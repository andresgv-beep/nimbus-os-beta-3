/**
 * NimbusOS — Hardware monitoring (CPU, Memory, GPU, Temps, Network, Disks)
 */
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const { run, readFile, formatBytes, sanitizeDockerName } = require('./shared.cjs');

// Detect available tools once at startup
const HAS_SMARTCTL = !!run('which smartctl 2>/dev/null');
const HAS_SENSORS = !!run('which sensors 2>/dev/null');
const HAS_DOCKER = !!run('which docker 2>/dev/null');

// ═══════════════════════════════════
// CPU
// ═══════════════════════════════════
let prevCpu = null;

function getCpuUsage() {
  const stat = readFile('/proc/stat');
  if (!stat) return { percent: 0, cores: os.cpus().length, model: os.cpus()[0]?.model || 'Unknown' };

  const line = stat.split('\n')[0]; // "cpu  user nice system idle iowait irq softirq steal"
  const parts = line.split(/\s+/).slice(1).map(Number);
  const idle = parts[3] + parts[4];
  const total = parts.reduce((a, b) => a + b, 0);

  let percent = 0;
  if (prevCpu) {
    const diffIdle = idle - prevCpu.idle;
    const diffTotal = total - prevCpu.total;
    percent = diffTotal > 0 ? Math.round((1 - diffIdle / diffTotal) * 100) : 0;
  }
  prevCpu = { idle, total };

  return {
    percent,
    cores: os.cpus().length,
    model: os.cpus()[0]?.model || 'Unknown',
  };
}

// ═══════════════════════════════════
// Memory
// ═══════════════════════════════════
function getMemory() {
  const info = readFile('/proc/meminfo');
  if (!info) return { total: 0, used: 0, percent: 0 };

  const parse = (key) => {
    const m = info.match(new RegExp(`${key}:\\s+(\\d+)`));
    return m ? parseInt(m[1]) * 1024 : 0; // kB to bytes
  };

  const total = parse('MemTotal');
  const available = parse('MemAvailable');
  const used = total - available;

  return {
    total,
    used,
    totalGB: (total / 1073741824).toFixed(1),
    usedGB: (used / 1073741824).toFixed(1),
    percent: total > 0 ? Math.round((used / total) * 100) : 0,
  };
}
// ═══════════════════════════════════
// Hardware / GPU Driver Management
// ═══════════════════════════════════
function getHardwareGpuInfo() {
  const result = {
    gpus: [],
    currentDriver: null,
    driverVersion: null,
    availableDrivers: [],
    kernelModules: [],
  };

  // Detect GPUs via lspci
  const lspci = run('lspci -nn 2>/dev/null | grep -iE "VGA|3D|Display"');
  if (lspci) {
    lspci.split('\n').filter(Boolean).forEach(line => {
      const vendor = line.toLowerCase().includes('nvidia') ? 'nvidia'
        : line.toLowerCase().includes('amd') || line.toLowerCase().includes('ati') ? 'amd'
        : line.toLowerCase().includes('intel') ? 'intel' : 'unknown';
      const pciMatch = line.match(/\[([0-9a-f]{4}:[0-9a-f]{4})\]/i);
      result.gpus.push({
        description: line.replace(/^\S+\s+/, '').trim(),
        vendor,
        pciId: pciMatch ? pciMatch[1] : null,
      });
    });
  }
  
  // ARM/SBC fallback: detect GPU from device tree or kernel
  if (result.gpus.length === 0) {
    // Raspberry Pi VideoCore
    const vcgencmd = run('vcgencmd get_mem gpu 2>/dev/null');
    if (vcgencmd) {
      const model = run('cat /proc/device-tree/model 2>/dev/null') || 'Raspberry Pi';
      const gpuMem = vcgencmd.replace('gpu=', '').replace('M', ' MB').trim();
      result.gpus.push({
        description: `${model.trim()} — VideoCore (${gpuMem})`,
        vendor: 'broadcom',
        pciId: null,
      });
      result.currentDriver = 'v3d';
    }
    // Generic ARM GPU via /sys
    if (result.gpus.length === 0) {
      const gpuDevs = run('ls /sys/class/drm/card*/device/driver 2>/dev/null | head -1');
      if (gpuDevs) {
        const driverName = run('basename $(readlink /sys/class/drm/card0/device/driver) 2>/dev/null') || 'unknown';
        const model = run('cat /proc/device-tree/model 2>/dev/null') || 'ARM Device';
        result.gpus.push({
          description: `${model.trim()} — ${driverName}`,
          vendor: 'arm',
          pciId: null,
        });
        result.currentDriver = driverName;
      }
    }
  }

  // Current NVIDIA driver
  if (HAS_NVIDIA) {
    const ver = run('nvidia-smi --query-gpu=driver_version --format=csv,noheader,nounits 2>/dev/null');
    if (ver) {
      result.currentDriver = 'nvidia';
      result.driverVersion = ver.trim().split('\n')[0];
    }
  }

  // AMD driver
  const amdgpu = run('lsmod 2>/dev/null | grep amdgpu');
  if (amdgpu) {
    result.currentDriver = result.currentDriver || 'amdgpu';
    const amdVer = run('modinfo amdgpu 2>/dev/null | grep ^version:');
    if (amdVer) result.driverVersion = result.driverVersion || amdVer.replace('version:', '').trim();
  }

  // Intel driver
  const i915 = run('lsmod 2>/dev/null | grep i915');
  if (i915) {
    result.currentDriver = result.currentDriver || 'i915';
  }

  // Nouveau fallback
  const nouveau = run('lsmod 2>/dev/null | grep nouveau');
  if (nouveau) {
    result.currentDriver = result.currentDriver || 'nouveau';
    result.driverVersion = result.driverVersion || 'open-source';
  }

  // Loaded GPU kernel modules
  const mods = run('lsmod 2>/dev/null | grep -iE "nvidia|amdgpu|radeon|i915|nouveau"');
  if (mods) {
    result.kernelModules = mods.split('\n').filter(Boolean).map(l => {
      const parts = l.split(/\s+/);
      return { name: parts[0], size: parts[1], usedBy: parts[3] || '' };
    });
  }

  // Available drivers via ubuntu-drivers
  const ubuntuDrivers = run('ubuntu-drivers devices 2>/dev/null');
  if (ubuntuDrivers) {
    ubuntuDrivers.split('\n').filter(l => l.includes('driver')).forEach(line => {
      const match = line.match(/(nvidia-driver-\S+|xserver-xorg-video-\S+)/);
      if (match) {
        result.availableDrivers.push({
          package: match[1],
          recommended: line.toLowerCase().includes('recommended'),
          installed: line.toLowerCase().includes('installed'),
        });
      }
    });
  }

  // Fallback: check installed nvidia packages
  if (result.availableDrivers.length === 0 && result.gpus.some(g => g.vendor === 'nvidia')) {
    const aptList = run('apt list --installed 2>/dev/null | grep nvidia-driver');
    if (aptList) {
      aptList.split('\n').filter(Boolean).forEach(line => {
        const pkg = line.split('/')[0];
        if (pkg) result.availableDrivers.push({ package: pkg, installed: true, recommended: false });
      });
    }
  }

  return result;
}

// GPU (detect once at startup, skip if absent)
// ═══════════════════════════════════
const HAS_NVIDIA = !!run('which nvidia-smi 2>/dev/null');
const HAS_AMD_DRM = (() => {
  try {
    return fs.readdirSync('/sys/class/drm').some(d => {
      if (!d.match(/^card\d$/)) return false;
      return readFile(`/sys/class/drm/${d}/device/gpu_busy_percent`) !== null;
    });
  } catch { return false; }
})();

function getGpu() {
  const gpus = [];

  if (HAS_NVIDIA) {
    const nvidia = run('nvidia-smi --query-gpu=index,name,utilization.gpu,temperature.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null');
    if (nvidia) {
      nvidia.split('\n').forEach(line => {
        const [index, name, util, temp, memUsed, memTotal] = line.split(',').map(s => s.trim());
        gpus.push({
          index: parseInt(index),
          name,
          utilization: parseInt(util),
          temperature: parseInt(temp),
          memUsed: parseInt(memUsed),
          memTotal: parseInt(memTotal),
          memPercent: memTotal > 0 ? Math.round((parseInt(memUsed) / parseInt(memTotal)) * 100) : 0,
          driver: 'nvidia',
        });
      });
    }
  }

  if (HAS_AMD_DRM) {
    try {
      const amdDevs = fs.readdirSync('/sys/class/drm').filter(d => d.match(/^card\d$/));
      for (const card of amdDevs) {
        const busy = readFile(`/sys/class/drm/${card}/device/gpu_busy_percent`);
        const temp = readFile(`/sys/class/drm/${card}/device/hwmon/hwmon*/temp1_input`);
        if (busy !== null) {
          gpus.push({
            index: gpus.length,
            name: `AMD GPU (${card})`,
            utilization: parseInt(busy) || 0,
            temperature: temp ? Math.round(parseInt(temp) / 1000) : 0,
            memUsed: 0, memTotal: 0, memPercent: 0,
            driver: 'amd',
          });
        }
      }
    } catch {}
  }

  return gpus;
}

// ═══════════════════════════════════
// Temperature (auto-detect sources)
// ═══════════════════════════════════
function getTemps(gpusCache) {
  const temps = {};

  // CPU temp via /sys/class/thermal
  try {
    const zones = fs.readdirSync('/sys/class/thermal').filter(z => z.startsWith('thermal_zone'));
    for (const zone of zones) {
      const type = readFile(`/sys/class/thermal/${zone}/type`);
      const temp = readFile(`/sys/class/thermal/${zone}/temp`);
      if (type && temp) {
        temps[type] = Math.round(parseInt(temp) / 1000);
      }
    }
  } catch {}

  // Try lm-sensors as fallback
  if (Object.keys(temps).length === 0 && HAS_SENSORS) {
    const sensors = run('sensors -u 2>/dev/null');
    if (sensors) {
      const m = sensors.match(/temp1_input:\s+([\d.]+)/);
      if (m) temps['cpu'] = Math.round(parseFloat(m[1]));
    }
  }

  // GPU temps — use cached gpus if available to avoid double nvidia-smi
  const gpus = gpusCache || getGpu();
  gpus.forEach((g, i) => {
    if (g.temperature > 0) temps[`gpu${i}`] = g.temperature;
  });

  return temps;
}

// ═══════════════════════════════════
// Network
// ═══════════════════════════════════
let prevNet = {};

function getNetwork() {
  const interfaces = [];
  const netDir = '/sys/class/net';

  // Get all IPs in one call instead of per-interface
  const allIps = {};
  const ipOutput = run("ip -4 -o addr show 2>/dev/null");
  if (ipOutput) {
    ipOutput.split('\n').forEach(line => {
      const m = line.match(/^\d+:\s+(\S+)\s+inet\s+([\d.]+)/);
      if (m) allIps[m[1]] = m[2];
    });
  }

  // Only physical network interfaces (exclude virtual, docker, bridges, etc.)
  const isPhysicalInterface = (dev) => {
    // Exclude: lo, docker*, br-*, veth*, virbr*, tun*, tap*
    if (dev === 'lo') return false;
    if (dev.startsWith('docker')) return false;
    if (dev.startsWith('br-')) return false;
    if (dev.startsWith('veth')) return false;
    if (dev.startsWith('virbr')) return false;
    if (dev.startsWith('tun')) return false;
    if (dev.startsWith('tap')) return false;
    // Check if it's a physical device
    const physicalPath = `/sys/class/net/${dev}/device`;
    try {
      fs.statSync(physicalPath);
      return true; // Has a physical device backing
    } catch {
      // No physical device, but allow common naming patterns
      return dev.startsWith('eth') || dev.startsWith('enp') || dev.startsWith('eno') || dev.startsWith('ens') || dev.startsWith('wl');
    }
  };

  try {
    const devs = fs.readdirSync(netDir).filter(d => isPhysicalInterface(d));
    for (const dev of devs) {
      const operstate = readFile(`${netDir}/${dev}/operstate`) || 'unknown';
      
      // Only include interfaces that are UP
      if (operstate !== 'up') continue;
      
      const speed = readFile(`${netDir}/${dev}/speed`);
      const rxBytes = parseInt(readFile(`${netDir}/${dev}/statistics/rx_bytes`) || '0');
      const txBytes = parseInt(readFile(`${netDir}/${dev}/statistics/tx_bytes`) || '0');
      const mac = readFile(`${netDir}/${dev}/address`) || '';
      const isWifi = dev.startsWith('wl');
      
      // Get WiFi info if wireless
      let ssid = null, signal = null;
      if (isWifi) {
        ssid = run(`iwgetid -r ${dev} 2>/dev/null`) || run(`nmcli -t -f active,ssid dev wifi 2>/dev/null | grep '^yes' | cut -d: -f2`) || null;
        const sigRaw = run(`iwconfig ${dev} 2>/dev/null | grep -i signal`);
        if (sigRaw) {
          const sigMatch = sigRaw.match(/Signal level[=:]?\s*(-?\d+)/i);
          if (sigMatch) signal = parseInt(sigMatch[1]);
        }
      }

      const prev = prevNet[dev];
      let rxRate = 0, txRate = 0;
      if (prev) {
        const dt = (Date.now() - prev.time) / 1000;
        if (dt > 0) {
          rxRate = Math.round((rxBytes - prev.rx) / dt);
          txRate = Math.round((txBytes - prev.tx) / dt);
        }
      }
      prevNet[dev] = { rx: rxBytes, tx: txBytes, time: Date.now() };

      interfaces.push({
        name: dev,
        type: isWifi ? 'wifi' : 'ethernet',
        status: operstate,
        speed: speed && parseInt(speed) > 0 ? `${speed} Mbps` : isWifi && ssid ? 'WiFi' : '—',
        ip: allIps[dev] || '—',
        mac,
        ssid: ssid ? ssid.trim() : null,
        signal,
        rxBytes, txBytes,
        rxRate, txRate,
        rxRateFormatted: formatBytes(rxRate) + '/s',
        txRateFormatted: formatBytes(txRate) + '/s',
      });
    }
  } catch {}

  return interfaces;
}


// ═══════════════════════════════════
// Disks (with caching for expensive operations)
// ═══════════════════════════════════
let diskCache = null;
let diskCacheTime = 0;
const DISK_CACHE_MS = 60000; // refresh hardware info every 60s

function getDisks() {
  const now = Date.now();

  // Cache lsblk + smartctl results — they don't change often
  if (!diskCache || (now - diskCacheTime) > DISK_CACHE_MS) {
    const disks = [];
    const lsblk = run('lsblk -Jbdo NAME,SIZE,MODEL,TYPE,TRAN 2>/dev/null');
    if (lsblk) {
      try {
        const data = JSON.parse(lsblk);
        (data.blockdevices || []).forEach(dev => {
          if (dev.type !== 'disk') return;
          if (dev.name.startsWith('loop') || dev.name.startsWith('ram') || dev.name.startsWith('zram')) return;
          if (parseInt(dev.size) <= 0) return;

          let temp = null;
          if (HAS_SMARTCTL) {
            const smart = run(`smartctl -A /dev/${dev.name} 2>/dev/null | grep -i temperature | head -1`);
            if (smart) {
              const m = smart.match(/(\d+)\s*$/);
              if (m) temp = parseInt(m[1]);
            }
          }

          disks.push({
            name: `/dev/${dev.name}`,
            model: (dev.model || 'Unknown').trim(),
            size: parseInt(dev.size),
            sizeFormatted: formatBytes(parseInt(dev.size)),
            temperature: temp,
            transport: dev.tran || '—',
            type: 'disk',
          });
        });
      } catch {}
    }

    // RAID detection
    const mdstat = readFile('/proc/mdstat');
    const raids = [];
    if (mdstat) {
      const matches = mdstat.matchAll(/^(md\d+)\s*:\s*active\s+(\w+)\s+(.+)/gm);
      for (const m of matches) {
        raids.push({ name: m[1], type: m[2], devices: m[3].trim() });
      }
    }

    diskCache = { disks, raids };
    diskCacheTime = now;
  }

  // df is cheap, always refresh for current usage
  const mounts = [];
  const df = run('df -B1 --output=source,size,used,avail,target 2>/dev/null');
  if (df) {
    df.split('\n').slice(1).forEach(line => {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 5 && parts[0].startsWith('/dev/')) {
        if (parts[0].includes('loop')) return;
        mounts.push({
          device: parts[0],
          total: parseInt(parts[1]),
          used: parseInt(parts[2]),
          available: parseInt(parts[3]),
          mount: parts[4],
          totalFormatted: formatBytes(parseInt(parts[1])),
          usedFormatted: formatBytes(parseInt(parts[2])),
          percent: Math.round((parseInt(parts[2]) / parseInt(parts[1])) * 100),
        });
      }
    });
  }

  return { ...diskCache, mounts };
}

// ═══════════════════════════════════
// Uptime
// ═══════════════════════════════════
function getUptime() {
  const raw = readFile('/proc/uptime');
  if (!raw) return '—';
  const secs = parseFloat(raw.split(' ')[0]);
  const days = Math.floor(secs / 86400);
  const hours = Math.floor((secs % 86400) / 3600);
  const mins = Math.floor((secs % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

// ═══════════════════════════════════
// System summary (for widgets)
// ═══════════════════════════════════
function getSystemSummary() {
  const cpu = getCpuUsage();
  const mem = getMemory();
  const gpus = getGpu();
  const temps = getTemps(gpus); // pass gpus to avoid double nvidia-smi call
  const network = getNetwork();
  const diskInfo = getDisks();
  const uptime = getUptime();

  // Pick main temp (prefer cpu, x86_pkg_temp, or first available)
  const mainTemp = temps['x86_pkg_temp'] || temps['cpu'] || temps['coretemp']
    || Object.values(temps)[0] || null;

  // Pick primary network interface (first with an IP)
  const primaryNet = network.find(n => n.ip !== '—' && n.status === 'up') || network[0] || null;

  return {
    cpu,
    memory: mem,
    gpus,
    temps,
    mainTemp,
    network,
    primaryNet,
    disks: diskInfo,
    uptime,
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
  };
}

// ═══════════════════════════════════
// Docker (auto-detect socket, with caching)
// ═══════════════════════════════════
let containerCache = { data: null, time: 0 };
const CONTAINER_CACHE_MS = 5000; // docker stats is very slow, cache 5s

function getContainers() {
  if (!HAS_DOCKER) return [];
  const now = Date.now();
  if (containerCache.data && (now - containerCache.time) < CONTAINER_CACHE_MS) {
    return containerCache.data;
  }

  const raw = run('docker ps -a --format "{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}|{{.State}}|{{.CreatedAt}}" 2>/dev/null');
  if (!raw) return [];

  const containers = raw.split('\n').filter(Boolean).map(line => {
    const [id, name, image, status, ports, state, created] = line.split('|');
    return { id, name, image, status, ports: ports || '—', state, created };
  });

  // docker stats --no-stream blocks for ~1-2s, cache aggressively
  const stats = run('docker stats --no-stream --format "{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}" 2>/dev/null');
  if (stats) {
    const statMap = {};
    stats.split('\n').filter(Boolean).forEach(line => {
      const [name, cpu, mem, memPct] = line.split('|');
      statMap[name] = { cpu: cpu || '0%', mem: mem || '—', memPct: memPct || '0%' };
    });
    containers.forEach(c => {
      const s = statMap[c.name];
      if (s) { c.cpu = s.cpu; c.mem = s.mem; c.memPct = s.memPct; }
      else { c.cpu = '—'; c.mem = '—'; c.memPct = '—'; }
    });
  }

  containerCache = { data: containers, time: now };
  return containers;
}

function containerAction(id, action) {
  const allowed = ['start', 'stop', 'restart', 'pause', 'unpause'];
  if (!allowed.includes(action)) return { error: 'Invalid action' };
  
  // SECURITY: Sanitize container ID
  const safeId = sanitizeDockerName(id);
  if (!safeId) return { error: 'Invalid container ID' };
  
  const result = run(`docker ${action} ${safeId} 2>&1`);
  return { ok: true, action, id: safeId, output: result };
}

// ═══════════════════════════════════
// HTTP Server (with response caching)
// ═══════════════════════════════════
let systemCache = { data: null, time: 0 };
const SYSTEM_CACHE_MS = 1500; // 1.5s cache - prevents double hits from widgets+monitor

function getCachedSystem() {
  const now = Date.now();
  if (!systemCache.data || (now - systemCache.time) > SYSTEM_CACHE_MS) {
    systemCache = { data: getSystemSummary(), time: now };
  }
  return systemCache.data;
}

// ═══════════════════════════════════════════════════
// STORAGE MANAGER
// ═══════════════════════════════════════════════════

const NIMBUS_POOLS_DIR = '/nimbus/pools';

module.exports = {
  getCpuUsage, getMemory, getGpu, getHardwareGpuInfo, getTemps, getNetwork,
  getDisks, getUptime, getSystemSummary, getContainers, containerAction,
  getCachedSystem,
};
