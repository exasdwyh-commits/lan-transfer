'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SHARE_TTL_MS = 6 * 60 * 60 * 1000;

class ShareError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'ShareError';
    this.code = code;
    this.status = status;
  }
}

class ShareRegistry {
  constructor({ ttlMs = SHARE_TTL_MS } = {}) {
    this.ttlMs = ttlMs;
    this.byToken = new Map();
    this.byGroup = new Map();
  }

  createGroup(files, { sourceRoot }) {
    const groupId = crypto.randomBytes(10).toString('hex');
    const createdAt = Date.now();
    const entries = [];
    for (const file of files) {
      const token = crypto.randomBytes(16).toString('hex');
      const entry = {
        token,
        groupId,
        relativePath: file.relativePath,
        absolutePath: path.resolve(sourceRoot, file.relativePath),
        size: file.size,
        sha256: file.sha256,
        chunkSize: file.chunkSize,
        totalChunks: Math.max(1, Math.ceil(file.size / file.chunkSize)),
        mtime: file.mtime ?? null,
        createdAt,
        lastReadAt: createdAt,
      };
      this.byToken.set(token, entry);
      entries.push(entry);
    }
    this.byGroup.set(groupId, entries);
    return { groupId, entries };
  }

  get(token) {
    const entry = this.byToken.get(token);
    if (!entry) throw new ShareError('ENOSHARE', 'unknown share token', 404);
    if (Date.now() - entry.createdAt > this.ttlMs) {
      this.removeGroup(entry.groupId);
      throw new ShareError('ESHAREEXPIRED', 'share expired', 410);
    }
    return entry;
  }

  getGroup(groupId) {
    return this.byGroup.get(groupId) || [];
  }

  stats(entry) {
    try {
      const stat = fs.statSync(entry.absolutePath);
      return { size: stat.size, mtimeMs: stat.mtimeMs, missing: false };
    } catch (error) {
      return { size: entry.size, mtimeMs: entry.mtime, missing: error.code === 'ENOENT' };
    }
  }

  readChunk(entry, index) {
    if (!Number.isInteger(index) || index < 0 || index >= entry.totalChunks) {
      throw new ShareError('EBADINDEX', 'chunk index out of range', 416);
    }
    const offset = index * entry.chunkSize;
    const expected = index < entry.totalChunks - 1
      ? entry.chunkSize
      : entry.size - entry.chunkSize * (entry.totalChunks - 1);
    if (expected <= 0) throw new ShareError('EBADRANGE', 'empty final chunk', 416);
    entry.lastReadAt = Date.now();
    return {
      stream: fs.createReadStream(entry.absolutePath, { start: offset, end: offset + expected - 1 }),
      length: expected,
    };
  }

  removeGroup(groupId) {
    const entries = this.byGroup.get(groupId);
    if (!entries) return 0;
    for (const entry of entries) this.byToken.delete(entry.token);
    this.byGroup.delete(groupId);
    return entries.length;
  }

  sweep() {
    const now = Date.now();
    let removed = 0;
    for (const [groupId, entries] of [...this.byGroup]) {
      const newest = entries.reduce((max, entry) => Math.max(max, entry.lastReadAt), 0);
      if (now - newest > this.ttlMs) removed += this.removeGroup(groupId);
    }
    return removed;
  }

  list() {
    return [...this.byGroup.entries()].map(([groupId, entries]) => ({
      groupId,
      fileCount: entries.length,
      totalBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
      oldest: Math.min(...entries.map((entry) => entry.createdAt)),
    }));
  }
}

module.exports = { ShareError, ShareRegistry, SHARE_TTL_MS };
