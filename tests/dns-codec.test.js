'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const codec = require('../src/discovery/dns-codec');

function roundTrip(buffer) {
  return codec.decodeMessage(buffer);
}

test('encodes a PTR query that decodes back byte-exact', () => {
  const buffer = codec.encodeQuery({ name: '_lantransfer._tcp.local', type: codec.TYPE.PTR, id: 0x1234 });
  const parsed = roundTrip(buffer);
  assert.equal(parsed.id, 0x1234);
  assert.equal(parsed.isResponse, false);
  assert.equal(parsed.questions.length, 1);
  assert.equal(parsed.questions[0].name, '_lantransfer._tcp.local');
  assert.equal(parsed.questions[0].type, codec.TYPE.PTR);
  assert.equal(parsed.questions[0].class, codec.CLASS_IN);
  assert.equal(parsed.records.length, 0);
});

test('encodes every label length as a single byte', () => {
  const buffer = codec.encodeQuery({ name: 'a'.repeat(63) + '.local', type: codec.TYPE.ANY, id: 1 });
  assert.equal(buffer[12], 63);
  const parsed = roundTrip(buffer);
  assert.equal(parsed.questions[0].name, `${'a'.repeat(63)}.local`);
});

test('rejects a label longer than 63 bytes', () => {
  assert.throws(() => codec.encodeQuery({ name: 'a'.repeat(64), type: codec.TYPE.A, id: 1 }), RangeError);
});

test('round-trips a full announcement with PTR, SRV, TXT and A records', () => {
  const buffer = codec.encodeResponse({
    id: 42,
    questions: [{ name: '_lantransfer._tcp.local', type: codec.TYPE.PTR }],
    answers: [{ kind: 'PTR', name: '_lantransfer._tcp.local', target: 'mac-abc123._lantransfer._tcp.local' }],
    additionals: [
      { kind: 'SRV', name: 'mac-abc123._lantransfer._tcp.local', port: 47831, target: 'abc123.local' },
      { kind: 'TXT', name: 'mac-abc123._lantransfer._tcp.local', entries: ['id=abc123', 'name=MacBook-Pro'] },
      { kind: 'A', name: 'abc123.local', address: '192.168.1.42' },
    ],
  });

  const parsed = roundTrip(buffer);
  assert.equal(parsed.id, 42);
  assert.equal(parsed.isResponse, true);

  const ptr = parsed.records.find((record) => record.type === codec.TYPE.PTR);
  assert.equal(ptr.target, 'mac-abc123._lantransfer._tcp.local');

  const srv = parsed.records.find((record) => record.type === codec.TYPE.SRV);
  assert.equal(srv.port, 47831);
  assert.equal(srv.target, 'abc123.local');

  const txt = parsed.records.find((record) => record.type === codec.TYPE.TXT);
  assert.deepEqual(txt.entries, ['id=abc123', 'name=MacBook-Pro']);

  const a = parsed.records.find((record) => record.type === codec.TYPE.A);
  assert.equal(a.address, '192.168.1.42');
});

test('decodes multi-entry TXT values including CJK', () => {
  const buffer = codec.encodeResponse({
    id: 1,
    answers: [{ kind: 'TXT', name: 'x._lantransfer._tcp.local', entries: ['name=我的电脑', 'id=deadbeef'] }],
  });
  const parsed = roundTrip(buffer);
  const txt = parsed.records.find((record) => record.type === codec.TYPE.TXT);
  assert.deepEqual(txt.entries, ['name=我的电脑', 'id=deadbeef']);
});

test('lower-cases decoded names for stable comparison', () => {
  const buffer = codec.encodeResponse({
    id: 1,
    answers: [{ kind: 'PTR', name: '_LanTransfer._TCP.local', target: 'Mac._LanTransfer._TCP.local' }],
  });
  const parsed = roundTrip(buffer);
  assert.equal(parsed.records[0].name, '_lantransfer._tcp.local');
  assert.equal(parsed.records[0].target, 'mac._lantransfer._tcp.local');
});

function compressionPacket(pointerTarget) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(1, 0);
  header.writeUInt16BE(0x8000, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(1, 6);
  const questionName = Buffer.from([5, ...Buffer.from('local', 'ascii'), 0]);
  const question = Buffer.concat([
    questionName,
    Buffer.from([0, codec.TYPE.PTR]),
    Buffer.from([0, codec.CLASS_IN]),
  ]);
  const record = Buffer.concat([
    Buffer.from([8, ...Buffer.from('myalias1', 'ascii'), 0xc0, pointerTarget]),
    Buffer.from([0, codec.TYPE.A, 0, codec.CLASS_IN]),
    Buffer.from([0, 0, 0, 120]),
    Buffer.from([0, 0]),
  ]);
  return Buffer.concat([header, question, record]);
}

test('follows name-compression pointers when parsing', () => {
  const parsed = roundTrip(compressionPacket(12));
  assert.equal(parsed.truncated, false);
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.records[0].name, 'myalias1.local');
});

test('refuses a forward compression pointer instead of looping', () => {
  const parsed = roundTrip(compressionPacket(30));
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.records.length, 0);
});

test('survives a truncated packet instead of throwing', () => {
  const buffer = codec.encodeQuery({ name: '_lantransfer._tcp.local', type: codec.TYPE.PTR, id: 9 });
  const truncated = buffer.subarray(0, 16);
  assert.doesNotThrow(() => roundTrip(truncated));
  assert.doesNotThrow(() => roundTrip(Buffer.from([0, 1, 0])));
  assert.doesNotThrow(() => roundTrip(Buffer.alloc(0)));
});

test('rejects malformed IPv4 address data', () => {
  assert.throws(() => codec.encodeARecord(new codec.Writer(), { name: 'x.local', address: 'not-an-ip' }), RangeError);
});

test('records carry the ttl the sender declared', () => {
  const buffer = codec.encodeResponse({
    id: 1,
    answers: [{ kind: 'A', name: 'x.local', address: '10.0.0.5', ttl: 120 }],
  });
  assert.equal(roundTrip(buffer).records[0].ttl, 120);
});

test('decode tolerates an unknown record type by skipping it', () => {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(1, 0);
  header.writeUInt16BE(0x8000, 2);
  header.writeUInt16BE(1, 6);
  const record = Buffer.concat([
    Buffer.from([1, 120, 0]),
    Buffer.from([0, 99, 0, codec.CLASS_IN]),
    Buffer.from([0, 0, 0, 60]),
    Buffer.from([0, 2, 0xde, 0xad]),
  ]);
  const parsed = roundTrip(Buffer.concat([header, record]));
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.records[0].type, 99);
});
