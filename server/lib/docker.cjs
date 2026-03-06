/**
 * NimbusOS — Docker API (containers, compose, stacks)
 */
const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { NIMBUS_ROOT, CONFIG_DIR, DOCKER_FILE, getSessionUser, sanitizeDockerName, isValidPort, run } = require('./shared.cjs');
const { getShares, saveShares } = require('./shares.cjs');
const { getStorageConfig } = require('./storage.cjs');
const { registerApp, unregisterApp, getInstalledApps } = require('./apps.cjs');

// ═══════════════════════════════════
// Docker API (REAL EXECUTION)
// ═══════════════════════════════════
function getDockerConfig() {
  try { 
    const config = JSON.parse(fs.readFileSync(DOCKER_FILE, 'utf-8'));
    // Ensure appPermissions exists
    if (!config.appPermissions) config.appPermissions = {};
    return config;
  }
  catch { return { installed: false, path: null, permissions: [], appPermissions: {}, installedAt: null, containers: [] }; }
}

function saveDockerConfig(config) {
  fs.writeFileSync(DOCKER_FILE, JSON.stringify(config, null, 2));
}

// App metadata for known Docker images
const KNOWN_APPS = {
  'jellyfin': { displayName: 'Jellyfin', icon: '🎞️', color: '#00A4DC' },
  'plex': { displayName: 'Plex', icon: '🎬', color: '#E5A00D' },
  'nextcloud': { displayName: 'Nextcloud', icon: '☁️', color: '#0082C9' },
  'immich': { displayName: 'Immich', icon: '📸', color: '#4250AF' },
  'syncthing': { displayName: 'Syncthing', icon: '🔄', color: '#0891B2' },
  'transmission': { displayName: 'Transmission', icon: '⬇️', color: '#B50D0D' },
  'qbittorrent': { displayName: 'qBittorrent', icon: '📥', color: '#2F67BA' },
  'homeassistant': { displayName: 'Home Assistant', icon: '🏠', color: '#18BCF2' },
  'home-assistant': { displayName: 'Home Assistant', icon: '🏠', color: '#18BCF2' },
  'vaultwarden': { displayName: 'Vaultwarden', icon: '🔐', color: '#175DDC' },
  'portainer': { displayName: 'Portainer', icon: '📊', color: '#13BEF9' },
  'gitea': { displayName: 'Gitea', icon: '🦊', color: '#609926' },
  'pihole': { displayName: 'Pi-hole', icon: '🛡️', color: '#96060C' },
  'adguard': { displayName: 'AdGuard Home', icon: '🛡️', color: '#68BC71' },
  'nginx': { displayName: 'Nginx', icon: '🌐', color: '#009639' },
  'mariadb': { displayName: 'MariaDB', icon: '🗄️', color: '#003545' },
  'postgres': { displayName: 'PostgreSQL', icon: '🐘', color: '#336791' },
  'redis': { displayName: 'Redis', icon: '🔴', color: '#DC382D' },
  'grafana': { displayName: 'Grafana', icon: '📈', color: '#F46800' },
  'prometheus': { displayName: 'Prometheus', icon: '🔥', color: '#E6522C' },
  'code-server': { displayName: 'VS Code Server', icon: '💻', color: '#007ACC' },
  'filebrowser': { displayName: 'File Browser', icon: '📁', color: '#40C4FF' },
  'calibre': { displayName: 'Calibre', icon: '📚', color: '#964B00' },
  'sonarr': { displayName: 'Sonarr', icon: '📺', color: '#35C5F4' },
  'radarr': { displayName: 'Radarr', icon: '🎥', color: '#FFC230' },
  'prowlarr': { displayName: 'Prowlarr', icon: '🔍', color: '#FFC230' },
  'overseerr': { displayName: 'Overseerr', icon: '🎫', color: '#5B4BB6' },
  'tautulli': { displayName: 'Tautulli', icon: '📊', color: '#E5A00D' },
  'bazarr': { displayName: 'Bazarr', icon: '💬', color: '#9B59B6' },
  'lidarr': { displayName: 'Lidarr', icon: '🎵', color: '#1DB954' },
  'readarr': { displayName: 'Readarr', icon: '📖', color: '#8E44AD' },
};

function getAppMetaFromImage(image, containerName) {
  // Try to match by container name first
  const nameLower = containerName.toLowerCase();
  for (const [key, meta] of Object.entries(KNOWN_APPS)) {
    if (nameLower.includes(key)) {
      return meta;
    }
  }
  
  // Try to match by image name
  const imageLower = image.toLowerCase();
  for (const [key, meta] of Object.entries(KNOWN_APPS)) {
    if (imageLower.includes(key)) {
      return meta;
    }
  }
  
  // Default
  return { displayName: containerName, icon: '📦', color: '#78706A' };
}

// Check if Docker is actually installed on the system
function isDockerInstalled() {
  try {
    execSync('docker --version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// Get real container status from Docker
function getRealContainers() {
  try {
    const output = execSync('docker ps -a --format "{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}|{{.State}}"', { encoding: 'utf-8' });
    return output.trim().split('\n').filter(Boolean).map(line => {
      const [id, name, image, status, ports, state] = line.split('|');
      return { id, name, image, status, ports, state };
    });
  } catch {
    return [];
  }
}

function handleDocker(url, method, body, req) {
  const session = getSessionUser(req);
  
  // GET /api/installed-apps — get all installed apps (for launcher)
  if (url === '/api/installed-apps' && method === 'GET') {
    if (!session) return { error: 'Not authenticated' };
    
    const apps = getInstalledApps();
    const config = getDockerConfig();
    
    // Filter based on user permissions if not admin
    if (session.role !== 'admin') {
      return apps.filter(app => {
        const appPerms = config.appPermissions?.[app.id] || [];
        return appPerms.includes(session.username);
      });
    }
    
    return apps;
  }
  
  // DELETE /api/installed-apps/:id — unregister an app
  const unregMatch = url.match(/^\/api\/installed-apps\/([a-zA-Z0-9_-]+)$/);
  if (unregMatch && method === 'DELETE') {
    if (!session || session.role !== 'admin') return { error: 'Unauthorized' };
    
    const appId = unregMatch[1];
    unregisterApp(appId);
    return { ok: true, appId };
  }
  
  // GET /api/docker/status — check if Docker is installed and user has permission
  if (url === '/api/docker/status' && method === 'GET') {
    if (!session) return { error: 'Not authenticated' };
    
    const config = getDockerConfig();
    const hasPermission = session.role === 'admin' || config.permissions.includes(session.username);
    const dockerRunning = isDockerInstalled();
    
    // If Docker is installed on system but not in our config, sync it
    if (dockerRunning && !config.installed) {
      config.installed = true;
      config.installedAt = new Date().toISOString();
      saveDockerConfig(config);
    }
    
    // Get real containers if Docker is running
    const realContainers = dockerRunning ? getRealContainers() : [];
    
    return {
      installed: config.installed || dockerRunning,
      path: config.path || '/var/lib/docker',
      hasPermission,
      installedAt: config.installedAt,
      containers: hasPermission ? realContainers : [],
      dockerRunning
    };
  }
  
  // GET /api/docker/permissions — get who has Docker access (admin only)
  if (url === '/api/docker/permissions' && method === 'GET') {
    if (!session || session.role !== 'admin') return { error: 'Unauthorized' };
    
    const config = getDockerConfig();
    const users = getUsers().map(u => ({
      username: u.username,
      role: u.role,
      hasAccess: u.role === 'admin' || config.permissions.includes(u.username)
    }));
    
    return { users, permissions: config.permissions };
  }
  
  // PUT /api/docker/permissions — update Docker permissions (admin only)
  if (url === '/api/docker/permissions' && method === 'PUT') {
    if (!session || session.role !== 'admin') return { error: 'Unauthorized' };
    
    const { permissions } = body;
    if (!Array.isArray(permissions)) return { error: 'Invalid permissions format' };
    
    const config = getDockerConfig();
    config.permissions = permissions;
    saveDockerConfig(config);
    
    return { ok: true, permissions };
  }
  
  // GET /api/docker/app-permissions — get all app permissions (admin only)
  if (url === '/api/docker/app-permissions' && method === 'GET') {
    if (!session || session.role !== 'admin') return { error: 'Unauthorized' };
    
    const config = getDockerConfig();
    const users = getUsers();
    const shares = getShares();
    
    // Get installed apps (containers + stacks)
    const installedApps = [];
    
    // Add containers
    const containers = getRealContainers();
    containers.forEach(c => {
      installedApps.push({
        id: c.name,
        name: c.name,
        type: 'container',
        image: c.image
      });
    });
    
    // Check for stacks
    const stacksPath = path.join(config.path || '/var/lib/docker', 'stacks');
    if (fs.existsSync(stacksPath)) {
      try {
        const stacks = fs.readdirSync(stacksPath);
        stacks.forEach(s => {
          if (fs.existsSync(path.join(stacksPath, s, 'docker-compose.yml'))) {
            installedApps.push({
              id: s,
              name: s,
              type: 'stack'
            });
          }
        });
      } catch {}
    }
    
    return {
      users: users.map(u => ({ username: u.username, role: u.role })),
      apps: installedApps,
      shares: shares.map(s => ({ name: s.name, displayName: s.displayName, permissions: s.permissions })),
      appPermissions: config.appPermissions || {},
      dockerPermissions: config.permissions || []
    };
  }
  
  // PUT /api/docker/app-permissions/:appId — update permissions for specific app
  const appPermMatch = url.match(/^\/api\/docker\/app-permissions\/([a-zA-Z0-9_-]+)$/);
  if (appPermMatch && method === 'PUT') {
    if (!session || session.role !== 'admin') return { error: 'Unauthorized' };
    
    const appId = appPermMatch[1];
    const { users: allowedUsers } = body;
    
    if (!Array.isArray(allowedUsers)) return { error: 'Invalid format' };
    
    const config = getDockerConfig();
    if (!config.appPermissions) config.appPermissions = {};
    config.appPermissions[appId] = allowedUsers;
    saveDockerConfig(config);
    
    return { ok: true, appId, users: allowedUsers };
  }
  
  // GET /api/docker/app-access/:appId — check if current user has access to app
  const appAccessMatch = url.match(/^\/api\/docker\/app-access\/([a-zA-Z0-9_-]+)$/);
  if (appAccessMatch && method === 'GET') {
    if (!session) return { error: 'Not authenticated' };
    
    const appId = appAccessMatch[1];
    const config = getDockerConfig();
    
    // Admin always has access
    if (session.role === 'admin') return { hasAccess: true, appId };
    
    // Check app-specific permissions
    const appPerms = config.appPermissions?.[appId] || [];
    const hasAccess = appPerms.includes(session.username);
    
    return { hasAccess, appId };
  }
  
  // GET /api/docker/app-folders/:appId — get folders accessible by an app
  const appFoldersMatch = url.match(/^\/api\/docker\/app-folders\/([a-zA-Z0-9_-]+)$/);
  if (appFoldersMatch && method === 'GET') {
    if (!session) return { error: 'Not authenticated' };
    
    const appId = appFoldersMatch[1];
    const shares = getShares();
    
    // Filter shares that have this app in their appPermissions
    const accessibleFolders = shares.filter(s => {
      const appPerms = s.appPermissions || [];
      return appPerms.includes(appId);
    }).map(s => ({
      name: s.name,
      displayName: s.displayName,
      path: s.path
    }));
    
    return { appId, folders: accessibleFolders };
  }
  
  // GET /api/permissions/matrix — get full permissions matrix (admin only)
  if (url === '/api/permissions/matrix' && method === 'GET') {
    if (!session || session.role !== 'admin') return { error: 'Unauthorized' };
    
    const users = getUsers();
    const shares = getShares();
    const dockerConfig = getDockerConfig();
    
    // Get installed apps
    const installedApps = [];
    const containers = getRealContainers();
    containers.forEach(c => {
      installedApps.push({ id: c.name, name: c.name, type: 'container' });
    });
    
    // Check for stacks
    const stacksPath = path.join(dockerConfig.path || '/var/lib/docker', 'stacks');
    if (fs.existsSync(stacksPath)) {
      try {
        fs.readdirSync(stacksPath).forEach(s => {
          if (fs.existsSync(path.join(stacksPath, s, 'docker-compose.yml'))) {
            installedApps.push({ id: s, name: s, type: 'stack' });
          }
        });
      } catch {}
    }
    
    return {
      users: users.map(u => ({ 
        username: u.username, 
        role: u.role,
        dockerAccess: u.role === 'admin' || dockerConfig.permissions.includes(u.username)
      })),
      shares: shares.map(s => ({
        name: s.name,
        displayName: s.displayName,
        userPermissions: s.permissions || {},
        appPermissions: s.appPermissions || []
      })),
      apps: installedApps,
      dockerAdmins: dockerConfig.permissions || []
    };
  }
  
  // POST /api/hardware/install-driver — install/remove GPU driver (admin only)
  // POST /api/firewall/add-rule — add firewall rule (admin only)
  if (url === '/api/firewall/add-rule' && method === 'POST') {
    if (!session || session.role !== 'admin') return { error: 'Unauthorized' };
    
    const { port, protocol, source, action } = body;
    if (!port || !protocol || !action) return { error: 'port, protocol, and action required' };
    
    // Validate
    const portNum = String(port);
    if (!/^\d+(-\d+)?$/.test(portNum)) return { error: 'Invalid port format' };
    if (!['tcp', 'udp', 'both'].includes(protocol)) return { error: 'protocol must be tcp, udp, or both' };
    if (!['allow', 'deny', 'limit'].includes(action)) return { error: 'action must be allow, deny, or limit' };
    
    const hasUfw = !!run('which ufw 2>/dev/null');
    
    if (hasUfw) {
      // Enable ufw if not active
      const status = run('ufw status 2>/dev/null');
      if (status && !status.includes('Status: active')) {
        run('echo "y" | ufw enable 2>/dev/null');
      }
      
      const proto = protocol === 'both' ? '' : `/${protocol}`;
      const src = source && source !== 'any' && source !== 'Any' ? ` from ${source}` : '';
      const cmd = `ufw ${action} ${portNum}${proto}${src}`;
      const result = run(`${cmd} 2>&1`);
      return { ok: true, command: cmd, result: result || 'Rule added' };
    } else {
      // Fallback to iptables
      const act = action === 'allow' ? 'ACCEPT' : action === 'deny' ? 'DROP' : 'REJECT';
      const protos = protocol === 'both' ? ['tcp', 'udp'] : [protocol];
      const results = [];
      for (const p of protos) {
        const src = source && source !== 'any' && source !== 'Any' ? `-s ${source}` : '';
        const cmd = `iptables -A INPUT -p ${p} --dport ${portNum} ${src} -j ${act}`;
        results.push(run(`${cmd} 2>&1`) || 'Rule added');
      }
      return { ok: true, results };
    }
  }

  // POST /api/firewall/remove-rule — remove firewall rule (admin only)
  if (url === '/api/firewall/remove-rule' && method === 'POST') {
    if (!session || session.role !== 'admin') return { error: 'Unauthorized' };
    
    const { ruleNum } = body;
    if (!ruleNum) return { error: 'ruleNum required' };
    
    const hasUfw = !!run('which ufw 2>/dev/null');
    const ufwActive = hasUfw && (run('ufw status 2>/dev/null') || '').includes('Status: active');
    
    if (ufwActive) {
      const result = run(`echo "y" | ufw delete ${ruleNum} 2>&1`);
      return { ok: true, result: result || 'Rule removed' };
    } else {
      const result = run(`iptables -D INPUT ${ruleNum} 2>&1`);
      return { ok: true, result: result || 'Rule removed' };
    }
  }

  // POST /api/firewall/toggle — enable/disable firewall (admin only)
  if (url === '/api/firewall/toggle' && method === 'POST') {
    if (!session || session.role !== 'admin') return { error: 'Unauthorized' };
    
    const { enable } = body;
    const hasUfw = !!run('which ufw 2>/dev/null');
    
    if (hasUfw) {
      const cmd = enable ? 'echo "y" | ufw enable' : 'ufw disable';
      const result = run(`${cmd} 2>&1`);
      return { ok: true, result: result || (enable ? 'Firewall enabled' : 'Firewall disabled') };
    }
    return { error: 'ufw not installed. Install with: apt install ufw' };
  }

  // POST /api/hardware/install-driver — install/remove GPU driver (admin only)
  // Body: { package: "nvidia-driver-550", action: "install" | "remove" }
  if (url === '/api/hardware/install-driver' && method === 'POST') {
    if (!session || session.role !== 'admin') return { error: 'Unauthorized' };
    
    const { package: pkg, action } = body;
    if (!pkg || !action) return { error: 'package and action required' };
    
    // Validate package name (only allow driver packages)
    if (!/^(nvidia-driver-\d+|nvidia-driver-\d+-server|nvidia-driver-\d+-open|xserver-xorg-video-\w+|mesa-\w+|linux-modules-nvidia-\S+)$/.test(pkg)) {
      return { error: 'Invalid driver package name' };
    }
    
    if (action !== 'install' && action !== 'remove') {
      return { error: 'action must be install or remove' };
    }
    
    const cmd = action === 'install'
      ? `apt-get install -y ${pkg}`
      : `apt-get remove -y ${pkg}`;
    
    // Run in background — return immediately
    const { exec } = require('child_process');
    const logFile = `/tmp/nimbus-driver-${Date.now()}.log`;
    exec(`${cmd} > ${logFile} 2>&1`, { timeout: 300000 }, (err) => {
      if (err) {
        fs.appendFileSync(logFile, `\nERROR: ${err.message}\n`);
      } else {
        fs.appendFileSync(logFile, `\nSUCCESS: ${action} ${pkg} completed\n`);
      }
    });
    
    return { ok: true, message: `${action} ${pkg} started`, logFile };
  }

  // GET /api/hardware/driver-log/:file — read driver install log
  if (url.startsWith('/api/hardware/driver-log/') && method === 'GET') {
    const logFile = '/tmp/' + url.split('/').pop();
    if (!logFile.startsWith('/tmp/nimbus-driver-')) return { error: 'Invalid log file' };
    try {
      const content = fs.readFileSync(logFile, 'utf8');
      const done = content.includes('SUCCESS:') || content.includes('ERROR:');
      const success = content.includes('SUCCESS:');
      return { content, done, success };
    } catch { return { content: 'Waiting...', done: false, success: false }; }
  }

  // POST /api/docker/install — install Docker and configure data path on a pool (admin only)
  if (url === '/api/docker/install' && method === 'POST') {
    if (!session || session.role !== 'admin') return { error: 'Unauthorized' };
    
    const { path: dockerPath, permissions, pool: poolName } = body;
    
    // Require a pool
    const storageConf = getStorageConfig();
    if (!storageConf.pools || storageConf.pools.length === 0) {
      return { error: 'No storage pools available. Create a pool in Storage Manager first.' };
    }
    
    // Determine which pool to use
    const targetPool = poolName
      ? storageConf.pools.find(p => p.name === poolName)
      : storageConf.pools.find(p => p.name === storageConf.primaryPool) || storageConf.pools[0];
    
    if (!targetPool) {
      return { error: 'Selected pool not found.' };
    }
    
    // Determine full path
    let fullPath;
    if (dockerPath && dockerPath.startsWith('/')) {
      fullPath = dockerPath;
    } else {
      fullPath = path.join(targetPool.mountPoint, 'docker');
    }
    
    const containersPath = path.join(fullPath, 'containers');
    const volumesPath = path.join(fullPath, 'volumes');
    const stacksPath = path.join(fullPath, 'stacks');
    
    // Check if parent directory exists
    const parentDir = path.dirname(fullPath);
    if (!fs.existsSync(parentDir)) {
      return { 
        error: 'Parent directory does not exist', 
        detail: `Cannot create ${fullPath} because ${parentDir} does not exist.`
      };
    }
    
    // Create directories
    try {
      fs.mkdirSync(containersPath, { recursive: true });
      fs.mkdirSync(volumesPath, { recursive: true });
      fs.mkdirSync(stacksPath, { recursive: true });
    } catch (err) {
      return { error: 'Error creando directorios', detail: err.message };
    }
    
    // Check if Docker is available — install if not
    let dockerAvailable = isDockerInstalled();
    
    if (!dockerAvailable) {
      try {
        console.log('[Docker] Installing Docker engine...');
        execSync('curl -fsSL https://get.docker.com | sh', { timeout: 300000, stdio: 'pipe' });
        execSync(`usermod -aG docker ${session.username} 2>/dev/null || true`, { timeout: 5000 });
        // Add nimbus user too
        execSync('usermod -aG docker nimbus 2>/dev/null || true', { timeout: 5000 });
        dockerAvailable = true;
        console.log('[Docker] Engine installed successfully');
      } catch (err) {
        return { error: 'Docker installation failed', detail: err.stderr || err.message };
      }
    }
    
    // Configure Docker daemon to use pool as data-root
    if (dockerAvailable) {
      const daemonJsonPath = '/etc/docker/daemon.json';
      let daemonConfig = {};
      try {
        if (fs.existsSync(daemonJsonPath)) {
          daemonConfig = JSON.parse(fs.readFileSync(daemonJsonPath, 'utf-8'));
        }
      } catch {}
      
      const dockerDataPath = path.join(fullPath, 'data');
      daemonConfig['data-root'] = dockerDataPath;
      
      try {
        fs.mkdirSync('/etc/docker', { recursive: true });
        fs.mkdirSync(dockerDataPath, { recursive: true });
        fs.writeFileSync(daemonJsonPath, JSON.stringify(daemonConfig, null, 2));
        execSync('systemctl enable docker', { timeout: 10000 });
        execSync('systemctl restart docker', { timeout: 30000 });
        console.log('[Docker] daemon.json configured with data-root:', dockerDataPath);
      } catch (err) {
        console.error('[Docker] Failed to configure daemon.json:', err.message);
      }
    }
    
    // Update config
    const config = getDockerConfig();
    config.installed = true; // Config is done
    config.dockerAvailable = dockerAvailable; // Docker engine status
    config.path = fullPath;
    config.permissions = permissions || [];
    config.installedAt = new Date().toISOString();
    saveDockerConfig(config);
    
    // Create shared folder for docker
    const shares = getShares();
    if (!shares.find(s => s.name === 'docker')) {
      shares.push({
        name: 'docker',
        displayName: 'Docker',
        description: 'Docker containers and data',
        path: fullPath,
        volume: targetPool ? targetPool.name : 'system',
        pool: targetPool ? targetPool.name : null,
        created: new Date().toISOString(),
        createdBy: session.username,
        recycleBin: false,
        permissions: { [session.username]: 'rw' },
        appPermissions: []
      });
      saveShares(shares);
    }
    
    console.log('[Docker] Configured. Path:', fullPath, 'Docker available:', dockerAvailable);
    
    return { 
      ok: true, 
      path: fullPath, 
      dockerAvailable,
      message: dockerAvailable ? 'Docker configurado correctamente' : 'Configurado. Docker no detectado en el sistema.'
    };
  }
  
  // POST /api/docker/uninstall — fully uninstall Docker (admin only)
  if (url === '/api/docker/uninstall' && method === 'POST') {
    if (!session || session.role !== 'admin') return { error: 'Unauthorized' };
    
    try {
      // 1. Stop all containers
      run('docker stop $(docker ps -aq) 2>/dev/null || true');
      run('docker rm $(docker ps -aq) 2>/dev/null || true');
      
      // 2. Stop Docker
      run('systemctl stop docker 2>/dev/null || true');
      run('systemctl stop docker.socket 2>/dev/null || true');
      run('systemctl disable docker 2>/dev/null || true');
      
      // 3. Remove Docker packages
      execSync('apt-get purge -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin 2>/dev/null || true', { timeout: 60000, stdio: 'pipe' });
      execSync('apt-get autoremove -y 2>/dev/null || true', { timeout: 30000, stdio: 'pipe' });
      
      // 4. Remove daemon.json
      run('rm -f /etc/docker/daemon.json 2>/dev/null || true');
      
      // 5. Reset NimbusOS docker config
      const config = getDockerConfig();
      config.installed = false;
      config.dockerAvailable = false;
      config.path = null;
      config.permissions = [];
      config.installedAt = null;
      saveDockerConfig(config);
      
      // 6. Remove docker share
      const shares = getShares().filter(s => s.name !== 'docker');
      saveShares(shares);
      
      console.log('[Docker] Fully uninstalled');
      return { ok: true };
    } catch (err) {
      return { error: 'Uninstall failed', detail: err.message };
    }
  }
  
  // DELETE /api/docker/uninstall — alias for backwards compat
  if (url === '/api/docker/uninstall' && method === 'DELETE') {
    if (!session || session.role !== 'admin') return { error: 'Unauthorized' };
    const config = getDockerConfig();
    config.installed = false;
    config.path = null;
    config.permissions = [];
    config.installedAt = null;
    saveDockerConfig(config);
    return { ok: true };
  }
  
  // POST /api/docker/container — create/run a real container
  if (url === '/api/docker/container' && method === 'POST') {
    if (!session) return { error: 'Not authenticated' };
    
    const config = getDockerConfig();
    if (!isDockerInstalled()) return { error: 'Docker not installed' };
    
    const hasPermission = session.role === 'admin' || config.permissions.includes(session.username);
    if (!hasPermission) return { error: 'No permission to manage Docker', code: 'NO_PERMISSION' };
    
    const { id, name, image, ports, volumes, env, mediaPath } = body;
    if (!id || !name || !image) return { error: 'Missing container info' };
    
    // SECURITY: Sanitize all inputs
    const safeId = sanitizeDockerName(id);
    const safeName = sanitizeDockerName(name);
    const safeImage = sanitizeDockerName(image);
    
    if (!safeId || !safeName || !safeImage) {
      return { error: 'Invalid container name or image (special characters not allowed)' };
    }
    
    // Build docker run command with sanitized values
    let cmd = `docker run -d --name ${safeId} --restart unless-stopped`;
    
    // Add port mappings (validate ports)
    if (ports) {
      for (const [host, container] of Object.entries(ports)) {
        if (!isValidPort(host) || !isValidPort(container)) {
          return { error: `Invalid port mapping: ${host}:${container}` };
        }
        cmd += ` -p ${parseInt(host)}:${parseInt(container)}`;
      }
    }
    
    // Add config volume for container data
    const containerDataPath = path.join(config.path || '/var/lib/docker', 'containers', safeId);
    
    // Prevent path traversal
    if (containerDataPath.includes('..')) {
      return { error: 'Invalid container path' };
    }
    
    fs.mkdirSync(containerDataPath, { recursive: true });
    cmd += ` -v ${containerDataPath}:/config`;
    
    // ═══════════════════════════════════════════════════════════
    // CRITICAL: Mount ONLY shared folders that have this app in appPermissions
    // ═══════════════════════════════════════════════════════════
    const shares = getShares();
    const allowedShares = shares.filter(s => {
      const appPerms = s.appPermissions || [];
      return appPerms.includes(safeId);
    });
    
    // Mount allowed shares to /media/{shareName}
    for (const share of allowedShares) {
      const sharePath = share.path;
      const mountPoint = `/media/${share.name}`;
      
      // Validate path
      if (!sharePath || sharePath.includes('..')) continue;
      if (!fs.existsSync(sharePath)) continue;
      
      // Mount as read-only for safety (apps shouldn't modify media by default)
      // Apps that need write access can be configured differently
      cmd += ` -v "${sharePath}":"${mountPoint}":ro`;
      
      console.log(`[Docker] Mounting share "${share.name}" -> ${mountPoint} (ro)`);
    }
    
    // Also mount custom media path if specified (legacy support)
    if (mediaPath && typeof mediaPath === 'string') {
      const safePath = mediaPath.replace(/\.\./g, '');
      if (fs.existsSync(safePath)) {
        cmd += ` -v "${safePath}":/media:ro`;
      }
    }
    
    // Legacy volumes (from app catalog)
    if (volumes) {
      for (const [host, container] of Object.entries(volumes)) {
        // Sanitize volume paths
        const hostPath = host.replace('{DOCKER_PATH}', config.path || '/var/lib/docker');
        if (hostPath.includes('..') || container.includes('..')) {
          return { error: 'Invalid volume path' };
        }
        // Only allow alphanumeric and path chars
        if (!/^[a-zA-Z0-9_.\-\/]+$/.test(hostPath) || !/^[a-zA-Z0-9_.\-\/]+$/.test(container)) {
          return { error: 'Invalid characters in volume path' };
        }
        cmd += ` -v ${hostPath}:${container}`;
      }
    }
    
    // Add environment variables (SANITIZED)
    if (env) {
      for (const [key, value] of Object.entries(env)) {
        if (value && !value.includes('{')) {
          // Only allow safe characters in env key and value
          if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
            return { error: `Invalid environment variable name: ${key}` };
          }
          // Escape value for shell (remove dangerous chars)
          const safeValue = String(value).replace(/[`$\\;"'|&<>]/g, '');
          if (safeValue.length > 1000) {
            return { error: `Environment value too long: ${key}` };
          }
          cmd += ` -e ${key}="${safeValue}"`;
        }
      }
    }
    
    // Add image (use sanitized)
    cmd += ` ${safeImage}`;
    
    console.log('[Docker] Running:', cmd);
    console.log(`[Docker] App "${safeId}" has access to ${allowedShares.length} shared folders`);
    
    try {
      const output = execSync(cmd, { encoding: 'utf-8', timeout: 120000 });
      const containerId = output.trim();
      
      // Register app in installed-apps registry
      const appPort = ports ? Object.keys(ports)[0] : null;
      registerApp({
        id: safeId,
        name: safeName,
        icon: body.icon || '📦',
        port: appPort ? parseInt(appPort) : null,
        image: safeImage,
        type: 'container',
        color: body.color || '#607D8B',
        installedBy: session.username
      });
      
      console.log(`[Docker] App "${safeId}" registered in launcher`);
      
      return { 
        ok: true, 
        containerId,
        container: { id: safeId, name: safeName, image: safeImage, status: 'running' },
        mountedShares: allowedShares.map(s => s.name)
      };
    } catch (err) {
      console.error('[Docker] Container creation failed:', err.message);
      return { error: 'Failed to create container', detail: err.stderr || err.message };
    }
  }
  
  // POST /api/docker/stack — deploy a docker-compose stack
  if (url === '/api/docker/stack' && method === 'POST') {
    if (!session) return { error: 'Not authenticated' };
    
    const config = getDockerConfig();
    if (!isDockerInstalled()) return { error: 'Docker not installed' };
    
    const hasPermission = session.role === 'admin' || config.permissions.includes(session.username);
    if (!hasPermission) return { error: 'No permission to manage Docker', code: 'NO_PERMISSION' };
    
    const { id, name, compose, env } = body;
    if (!id || !name || !compose) return { error: 'Missing stack info' };
    
    console.log('[Docker] Received compose for', id, '- length:', compose?.length || 0);
    
    // SECURITY: Sanitize ID
    const safeId = sanitizeDockerName(id);
    if (!safeId) return { error: 'Invalid stack ID' };
    
    // Create stack directory
    const stackPath = path.join(config.path || '/var/lib/docker', 'stacks', safeId);
    
    if (stackPath.includes('..')) {
      return { error: 'Invalid stack path' };
    }
    
    // ═══════════════════════════════════════════════════════════
    // Get allowed shared folders for this app
    // ═══════════════════════════════════════════════════════════
    const shares = getShares();
    const allowedShares = shares.filter(s => {
      const appPerms = s.appPermissions || [];
      return appPerms.includes(safeId);
    });
    
    try {
      fs.mkdirSync(stackPath, { recursive: true });
      
      // Create media directories symlinks or mount info
      const mediaPath = path.join(stackPath, 'media');
      fs.mkdirSync(mediaPath, { recursive: true });
      
      // Write a media-mounts.txt for reference
      const mountsInfo = allowedShares.map(s => `${s.name}: ${s.path}`).join('\n');
      fs.writeFileSync(path.join(stackPath, 'media-mounts.txt'), mountsInfo || 'No shares assigned');
      
      // Modify compose to add volume mounts for allowed shares
      let modifiedCompose = compose;
      
      // For stacks like Immich, inject media volumes into the main service
      if (allowedShares.length > 0) {
        // Build additional volumes section
        const additionalVolumes = allowedShares.map(s => 
          `      - "${s.path}:/media/${s.name}:ro"`
        ).join('\n');
        
        // Try to inject after the existing volumes in the main service
        // This is a simple approach - works for most compose files
        const volumeMarker = '      - /etc/localtime:/etc/localtime:ro';
        if (modifiedCompose.includes(volumeMarker)) {
          modifiedCompose = modifiedCompose.replace(
            volumeMarker,
            `${volumeMarker}\n${additionalVolumes}`
          );
        }
      }
      
      // Write docker-compose.yml
      const composePath = path.join(stackPath, 'docker-compose.yml');
      fs.writeFileSync(composePath, modifiedCompose);
      
      // Write .env file if provided
      const envPath = path.join(stackPath, '.env');
      if (env && typeof env === 'object') {
        // Check if .env already exists (reinstall case)
        let existingEnv = {};
        if (fs.existsSync(envPath)) {
          try {
            const existingContent = fs.readFileSync(envPath, 'utf-8');
            existingContent.split('\n').forEach(line => {
              const [key, ...valueParts] = line.split('=');
              if (key && valueParts.length > 0) {
                existingEnv[key.trim()] = valueParts.join('=').trim();
              }
            });
            console.log('[Docker] Found existing .env, preserving DB passwords');
          } catch (e) {
            console.log('[Docker] Could not read existing .env:', e.message);
          }
        }
        
        // Add media paths to env
        const mediaEnv = {};
        allowedShares.forEach((s, i) => {
          mediaEnv[`MEDIA_PATH_${i + 1}`] = s.path;
          mediaEnv[`MEDIA_NAME_${i + 1}`] = s.name;
        });
        
        // Merge: existing values take priority for DB_* and POSTGRES_* keys
        const allEnv = { ...env, ...mediaEnv };
        for (const [key, value] of Object.entries(existingEnv)) {
          // Preserve existing DB passwords to avoid breaking reinstalls
          if (key.startsWith('DB_') || key.startsWith('POSTGRES_')) {
            allEnv[key] = value;
          }
        }
        
        const envContent = Object.entries(allEnv)
          .map(([k, v]) => `${k}=${v}`)
          .join('\n');
        fs.writeFileSync(envPath, envContent);
      }
      
      // ═══════════════════════════════════════════════════════════
      // Create initial config files for specific apps
      // ═══════════════════════════════════════════════════════════
      if (safeId === 'homeassistant') {
        // Home Assistant needs configuration to allow iframes
        const haConfigDir = path.join(stackPath, 'config');
        fs.mkdirSync(haConfigDir, { recursive: true });
        const haConfig = `# Home Assistant Configuration
# Auto-generated by NimbusOS

homeassistant:
  name: Home
  unit_system: metric

http:
  use_x_forwarded_for: true
  trusted_proxies:
    - 127.0.0.1
    - 172.16.0.0/12
    - 192.168.0.0/16
    - 10.0.0.0/8
    - ::1

# Enable frontend
frontend:

# Enable config UI
config:

# Discover some devices automatically
discovery:

# Track the sun
sun:

# Text to speech
tts:
  - platform: google_translate
`;
        fs.writeFileSync(path.join(haConfigDir, 'configuration.yaml'), haConfig);
        console.log('[Docker] Created Home Assistant initial configuration');
      }
      
      // Run docker-compose up
      console.log('[Docker] Deploying stack:', safeId);
      console.log(`[Docker] Stack "${safeId}" has access to ${allowedShares.length} shared folders`);
      
      execSync(`docker compose -f "${composePath}" up -d`, { 
        cwd: stackPath,
        encoding: 'utf-8', 
        timeout: 300000 // 5 min for pulling images
      });
      
      // Register stack in installed-apps registry
      registerApp({
        id: safeId,
        name: body.name || safeId,
        icon: body.icon || '📦',
        port: body.port || null,
        image: 'stack',
        type: 'stack',
        color: body.color || '#607D8B',
        external: body.external || false,
        installedBy: session.username
      });
      
      console.log(`[Docker] Stack "${safeId}" registered in launcher`);
      
      // Download app icon to local cache
      if (body.icon && body.icon.startsWith('http')) {
        try {
          const ext = path.extname(new URL(body.icon).pathname) || '.svg';
          const iconName = safeId + ext;
          const iconDir = path.join(__dirname, '..', '..', 'public', 'app-icons');
          fs.mkdirSync(iconDir, { recursive: true });
          execSync(`curl -fsSL "${body.icon}" -o "${iconDir}/${iconName}"`, { timeout: 15000 });
          console.log('[Docker] Icon downloaded:', iconName);
        } catch (e) { console.log('[Docker] Icon download failed:', e.message); }
      }
      
      return { 
        ok: true, 
        stack: safeId, 
        path: stackPath,
        mountedShares: allowedShares.map(s => s.name)
      };
      
    } catch (err) {
      console.error('[Docker] Stack deployment failed:', err.message);
      return { error: 'Failed to deploy stack', detail: err.stderr || err.message };
    }
  }
  
  // DELETE /api/docker/stack/:id — remove a stack
  const stackMatch = url.match(/^\/api\/docker\/stack\/([a-zA-Z0-9_-]+)$/);
  if (stackMatch && method === 'DELETE') {
    if (!session) return { error: 'Not authenticated' };
    
    const config = getDockerConfig();
    const hasPermission = session.role === 'admin' || config.permissions.includes(session.username);
    if (!hasPermission) return { error: 'No permission', code: 'NO_PERMISSION' };
    
    const safeId = sanitizeDockerName(stackMatch[1]);
    if (!safeId) return { error: 'Invalid stack ID' };
    
    const basePath = config.path || '/var/lib/docker';
    const stackPath = path.join(basePath, 'stacks', safeId);
    const containerPath = path.join(basePath, 'containers', safeId);
    const composePath = path.join(stackPath, 'docker-compose.yml');
    
    // Unregister from installed apps FIRST (instant, so UI updates immediately)
    unregisterApp(safeId);
    
    // Run docker compose down in background (non-blocking)
    const cleanup = () => {
      if (fs.existsSync(composePath)) {
        exec(`docker compose -f "${composePath}" down -v --remove-orphans`, { 
          cwd: stackPath,
          timeout: 120000 
        }, (err) => {
          if (err) console.error(`[Docker] compose down error for "${safeId}":`, err.message);
          else console.log(`[Docker] Stack "${safeId}" containers stopped`);
          
          // Clean up directories after compose down finishes
          try {
            if (fs.existsSync(stackPath)) fs.rmSync(stackPath, { recursive: true, force: true });
          } catch (e) { console.error(`[Docker] Could not remove stack dir "${safeId}":`, e.message); }
          
          try {
            if (fs.existsSync(containerPath)) fs.rmSync(containerPath, { recursive: true, force: true });
          } catch (e) { console.error(`[Docker] Could not remove container dir "${safeId}":`, e.message); }
          
          console.log(`[Docker] Stack "${safeId}" cleanup complete`);
        });
      } else {
        // No compose file, just clean dirs
        try {
          if (fs.existsSync(stackPath)) fs.rmSync(stackPath, { recursive: true, force: true });
        } catch (e) { console.error(`[Docker] Could not remove stack dir "${safeId}":`, e.message); }
        try {
          if (fs.existsSync(containerPath)) fs.rmSync(containerPath, { recursive: true, force: true });
        } catch (e) { console.error(`[Docker] Could not remove container dir "${safeId}":`, e.message); }
        console.log(`[Docker] Stack "${safeId}" cleanup complete (no compose)`);
      }
    };
    
    // Launch cleanup async
    cleanup();
    
    console.log(`[Docker] Stack "${safeId}" unregistered, cleanup running in background`);
    return { ok: true };
  }
  
  // GET /api/docker/containers — list real containers
  if (url === '/api/docker/containers' && method === 'GET') {
    if (!session) return { error: 'Not authenticated' };
    
    const config = getDockerConfig();
    if (!isDockerInstalled()) return { installed: false, containers: [] };
    
    const hasPermission = session.role === 'admin' || config.permissions.includes(session.username);
    if (!hasPermission) return { error: 'No permission to manage Docker', code: 'NO_PERMISSION' };
    
    return { installed: true, containers: getRealContainers() };
  }
  
  // GET /api/docker/installed-apps — list installed apps with their ports (for launcher)
  if (url === '/api/docker/installed-apps' && method === 'GET') {
    if (!session) return { error: 'Not authenticated' };
    
    const config = getDockerConfig();
    if (!isDockerInstalled()) return { apps: [] };
    
    try {
      // Get registered apps from our registry
      const registeredApps = getInstalledApps();
      
      // Get running containers
      const output = execSync(
        `docker ps --format '{{.Names}}|{{.Image}}|{{.Ports}}|{{.Status}}'`,
        { encoding: 'utf-8', timeout: 10000 }
      );
      
      const runningContainers = {};
      output.trim().split('\n').filter(Boolean).forEach(line => {
        const [name, image, ports, status] = line.split('|');
        let port = null;
        if (ports) {
          const portMatch = ports.match(/0\.0\.0\.0:(\d+)/);
          if (portMatch) port = parseInt(portMatch[1]);
        }
        runningContainers[name] = { image, port, status: status.includes('Up') ? 'running' : 'stopped' };
      });
      
      const apps = [];
      const addedIds = new Set();
      
      // First: Add ALL registered apps (these are our source of truth)
      registeredApps.forEach(reg => {
        const isStack = reg.type === 'stack';
        
        // Try to find running container for status
        let containerStatus = 'unknown';
        if (isStack) {
          // For stacks, check various possible container names
          const possibleNames = [
            `${reg.id}_server`,
            `${reg.id}-server`,
            `${reg.id}_app`,
            `${reg.id}-app`,
            reg.id
          ];
          for (const name of possibleNames) {
            if (runningContainers[name]) {
              containerStatus = runningContainers[name].status;
              break;
            }
          }
          // If no container found, check if any container starts with the stack id
          if (containerStatus === 'unknown') {
            for (const [name, container] of Object.entries(runningContainers)) {
              if (name.startsWith(reg.id + '_') || name.startsWith(reg.id + '-')) {
                containerStatus = container.status;
                break;
              }
            }
          }
        } else {
          const container = runningContainers[reg.id];
          if (container) containerStatus = container.status;
        }
        
        apps.push({
          id: reg.id,
          name: reg.name,
          icon: reg.icon || '📦',
          color: reg.color || '#78706A',
          port: reg.port,
          image: reg.image,
          status: containerStatus,
          category: 'installed',
          isStack,
          external: reg.external || false
        });
        addedIds.add(reg.id);
      });
      
      // Second: Add unregistered containers with ports (fallback)
      Object.entries(runningContainers).forEach(([name, container]) => {
        if (addedIds.has(name) || !container.port) return;
        // Skip stack sub-containers (redis, postgres, etc)
        if (name.includes('_redis') || name.includes('_postgres') || name.includes('_ml')) return;
        // Skip containers that belong to a registered stack (e.g. immich_server belongs to immich)
        let belongsToStack = false;
        for (const id of addedIds) {
          if (name.startsWith(id + '_') || name.startsWith(id + '-')) {
            belongsToStack = true;
            break;
          }
        }
        if (belongsToStack) return;
        
        const appMeta = getAppMetaFromImage(container.image, name);
        apps.push({
          id: name,
          name: appMeta.displayName || name,
          icon: appMeta.icon || '📦',
          color: appMeta.color || '#78706A',
          port: container.port,
          image: container.image,
          status: container.status,
          category: 'installed'
        });
      });
      
      return { apps };
      
    } catch (err) {
      return { apps: [], error: err.message };
    }
  }
  
  // GET /api/docker/container/:id/mounts — get mounted volumes of a container
  const mountsMatch = url.match(/^\/api\/docker\/container\/([a-zA-Z0-9_-]+)\/mounts$/);
  if (mountsMatch && method === 'GET') {
    if (!session) return { error: 'Not authenticated' };
    
    const config = getDockerConfig();
    const hasPermission = session.role === 'admin' || config.permissions.includes(session.username);
    if (!hasPermission) return { error: 'No permission', code: 'NO_PERMISSION' };
    
    const containerId = sanitizeDockerName(mountsMatch[1]);
    if (!containerId) return { error: 'Invalid container ID' };
    
    try {
      // Get container mounts using docker inspect
      const output = execSync(
        `docker inspect ${containerId} --format '{{range .Mounts}}{{.Source}}|{{.Destination}}|{{.Mode}}{{println}}{{end}}'`,
        { encoding: 'utf-8', timeout: 10000 }
      );
      
      const mounts = output.trim().split('\n').filter(Boolean).map(line => {
        const [source, destination, mode] = line.split('|');
        return { source, destination, mode: mode || 'rw' };
      });
      
      // Get allowed shares for this container
      const shares = getShares();
      const allowedShares = shares.filter(s => (s.appPermissions || []).includes(containerId));
      
      return { 
        containerId, 
        mounts,
        allowedShares: allowedShares.map(s => ({ name: s.name, path: s.path }))
      };
    } catch (err) {
      return { error: 'Failed to get mounts', detail: err.message };
    }
  }
  
  // POST /api/docker/container/:id/rebuild — recreate container with updated mounts
  const rebuildMatch = url.match(/^\/api\/docker\/container\/([a-zA-Z0-9_-]+)\/rebuild$/);
  if (rebuildMatch && method === 'POST') {
    if (!session) return { error: 'Not authenticated' };
    
    const config = getDockerConfig();
    const hasPermission = session.role === 'admin' || config.permissions.includes(session.username);
    if (!hasPermission) return { error: 'No permission', code: 'NO_PERMISSION' };
    
    const containerId = sanitizeDockerName(rebuildMatch[1]);
    if (!containerId) return { error: 'Invalid container ID' };
    
    try {
      // Get current container info
      const inspectOutput = execSync(
        `docker inspect ${containerId} --format '{{.Config.Image}}|{{range $p, $conf := .NetworkSettings.Ports}}{{$p}}={{(index $conf 0).HostPort}},{{end}}'`,
        { encoding: 'utf-8', timeout: 10000 }
      );
      
      const [image, portsStr] = inspectOutput.trim().split('|');
      
      // Parse ports
      const ports = {};
      if (portsStr) {
        portsStr.split(',').filter(Boolean).forEach(p => {
          const [containerPort, hostPort] = p.split('=');
          if (containerPort && hostPort) {
            const cp = containerPort.replace('/tcp', '').replace('/udp', '');
            ports[hostPort] = cp;
          }
        });
      }
      
      // Stop and remove old container
      try { execSync(`docker stop ${containerId}`, { timeout: 30000 }); } catch {}
      try { execSync(`docker rm ${containerId}`, { timeout: 10000 }); } catch {}
      
      // Get allowed shares
      const shares = getShares();
      const allowedShares = shares.filter(s => (s.appPermissions || []).includes(containerId));
      
      // Build new docker run command
      let cmd = `docker run -d --name ${containerId} --restart unless-stopped`;
      
      // Add ports
      for (const [host, container] of Object.entries(ports)) {
        cmd += ` -p ${host}:${container}`;
      }
      
      // Add config volume
      const containerDataPath = path.join(config.path || '/var/lib/docker', 'containers', containerId);
      cmd += ` -v ${containerDataPath}:/config`;
      
      // Add allowed shares
      for (const share of allowedShares) {
        cmd += ` -v "${share.path}":"/media/${share.name}":ro`;
      }
      
      // Add image
      cmd += ` ${image}`;
      
      console.log('[Docker] Rebuilding container:', cmd);
      
      const output = execSync(cmd, { encoding: 'utf-8', timeout: 120000 });
      
      return { 
        ok: true, 
        containerId,
        mountedShares: allowedShares.map(s => s.name)
      };
      
    } catch (err) {
      return { error: 'Failed to rebuild container', detail: err.message };
    }
  }
  
  // POST /api/docker/container/:id/:action — start/stop/restart container
  const actionMatch = url.match(/^\/api\/docker\/container\/([a-zA-Z0-9_-]+)\/(start|stop|restart)$/);
  if (actionMatch && method === 'POST') {
    if (!session) return { error: 'Not authenticated' };
    
    const config = getDockerConfig();
    const hasPermission = session.role === 'admin' || config.permissions.includes(session.username);
    if (!hasPermission) return { error: 'No permission to manage Docker', code: 'NO_PERMISSION' };
    
    const [, rawContainerId, action] = actionMatch;
    
    // SECURITY: Sanitize container ID
    const containerId = sanitizeDockerName(rawContainerId);
    if (!containerId) {
      return { error: 'Invalid container ID' };
    }
    
    try {
      execSync(`docker ${action} ${containerId}`, { encoding: 'utf-8', timeout: 60000 });
      return { ok: true, action, containerId };
    } catch (err) {
      return { error: `Failed to ${action} container`, detail: err.message };
    }
  }
  
  // DELETE /api/docker/container/:id — remove container
  const containerMatch = url.match(/^\/api\/docker\/container\/([a-zA-Z0-9_-]+)$/);
  if (containerMatch && method === 'DELETE') {
    if (!session) return { error: 'Not authenticated' };
    
    const config = getDockerConfig();
    const hasPermission = session.role === 'admin' || config.permissions.includes(session.username);
    if (!hasPermission) return { error: 'No permission to manage Docker', code: 'NO_PERMISSION' };
    
    const rawContainerId = containerMatch[1];
    
    // SECURITY: Sanitize container ID
    const containerId = sanitizeDockerName(rawContainerId);
    if (!containerId) {
      return { error: 'Invalid container ID' };
    }
    
    // Unregister immediately so UI updates fast
    unregisterApp(containerId);
    
    // Run stop + remove in background
    exec(`docker stop ${containerId} && docker rm ${containerId} || docker rm -f ${containerId}`, { 
      timeout: 60000 
    }, (err) => {
      if (err) console.error(`[Docker] Failed to remove container "${containerId}":`, err.message);
      else console.log(`[Docker] Container "${containerId}" removed`);
    });
    
    return { ok: true, containerId };
  }
  
  // GET /api/docker/pull/:image — pull an image
  const pullMatch = url.match(/^\/api\/docker\/pull\/(.+)$/);
  if (pullMatch && method === 'GET') {
    if (!session) return { error: 'Not authenticated' };
    
    const config = getDockerConfig();
    const hasPermission = session.role === 'admin' || config.permissions.includes(session.username);
    if (!hasPermission) return { error: 'No permission', code: 'NO_PERMISSION' };
    
    const rawImage = decodeURIComponent(pullMatch[1]);
    
    // SECURITY: Sanitize image name
    const image = sanitizeDockerName(rawImage);
    if (!image) {
      return { error: 'Invalid image name' };
    }
    
    try {
      console.log('[Docker] Pulling image:', image);
      execSync(`docker pull ${image}`, { stdio: 'inherit', timeout: 300000 });
      return { ok: true, image };
    } catch (err) {
      return { error: 'Failed to pull image', detail: err.message };
    }
  }
  
  return null;
}


module.exports = { handleDocker, getDockerConfig, saveDockerConfig, isDockerInstalled };

// Re-export getContainers and containerAction from the functions defined above
// (they're defined inline in the section)
