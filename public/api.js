const LOCAL = '';

function base(url) {
  return url.replace(/\/+$/, '');
}

async function parse(res) {
  const text = await res.text();
  let payload = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
  }
  if (!res.ok) {
    const error = new Error(payload?.error?.message || `HTTP ${res.status}`);
    error.code = payload?.error?.code || `HTTP_${res.status}`;
    error.status = res.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function json(url, options) {
  return fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) },
  }).then(parse);
}

export function getInfo() {
  return json(`${LOCAL}/api/info`);
}

export function getDevices() {
  return json(`${LOCAL}/api/devices`);
}

export function getTransfers() {
  return json(`${LOCAL}/api/transfers`);
}

export function getConfig() {
  return json(`${LOCAL}/api/config`);
}

export function putConfig(patch) {
  return json(`${LOCAL}/api/config`, { method: 'PUT', body: JSON.stringify(patch) });
}

export function registerShare(files, sourceRoot) {
  return json(`${LOCAL}/api/share`, {
    method: 'POST',
    body: JSON.stringify({ files, sourceRoot }),
  });
}

export function offerInbox(origin, payload) {
  return json(`${base(origin)}/api/inbox/offer`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function pollStatus(uploadId, origin = LOCAL) {
  return json(`${base(origin)}/api/upload/status?uploadId=${encodeURIComponent(uploadId)}`);
}

export function acceptTransfer(uploadId, origin = LOCAL) {
  return json(`${base(origin)}/api/upload/accept?uploadId=${encodeURIComponent(uploadId)}`, { method: 'POST' });
}

export function rejectTransfer(uploadId, reason, origin = LOCAL) {
  return json(
    `${base(origin)}/api/upload/reject?uploadId=${encodeURIComponent(uploadId)}&reason=${encodeURIComponent(reason || '')}`,
    { method: 'POST' },
  );
}

export function cancelTransfer(uploadId, origin = LOCAL) {
  return json(`${base(origin)}/api/upload/cancel?uploadId=${encodeURIComponent(uploadId)}`, { method: 'POST' });
}

export function completeTransfer(uploadId, origin = LOCAL) {
  return json(`${base(origin)}/api/upload/complete?uploadId=${encodeURIComponent(uploadId)}`, { method: 'POST' });
}

export function putChunk(uploadId, index, blob, { onProgress, signal, origin = LOCAL } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const url = `${base(origin)}/api/upload/chunk?uploadId=${encodeURIComponent(uploadId)}&index=${index}`;
    xhr.open('PUT', url, true);
    xhr.responseType = 'text';
    xhr.upload.onprogress = (event) => {
      if (onProgress && event.lengthComputable) onProgress(event.loaded, event.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve({ index, bytes: blob.size });
        return;
      }
      let code = `HTTP_${xhr.status}`;
      try {
        code = JSON.parse(xhr.responseText)?.error?.code || code;
      } catch {
        code = `HTTP_${xhr.status}`;
      }
      reject(Object.assign(new Error(`chunk ${index} rejected: ${code}`), { code, status: xhr.status }));
    };
    xhr.onerror = () => reject(Object.assign(new Error(`chunk ${index} network failure`), { code: 'ENETWORK' }));
    xhr.onabort = () => reject(Object.assign(new Error(`chunk ${index} canceled`), { code: 'ECANCELED' }));
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(blob);
  });
}

export async function fetchShareChunk(host, port, token, index, { signal } = {}) {
  const url = `http://${host}:${port}/api/pull/${token}/chunk?index=${index}`;
  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw Object.assign(new Error(`pull chunk ${index} failed: HTTP ${res.status}`), {
      code: 'EPULL',
      status: res.status,
    });
  }
  return res;
}

export async function shareManifest(host, port, token) {
  const res = await fetch(`http://${host}:${port}/api/pull/${token}`);
  return parse(res);
}

export function subscribeToEvents(onEvent) {
  const source = new EventSource(`${LOCAL}/api/events`);
  const names = [
    'incoming',
    'incoming-progress',
    'transfer-state',
    'transfer-progress',
    'transfer-complete',
    'transfer-rejected',
    'transfer-canceled',
    'devices',
  ];
  for (const name of names) {
    source.addEventListener(name, (event) => {
      try {
        onEvent(name, JSON.parse(event.data));
      } catch {
        onEvent(name, {});
      }
    });
  }
  source.onerror = () => onEvent('stream-error', {});
  return () => source.close();
}
