'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { PathAllocator, randomSuffix, resolveWithinRoot } = require('./safepath');

async function pathExists(target) {
  try {
    await fsp.lstat(target);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function removeIfPresent(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function ensureDirectory(target) {
  await fsp.mkdir(target, { recursive: true });
}

class SafeWriter {
  constructor(rootDir, { overwrite = 'rename' } = {}) {
    this.rootDir = path.resolve(rootDir);
    this.overwrite = overwrite;
    this.allocator = new PathAllocator();
    this.claimed = new Set();
  }

  get caseSensitive() {
    return this.allocator.caseSensitive;
  }

  claim(relativePath) {
    const result = this.allocator.reserve(relativePath);
    this.claimed.add(this.allocator.foldKey(result.path));
    return result.path;
  }

  async findCaseVariant(directory, basename) {
    let entries;
    try {
      entries = await fsp.readdir(directory);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
      throw error;
    }
    if (this.caseSensitive) return null;
    const wanted = this.allocator.foldKey(basename);
    const match = entries.find((entry) => this.allocator.foldKey(entry) === wanted);
    return match === undefined ? null : path.join(directory, match);
  }

  async occupied(absolute) {
    if (this.claimed.has(this.allocator.foldKey(absolute))) return false;
    if (await pathExists(absolute)) return true;
    const variant = await this.findCaseVariant(path.dirname(absolute), path.basename(absolute));
    return variant !== null;
  }

  async resolveFinalPath(relativePath) {
    const claimedRelative = this.claim(relativePath);
    const absolute = resolveWithinRoot(this.rootDir, claimedRelative);
    if (this.overwrite === 'overwrite') return absolute;
    if (!(await this.occupied(absolute))) return absolute;
    return this.findFreeName(absolute);
  }

  async findFreeName(absolute) {
    const directory = path.dirname(absolute);
    const extension = path.extname(absolute);
    const stem = path.basename(absolute, extension);
    for (let counter = 2; counter < 10000; counter += 1) {
      const candidate = path.join(directory, `${stem} (${counter})${extension}`);
      if (!(await this.occupied(candidate))) {
        this.claimed.add(this.allocator.foldKey(candidate));
        return candidate;
      }
    }
    const fallback = path.join(directory, `${stem}-${randomSuffix()}${extension}`);
    this.claimed.add(this.allocator.foldKey(fallback));
    return fallback;
  }

  stagingPathFor(finalPath) {
    return path.join(
      path.dirname(finalPath),
      `.${path.basename(finalPath)}.incoming-${randomSuffix()}`,
    );
  }

  async commit(stagingFile, finalPath) {
    await ensureDirectory(path.dirname(finalPath));
    try {
      await fsp.rename(stagingFile, finalPath);
    } catch (error) {
      if (error.code !== 'EXDEV') throw error;
      await fsp.copyFile(stagingFile, finalPath);
      removeIfPresent(stagingFile);
    }
    return finalPath;
  }
}

module.exports = { SafeWriter, ensureDirectory, pathExists, removeIfPresent };