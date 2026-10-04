import * as api from './api.js';
import { hashFile } from './files.js';

const CHUNK_CONCURRENCY = 3;
const POLL_INTERVAL_MS = 700;
const ACCEPT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_POLL_FAILURES = 40;

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('canceled', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new DOMException('canceled', 'AbortError'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function pollUntilAccepted(uploadId, origin, signal, onTick) {
  const deadline = Date.now() + ACCEPT_TIMEOUT_MS;
  let failures = 0;
  for (;;) {
    if (signal?.aborted) throw new DOMException('canceled', 'AbortError');
    let status;
    try {
      status = await api.pollStatus(uploadId, origin);
      failures = 0;
    } catch (error) {
      failures += 1;
      if (error.code === 'ENOSESSION' || error.status === 404) throw error;
      if (failures > MAX_POLL_FAILURES) throw error;
      await sleep(POLL_INTERVAL_MS * 2, signal);
      continue;
    }
    onTick?.(status);
    if (status.state === 'accepted' || status.state === 'receiving' || status.state === 'verifying') {
      return status;
    }
    if (status.state === 'rejected') {
      throw Object.assign(new Error('receiver rejected the transfer'), { code: 'EREJECTED' });
    }
    if (status.state === 'error') {
      throw Object.assign(new Error(status.error || 'receiver reported an error'), { code: 'ERECEIVER' });
    }
    if (status.state === 'complete') {
      throw Object.assign(new Error('transfer already completed elsewhere'), { code: 'EDONE' });
    }
    if (Date.now() > deadline) {
      throw Object.assign(new Error('timed out waiting for receiver approval'), { code: 'ETIMEOUT' });
    }
    await sleep(POLL_INTERVAL_MS, signal);
  }
}

async function pushChunks(uploadId, origin, file, { chunkSize, missingChunks }, signal, onProgress) {
  const queue = [...missingChunks];
  const done = new Map();
  let settledBytes = 0;
  const announce = (index, bytes) => {
    done.set(index, bytes);
    settledBytes += bytes;
    onProgress?.(settledBytes, file.size);
  };

  const worker = async () => {
    for (;;) {
      const index = queue.shift();
      if (index === undefined) return;
      if (signal?.aborted) throw new DOMException('canceled', 'AbortError');
      const start = index * chunkSize;
      const blob = file.slice(start, Math.min(file.size, start + chunkSize));
      await api.putChunk(uploadId, index, blob, {
        signal,
        origin,
        onProgress: (loaded) => {
          const previous = done.get(index) || 0;
          if (loaded > previous) {
            done.set(index, loaded);
            settledBytes += loaded - previous;
            onProgress?.(settledBytes, file.size);
          }
        },
      });
      announce(index, blob.size);
    }
  };

  const workers = Array.from({ length: Math.min(CHUNK_CONCURRENCY, Math.max(1, queue.length)) }, worker);
  await Promise.all(workers);
}

async function pullChunks(uploadId, origin, file, plan, source, signal, onProgress) {
  const { chunkSize, missingChunks } = plan;
  const queue = [...missingChunks];
  let settledBytes = 0;
  const worker = async () => {
    for (;;) {
      const index = queue.shift();
      if (index === undefined) return;
      if (signal?.aborted) throw new DOMException('canceled', 'AbortError');
      let host = source.host;
      let lastError = null;
      for (const candidate of source.hosts || [host]) {
        try {
          const res = await api.fetchShareChunk(candidate, source.port, source.token, index, { signal });
          const blob = await res.blob();
          await api.putChunk(uploadId, index, blob, { signal, origin });
          settledBytes += blob.size;
          onProgress?.(settledBytes, file.size);
          lastError = null;
          break;
        } catch (error) {
          if (error.code === 'ECANCELED') throw error;
          lastError = error;
          host = candidate;
        }
      }
      if (lastError) throw lastError;
    }
  };
  const workers = Array.from({ length: Math.min(CHUNK_CONCURRENCY, Math.max(1, queue.length)) }, worker);
  await Promise.all(workers);
}

export class SendJob {
  constructor({ items, device, origin, chunkSize, sourceRoot, selfHost, selfPort, onUpdate }) {
    this.items = items;
    this.device = device;
    this.origin = origin;
    this.chunkSize = chunkSize;
    this.sourceRoot = sourceRoot;
    this.selfHost = selfHost;
    this.selfPort = selfPort;
    this.onUpdate = onUpdate || (() => {});
    this.controller = new AbortController();
    this.entries = items.map((item) => ({
      relativePath: item.relativePath,
      file: item.file,
      sha256: null,
      uploadId: null,
      totalChunks: Math.max(1, Math.ceil(item.file.size / chunkSize)),
      state: 'queued',
      sentBytes: 0,
      error: null,
      token: null,
    }));
  }

  cancel() {
    this.controller.abort();
  }

  async run() {
    const { signal } = this.controller;
    try {
      for (const entry of this.entries) {
        entry.state = 'hashing';
        this.onUpdate();
        entry.sha256 = await hashFile(entry.file, (loaded, total) => {
          entry.sentBytes = 0;
          entry.hashBytes = loaded;
          entry.hashTotal = total;
          this.onUpdate();
        });
        delete entry.hashBytes;
      }

      this.onUpdate({ phase: 'registering' });

      let shareTokens = new Map();
      try {
        const share = await api.registerShare(
          this.entries.map((entry) => ({
            relativePath: entry.relativePath,
            size: entry.file.size,
            sha256: entry.sha256,
            chunkSize: this.chunkSize,
            mtime: entry.file.lastModified,
          })),
          this.sourceRoot,
        );
        shareTokens = new Map(share.files.map((file) => [file.relativePath, file.token]));
      } catch (error) {
        this.onUpdate({ warning: `本地分享注册失败(不影响推送传输): ${error.message}` });
      }

      const files = this.entries.map((entry) => ({
        relativePath: entry.relativePath,
        size: entry.file.size,
        sha256: entry.sha256,
        chunkSize: this.chunkSize,
        mtime: entry.file.lastModified,
      }));

      const offer = await api.offerInbox(this.origin, {
        files,
        sourceName: this.device.name || 'device',
        mode: 'push',
      });
      this.onUpdate({ phase: 'offered' });

      const byPath = new Map(offer.results.map((result) => [result.relativePath, result]));
      for (const entry of this.entries) {
        const result = byPath.get(entry.relativePath);
        if (!result) {
          entry.state = 'error';
          entry.error = '对端拒绝了该路径';
          continue;
        }
        if (result.status === 'rejected-path') {
          entry.state = 'error';
          entry.error = '路径不合法';
          continue;
        }
        entry.uploadId = result.uploadId;
        entry.token = shareTokens.get(entry.relativePath) || null;
        entry.state = 'offered';
      }
      this.onUpdate();

      const queue = this.entries.filter((entry) => entry.uploadId && !entry.error);
      const workers = [];
      const lanes = Math.min(2, Math.max(1, queue.length));
      for (let lane = 0; lane < lanes; lane += 1) {
        workers.push((async () => {
          for (;;) {
            const entry = queue.shift();
            if (entry === undefined) return;
            await this.sendOne(entry, signal);
          }
        })());
      }
      await Promise.all(workers);

      const failed = this.entries.filter((entry) => entry.state === 'error');
      return { failed };
    } catch (error) {
      if (error.name === 'AbortError') {
        for (const entry of this.entries) {
          if (!['done', 'error'].includes(entry.state)) entry.state = 'canceled';
        }
        this.onUpdate();
        return { failed: [], canceled: true };
      }
      throw error;
    }
  }

  async sendOne(entry, signal) {
    entry.state = 'waiting';
    this.onUpdate();
    try {
      const plan = await pollUntilAccepted(entry.uploadId, this.origin, signal, (status) => {
        entry.state = status.state === 'pending' ? 'waiting' : 'uploading';
        entry.missingChunks = status.missingCount;
        this.onUpdate();
      });

      entry.state = 'uploading';
      entry.sentBytes = 0;
      this.onUpdate();

      const missing = plan.missingChunks.length
        ? plan.missingChunks
        : range(plan.totalChunks);
      const resumePlan = {
        chunkSize: plan.chunkSize,
        totalChunks: plan.totalChunks,
        missingChunks: missing,
      };

      try {
        await pushChunks(entry.uploadId, this.origin, entry.file, resumePlan, signal, (bytes) => {
          entry.sentBytes = bytes;
          entry.state = 'uploading';
          this.onUpdate();
        });
      } catch (error) {
        if (error.code !== 'ENETWORK' || !entry.token) throw error;
        entry.state = 'relaying';
        this.onUpdate({ warning: '直连推送失败,切换为中继传输' });
        await pullChunks(
          entry.uploadId,
          this.origin,
          entry.file,
          resumePlan,
          { token: entry.token, port: this.selfPort, hosts: this.selfHosts(), host: this.selfHost },
          signal,
          (bytes) => {
            entry.sentBytes = bytes;
            this.onUpdate();
          },
        );
      }

      entry.state = 'verifying';
      this.onUpdate();
      const result = await api.completeTransfer(entry.uploadId, this.origin);
      entry.state = 'done';
      entry.savedPath = result.savedPath;
      this.onUpdate();
    } catch (error) {
      if (error.name === 'AbortError') {
        entry.state = 'canceled';
        this.onUpdate();
        return;
      }
      entry.state = 'error';
      entry.error = error.message;
      this.onUpdate();
    }
  }

  selfHosts() {
    return this.device.selfAddresses && this.device.selfAddresses.length
      ? this.device.selfAddresses
      : [this.selfHost];
  }
}

function range(count) {
  return Array.from({ length: count }, (_, index) => index);
}
