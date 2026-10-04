import * as api from './api.js';
import { filesFromDataTransfer, filesFromInput, filterItems, totalSize } from './files.js';
import { SendJob } from './transfer.js';

const els = {};
const state = {
  info: null,
  devices: [],
  selectedPeer: null,
  pending: [],
  transfers: new Map(),
  history: [],
  job: null,
  historyLoaded: false,
};

const STATE_LABEL = {
  queued: '等待中',
  hashing: '校验中',
  registering: '准备中',
  offered: '已通知对方',
  waiting: '等待对方确认',
  uploading: '发送中',
  relaying: '中继中',
  verifying: '校验合并',
  done: '已完成',
  error: '失败',
  canceled: '已取消',
  pending: '等待确认',
  accepted: '已确认',
  receiving: '接收中',
  complete: '已完成',
  rejected: '已拒绝',
};

function byId(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing element #${id}`);
  return element;
}

function cacheElements() {
  for (const id of [
    'deviceName', 'deviceMeta', 'copyLink', 'toggleSettings', 'lanBanner', 'deviceCount',
    'peers', 'dropzone', 'fileInput', 'folderInput', 'pickFiles', 'pickFolder', 'manualIp',
    'sendQueue', 'sendBar', 'sendSummary', 'sendNow', 'sendCancel', 'inbox', 'inboxEmpty',
    'history', 'recvDir', 'settings', 'cfgName', 'cfgDir', 'cfgChunk', 'cfgConflict',
    'cfgAccept', 'cfgDiscovery', 'saveSettings', 'settingsStatus', 'toasts', 'manualDialog',
    'manualHost', 'manualPort', 'manualName',
  ]) {
    els[id] = byId(id);
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatSpeed(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '';
  return `${formatBytes(bytesPerSecond)}/s`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function toast(message, kind = '') {
  const node = el('div', `toast ${kind}`.trim(), message);
  els.toasts.append(node);
  setTimeout(() => {
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 250);
  }, kind === 'err' ? 8000 : 4000);
}

async function boot() {
  cacheElements();
  wireEvents();
  state.info = await api.getInfo();
  els.deviceName.textContent = state.info.deviceName;
  els.recvDir.textContent = state.info.downloadDir;
  els.recvDir.title = state.info.downloadDir;
  renderMeta();
  await refreshDevices();
  await refreshTransfers();
  await loadConfig();
  api.subscribeToEvents(handleServerEvent);
  setInterval(refreshDevices, 3000);
}

function renderMeta() {
  const info = state.info;
  const primary = info.primaryAddress || '127.0.0.1';
  els.deviceMeta.textContent = `${primary}:${info.port} · ${info.platform === 'win32' ? 'Windows' : 'macOS'}`;
  if (!info.mdnsHealthy && info.discovery !== 'off') {
    els.lanBanner.hidden = false;
    els.lanBanner.textContent =
      'mDNS 未就绪,已切换为 UDP 广播发现。若找不到设备,请用"手动输入 IP"。';
  }
}

function wireEvents() {
  els.copyLink.addEventListener('click', async () => {
    const url = `http://${state.info.primaryAddress}:${state.info.port}`;
    try {
      await navigator.clipboard.writeText(url);
      toast(`已复制 ${url}`, 'ok');
    } catch {
      toast(url);
    }
  });

  els.toggleSettings.addEventListener('click', () => {
    const open = els.settings.hidden;
    els.settings.hidden = !open;
    els.toggleSettings.setAttribute('aria-expanded', String(open));
  });

  els.pickFiles.addEventListener('click', () => els.fileInput.click());
  els.pickFolder.addEventListener('click', () => els.folderInput.click());
  els.dropzone.addEventListener('click', (event) => {
    if (event.target === els.dropzone || event.target.closest('.dropzone-inner')) els.fileInput.click();
  });
  els.dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      els.fileInput.click();
    }
  });

  for (const type of ['dragenter', 'dragover']) {
    els.dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      els.dropzone.classList.add('dragging');
    });
  }
  for (const type of ['dragleave', 'drop']) {
    els.dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      if (type === 'dragleave' && els.dropzone.contains(event.relatedTarget)) return;
      els.dropzone.classList.remove('dragging');
    });
  }
  els.dropzone.addEventListener('drop', async (event) => {
    event.preventDefault();
    const items = await filesFromDataTransfer(event.dataTransfer);
    addPending(items);
  });

  els.fileInput.addEventListener('change', (event) => {
    addPending(filesFromInput(event.target.files));
    event.target.value = '';
  });
  els.folderInput.addEventListener('change', (event) => {
    addPending(filesFromInput(event.target.files));
    event.target.value = '';
  });

  els.sendNow.addEventListener('click', startSend);
  els.sendCancel.addEventListener('click', () => {
    state.job?.cancel();
    toast('正在取消…', 'warn');
  });

  els.manualIp.addEventListener('click', () => {
    els.manualPort.value = String(state.info.port);
    els.manualDialog.showModal();
  });
  els.manualDialog.addEventListener('close', () => {
    if (els.manualDialog.returnValue !== 'ok') return;
    const host = els.manualHost.value.trim();
    const port = Number.parseInt(els.manualPort.value, 10);
    if (!host || !Number.isInteger(port)) return;
    state.selectedPeer = {
      id: `manual-${host}-${port}`,
      name: els.manualName.value.trim() || `${host}:${port}`,
      host,
      port,
      addresses: [host],
      manual: true,
      origin: `http://${host}:${port}`,
    };
    renderPeers();
    toast(`已选择 ${state.selectedPeer.name}`, 'ok');
  });

  els.saveSettings.addEventListener('click', saveSettings);
}

function addPending(items) {
  const { kept, skipped } = filterItems(items);
  if (skipped.length) toast(`已跳过 ${skipped.length} 个无效/重复/系统文件`, 'warn');
  if (!kept.length) {
    toast('没有可发送的文件', 'warn');
    return;
  }
  const known = new Set(state.pending.map((item) => item.relativePath.toLowerCase()));
  let added = 0;
  for (const item of kept) {
    const key = item.relativePath.toLowerCase();
    if (known.has(key)) continue;
    known.add(key);
    state.pending.push(item);
    added += 1;
  }
  if (added) renderSendQueue();
  if (added) toast(`已加入 ${added} 个文件,共 ${formatBytes(totalSize(kept))}`, 'ok');
}

function sourceRootFor() {
  const first = state.pending[0]?.relativePath || '';
  const separator = first.includes('/') ? '/' : '\\';
  const parts = first.split(/[\\/]/).filter(Boolean);
  if (parts.length < 2) return null;
  return parts.slice(0, -1).join(separator);
}

async function startSend() {
  if (state.job) {
    toast('已有传输正在进行', 'warn');
    return;
  }
  const peer = state.selectedPeer;
  if (!peer) {
    toast('请先选择接收方', 'warn');
    return;
  }
  const items = state.pending;
  if (!items.length) return;

  const origin = peer.origin || `http://${peer.host || peer.addresses?.[0]}:${peer.port}`;
  const chunkSize = state.info.chunkSizeBytes;
  const selfAddress = state.info.primaryAddress;

  const job = new SendJob({
    items,
    device: { name: state.info.deviceName, selfAddresses: state.info.addresses },
    origin,
    chunkSize,
    sourceRoot: sourceRootFor() || '.',
    selfHost: selfAddress,
    selfPort: state.info.port,
    onUpdate: (patch) => {
      if (patch?.warning) toast(patch.warning, 'warn');
      renderSendQueue();
    },
  });
  state.job = job;
  els.sendCancel.hidden = false;
  els.sendSummary.textContent = `正在发送到 ${peer.name}…`;
  renderSendQueue();

  try {
    const result = await job.run();
    const done = job.entries.filter((entry) => entry.state === 'done').length;
    if (result.canceled) {
      toast(`已取消,已完成的 ${done} 个文件保留在对方设备`, 'warn');
    } else if (result.failed.length === 0) {
      toast(`全部 ${done} 个文件发送完成`, 'ok');
      state.pending = [];
    } else {
      toast(`${done} 个成功,${result.failed.length} 个失败`, 'err');
      state.pending = job.entries
        .filter((entry) => entry.state === 'error')
        .map((entry) => ({ file: entry.file, relativePath: entry.relativePath }));
    }
  } catch (error) {
    toast(`发送失败: ${error.message}`, 'err');
  } finally {
    state.job = null;
    els.sendCancel.hidden = true;
    renderSendQueue();
  }
}

function renderSendQueue() {
  const job = state.job;
  els.sendBar.hidden = state.pending.length === 0 && !job;
  renderPeerHint();
  els.sendNow.disabled = Boolean(job) || !state.selectedPeer;
  if (!job) {
    const bytes = totalSize(state.pending);
    els.sendSummary.textContent = state.pending.length
      ? `${state.pending.length} 个文件 · ${formatBytes(bytes)}`
      : '准备就绪';
    renderIdleQueue();
    return;
  }
  const done = job.entries.filter((entry) => entry.state === 'done').length;
  els.sendSummary.textContent = `发送到 ${job.device.name} · ${done}/${job.entries.length} 完成`;
  renderJobQueue(job);
}

function renderPeerHint() {
  const existing = document.getElementById('peerHint');
  if (state.selectedPeer) {
    existing?.remove();
    return;
  }
  if (els.sendBar.hidden) {
    existing?.remove();
    return;
  }
  const hint = el('div', 'row-path');
  hint.id = 'peerHint';
  hint.textContent = state.devices.length
    ? '↑ 先在上方点选一台接收设备'
    : '↑ 未发现设备:请确认对方也运行了本程序,或用「手动输入 IP」';
  if (!existing) els.sendBar.prepend(hint);
}

function renderIdleQueue() {
  els.sendQueue.replaceChildren();
  for (const item of state.pending.slice(0, 60)) {
    const row = el('div', 'row');
    const top = el('div', 'row-top');
    top.append(el('span', 'row-name', item.relativePath));
    top.append(el('span', 'row-meta', formatBytes(item.file.size)));
    row.append(top, el('div', 'row-path', `目录: ${sourceRootFor() || '(当前目录)'}`));
    els.sendQueue.append(row);
  }
  if (state.pending.length > 60) {
    els.sendQueue.append(el('div', 'muted small', `…以及另外 ${state.pending.length - 60} 个文件`));
  }
}

function renderJobQueue(job) {
  els.sendQueue.replaceChildren();
  const startedAt = Date.now() - (job.elapsed || 0);
  job.elapsed = Date.now() - startedAt;
  for (const entry of job.entries.slice(0, 60)) {
    const row = el('div', 'row');
    const top = el('div', 'row-top');
    const name = el('span', 'row-name', entry.relativePath);
    const meta = el('span', 'row-meta');
    top.append(name);

    const total = entry.file.size;
    let sent = 0;
    let label = STATE_LABEL[entry.state] || entry.state;

    if (entry.state === 'hashing') {
      sent = entry.hashBytes || 0;
      label = `${STATE_LABEL.hashing} ${formatBytes(sent)}/${formatBytes(total)}`;
    } else if (entry.state === 'uploading' || entry.state === 'relaying') {
      sent = entry.sentBytes || 0;
      const speed = sent / Math.max(0.6, (Date.now() - startedAt) / 1000);
      label = `${STATE_LABEL[entry.state]} ${formatSpeed(speed)}`;
    } else if (entry.state === 'waiting') {
      label = entry.missingChunks === 0 ? STATE_LABEL.offered : `${STATE_LABEL.waiting}(待传 ${entry.missingChunks} 片)`;
    }

    meta.textContent = total > 0 && ['hashing', 'uploading', 'relaying'].includes(entry.state)
      ? `${label} · ${formatBytes(sent)}/${formatBytes(total)}`
      : label;
    top.append(meta);
    row.append(top);

    const percent = total > 0 ? Math.min(100, Math.round((sent / total) * 100)) : entry.state === 'done' ? 100 : 0;
    const barClass = entry.state === 'done' ? 'bar ok' : entry.state === 'error' ? 'bar err' : 'bar';
    const bar = el('div', barClass);
    const fill = el('i');
    fill.style.width = `${percent}%`;
    bar.append(fill);
    row.append(bar);

    if (entry.error) row.append(el('div', 'row-path', entry.error));
    if (entry.state === 'relaying') row.append(el('div', 'row-path', '直连失败,正在经本机中继'));
    els.sendQueue.append(row);
  }
  if (job.entries.length > 60) {
    els.sendQueue.append(el('div', 'muted small', `…以及另外 ${job.entries.length - 60} 个文件`));
  }
}

async function refreshDevices() {
  let payload;
  try {
    payload = await api.getDevices();
  } catch {
    return;
  }
  state.devices = payload.devices;
  if (state.selectedPeer?.manual) {
    renderPeers();
    return;
  }
  const stillThere = state.devices.some((device) => device.id === state.selectedPeer?.id);
  if (state.selectedPeer && !stillThere) {
    toast(`${state.selectedPeer.name} 已离线`, 'warn');
    state.selectedPeer = null;
  }
  if (!state.selectedPeer && state.devices.length === 1) {
    const only = state.devices[0];
    const address = only.addresses?.[0];
    state.selectedPeer = { ...only, origin: `http://${address}:${only.port}` };
  }
  renderPeers();
}

function renderPeers() {
  els.peers.replaceChildren();
  const manual = state.selectedPeer?.manual ? [state.selectedPeer] : [];
  const all = [...manual, ...state.devices];
  els.deviceCount.textContent = `${all.length} 台设备`;
  if (!all.length) {
    els.peers.append(el('span', 'peers-empty', '未发现设备。可让对方也运行本程序,或用手动输入 IP。'));
    return;
  }
  for (const device of all) {
    const peer = el('div', 'peer');
    peer.setAttribute('role', 'radio');
    peer.tabIndex = 0;
    const selected = state.selectedPeer?.id === device.id;
    peer.setAttribute('aria-checked', String(selected));
    const age = Date.now() - (device.lastSeen || 0);
    const dot = el('span', `peer-dot${age > 12000 && !device.manual ? ' stale' : ''}`);
    const address = device.manual ? device.host : device.addresses?.[0];
    peer.append(dot, el('span', 'peer-name', device.name), el('span', 'peer-addr', `${address}:${device.port}`));
    const select = () => {
      state.selectedPeer = { ...device, origin: `http://${address}:${device.port}` };
      renderPeers();
    };
    peer.addEventListener('click', select);
    peer.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        select();
      }
    });
    els.peers.append(peer);
  }
  renderSendQueue();
}

async function refreshTransfers() {
  const payload = await api.getTransfers().catch(() => null);
  if (!payload) return;
  state.transfers.clear();
  for (const transfer of payload.transfers) state.transfers.set(transfer.uploadId, transfer);
  renderInbox();
}

function handleServerEvent(name, data) {
  if (name === 'incoming') {
    state.transfers.set(data.uploadId, data);
    renderInbox();
    toast(`${data.sourceName || '对方'} 请求发送 ${data.displayName}`, 'warn');
    return;
  }
  if (name === 'incoming-progress' || name === 'transfer-progress') {
    const current = state.transfers.get(data.uploadId);
    if (current) {
      current.receivedBytes = data.receivedBytes;
      current.state = 'receiving';
      renderInbox();
    }
    return;
  }
  if (name === 'transfer-state') {
    const current = state.transfers.get(data.uploadId);
    if (current) {
      Object.assign(current, data);
      if (!['complete', 'rejected', 'error', 'canceled'].includes(data.state)) {
        state.transfers.set(data.uploadId, data);
      } else {
        state.transfers.delete(data.uploadId);
      }
      renderInbox();
    }
    return;
  }
  if (name === 'transfer-complete') {
    state.transfers.delete(data.uploadId);
    pushHistory(data);
    renderInbox();
    toast(`${data.displayName} 已接收`, 'ok');
    return;
  }
  if (name === 'transfer-rejected' || name === 'transfer-canceled') {
    state.transfers.delete(data.uploadId);
    renderInbox();
    return;
  }
  if (name === 'devices') {
    refreshDevices();
  }
}

function pushHistory(transfer) {
  state.history.unshift({
    name: transfer.displayName,
    size: transfer.size,
    at: new Date(),
    path: transfer.savedPath,
  });
  state.history = state.history.slice(0, 20);
  renderHistory();
}

function renderInbox() {
  const list = [...state.transfers.values()].sort((a, b) => a.createdAt - b.createdAt);
  els.inboxEmpty.hidden = list.length > 0;
  els.inbox.replaceChildren();
  if (!list.length) {
    els.inbox.append(els.inboxEmpty);
    return;
  }
  for (const transfer of list) els.inbox.append(inboxRow(transfer));
}

function inboxRow(transfer) {
  const row = el('div', 'row');
  const top = el('div', 'row-top');
  top.append(el('span', 'row-name', transfer.relativePath));

  const pending = transfer.state === 'pending';
  const percent = transfer.size > 0
    ? Math.min(100, Math.round((transfer.receivedBytes / transfer.size) * 100))
    : 0;
  const badge = el('span', `state ${transfer.state === 'error' ? 'error' : pending ? 'waiting' : 'uploading'}`);
  badge.textContent = pending
    ? STATE_LABEL.pending
    : `${transfer.restored ? '可续传' : STATE_LABEL[transfer.state] || transfer.state} ${percent}%`;
  top.append(badge);
  row.append(top);

  row.append(el('div', 'row-path', `来自 ${transfer.sourceName || '未知设备'}${transfer.sourceAddress ? ` (${transfer.sourceAddress})` : ''}`));

  const bar = el('div', 'bar');
  const fill = el('i');
  fill.style.width = `${percent}%`;
  bar.append(fill);
  row.append(bar);

  row.append(el('div', 'row-meta', `${formatBytes(transfer.receivedBytes)} / ${formatBytes(transfer.size)} · ${transfer.totalChunks} 个分片`));

  const actions = el('div', 'row-actions');
  if (pending) {
    const accept = el('button', 'primary', '接受');
    accept.addEventListener('click', async () => {
      accept.disabled = true;
      try {
        await api.acceptTransfer(transfer.uploadId);
        toast(`开始接收 ${transfer.displayName}`, 'ok');
      } catch (error) {
        toast(`接受失败: ${error.message}`, 'err');
        accept.disabled = false;
      }
    });
    const reject = el('button', 'ghost', '拒绝');
    reject.addEventListener('click', async () => {
      await api.rejectTransfer(transfer.uploadId, 'rejected by user').catch(() => {});
      state.transfers.delete(transfer.uploadId);
      renderInbox();
      toast('已拒绝');
    });
    actions.append(accept, reject);
  } else {
    const cancel = el('button', 'ghost', '取消');
    cancel.addEventListener('click', async () => {
      await api.cancelTransfer(transfer.uploadId).catch(() => {});
      state.transfers.delete(transfer.uploadId);
      renderInbox();
    });
    actions.append(cancel);
  }
  row.append(actions);
  return row;
}

function renderHistory() {
  els.history.replaceChildren();
  if (!state.history.length) return;
  els.history.append(el('h3', null, '最近接收'));
  for (const item of state.history) {
    const row = el('div', 'history-item');
    row.append(el('span', null, item.name));
    row.append(el('span', null, `${formatBytes(item.size)} · ${item.at.toLocaleTimeString()}`));
    els.history.append(row);
  }
}

async function loadConfig() {
  const config = await api.getConfig();
  els.cfgName.value = config.deviceName;
  els.cfgDir.value = config.downloadDir;
  els.cfgChunk.value = String(config.chunkSizeBytes);
  els.cfgConflict.value = config.conflictPolicy;
  els.cfgAccept.value = config.acceptPolicy;
  els.cfgDiscovery.value = config.discovery;
}

async function saveSettings() {
  els.saveSettings.disabled = true;
  els.settingsStatus.textContent = '保存中…';
  try {
    await api.putConfig({
      deviceName: els.cfgName.value,
      downloadDir: els.cfgDir.value,
      chunkSizeBytes: Number(els.cfgChunk.value),
      conflictPolicy: els.cfgConflict.value,
      acceptPolicy: els.cfgAccept.value,
      discovery: els.cfgDiscovery.value,
    });
    els.settingsStatus.textContent = '已保存';
    els.recvDir.textContent = els.cfgDir.value;
    toast('设置已保存,重启程序后完全生效', 'ok');
    setTimeout(() => {
      els.settingsStatus.textContent = '';
    }, 3000);
  } catch (error) {
    els.settingsStatus.textContent = `失败: ${error.message}`;
    toast(`保存失败: ${error.message}`, 'err');
  } finally {
    els.saveSettings.disabled = false;
  }
}

boot().catch((error) => {
  document.body.insertAdjacentHTML(
    'afterbegin',
    `<div class="banner">界面初始化失败: ${error.message}</div>`,
  );
});
