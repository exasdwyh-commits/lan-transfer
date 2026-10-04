'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { sanitizeSegment } = require('./fsx/safepath');

const DEFAULT_PORT = 47831;
const APP_DIR_NAME = 'lan-transfer';

function stateHome() {
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(base, APP_DIR_NAME);
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', APP_DIR_NAME);
  }
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(base, APP_DIR_NAME);
}

function defaultDownloadDir() {
  return path.join(os.homedir(), 'Downloads', 'LANTransfer');
}

function defaultDeviceName() {
  const raw = os.hostname() || 'device';
  return sanitizeSegment(raw.replace(/\.(local|lan)$/i, '')) || 'device';
}

const DEFAULTS = {
  port: DEFAULT_PORT,
  deviceName: defaultDeviceName(),
  downloadDir: defaultDownloadDir(),
  acceptPolicy: 'ask',
  chunkSizeBytes: 4 * 1024 * 1024,
  conflictPolicy: 'rename',
  maxConcurrentTransfers: 2,
  discovery: 'both',
  allowOverwrite: false,
};

const MUTABLE_KEYS = new Set([
  'deviceName',
  'downloadDir',
  'acceptPolicy',
  'chunkSizeBytes',
  'conflictPolicy',
  'maxConcurrentTransfers',
  'discovery',
  'allowOverwrite',
]);

class Config {
  constructor(data, { dir } = {}) {
    this.data = data;
    this.dir = dir || stateHome();
    this.configPath = path.join(this.dir, 'config.json');
  }

  static load({ dir, overrides = {} } = {}) {
    const resolvedDir = dir || stateHome();
    let stored = {};
    try {
      stored = JSON.parse(fs.readFileSync(path.join(resolvedDir, 'config.json'), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        process.emitWarning(`config.json unreadable, using defaults: ${error.message}`);
      }
      stored = {};
    }
    return new Config({ ...DEFAULTS, ...stored, ...overrides }, { dir: resolvedDir });
  }

  get(key) {
    return this.data[key];
  }

  get stateDir() {
    return this.dir;
  }

  all() {
    return { ...this.data };
  }

  deviceId() {
    return this.data.deviceId || createDeviceId(this.data.deviceName);
  }

  update(patch) {
    for (const [key, value] of Object.entries(patch || {})) {
      if (!MUTABLE_KEYS.has(key)) continue;
      this.data[key] = coerce(key, value, this.data[key]);
    }
    return this.all();
  }

  save() {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.configPath}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, this.configPath);
    return this.configPath;
  }
}

function createDeviceId(seed) {
  const machine = `${os.hostname()}|${os.platform()}|${os.arch()}`;
  return crypto.createHash('sha256').update(`${machine}|${seed || ''}`).digest('hex').slice(0, 16);
}

function coerce(key, value, fallback) {
  if (key === 'acceptPolicy') return value === 'auto' ? 'auto' : 'ask';
  if (key === 'conflictPolicy') return value === 'overwrite' ? 'overwrite' : 'rename';
  if (key === 'discovery') return ['mdns', 'beacon', 'both', 'off'].includes(value) ? value : 'both';
  if (key === 'allowOverwrite') return Boolean(value);
  if (key === 'deviceName') {
    const cleaned = sanitizeSegment(String(value || '').trim());
    return cleaned || fallback;
  }
  if (key === 'downloadDir') {
    const trimmed = String(value || '').trim();
    return trimmed ? path.resolve(trimmed) : fallback;
  }
  if (key === 'chunkSizeBytes') {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(64 * 1024 * 1024, Math.max(256 * 1024, Math.round(parsed / 1024) * 1024));
  }
  if (key === 'maxConcurrentTransfers') {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(8, Math.max(1, Math.round(parsed)));
  }
  return value;
}

module.exports = { AppConfig: Config, DEFAULTS, DEFAULT_PORT, defaultDeviceName, stateHome };