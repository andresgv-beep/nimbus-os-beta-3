/**
 * NimbusOS — Virtual Machines (QEMU/KVM) API
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { getSessionUser, run } = require('./shared.cjs');

// ═══════════════════════════════════
// Virtual Machines (QEMU/KVM) API
// ═══════════════════════════════════
const VM_DIR = '/var/lib/nimbusos/vms';
const ISO_DIR = '/var/lib/nimbusos/isos';

function handleVMs(url, method, body, req) {
  const session = getSessionUser(req);
  if (!session) return { error: 'Not authenticated' };

  // GET /api/vms/status — check if KVM is available
  if (url === '/api/vms/status' && method === 'GET') {
    const virshInstalled = !!(run('which virsh 2>/dev/null'));
    const qemuInstalled = !!(run('which qemu-system-x86_64 2>/dev/null'));
    const kvmSupport = run('grep -Ec "(vmx|svm)" /proc/cpuinfo 2>/dev/null') || '0';
    const kvmLoaded = !!(run('lsmod 2>/dev/null | grep kvm'));
    const libvirtdRunning = run('systemctl is-active libvirtd 2>/dev/null') === 'active';
    const version = run('virsh version --daemon 2>/dev/null | head -1') || '';
    
    // Ensure dirs exist
    run(`mkdir -p "${VM_DIR}" "${ISO_DIR}" 2>/dev/null`);
    
    return {
      installed: virshInstalled && qemuInstalled,
      kvmSupport: parseInt(kvmSupport) > 0,
      kvmLoaded,
      libvirtdRunning,
      version,
    };
  }

  // GET /api/vms/list — list all VMs
  if (url === '/api/vms/list' && method === 'GET') {
    const raw = run('virsh list --all 2>/dev/null') || '';
    const vms = [];
    const lines = raw.split('\n').filter(l => l.trim() && !l.includes('Id') && !l.includes('---'));
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) continue;
      const id = parts[0] === '-' ? null : parts[0];
      const name = parts[1];
      const status = parts.slice(2).join(' ');
      
      // Get VM details
      let cpu = '—', ram = '—', disk = '—', ip = '—';
      try {
        const info = run(`virsh dominfo "${name}" 2>/dev/null`) || '';
        const cpuMatch = info.match(/CPU\(s\):\s+(\d+)/);
        const ramMatch = info.match(/Max memory:\s+(\d+)/);
        if (cpuMatch) cpu = cpuMatch[1];
        if (ramMatch) ram = Math.round(parseInt(ramMatch[1]) / 1024 / 1024) + ' GB';
      } catch {}
      
      // Try to get IP if running
      if (status === 'running') {
        try {
          const ips = run(`virsh domifaddr "${name}" 2>/dev/null`) || '';
          const ipMatch = ips.match(/(\d+\.\d+\.\d+\.\d+)/);
          if (ipMatch) ip = ipMatch[1];
        } catch {}
      }
      
      // Get disk size
      try {
        const blk = run(`virsh domblklist "${name}" --details 2>/dev/null`) || '';
        const diskLine = blk.split('\n').find(l => l.includes('disk'));
        if (diskLine) {
          const diskPath = diskLine.trim().split(/\s+/).pop();
          if (diskPath && fs.existsSync(diskPath)) {
            const sz = run(`qemu-img info "${diskPath}" 2>/dev/null | grep "virtual size"`) || '';
            const szMatch = sz.match(/virtual size:\s+(.+?)(?:\s+\(|$)/);
            if (szMatch) disk = szMatch[1];
          }
        }
      } catch {}
      
      vms.push({ id, name, status, cpu, ram, disk, ip });
    }
    return { vms };
  }

  // GET /api/vms/overview — host stats
  if (url === '/api/vms/overview' && method === 'GET') {
    const hostname = run('hostname') || 'NimbusNAS';
    const cpuUsage = run("top -bn1 | grep '%Cpu' | awk '{print $2}' 2>/dev/null") || '0';
    const memInfo = run("free -m | awk '/Mem:/{printf \"%.0f\", $3/$2*100}' 2>/dev/null") || '0';
    const nodeInfo = run('virsh nodeinfo 2>/dev/null') || '';
    const totalCPUs = (nodeInfo.match(/CPU\(s\):\s+(\d+)/) || [,'?'])[1];
    const totalRAM = (nodeInfo.match(/Memory size:\s+(\d+)/) || [,'?'])[1];
    
    // Count VMs
    const raw = run('virsh list --all 2>/dev/null') || '';
    const lines = raw.split('\n').filter(l => l.trim() && !l.includes('Id') && !l.includes('---'));
    const running = lines.filter(l => l.includes('running')).length;
    const total = lines.length;
    
    return { hostname, cpuUsage, memUsage: memInfo, totalCPUs, totalRAM, running, total };
  }

  // POST /api/vms/create — create a new VM
  if (url === '/api/vms/create' && method === 'POST') {
    if (session.role !== 'admin') return { error: 'Admin required' };
    const { name, os, cpus, ram, ramUnit, disk, diskUnit, networkType, iso, autoStart, firmware } = body;
    if (!name) return { error: 'Name required' };
    
    // Sanitize name
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '');
    const diskPath = `${VM_DIR}/${safeName}.qcow2`;
    const diskSize = `${disk}${diskUnit === 'TB' ? 'T' : 'G'}`;
    const ramMB = ramUnit === 'GB' ? parseInt(ram) * 1024 : parseInt(ram);
    
    try {
      // Create disk
      execSync(`qemu-img create -f qcow2 "${diskPath}" ${diskSize}`, { encoding: 'utf-8', timeout: 30000 });
      
      // Build virt-install command
      let cmd = `virt-install --name "${safeName}"`;
      cmd += ` --vcpus ${cpus || 2}`;
      cmd += ` --memory ${ramMB || 2048}`;
      cmd += ` --disk path="${diskPath}",format=qcow2`;
      cmd += ` --os-variant generic`;
      cmd += ` --graphics vnc,listen=0.0.0.0`;
      
      // Network
      if (networkType === 'bridge') cmd += ` --network bridge=br0,model=virtio`;
      else if (networkType === 'nat') cmd += ` --network network=default,model=virtio`;
      else cmd += ` --network none`;
      
      // Firmware
      if (firmware === 'UEFI') cmd += ` --boot uefi`;
      
      // ISO
      if (iso) cmd += ` --cdrom "${ISO_DIR}/${iso}"`;
      else cmd += ` --import --noautoconsole`;
      
      if (!iso) cmd += ` --noautoconsole`;
      
      const log = execSync(cmd + ' 2>&1', { encoding: 'utf-8', timeout: 60000 });
      
      if (autoStart) {
        run(`virsh autostart "${safeName}" 2>/dev/null`);
      }
      
      return { ok: true, name: safeName, log };
    } catch (err) {
      return { error: err.message || 'Failed to create VM' };
    }
  }

  // POST /api/vms/action — start/stop/pause/resume/delete/restart
  if (url === '/api/vms/action' && method === 'POST') {
    if (session.role !== 'admin') return { error: 'Admin required' };
    const { name, action } = body;
    if (!name || !action) return { error: 'Name and action required' };
    
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '');
    let result;
    
    switch (action) {
      case 'start':
        result = run(`virsh start "${safeName}" 2>&1`);
        break;
      case 'stop':
        result = run(`virsh shutdown "${safeName}" 2>&1`);
        break;
      case 'force-stop':
        result = run(`virsh destroy "${safeName}" 2>&1`);
        break;
      case 'pause':
        result = run(`virsh suspend "${safeName}" 2>&1`);
        break;
      case 'resume':
        result = run(`virsh resume "${safeName}" 2>&1`);
        break;
      case 'restart':
        result = run(`virsh reboot "${safeName}" 2>&1`);
        break;
      case 'delete':
        run(`virsh destroy "${safeName}" 2>/dev/null`);
        run(`virsh undefine "${safeName}" --remove-all-storage 2>&1`);
        result = 'VM deleted';
        break;
      case 'autostart-on':
        result = run(`virsh autostart "${safeName}" 2>&1`);
        break;
      case 'autostart-off':
        result = run(`virsh autostart --disable "${safeName}" 2>&1`);
        break;
      default:
        return { error: 'Unknown action' };
    }
    
    return { ok: true, result };
  }

  // GET /api/vms/isos — list available ISOs
  if (url === '/api/vms/isos' && method === 'GET') {
    run(`mkdir -p "${ISO_DIR}" 2>/dev/null`);
    const files = run(`ls -lh "${ISO_DIR}"/*.iso 2>/dev/null`) || '';
    const isos = [];
    for (const line of files.split('\n').filter(Boolean)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 9) {
        const size = parts[4];
        const name = path.basename(parts.slice(8).join(' '));
        isos.push({ name, size });
      }
    }
    return { isos, path: ISO_DIR };
  }

  // GET /api/vms/networks — list virtual networks
  if (url === '/api/vms/networks' && method === 'GET') {
    const raw = run('virsh net-list --all 2>/dev/null') || '';
    const networks = [];
    const lines = raw.split('\n').filter(l => l.trim() && !l.includes('Name') && !l.includes('---'));
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2) {
        networks.push({ name: parts[0], state: parts[1], autostart: parts[2] || '—', persistent: parts[3] || '—' });
      }
    }
    
    // Also get bridge info
    const bridges = run('brctl show 2>/dev/null | tail -n +2') || '';
    
    return { networks, bridges };
  }

  // GET /api/vms/vnc/:name — get VNC port for a VM
  if (url.startsWith('/api/vms/vnc/') && method === 'GET') {
    const vmName = url.split('/').pop();
    const display = run(`virsh vncdisplay "${vmName}" 2>/dev/null`) || '';
    const port = display.trim() ? 5900 + parseInt(display.trim().replace(':', '')) : null;
    return { port, display: display.trim() };
  }

  // GET /api/vms/logs — recent libvirt logs
  if (url === '/api/vms/logs' && method === 'GET') {
    const logs = run('journalctl -u libvirtd --no-pager -n 50 --output=short 2>/dev/null') || '';
    return { logs };
  }

  // POST /api/vms/snapshot — create/list/revert snapshots
  if (url === '/api/vms/snapshot' && method === 'POST') {
    if (session.role !== 'admin') return { error: 'Admin required' };
    const { name, action: snapAction, snapshotName } = body;
    if (!name) return { error: 'VM name required' };
    
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '');
    
    if (snapAction === 'create') {
      const snapName = snapshotName || `snap-${Date.now()}`;
      const result = run(`virsh snapshot-create-as "${safeName}" "${snapName}" 2>&1`);
      return { ok: true, result };
    }
    if (snapAction === 'list') {
      const result = run(`virsh snapshot-list "${safeName}" 2>/dev/null`) || '';
      return { snapshots: result };
    }
    if (snapAction === 'revert') {
      if (!snapshotName) return { error: 'Snapshot name required' };
      const result = run(`virsh snapshot-revert "${safeName}" "${snapshotName}" 2>&1`);
      return { ok: true, result };
    }
    if (snapAction === 'delete') {
      if (!snapshotName) return { error: 'Snapshot name required' };
      const result = run(`virsh snapshot-delete "${safeName}" "${snapshotName}" 2>&1`);
      return { ok: true, result };
    }
    
    return { error: 'Unknown snapshot action' };
  }

  return null;
}


// ═══════════════════════════════════

module.exports = { handleVMs };
