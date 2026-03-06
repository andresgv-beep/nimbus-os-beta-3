/**
 * NimbusOS — File Manager API (browse, upload, download)
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { NIMBUS_ROOT, CONFIG_DIR, SHARES_FILE, getSessionUser, SESSIONS, hashToken, run, formatBytes } = require('./shared.cjs');
const { getShares } = require('./shares.cjs');

// ═══════════════════════════════════
// File browsing API (for File Manager)
// ═══════════════════════════════════
function handleFiles(url, method, body, req) {
  const session = getSessionUser(req);
  if (!session) return { error: 'Not authenticated' };

  // GET /api/files?share=name&path=/subdir
  if (url.startsWith('/api/files') && method === 'GET') {
    const urlObj = new URL('http://localhost' + req.url);
    const shareName = urlObj.searchParams.get('share');
    const subPath = urlObj.searchParams.get('path') || '/';

    if (!shareName) {
      // Return list of shares this user can access
      const shares = getShares();
      const accessible = shares.filter(s => {
        if (session.role === 'admin') return true;
        const perm = (s.permissions || {})[session.username];
        return perm === 'rw' || perm === 'ro';
      }).map(s => ({
        name: s.name,
        displayName: s.displayName,
        description: s.description,
        permission: session.role === 'admin' ? 'rw' : ((s.permissions || {})[session.username] || 'none'),
      }));
      return { shares: accessible };
    }

    // Check permission
    const shares = getShares();
    const share = shares.find(s => s.name === shareName);
    if (!share) return { error: 'Shared folder not found' };

    const perm = session.role === 'admin' ? 'rw' : ((share.permissions || {})[session.username] || 'none');
    if (perm === 'none') return { error: 'Access denied' };

    // Read directory
    // SECURITY: Normalize and validate path to prevent traversal
    const normalizedSubPath = path.normalize(subPath).replace(/^(\.\.[\/\\])+/, '');
    const fullPath = path.join(share.path, normalizedSubPath);
    
    // Security: prevent path traversal - must be within share.path
    const resolvedFull = path.resolve(fullPath);
    const resolvedShare = path.resolve(share.path);
    if (!resolvedFull.startsWith(resolvedShare)) {
      return { error: 'Invalid path: access denied' };
    }

    try {
      const entries = fs.readdirSync(fullPath, { withFileTypes: true });
      const files = entries.map(e => {
        const filePath = path.join(fullPath, e.name);
        let size = 0;
        let modified = null;
        try {
          const stat = fs.statSync(filePath);
          size = stat.size;
          modified = stat.mtime.toISOString();
        } catch {}
        return {
          name: e.name,
          isDirectory: e.isDirectory(),
          size,
          modified,
        };
      }).sort((a, b) => {
        // Directories first, then alphabetical
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      return { files, path: subPath, share: shareName, permission: perm };
    } catch (err) {
      return { error: 'Cannot read directory', detail: err.message };
    }
  }

  // POST /api/files/mkdir — create directory
  if (url === '/api/files/mkdir' && method === 'POST') {
    const { share: shareName, path: dirPath, name: dirName } = body;
    if (!shareName || !dirName) return { error: 'Missing share or name' };

    const shares = getShares();
    const share = shares.find(s => s.name === shareName);
    if (!share) return { error: 'Shared folder not found' };

    const perm = session.role === 'admin' ? 'rw' : ((share.permissions || {})[session.username] || 'none');
    if (perm !== 'rw') return { error: 'Write access denied' };

    // SECURITY: Sanitize directory name
    if (dirName.includes('..') || dirName.includes('/') || dirName.includes('\\')) {
      return { error: 'Invalid directory name' };
    }
    
    const normalizedDirPath = path.normalize(dirPath || '').replace(/^(\.\.[\/\\])+/, '');
    const fullPath = path.join(share.path, normalizedDirPath, dirName);
    
    // Verify within share
    const resolvedFull = path.resolve(fullPath);
    const resolvedShare = path.resolve(share.path);
    if (!resolvedFull.startsWith(resolvedShare)) {
      return { error: 'Invalid path: access denied' };
    }

    try {
      fs.mkdirSync(fullPath, { recursive: true });
      return { ok: true };
    } catch (err) {
      return { error: err.message };
    }
  }

  // POST /api/files/delete — delete file or directory
  if (url === '/api/files/delete' && method === 'POST') {
    const { share: shareName, path: filePath } = body;
    if (!shareName || !filePath) return { error: 'Missing share or path' };

    const shares = getShares();
    const share = shares.find(s => s.name === shareName);
    if (!share) return { error: 'Shared folder not found' };

    const perm = session.role === 'admin' ? 'rw' : ((share.permissions || {})[session.username] || 'none');
    if (perm !== 'rw') return { error: 'Write access denied' };

    // SECURITY: Validate path
    const normalizedPath = path.normalize(filePath).replace(/^(\.\.[\/\\])+/, '');
    const fullPath = path.join(share.path, normalizedPath);
    const resolvedFull = path.resolve(fullPath);
    const resolvedShare = path.resolve(share.path);
    
    if (!resolvedFull.startsWith(resolvedShare) || resolvedFull === resolvedShare) {
      return { error: 'Invalid path: access denied' };
    }

    try {
      fs.rmSync(fullPath, { recursive: true });
      return { ok: true };
    } catch (err) {
      return { error: err.message };
    }
  }

  // POST /api/files/rename
  if (url === '/api/files/rename' && method === 'POST') {
    const { share: shareName, oldPath, newPath } = body;
    if (!shareName || !oldPath || !newPath) return { error: 'Missing params' };

    const shares = getShares();
    const share = shares.find(s => s.name === shareName);
    if (!share) return { error: 'Shared folder not found' };

    const perm = session.role === 'admin' ? 'rw' : ((share.permissions || {})[session.username] || 'none');
    if (perm !== 'rw') return { error: 'Write access denied' };

    // SECURITY: Validate both paths
    const normalizedOld = path.normalize(oldPath).replace(/^(\.\.[\/\\])+/, '');
    const normalizedNew = path.normalize(newPath).replace(/^(\.\.[\/\\])+/, '');
    const fullOld = path.join(share.path, normalizedOld);
    const fullNew = path.join(share.path, normalizedNew);
    const resolvedOld = path.resolve(fullOld);
    const resolvedNew = path.resolve(fullNew);
    const resolvedShare = path.resolve(share.path);
    
    if (!resolvedOld.startsWith(resolvedShare) || !resolvedNew.startsWith(resolvedShare)) {
      return { error: 'Invalid path: access denied' };
    }

    try {
      fs.renameSync(fullOld, fullNew);
      return { ok: true };
    } catch (err) {
      return { error: err.message };
    }
  }

  // POST /api/files/paste — copy or move
  if (url === '/api/files/paste' && method === 'POST') {
    const { srcShare, srcPath, destShare, destPath, action } = body;
    if (!srcShare || !srcPath || !destShare || !destPath) return { error: 'Missing params' };

    const shares = getShares();
    const src = shares.find(s => s.name === srcShare);
    const dest = shares.find(s => s.name === destShare);
    if (!src || !dest) return { error: 'Share not found' };

    const destPerm = session.role === 'admin' ? 'rw' : ((dest.permissions || {})[session.username] || 'none');
    if (destPerm !== 'rw') return { error: 'Write access denied on destination' };

    // SECURITY: Validate both paths
    const normalizedSrc = path.normalize(srcPath).replace(/^(\.\.[\/\\])+/, '');
    const normalizedDest = path.normalize(destPath).replace(/^(\.\.[\/\\])+/, '');
    const fullSrc = path.join(src.path, normalizedSrc);
    const fullDest = path.join(dest.path, normalizedDest);
    const resolvedSrc = path.resolve(fullSrc);
    const resolvedDest = path.resolve(fullDest);
    const resolvedSrcShare = path.resolve(src.path);
    const resolvedDestShare = path.resolve(dest.path);
    
    if (!resolvedSrc.startsWith(resolvedSrcShare) || !resolvedDest.startsWith(resolvedDestShare)) {
      return { error: 'Invalid path: access denied' };
    }

    try {
      if (action === 'cut') {
        fs.renameSync(fullSrc, fullDest);
      } else {
        fs.cpSync(fullSrc, fullDest, { recursive: true });
      }
      return { ok: true };
    } catch (err) {
      return { error: err.message };
    }
  }

  return null;
}

// Handle file upload (multipart) — called directly from HTTP handler
function handleFileUpload(req, res, session) {
  const boundary = req.headers['content-type']?.split('boundary=')[1];
  if (!boundary) {
    res.writeHead(400, CORS_HEADERS);
    return res.end(JSON.stringify({ error: 'No boundary' }));
  }

  let rawData = [];
  req.on('data', chunk => rawData.push(chunk));
  req.on('end', () => {
    const buffer = Buffer.concat(rawData);
    const text = buffer.toString('latin1');
    const parts = text.split('--' + boundary).slice(1, -1);

    let shareName = '', uploadPath = '', fileName = '', fileData = null;

    for (const part of parts) {
      const headerEnd = part.indexOf('\r\n\r\n');
      const header = part.substring(0, headerEnd);
      const body = part.substring(headerEnd + 4, part.length - 2);

      if (header.includes('name="share"')) {
        shareName = body.trim();
      } else if (header.includes('name="path"')) {
        uploadPath = body.trim();
      } else if (header.includes('name="file"')) {
        const fnMatch = header.match(/filename="([^"]+)"/);
        if (fnMatch) fileName = fnMatch[1];
        // Get binary data from original buffer
        const headerBytes = Buffer.from(part.substring(0, headerEnd + 4), 'latin1').length;
        const partStart = buffer.indexOf('--' + boundary);
        // Simpler: just use the text body and convert back
        fileData = Buffer.from(body, 'latin1');
      }
    }

    if (!shareName || !fileName) {
      res.writeHead(400, CORS_HEADERS);
      return res.end(JSON.stringify({ error: 'Missing data' }));
    }

    const shares = getShares();
    const share = shares.find(s => s.name === shareName);
    if (!share) {
      res.writeHead(400, CORS_HEADERS);
      return res.end(JSON.stringify({ error: 'Share not found' }));
    }

    const perm = session.role === 'admin' ? 'rw' : ((share.permissions || {})[session.username] || 'none');
    if (perm !== 'rw') {
      res.writeHead(403, CORS_HEADERS);
      return res.end(JSON.stringify({ error: 'Write access denied' }));
    }

    // SECURITY: Sanitize filename and validate path
    const safeFileName = fileName.replace(/[\/\\:*?"<>|]/g, '_').replace(/\.\./g, '');
    if (!safeFileName || safeFileName.length > 255) {
      res.writeHead(400, CORS_HEADERS);
      return res.end(JSON.stringify({ error: 'Invalid filename' }));
    }
    
    const normalizedPath = path.normalize(uploadPath || '').replace(/^(\.\.[\/\\])+/, '');
    const fullPath = path.join(share.path, normalizedPath, safeFileName);
    const resolvedFull = path.resolve(fullPath);
    const resolvedShare = path.resolve(share.path);
    
    if (!resolvedFull.startsWith(resolvedShare)) {
      res.writeHead(400, CORS_HEADERS);
      return res.end(JSON.stringify({ error: 'Invalid path: access denied' }));
    }

    try {
      fs.writeFileSync(fullPath, fileData);
      res.writeHead(200, CORS_HEADERS);
      res.end(JSON.stringify({ ok: true, name: safeFileName }));
    } catch (err) {
      res.writeHead(500, CORS_HEADERS);
      res.end(JSON.stringify({ error: err.message }));
    }
  });
}

// Handle file download — called directly from HTTP handler
function handleFileDownload(req, res, session) {
  const urlObj = new URL('http://localhost' + req.url);
  const shareName = urlObj.searchParams.get('share');
  const filePath = urlObj.searchParams.get('path');

  if (!shareName || !filePath) {
    res.writeHead(400, CORS_HEADERS);
    return res.end(JSON.stringify({ error: 'Missing params' }));
  }

  const shares = getShares();
  const share = shares.find(s => s.name === shareName);
  if (!share) {
    res.writeHead(404, CORS_HEADERS);
    return res.end(JSON.stringify({ error: 'Share not found' }));
  }

  const perm = session.role === 'admin' ? 'rw' : ((share.permissions || {})[session.username] || 'none');
  if (perm === 'none') {
    res.writeHead(403, CORS_HEADERS);
    return res.end(JSON.stringify({ error: 'Access denied' }));
  }

  // SECURITY: Validate path
  const normalizedPath = path.normalize(filePath).replace(/^(\.\.[\/\\])+/, '');
  const fullPath = path.join(share.path, normalizedPath);
  const resolvedFull = path.resolve(fullPath);
  const resolvedShare = path.resolve(share.path);
  
  if (!resolvedFull.startsWith(resolvedShare)) {
    res.writeHead(400, CORS_HEADERS);
    return res.end(JSON.stringify({ error: 'Invalid path: access denied' }));
  }

  try {
    const stat = fs.statSync(fullPath);
    const fileName = path.basename(fullPath);
    const ext = fileName.split('.').pop().toLowerCase();

    // MIME type map for previewing
    const mimeTypes = {
      jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
      webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
      mp4: 'video/mp4', webm: 'video/webm', ogg: 'video/ogg', mov: 'video/quicktime',
      mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', aac: 'audio/aac',
      pdf: 'application/pdf',
      txt: 'text/plain', md: 'text/plain', log: 'text/plain', csv: 'text/plain',
      json: 'application/json', xml: 'text/xml', yml: 'text/yaml', yaml: 'text/yaml',
      js: 'text/javascript', jsx: 'text/javascript', ts: 'text/javascript',
      py: 'text/plain', sh: 'text/plain', css: 'text/css', html: 'text/html',
      c: 'text/plain', cpp: 'text/plain', h: 'text/plain', java: 'text/plain',
      rs: 'text/plain', go: 'text/plain', rb: 'text/plain', php: 'text/plain',
      sql: 'text/plain', toml: 'text/plain', ini: 'text/plain', conf: 'text/plain',
    };
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    const isDownload = contentType === 'application/octet-stream';
    const fileSize = stat.size;

    // Range request support (needed for audio/video seeking)
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      res.writeHead(206, {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': contentType,
        'Content-Range': `bytes ${start}-${end}/${fileSize}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkSize,
      });
      const stream = fs.createReadStream(fullPath, { start, end });
      stream.pipe(res);
      return;
    }

    const resHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': contentType,
      'Content-Length': fileSize,
      'Accept-Ranges': 'bytes',
    };
    if (isDownload) {
      resHeaders['Content-Disposition'] = `attachment; filename="${fileName}"`;
    }

    res.writeHead(200, resHeaders);
    const stream = fs.createReadStream(fullPath);
    stream.pipe(res);
  } catch (err) {
    res.writeHead(404, CORS_HEADERS);
    res.end(JSON.stringify({ error: 'File not found' }));
  }
}


module.exports = { handleFiles, handleFileUpload, handleFileDownload };
