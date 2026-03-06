/**
 * NimbusOS — Shared Folders API
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { NIMBUS_ROOT, SHARES_FILE, getSessionUser, run } = require('./shared.cjs');
const { getStorageConfig } = require('./storage.cjs');

// ═══════════════════════════════════
// Shared Folders API
// ═══════════════════════════════════
const VOLUMES_DIR = path.join(NIMBUS_ROOT, 'volumes');

function getShares() {
  try { return JSON.parse(fs.readFileSync(SHARES_FILE, 'utf-8')); }
  catch { return []; }
}

function saveShares(shares) {
  fs.writeFileSync(SHARES_FILE, JSON.stringify(shares, null, 2));
}

function handleShares(url, method, body, req) {
  const session = getSessionUser(req);

  // GET /api/shares — list all shared folders (any authenticated user)
  if (url === '/api/shares' && method === 'GET') {
    if (!session) return { error: 'Not authenticated' };
    const shares = getShares();
    // If not admin, filter to only shares they have access to
    if (session.role !== 'admin') {
      return shares.filter(s => {
        const perm = (s.permissions || {})[session.username];
        return perm === 'rw' || perm === 'ro';
      }).map(s => ({
        ...s,
        myPermission: (s.permissions || {})[session.username] || 'none',
      }));
    }
    return shares;
  }

  // POST /api/shares — create shared folder (admin only)
  if (url === '/api/shares' && method === 'POST') {
    if (!session || session.role !== 'admin') return { error: 'Unauthorized' };
    const { name, description, pool } = body;
    if (!name || !name.trim()) return { error: 'Folder name required' };
    if (/[^a-zA-Z0-9_\- ]/.test(name.trim())) return { error: 'Name can only contain letters, numbers, spaces, -, _' };

    const shares = getShares();
    const safeName = name.trim().toLowerCase().replace(/\s+/g, '-');

    if (shares.find(s => s.name === safeName)) return { error: 'Shared folder already exists' };

    // Determine target path — MUST use a pool
    const storageConf = getStorageConfig();
    const targetPool = pool 
      ? (storageConf.pools || []).find(p => p.name === pool)
      : (storageConf.pools || []).find(p => p.name === storageConf.primaryPool);
    
    if (!targetPool) {
      return { error: 'No storage pool available. Create a pool in Storage Manager first.' };
    }
    
    const folderPath = path.join(targetPool.mountPoint, 'shares', safeName);
    const volumeName = targetPool.name;
    
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true });
    }
    // Set ownership so SMB users can access — owner=creator, group=nimbus, mode=2775 (setgid)
    run(`sudo chown ${session.username}:nimbus "${folderPath}" 2>/dev/null`);
    run(`sudo chmod 2775 "${folderPath}" 2>/dev/null`);

    // Default: admin has rw
    const permissions = {};
    permissions[session.username] = 'rw';

    shares.push({
      name: safeName,
      displayName: name.trim(),
      description: description || '',
      path: folderPath,
      volume: volumeName,
      pool: targetPool ? targetPool.name : null,
      created: new Date().toISOString(),
      createdBy: session.username,
      recycleBin: true,
      permissions,        // User permissions: { "user1": "rw", "user2": "ro" }
      appPermissions: [], // App permissions: ["plex", "jellyfin", "immich"]
    });
    saveShares(shares);

    return { ok: true, name: safeName, path: folderPath, pool: volumeName };
  }

  // PUT /api/shares/:name — update shared folder (admin only)
  const shareMatch = url.match(/^\/api\/shares\/([a-zA-Z0-9_-]+)$/);
  if (shareMatch && method === 'PUT') {
    if (!session || session.role !== 'admin') return { error: 'Unauthorized' };
    const target = shareMatch[1];
    const shares = getShares();
    const share = shares.find(s => s.name === target);
    if (!share) return { error: 'Shared folder not found' };

    if (body.description !== undefined) share.description = body.description;
    if (body.recycleBin !== undefined) share.recycleBin = body.recycleBin;
    if (body.permissions) share.permissions = body.permissions;
    if (body.appPermissions) share.appPermissions = body.appPermissions; // NEW

    saveShares(shares);
    return { ok: true };
  }

  // DELETE /api/shares/:name — delete shared folder (admin only)
  if (shareMatch && method === 'DELETE') {
    if (!session || session.role !== 'admin') return { error: 'Unauthorized' };
    const target = shareMatch[1];
    let shares = getShares();
    const share = shares.find(s => s.name === target);
    if (!share) return { error: 'Shared folder not found' };

    shares = shares.filter(s => s.name !== target);
    saveShares(shares);
    // Note: we do NOT delete the actual directory for safety
    return { ok: true };
  }

  // GET /api/shares/:name/files?path= — list files in shared folder
  if (shareMatch && method === 'GET' && url.includes('/files')) {
    // handled separately
    return null;
  }

  return null;
}


module.exports = { handleShares, getShares, saveShares };
