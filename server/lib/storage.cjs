/**
 * NimbusOS — Storage Manager (RAID pools, disk detection, health checks)
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { NIMBUS_ROOT, CONFIG_DIR, run, readFile, formatBytes } = require('./shared.cjs');
const HAS_SMARTCTL = !!run('which smartctl 2>/dev/null');

// ═══════════════════════════════════════════════════
// STORAGE MANAGER
// ═══════════════════════════════════════════════════

const NIMBUS_POOLS_DIR = '/nimbus/pools';
const STORAGE_CONFIG_FILE = path.join(CONFIG_DIR, 'storage.json');

function getStorageConfig() {
  try { return JSON.parse(fs.readFileSync(STORAGE_CONFIG_FILE, 'utf8')); }
  catch { return { pools: [], primaryPool: null, alerts: { email: null }, configuredAt: null }; }
}

function saveStorageConfig(config) {
  fs.writeFileSync(STORAGE_CONFIG_FILE, JSON.stringify(config, null, 2));
}

// Check if system has at least one pool
function hasPool() {
  const config = getStorageConfig();
  return config.pools && config.pools.length > 0;
}

// Detect and classify all disks per the architecture document
function detectStorageDisks() {
  const result = { eligible: [], nvme: [], usb: [], provisioned: [] };
  
  // Get all block devices with extended info
  const lsblkRaw = run('lsblk -J -b -o NAME,SIZE,TYPE,ROTA,MOUNTPOINT,MODEL,SERIAL,TRAN,RM,FSTYPE,LABEL,PKNAME 2>/dev/null');
  if (!lsblkRaw) return result;
  
  let data;
  try { data = JSON.parse(lsblkRaw); } catch { return result; }
  
  const devices = data.blockdevices || [];
  
  // Find which disk has the root partition
  const rootDisk = findRootDisk(devices);
  
  for (const dev of devices) {
    if (dev.type !== 'disk') continue;
    if (dev.name.startsWith('loop') || dev.name.startsWith('ram') || dev.name.startsWith('zram')) continue;
    
    const size = parseInt(dev.size) || 0;
    if (size <= 0) continue;
    
    const diskInfo = {
      name: dev.name,
      path: `/dev/${dev.name}`,
      model: (dev.model || 'Unknown').trim(),
      serial: (dev.serial || '').trim(),
      size: size,
      sizeFormatted: formatBytes(size),
      transport: dev.tran || 'unknown',
      rotational: dev.rota === true || dev.rota === '1' || dev.rota === 1,
      removable: dev.rm === true || dev.rm === '1' || dev.rm === 1,
      partitions: [],
      smart: null,
      temperature: null,
      isBoot: dev.name === rootDisk,
      freeSpace: 0,
      freeSpaceFormatted: '0 B',
    };
    
    // Get partitions
    let usedSpace = 0;
    if (dev.children) {
      for (const child of dev.children) {
        const partSize = parseInt(child.size) || 0;
        usedSpace += partSize;
        diskInfo.partitions.push({
          name: child.name,
          path: `/dev/${child.name}`,
          size: partSize,
          sizeFormatted: formatBytes(partSize),
          fstype: child.fstype || null,
          label: child.label || null,
          mountpoint: child.mountpoint || null,
        });
      }
    }
    
    // Calculate free space on disk (total - all partitions)
    diskInfo.freeSpace = Math.max(0, size - usedSpace);
    diskInfo.freeSpaceFormatted = formatBytes(diskInfo.freeSpace);
    
    // Get SMART + temperature
    if (HAS_SMARTCTL) {
      const smartHealth = run(`smartctl -H /dev/${dev.name} 2>/dev/null`);
      if (smartHealth) {
        diskInfo.smart = smartHealth.includes('PASSED') ? 'PASSED' : 
                         smartHealth.includes('FAILED') ? 'FAILED' : 'UNKNOWN';
      }
      const smartTemp = run(`smartctl -A /dev/${dev.name} 2>/dev/null | grep -i temperature | head -1`);
      if (smartTemp) {
        const m = smartTemp.match(/(\d+)\s*$/);
        if (m) diskInfo.temperature = parseInt(m[1]);
      }
    }
    
    // CLASSIFY per document rules
    // Rule: USB -> skip ONLY if small/removable (pendrives, SD cards)
    // Large USB disks (HDDs, SSDs via USB) are eligible — important for RPi, mini PCs
    const isUsb = diskInfo.transport === 'usb';
    const minPoolDiskSize = 10 * 1024 * 1024 * 1024; // 10GB minimum for pool disks
    
    if (isUsb && (diskInfo.removable || size < minPoolDiskSize)) {
      diskInfo.classification = 'usb';
      result.usb.push(diskInfo);
      continue;
    }
    
    // Rule: NVMe
    if (dev.name.startsWith('nvme')) {
      diskInfo.classification = dev.name === rootDisk ? 'nvme-system' : 'nvme-cache';
      result.nvme.push(diskInfo);
      continue;
    }
    
    // Check if already part of a NIMBUS pool (by label OR by storage config)
    const hasNimbusLabel = diskInfo.partitions.some(p => 
      p.label && p.label.startsWith('NIMBUS-')
    );
    const storageConf = getStorageConfig();
    const inPool = (storageConf.pools || []).some(pool => 
      (pool.disks || []).includes(diskInfo.path)
    );
    
    if (hasNimbusLabel || inPool) {
      diskInfo.classification = 'provisioned';
      diskInfo.poolName = inPool ? (storageConf.pools || []).find(p => (p.disks || []).includes(diskInfo.path))?.name : null;
      result.provisioned.push(diskInfo);
      continue;
    }
    
    // Detect existing RAID/LVM superblocks (from Synology, old arrays, etc.)
    let hasRaidSuperblock = false;
    let hasForeignData = false;
    for (const part of diskInfo.partitions) {
      const superCheck = run(`mdadm --examine ${part.path} 2>/dev/null`);
      if (superCheck && superCheck.includes('Magic')) hasRaidSuperblock = true;
      if (part.fstype === 'LVM2_member' || part.fstype === 'linux_raid_member') hasRaidSuperblock = true;
    }
    // Also check raw disk for RAID superblock
    const diskSuperCheck = run(`mdadm --examine ${diskInfo.path} 2>/dev/null`);
    if (diskSuperCheck && diskSuperCheck.includes('Magic')) hasRaidSuperblock = true;
    
    diskInfo.hasRaidSuperblock = hasRaidSuperblock;
    diskInfo.hasExistingData = diskInfo.partitions.length > 0;
    diskInfo.needsWipe = hasRaidSuperblock || diskInfo.hasExistingData;
    
    // Rule: Boot disk with free space OR clean disk -> eligible
    // Boot disk participates in pool using its free space (system partitions stay intact)
    // Non-boot disk uses entire disk
    if (diskInfo.isBoot) {
      // Boot disk: eligible ONLY if it has enough free space (min 5GB)
      const minFreeBytes = 5 * 1024 * 1024 * 1024; // 5GB
      if (diskInfo.freeSpace >= minFreeBytes) {
        diskInfo.classification = diskInfo.rotational ? 'hdd' : 'ssd';
        diskInfo.availableSpace = diskInfo.freeSpace;
        diskInfo.availableSpaceFormatted = formatBytes(diskInfo.freeSpace);
        diskInfo.hasExistingData = false; // System partitions are expected
        result.eligible.push(diskInfo);
      }
      // If not enough free space, boot disk just doesn't appear as eligible
      // (no separate 'boot' category needed)
    } else {
      // Non-boot disk: use entire disk
      diskInfo.classification = diskInfo.rotational ? 'hdd' : 'ssd';
      diskInfo.availableSpace = size;
      diskInfo.availableSpaceFormatted = formatBytes(size);
      diskInfo.hasExistingData = diskInfo.partitions.length > 0;
      result.eligible.push(diskInfo);
    }
  }
  
  return result;
}

function findRootDisk(devices) {
  for (const dev of devices) {
    if (dev.children) {
      for (const child of dev.children) {
        if (child.mountpoint === '/') return dev.name;
      }
    }
    if (dev.mountpoint === '/') return dev.name;
  }
  return null;
}

// Get RAID array status from /proc/mdstat
function getRAIDStatus() {
  const mdstat = readFile('/proc/mdstat');
  const arrays = [];
  
  if (!mdstat) return arrays;
  
  const lines = mdstat.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(md\d+)\s*:\s*active\s+(\w+)\s+(.+)/);
    if (!match) continue;
    
    const name = match[1];
    const level = match[2];
    const devicesStr = match[3];
    
    // Parse member devices
    const members = [];
    const devMatches = devicesStr.matchAll(/(\w+)\[(\d+)\](\((?:S|F)\))?/g);
    for (const dm of devMatches) {
      members.push({
        device: dm[1],
        index: parseInt(dm[2]),
        spare: dm[3] === '(S)',
        failed: dm[3] === '(F)',
      });
    }
    
    // Next line has blocks and status
    let status = 'active';
    let progress = null;
    let totalBlocks = 0;
    if (i + 1 < lines.length) {
      const statusLine = lines[i + 1];
      const blocksMatch = statusLine.match(/(\d+)\s+blocks/);
      if (blocksMatch) totalBlocks = parseInt(blocksMatch[1]);
      
      if (statusLine.includes('[_')) status = 'degraded';
    }
    if (i + 2 < lines.length) {
      const progressLine = lines[i + 2];
      const rebuildMatch = progressLine.match(/recovery\s*=\s*([\d.]+)%/);
      const reshapeMatch = progressLine.match(/reshape\s*=\s*([\d.]+)%/);
      if (rebuildMatch) {
        status = 'rebuilding';
        progress = parseFloat(rebuildMatch[1]);
      } else if (reshapeMatch) {
        status = 'reshaping';
        progress = parseFloat(reshapeMatch[1]);
      }
    }
    
    // Get detailed info
    const detail = run(`mdadm --detail /dev/${name} 2>/dev/null`);
    let uuid = null, arraySize = 0;
    if (detail) {
      const uuidMatch = detail.match(/UUID\s*:\s*(\S+)/);
      if (uuidMatch) uuid = uuidMatch[1];
      const sizeMatch = detail.match(/Array Size\s*:\s*(\d+)/);
      if (sizeMatch) arraySize = parseInt(sizeMatch[1]) * 1024; // KB to bytes
    }
    
    arrays.push({
      name, level, status, progress, members, uuid,
      totalBlocks, arraySize, arraySizeFormatted: formatBytes(arraySize),
    });
  }
  
  return arrays;
}

// Get pool info (RAID arrays that are mounted as nimbus pools)
function getStoragePools() {
  const config = getStorageConfig();
  const raids = getRAIDStatus();
  const pools = [];
  
  for (const poolConf of (config.pools || [])) {
    const raid = raids.find(r => r.name === poolConf.arrayName);
    const mountInfo = run(`df -B1 --output=size,used,avail ${poolConf.mountPoint} 2>/dev/null`);
    
    let total = 0, used = 0, available = 0;
    if (mountInfo) {
      const lines = mountInfo.trim().split('\n');
      if (lines.length > 1) {
        const parts = lines[1].trim().split(/\s+/);
        total = parseInt(parts[0]) || 0;
        used = parseInt(parts[1]) || 0;
        available = parseInt(parts[2]) || 0;
      }
    }
    
    // Determine pool status
    let poolStatus = 'unknown';
    if (raid) {
      poolStatus = raid.status; // RAID array: use mdstat status
    } else if (poolConf.raidLevel === 'single' || poolConf.arrayName === null) {
      // Single disk pool: check if mounted and has data
      poolStatus = total > 0 ? 'active' : 'unmounted';
    }
    
    pools.push({
      name: poolConf.name,
      arrayName: poolConf.arrayName,
      arrayPath: poolConf.arrayName ? `/dev/${poolConf.arrayName}` : null,
      mountPoint: poolConf.mountPoint,
      raidLevel: poolConf.raidLevel,
      filesystem: poolConf.filesystem || 'ext4',
      createdAt: poolConf.createdAt,
      disks: poolConf.disks || [],
      status: poolStatus,
      rebuildProgress: raid ? raid.progress : null,
      members: raid ? raid.members : [],
      total, used, available,
      totalFormatted: formatBytes(total),
      usedFormatted: formatBytes(used),
      availableFormatted: formatBytes(available),
      usagePercent: total > 0 ? Math.round((used / total) * 100) : 0,
      isPrimary: poolConf.name === config.primaryPool,
    });
  }
  
  return pools;
}

// Create a new RAID pool
function createPool(name, disks, level, filesystem = 'ext4') {
  // Validate name
  if (!name || !/^[a-zA-Z0-9-]{1,32}$/.test(name)) {
    return { error: 'Invalid pool name. Use alphanumeric + hyphens, max 32 chars.' };
  }
  const reserved = ['system', 'config', 'temp', 'swap', 'root', 'boot'];
  if (reserved.includes(name.toLowerCase())) {
    return { error: `"${name}" is a reserved name.` };
  }
  
  // Check name not taken
  const config = getStorageConfig();
  if ((config.pools || []).find(p => p.name === name)) {
    return { error: `Pool "${name}" already exists.` };
  }
  
  // Validate disks
  if (!disks || !Array.isArray(disks) || disks.length < 1) {
    return { error: 'At least 1 disk required.' };
  }
  
  // Validate RAID level vs disk count
  const levelInt = parseInt(level);
  const isSingleDisk = disks.length === 1;
  
  if (!isSingleDisk) {
    const minDisks = { 0: 2, 1: 2, 5: 3, 6: 4, 10: 4 };
    if (minDisks[levelInt] === undefined) {
      return { error: `Invalid RAID level: ${level}. Use 0, 1, 5, 6, or 10.` };
    }
    if (disks.length < minDisks[levelInt]) {
      return { error: `RAID ${level} requires at least ${minDisks[levelInt]} disks. You selected ${disks.length}.` };
    }
    if (levelInt === 10 && disks.length % 2 !== 0) {
      return { error: 'RAID 10 requires an even number of disks.' };
    }
  }
  
  // Validate filesystem
  if (!['ext4', 'xfs'].includes(filesystem)) {
    return { error: 'Filesystem must be ext4 or xfs.' };
  }
  
  // Verify disks are eligible
  const detected = detectStorageDisks();
  const eligiblePaths = detected.eligible.map(d => d.path);
  for (const disk of disks) {
    if (!eligiblePaths.includes(disk)) {
      return { error: `Disk ${disk} is not eligible for pool creation.` };
    }
  }
  
  // Find next available md device
  const raids = getRAIDStatus();
  const usedMds = raids.map(r => parseInt(r.name.replace('md', '')));
  let mdNum = 0;
  while (usedMds.includes(mdNum)) mdNum++;
  const mdName = `md${mdNum}`;
  const mdPath = `/dev/${mdName}`;
  const mountPoint = `${NIMBUS_POOLS_DIR}/${name}`;
  
  try {
    // 1. Partition each disk
    // Boot disks: add new partition in free space (keep system partitions)
    // Non-boot disks: wipe and use entire disk
    const detected = detectStorageDisks();
    const partitions = [];
    
    // Check if basic tools exist
    const hasSgdisk = !!(run('which sgdisk 2>/dev/null'));
    const hasMdadm = !!(run('which mdadm 2>/dev/null'));
    
    for (const disk of disks) {
      const diskInfo = detected.eligible.find(d => d.path === disk);
      const isBoot = diskInfo && diskInfo.isBoot;
      
      // Clear any existing RAID superblocks and LVM from this disk
      if (!isBoot && hasMdadm) {
        // Stop any arrays this disk is part of
        const mdstat = readFile('/proc/mdstat') || '';
        const diskName = disk.replace('/dev/', '');
        for (const line of mdstat.split('\n')) {
          if (line.includes(diskName)) {
            const arrayMatch = line.match(/^(md\d+)/);
            if (arrayMatch) {
              const mdDev = `/dev/${arrayMatch[1]}`;
              console.log(`[Storage] Found active array ${mdDev} containing ${disk}`);
              // Unmount the array first
              const mdMount = run(`findmnt -n -o TARGET ${mdDev} 2>/dev/null`)?.trim();
              if (mdMount) {
                console.log(`[Storage] Unmounting ${mdDev} from ${mdMount}`);
                execSync(`umount -f ${mdDev} 2>/dev/null || true`, { timeout: 15000 });
                execSync(`sed -i '\\|${mdMount.replace(/\//g, '\\/')}|d' /etc/fstab 2>/dev/null || true`, { timeout: 5000 });
              }
              // Remove fstab entries for this array
              execSync(`sed -i '\\|${arrayMatch[1]}|d' /etc/fstab 2>/dev/null || true`, { timeout: 5000 });
              // Stop the array
              console.log(`[Storage] Stopping array ${mdDev}`);
              execSync(`mdadm --stop ${mdDev} 2>/dev/null || true`, { timeout: 15000 });
              // If stop failed, force it
              if (run(`cat /proc/mdstat 2>/dev/null`)?.includes(arrayMatch[1])) {
                console.log(`[Storage] Force stopping ${mdDev}`);
                execSync(`mdadm --stop --force ${mdDev} 2>/dev/null || true`, { timeout: 15000 });
              }
            }
          }
        }
        // Update mdadm.conf
        execSync('mdadm --detail --scan > /etc/mdadm/mdadm.conf 2>/dev/null || true', { timeout: 5000 });
        // Clear superblocks from all existing partitions
        if (diskInfo && diskInfo.partitions) {
          for (const part of diskInfo.partitions) {
            execSync(`mdadm --zero-superblock ${part.path} 2>/dev/null || true`, { timeout: 5000 });
            execSync(`pvremove -f ${part.path} 2>/dev/null || true`, { timeout: 5000 });
          }
        }
        execSync(`mdadm --zero-superblock ${disk} 2>/dev/null || true`, { timeout: 5000 });
      }
      
      if (isBoot) {
        // Boot disk: find next available partition number and create in free space
        if (!hasSgdisk) return { error: 'sgdisk is required for boot disk partitioning. Install: sudo apt install gdisk' };
        const existingParts = diskInfo.partitions.length;
        const nextPartNum = existingParts + 1;
        execSync(`sgdisk -n ${nextPartNum}:0:0 -t ${nextPartNum}:FD00 -c ${nextPartNum}:"NIMBUS-DATA" ${disk}`, { timeout: 10000 });
        partitions.push(`${disk}${nextPartNum}`);
        console.log(`[Storage] Boot disk ${disk}: created partition ${nextPartNum} in free space`);
      } else if (isSingleDisk) {
        // Single non-boot disk: simple approach that works on any platform (Pi, mini PC, etc)
        
        // First: unmount ALL partitions on this disk
        if (diskInfo && diskInfo.partitions) {
          for (const part of diskInfo.partitions) {
            if (part.mountpoint) {
              console.log(`[Storage] Unmounting ${part.path} (was mounted at ${part.mountpoint})`);
              execSync(`umount -f ${part.path} 2>/dev/null || true`, { timeout: 10000 });
            }
          }
        }
        // Also try unmounting the disk itself
        execSync(`umount -f ${disk} 2>/dev/null || true`, { timeout: 5000 });
        // Remove any fstab entries for this disk
        execSync(`sed -i '\\|${disk}|d' /etc/fstab 2>/dev/null || true`, { timeout: 5000 });
        
        // Wait for unmount
        execSync('sleep 1');
        
        // Wipe and repartition
        execSync(`wipefs -a ${disk} 2>/dev/null || true`, { timeout: 10000 });
        
        if (hasSgdisk) {
          execSync(`sgdisk -Z ${disk} 2>/dev/null || true`, { timeout: 10000 });
          execSync(`sgdisk -n 1:0:0 -t 1:8300 -c 1:"NIMBUS-DATA" ${disk}`, { timeout: 10000 });
        } else {
          // Fallback: use sfdisk (always available on Debian/Ubuntu)
          execSync(`echo ";" | sfdisk --force ${disk} 2>/dev/null || true`, { timeout: 10000 });
        }
        
        // Detect partition name (handle /dev/sda1 vs /dev/mmcblk0p1)
        execSync(`partprobe ${disk} 2>/dev/null || true`, { timeout: 5000 });
        execSync('sleep 2');
        
        // Find the new partition
        const newParts = run(`lsblk -lnp -o NAME ${disk} 2>/dev/null`) || '';
        const partLines = newParts.trim().split('\n').filter(l => l.trim() !== disk);
        if (partLines.length > 0) {
          partitions.push(partLines[partLines.length - 1].trim());
        } else {
          // No partition table needed — format the whole disk directly
          partitions.push(disk);
        }
        console.log(`[Storage] Single disk ${disk}: partition ${partitions[partitions.length - 1]}`);
      } else {
        // Multi-disk RAID: need sgdisk
        if (!hasSgdisk) return { error: 'sgdisk is required for RAID. Install: sudo apt install gdisk' };
        execSync(`sgdisk -Z ${disk} 2>/dev/null || true`, { timeout: 10000 });
        execSync(`sgdisk -n 1:0:0 -t 1:FD00 -c 1:"NIMBUS-DATA" ${disk}`, { timeout: 10000 });
        partitions.push(`${disk}1`);
        console.log(`[Storage] Clean disk ${disk}: wiped and created partition 1`);
      }
    }
    
    execSync(`partprobe ${disks.join(' ')} 2>/dev/null || true`, { timeout: 10000 });
    
    // Wait for partitions to appear
    execSync('sleep 2');
    
    // 2. Create RAID array (or single disk)
    if (isSingleDisk) {
      // Single disk: no RAID, just format the partition directly
      const mkfsCmd = filesystem === 'xfs' 
        ? `mkfs.xfs -f -L nimbus-${name} ${partitions[0]}`
        : `mkfs.ext4 -F -L nimbus-${name} ${partitions[0]}`;
      execSync(mkfsCmd, { timeout: 120000 });
      
      // Mount
      execSync(`mkdir -p ${mountPoint}`, { timeout: 5000 });
      execSync(`mount ${partitions[0]} ${mountPoint}`, { timeout: 10000 });
      
      // fstab
      const uuid = run(`blkid -s UUID -o value ${partitions[0]}`) || '';
      execSync(`echo "UUID=${uuid.trim()} ${mountPoint} ${filesystem} defaults,noatime 0 2" >> /etc/fstab`);
      
    } else {
      // RAID array
      const raidLevel = levelInt === 10 ? '10' : `${levelInt}`;
      const mdadmCmd = `mdadm --create ${mdPath} --level=${raidLevel} --raid-devices=${disks.length} --metadata=1.2 --run ${partitions.join(' ')}`;
      execSync(mdadmCmd, { timeout: 30000 });
      
      // Format
      const mkfsCmd = filesystem === 'xfs'
        ? `mkfs.xfs -f -L nimbus-${name} ${mdPath}`
        : `mkfs.ext4 -F -L nimbus-${name} ${mdPath}`;
      execSync(mkfsCmd, { timeout: 120000 });
      
      // Mount
      execSync(`mkdir -p ${mountPoint}`, { timeout: 5000 });
      execSync(`mount ${mdPath} ${mountPoint}`, { timeout: 10000 });
      
      // fstab + mdadm config
      const uuid = run(`blkid -s UUID -o value ${mdPath}`) || '';
      execSync(`echo "UUID=${uuid.trim()} ${mountPoint} ${filesystem} defaults,noatime 0 2" >> /etc/fstab`);
      execSync('mdadm --detail --scan > /etc/mdadm/mdadm.conf 2>/dev/null || true');
      execSync('update-initramfs -u 2>/dev/null || true', { timeout: 60000 });
    }
    
    // 3. Create directory structure
    const dirs = ['docker/containers', 'docker/stacks', 'docker/volumes', 'shares', 'system-backup/config', 'system-backup/snapshots'];
    for (const dir of dirs) {
      execSync(`mkdir -p ${mountPoint}/${dir}`);
    }
    
    // 3b. Write pool identity file (survives reinstalls)
    const poolIdentity = {
      name,
      raidLevel: isSingleDisk ? 'single' : `raid${levelInt}`,
      filesystem,
      disks,
      createdAt: new Date().toISOString(),
      nimbusVersion: '2.0.0-beta',
    };
    fs.writeFileSync(path.join(mountPoint, '.nimbus-pool.json'), JSON.stringify(poolIdentity, null, 2));
    
    // 4. Save pool config
    const isFirstPool = !config.pools || config.pools.length === 0;
    if (!config.pools) config.pools = [];
    config.pools.push({
      name,
      arrayName: isSingleDisk ? null : mdName,
      mountPoint,
      raidLevel: isSingleDisk ? 'single' : `raid${levelInt}`,
      filesystem,
      disks,
      createdAt: new Date().toISOString(),
    });
    if (isFirstPool) {
      config.primaryPool = name;
      config.configuredAt = new Date().toISOString();
    }
    saveStorageConfig(config);
    
    // 5. If first pool, save as primary and create docker directory structure
    if (isFirstPool) {
      // Just prepare the directory structure — Docker will be installed from App Store
      const dockerDir = `${mountPoint}/docker`;
      const dirs2 = ['containers', 'stacks', 'volumes', 'data'];
      for (const dir of dirs2) {
        execSync(`mkdir -p ${dockerDir}/${dir}`);
      }
      
      // Initial config backup
      backupConfigToPool(mountPoint);
    }
    
    console.log(`[Storage] Pool "${name}" created at ${mountPoint} (${isSingleDisk ? 'single disk' : 'RAID ' + levelInt})`);
    
    return {
      ok: true,
      pool: { name, mountPoint, raidLevel: isSingleDisk ? 'single' : `raid${levelInt}`, disks },
      isFirstPool,
    };
    
  } catch (err) {
    console.error('[Storage] Pool creation failed:', err.message);
    return { error: 'Pool creation failed: ' + err.message };
  }
}

// Wipe a disk: stop any RAID arrays, clear superblocks, remove all partitions
function wipeDisk(diskPath) {
  // Safety: verify the disk exists and is not the boot disk
  const detected = detectStorageDisks();
  const allDisks = [...detected.eligible, ...detected.provisioned];
  const diskInfo = allDisks.find(d => d.path === diskPath);
  
  if (!diskInfo) {
    return { error: `Disk ${diskPath} not found or not wipeable` };
  }
  if (diskInfo.isBoot) {
    return { error: 'Cannot wipe the boot disk' };
  }
  
  // Check if disk is part of an active pool
  const config = getStorageConfig();
  const inPool = (config.pools || []).find(p => (p.disks || []).includes(diskPath));
  if (inPool) {
    return { error: `Disk is part of pool "${inPool.name}". Destroy the pool first.` };
  }
  
  const hasSgdisk = !!(run('which sgdisk 2>/dev/null'));
  const hasMdadm = !!(run('which mdadm 2>/dev/null'));
  
  try {
    // 1. Unmount ALL mounted partitions on this disk
    for (const part of diskInfo.partitions) {
      if (part.mountpoint) {
        console.log(`[Storage] Unmounting ${part.path} from ${part.mountpoint}`);
        execSync(`umount -f ${part.path} 2>/dev/null || true`, { timeout: 10000 });
      }
    }
    execSync(`umount -f ${diskPath} 2>/dev/null || true`, { timeout: 5000 });
    // Remove fstab entries for this disk
    const diskName = diskPath.replace('/dev/', '');
    execSync(`sed -i '\\|${diskPath}|d' /etc/fstab 2>/dev/null || true`, { timeout: 5000 });
    execSync(`sed -i '\\|${diskName}|d' /etc/fstab 2>/dev/null || true`, { timeout: 5000 });
    
    execSync('sleep 1');
    
    // 2. Stop any RAID arrays this disk participates in
    if (hasMdadm) {
      const mdstat = readFile('/proc/mdstat') || '';
      const lines = mdstat.split('\n');
      for (const line of lines) {
        if (line.includes(diskName)) {
          const arrayMatch = line.match(/^(md\d+)/);
          if (arrayMatch) {
            const mdDev = `/dev/${arrayMatch[1]}`;
            console.log(`[Storage] Found array ${mdDev} (contains ${diskPath})`);
            // Unmount the array first
            const mdMount = run(`findmnt -n -o TARGET ${mdDev} 2>/dev/null`)?.trim();
            if (mdMount) {
              console.log(`[Storage] Unmounting ${mdDev} from ${mdMount}`);
              execSync(`umount -f ${mdDev} 2>/dev/null || true`, { timeout: 10000 });
              // Remove fstab entries for this array
              execSync(`sed -i '\\|${arrayMatch[1]}|d' /etc/fstab 2>/dev/null || true`, { timeout: 5000 });
              execSync(`sed -i '\\|${mdMount.replace(/\//g, '\\/')}|d' /etc/fstab 2>/dev/null || true`, { timeout: 5000 });
            }
            console.log(`[Storage] Stopping array ${mdDev}`);
            execSync(`mdadm --stop ${mdDev} 2>/dev/null || true`, { timeout: 15000 });
          }
        }
      }
      
      // Also remove from mdadm.conf
      execSync('mdadm --detail --scan > /etc/mdadm/mdadm.conf 2>/dev/null || true', { timeout: 5000 });
      
      // 3. Clear RAID superblocks from all partitions
      for (const part of diskInfo.partitions) {
        execSync(`mdadm --zero-superblock ${part.path} 2>/dev/null || true`, { timeout: 5000 });
      }
      execSync(`mdadm --zero-superblock ${diskPath} 2>/dev/null || true`, { timeout: 5000 });
    }
    
    // 4. Remove all LVM
    for (const part of diskInfo.partitions) {
      execSync(`pvremove -f ${part.path} 2>/dev/null || true`, { timeout: 5000 });
    }
    
    // 5. Wipe filesystem signatures
    execSync(`wipefs -a ${diskPath} 2>/dev/null || true`, { timeout: 10000 });
    for (const part of diskInfo.partitions) {
      execSync(`wipefs -a ${part.path} 2>/dev/null || true`, { timeout: 5000 });
    }
    
    // 6. Wipe partition table
    if (hasSgdisk) {
      execSync(`sgdisk -Z ${diskPath}`, { timeout: 10000 });
    } else {
      // Fallback: dd the first and last MB to kill MBR/GPT
      execSync(`dd if=/dev/zero of=${diskPath} bs=1M count=1 2>/dev/null || true`, { timeout: 10000 });
      execSync(`dd if=/dev/zero of=${diskPath} bs=1M seek=$(( $(blockdev --getsize64 ${diskPath}) / 1048576 - 1 )) count=1 2>/dev/null || true`, { timeout: 10000 });
    }
    
    execSync(`partprobe ${diskPath} 2>/dev/null || true`, { timeout: 5000 });
    
    // 7. Clear disk cache
    diskCache = null;
    
    console.log(`[Storage] Disk ${diskPath} wiped successfully`);
    return { ok: true, disk: diskPath };
    
  } catch (err) {
    console.error(`[Storage] Wipe failed for ${diskPath}:`, err.message);
    return { error: 'Wipe failed: ' + err.message };
  }
}

// Destroy a pool: unmount, remove fstab entry, stop RAID, clear config
function destroyPool(poolName) {
  const config = getStorageConfig();
  const poolConf = (config.pools || []).find(p => p.name === poolName);
  
  if (!poolConf) {
    return { error: `Pool "${poolName}" not found` };
  }
  
  try {
    // 1. Unmount
    execSync(`umount ${poolConf.mountPoint} 2>/dev/null || true`, { timeout: 10000 });
    
    // 2. Stop RAID array if exists
    if (poolConf.arrayName) {
      execSync(`mdadm --stop /dev/${poolConf.arrayName} 2>/dev/null || true`, { timeout: 10000 });
    }
    
    // 3. Clear RAID superblocks from member disks
    for (const disk of (poolConf.disks || [])) {
      // Find the partition that was used
      const parts = run(`lsblk -ln -o NAME ${disk} 2>/dev/null`) || '';
      for (const part of parts.split('\n').filter(Boolean)) {
        execSync(`mdadm --zero-superblock /dev/${part.trim()} 2>/dev/null || true`, { timeout: 5000 });
      }
    }
    
    // 4. Remove fstab entry
    execSync(`sed -i '/${poolName.replace(/[/\\]/g, '\\/')}/d' /etc/fstab 2>/dev/null || true`);
    // Also remove by mount point
    const escapedMount = poolConf.mountPoint.replace(/\//g, '\\/');
    execSync(`sed -i '/${escapedMount}/d' /etc/fstab 2>/dev/null || true`);
    
    // 5. Remove mount point directory
    execSync(`rm -rf ${poolConf.mountPoint} 2>/dev/null || true`);
    
    // 6. Update mdadm config
    execSync('mdadm --detail --scan > /etc/mdadm/mdadm.conf 2>/dev/null || true');
    
    // 7. Remove from storage config
    config.pools = (config.pools || []).filter(p => p.name !== poolName);
    if (config.primaryPool === poolName) {
      config.primaryPool = config.pools.length > 0 ? config.pools[0].name : null;
    }
    saveStorageConfig(config);
    
    // 8. Clear disk cache
    diskCache = null;
    
    console.log(`[Storage] Pool "${poolName}" destroyed`);
    return { ok: true, pool: poolName };
    
  } catch (err) {
    console.error(`[Storage] Destroy pool failed:`, err.message);
    return { error: 'Destroy failed: ' + err.message };
  }
}

// Backup config files to pool
function backupConfigToPool(mountPoint) {
  if (!mountPoint) {
    const config = getStorageConfig();
    if (!config.primaryPool) return;
    const pool = (config.pools || []).find(p => p.name === config.primaryPool);
    if (!pool) return;
    mountPoint = pool.mountPoint;
  }
  
  const backupDir = path.join(mountPoint, 'system-backup', 'config');
  const snapshotDir = path.join(mountPoint, 'system-backup', 'snapshots', 
    new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19));
  
  try {
    execSync(`mkdir -p ${backupDir} ${snapshotDir}`);
    
    // Copy current configs
    const files = ['users.json', 'shares.json', 'docker.json', 'installed-apps.json', 'storage.json'];
    for (const file of files) {
      const src = path.join(CONFIG_DIR, file);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(backupDir, file));
        fs.copyFileSync(src, path.join(snapshotDir, file));
      }
    }
    
    // Keep only last 5 snapshots
    const snapshotsBase = path.join(mountPoint, 'system-backup', 'snapshots');
    const snapshots = fs.readdirSync(snapshotsBase).sort().reverse();
    for (let i = 5; i < snapshots.length; i++) {
      execSync(`rm -rf "${path.join(snapshotsBase, snapshots[i])}"`);
    }
    
    console.log('[Storage] Config backed up to pool');
  } catch (err) {
    console.error('[Storage] Backup failed:', err.message);
  }
}

// Detect existing NIMBUS pools (for re-import after reinstall)
function detectExistingPools() {
  const found = [];
  
  // Scan for NIMBUS-DATA labels
  const blkid = run('blkid 2>/dev/null') || '';
  const nimbusPartitions = [];
  for (const line of blkid.split('\n')) {
    if (line.includes('NIMBUS-DATA')) {
      const devMatch = line.match(/^(\/dev\/\S+):/);
      if (devMatch) nimbusPartitions.push(devMatch[1]);
    }
  }
  
  if (nimbusPartitions.length === 0) return found;
  
  // Try to assemble arrays
  execSync('mdadm --assemble --scan 2>/dev/null || true', { timeout: 15000 });
  
  // Check assembled arrays
  const raids = getRAIDStatus();
  for (const raid of raids) {
    // Check if this array has a nimbus label
    const label = run(`blkid -s LABEL -o value /dev/${raid.name} 2>/dev/null`) || '';
    if (label.trim().startsWith('nimbus-')) {
      const poolName = label.trim().replace('nimbus-', '');
      
      // Check for system-backup
      const tmpMount = `/tmp/nimbus-import-${raid.name}`;
      let hasBackup = false;
      try {
        execSync(`mkdir -p ${tmpMount} && mount -o ro /dev/${raid.name} ${tmpMount} 2>/dev/null`, { timeout: 10000 });
        hasBackup = fs.existsSync(path.join(tmpMount, 'system-backup', 'config'));
        execSync(`umount ${tmpMount} 2>/dev/null || true`);
      } catch {}
      
      found.push({
        arrayName: raid.name,
        poolName,
        raidLevel: raid.level,
        status: raid.status,
        members: raid.members,
        arraySize: raid.arraySize,
        arraySizeFormatted: raid.arraySizeFormatted,
        hasConfigBackup: hasBackup,
      });
    }
  }
  
  return found;
}

// Storage monitoring - check RAID health and disk temps
let storageAlerts = [];

function checkStorageHealth() {
  const alerts = [];
  const raids = getRAIDStatus();
  const pools = getStoragePools();
  
  // Check RAID status
  for (const raid of raids) {
    if (raid.status === 'degraded') {
      alerts.push({ severity: 'critical', type: 'raid_degraded', array: raid.name, 
        message: `RAID array ${raid.name} is DEGRADED - a disk has failed` });
    }
    if (raid.status === 'rebuilding') {
      alerts.push({ severity: 'warning', type: 'raid_rebuilding', array: raid.name,
        message: `RAID array ${raid.name} is rebuilding (${raid.progress}%)` });
    }
  }
  
  // Check pool usage
  for (const pool of pools) {
    if (pool.usagePercent >= 95) {
      alerts.push({ severity: 'critical', type: 'pool_full', pool: pool.name,
        message: `Pool "${pool.name}" is ${pool.usagePercent}% full` });
    } else if (pool.usagePercent >= 85) {
      alerts.push({ severity: 'warning', type: 'pool_warning', pool: pool.name,
        message: `Pool "${pool.name}" is ${pool.usagePercent}% full` });
    }
  }
  
  // Check disk temps
  const detected = detectStorageDisks();
  const allDisks = [...detected.eligible, ...detected.provisioned];
  for (const disk of allDisks) {
    if (disk.temperature && disk.temperature > 60) {
      alerts.push({ severity: 'critical', type: 'disk_hot', disk: disk.path,
        message: `Disk ${disk.model} is at ${disk.temperature}C - dangerously hot` });
    } else if (disk.temperature && disk.temperature > 50) {
      alerts.push({ severity: 'warning', type: 'disk_warm', disk: disk.path,
        message: `Disk ${disk.model} is at ${disk.temperature}C - running warm` });
    }
  }
  
  storageAlerts = alerts;
  return alerts;
}

// Start storage monitoring interval
setInterval(checkStorageHealth, 300000); // Every 5min
setInterval(() => { if (hasPool()) backupConfigToPool(); }, 6 * 60 * 60 * 1000); // Every 6h

// ═══════════════════════════════════
// Pool Restore — detect and recover pools from previous installs
// ═══════════════════════════════════

// Scan all partitions for .nimbus-pool.json identity files
function scanForRestorablePools() {
  const found = [];
  const config = getStorageConfig();
  const existingMounts = (config.pools || []).map(p => p.mountPoint);

  // Get all partitions with ext4/xfs that could be nimbus pools
  const blkid = run('blkid 2>/dev/null') || '';
  const candidates = [];
  for (const line of blkid.split('\n')) {
    if (!line) continue;
    const devMatch = line.match(/^(\/dev\/\S+):/);
    if (!devMatch) continue;
    const dev = devMatch[1];
    // Skip boot partitions, swap, small partitions
    if (dev.includes('nvme0n1p') && !line.includes('nimbus')) continue;
    if (line.includes('TYPE="swap"') || line.includes('TYPE="vfat"')) continue;
    // Only ext4 and xfs
    if (line.includes('TYPE="ext4"') || line.includes('TYPE="xfs"')) {
      const labelMatch = line.match(/LABEL="([^"]+)"/);
      candidates.push({ dev, label: labelMatch ? labelMatch[1] : null });
    }
  }

  for (const cand of candidates) {
    const tmpMount = `/tmp/nimbus-scan-${cand.dev.replace(/\//g, '_')}`;
    try {
      // Check if already mounted somewhere
      const existingMount = run(`findmnt -n -o TARGET ${cand.dev} 2>/dev/null`)?.trim();
      let mountDir = existingMount;
      let didMount = false;

      if (!mountDir) {
        execSync(`mkdir -p ${tmpMount}`, { timeout: 5000 });
        execSync(`mount -o ro ${cand.dev} ${tmpMount} 2>/dev/null`, { timeout: 10000 });
        mountDir = tmpMount;
        didMount = true;
      }

      const identityFile = path.join(mountDir, '.nimbus-pool.json');
      if (fs.existsSync(identityFile)) {
        const identity = JSON.parse(fs.readFileSync(identityFile, 'utf8'));

        // Check it's not already configured
        const alreadyConfigured = (config.pools || []).some(p => p.name === identity.name);

        // Check what data exists
        const hasDocker = fs.existsSync(path.join(mountDir, 'docker'));
        const hasShares = fs.existsSync(path.join(mountDir, 'shares'));
        const hasBackup = fs.existsSync(path.join(mountDir, 'system-backup', 'config'));

        // Get size info
        const sizeInfo = run(`df -B1 ${mountDir} 2>/dev/null | tail -1`)?.trim() || '';
        const sizeParts = sizeInfo.split(/\s+/);
        const totalBytes = parseInt(sizeParts[1]) || 0;
        const usedBytes = parseInt(sizeParts[2]) || 0;

        found.push({
          device: cand.dev,
          label: cand.label,
          pool: identity,
          alreadyConfigured,
          currentMount: existingMount || null,
          data: { hasDocker, hasShares, hasBackup },
          size: { total: totalBytes, totalFormatted: formatBytes(totalBytes), used: usedBytes, usedFormatted: formatBytes(usedBytes) },
        });
      }

      if (didMount) {
        execSync(`umount ${tmpMount} 2>/dev/null || true`, { timeout: 5000 });
        execSync(`rmdir ${tmpMount} 2>/dev/null || true`);
      }
    } catch (err) {
      // Cleanup on error
      execSync(`umount ${tmpMount} 2>/dev/null || true`);
      execSync(`rmdir ${tmpMount} 2>/dev/null || true`);
    }
  }

  // Also check for nimbus-labeled partitions without identity file (beta 1 pools)
  for (const cand of candidates) {
    if (cand.label && cand.label.startsWith('nimbus-') && !found.some(f => f.device === cand.dev)) {
      const poolName = cand.label.replace('nimbus-', '');
      const alreadyConfigured = (config.pools || []).some(p => p.name === poolName);
      found.push({
        device: cand.dev,
        label: cand.label,
        pool: { name: poolName, raidLevel: 'unknown', filesystem: 'ext4', createdAt: null, legacy: true },
        alreadyConfigured,
        currentMount: run(`findmnt -n -o TARGET ${cand.dev} 2>/dev/null`)?.trim() || null,
        data: { hasDocker: false, hasShares: false, hasBackup: false },
        size: { total: 0, totalFormatted: '—', used: 0, usedFormatted: '—' },
      });
    }
  }

  return found;
}

// Restore a pool: mount it and register in config
function restorePool(device, poolName) {
  if (!device) return { error: 'Device path required' };

  // Verify the device exists
  if (!fs.existsSync(device)) return { error: `Device ${device} not found` };

  const config = getStorageConfig();
  if ((config.pools || []).some(p => p.name === poolName)) {
    return { error: `Pool "${poolName}" already configured` };
  }

  const mountPoint = `${NIMBUS_POOLS_DIR}/${poolName}`;

  try {
    // 1. Mount the pool
    execSync(`mkdir -p ${mountPoint}`, { timeout: 5000 });

    // Check if already mounted
    const existing = run(`findmnt -n -o TARGET ${device} 2>/dev/null`)?.trim();
    if (existing && existing !== mountPoint) {
      execSync(`umount ${device} 2>/dev/null || true`, { timeout: 10000 });
    }
    if (!existing || existing !== mountPoint) {
      execSync(`mount ${device} ${mountPoint}`, { timeout: 10000 });
    }

    // 2. Read identity file if it exists
    let identity = {};
    const identityFile = path.join(mountPoint, '.nimbus-pool.json');
    if (fs.existsSync(identityFile)) {
      identity = JSON.parse(fs.readFileSync(identityFile, 'utf8'));
    }

    // 3. Detect filesystem
    const fstype = run(`blkid -s TYPE -o value ${device} 2>/dev/null`)?.trim() || 'ext4';

    // 4. Add to fstab
    const uuid = run(`blkid -s UUID -o value ${device} 2>/dev/null`)?.trim();
    if (uuid) {
      // Remove old fstab entries for this device/uuid
      execSync(`sed -i '/${uuid}/d' /etc/fstab 2>/dev/null || true`);
      execSync(`echo "UUID=${uuid} ${mountPoint} ${fstype} defaults,noatime 0 2" >> /etc/fstab`);
    }

    // 5. Figure out parent disk
    const parentDisk = run(`lsblk -no PKNAME ${device} 2>/dev/null`)?.trim();
    const diskPath = parentDisk ? `/dev/${parentDisk}` : device;

    // 6. Register pool in config
    if (!config.pools) config.pools = [];
    const poolEntry = {
      name: poolName,
      arrayName: null,
      mountPoint,
      raidLevel: identity.raidLevel || 'single',
      filesystem: fstype,
      disks: identity.disks || [diskPath],
      createdAt: identity.createdAt || new Date().toISOString(),
      restoredAt: new Date().toISOString(),
      imported: true,
    };
    config.pools.push(poolEntry);

    if (!config.primaryPool) {
      config.primaryPool = poolName;
      config.configuredAt = new Date().toISOString();
    }
    saveStorageConfig(config);

    // 7. If there's a config backup in the pool, offer to restore it
    let restoredConfig = false;
    const backupDir = path.join(mountPoint, 'system-backup', 'config');
    if (fs.existsSync(backupDir)) {
      // Restore shares and docker config (not users — current install has its own)
      const restorableFiles = ['shares.json', 'docker.json', 'installed-apps.json'];
      for (const file of restorableFiles) {
        const backupFile = path.join(backupDir, file);
        const targetFile = path.join(CONFIG_DIR, file);
        if (fs.existsSync(backupFile)) {
          // Overwrite if target doesn't exist or is empty/default
          const targetContent = fs.existsSync(targetFile) ? fs.readFileSync(targetFile, 'utf8').trim() : '';
          if (!targetContent || targetContent === '[]' || targetContent === '{}') {
            fs.copyFileSync(backupFile, targetFile);
          }
        }
      }
      restoredConfig = true;
    }

    // 8. Write/update identity file if missing
    if (!fs.existsSync(identityFile)) {
      fs.writeFileSync(identityFile, JSON.stringify({
        name: poolName,
        raidLevel: poolEntry.raidLevel,
        filesystem: fstype,
        disks: poolEntry.disks,
        createdAt: poolEntry.createdAt,
        nimbusVersion: '2.0.0-beta',
      }, null, 2));
    }

    // 9. Clear disk cache
    diskCache = null;

    console.log(`[Storage] Pool "${poolName}" restored from ${device} at ${mountPoint}`);
    return {
      ok: true,
      pool: poolEntry,
      restoredConfig,
      data: {
        hasDocker: fs.existsSync(path.join(mountPoint, 'docker')),
        hasShares: fs.existsSync(path.join(mountPoint, 'shares')),
        hasBackup: fs.existsSync(backupDir),
      },
    };

  } catch (err) {
    console.error(`[Storage] Restore pool failed:`, err.message);
    // Cleanup on failure
    execSync(`umount ${mountPoint} 2>/dev/null || true`);
    return { error: 'Restore failed: ' + err.message };
  }
}


module.exports = {
  getStorageConfig, saveStorageConfig, hasPool, detectStorageDisks,
  getRAIDStatus, getStoragePools, createPool, wipeDisk, destroyPool,
  backupConfigToPool, detectExistingPools, checkStorageHealth,
  scanForRestorablePools, restorePool,
  get storageAlerts() { return storageAlerts; },
  NIMBUS_POOLS_DIR,
};
