'use strict';

const TYPE = {
  A: 1,
  PTR: 12,
  TXT: 16,
  SRV: 33,
  ANY: 255,
};

const CLASS_IN = 1;
const CLASS_ANY = 255;

class Reader {
  constructor(buffer, start = 0) {
    this.buffer = buffer;
    this.offset = start;
  }

  get remaining() {
    return this.buffer.length - this.offset;
  }

  u8() {
    if (this.remaining < 1) throw new RangeError('dns: truncated u8');
    const value = this.buffer[this.offset];
    this.offset += 1;
    return value;
  }

  u16() {
    if (this.remaining < 2) throw new RangeError('dns: truncated u16');
    const value = this.buffer.readUInt16BE(this.offset);
    this.offset += 2;
    return value;
  }

  u32() {
    if (this.remaining < 4) throw new RangeError('dns: truncated u32');
    const value = this.buffer.readUInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  bytes(length) {
    if (this.remaining < length) throw new RangeError('dns: truncated bytes');
    const slice = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }

  name() {
    const labels = [];
    let cursor = this.offset;
    let jumped = false;
    let guard = 0;
    for (;;) {
      if (cursor >= this.buffer.length) throw new RangeError('dns: truncated name');
      const length = this.buffer[cursor];
      if (length === 0) {
        cursor += 1;
        if (!jumped) this.offset = cursor;
        break;
      }
      if ((length & 0xc0) === 0xc0) {
        if (cursor + 1 >= this.buffer.length) throw new RangeError('dns: truncated pointer');
        const pointer = ((length & 0x3f) << 8) | this.buffer[cursor + 1];
        if (!jumped) this.offset = cursor + 2;
        jumped = true;
        if (pointer >= cursor) throw new RangeError('dns: forward compression pointer');
        cursor = pointer;
        if ((guard += 1) > 64) throw new RangeError('dns: name pointer loop');
        continue;
      }
      const start = cursor + 1;
      const end = start + length;
      if (end > this.buffer.length) throw new RangeError('dns: truncated label');
      labels.push(this.buffer.subarray(start, end).toString('utf8'));
      cursor = end;
    }
    return labels.join('.').toLowerCase();
  }
}

class Writer {
  constructor() {
    this.chunks = [];
    this.length = 0;
  }

  raw(buffer) {
    this.chunks.push(buffer);
    this.length += buffer.length;
    return this;
  }

  u8(value) {
    const buffer = Buffer.allocUnsafe(1);
    buffer.writeUInt8(value & 0xff, 0);
    return this.raw(buffer);
  }

  u16(value) {
    const buffer = Buffer.allocUnsafe(2);
    buffer.writeUInt16BE(value & 0xffff, 0);
    return this.raw(buffer);
  }

  u32(value) {
    const buffer = Buffer.allocUnsafe(4);
    buffer.writeUInt32BE(value >>> 0, 0);
    return this.raw(buffer);
  }

  name(name, { compress = false } = {}) {
    const labels = String(name).split('.').filter((label) => label.length > 0);
    for (const label of labels) {
      const encoded = Buffer.from(label, 'utf8');
      if (encoded.length > 63) throw new RangeError('dns: label too long');
      this.u8(encoded.length);
      this.raw(encoded);
    }
    return this.u8(0);
  }

  record({ name, type, ttl = 120, rdata }) {
    this.name(name);
    this.u16(type).u16(CLASS_IN).u32(ttl);
    const lengthBuffer = Buffer.allocUnsafe(2);
    lengthBuffer.writeUInt16BE(rdata.length, 0);
    this.raw(lengthBuffer);
    return this.raw(rdata);
  }

  toBuffer() {
    return Buffer.concat(this.chunks, this.length);
  }
}

function encodeQuestion(writer, { name, type }) {
  writer.name(name);
  writer.u16(type).u16(CLASS_IN);
}

function encodeARecord(writer, { name, address, ttl = 120 }) {
  const rdata = Buffer.from(address.split('.').map((part) => Number(part) & 0xff));
  if (rdata.length !== 4) throw new RangeError('dns: ipv4 required');
  writer.record({ name, type: TYPE.A, ttl, rdata });
}

function encodePTRRecord(writer, { name, target, ttl = 4500 }) {
  const nested = new Writer();
  nested.name(target);
  writer.record({ name, type: TYPE.PTR, ttl, rdata: nested.toBuffer() });
}

function encodeSRVRecord(writer, { name, port, target, ttl = 120 }) {
  const nested = new Writer();
  nested.u16(0).u16(0).u16(port);
  nested.name(target);
  writer.record({ name, type: TYPE.SRV, ttl, rdata: nested.toBuffer() });
}

function encodeTXTRecord(writer, { name, entries, ttl = 4500 }) {
  const nested = new Writer();
  for (const entry of entries) {
    const encoded = Buffer.from(entry, 'utf8');
    if (encoded.length > 255) throw new RangeError('dns: txt entry too long');
    nested.u8(encoded.length);
    nested.raw(encoded);
  }
  writer.record({ name, type: TYPE.TXT, ttl, rdata: nested.toBuffer() });
}

function decodeTxt(rdata) {
  const reader = new Reader(rdata);
  const entries = [];
  while (reader.remaining > 0) {
    const length = reader.u8();
    entries.push(reader.bytes(length).toString('utf8'));
  }
  return entries;
}

function decodeSrv(rdata) {
  const reader = new Reader(rdata);
  reader.u16();
  reader.u16();
  const port = reader.u16();
  return { port, target: reader.name() };
}

function decodeMessage(buffer) {
  const reader = new Reader(buffer);
  if (reader.remaining < 12) {
    return { id: 0, flags: 0, isResponse: false, questions: [], records: [], truncated: true };
  }
  const id = reader.u16();
  const flags = reader.u16();
  const counts = {
    questions: reader.u16(),
    answers: reader.u16(),
    authorities: reader.u16(),
    additionals: reader.u16(),
  };

  const questions = [];
  for (let i = 0; i < counts.questions; i += 1) {
    try {
      questions.push({ name: reader.name(), type: reader.u16(), class: reader.u16() });
    } catch {
      return { id, flags, isResponse: (flags & 0x8000) !== 0, questions, records: [], truncated: true };
    }
  }

  const records = [];
  const total = counts.answers + counts.authorities + counts.additionals;
  let truncated = false;
  for (let i = 0; i < total; i += 1) {
    let record;
    try {
      record = {
        name: reader.name(),
        type: reader.u16(),
        class: reader.u16(),
        ttl: reader.u32(),
        dataLength: reader.u16(),
      };
      const rdata = reader.bytes(record.dataLength);
      record.rdata = rdata;
      if (record.type === TYPE.A) {
        record.address = [...rdata].join('.');
      } else if (record.type === TYPE.PTR) {
        record.target = new Reader(rdata).name();
      } else if (record.type === TYPE.SRV) {
        Object.assign(record, decodeSrv(rdata));
      } else if (record.type === TYPE.TXT) {
        record.entries = decodeTxt(rdata);
      }
    } catch {
      truncated = true;
      break;
    }
    records.push(record);
  }

  return {
    id,
    flags,
    isResponse: (flags & 0x8000) !== 0,
    questions,
    records,
    truncated,
  };
}

function encodeQuery({ name, type, id }) {
  const writer = new Writer();
  writer.u16(id).u16(0).u16(1).u16(0).u16(0).u16(0);
  encodeQuestion(writer, { name, type });
  return writer.toBuffer();
}

function encodeResponse({ id, questions = [], answers = [], additionals = [] }) {
  const writer = new Writer();
  writer
    .u16(id)
    .u16(0x8400)
    .u16(questions.length)
    .u16(answers.length + additionals.length)
    .u16(0)
    .u16(additionals.length);
  for (const question of questions) encodeQuestion(writer, question);
  for (const answer of answers) writeRecord(writer, answer);
  for (const additional of additionals) writeRecord(writer, additional);
  return writer.toBuffer();
}

function writeRecord(writer, record) {
  if (record.kind === 'A') {
    encodeARecord(writer, record);
  } else if (record.kind === 'PTR') {
    encodePTRRecord(writer, record);
  } else if (record.kind === 'SRV') {
    encodeSRVRecord(writer, record);
  } else if (record.kind === 'TXT') {
    encodeTXTRecord(writer, record);
  } else {
    throw new RangeError(`dns: unsupported record ${record.kind}`);
  }
}

module.exports = {
  CLASS_IN,
  TYPE,
  Writer,
  decodeMessage,
  encodeARecord,
  encodeQuery,
  encodeResponse,
};
