'use strict';

const {
  clientAddress,
  httpError,
  readJson,
  requireFields,
  requireHash,
  requireInteger,
  sendError,
  sendJson,
} = require('./helpers');
const { PathRejectedError, sanitizeRelativePath } = require('../fsx/safepath');

async function offerInbox(ctx, req, res) {
  const payload = await readJson(req);
  requireFields(payload, ['files']);
  if (!Array.isArray(payload.files) || payload.files.length === 0) {
    throw httpError(400, 'EFIELD', 'files must be a non-empty array');
  }
  if (payload.files.length > 5000) {
    throw httpError(413, 'ETOOMANY', 'too many files in one offer');
  }

  const batchId = String(payload.batchId || '') || randomBatchId();
  const sourceName = String(payload.sourceName || '').slice(0, 120) || 'unknown device';
  const sourceAddress = clientAddress(req);
  const autoAccept = ctx.config.get('acceptPolicy') === 'auto';
  const results = [];

  for (const raw of payload.files) {
    if (typeof raw?.relativePath !== 'string' || raw.relativePath.trim() === '') {
      throw httpError(400, 'EFIELD', 'each file needs a relativePath string');
    }
    let relativePath;
    try {
      relativePath = sanitizeRelativePath(raw.relativePath);
    } catch (error) {
      if (error instanceof PathRejectedError) {
        results.push({ relativePath: raw.relativePath.slice(0, 200), status: 'rejected-path' });
        continue;
      }
      throw error;
    }

    const size = requireInteger(raw, 'size', { min: 0, max: Number.MAX_SAFE_INTEGER });
    const sha256 = requireHash(raw, 'sha256');
    const chunkSize = requireInteger(raw, 'chunkSize', { min: 262144, max: 67108864 });
    const totalChunks = Math.max(1, Math.ceil(size / chunkSize));

    const existing = ctx.sessions.findResumable({
      relativePath,
      sha256,
      size,
      chunkSize,
    });
    if (existing) {
      existing.sourceName = sourceName;
      existing.sourceAddress = sourceAddress;
      await ctx.sessions.persist(existing);
      results.push({
        relativePath,
        status: 'reuse',
        uploadId: existing.uploadId,
        state: existing.state,
        chunkSize,
        totalChunks,
        missingChunks: await ctx.sessions.missingChunks(existing.uploadId),
      });
      continue;
    }

    const session = await ctx.sessions.create({
      relativePath,
      displayName: relativePath.split('/').pop(),
      size,
      chunkSize,
      totalChunks,
      sha256,
      mtime: raw.mtime ?? null,
      mode: payload.mode === 'pull' ? 'pull' : 'push',
      sourceName,
      sourceAddress,
      batchId,
      acceptPolicy: autoAccept ? 'auto' : 'ask',
    });

    results.push({
      relativePath,
      status: session.state,
      uploadId: session.uploadId,
      state: session.state,
      chunkSize,
      totalChunks,
      missingChunks: [],
    });
  }

  sendJson(res, 200, { batchId, results });
}

function randomBatchId() {
  return `b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function uploadStatus(ctx, req, res) {
  const uploadId = String(req.query.get('uploadId') || '');
  const session = ctx.sessions.require(uploadId);
  const missing = await ctx.sessions.missingChunks(uploadId);
  sendJson(res, 200, {
    uploadId: session.uploadId,
    state: session.state,
    chunkSize: session.chunkSize,
    totalChunks: session.totalChunks,
    size: session.size,
    receivedBytes: session.receivedBytes,
    missingChunks: missing.length > 400 ? missing.slice(0, 400) : missing,
    missingCount: missing.length,
    savedPath: session.savedPath,
    error: session.error,
  });
}

async function uploadChunk(ctx, req, res) {
  if (req.method === 'GET') return sendError(res, 405, 'EMETHOD', 'PUT required');
  const uploadId = String(req.query.get('uploadId') || '');
  const index = Number.parseInt(String(req.query.get('index') || ''), 10);
  if (!Number.isInteger(index)) throw httpError(400, 'EFIELD', 'index must be an integer');
  const bytes = await ctx.sessions.writeChunk(uploadId, index, req);
  sendJson(res, 200, { ok: true, index, bytes });
}

async function uploadComplete(ctx, req, res) {
  const uploadId = String(req.query.get('uploadId') || '');
  const session = await ctx.sessions.assemble(uploadId, ctx.writerFor());
  sendJson(res, 200, {
    ok: true,
    uploadId: session.uploadId,
    savedPath: session.savedPath,
    relativePath: session.relativePath,
    size: session.size,
    sha256: session.sha256,
  });
}

async function uploadReject(ctx, req, res) {
  const uploadId = String(req.query.get('uploadId') || '');
  const reason = String(req.query.get('reason') || 'rejected by receiver').slice(0, 200);
  const session = await ctx.sessions.reject(uploadId, reason);
  sendJson(res, 200, { ok: true, uploadId: session.uploadId, state: session.state });
}

async function uploadCancel(ctx, req, res) {
  const uploadId = String(req.query.get('uploadId') || '');
  const session = await ctx.sessions.cancel(uploadId, 'canceled by sender');
  sendJson(res, 200, { ok: true, uploadId: session.uploadId, state: session.state });
}

async function uploadAccept(ctx, req, res) {
  const uploadId = String(req.query.get('uploadId') || '');
  const session = ctx.sessions.require(uploadId);
  if (session.state !== 'pending') {
    sendJson(res, 200, { ok: true, uploadId, state: session.state, unchanged: true });
    return;
  }
  await ctx.sessions.setState(uploadId, 'accepted');
  sendJson(res, 200, { ok: true, uploadId, state: 'accepted' });
}

async function listTransfers(ctx, req, res) {
  sendJson(res, 200, { transfers: ctx.sessions.list() });
}

async function createShare(ctx, req, res) {
  const payload = await readJson(req);
  requireFields(payload, ['files']);
  if (!Array.isArray(payload.files) || payload.files.length === 0) {
    throw httpError(400, 'EFIELD', 'files must be a non-empty array');
  }
  const sourceRoot = ctx.resolveSourceRoot(String(payload.sourceRoot || ''));
  const normalized = [];
  for (const raw of payload.files) {
    const relativePath = sanitizeRelativePath(String(raw.relativePath || ''));
    const size = requireInteger(raw, 'size', { min: 0 });
    const sha256 = requireHash(raw, 'sha256');
    const chunkSize = requireInteger(raw, 'chunkSize', { min: 262144, max: 67108864 });
    normalized.push({ relativePath, size, sha256, chunkSize, mtime: raw.mtime ?? null });
  }
  const group = ctx.shares.createGroup(normalized, { sourceRoot });
  sendJson(res, 200, {
    groupId: group.groupId,
    sourceRoot,
    files: group.entries.map((entry) => ({
      token: entry.token,
      relativePath: entry.relativePath,
      size: entry.size,
      chunkSize: entry.chunkSize,
      totalChunks: entry.totalChunks,
      sha256: entry.sha256,
    })),
  });
}

async function shareManifest(ctx, req, res, token) {
  const entry = ctx.shares.get(token);
  const stats = ctx.shares.stats(entry);
  sendJson(res, 200, {
    token: entry.token,
    relativePath: entry.relativePath,
    size: entry.size,
    sha256: entry.sha256,
    chunkSize: entry.chunkSize,
    totalChunks: entry.totalChunks,
    presentOnDisk: !stats.missing,
  });
}

async function shareChunk(ctx, req, res, token) {
  const entry = ctx.shares.get(token);
  const index = Number.parseInt(String(req.query.get('index') || ''), 10);
  const { stream, length } = ctx.shares.readChunk(entry, index);
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': length,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  stream.once('error', () => res.destroy());
  stream.pipe(res);
}

async function listShares(ctx, req, res) {
  sendJson(res, 200, { shares: ctx.shares.list() });
}

async function dropShare(ctx, req, res, groupId) {
  const removed = ctx.shares.removeGroup(groupId);
  sendJson(res, 200, { ok: true, removed });
}

module.exports = {
  createShare,
  dropShare,
  listShares,
  listTransfers,
  offerInbox,
  shareChunk,
  shareManifest,
  uploadAccept,
  uploadCancel,
  uploadChunk,
  uploadComplete,
  uploadReject,
  uploadStatus,
};
