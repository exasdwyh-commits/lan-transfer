'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');

const { randomSuffix } = require('../fsx/safepath');

const STATES = {
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  RECEIVING: 'receiving',
  VERIFYING: 'verifying',
  COMPLETE: 'complete',
  REJECTED: 'rejected',
  ERROR: 'error',
  CANCELED: 'canceled',
};

const TERMINAL = new Set([STATES.COMPLETE, STATES.REJECTED, STATES.ERROR, STATES.CANCELED]);

class SessionError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'SessionError';
    this.code = code;
    this.status = status;
  }
}

class SessionStore {
  constructor(rootDir, { events } = {}) {
    this.root = path.resolve(rootDir);
    this.sessionsDir = path.join(this.root, 'sessions');
    this.events = events;
    this.sessions = new Map();
  }

  async init() {
    await fsp.mkdir(this.sessionsDir, { recursive: true });
    const entries = await fsp.readdir(this.sessionsDir, { withFileTypes: true });
    let restored = 0;
    let discarded = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const sessionDir = path.join(this.sessionsDir, entry.name);
      try {
        const manifest = JSON.parse(await fsp.readFile(path.join(sessionDir, 'manifest.json'), 'utf8'));
        if (TERMINAL.has(manifest.state)) {
          await fsp.rm(sessionDir, { recursive: true, force: true });
          continue;
        }
        if (manifest.state === STATES.VERIFYING) manifest.state = STATES.ACCEPTED;
        const hasProgress = (await this.chunkCount(manifest.uploadId)) > 0;
        if (manifest.state === STATES.PENDING && !hasProgress) {
          await fsp.rm(sessionDir, { recursive: true, force: true });
          discarded += 1;
          continue;
        }
        if (manifest.state === STATES.PENDING && hasProgress) {
          manifest.state = STATES.ACCEPTED;
        }
        manifest.restored = true;
        this.sessions.set(manifest.uploadId, manifest);
        restored += 1;
      } catch {
        await fsp.rm(sessionDir, { recursive: true, force: true });
      }
    }
    return { restored, discarded };
  }

  async chunkCount(uploadId) {
    try {
      return (await this.receivedIndexes(uploadId)).length;
    } catch {
      return 0;
    }
  }

  dirFor(uploadId) {
    if (!/^[a-f0-9]{16,64}$/.test(uploadId)) {
      throw new SessionError('EBADID', 'invalid upload id', 400);
    }
    return path.join(this.sessionsDir, uploadId);
  }

  chunksDir(uploadId) {
    return path.join(this.dirFor(uploadId), 'chunks');
  }

  manifestPath(uploadId) {
    return path.join(this.dirFor(uploadId), 'manifest.json');
  }

  get(uploadId) {
    return this.sessions.get(uploadId) || null;
  }

require(uploadId) {
    if (!/^[a-f0-9]{16,64}$/.test(uploadId)) {
      throw new SessionError('EBADID', 'malformed upload id', 400);
    }
    const session = this.sessions.get(uploadId);
    if (!session) throw new SessionError('ENOSESSION', 'unknown transfer', 404);
    return session;
  }

  list() {
    return [...this.sessions.values()].map(publicView);
  }

  async create(spec) {
    const uploadId = crypto.randomBytes(12).toString('hex');
    const chunkSize = spec.chunkSize;
    const totalChunks = spec.totalChunks ?? Math.max(1, Math.ceil(spec.size / chunkSize));
    const manifest = {
      uploadId,
      transferId: crypto.randomBytes(8).toString('hex'),
      state: spec.acceptPolicy === 'auto' ? STATES.ACCEPTED : STATES.PENDING,
      mode: spec.mode || 'push',
      relativePath: spec.relativePath,
      displayName: spec.displayName || path.basename(spec.relativePath),
      size: spec.size,
      chunkSize,
      totalChunks,
      sha256: spec.sha256,
      mtime: spec.mtime ?? null,
      sourceName: spec.sourceName || null,
      sourceAddress: spec.sourceAddress || null,
      batchId: spec.batchId || null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      receivedBytes: 0,
      error: null,
      savedPath: null,
    };
    await fsp.mkdir(path.join(this.chunksDir(uploadId), '..'), { recursive: true });
    await this.persist(manifest);
    this.sessions.set(uploadId, manifest);
    this.emit('incoming', publicView(manifest));
    return manifest;
  }

  findResumable(spec) {
    for (const session of this.sessions.values()) {
      if (session.state === STATES.REJECTED || session.state === STATES.CANCELED) continue;
      if (session.state === STATES.COMPLETE) continue;
      if (session.relativePath !== spec.relativePath) continue;
      if (session.sha256 !== spec.sha256) continue;
      if (session.size !== spec.size) continue;
      if (session.chunkSize !== spec.chunkSize) continue;
      return session;
    }
    return null;
  }

  async persist(manifest) {
    manifest.updatedAt = Date.now();
    await fsp.mkdir(this.dirFor(manifest.uploadId), { recursive: true });
    const target = this.manifestPath(manifest.uploadId);
    const tmp = `${target}.${randomSuffix()}.tmp`;
    try {
      await fsp.writeFile(tmp, JSON.stringify(manifest, null, 2), 'utf8');
      await fsp.rename(tmp, target);
    } catch (error) {
      await fsp.rm(tmp, { force: true });
      throw error;
    }
  }

  async patch(uploadId, changes) {
    const session = this.require(uploadId);
    Object.assign(session, changes);
    await this.persist(session);
    this.emit('transfer-state', publicView(session));
    return session;
  }

  async setState(uploadId, state, extra = {}) {
    return this.patch(uploadId, { state, ...extra });
  }

  async receivedIndexes(uploadId) {
    this.require(uploadId);
    let entries;
    try {
      entries = await fsp.readdir(this.chunksDir(uploadId));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const indexes = [];
    for (const entry of entries) {
      if (!entry.endsWith('.part')) continue;
      const index = Number.parseInt(entry.slice(0, -5), 10);
      if (Number.isInteger(index)) indexes.push(index);
    }
    return indexes;
  }

  async missingChunks(uploadId) {
    const session = this.require(uploadId);
    const received = new Set(await this.receivedIndexes(uploadId));
    const missing = [];
    for (let index = 0; index < session.totalChunks; index += 1) {
      if (!received.has(index)) missing.push(index);
    }
    return missing;
  }

  chunkPath(uploadId, index) {
    const session = this.require(uploadId);
    if (!Number.isInteger(index) || index < 0 || index >= session.totalChunks) {
      throw new SessionError('EBADINDEX', 'chunk index out of range', 416);
    }
    return path.join(this.chunksDir(uploadId), `${index}.part`);
  }

  async writeChunk(uploadId, index, source) {
    const session = this.require(uploadId);
    if (TERMINAL.has(session.state)) {
      throw new SessionError('ETERMINAL', `transfer is ${session.state}`, 409);
    }
    if (session.state === STATES.PENDING) {
      throw new SessionError('EPENDING', 'transfer not accepted yet', 409);
    }
    const target = this.chunkPath(uploadId, index);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const expected = expectedChunkSize(session, index);
    const counter = { bytes: 0 };
    const guard = async function* (iterable) {
      for await (const piece of iterable) {
        counter.bytes += piece.length;
        if (counter.bytes > expected) {
          throw new SessionError('ECHUNKSIZE', 'chunk larger than declared', 400);
        }
        yield piece;
      }
    };
    try {
      await pipeline(source, guard, fs.createWriteStream(target));
    } catch (error) {
      await fsp.rm(target, { force: true });
      throw error;
    }
    if (counter.bytes !== expected) {
      await fsp.rm(target, { force: true });
      throw new SessionError(
        'ECHUNKSHORT',
        `chunk ${index} expected ${expected} bytes, got ${counter.bytes}`,
        400,
      );
    }
    session.receivedBytes = Math.min(session.size, session.receivedBytes + counter.bytes);
    if (session.state === STATES.ACCEPTED) {
      session.state = STATES.RECEIVING;
      await this.persist(session);
      this.emit('transfer-state', publicView(session));
    } else {
      await this.persist(session);
    }
    this.emit('transfer-progress', {
      uploadId,
      transferId: session.transferId,
      receivedBytes: session.receivedBytes,
      size: session.size,
      chunkIndex: index,
    });
    return counter.bytes;
  }

  async assemble(uploadId, writer, { onProgress } = {}) {
    const session = this.require(uploadId);
    const missing = await this.missingChunks(uploadId);
    if (missing.length) {
      throw new SessionError('EINCOMPLETE', `${missing.length} chunks missing`, 409);
    }
    session.state = STATES.VERIFYING;
    await this.persist(session);
    this.emit('transfer-state', publicView(session));

    const finalPath = await writer.resolveFinalPath(session.relativePath);
    const stagingFile = writer.stagingPathFor(finalPath);
    await fsp.mkdir(path.dirname(stagingFile), { recursive: true });
    const hash = crypto.createHash('sha256');
    let written = 0;
    const sink = fs.createWriteStream(stagingFile);
    let sinkFailure = null;
    sink.on('error', (error) => {
      sinkFailure = error;
    });

    try {
      for (let index = 0; index < session.totalChunks; index += 1) {
        await new Promise((resolve, reject) => {
          if (sinkFailure) {
            reject(sinkFailure);
            return;
          }
          const source = fs.createReadStream(this.chunkPath(uploadId, index));
          source.on('data', (piece) => {
            hash.update(piece);
            written += piece.length;
          });
          source.once('error', reject);
          source.once('end', resolve);
          source.pipe(sink, { end: false });
        });
        if (onProgress) onProgress(written, session.size);
      }
      await new Promise((resolve, reject) => {
        sink.once('error', reject);
        sink.end(resolve);
      });
    } catch (error) {
      sink.destroy();
      await fsp.rm(stagingFile, { force: true });
      session.state = STATES.ERROR;
      session.error = error.message;
      await this.persist(session);
      this.emit('transfer-state', publicView(session));
      throw error;
    }

    if (written !== session.size) {
      await fsp.rm(stagingFile, { force: true });
      const error = new SessionError('ESIZEMISMATCH', `assembled ${written} of ${session.size}`, 409);
      session.state = STATES.ERROR;
      session.error = error.message;
      await this.persist(session);
      this.emit('transfer-state', publicView(session));
      throw error;
    }

    const digest = hash.digest('hex');
    if (session.sha256 && digest.toLowerCase() !== session.sha256.toLowerCase()) {
      await fsp.rm(stagingFile, { force: true });
      const error = new SessionError('EHASHMISMATCH', 'sha256 mismatch, file discarded', 422);
      session.state = STATES.ERROR;
      session.error = error.message;
      await this.persist(session);
      this.emit('transfer-state', publicView(session));
      throw error;
    }

    await writer.commit(stagingFile, finalPath);
    session.state = STATES.COMPLETE;
    session.savedPath = finalPath;
    session.sha256 = digest;
    session.receivedBytes = written;
    await this.persist(session);
    await fsp.rm(this.dirFor(uploadId), { recursive: true, force: true });
    this.sessions.delete(uploadId);
    this.emit('transfer-complete', publicView(session));
    return session;
  }

  async reject(uploadId, reason) {
    const session = this.require(uploadId);
    session.state = STATES.REJECTED;
    session.error = reason || 'rejected by receiver';
    await this.persist(session);
    await fsp.rm(this.dirFor(uploadId), { recursive: true, force: true });
    this.sessions.delete(uploadId);
    this.emit('transfer-rejected', publicView(session));
    return session;
  }

  async cancel(uploadId, reason) {
    const session = this.require(uploadId);
    session.state = STATES.CANCELED;
    session.error = reason || 'canceled';
    await this.persist(session);
    await fsp.rm(this.dirFor(uploadId), { recursive: true, force: true });
    this.sessions.delete(uploadId);
    this.emit('transfer-canceled', publicView(session));
    return session;
  }

  async sweepIdle(maxAgeMs) {
    const now = Date.now();
    const removed = [];
    for (const session of [...this.sessions.values()]) {
      if (TERMINAL.has(session.state)) continue;
      if (now - session.updatedAt > maxAgeMs) {
        await fsp.rm(this.dirFor(session.uploadId), { recursive: true, force: true });
        this.sessions.delete(session.uploadId);
        removed.push(session.uploadId);
      }
    }
    return removed;
  }

  emit(event, payload) {
    if (this.events && typeof this.events === 'function') this.events(event, payload);
  }
}

function expectedChunkSize(session, index) {
  if (index < session.totalChunks - 1) return session.chunkSize;
  return session.size - session.chunkSize * (session.totalChunks - 1);
}

function publicView(session) {
  return {
    uploadId: session.uploadId,
    transferId: session.transferId,
    state: session.state,
    mode: session.mode,
    relativePath: session.relativePath,
    displayName: session.displayName,
    size: session.size,
    chunkSize: session.chunkSize,
    totalChunks: session.totalChunks,
    sha256: session.sha256,
    mtime: session.mtime,
    sourceName: session.sourceName,
    sourceAddress: session.sourceAddress,
    batchId: session.batchId,
    receivedBytes: session.receivedBytes,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    error: session.error,
    savedPath: session.savedPath,
    restored: Boolean(session.restored),
  };
}

module.exports = { SessionError, SessionStore, STATES, publicView };