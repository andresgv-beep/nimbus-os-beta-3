/**
 * NimbusOS — Installed Apps Registry & Native Apps Detection
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { CONFIG_DIR, NATIVE_APPS_FILE, run, getSessionUser } = require('./shared.cjs');

// ═══════════════════════════════════
// Installed Apps Registry
// ═══════════════════════════════════
const APPS_FILE = path.join(CONFIG_DIR, 'installed-apps.json');

function getInstalledApps() {
  try { 
    return JSON.parse(fs.readFileSync(APPS_FILE, 'utf-8'));
  }
  catch (err) { 
    return []; 
  }
}

function saveInstalledApps(apps) {
  fs.writeFileSync(APPS_FILE, JSON.stringify(apps, null, 2));
}

function registerApp(appData) {
  console.log(`[Apps] Registering app: ${appData.id}`);
  const apps = getInstalledApps();
  // Remove if already exists
  const filtered = apps.filter(a => a.id !== appData.id);
  
  let iconPath = appData.icon || '📦';
  
  // If icon is a URL, download it locally
  if (appData.icon && appData.icon.startsWith('http')) {
    try {
      const iconsDir = path.join(__dirname, '..', 'public', 'app-icons');
      if (!fs.existsSync(iconsDir)) {
        fs.mkdirSync(iconsDir, { recursive: true });
      }
      
      // Detect extension from URL or default to png
      const urlPath = appData.icon.split('?')[0];
      const urlExt = path.extname(urlPath).toLowerCase();
      const ext = ['.svg', '.png', '.jpg', '.jpeg', '.webp', '.ico'].includes(urlExt) ? urlExt : '.png';
      const iconFileName = `${appData.id}${ext}`;
      const localIconPath = path.join(iconsDir, iconFileName);
      
      // Download synchronously using curl
      execSync(`curl -sL -o "${localIconPath}" "${appData.icon}"`, { timeout: 10000 });
      
      // Use local path for the icon
      iconPath = `/app-icons/${iconFileName}`;
      console.log(`[App] Downloaded icon for ${appData.id}: ${iconPath}`);
    } catch (err) {
      console.error(`[App] Failed to download icon for ${appData.id}:`, err.message);
      iconPath = appData.icon; // Keep original URL as fallback
    }
  }
  
  filtered.push({
    id: appData.id,
    name: appData.name,
    icon: iconPath,
    port: appData.port,
    image: appData.image,
    type: appData.type || 'container', // container or stack
    color: appData.color || '#607D8B',
    external: appData.external || false,
    installedAt: new Date().toISOString(),
    installedBy: appData.installedBy || 'admin'
  });
  saveInstalledApps(filtered);
  return filtered;
}

function unregisterApp(appId) {
  const apps = getInstalledApps();
  const filtered = apps.filter(a => a.id !== appId);
  saveInstalledApps(filtered);
  return filtered;
}

// ═══════════════════════════════════
// Native Apps Detection & Management
// ═══════════════════════════════════

// Known native apps that NimbusOS can detect and integrate
const KNOWN_NATIVE_APPS = {
  'virtualization': {
    name: 'Virtual Machines (KVM)',
    description: 'Full virtualization with QEMU/KVM. Create and manage virtual machines.',
    category: 'system',
    checkCommand: 'which virsh 2>/dev/null && which qemu-system-x86_64 2>/dev/null',
    installCommand: 'sudo apt install -y qemu-kvm libvirt-daemon-system libvirt-clients bridge-utils virt-install virtinst && sudo systemctl enable libvirtd && sudo systemctl start libvirtd && sudo mkdir -p /var/lib/nimbusos/vms /var/lib/nimbusos/isos',
    uninstallCommand: 'sudo apt remove -y qemu-kvm libvirt-daemon-system libvirt-clients virt-install virtinst',
    port: null,
    icon: '/app-icons/virtualization.svg',
    color: '#7C4DFF',
    isNativeApp: true,
    nimbusApp: 'vms',
  },
  'transmission': {
    name: 'Transmission',
    description: 'Lightweight BitTorrent client with web interface and RPC API.',
    category: 'downloads',
    checkCommand: 'which transmission-daemon 2>/dev/null',
    installCommand: 'sudo apt install -y transmission-daemon && sudo systemctl stop transmission-daemon && sudo mkdir -p /etc/transmission-daemon /nimbus/downloads && sudo usermod -a -G debian-transmission nimbus 2>/dev/null; sudo systemctl enable transmission-daemon',
    uninstallCommand: 'sudo systemctl stop transmission-daemon; sudo systemctl disable transmission-daemon; sudo apt remove -y transmission-daemon',
    port: 9091,
    icon: '/app-icons/transmission.svg',
    color: '#B50D0D',
    configPath: '/etc/transmission-daemon/settings.json',
    isNativeApp: true,
    nimbusApp: 'downloads',
  },
  'amule': {
    name: 'aMule',
    description: 'eMule-compatible P2P client for ed2k and Kademlia networks.',
    category: 'downloads',
    checkCommand: 'systemctl is-active amuled || which amuled 2>/dev/null',
    installCommand: 'sudo apt install -y amule-daemon amule-utils && sudo systemctl enable amuled 2>/dev/null',
    uninstallCommand: 'sudo systemctl stop amuled; sudo apt remove -y amule-daemon amule-utils',
    port: 4711,
    icon: '/app-icons/amule.svg',
    color: '#0078D4',
    isNativeApp: true,
  },
  'onlyoffice': {
    name: 'OnlyOffice',
    checkCommand: 'which onlyoffice-desktopeditors || snap list onlyoffice-desktopeditors 2>/dev/null || ls /snap/bin/onlyoffice* 2>/dev/null || flatpak list 2>/dev/null | grep -i onlyoffice',
    port: null, // Desktop app, no web port
    icon: '/app-icons/onlyoffice.svg',
    color: '#FF6F3D',
    isDesktop: true,
    launchCommand: 'onlyoffice-desktopeditors || snap run onlyoffice-desktopeditors || flatpak run org.onlyoffice.desktopeditors'
  },
  'samba': {
    name: 'Samba (SMB)',
    checkCommand: 'systemctl is-active smbd',
    installCommand: 'sudo apt install -y samba',
    port: 445,
    icon: '📁',
    color: '#4A90A4',
    configPath: '/etc/samba/smb.conf'
  },
  'libreoffice': {
    name: 'LibreOffice',
    checkCommand: 'which libreoffice || snap list libreoffice 2>/dev/null',
    port: null,
    icon: '/app-icons/libreoffice.svg', 
    color: '#18A303',
    isDesktop: true,
    launchCommand: 'libreoffice'
  }
};

function getNativeApps() {
  try {
    if (!fs.existsSync(NATIVE_APPS_FILE)) return [];
    return JSON.parse(fs.readFileSync(NATIVE_APPS_FILE, 'utf-8'));
  } catch { return []; }
}

function saveNativeApps(apps) {
  fs.writeFileSync(NATIVE_APPS_FILE, JSON.stringify(apps, null, 2));
}

function detectNativeApp(appId) {
  const appDef = KNOWN_NATIVE_APPS[appId];
  if (!appDef) return { installed: false, running: false };
  
  try {
    const result = execSync(appDef.checkCommand, { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' }).trim();
    const isActive = result === 'active' || result.length > 0;
    return { installed: true, running: isActive };
  } catch {
    return { installed: false, running: false };
  }
}

function detectAllNativeApps() {
  const results = [];
  for (const [id, def] of Object.entries(KNOWN_NATIVE_APPS)) {
    const status = detectNativeApp(id);
    if (status.installed) {
      results.push({
        id,
        name: def.name,
        icon: def.icon,
        color: def.color,
        port: def.port,
        type: 'native',
        isDesktop: def.isDesktop || false,
        nimbusApp: def.nimbusApp || null,
        running: status.running
      });
    }
  }
  return results;
}

function registerNativeApp(appData) {
  const apps = getNativeApps();
  const filtered = apps.filter(a => a.id !== appData.id);
  filtered.push({
    ...appData,
    type: 'native',
    installedAt: new Date().toISOString()
  });
  saveNativeApps(filtered);
  return filtered;
}
function handleNativeApps(url, method, body, req) {
  const session = getSessionUser(req);
  
  // GET /api/native-apps — list detected native apps
  if (url === '/api/native-apps' && method === 'GET') {
    if (!session) return { error: 'Not authenticated' };
    
    const apps = detectAllNativeApps();
    return { apps };
  }
  
  // GET /api/native-apps/available — list all known native apps (installed or not)
  if (url === '/api/native-apps/available' && method === 'GET') {
    if (!session) return { error: 'Not authenticated' };
    
    const available = Object.entries(KNOWN_NATIVE_APPS).map(([id, def]) => {
      const status = detectNativeApp(id);
      return {
        id,
        name: def.name,
        description: def.description || '',
        category: def.category || 'system',
        icon: def.icon,
        color: def.color,
        port: def.port,
        installed: status.installed,
        running: status.running,
        installCommand: def.installCommand,
        uninstallCommand: def.uninstallCommand || null,
        isDesktop: def.isDesktop || false,
        isNativeApp: def.isNativeApp || false,
        nimbusApp: def.nimbusApp || null,
      };
    });
    return { apps: available };
  }
  
  // POST /api/native-apps/:id/start — start a native service
  const startMatch = url.match(/^\/api\/native-apps\/([a-z]+)\/start$/);
  if (startMatch && method === 'POST') {
    if (!session) return { error: 'Not authenticated' };
    if (session.role !== 'admin') return { error: 'Admin required' };
    
    const appId = startMatch[1];
    const appDef = KNOWN_NATIVE_APPS[appId];
    if (!appDef) return { error: 'Unknown app' };
    
    try {
      execSync(`sudo systemctl start ${appId}-daemon || sudo systemctl start ${appId}d || sudo systemctl start ${appId}`, 
        { encoding: 'utf-8', timeout: 30000 });
      return { ok: true, appId };
    } catch (err) {
      return { error: 'Failed to start service', detail: err.message };
    }
  }
  
  // POST /api/native-apps/:id/stop — stop a native service
  const stopMatch = url.match(/^\/api\/native-apps\/([a-z]+)\/stop$/);
  if (stopMatch && method === 'POST') {
    if (!session) return { error: 'Not authenticated' };
    if (session.role !== 'admin') return { error: 'Admin required' };
    
    const appId = stopMatch[1];
    const appDef = KNOWN_NATIVE_APPS[appId];
    if (!appDef) return { error: 'Unknown app' };
    
    try {
      execSync(`sudo systemctl stop ${appId}-daemon || sudo systemctl stop ${appId}d || sudo systemctl stop ${appId}`, 
        { encoding: 'utf-8', timeout: 30000 });
      return { ok: true, appId };
    } catch (err) {
      return { error: 'Failed to stop service', detail: err.message };
    }
  }
  
  // POST /api/native-apps/:id/install — install a native app
  const installMatch = url.match(/^\/api\/native-apps\/([a-zA-Z0-9_-]+)\/install$/);
  if (installMatch && method === 'POST') {
    if (!session) return { error: 'Not authenticated' };
    if (session.role !== 'admin') return { error: 'Admin required' };
    
    const appId = installMatch[1];
    const appDef = KNOWN_NATIVE_APPS[appId];
    if (!appDef) return { error: 'Unknown app' };
    if (!appDef.installCommand) return { error: 'No install command defined' };
    
    // Run install asynchronously so it doesn't block the server
    const logDir = '/var/log/nimbusos';
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    
    const statusFile = path.join(logDir, `install-${appId}.json`);
    // Mark as installing
    fs.writeFileSync(statusFile, JSON.stringify({ status: 'installing', appId, startedAt: new Date().toISOString() }));
    
    const { spawn } = require('child_process');
    const logFile = fs.openSync(path.join(logDir, `install-${appId}.log`), 'w');
    const child = spawn('bash', ['-c', appDef.installCommand], {
      detached: true,
      stdio: ['ignore', logFile, logFile],
    });
    
    child.on('close', (code) => {
      fs.closeSync(logFile);
      if (code === 0) {
        registerNativeApp({ id: appId, name: appDef.name, icon: appDef.icon, color: appDef.color, port: appDef.port, isDesktop: appDef.isDesktop || false, nimbusApp: appDef.nimbusApp || null });
        fs.writeFileSync(statusFile, JSON.stringify({ status: 'done', appId, code: 0 }));
      } else {
        fs.writeFileSync(statusFile, JSON.stringify({ status: 'error', appId, code }));
      }
    });
    child.unref();
    
    return { ok: true, appId, async: true, message: 'Installation started' };
  }
  
  // GET /api/native-apps/:id/install-status — check async install progress
  const installStatusMatch = url.match(/^\/api\/native-apps\/([a-zA-Z0-9_-]+)\/install-status$/);
  if (installStatusMatch && method === 'GET') {
    if (!session) return { error: 'Not authenticated' };
    const appId = installStatusMatch[1];
    const statusFile = `/var/log/nimbusos/install-${appId}.json`;
    try {
      if (fs.existsSync(statusFile)) {
        return JSON.parse(fs.readFileSync(statusFile, 'utf-8'));
      }
    } catch {}
    return { status: 'unknown' };
  }
  
  // POST /api/native-apps/:id/uninstall — uninstall a native app
  const uninstallMatch = url.match(/^\/api\/native-apps\/([a-zA-Z0-9_-]+)\/uninstall$/);
  if (uninstallMatch && method === 'POST') {
    if (!session) return { error: 'Not authenticated' };
    if (session.role !== 'admin') return { error: 'Admin required' };
    
    const appId = uninstallMatch[1];
    const appDef = KNOWN_NATIVE_APPS[appId];
    if (!appDef) return { error: 'Unknown app' };
    
    try {
      if (appDef.uninstallCommand) {
        execSync(appDef.uninstallCommand, { encoding: 'utf-8', timeout: 120000, stdio: 'pipe' });
      }
      // Remove from native apps list
      const apps = getNativeApps().filter(a => a.id !== appId);
      saveNativeApps(apps);
      return { ok: true, appId };
    } catch (err) {
      return { error: 'Uninstall failed', detail: err.stderr || err.message };
    }
  }

  // GET /api/native-apps/:id/status — check status of specific native app
  const statusMatch = url.match(/^\/api\/native-apps\/([a-z]+)\/status$/);
  if (statusMatch && method === 'GET') {
    if (!session) return { error: 'Not authenticated' };
    
    const appId = statusMatch[1];
    const appDef = KNOWN_NATIVE_APPS[appId];
    if (!appDef) return { error: 'Unknown app' };
    
    const status = detectNativeApp(appId);
    return { 
      id: appId, 
      name: appDef.name,
      ...status,
      port: appDef.port
    };
  }
  
  return null;
}


module.exports = {
  getInstalledApps, saveInstalledApps, registerApp, unregisterApp,
  KNOWN_NATIVE_APPS, getNativeApps, saveNativeApps, detectNativeApp, detectAllNativeApps, registerNativeApp,
  handleNativeApps,
};
