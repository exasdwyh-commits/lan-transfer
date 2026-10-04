'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { AppConfig } = require('../src/config');
const { start } = require('../src/http/server');

const CHUNK = 256 * 1024;

async function makeServer(overrides = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lan-test-'));
  const stateDir = path.join(root, 'state');
  const downloadDir = overrides.downloadDir || path.join(root, 'downloads');
  await fsp.mkdir(downloadDir, { recursive: true });
  const config = AppConfig.load({
    dir: stateDir,
    overrides: {
      port: 0,
      downloadDir,
      chunkSizeBytes: CHUNK,
      discovery: 'off',
      acceptPolicy: 'auto',
      deviceName: overrides.deviceName || 'test-device',
      ...overrides.config,
    },
  });
  const app = await start({ config, port: 0, host: '127.0.0.1', discovery: false });
  return {
    app,
    root,
    downloadDir,
    origin: `http://127.0.0.1:${app.port}`,
    async close() {
      await app.close();
      await fsp.rm(root, { recursive: true, force: true });
    },
  };
}

async function request(origin, pathname, options = {}) {
  const res = await fetch(`${origin}${pathname}`, options);
  const text = await res.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  return { status: res.status, payload };
}

async function offerFile(origin, descriptor, { accept = true } = {}) {
  if (!accept) await request(origin, '/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ acceptPolicy: 'ask' }),
  });
  const offered = await request(origin, '/api/inbox/offer', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: [descriptor], sourceName: 'test-sender' }),
  });
  if (accept) await request(origin, '/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ acceptPolicy: 'auto' }),
  });
  assert.equal(offered.status, 200, JSON.stringify(offered.payload));
  return offered.payload.results[0];
}

async function pushChunk(origin, uploadId, index, buffer) {
  return request(
    origin,
    `/api/upload/chunk?uploadId=${uploadId}&index=${index}`,
    { method: 'PUT', body: buffer, headers: { 'Content-Type': 'application/octet-stream' } },
  );
}

function descriptorFor(relativePath, buffer, chunkSize = CHUNK) {
  return {
    relativePath,
    size: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    chunkSize,
    mtime: Date.now(),
  };
}

test('transfers a binary file end to end and verifies its digest', async (t) => {
  const server = await makeServer();
  t.after(() => server.close());

  const buffer = crypto.randomBytes(CHUNK * 5 + 12345);
  const offer = await offerFile(server.origin, descriptorFor('photo.jpg', buffer));
  assert.equal(offer.status, 'accepted');
  assert.equal(offer.totalChunks, 6);

  for (let index = 0; index < offer.totalChunks; index += 1) {
    const start = index * CHUNK;
    const slice = buffer.subarray(start, Math.min(buffer.length, start + CHUNK));
    const pushed = await pushChunk(server.origin, offer.uploadId, index, slice);
    assert.equal(pushed.status, 200);
  }

  const done = await request(server.origin, `/api/upload/complete?uploadId=${offer.uploadId}`, { method: 'POST' });
  assert.equal(done.status, 200);
  assert.equal(done.payload.sha256, descriptorFor('x', buffer).sha256);

  const saved = await fsp.readFile(path.join(server.downloadDir, 'photo.jpg'));
  assert.deepEqual(saved, buffer);
});

test('transfers an empty file without hanging', async (t) => {
  const server = await makeServer();
  t.after(() => server.close());

  const buffer = Buffer.alloc(0);
  const offer = await offerFile(server.origin, descriptorFor('empty.txt', buffer));
  assert.equal(offer.totalChunks, 1);
  await pushChunk(server.origin, offer.uploadId, 0, buffer);
  const done = await request(server.origin, `/api/upload/complete?uploadId=${offer.uploadId}`, { method: 'POST' });
  assert.equal(done.status, 200);
  assert.equal((await fsp.stat(path.join(server.downloadDir, 'empty.txt'))).size, 0);
});

test('reconstructs a nested folder tree', async (t) => {
  const server = await makeServer();
  t.after(() => server.close());

  const files = [
    { relativePath: 'Project/readme.md', data: Buffer.from('# hello') },
    { relativePath: 'Project/src/index.js', data: Buffer.from('console.log(1)') },
    { relativePath: 'Project/src/deep/util.js', data: Buffer.from('export default 2') },
  ];
  const offers = [];
  for (const file of files) {
    offers.push(await offerFile(server.origin, descriptorFor(file.relativePath, file.data)));
  }
  for (let index = 0; index < files.length; index += 1) {
    await pushChunk(server.origin, offers[index].uploadId, 0, files[index].data);
    const done = await request(server.origin, `/api/upload/complete?uploadId=${offers[index].uploadId}`, { method: 'POST' });
    assert.equal(done.status, 200, JSON.stringify(done.payload));
  }
  for (const file of files) {
    const saved = await fsp.readFile(path.join(server.downloadDir, file.relativePath));
    assert.deepEqual(saved, file.data);
  }
});

test('resumes an interrupted transfer and only re-sends missing chunks', async (t) => {
  const server = await makeServer();
  t.after(() => server.close());

  const buffer = crypto.randomBytes(CHUNK * 8);
  const descriptor = descriptorFor('movie.mp4', buffer);

  const first = await offerFile(server.origin, descriptor);
  for (let index = 0; index < 5; index += 1) {
    await pushChunk(server.origin, first.uploadId, index, buffer.subarray(index * CHUNK, (index + 1) * CHUNK));
  }

  const partial = await request(server.origin, `/api/upload/status?uploadId=${first.uploadId}`);
  assert.equal(partial.payload.missingCount, 3);
  assert.deepEqual(partial.payload.missingChunks, [5, 6, 7]);

  const resumed = await offerFile(server.origin, descriptor);
  assert.equal(resumed.status, 'reuse');
  assert.equal(resumed.uploadId, first.uploadId);
  assert.deepEqual(resumed.missingChunks, [5, 6, 7]);

  for (const index of resumed.missingChunks) {
    await pushChunk(server.origin, resumed.uploadId, index, buffer.subarray(index * CHUNK, (index + 1) * CHUNK));
  }
  const done = await request(server.origin, `/api/upload/complete?uploadId=${resumed.uploadId}`, { method: 'POST' });
  assert.equal(done.status, 200);
  assert.deepEqual(await fsp.readFile(path.join(server.downloadDir, 'movie.mp4')), buffer);
});

test('resumes across a server restart because chunks live on disk', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lan-restart-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'state');
  const downloadDir = path.join(root, 'downloads');
  await fsp.mkdir(downloadDir, { recursive: true });

  const build = () => AppConfig.load({
    dir: stateDir,
    overrides: { port: 0, downloadDir, chunkSizeBytes: CHUNK, discovery: 'off', acceptPolicy: 'auto' },
  });

  const buffer = crypto.randomBytes(CHUNK * 6);
  const descriptor = descriptorFor('archive.bin', buffer);

  const first = await start({ config: build(), port: 0, host: '127.0.0.1', discovery: false });
  const firstOrigin = `http://127.0.0.1:${first.port}`;
  const offer = await offerFile(firstOrigin, descriptor);
  for (let index = 0; index < 4; index += 1) {
    await pushChunk(firstOrigin, offer.uploadId, index, buffer.subarray(index * CHUNK, (index + 1) * CHUNK));
  }
  await first.close();

  const second = await start({ config: build(), port: 0, host: '127.0.0.1', discovery: false });
  t.after(() => second.close());
  const secondOrigin = `http://127.0.0.1:${second.port}`;

  const restored = await request(secondOrigin, '/api/transfers');
  assert.equal(restored.payload.transfers.length, 1);
  assert.equal(restored.payload.transfers[0].uploadId, offer.uploadId);

  const resumed = await offerFile(secondOrigin, descriptor);
  assert.equal(resumed.status, 'reuse');
  assert.deepEqual(resumed.missingChunks, [4, 5]);
  for (const index of resumed.missingChunks) {
    await pushChunk(secondOrigin, resumed.uploadId, index, buffer.subarray(index * CHUNK, (index + 1) * CHUNK));
  }
  const done = await request(secondOrigin, `/api/upload/complete?uploadId=${resumed.uploadId}`, { method: 'POST' });
  assert.equal(done.status, 200);
  assert.deepEqual(await fsp.readFile(path.join(downloadDir, 'archive.bin')), buffer);
});

test('accepts many chunks uploaded concurrently without corrupting state', async (t) => {
  const server = await makeServer();
  t.after(() => server.close());

  const total = 64;
  const buffer = crypto.randomBytes(CHUNK * total);
  const offer = await offerFile(server.origin, descriptorFor('concurrent.bin', buffer));
  assert.equal(offer.totalChunks, total);

  const responses = await Promise.all(
    Array.from({ length: total }, (_, index) =>
      pushChunk(server.origin, offer.uploadId, index, buffer.subarray(index * CHUNK, (index + 1) * CHUNK)),
    ),
  );
  for (const response of responses) {
    assert.equal(response.status, 200, JSON.stringify(response.payload));
  }

  const status = await request(server.origin, `/api/upload/status?uploadId=${offer.uploadId}`);
  assert.equal(status.payload.missingCount, 0);
  assert.equal(status.payload.receivedBytes, buffer.length);

  const done = await request(server.origin, `/api/upload/complete?uploadId=${offer.uploadId}`, { method: 'POST' });
  assert.equal(done.status, 200);
  assert.deepEqual(await fsp.readFile(path.join(server.downloadDir, 'concurrent.bin')), buffer);
});

test('refuses to complete while chunks are still missing', async (t) => {
  const server = await makeServer();
  t.after(() => server.close());

  const buffer = crypto.randomBytes(CHUNK * 4);
  const offer = await offerFile(server.origin, descriptorFor('partial.dat', buffer));
  await pushChunk(server.origin, offer.uploadId, 0, buffer.subarray(0, CHUNK));
  const done = await request(server.origin, `/api/upload/complete?uploadId=${offer.uploadId}`, { method: 'POST' });
  assert.equal(done.status, 409);
  assert.equal(done.payload.error.code, 'EINCOMPLETE');
});

test('discards the file when the assembled digest does not match', async (t) => {
  const server = await makeServer();
  t.after(() => server.close());

  const real = crypto.randomBytes(CHUNK * 3);
  const lying = descriptorFor('tampered.bin', real);
  const offer = await offerFile(server.origin, lying);
  const corrupt = Buffer.alloc(CHUNK * 3, 0xab);
  for (let index = 0; index < 3; index += 1) {
    await pushChunk(server.origin, offer.uploadId, index, corrupt.subarray(index * CHUNK, (index + 1) * CHUNK));
  }
  const done = await request(server.origin, `/api/upload/complete?uploadId=${offer.uploadId}`, { method: 'POST' });
  assert.equal(done.status, 422);
  assert.equal(done.payload.error.code, 'EHASHMISMATCH');
  assert.equal(fs.existsSync(path.join(server.downloadDir, 'tampered.bin')), false);
  assert.deepEqual(
    (await fsp.readdir(server.downloadDir)).filter((name) => name.includes('incoming')),
    [],
  );
});

test('rejects a chunk whose length disagrees with the manifest', async (t) => {
  const server = await makeServer();
  t.after(() => server.close());

  const buffer = crypto.randomBytes(CHUNK * 2);
  const offer = await offerFile(server.origin, descriptorFor('strict.bin', buffer));
  const short = await pushChunk(server.origin, offer.uploadId, 0, Buffer.alloc(10));
  assert.equal(short.status, 400);
  assert.equal(short.payload.error.code, 'ECHUNKSHORT');

  const oversize = await pushChunk(server.origin, offer.uploadId, 0, Buffer.alloc(CHUNK + 1));
  assert.equal(oversize.status, 400);
  assert.equal(oversize.payload.error.code, 'ECHUNKSIZE');

  const status = await request(server.origin, `/api/upload/status?uploadId=${offer.uploadId}`);
  assert.deepEqual(status.payload.missingChunks, [0, 1]);
});

test('rejects an out-of-range chunk index', async (t) => {
  const server = await makeServer();
  t.after(() => server.close());
  const buffer = crypto.randomBytes(CHUNK);
  const offer = await offerFile(server.origin, descriptorFor('one.bin', buffer));
  const bad = await pushChunk(server.origin, offer.uploadId, 7, buffer);
  assert.equal(bad.status, 416);
});

test('requires explicit approval when acceptPolicy is ask', async (t) => {
  const server = await makeServer();
  t.after(() => server.close());

  const buffer = Buffer.from('secret payload');
  const offer = await offerFile(server.origin, descriptorFor('secret.txt', buffer), { accept: false });
  assert.equal(offer.status, 'pending');

  const premature = await pushChunk(server.origin, offer.uploadId, 0, buffer);
  assert.equal(premature.status, 409);
  assert.equal(premature.payload.error.code, 'EPENDING');

  await request(server.origin, '/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ acceptPolicy: 'ask' }),
  });
  const accepted = await request(server.origin, `/api/upload/accept?uploadId=${offer.uploadId}`, { method: 'POST' });
  assert.equal(accepted.payload.state, 'accepted');
  assert.equal((await pushChunk(server.origin, offer.uploadId, 0, buffer)).status, 200);
  await request(server.origin, `/api/upload/complete?uploadId=${offer.uploadId}`, { method: 'POST' });
  assert.deepEqual(await fsp.readFile(path.join(server.downloadDir, 'secret.txt')), buffer);
});

test('a rejected offer refuses further chunks', async (t) => {
  const server = await makeServer();
  t.after(() => server.close());
  const buffer = Buffer.from('nope');
  const offer = await offerFile(server.origin, descriptorFor('nope.txt', buffer), { accept: false });
  await request(server.origin, `/api/upload/reject?uploadId=${offer.uploadId}`, { method: 'POST' });
  const rejected = await pushChunk(server.origin, offer.uploadId, 0, buffer);
  assert.equal(rejected.status, 404);
});

test('sanitizes hostile filenames offered by a peer', async (t) => {
  const server = await makeServer();
  t.after(() => server.close());

  const hostile = [
    { relativePath: '../../etc/evil.sh', body: Buffer.from('pwned?') },
    { relativePath: '/absolute/evil.sh', body: Buffer.from('absolute') },
    { relativePath: 'C:/Windows/evil.exe', body: Buffer.from('drive') },
    { relativePath: 'win:bad|name.txt', body: Buffer.from('windows chars') },
    { relativePath: 'ok/report.pdf', body: Buffer.from('a pdf') },
    { relativePath: 'ok/.DS_Store', body: Buffer.from('junk') },
    { relativePath: 'ok/report.pdf', body: Buffer.from('a pdf') },
  ];
  const results = [];
  for (const item of hostile) {
    const offered = await request(server.origin, '/api/inbox/offer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: [descriptorFor(item.relativePath, item.body)], sourceName: 'attacker' }),
    });
    assert.equal(offered.status, 200);
    results.push({ asked: item.relativePath, got: offered.payload.results[0] });
  }

  const accepted = results.filter((entry) => entry.got.status === 'accepted');
  const resumed = results.filter((entry) => entry.got.status === 'reuse');
  const refused = results.filter((entry) => entry.got.status === 'rejected-path');
  assert.deepEqual(accepted.map((entry) => entry.asked).sort(), ['ok/report.pdf', 'win:bad|name.txt']);
  assert.equal(refused.length, 4);
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0].asked, 'ok/report.pdf');

  const offer = accepted.find((entry) => entry.asked === 'win:bad|name.txt');
  await pushChunk(server.origin, offer.got.uploadId, 0, Buffer.from('windows chars'));
  await request(server.origin, `/api/upload/complete?uploadId=${offer.got.uploadId}`, { method: 'POST' });
  assert.deepEqual(
    await fsp.readFile(path.join(server.downloadDir, 'win_bad_name.txt')),
    Buffer.from('windows chars'),
  );
  assert.equal(fs.existsSync(path.join(path.dirname(server.downloadDir), 'evil.sh')), false);
});

test('re-offering identical pending files does not create duplicate requests', async (t) => {
  const server = await makeServer({ config: { acceptPolicy: 'ask' } });
  t.after(() => server.close());

  const buffer = Buffer.from('offered twice');
  const descriptor = descriptorFor('twice.txt', buffer);

  const first = await offerFile(server.origin, descriptor, { accept: false });
  assert.equal(first.status, 'pending');
  const second = await offerFile(server.origin, descriptor, { accept: false });
  assert.equal(second.status, 'reuse');
  assert.equal(second.uploadId, first.uploadId);

  const listed = await request(server.origin, '/api/transfers');
  assert.equal(listed.payload.transfers.length, 1);

  await request(server.origin, `/api/upload/accept?uploadId=${first.uploadId}`, { method: 'POST' });
  assert.equal((await pushChunk(server.origin, first.uploadId, 0, buffer)).status, 200);
  const done = await request(server.origin, `/api/upload/complete?uploadId=${first.uploadId}`, { method: 'POST' });
  assert.equal(done.status, 200);
});

test('a rejected file can be offered again as a fresh request', async (t) => {
  const server = await makeServer({ config: { acceptPolicy: 'ask' } });
  t.after(() => server.close());

  const buffer = Buffer.from('try me again');
  const descriptor = descriptorFor('retry.txt', buffer);
  const first = await offerFile(server.origin, descriptor, { accept: false });
  await request(server.origin, `/api/upload/reject?uploadId=${first.uploadId}`, { method: 'POST' });

  const second = await offerFile(server.origin, descriptor, { accept: false });
  assert.equal(second.status, 'pending');
  assert.notEqual(second.uploadId, first.uploadId);
  assert.equal((await request(server.origin, '/api/transfers')).payload.transfers.length, 1);
});

test('renames instead of clobbering an existing file on disk', async (t) => {
  const server = await makeServer();
  t.after(() => server.close());

  const existing = Buffer.from('do not overwrite me');
  await fsp.writeFile(path.join(server.downloadDir, 'report.pdf'), existing);

  const incoming = Buffer.from('brand new content');
  const offer = await offerFile(server.origin, descriptorFor('report.pdf', incoming));
  await pushChunk(server.origin, offer.uploadId, 0, incoming);
  const done = await request(server.origin, `/api/upload/complete?uploadId=${offer.uploadId}`, { method: 'POST' });
  assert.equal(done.status, 200);
  assert.equal(path.basename(done.payload.savedPath), 'report (2).pdf');
  assert.deepEqual(await fsp.readFile(path.join(server.downloadDir, 'report.pdf')), existing);
  assert.deepEqual(await fsp.readFile(path.join(server.downloadDir, 'report (2).pdf')), incoming);
});

test('case-only filename differences do not collide on disk', async (t) => {
  const server = await makeServer();
  t.after(() => server.close());

  const first = Buffer.from('upper');
  const second = Buffer.from('lower');
  for (const [relativePath, data] of [['Notes.TXT', first], ['notes.txt', second]]) {
    const offer = await offerFile(server.origin, descriptorFor(relativePath, data));
    await pushChunk(server.origin, offer.uploadId, 0, data);
    const done = await request(server.origin, `/api/upload/complete?uploadId=${offer.uploadId}`, { method: 'POST' });
    assert.equal(done.status, 200);
  }
  assert.deepEqual(await fsp.readFile(path.join(server.downloadDir, 'Notes.TXT')), first);
  assert.deepEqual(await fsp.readFile(path.join(server.downloadDir, 'notes (2).txt')), second);
});

test('serves registered shares by chunk range for relay transfers', async (t) => {
  const sourceRoot = await fsp.mkdtemp(
    path.join(os.homedir(), 'Downloads', 'lan-transfer-test-'),
  );
  t.after(() => fsp.rm(sourceRoot, { recursive: true, force: true }));
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lan-share-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  const buffer = crypto.randomBytes(CHUNK * 3 + 17);
  await fsp.writeFile(path.join(sourceRoot, 'asset.bin'), buffer);

  const server = await makeServer({ downloadDir: path.join(root, 'downloads') });
  t.after(() => server.close());

  const share = await request(server.origin, '/api/share', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sourceRoot,
      files: [{
        relativePath: 'asset.bin',
        size: buffer.length,
        sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
        chunkSize: CHUNK,
        mtime: Date.now(),
      }],
    }),
  });
  assert.equal(share.status, 200);
  const token = share.payload.files[0].token;
  assert.equal(share.payload.files[0].totalChunks, 4);

  const manifest = await request(server.origin, `/api/pull/${token}`);
  assert.equal(manifest.payload.presentOnDisk, true);

  const rebuilt = [];
  for (let index = 0; index < 4; index += 1) {
    const res = await fetch(`${server.origin}/api/pull/${token}/chunk?index=${index}`);
    assert.equal(res.status, 200);
    const piece = Buffer.from(await res.arrayBuffer());
    assert.equal(piece.length, index < 3 ? CHUNK : 17);
    rebuilt.push(piece);
  }
  assert.deepEqual(Buffer.concat(rebuilt), buffer);
});

test('refuses to share files outside the allowed home folders', async (t) => {
  const server = await makeServer();
  t.after(() => server.close());
  const denied = await request(server.origin, '/api/share', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sourceRoot: '/etc',
      files: [{ relativePath: 'passwd', size: 1, sha256: 'a'.repeat(64), chunkSize: CHUNK }],
    }),
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.payload.error.code, 'EROOT');
});

test('validates offer payloads', async (t) => {
  const server = await makeServer();
  t.after(() => server.close());

  const cases = [
    { body: { files: [] }, code: 'EFIELD' },
    { body: { files: 'nope' }, code: 'EFIELD' },
    { body: { files: [{ relativePath: 'a.txt', size: 1, sha256: 'short', chunkSize: CHUNK }] }, code: 'EFIELD' },
    { body: { files: [{ relativePath: 'a.txt', size: -5, sha256: 'a'.repeat(64), chunkSize: CHUNK }] }, code: 'EFIELD' },
    { body: { files: [{ relativePath: 'a.txt', size: 1, sha256: 'a'.repeat(64), chunkSize: 10 }] }, code: 'EFIELD' },
    { body: { files: [{ size: 1, sha256: 'a'.repeat(64), chunkSize: CHUNK }] }, code: 'EFIELD' },
  ];
  for (const testCase of cases) {
    const res = await request(server.origin, '/api/inbox/offer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(testCase.body),
    });
    assert.equal(res.status, 400, JSON.stringify(res.payload));
    assert.equal(res.payload.error.code, testCase.code);
  }
});

test('unknown routes and methods return structured errors', async (t) => {
  const server = await makeServer();
  t.after(() => server.close());
  const missing = await request(server.origin, '/api/nope');
  assert.equal(missing.status, 404);
  assert.equal(missing.payload.error.code, 'ENOTFOUND');
  const badId = await request(server.origin, '/api/upload/status?uploadId=zzzz');
  assert.equal(badId.status, 400);
  const unknown = await request(server.origin, '/api/upload/status?uploadId=' + 'f'.repeat(24));
  assert.equal(unknown.status, 404);
});

test('static assets are served and cannot be path-traversed', async (t) => {
  const server = await makeServer();
  t.after(() => server.close());
  const page = await fetch(`${server.origin}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(await page.text(), /局域网文件传输/);

  const escape = await fetch(`${server.origin}/..%2f..%2fpackage.json`);
  assert.ok(escape.status === 404 || escape.status === 400, `got ${escape.status}`);
});

async function waitForEvent(origin, eventName, timeoutMs = 5000) {
  const controller = new AbortController();
  const res = await fetch(`${origin}/api/events`, { signal: controller.signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.includes(`event: ${eventName}\n`)) break;
    }
  } catch (error) {
    if (error.name !== 'AbortError') throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return buffer;
}

test('serves the event stream with the right content type', async (t) => {
  const server = await makeServer();
  t.after(() => server.close());
  const controller = new AbortController();
  const res = await fetch(`${server.origin}/api/events`, { signal: controller.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  controller.abort();
});

test('event stream delivers JSON payloads the browser can parse', async (t) => {
  const server = await makeServer();
  t.after(() => server.close());

  const buffer = crypto.randomBytes(1024);
  const streamed = waitForEvent(server.origin, 'incoming');
  await new Promise((resolve) => setTimeout(resolve, 250));
  await offerFile(server.origin, descriptorFor('streamed.bin', buffer));

  const frames = await streamed;
  const match = /event: incoming\ndata: (.+?)\n\n/.exec(frames);
  assert.ok(match, `no incoming event in stream: ${JSON.stringify(frames.slice(0, 400))}`);
  const payload = JSON.parse(match[1]);
  assert.equal(payload.displayName, 'streamed.bin');
  assert.equal(payload.relativePath, 'streamed.bin');
  assert.equal(payload.size, buffer.length);
  assert.equal(payload.totalChunks, 1);
  assert.equal(payload.state, 'accepted');
  assert.ok(payload.uploadId, 'payload needs an uploadId');
  assert.ok(payload.sourceName, 'payload needs a sourceName');
});
