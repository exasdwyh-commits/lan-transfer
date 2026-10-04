import { Sha256 } from './sha256.js';

const HASH_SLICE_BYTES = 4 * 1024 * 1024;

export async function hashBlob(blob, onProgress) {
  const hash = new Sha256();
  let offset = 0;
  while (offset < blob.size) {
    const end = Math.min(blob.size, offset + HASH_SLICE_BYTES);
    const slice = blob.slice(offset, end);
    const buffer = await slice.arrayBuffer();
    hash.update(new Uint8Array(buffer));
    offset = end;
    onProgress?.(offset, blob.size);
  }
  return hash.digest();
}

export async function hashFile(file, onProgress) {
  return hashBlob(file, onProgress);
}

export function readEntry(entry, prefix = '') {
  return new Promise((resolve) => {
    if (!entry) {
      resolve([]);
      return;
    }
    if (entry.isFile) {
      entry.file((file) => {
        const relativePath = prefix ? `${prefix}/${file.name}` : file.name;
        resolve([{ file, relativePath }]);
      }, () => resolve([]));
      return;
    }
    if (!entry.isDirectory) {
      resolve([]);
      return;
    }
    const reader = entry.createReader();
    const found = [];
    const readBatch = () => {
      reader.readEntries(async (entries) => {
        if (entries.length === 0) {
          resolve(found.flat());
          return;
        }
        const nested = await Promise.all(
          entries.map((child) => readEntry(child, prefix ? `${prefix}/${entry.name}` : entry.name)),
        );
        found.push(...nested.flat());
        readBatch();
      }, () => resolve(found.flat()));
    };
    readBatch();
  });
}

export async function filesFromDataTransfer(dataTransfer) {
  const items = [...(dataTransfer.items || [])];
  const entries = items
    .map((item) => (typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null))
    .filter(Boolean);
  if (entries.length === 0) {
    return [...(dataTransfer.files || [])].map((file) => ({ file, relativePath: file.name }));
  }
  const groups = await Promise.all(entries.map((entry) => readEntry(entry)));
  return groups.flat();
}

export function filesFromInput(fileList) {
  return [...fileList].map((file) => ({
    file,
    relativePath: file.webkitRelativePath || file.name,
  }));
}

export function isJunkArtifact(relativePath) {
  const name = relativePath.split('/').pop().toLowerCase();
  return name === '.ds_store'
    || name === 'thumbs.db'
    || name === 'desktop.ini'
    || name.startsWith('._');
}

export function filterItems(items) {
  const seen = new Set();
  const kept = [];
  const skipped = [];
  for (const item of items) {
    const relativePath = item.relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!relativePath || isJunkArtifact(relativePath)) {
      skipped.push(relativePath || '(empty)');
      continue;
    }
    const key = relativePath.toLowerCase();
    if (seen.has(key)) {
      skipped.push(relativePath);
      continue;
    }
    seen.add(key);
    kept.push({ file: item.file, relativePath });
  }
  return { kept, skipped };
}

export function totalSize(items) {
  return items.reduce((sum, item) => sum + item.file.size, 0);
}
