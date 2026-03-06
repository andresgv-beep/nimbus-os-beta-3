/**
 * NimbusOS — Download Station API (Transmission RPC + aMule)
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { NIMBUS_ROOT, CONFIG_DIR, getSessionUser, run } = require('./shared.cjs');

// ═══════════════════════════════════
// Download Station API (Transmission RPC proxy + aMule)
// ═══════════════════════════════════
let transmissionSessionId = '';

async function transmissionRPC(method, args = {}) {
  const settingsPath = '/etc/transmission-daemon/settings.json';
  let rpcPort = 9091;
  let rpcPass = '';
  
  try {
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      rpcPort = settings['rpc-port'] || 9091;
      if (settings['rpc-authentication-required']) {
        rpcUser = settings['rpc-username'] || '';
        rpcPass = settings['rpc-password'] || '';
      }
    }
  } catch {}
  
  const payload = JSON.stringify({ method, arguments: args });
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'X-Transmission-Session-Id': transmissionSessionId,
  };
  if (rpcUser) {
    headers['Authorization'] = 'Basic ' + Buffer.from(`${rpcUser}:${rpcPass}`).toString('base64');
  }
  
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: rpcPort, path: '/transmission/rpc',
      method: 'POST', headers, timeout: 10000,
    }, (res) => {
      // Handle 409 Conflict — need new session ID
      if (res.statusCode === 409) {
        transmissionSessionId = res.headers['x-transmission-session-id'] || '';
        // Retry with new session ID
        headers['X-Transmission-Session-Id'] = transmissionSessionId;
        const retry = http.request({
          hostname: '127.0.0.1', port: rpcPort, path: '/transmission/rpc',
          method: 'POST', headers, timeout: 10000,
        }, (res2) => {
          let data = '';
          res2.on('data', chunk => data += chunk);
          res2.on('end', () => {
            try { resolve(JSON.parse(data)); } catch { resolve({ result: 'error', error: data }); }
          });
        });
        retry.on('error', reject);
        retry.write(payload);
        retry.end();
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve({ result: 'error', error: data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Transmission RPC timeout')); });
    req.write(payload);
    req.end();
  });
}

function handleDownloads(url, method, body, req) {
  const session = getSessionUser(req);
  if (!session) return { error: 'Not authenticated' };
  
  // GET /api/downloads/status — overall status
  if (url === '/api/downloads/status' && method === 'GET') {
    const transmissionInstalled = !!(run('which transmission-daemon 2>/dev/null'));
    const transmissionRunning = run('systemctl is-active transmission-daemon 2>/dev/null') === 'active';
    const amuleInstalled = !!(run('which amuled 2>/dev/null'));
    const amuleRunning = run('systemctl is-active amuled 2>/dev/null') === 'active';
    return {
      transmission: { installed: transmissionInstalled, running: transmissionRunning },
      amule: { installed: amuleInstalled, running: amuleRunning },
    };
  }
  
  // GET /api/downloads/list — list all torrents
  if (url === '/api/downloads/list' && method === 'GET') {
    return new Promise(async (resolve) => {
      try {
        const result = await transmissionRPC('torrent-get', {
          fields: ['id', 'name', 'status', 'totalSize', 'percentDone', 'rateDownload', 'rateUpload',
                   'eta', 'downloadedEver', 'uploadedEver', 'addedDate', 'doneDate', 'downloadDir',
                   'error', 'errorString', 'peersConnected', 'peersSendingToUs', 'peersGettingFromUs',
                   'isFinished', 'hashString', 'files', 'trackerStats']
        });
        if (result.result === 'success') {
          resolve({ torrents: result.arguments.torrents });
        } else {
          resolve({ error: result.result || 'RPC error', torrents: [] });
        }
      } catch (err) {
        resolve({ error: err.message, torrents: [] });
      }
    });
  }
  
  // GET /api/downloads/stats — session stats (speeds, totals)
  if (url === '/api/downloads/stats' && method === 'GET') {
    return new Promise(async (resolve) => {
      try {
        const result = await transmissionRPC('session-stats');
        if (result.result === 'success') {
          resolve(result.arguments);
        } else {
          resolve({ error: result.result });
        }
      } catch (err) {
        resolve({ error: err.message });
      }
    });
  }
  
  // POST /api/downloads/add — add torrent (magnet or file)
  if (url === '/api/downloads/add' && method === 'POST') {
    if (session.role !== 'admin') return { error: 'Admin required' };
    return new Promise(async (resolve) => {
      try {
        const args = {};
        if (body.magnet) args.filename = body.magnet;
        if (body.metainfo) args.metainfo = body.metainfo; // base64 .torrent
        if (body.downloadDir) args['download-dir'] = body.downloadDir;
        if (body.paused !== undefined) args.paused = body.paused;
        
        const result = await transmissionRPC('torrent-add', args);
        if (result.result === 'success') {
          resolve({ ok: true, torrent: result.arguments['torrent-added'] || result.arguments['torrent-duplicate'] });
        } else {
          resolve({ error: result.result });
        }
      } catch (err) {
        resolve({ error: err.message });
      }
    });
  }
  
  // POST /api/downloads/action — start, stop, remove torrents
  if (url === '/api/downloads/action' && method === 'POST') {
    if (session.role !== 'admin') return { error: 'Admin required' };
    return new Promise(async (resolve) => {
      try {
        const { action, ids } = body;
        if (!action || !ids) return resolve({ error: 'action and ids required' });
        
        let rpcMethod = '';
        let args = { ids: Array.isArray(ids) ? ids : [ids] };
        
        switch (action) {
          case 'start': rpcMethod = 'torrent-start'; break;
          case 'stop': rpcMethod = 'torrent-stop'; break;
          case 'remove': rpcMethod = 'torrent-remove'; args['delete-local-data'] = false; break;
          case 'remove-data': rpcMethod = 'torrent-remove'; args['delete-local-data'] = true; break;
          case 'verify': rpcMethod = 'torrent-verify'; break;
          case 'reannounce': rpcMethod = 'torrent-reannounce'; break;
          case 'move':
            rpcMethod = 'torrent-set-location';
            args.location = body.location;
            args.move = true;
            break;
          default: return resolve({ error: 'Unknown action' });
        }
        
        const result = await transmissionRPC(rpcMethod, args);
        resolve({ ok: result.result === 'success', result: result.result });
      } catch (err) {
        resolve({ error: err.message });
      }
    });
  }
  
  // GET /api/downloads/torrent/:id — detailed info for a specific torrent
  const torrentMatch = url.match(/^\/api\/downloads\/torrent\/(\d+)$/);
  if (torrentMatch && method === 'GET') {
    return new Promise(async (resolve) => {
      try {
        const id = parseInt(torrentMatch[1]);
        const result = await transmissionRPC('torrent-get', {
          ids: [id],
          fields: ['id', 'name', 'status', 'totalSize', 'percentDone', 'rateDownload', 'rateUpload',
                   'eta', 'downloadedEver', 'uploadedEver', 'addedDate', 'doneDate', 'downloadDir',
                   'error', 'errorString', 'peersConnected', 'peersSendingToUs', 'peersGettingFromUs',
                   'isFinished', 'hashString', 'files', 'fileStats', 'peers', 'trackerStats',
                   'uploadRatio', 'comment', 'creator', 'dateCreated', 'magnetLink', 'pieceCount', 'pieceSize']
        });
        if (result.result === 'success' && result.arguments.torrents.length > 0) {
          resolve({ torrent: result.arguments.torrents[0] });
        } else {
          resolve({ error: 'Torrent not found' });
        }
      } catch (err) {
        resolve({ error: err.message });
      }
    });
  }
  
  // GET /api/downloads/settings — get Transmission settings
  if (url === '/api/downloads/settings' && method === 'GET') {
    return new Promise(async (resolve) => {
      try {
        const result = await transmissionRPC('session-get');
        if (result.result === 'success') {
          const s = result.arguments;
          resolve({
            downloadDir: s['download-dir'],
            speedLimitDown: s['speed-limit-down'],
            speedLimitDownEnabled: s['speed-limit-down-enabled'],
            speedLimitUp: s['speed-limit-up'],
            speedLimitUpEnabled: s['speed-limit-up-enabled'],
            peerPort: s['peer-port'],
            encryption: s['encryption'],
            peerLimitGlobal: s['peer-limit-global'],
            peerLimitPerTorrent: s['peer-limit-per-torrent'],
          });
        } else {
          resolve({ error: result.result });
        }
      } catch (err) {
        resolve({ error: err.message });
      }
    });
  }
  
  // POST /api/downloads/settings — update Transmission settings
  if (url === '/api/downloads/settings' && method === 'POST') {
    if (session.role !== 'admin') return { error: 'Admin required' };
    return new Promise(async (resolve) => {
      try {
        const args = {};
        if (body.downloadDir) args['download-dir'] = body.downloadDir;
        if (body.speedLimitDown !== undefined) { args['speed-limit-down'] = body.speedLimitDown; args['speed-limit-down-enabled'] = body.speedLimitDown > 0; }
        if (body.speedLimitUp !== undefined) { args['speed-limit-up'] = body.speedLimitUp; args['speed-limit-up-enabled'] = body.speedLimitUp > 0; }
        if (body.peerPort) args['peer-port'] = body.peerPort;
        if (body.encryption) args['encryption'] = body.encryption;
        
        const result = await transmissionRPC('session-set', args);
        resolve({ ok: result.result === 'success' });
      } catch (err) {
        resolve({ error: err.message });
      }
    });
  }

  // POST /api/downloads/configure — initial setup of Transmission for NimbusOS
  if (url === '/api/downloads/configure' && method === 'POST') {
    if (session.role !== 'admin') return { error: 'Admin required' };
    try {
      const downloadDir = body.downloadDir || '/nimbus/downloads';
      
      // Stop daemon to modify settings
      run('sudo systemctl stop transmission-daemon 2>/dev/null');
      
      const settingsPath = '/etc/transmission-daemon/settings.json';
      let settings = {};
      try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')); } catch {}
      
      // Configure for NimbusOS
      settings['download-dir'] = downloadDir;
      settings['rpc-enabled'] = true;
      settings['rpc-port'] = 9091;
      settings['rpc-whitelist-enabled'] = true;
      settings['rpc-whitelist'] = '127.0.0.1,::1';
      settings['rpc-authentication-required'] = false;
      settings['rpc-bind-address'] = '127.0.0.1';
      settings['umask'] = 2;
      settings['watch-dir-enabled'] = false;
      settings['peer-port'] = body.peerPort || 51413;
      settings['encryption'] = 1; // prefer encryption
      settings['speed-limit-down-enabled'] = false;
      settings['speed-limit-up-enabled'] = false;
      settings['incomplete-dir-enabled'] = false;
      
      // Ensure download dir exists
      if (!fs.existsSync(downloadDir)) {
        run(`sudo mkdir -p "${downloadDir}"`);
        run(`sudo chown debian-transmission:debian-transmission "${downloadDir}"`);
      }
      
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      run('sudo systemctl start transmission-daemon 2>/dev/null');
      
      return { ok: true, downloadDir };
    } catch (err) {
      return { error: err.message };
    }
  }
  
  return null;
}

module.exports = { handleDownloads };
