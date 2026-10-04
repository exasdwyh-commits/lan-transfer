'use strict';

const MAX_JSON_BYTES = 4 * 1024 * 1024;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Lan-Transfer',
  'Access-Control-Max-Age': '600',
};

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...CORS_HEADERS,
  });
  res.end(body);
}

function sendError(res, status, code, message) {
  sendJson(res, status, { error: { code, message } });
}

function readJson(req, { limit = MAX_JSON_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > limit) {
        aborted = true;
        reject(httpError(413, 'ETOOBIG', 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(httpError(400, 'EBADJSON', 'invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function httpError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function requireFields(payload, fields) {
  for (const field of fields) {
    const value = payload[field];
    if (value === undefined || value === null || value === '') {
      throw httpError(400, 'EFIELD', `missing field: ${field}`);
    }
  }
}

function requireInteger(payload, field, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = Number(payload[field]);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw httpError(400, 'EFIELD', `${field} must be an integer in [${min}, ${max}]`);
  }
  return value;
}

function requireHash(payload, field) {
  const value = String(payload[field] || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw httpError(400, 'EFIELD', `${field} must be a 64-char lowercase sha256 hex`);
  }
  return value;
}

function clientAddress(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || '';
}

module.exports = {
  CORS_HEADERS,
  MAX_JSON_BYTES,
  clientAddress,
  httpError,
  readJson,
  requireFields,
  requireHash,
  requireInteger,
  sendError,
  sendJson,
};
