/**
 * NimbusOS — Shared constants, sessions, and helpers
 */
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const path = require('path');

const PORT = parseInt(process.env.NIMBUS_PORT || '5000');
const NIMBUS_ROOT = process.env.NIMBUS_ROOT || '/var/lib/nimbusos';
const CONFIG_DIR = path.join(NIMBUS_ROOT, 'config');
const USER_DATA_DIR = path.join(NIMBUS_ROOT, 'userdata');
const USERS_FILE = path.join(CONFIG_DIR, 'users.json');
const SHARES_FILE = path.join(CONFIG_DIR, 'shares.json');
const DOCKER_FILE = path.join(CONFIG_DIR, 'docker.json');
const NATIVE_APPS_FILE = path.join(CONFIG_DIR, 'native-apps.json');
const SESSIONS_FILE = path.join(CONFIG_DIR, 'sessions.json');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json',
};

const SESSION_EXPIRY_MS = 24 * 60 * 60 * 1000;

// ── Sessions (in-memory + disk persistence) ──
let SESSIONS = {};

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// Load sessions from disk
try {
  if (fs.existsSync(SESSIONS_FILE)) {
    SESSIONS = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    const now = Date.now();
    Object.keys(SESSIONS).forEach(token => {
      if (now - SESSIONS[token].created > SESSION_EXPIRY_MS) delete SESSIONS[token];
    });
  }
} catch { SESSIONS = {}; }

function saveSessions() {
  try { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(SESSIONS, null, 2)); } catch {}
}

// Clean expired sessions periodically
setInterval(() => {
  const now = Date.now();
  Object.keys(SESSIONS).forEach(token => {
    if (now - SESSIONS[token].created > SESSION_EXPIRY_MS) delete SESSIONS[token];
  });
}, 60 * 60 * 1000);

function getSessionUser(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.replace('Bearer ', '');
  const session = SESSIONS[hashToken(token)];
  if (session && (Date.now() - session.created < SESSION_EXPIRY_MS)) return session;
  if (session) delete SESSIONS[hashToken(token)];
  return null;
}

// ── Shell helpers ──
function run(cmd) {
  try { return execSync(cmd, { timeout: 5000, encoding: 'utf-8' }).trim(); }
  catch { return null; }
}

function readFile(p) {
  try { return fs.readFileSync(p, 'utf-8').trim(); }
  catch { return null; }
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + sizes[i];
}

// ── Config directory setup ──
function ensureConfig() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  if (!fs.existsSync(USER_DATA_DIR)) fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]');
  if (!fs.existsSync(SHARES_FILE)) fs.writeFileSync(SHARES_FILE, '[]');
  if (!fs.existsSync(DOCKER_FILE)) {
    fs.writeFileSync(DOCKER_FILE, JSON.stringify({
      installed: false, path: null, permissions: [], appPermissions: {},
      installedAt: null, containers: []
    }, null, 2));
  }
  const APPS_FILE = path.join(CONFIG_DIR, 'installed-apps.json');
  if (!fs.existsSync(APPS_FILE)) fs.writeFileSync(APPS_FILE, '[]');
}
ensureConfig();

// ── Docker name sanitization ──
function sanitizeDockerName(name) {
  if (!name || typeof name !== 'string') return null;
  const sanitized = name.replace(/[^a-zA-Z0-9_.\-\/:]/g, '');
  if (sanitized.length === 0 || sanitized.length > 256) return null;
  if (sanitized.includes('..')) return null;
  return sanitized;
}

function isValidPort(port) {
  const num = parseInt(port);
  return !isNaN(num) && num >= 1 && num <= 65535;
}

module.exports = {
  PORT, NIMBUS_ROOT, CONFIG_DIR, USER_DATA_DIR, USERS_FILE, SHARES_FILE,
  DOCKER_FILE, NATIVE_APPS_FILE, SESSIONS_FILE, CORS_HEADERS, SESSION_EXPIRY_MS,
  SESSIONS, hashToken, saveSessions, getSessionUser,
  run, readFile, formatBytes, ensureConfig,
  sanitizeDockerName, isValidPort,
};
