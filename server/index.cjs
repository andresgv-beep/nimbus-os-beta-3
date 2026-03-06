/**
 * NimbusOS Backend API Server
 * Modular architecture — this file is the router only.
 * Each domain lives in server/lib/*.cjs
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, spawn } = require('child_process');
const { URL } = require('url');

// ── Safety net: don't crash on unhandled errors ──
process.on('uncaughtException', (err) => {
  console.error('[NimbusOS] Uncaught exception:', err.message);
  console.error(err.stack);
});
process.on('unhandledRejection', (err) => {
  console.error('[NimbusOS] Unhandled rejection:', err);
});

// ── Load modules ──
const shared = require('./lib/shared.cjs');
const auth = require('./lib/auth.cjs');
const apps = require('./lib/apps.cjs');
const shares = require('./lib/shares.cjs');
const docker = require('./lib/docker.cjs');
const network = require('./lib/network.cjs');
const vms = require('./lib/vms.cjs');
const downloads = require('./lib/downloads.cjs');
const files = require('./lib/files.cjs');
const hw = require('./lib/hardware.cjs');
const storage = require('./lib/storage.cjs');

const {
  PORT, NIMBUS_ROOT, CONFIG_DIR, CORS_HEADERS,
  SESSIONS, hashToken, getSessionUser, sanitizeDockerName, run, readFile,
} = shared;

// ═══════════════════════════════════
// System routes (hardware monitoring)
// ═══════════════════════════════════
const routes = {
  '/api/system':          () => hw.getSystemSummary(),
  '/api/cpu':             () => hw.getCpuUsage(),
  '/api/memory':          () => hw.getMemory(),
  '/api/gpu':             () => hw.getGpu(),
  '/api/temps':           () => hw.getTemps(),
  '/api/network':         () => hw.getNetwork(),
  '/api/disks':           () => hw.getDisks(),
  '/api/uptime':          () => ({ uptime: hw.getUptime() }),
  '/api/containers':      () => hw.getContainers(),
  '/api/hostname':        () => ({ hostname: os.hostname() }),
  '/api/hardware/gpu-info': () => hw.getHardwareGpuInfo(),
  '/api/system/info':     () => {
    const interfaces = hw.getNetwork();
    const hostname = os.hostname();
    const gateway = run("ip route | grep default | awk '{print $3}' | head -1") || '—';
    const dns = run("cat /etc/resolv.conf 2>/dev/null | grep nameserver | awk '{print $2}'") || '';
    const dnsServers = dns.split('\n').filter(Boolean);
    const primaryIface = interfaces.find(n => n.ip !== '—') || {};
    const subnet = run(`ip -4 -o addr show ${primaryIface.name || 'eth0'} 2>/dev/null | awk '{print $4}'`) || '—';
    return { network: { hostname, gateway, subnet, dns: dnsServers, interfaces } };
  },
  '/api/storage':           () => storage.getStoragePools(),
  '/api/storage/disks':     () => storage.detectStorageDisks(),
  '/api/storage/pools':     () => storage.getStoragePools(),
  '/api/storage/status':    () => ({ pools: storage.getStoragePools(), alerts: storage.storageAlerts, hasPool: storage.hasPool() }),
  '/api/storage/alerts':    () => ({ alerts: storage.storageAlerts }),
  '/api/storage/health':    () => storage.checkStorageHealth(),
  '/api/storage/detect-existing': () => ({ pools: storage.detectExistingPools() }),
  '/api/storage/restorable':      () => ({ pools: storage.scanForRestorablePools() }),
  '/api/firewall':          () => network.getFirewallScan(),
  '/api/firewall/rules':    () => network.getFirewallRules(),
  '/api/firewall/ports':    () => network.getListeningPorts(),
  '/api/firewall/scan':     () => network.getFirewallScan(),
};

// ═══════════════════════════════════
// Helpers: body parsing + response
// ═══════════════════════════════════
function withBody(req, res, handler) {
  let body = '';
  req.on('data', chunk => { body += chunk; if (body.length > 10485760) req.destroy(); });
  req.on('end', async () => {
    try {
      const parsed = body ? JSON.parse(body) : {};
      const result = await handler(parsed);
      sendResult(res, result);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, CORS_HEADERS);
        res.end(JSON.stringify({ error: err.message }));
      }
    }
  });
}

function sendResult(res, result) {
  if (res.headersSent) return;
  if (result === null) { res.writeHead(404, CORS_HEADERS); return res.end(JSON.stringify({ error: 'Not found' })); }
  if (result.__binary) { res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': result.mime }); return res.end(fs.readFileSync(result.path)); }
  const code = result.error ? (result.error === 'Unauthorized' ? 401 : result.code === 'NO_PERMISSION' ? 403 : 400) : 200;
  res.writeHead(code, CORS_HEADERS);
  res.end(JSON.stringify(result));
}

// Route helper: GET → direct call, POST/PUT/DELETE → parse body first
function routeHandler(req, res, method, url, handler) {
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
    return withBody(req, res, (parsed) => handler(url, method, parsed, req));
  }
  return sendResult(res, handler(url, method, {}, req));
}

// ═══════════════════════════════════
// HTTP Server
// ═══════════════════════════════════
const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS_HEADERS); return res.end(); }

  const url = req.url.split('?')[0];
  const method = req.method;

  // ── Static: app icons ──
  if (url.startsWith('/app-icons/') && method === 'GET') {
    const iconName = path.basename(url);
    if (!/^[a-zA-Z0-9_-]+\.(svg|png|jpg|jpeg|webp|ico)$/.test(iconName)) { res.writeHead(400); return res.end('Invalid icon name'); }
    const iconPath = path.join(__dirname, '..', 'public', 'app-icons', iconName);
    if (fs.existsSync(iconPath)) {
      const ext = path.extname(iconName).toLowerCase();
      const mt = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon' };
      res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': mt[ext] || 'image/png' });
      return res.end(fs.readFileSync(iconPath));
    }
    res.writeHead(404); return res.end('Icon not found');
  }

  // ── Static: user wallpapers ──
  const wpMatch = url.match(/^\/api\/user\/wallpaper\/([a-zA-Z0-9_.-]+)\/(wallpaper\.(png|jpg|jpeg|webp|gif))$/);
  if (wpMatch && method === 'GET') {
    const wpPath = path.join(NIMBUS_ROOT, 'userdata', wpMatch[1], wpMatch[2]);
    if (fs.existsSync(wpPath)) {
      const mt = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
      res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': mt[path.extname(wpMatch[2]).toLowerCase()] || 'image/png', 'Cache-Control': 'no-cache' });
      return res.end(fs.readFileSync(wpPath));
    }
    res.writeHead(404); return res.end('Wallpaper not found');
  }

  // ── API Routes (each domain delegates to its module) ──
  if (url.startsWith('/api/auth/') || url.startsWith('/api/users') || url.startsWith('/api/user/'))
    return routeHandler(req, res, method, url, auth.handleAuth);

  if (url.startsWith('/api/shares'))
    return routeHandler(req, res, method, url, shares.handleShares);

  if (url.startsWith('/api/docker') || url.startsWith('/api/permissions') || url.startsWith('/api/installed-apps'))
    return routeHandler(req, res, method, url, docker.handleDocker);

  if (url.startsWith('/api/remote-access'))
    return routeHandler(req, res, method, url, network.handleRemoteAccess);

  if (url.startsWith('/api/ddns'))
    return routeHandler(req, res, method, url, network.handleDdns);

  if (url.startsWith('/api/portal'))
    return routeHandler(req, res, method, url, network.handlePortal);

  if (url.startsWith('/api/proxy'))
    return routeHandler(req, res, method, url, network.handleProxy);

  if (url.startsWith('/api/ssh'))
    return routeHandler(req, res, method, url, network.handleSsh);

  if (url.startsWith('/api/ftp'))
    return routeHandler(req, res, method, url, network.handleFtp);

  if (url.startsWith('/api/nfs'))
    return routeHandler(req, res, method, url, network.handleNfs);

  if (url.startsWith('/api/dns'))
    return routeHandler(req, res, method, url, network.handleDns);

  if (url.startsWith('/api/certs'))
    return routeHandler(req, res, method, url, network.handleCerts);

  if (url.startsWith('/api/webdav'))
    return routeHandler(req, res, method, url, network.handleWebdav);

  if (url.startsWith('/api/smb'))
    return routeHandler(req, res, method, url, network.handleSmb);

  if (url.startsWith('/api/vms'))
    return routeHandler(req, res, method, url, vms.handleVMs);

  // ── Downloads (async handlers) ──
  if (url.startsWith('/api/downloads')) {
    if (['POST', 'PUT'].includes(method)) {
      return withBody(req, res, async (parsed) => await downloads.handleDownloads(url, method, parsed, req));
    }
    try {
      const result = downloads.handleDownloads(url, method, {}, req);
      if (result && typeof result.then === 'function') {
        result.then(r => sendResult(res, r)).catch(err => { res.writeHead(500, CORS_HEADERS); res.end(JSON.stringify({ error: err.message })); });
      } else { sendResult(res, result); }
    } catch (err) { res.writeHead(500, CORS_HEADERS); res.end(JSON.stringify({ error: err.message })); }
    return;
  }

  if (url.startsWith('/api/native-apps'))
    return routeHandler(req, res, method, url, apps.handleNativeApps);

  // ── UPnP (async) ──
  if (url.startsWith('/api/upnp')) {
    const sendJson = (data) => { res.writeHead(data.error ? 400 : 200, CORS_HEADERS); res.end(JSON.stringify(data)); };
    if (url === '/api/upnp/status' && method === 'GET') {
      (async () => {
        try {
          const gw = await network.getUpnpGateway();
          const [mappings, externalIp] = await Promise.all([
            network.upnpListMappings(gw.controlUrl, gw.serviceType),
            network.upnpGetExternalIP(gw.controlUrl, gw.serviceType).catch(() => null),
          ]);
          sendJson({ ok: true, available: true, externalIp, localIp: network.getLocalIP(), mappings, gateway: gw.descUrl || gw.controlUrl });
        } catch (e) { sendJson({ ok: true, available: false, error: e.message, localIp: network.getLocalIP(), mappings: [] }); }
      })();
      return;
    }
    if (method === 'POST') {
      return withBody(req, res, async (parsed) => {
        const session = getSessionUser(req);
        if (!session || session.role !== 'admin') return { error: 'Unauthorized' };
        const gw = await network.getUpnpGateway();
        if (url === '/api/upnp/add') {
          const { externalPort, internalPort, protocol, description } = parsed;
          if (!externalPort || !protocol) return { error: 'externalPort and protocol required' };
          const localIp = network.getLocalIP();
          await network.upnpAddMapping(gw.controlUrl, gw.serviceType, parseInt(externalPort), parseInt(internalPort || externalPort), protocol, localIp, description || `NimbusOS:${externalPort}`, 0);
          return { ok: true, message: `Port ${externalPort}/${protocol} → ${localIp}:${internalPort || externalPort}` };
        }
        if (url === '/api/upnp/remove') {
          const { externalPort, protocol } = parsed;
          if (!externalPort || !protocol) return { error: 'externalPort and protocol required' };
          await network.upnpRemoveMapping(gw.controlUrl, gw.serviceType, parseInt(externalPort), protocol);
          return { ok: true, message: `Mapping ${externalPort}/${protocol} removed` };
        }
        return null;
      });
    }
    res.writeHead(404, CORS_HEADERS); return res.end(JSON.stringify({ error: 'Not found' }));
  }

  // ── File upload/download (special handling — binary streams) ──
  if (url === '/api/files/upload' && method === 'POST') {
    const session = getSessionUser(req);
    if (!session) { res.writeHead(401, CORS_HEADERS); return res.end(JSON.stringify({ error: 'Not authenticated' })); }
    return files.handleFileUpload(req, res, session);
  }
  if (url.startsWith('/api/files/download') && method === 'GET') {
    const urlObj = new URL('http://localhost' + req.url);
    const tkn = urlObj.searchParams.get('token');
    const session = SESSIONS[hashToken(tkn)];
    if (!session) { res.writeHead(401, CORS_HEADERS); return res.end(JSON.stringify({ error: 'Not authenticated' })); }
    return files.handleFileDownload(req, res, session);
  }
  if (url.startsWith('/api/files'))
    return routeHandler(req, res, method, url, files.handleFiles);

  // ── Container actions ──
  const containerMatch = url.match(/^\/api\/containers\/([a-zA-Z0-9_.-]+)\/(start|stop|restart|pause|unpause)$/);
  if (containerMatch && method === 'POST') {
    const session = getSessionUser(req);
    if (!session) { res.writeHead(401, CORS_HEADERS); return res.end(JSON.stringify({ error: 'Not authenticated' })); }
    const dc = docker.getDockerConfig();
    if (session.role !== 'admin' && !dc.permissions.includes(session.username)) { res.writeHead(403, CORS_HEADERS); return res.end(JSON.stringify({ error: 'No permission' })); }
    const name = sanitizeDockerName(containerMatch[1]);
    if (!name) { res.writeHead(400, CORS_HEADERS); return res.end(JSON.stringify({ error: 'Invalid container name' })); }
    try { res.writeHead(200, CORS_HEADERS); res.end(JSON.stringify(hw.containerAction(name, containerMatch[2]))); }
    catch (err) { if (!res.headersSent) { res.writeHead(500, CORS_HEADERS); res.end(JSON.stringify({ error: err.message })); } }
    return;
  }

  // ── Terminal (admin only) ──
  if (url === '/api/terminal' && method === 'POST') {
    const session = getSessionUser(req);
    if (!session) { res.writeHead(401, CORS_HEADERS); return res.end(JSON.stringify({ error: 'Not authenticated' })); }
    if (session.role !== 'admin') { res.writeHead(403, CORS_HEADERS); return res.end(JSON.stringify({ error: 'Admin required' })); }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { cmd, cwd } = JSON.parse(body);
        if (!cmd || typeof cmd !== 'string' || cmd.length > 10000) { res.writeHead(400, CORS_HEADERS); return res.end(JSON.stringify({ error: 'Invalid cmd' })); }
        const workDir = cwd || os.homedir();
        const child = spawn('bash', ['-c', cmd], { cwd: workDir, env: { ...process.env, TERM: 'xterm-256color', COLUMNS: '120', LINES: '40' }, timeout: 30000 });
        let stdout = '', stderr = '';
        child.stdout.on('data', d => stdout += d.toString());
        child.stderr.on('data', d => stderr += d.toString());
        child.on('close', (code) => { res.writeHead(200, CORS_HEADERS); res.end(JSON.stringify({ stdout, stderr, code, cwd: workDir })); });
        child.on('error', (err) => { res.writeHead(200, CORS_HEADERS); res.end(JSON.stringify({ stdout: '', stderr: err.message, code: 1, cwd: workDir })); });
      } catch (err) { res.writeHead(500, CORS_HEADERS); res.end(JSON.stringify({ error: err.message })); }
    });
    return;
  }

  // ── Storage Manager POST routes ──
  if (url.startsWith('/api/storage/') && ['POST', 'DELETE'].includes(method)) {
    const session = getSessionUser(req);
    if (!session || session.role !== 'admin') { res.writeHead(401, CORS_HEADERS); return res.end(JSON.stringify({ error: 'Admin required' })); }
    return withBody(req, res, (parsed) => {
      if (url === '/api/storage/pool') return storage.createPool(parsed.name, parsed.disks, parsed.level, parsed.filesystem);
      if (url === '/api/storage/scan') return { ok: true, disks: storage.detectStorageDisks() };
      if (url === '/api/storage/backup') { storage.backupConfigToPool(); return { ok: true }; }
      if (url === '/api/storage/wipe') return parsed.disk ? storage.wipeDisk(parsed.disk) : { error: 'Provide disk path' };
      if (url === '/api/storage/pool/destroy') return parsed.name ? storage.destroyPool(parsed.name) : { error: 'Provide pool name' };
      if (url === '/api/storage/pool/restore') return (parsed.device && parsed.name) ? storage.restorePool(parsed.device, parsed.name) : { error: 'Provide device and name' };
      if (url === '/api/storage/reimport') {
        if (!parsed.pools || !Array.isArray(parsed.pools)) return { error: 'Provide pools array' };
        const config = storage.getStorageConfig();
        const imported = [];
        for (const pool of parsed.pools) {
          const mp = `${storage.NIMBUS_POOLS_DIR}/${pool.poolName}`;
          try {
            execSync(`mkdir -p ${mp}`); execSync(`mount /dev/${pool.arrayName} ${mp}`, { timeout: 10000 });
            const uuid = run(`blkid -s UUID -o value /dev/${pool.arrayName}`) || '';
            execSync(`echo "UUID=${uuid.trim()} ${mp} ext4 defaults,noatime 0 2" >> /etc/fstab`);
            if (!config.pools) config.pools = [];
            config.pools.push({ name: pool.poolName, arrayName: pool.arrayName, mountPoint: mp, raidLevel: pool.raidLevel, filesystem: 'ext4', disks: pool.members.map(m => m.device), createdAt: new Date().toISOString(), imported: true });
            if (!config.primaryPool) config.primaryPool = pool.poolName;
            imported.push(pool.poolName);
          } catch (err) { console.error(`[Storage] Import failed ${pool.poolName}:`, err.message); }
        }
        storage.saveStorageConfig(config);
        return imported.length > 0 ? { ok: true, imported } : { error: 'No pools imported' };
      }
      return null;
    });
  }

  // ── System power ──
  if ((url === '/api/system/reboot-service' || url === '/api/system/reboot' || url === '/api/system/shutdown') && method === 'POST') {
    const session = getSessionUser(req);
    if (!session || session.role !== 'admin') { res.writeHead(401, CORS_HEADERS); return res.end(JSON.stringify({ error: 'Unauthorized' })); }
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      const cmds = { '/api/system/reboot-service': 'sudo systemctl restart nimbusos', '/api/system/reboot': 'sudo reboot', '/api/system/shutdown': 'sudo shutdown -h now' };
      const msgs = { '/api/system/reboot-service': 'NimbusOS restarting...', '/api/system/reboot': 'System rebooting...', '/api/system/shutdown': 'System shutting down...' };
      res.writeHead(200, CORS_HEADERS); res.end(JSON.stringify({ ok: true, message: msgs[url] }));
      setTimeout(() => { try { execSync(cmds[url]); } catch {} }, 1000);
    });
    return;
  }

  // ── System Update ──
  if (url.startsWith('/api/system/update')) {
    const session = getSessionUser(req);
    if (!session || session.role !== 'admin') { res.writeHead(401, CORS_HEADERS); return res.end(JSON.stringify({ error: 'Unauthorized' })); }
    if (url === '/api/system/update/check' && method === 'GET') {
      try {
        const currentVersion = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version || '0.0.0';
        const latestVersion = JSON.parse(execSync('curl -fsSL "https://raw.githubusercontent.com/andresgv-beep/nimbus-os-beta-2/main/package.json" 2>/dev/null', { timeout: 10000, encoding: 'utf8' })).version || '0.0.0';
        res.writeHead(200, CORS_HEADERS);
        return res.end(JSON.stringify({ currentVersion, latestVersion, updateAvailable: latestVersion !== currentVersion, installDir: '/opt/nimbusos' }));
      } catch (err) { res.writeHead(200, CORS_HEADERS); return res.end(JSON.stringify({ error: 'Failed: ' + err.message })); }
    }
    if (url === '/api/system/update/apply' && method === 'POST') {
      try {
        const script = path.join(__dirname, '..', 'scripts', 'update.sh');
        if (!fs.existsSync(script)) { res.writeHead(400, CORS_HEADERS); return res.end(JSON.stringify({ error: 'Update script not found' })); }
        if (!fs.existsSync('/var/log/nimbusos')) fs.mkdirSync('/var/log/nimbusos', { recursive: true });
        try { fs.unlinkSync('/var/log/nimbusos/update-result.json'); } catch {}
        const log = fs.openSync('/var/log/nimbusos/update.log', 'a');
        spawn('setsid', ['bash', script], { detached: true, stdio: ['ignore', log, log] }).unref();
        res.writeHead(200, CORS_HEADERS); return res.end(JSON.stringify({ ok: true, message: 'Update started.' }));
      } catch (err) { res.writeHead(500, CORS_HEADERS); return res.end(JSON.stringify({ error: err.message })); }
    }
    if (url === '/api/system/update/status' && method === 'GET') {
      const rf = '/var/log/nimbusos/update-result.json';
      if (fs.existsSync(rf)) { try { res.writeHead(200, CORS_HEADERS); return res.end(JSON.stringify({ done: true, ...JSON.parse(fs.readFileSync(rf, 'utf-8')) })); } catch {} }
      res.writeHead(200, CORS_HEADERS); return res.end(JSON.stringify({ done: false }));
    }
    res.writeHead(404, CORS_HEADERS); return res.end(JSON.stringify({ error: 'Not found' }));
  }

  // ── System monitoring (routes table) ──
  const handler = routes[url];
  if (handler) {
    const session = getSessionUser(req);
    if (!session) { res.writeHead(401, CORS_HEADERS); return res.end(JSON.stringify({ error: 'Not authenticated' })); }
    if (url === '/api/containers') {
      const dc = docker.getDockerConfig();
      if (session.role !== 'admin' && !dc.permissions.includes(session.username)) { res.writeHead(403, CORS_HEADERS); return res.end(JSON.stringify({ error: 'No permission' })); }
    }
    try {
      const data = handler();
      res.writeHead(200, CORS_HEADERS);
      res.end(JSON.stringify(data));
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, CORS_HEADERS);
        res.end(JSON.stringify({ error: err.message }));
      }
    }
    return;
  }

  // ── Static file serving (production) ──
  const DIST_DIR = path.join(__dirname, '..', 'dist');
  const PUBLIC_DIR = path.join(__dirname, '..', 'public');
  if (fs.existsSync(DIST_DIR)) {
    let filePath = path.join(DIST_DIR, url === '/' ? 'index.html' : url);
    if (!filePath.startsWith(DIST_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      if (url.startsWith('/api/')) { res.writeHead(404, CORS_HEADERS); return res.end(JSON.stringify({ error: 'Endpoint not found' })); }
      filePath = path.join(DIST_DIR, 'index.html');
    }
    if (fs.existsSync(filePath)) {
      const ext = path.extname(filePath).toLowerCase();
      const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm' };
      res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable' });
      return res.end(fs.readFileSync(filePath));
    }
  }
  const pubFile = path.join(PUBLIC_DIR, url);
  if (fs.existsSync(pubFile) && pubFile.startsWith(PUBLIC_DIR) && !fs.statSync(pubFile).isDirectory()) {
    const ext = path.extname(pubFile).toLowerCase();
    res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': ext === '.svg' ? 'image/svg+xml' : ext === '.png' ? 'image/png' : 'application/octet-stream' });
    return res.end(fs.readFileSync(pubFile));
  }
  res.writeHead(404, CORS_HEADERS);
  res.end(JSON.stringify({ error: 'Not found' }));
});

// ═══════════════════════════════════
// Startup
// ═══════════════════════════════════
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  ╔══════════════════════════════════╗`);
  console.log(`  ║   NimbusOS API Server v0.1.0     ║`);
  console.log(`  ║   http://0.0.0.0:${PORT}             ║`);
  console.log(`  ╚══════════════════════════════════╝\n`);
  console.log(`  Endpoints:`);
  Object.keys(routes).forEach(r => console.log(`    GET ${r}`));
  console.log();

  // Nginx auto-start + port sync
  try {
    if (run('systemctl is-active nginx 2>/dev/null')?.trim() !== 'active') run('sudo systemctl start nginx 2>/dev/null');
    const nginxConf = '/etc/nginx/sites-available/nimbusos-https.conf';
    if (fs.existsSync(nginxConf)) {
      let conf = fs.readFileSync(nginxConf, 'utf-8');
      const m = conf.match(/proxy_pass http:\/\/127\.0\.0\.1:(\d+)/);
      if (m && parseInt(m[1]) !== PORT) {
        conf = conf.replace(/proxy_pass http:\/\/127\.0\.0\.1:\d+;/g, `proxy_pass http://127.0.0.1:${PORT};`);
        fs.writeFileSync(nginxConf, conf);
        run('sudo nginx -t 2>/dev/null && sudo systemctl reload nginx 2>/dev/null');
      }
    }
  } catch {}

  // Storage pools mount + auto-import
  try {
    const storageConf = storage.getStorageConfig();
    if (storageConf.pools?.length > 0) {
      for (const pool of storageConf.pools) { try { execSync(`mkdir -p ${pool.mountPoint}`, { timeout: 5000 }); } catch {} }
      execSync('mount -a 2>/dev/null || true', { timeout: 15000 });
      for (const pool of storageConf.pools) {
        const ok = run(`mountpoint -q ${pool.mountPoint} 2>/dev/null && echo yes || echo no`)?.trim() === 'yes';
        console.log(`    Storage: Pool "${pool.name}" ${ok ? 'mounted' : 'FAILED'} at ${pool.mountPoint}`);
      }
      storage.checkStorageHealth();
      storage.backupConfigToPool();
    } else {
      console.log(`    Storage: Scanning for existing arrays...`);
      const existing = storage.detectExistingPools();
      if (existing.length > 0) console.log(`    Storage: Found ${existing.length} pool(s) — use reimport API to activate`);
      else console.log(`    Storage: No pools found`);
    }
  } catch (err) { console.log(`    Storage: ${err.message}`); }

  // Docker auto-config
  try {
    const dc = docker.getDockerConfig();
    if (!dc.installed && docker.isDockerInstalled()) {
      const dp = path.join(NIMBUS_ROOT, 'volumes', 'docker');
      fs.mkdirSync(path.join(dp, 'containers'), { recursive: true });
      fs.mkdirSync(path.join(dp, 'volumes'), { recursive: true });
      fs.mkdirSync(path.join(dp, 'stacks'), { recursive: true });
      dc.installed = true; dc.dockerAvailable = true; dc.path = dp; dc.permissions = []; dc.installedAt = new Date().toISOString();
      docker.saveDockerConfig(dc);
      console.log(`    Docker: Auto-configured at ${dp}`);
    } else if (dc.installed) { console.log(`    Docker: Configured at ${dc.path}`); }
  } catch (err) { console.log(`    Docker: ${err.message}`); }

  // Hardware summary
  const s = hw.getSystemSummary();
  console.log(`    CPU: ${s.cpu.model} (${s.cpu.cores} cores)`);
  console.log(`    RAM: ${s.memory.totalGB} GB`);
  s.gpus.forEach(g => console.log(`    GPU: ${g.name} (${g.memTotal} MB VRAM)`));
  if (!s.gpus.length) console.log(`    GPU: None detected`);
  console.log(`    Network: ${s.network.map(n => n.name).join(', ')}`);
  console.log(`    Disks: ${s.disks.disks.length} detected`);
  console.log(`    Hostname: ${s.hostname}`);
  console.log(`    Uptime: ${s.uptime}\n`);
});
