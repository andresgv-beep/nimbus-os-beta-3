/**
 * NimbusOS — Auth, Users, Preferences, 2FA
 */
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const path = require('path');
const shared = require('./shared.cjs');
const { NIMBUS_ROOT, CONFIG_DIR, USER_DATA_DIR, USERS_FILE, SESSIONS, hashToken, saveSessions, SESSION_EXPIRY_MS, getSessionUser, run } = shared;

// ═══════════════════════════════════
// Default user preferences
// ═══════════════════════════════════
const DEFAULT_PREFERENCES = {
  theme: 'dark',
  accentColor: 'orange',
  glowIntensity: 50,
  taskbarSize: 'medium',
  taskbarPosition: 'bottom',
  autoHideTaskbar: false,
  clock24: true,
  showDesktopIcons: true,
  textScale: 100,
  wallpaper: '',
  showWidgets: true,
  widgetScale: 100,
  visibleWidgets: {
    system: true,
    network: true,
    disk: true,
    notifications: true
  },
  pinnedApps: ['files', 'appstore', 'settings'],
  playlist: [],
  playlistName: 'Mi Lista'
};

// ═══════════════════════════════════
// User Preferences Management
// ═══════════════════════════════════
function getUserDataPath(username) {
  const safeName = username.replace(/[^a-zA-Z0-9_-]/g, '');
  return path.join(USER_DATA_DIR, safeName);
}

function ensureUserDataDir(username) {
  const userPath = getUserDataPath(username);
  if (!fs.existsSync(userPath)) {
    fs.mkdirSync(userPath, { recursive: true });
  }
  return userPath;
}

function getUserPreferences(username) {
  try {
    const userPath = getUserDataPath(username);
    const prefsFile = path.join(userPath, 'preferences.json');
    if (fs.existsSync(prefsFile)) {
      const saved = JSON.parse(fs.readFileSync(prefsFile, 'utf-8'));
      // Merge with defaults to ensure all keys exist
      return { ...DEFAULT_PREFERENCES, ...saved };
    }
  } catch (err) {
    console.error(`[Prefs] Error loading preferences for ${username}:`, err.message);
  }
  return { ...DEFAULT_PREFERENCES };
}

function saveUserPreferences(username, prefs) {
  try {
    const userPath = ensureUserDataDir(username);
    const prefsFile = path.join(userPath, 'preferences.json');
    // Only save non-default values to keep file small
    fs.writeFileSync(prefsFile, JSON.stringify(prefs, null, 2));
    console.log(`[Prefs] Saved preferences for ${username}`);
    return true;
  } catch (err) {
    console.error(`[Prefs] Error saving preferences for ${username}:`, err.message);
    return false;
  }
}

function getUserPlaylist(username) {
  try {
    const userPath = getUserDataPath(username);
    const playlistFile = path.join(userPath, 'playlist.json');
    if (fs.existsSync(playlistFile)) {
      return JSON.parse(fs.readFileSync(playlistFile, 'utf-8'));
    }
  } catch (err) {
    console.error(`[Playlist] Error loading playlist for ${username}:`, err.message);
  }
  return [];
}

function saveUserPlaylist(username, playlist) {
  try {
    const userPath = ensureUserDataDir(username);
    const playlistFile = path.join(userPath, 'playlist.json');
    fs.writeFileSync(playlistFile, JSON.stringify(playlist, null, 2));
    console.log(`[Playlist] Saved ${playlist.length} items for ${username}`);
    return true;
  } catch (err) {
    console.error(`[Playlist] Error saving playlist for ${username}:`, err.message);
    return false;
  }
}
// ═══════════════════════════════════
// Auth helpers
// ═══════════════════════════════════
// ═══════════════════════════════════
// Rate limiting for auth endpoints
// ═══════════════════════════════════
const LOGIN_ATTEMPTS = {}; // { ip: { count, lastAttempt, lockedUntil } }
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION = 15 * 60 * 1000; // 15 minutes

function checkRateLimit(ip) {
  const record = LOGIN_ATTEMPTS[ip];
  if (!record) return { allowed: true };
  if (record.lockedUntil && Date.now() < record.lockedUntil) {
    const remaining = Math.ceil((record.lockedUntil - Date.now()) / 60000);
    return { allowed: false, message: `Too many attempts. Try again in ${remaining} minutes.` };
  }
  if (record.lockedUntil && Date.now() >= record.lockedUntil) {
    delete LOGIN_ATTEMPTS[ip];
    return { allowed: true };
  }
  return { allowed: true };
}

function recordFailedAttempt(ip) {
  if (!LOGIN_ATTEMPTS[ip]) LOGIN_ATTEMPTS[ip] = { count: 0, lastAttempt: 0 };
  const record = LOGIN_ATTEMPTS[ip];
  // Reset if last attempt was more than lockout duration ago
  if (Date.now() - record.lastAttempt > LOCKOUT_DURATION) record.count = 0;
  record.count++;
  record.lastAttempt = Date.now();
  if (record.count >= MAX_LOGIN_ATTEMPTS) {
    record.lockedUntil = Date.now() + LOCKOUT_DURATION;
  }
}

function clearFailedAttempts(ip) {
  delete LOGIN_ATTEMPTS[ip];
}

// Clean up old entries every hour
setInterval(() => {
  const now = Date.now();
  for (const ip of Object.keys(LOGIN_ATTEMPTS)) {
    const r = LOGIN_ATTEMPTS[ip];
    if (now - r.lastAttempt > LOCKOUT_DURATION * 2) delete LOGIN_ATTEMPTS[ip];
  }
}, 3600000);
// ═══════════════════════════════════
// TOTP secret encryption (encrypt at rest with server key)
// ═══════════════════════════════════
const SERVER_KEY_FILE = path.join(CONFIG_DIR, '.server_key');
function getServerKey() {
  if (fs.existsSync(SERVER_KEY_FILE)) {
    const existing = fs.readFileSync(SERVER_KEY_FILE, 'utf-8').trim();
    // If key is valid 64-char hex (32 bytes), use it directly
    if (/^[0-9a-f]{64}$/i.test(existing)) return existing;
    // Otherwise regenerate as proper hex key
  }
  const key = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SERVER_KEY_FILE, key, { mode: 0o600 });
  return key;
}

function encryptSecret(plaintext) {
  const key = Buffer.from(getServerKey(), 'hex');
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decryptSecret(ciphertext) {
  if (!ciphertext || !ciphertext.includes(':')) return ciphertext; // backwards compat: unencrypted
  const key = Buffer.from(getServerKey(), 'hex');
  const [ivHex, encrypted] = ciphertext.split(':');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex, 'hex'));
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// Backup codes for 2FA recovery
function generateBackupCodes(count = 8) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    codes.push(crypto.randomBytes(4).toString('hex').toUpperCase());
  }
  return codes;
}

function validatePassword(password) {
  if (!password || password.length < 8) return 'Password must be at least 8 characters';
  if (!/[A-Z]/.test(password)) return 'Password must contain at least one uppercase letter';
  if (!/[0-9]/.test(password)) return 'Password must contain at least one number';
  return null;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

// ═══════════════════════════════════
// TOTP (2FA) — compatible with Google Authenticator
// ═══════════════════════════════════
function generateTotpSecret() {
  // Generate 20 random bytes, encode as base32
  const bytes = crypto.randomBytes(20);
  return base32Encode(bytes);
}

function base32Encode(buffer) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0, result = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) result += alphabet[(value << (5 - bits)) & 31];
  return result;
}

function base32Decode(str) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0;
  const output = [];
  for (const c of str.toUpperCase().replace(/=+$/, '')) {
    const idx = alphabet.indexOf(c);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xFF);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

function generateTotp(secret, time) {
  const t = Math.floor((time || Date.now() / 1000) / 30);
  const timeBuffer = Buffer.alloc(8);
  timeBuffer.writeUInt32BE(0, 0);
  timeBuffer.writeUInt32BE(t, 4);
  const key = base32Decode(secret);
  const hmac = crypto.createHmac('sha1', key).update(timeBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24 | hmac[offset + 1] << 16 | hmac[offset + 2] << 8 | hmac[offset + 3]) % 1000000;
  return code.toString().padStart(6, '0');
}

function verifyTotp(secret, token) {
  // Check current and ±1 time step (30 second window each side)
  const now = Date.now() / 1000;
  for (let i = -1; i <= 1; i++) {
    if (generateTotp(secret, now + i * 30) === token) return true;
  }
  return false;
}

function getTotpQrUrl(username, secret) {
  const issuer = 'NimbusOS';
  const uri = `otpauth://totp/${issuer}:${username}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
  return { uri };
}

function generateQrSvg(text) {
  // Try qrencode CLI first (apt install qrencode)
  try {
    const svg = execSync(`echo -n "${text.replace(/"/g, '\\"')}" | qrencode -t SVG -o - -m 1`, { timeout: 5000 }).toString();
    return svg;
  } catch {}
  
  // Try python3 qrcode module
  try {
    const svg = execSync(`python3 -c "
import qrcode, qrcode.image.svg, sys
img = qrcode.make(sys.argv[1], image_factory=qrcode.image.svg.SvgPathImage, box_size=8, border=1)
import io; buf = io.BytesIO(); img.save(buf); sys.stdout.buffer.write(buf.getvalue())
" "${text.replace(/"/g, '\\"')}"`, { timeout: 5000 }).toString();
    return svg;
  } catch {}
  
  // Install qrencode and retry
  try {
    execSync('apt-get install -y qrencode 2>/dev/null', { timeout: 30000, stdio: 'pipe' });
    const svg = execSync(`echo -n "${text.replace(/"/g, '\\"')}" | qrencode -t SVG -o - -m 1`, { timeout: 5000 }).toString();
    return svg;
  } catch {}
  
  throw new Error('QR generation not available. Install qrencode: sudo apt install qrencode');
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(password, salt, 64).toString('hex');
  return hash === test;
}

function generateToken() {
  return crypto.randomBytes(48).toString('base64url');
}

function getUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8')); }
  catch { return []; }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), { mode: 0o600 });
}

function isSetupDone() {
  const users = getUsers();
  return users.length > 0;
}

// ═══════════════════════════════════
// Auth API handlers
// ═══════════════════════════════════
// ═══════════════════════════════════
// Linux / Samba user sync
// ═══════════════════════════════════
function ensureLinuxUser(username) {
  // Check if user already exists in Linux
  const exists = run(`id "${username}" 2>/dev/null`);
  if (!exists) {
    // Create system user: no home, no login shell, in 'nimbus' group for shared access
    run(`sudo useradd -M -s /usr/sbin/nologin -G nimbus "${username}" 2>/dev/null`);
    // If nimbus group doesn't exist, create without group
    if (!run(`id "${username}" 2>/dev/null`)) {
      run(`sudo useradd -M -s /usr/sbin/nologin "${username}" 2>/dev/null`);
    }
  }
}

function ensureSmbUser(username, password) {
  ensureLinuxUser(username);
  // Set samba password securely via stdin (password not visible in ps aux)
  try {
    const { spawnSync } = require('child_process');
    const result = spawnSync('sudo', ['smbpasswd', '-s', '-a', username], {
      input: password + '\n' + password + '\n',
      encoding: 'utf-8',
      timeout: 10000,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

function removeLinuxSmbUser(username) {
  // Remove from samba
  run(`sudo smbpasswd -x "${username}" 2>/dev/null`);
  // Remove linux user (only if it was created by NimbusOS — check nologin shell)
  const shell = run(`getent passwd "${username}" 2>/dev/null | cut -d: -f7`);
  if (shell && shell.includes('nologin')) {
    run(`sudo userdel "${username}" 2>/dev/null`);
  }
}
function handleAuth(url, method, body, req) {

  // GET /api/auth/status — is setup done?
  if (url === '/api/auth/status' && method === 'GET') {
    return { setup: isSetupDone(), hostname: os.hostname() };
  }

  // POST /api/auth/setup — create initial admin account (only if no users exist)
  if (url === '/api/auth/setup' && method === 'POST') {
    if (isSetupDone()) return { error: 'Setup already completed' };
    const { username, password, deviceName } = body;
    if (!username || !password) return { error: 'Username and password required' };
    if (!/^[a-zA-Z][a-zA-Z0-9_]{1,31}$/.test(username.trim())) return { error: 'Invalid username: letters, numbers and underscores only (2-32 chars)' };
    const pwErr = validatePassword(password); if (pwErr) return { error: pwErr };

    const users = [{
      username: username.toLowerCase().trim(),
      password: hashPassword(password),
      role: 'admin',
      created: new Date().toISOString(),
      description: 'System administrator',
    }];
    saveUsers(users);

    // Sync: create Linux user + Samba password
    ensureSmbUser(users[0].username, password);

    // Create default volume directory
    const volDir = path.join(NIMBUS_ROOT, 'volumes', 'volume1');
    if (!fs.existsSync(volDir)) fs.mkdirSync(volDir, { recursive: true });

    // Auto-login after setup
    const token = generateToken();
    SESSIONS[hashToken(token)] = { username: users[0].username, role: 'admin', created: Date.now() };
    saveSessions();

    return { ok: true, token, user: { username: users[0].username, role: 'admin' } };
  }

  // POST /api/auth/login
  if (url === '/api/auth/login' && method === 'POST') {
    const { username, password, totpCode } = body;
    if (!username || !password) return { error: 'Username and password required' };

    // Rate limiting
    const clientIp = req.socket?.remoteAddress || 'unknown';
    const rateCheck = checkRateLimit(clientIp);
    if (!rateCheck.allowed) return { error: rateCheck.message };

    const users = getUsers();
    const user = users.find(u => u.username === username.toLowerCase().trim());
    if (!user || !verifyPassword(password, user.password)) {
      recordFailedAttempt(clientIp);
      return { error: 'Invalid credentials' };
    }

    // Check 2FA if enabled
    if (user.totpSecret && user.totpEnabled) {
      if (!totpCode) {
        return { requires2FA: true, message: 'Two-factor authentication code required' };
      }
      const secret = decryptSecret(user.totpSecret);
      if (!verifyTotp(secret, totpCode)) {
        // Check backup codes
        let backupValid = false;
        if (user.backupCodes && Array.isArray(user.backupCodes)) {
          const idx = user.backupCodes.indexOf(totpCode.toUpperCase());
          if (idx !== -1) {
            user.backupCodes.splice(idx, 1); // One-time use
            saveUsers(users);
            backupValid = true;
          }
        }
        if (!backupValid) {
          recordFailedAttempt(clientIp);
          return { error: 'Invalid 2FA code' };
        }
      }
    }

    clearFailedAttempts(clientIp);
    const token = generateToken();
    SESSIONS[hashToken(token)] = { username: user.username, role: user.role, created: Date.now() };
    saveSessions();

    return { ok: true, token, user: { username: user.username, role: user.role } };
  }

  // POST /api/auth/change-password
  if (url === '/api/auth/change-password' && method === 'POST') {
    const session = getSessionUser(req);
    if (!session) return { error: 'Not authenticated' };
    
    const { currentPassword, newPassword, targetUser } = body;
    if (!newPassword || newPassword.length < 4) return { error: 'Password must be at least 4 characters' };
    
    const users = getUsers();
    const editUser = targetUser && session.role === 'admin'
      ? users.find(u => u.username === targetUser)
      : users.find(u => u.username === session.username);
    
    if (!editUser) return { error: 'User not found' };
    
    // Non-admin users must provide current password
    if (!targetUser || targetUser === session.username) {
      if (!currentPassword || !verifyPassword(currentPassword, editUser.password)) {
        return { error: 'Current password is incorrect' };
      }
    }
    
    editUser.password = hashPassword(newPassword);
    // Invalidate all sessions for this user
    for (const [tk, sess] of Object.entries(SESSIONS)) { if (sess.username === editUser.username) delete SESSIONS[tk]; }
    saveUsers(users);
    
    // Also update Linux/Samba password
    ensureSmbUser(editUser.username, newPassword);
    
    return { ok: true };
  }

  // POST /api/auth/2fa/setup — generate TOTP secret and QR
  if (url === '/api/auth/2fa/setup' && method === 'POST') {
    const session = getSessionUser(req);
    if (!session) return { error: 'Not authenticated' };
    
    const users = getUsers();
    const user = users.find(u => u.username === session.username);
    if (!user) return { error: 'User not found' };
    
    // Generate new secret (store encrypted, not yet enabled)
    const secret = generateTotpSecret();
    user.totpSecret = encryptSecret(secret);
    user.totpEnabled = false;
    saveUsers(users);
    
    const { uri } = getTotpQrUrl(user.username, secret);
    return { ok: true, secret, uri };
  }

  // POST /api/auth/2fa/verify — verify TOTP code and enable 2FA
  if (url === '/api/auth/2fa/verify' && method === 'POST') {
    const session = getSessionUser(req);
    if (!session) return { error: 'Not authenticated' };
    
    const { code } = body;
    if (!code) return { error: 'Code required' };
    
    const users = getUsers();
    const user = users.find(u => u.username === session.username);
    if (!user || !user.totpSecret) return { error: 'No 2FA setup in progress' };
    
    const secret = decryptSecret(user.totpSecret);
    if (!verifyTotp(secret, code)) {
      return { error: 'Invalid code. Make sure your authenticator app is synced.' };
    }
    
    // Generate backup codes
    const backupCodes = generateBackupCodes();
    user.totpEnabled = true;
    user.backupCodes = backupCodes;
    saveUsers(users);
    
    return { ok: true, message: '2FA enabled successfully', backupCodes };
  }

  // POST /api/auth/2fa/disable — disable 2FA
  if (url === '/api/auth/2fa/disable' && method === 'POST') {
    const session = getSessionUser(req);
    if (!session) return { error: 'Not authenticated' };
    
    const { password } = body;
    if (!password) return { error: 'Password required to disable 2FA' };
    
    const users = getUsers();
    const user = users.find(u => u.username === session.username);
    if (!user) return { error: 'User not found' };
    
    if (!verifyPassword(password, user.password)) {
      return { error: 'Invalid password' };
    }
    
    user.totpSecret = null;
    user.totpEnabled = false;
    saveUsers(users);
    
    return { ok: true };
  }

  // GET /api/auth/2fa/status — check if 2FA is enabled
  if (url === '/api/auth/2fa/status' && method === 'GET') {
    const session = getSessionUser(req);
    if (!session) return { error: 'Not authenticated' };
    
    const users = getUsers();
    const user = users.find(u => u.username === session.username);
    return { enabled: !!(user?.totpEnabled) };
  }

  // POST /api/auth/2fa/qr — generate QR code as SVG
  if (url === '/api/auth/2fa/qr' && method === 'POST') {
    const session = getSessionUser(req);
    if (!session) return { error: 'Not authenticated' };
    
    const { text } = body;
    if (!text) return { error: 'Text required' };
    
    try {
      const svg = generateQrSvg(text);
      return { svg };
    } catch (err) {
      return { error: 'QR generation failed', detail: err.message };
    }
  }

  // POST /api/auth/logout
  if (url === '/api/auth/logout' && method === 'POST') {
    const auth = req.headers['authorization'] || '';
    const token = auth.replace('Bearer ', '');
    delete SESSIONS[hashToken(token)];
    saveSessions();
    return { ok: true };
  }

  // GET /api/auth/me — verify session
  if (url === '/api/auth/me' && method === 'GET') {
    const session = getSessionUser(req);
    if (!session) return { error: 'Not authenticated' };
    return { user: { username: session.username, role: session.role } };
  }

  // ═══════════════════════════════════
  // User Preferences API
  // ═══════════════════════════════════
  
  // GET /api/user/preferences — get current user's preferences
  if (url === '/api/user/preferences' && method === 'GET') {
    const session = getSessionUser(req);
    if (!session) return { error: 'Not authenticated' };
    const prefs = getUserPreferences(session.username);
    return { preferences: prefs };
  }
  
  // PUT /api/user/preferences — save current user's preferences
  if (url === '/api/user/preferences' && method === 'PUT') {
    const session = getSessionUser(req);
    if (!session) return { error: 'Not authenticated' };
    
    // Merge with existing preferences
    const current = getUserPreferences(session.username);
    const updated = { ...current, ...body };
    
    // Remove playlist from preferences (it has its own endpoint)
    delete updated.playlist;
    
    if (saveUserPreferences(session.username, updated)) {
      return { ok: true, preferences: updated };
    }
    return { error: 'Failed to save preferences' };
  }
  
  // PATCH /api/user/preferences — partial update (for single setting changes)
  if (url === '/api/user/preferences' && method === 'PATCH') {
    const session = getSessionUser(req);
    if (!session) return { error: 'Not authenticated' };
    
    const current = getUserPreferences(session.username);
    const updated = { ...current, ...body };
    delete updated.playlist;
    
    if (saveUserPreferences(session.username, updated)) {
      return { ok: true };
    }
    return { error: 'Failed to save preferences' };
  }
  
  // POST /api/user/wallpaper — upload wallpaper image (base64 in body)
  if (url === '/api/user/wallpaper' && method === 'POST') {
    const session = getSessionUser(req);
    if (!session) return { error: 'Not authenticated' };
    
    const { data, filename } = body;
    if (!data) return { error: 'No image data provided' };
    
    try {
      // Extract base64 data
      const matches = data.match(/^data:image\/(png|jpeg|jpg|webp|gif);base64,(.+)$/);
      if (!matches) return { error: 'Invalid image format' };
      
      const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
      const imgBuffer = Buffer.from(matches[2], 'base64');
      
      // Limit to 10MB
      if (imgBuffer.length > 10 * 1024 * 1024) return { error: 'Image too large (max 10MB)' };
      
      // Save to user data dir
      const userPath = ensureUserDataDir(session.username);
      const wallpaperFile = `wallpaper.${ext}`;
      const fullPath = path.join(userPath, wallpaperFile);
      fs.writeFileSync(fullPath, imgBuffer);
      
      // Return URL that the frontend can use
      const wallpaperUrl = `/api/user/wallpaper/${session.username}/${wallpaperFile}`;
      
      // Also save URL in preferences
      const current = getUserPreferences(session.username);
      current.wallpaper = wallpaperUrl;
      saveUserPreferences(session.username, current);
      
      return { ok: true, url: wallpaperUrl };
    } catch (err) {
      return { error: 'Failed to save wallpaper: ' + err.message };
    }
  }
  
  // GET /api/user/wallpaper/:username/:file — serve wallpaper image
  const wpMatch = url.match(/^\/api\/user\/wallpaper\/([a-zA-Z0-9_.-]+)\/wallpaper\.(png|jpg|jpeg|webp|gif)$/);
  if (wpMatch && method === 'GET') {
    const session = getSessionUser(req);
    if (!session) return { error: 'Not authenticated' };
    
    const wpUser = wpMatch[1];
    const ext = wpMatch[2];
    const userPath = getUserDataPath(wpUser);
    const wallpaperPath = path.join(userPath, `wallpaper.${ext}`);
    
    if (fs.existsSync(wallpaperPath)) {
      const mimeTypes = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
      // Return special marker so the caller handles binary
      return { __binary: true, path: wallpaperPath, mime: mimeTypes[ext] || 'image/png' };
    }
    return { error: 'Wallpaper not found' };
  }

  // GET /api/user/playlist — get current user's playlist
  if (url === '/api/user/playlist' && method === 'GET') {
    const session = getSessionUser(req);
    if (!session) return { error: 'Not authenticated' };
    const playlist = getUserPlaylist(session.username);
    return { playlist };
  }
  
  // PUT /api/user/playlist — save current user's playlist
  if (url === '/api/user/playlist' && method === 'PUT') {
    const session = getSessionUser(req);
    if (!session) return { error: 'Not authenticated' };
    
    const { playlist } = body;
    if (!Array.isArray(playlist)) {
      return { error: 'Playlist must be an array' };
    }
    
    // Validate and sanitize playlist items
    const sanitized = playlist.map(item => ({
      name: String(item.name || 'Unknown'),
      url: String(item.url || ''),
      type: item.type === 'video' ? 'video' : 'audio',
      duration: item.duration || null,
      addedAt: item.addedAt || new Date().toISOString()
    })).filter(item => item.url); // Remove items without URL
    
    if (saveUserPlaylist(session.username, sanitized)) {
      return { ok: true, count: sanitized.length };
    }
    return { error: 'Failed to save playlist' };
  }
  
  // POST /api/user/playlist/add — add item to playlist
  if (url === '/api/user/playlist/add' && method === 'POST') {
    const session = getSessionUser(req);
    if (!session) return { error: 'Not authenticated' };
    
    const { name, url: itemUrl, type, duration } = body;
    if (!itemUrl) return { error: 'URL required' };
    
    const playlist = getUserPlaylist(session.username);
    
    // Check if already in playlist
    if (playlist.some(item => item.url === itemUrl)) {
      return { error: 'Already in playlist', exists: true };
    }
    
    playlist.push({
      name: name || 'Unknown',
      url: itemUrl,
      type: type === 'video' ? 'video' : 'audio',
      duration: duration || null,
      addedAt: new Date().toISOString()
    });
    
    if (saveUserPlaylist(session.username, playlist)) {
      return { ok: true, count: playlist.length };
    }
    return { error: 'Failed to add to playlist' };
  }
  
  // DELETE /api/user/playlist/:index — remove item from playlist
  const playlistDelMatch = url.match(/^\/api\/user\/playlist\/(\d+)$/);
  if (playlistDelMatch && method === 'DELETE') {
    const session = getSessionUser(req);
    if (!session) return { error: 'Not authenticated' };
    
    const index = parseInt(playlistDelMatch[1]);
    const playlist = getUserPlaylist(session.username);
    
    if (index < 0 || index >= playlist.length) {
      return { error: 'Invalid index' };
    }
    
    playlist.splice(index, 1);
    
    if (saveUserPlaylist(session.username, playlist)) {
      return { ok: true, count: playlist.length };
    }
    return { error: 'Failed to remove from playlist' };
  }

  // GET /api/users — list users (admin only)
  if (url === '/api/users' && method === 'GET') {
    const session = getSessionUser(req);
    if (!session || session.role !== 'admin') return { error: 'Unauthorized' };
    const users = getUsers().map(u => ({
      username: u.username,
      role: u.role,
      description: u.description || '',
      created: u.created,
    }));
    return users;
  }

  // POST /api/users — create user (admin only)
  if (url === '/api/users' && method === 'POST') {
    const session = getSessionUser(req);
    if (!session || session.role !== 'admin') return { error: 'Unauthorized' };
    const { username, password, role, description } = body;
    if (!username || !password) return { error: 'Username and password required' };
    if (!/^[a-zA-Z][a-zA-Z0-9_]{1,31}$/.test(username.trim())) return { error: 'Invalid username: letters, numbers and underscores only (2-32 chars)' };
    const pwErr = validatePassword(password); if (pwErr) return { error: pwErr };

    const users = getUsers();
    if (users.find(u => u.username === username.toLowerCase().trim())) {
      return { error: 'User already exists' };
    }

    users.push({
      username: username.toLowerCase().trim(),
      password: hashPassword(password),
      role: role || 'user',
      description: description || '',
      created: new Date().toISOString(),
    });
    saveUsers(users);

    // Sync: create Linux user + Samba password
    ensureSmbUser(username.toLowerCase().trim(), password);

    return { ok: true, username: username.toLowerCase().trim() };
  }

  // DELETE /api/users/:username — delete user (admin only)
  const delMatch = url.match(/^\/api\/users\/([a-zA-Z0-9_.-]+)$/);
  if (delMatch && method === 'DELETE') {
    const session = getSessionUser(req);
    if (!session || session.role !== 'admin') return { error: 'Unauthorized' };
    const target = delMatch[1].toLowerCase();
    if (target === session.username) return { error: 'Cannot delete yourself' };

    let users = getUsers();
    const before = users.length;
    users = users.filter(u => u.username !== target);
    if (users.length === before) return { error: 'User not found' };

    saveUsers(users);

    // Sync: remove Linux/Samba user
    removeLinuxSmbUser(target);

    return { ok: true };
  }

  // PUT /api/users/:username — update user (admin only)
  if (delMatch && method === 'PUT') {
    const session = getSessionUser(req);
    if (!session || session.role !== 'admin') return { error: 'Unauthorized' };
    const target = delMatch[1].toLowerCase();

    const users = getUsers();
    const user = users.find(u => u.username === target);
    if (!user) return { error: 'User not found' };

    if (body.password) { const pwErr = validatePassword(body.password); if (pwErr) return { error: pwErr };
      user.password = hashPassword(body.password);
      // Sync: update Samba password
      ensureSmbUser(target, body.password);
    }
    if (body.role) user.role = body.role;
    if (body.description !== undefined) user.description = body.description;

    saveUsers(users);
    return { ok: true };
  }

  return null; // not handled
}

module.exports = { handleAuth, getSessionUser: shared.getSessionUser, getUsers, DEFAULT_PREFERENCES };
