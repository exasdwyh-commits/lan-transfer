const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const HEX = [];
for (let i = 0; i < 256; i += 1) {
  HEX.push(i.toString(16).padStart(2, '0'));
}

function rotr(value, bits) {
  return (value >>> bits) | (value << (32 - bits));
}

export class Sha256 {
  constructor() {
    this.state = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
    this.tail = new Uint8Array(64);
    this.tailLength = 0;
    this.total = 0;
    this.words = new Uint32Array(64);
    this.closed = false;
  }

  update(data) {
    if (this.closed) throw new Error('Sha256 already finalized');
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.total += bytes.length;
    let offset = 0;

    if (this.tailLength > 0) {
      const need = 64 - this.tailLength;
      if (bytes.length < need) {
        this.tail.set(bytes, this.tailLength);
        this.tailLength += bytes.length;
        return this;
      }
      this.tail.set(bytes.subarray(0, need), this.tailLength);
      this.compress(this.tail, 0);
      this.tailLength = 0;
      offset = need;
    }

    while (offset + 64 <= bytes.length) {
      this.compress(bytes, offset);
      offset += 64;
    }

    if (offset < bytes.length) {
      this.tail.set(bytes.subarray(offset), 0);
      this.tailLength = bytes.length - offset;
    }
    return this;
  }

  compress(block, offset) {
    const w = this.words;
    for (let i = 0; i < 16; i += 1) {
      const p = offset + i * 4;
      w[i] = (block[p] << 24) | (block[p + 1] << 16) | (block[p + 2] << 8) | block[p + 3];
    }
    for (let i = 16; i < 64; i += 1) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }

    let [a, b, c, d, e, f, g, h] = this.state;
    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i] + w[i]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }

    this.state[0] = (this.state[0] + a) | 0;
    this.state[1] = (this.state[1] + b) | 0;
    this.state[2] = (this.state[2] + c) | 0;
    this.state[3] = (this.state[3] + d) | 0;
    this.state[4] = (this.state[4] + e) | 0;
    this.state[5] = (this.state[5] + f) | 0;
    this.state[6] = (this.state[6] + g) | 0;
    this.state[7] = (this.state[7] + h) | 0;
  }

  digest() {
    if (this.closed) throw new Error('Sha256 already finalized');
    this.closed = true;
    const bitLength = this.total * 8;
    const padLength = this.tailLength < 56 ? 56 - this.tailLength : 120 - this.tailLength;
    const padding = new Uint8Array(padLength + 8);
    padding[0] = 0x80;
    const view = new DataView(padding.buffer);
    view.setUint32(padLength, Math.floor(bitLength / 0x100000000), false);
    view.setUint32(padLength + 4, bitLength >>> 0, false);
    const combined = new Uint8Array(this.tailLength + padding.length);
    combined.set(this.tail.subarray(0, this.tailLength), 0);
    combined.set(padding, this.tailLength);

    const savedTotal = this.total;
    let cursor = 0;
    while (cursor + 64 <= combined.length) {
      this.compress(combined, cursor);
      cursor += 64;
    }
    this.total = savedTotal;

    let hex = '';
    for (let i = 0; i < 8; i += 1) {
      const value = this.state[i] >>> 0;
      hex += HEX[(value >>> 24) & 0xff] + HEX[(value >>> 16) & 0xff]
        + HEX[(value >>> 8) & 0xff] + HEX[value & 0xff];
    }
    return hex;
  }
}

export function bytesToHex(bytes) {
  let hex = '';
  for (let i = 0; i < bytes.length; i += 1) {
    hex += HEX[bytes[i]];
  }
  return hex;
}
