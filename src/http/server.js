'use strict';

const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs/promises');

const { CORS_HEADERS, readJson, sendError, sendJson } = require('./helpers');
const { serveStatic } = require('./static');
const { EventHub } = require('../events');
const transfer = require('./routes-transfer');
const { SafeWriter, ensureDirectory } = require('../fsx/writer');
const { SessionStore } = require('../transfer/sessions');
const { ShareRegistry } = require('../transfer/shares');
const { Discovery, interfaceAddresses } = require('../discovery/discovery');
const { PathRejectedError } = require('../fsx/safepath');

const PUBLIC_DIR = path.resolve(__dirname, '..', '..', 'public');
const SHARE_SOURCE_ROOTS = new Set(['Desktop', 'Documents', 'Downloads', 'Pictures', 'Music', 'Movies', 'home']);

function localAddresses() {
  return interfaceAddresses().map((iface) => iface.address);
}

function banner(ctx, req) {
  const addresses = localAddresses();
  const primary = addresses[0];
  return {
    deviceId: ctx.config.deviceId(),
    deviceName: ctx.config.get('deviceName'),
    version: '1.0.0',
    platform: process.platform,
    port: ctx.port,
    addresses,
    primaryAddress: primary || '127.0.0.1',
    downloadDir: ctx.config.get('downloadDir'),
    acceptPolicy: ctx.config.get('acceptPolicy'),
    chunkSizeBytes: ctx.config.get('chunkSizeBytes'),
    discovery: ctx.discovery ? ctx.discovery.mode : 'off',
    mdnsHealthy: ctx.discovery ? ctx.discovery.mdnsHealthy : false,
    localUrl: `http://127.0.0.1:${ctx.port}`,
    openUrls: addresses.map((address) => `http://${address}:${ctx.port}`),
    uptimeSeconds: Math.round(process.uptime()),
  };
}

function createContext({ config }) {
  const events = new EventHub();
  const sessions = new SessionStore(path.join(config.stateDir, 'transfers'), {
    events: (name, payload) => events.broadcast(name, payload),
  });
  const shares = new ShareRegistry();
  let writer = null;
  let writerRoot = null;

  const ctx = {
    config,
    events,
    sessions,
    shares,
    port: config.get('port'),
    discovery: null,
    refreshWriter() {
      return this.writerFor();
    },
    writerFor() {
      const root = config.get('downloadDir');
      if (!writer || writerRoot !== root) {
        writer = new SafeWriter(root, {
          overwrite: config.get('conflictPolicy') === 'overwrite' ? 'overwrite' : 'rename',
        });
        writerRoot = root;
      }
      return writer;
    },
    resolveSourceRoot(requested) {
      if (!requested) {
        throw Object.assign(new Error('sourceRoot required'), { status: 400, code: 'EFIELD' });
      }
      const resolved = path.resolve(requested);
      const home = path.resolve(os.homedir());
      if (resolved !== home && !resolved.startsWith(home + path.sep)) {
        throw Object.assign(new Error('sourceRoot must live under the home directory'), {
          status: 403,
          code: 'EROOT',
        });
      }
      const tail = path.relative(home, resolved).split(path.sep)[0];
      if (resolved !== home && !SHARE_SOURCE_ROOTS.has(tail)) {
        throw Object.assign(
          new Error(`only these source roots may be shared: ${[...SHARE_SOURCE_ROOTS].join(', ')}`),
          { status: 403, code: 'EROOT' },
        );
      }
      return resolved;
    },
  };
  return ctx;
}

function notFound(req, res) {
  sendError(res, 404, 'ENOTFOUND', `no route for ${req.method} ${req.url}`);
}

async function handle(ctx, req, res) {
  const url = new URL(req.url, 'http://placeholder');
  const route = url.pathname;
  req.query = url.searchParams;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  if (route === '/api/events' && req.method === 'GET') {
    ctx.events.handleEventStream(req, res);
    return;
  }
  if (route === '/api/info' && req.method === 'GET') {
    sendJson(res, 200, banner(ctx, req));
    return;
  }
  if (route === '/api/devices' && req.method === 'GET') {
    sendJson(res, 200, {
      devices: ctx.discovery ? ctx.discovery.list() : [],
      mode: ctx.discovery ? ctx.discovery.mode : 'off',
      mdnsHealthy: ctx.discovery ? ctx.discovery.mdnsHealthy : false,
      log: ctx.discovery ? ctx.discovery.log.slice(-8) : [],
    });
    return;
  }
  if (route === '/api/config' && req.method === 'GET') {
    sendJson(res, 200, ctx.config.all());
    return;
  }
  if (route === '/api/config' && req.method === 'PUT') {
    const patch = await readJson(req);
    const next = ctx.config.update(patch);
    ctx.refreshWriter();
    if (next.deviceName && ctx.discovery) {
      ctx.discovery.deviceName = next.deviceName;
      ctx.discovery.instanceName = `${next.deviceName}-${ctx.config.deviceId().slice(0, 6)}._lantransfer._tcp.local`;
    }
    await fsp.mkdir(next.downloadDir, { recursive: true }).catch(() => {});
    sendJson(res, 200, next);
    return;
  }
  if (route === '/api/inbox/offer' && req.method === 'POST') {
    await transfer.offerInbox(ctx, req, res);
    return;
  }
  if (route === '/api/upload/status' && req.method === 'GET') {
    await transfer.uploadStatus(ctx, req, res);
    return;
  }
  if (route === '/api/upload/chunk' && (req.method === 'PUT' || req.method === 'GET')) {
    await transfer.uploadChunk(ctx, req, res);
    return;
  }
  if (route === '/api/upload/complete' && req.method === 'POST') {
    await transfer.uploadComplete(ctx, req, res);
    return;
  }
  if (route === '/api/upload/accept' && req.method === 'POST') {
    await transfer.uploadAccept(ctx, req, res);
    return;
  }
  if (route === '/api/upload/reject' && req.method === 'POST') {
    await transfer.uploadReject(ctx, req, res);
    return;
  }
  if (route === '/api/upload/cancel' && req.method === 'POST') {
    await transfer.uploadCancel(ctx, req, res);
    return;
  }
  if (route === '/api/transfers' && req.method === 'GET') {
    await transfer.listTransfers(ctx, req, res);
    return;
  }
  if (route === '/api/share' && req.method === 'POST') {
    await transfer.createShare(ctx, req, res);
    return;
  }
  if (route === '/api/share' && req.method === 'GET') {
    await transfer.listShares(ctx, req, res);
    return;
  }
  const shareDrop = /^\/api\/share\/([a-f0-9]{8,64})$/.exec(route);
  if (shareDrop && req.method === 'DELETE') {
    await transfer.dropShare(ctx, req, res, shareDrop[1]);
    return;
  }
  const pullManifest = /^\/api\/pull\/([a-f0-9]{16,64})$/.exec(route);
  if (pullManifest && req.method === 'GET') {
    await transfer.shareManifest(ctx, req, res, pullManifest[1]);
    return;
  }
  const pullChunk = /^\/api\/pull\/([a-f0-9]{16,64})\/chunk$/.exec(route);
  if (pullChunk && req.method === 'GET') {
    await transfer.shareChunk(ctx, req, res, pullChunk[1]);
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    const target = route === '/' ? '/index.html' : route;
    if (await serveStatic(res, PUBLIC_DIR, target)) return;
    if (route === '/' && await serveStatic(res, PUBLIC_DIR, '/index.html')) return;
    notFound(req, res);
    return;
  }

  notFound(req, res);
}

async function start({ config, port, host = '0.0.0.0', discovery = true } = {}) {
  const ctx = createContext({ config });
  await ensureDirectory(config.get('downloadDir'));
  await ctx.sessions.init();

  const server = http.createServer((req, res) => {
    handle(ctx, req, res).catch((error) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const status = error.status || (error.code === 'ENOSESSION' ? 404 : 500);
      const code = error.code || 'EINTERNAL';
      if (status >= 500) {
        process.emitWarning(`request failed ${req.method} ${req.url}: ${error.stack || error.message}`);
      }
      if (error instanceof PathRejectedError) {
        sendError(res, 400, 'EPATH', error.message);
        return;
      }
      sendError(res, status, code, error.message || 'internal error');
    });
  });

  server.keepAliveTimeout = 65000;
  server.headersTimeout = 70000;
  server.requestTimeout = 15 * 60 * 1000;

  const listenPort = port ?? config.get('port');
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  ctx.port = server.address().port;
  config.data.port = ctx.port;

  if (discovery) {
    ctx.discovery = new Discovery({
      deviceId: config.deviceId(),
      deviceName: config.get('deviceName'),
      port: ctx.port,
      mode: config.get('discovery'),
      onChange: () => ctx.events.broadcast('devices', { at: Date.now() }),
    });
    await ctx.discovery.start();
  }

  const sweeper = setInterval(() => {
    ctx.sessions.sweepIdle(24 * 60 * 60 * 1000).catch(() => {});
    ctx.shares.sweep();
  }, 10 * 60 * 1000);
  sweeper.unref?.();

  const sockets = new Set();
  const openStreams = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('request', (req, res) => {
    openStreams.add(res);
    res.on('close', () => openStreams.delete(res));
  });

  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    clearInterval(sweeper);
    ctx.events.closeAll();
    if (ctx.discovery) await ctx.discovery.close();
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeIdleConnections?.();
      for (const res of openStreams) res.destroy();
      server.closeAllConnections?.();
      for (const socket of sockets) socket.destroy();
    });
  }

  return { ctx, server, close, port: ctx.port };
}

module.exports = { PUBLIC_DIR, createContext, localAddresses, start };
