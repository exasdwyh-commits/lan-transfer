'use strict';

const dgram = require('node:dgram');
const os = require('node:os');
const crypto = require('node:crypto');

const codec = require('./dns-codec');

const MULTICAST_GROUP = '224.0.0.251';
const MDNS_PORT = 5353;
const SERVICE_TYPE = '_lantransfer._tcp.local';
const BEACON_PORT = 48221;
const BEACON_INTERVAL_MS = 4000;
const PRUNE_AFTER_MS = 16000;

function interfaceAddresses() {
  const found = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' && entry.family !== 4) continue;
      if (entry.internal) continue;
      found.push({ name, address: entry.address, netmask: entry.netmask });
    }
  }
  return found;
}

function broadcastAddresses(interfaces) {
  const targets = new Set(['255.255.255.255']);
  for (const iface of interfaces) {
    const parts = iface.address.split('.').map(Number);
    const mask = (iface.netmask || '255.255.255.0').split('.').map(Number);
    if (parts.length !== 4 || mask.length !== 4) continue;
    parts[3] = (~parts[3] & (mask[3] || 0)) + 1;
    const candidate = parts.join('.');
    if (candidate !== '0.0.0.0') targets.add(candidate);
  }
  return [...targets];
}

class Discovery {
  constructor({ deviceId, deviceName, port, mode = 'both', onChange }) {
    this.deviceId = deviceId;
    this.deviceName = deviceName;
    this.port = port;
    this.mode = mode;
    this.onChange = onChange || (() => {});
    this.devices = new Map();
    this.interfaces = interfaceAddresses();
    this.mdnsSocket = null;
    this.beaconSocket = null;
    this.mdnsHealthy = false;
    this.timers = [];
    this.sequence = 0;
    this.instanceName = `${deviceName}-${deviceId.slice(0, 6)}.${SERVICE_TYPE}`;
    this.log = [];
  }

  note(level, message) {
    this.log.push({ level, message, at: Date.now() });
    if (this.log.length > 50) this.log.shift();
  }

  async start() {
    if (this.mode === 'off') return;
    if (this.mode === 'mdns' || this.mode === 'both') {
      await this.startMdns().catch((error) => {
        this.note('warn', `mDNS unavailable: ${error.message}`);
      });
    }
    if (this.mode === 'beacon' || this.mode === 'both') {
      await this.startBeacon().catch((error) => {
        this.note('warn', `beacon unavailable: ${error.message}`);
      });
    }
    if (this.mode === 'mdns' && !this.mdnsHealthy) {
      await this.startBeacon().catch(() => {});
    }
  }

  async startMdns() {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    await bind(socket, MDNS_PORT);
    socket.setMulticastTTL(255);
    socket.setMulticastLoopback(true);
    for (const iface of this.interfaces) {
      try {
        socket.addMembership(MULTICAST_GROUP, iface.address);
      } catch (error) {
        this.note('warn', `addMembership(${iface.address}) failed: ${error.message}`);
      }
    }
    socket.on('message', (message, remote) => this.handleMdnsMessage(message, remote));
    socket.on('error', (error) => {
      this.note('warn', `mDNS socket error: ${error.message}`);
    });
    this.mdnsSocket = socket;
    this.mdnsHealthy = true;
    this.note('info', 'mDNS responder active on 224.0.0.251:5353');
    this.announce();
    this.query();
    this.timers.push(setInterval(() => {
      this.announce();
      this.query();
    }, BEACON_INTERVAL_MS));
    return socket;
  }

  async startBeacon() {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    await bind(socket, BEACON_PORT);
    socket.on('message', (message, remote) => this.handleBeaconMessage(message, remote));
    socket.on('error', (error) => {
      this.note('warn', `beacon socket error: ${error.message}`);
    });
    this.beaconSocket = socket;
    this.note('info', `UDP broadcast beacon active on ${BEACON_PORT}`);
    this.broadcastBeacon();
    this.timers.push(setInterval(() => this.broadcastBeacon(), BEACON_INTERVAL_MS));
    this.timers.push(setInterval(() => this.prune(), 4000));
    return socket;
  }

  announce() {
    if (!this.mdnsSocket) return;
    const addresses = this.interfaces.map((iface) => iface.address);
    const answers = [{ kind: 'PTR', name: SERVICE_TYPE, target: this.instanceName }];
    const additionals = [
      { kind: 'SRV', name: this.instanceName, port: this.port, target: `${this.deviceId}.local` },
      {
        kind: 'TXT',
        name: this.instanceName,
        entries: [`id=${this.deviceId}`, `name=${this.deviceName}`, `port=${this.port}`, `v=1`],
      },
    ];
    for (const address of addresses) {
      additionals.push({ kind: 'A', name: `${this.deviceId}.local`, address });
    }
    const packet = codec.encodeResponse({ id: 0, questions: [], answers, additionals });
    this.sendMdns(packet);
  }

  query() {
    if (!this.mdnsSocket) return;
    const packet = codec.encodeQuery({ name: SERVICE_TYPE, type: codec.TYPE.PTR, id: (this.sequence += 1) & 0xffff });
    this.sendMdns(packet);
  }

  sendMdns(buffer) {
    const targets = [
      { address: MULTICAST_GROUP, port: MDNS_PORT },
      { address: '255.255.255.255', port: MDNS_PORT },
    ];
    for (const target of targets) {
      this.mdnsSocket.send(buffer, target.port, target.address, () => {});
    }
  }

  handleMdnsMessage(message, remote) {
    let parsed;
    try {
      parsed = codec.decodeMessage(message);
    } catch {
      return;
    }
    if (!parsed.isResponse) {
      const asksUs = parsed.questions.some(
        (question) => question.name === SERVICE_TYPE && question.type === codec.TYPE.PTR,
      );
      if (asksUs) this.announce();
      return;
    }
    const ptr = parsed.records.find(
      (record) => record.type === codec.TYPE.PTR && record.name === SERVICE_TYPE,
    );
    if (!ptr) return;
    this.absorbMdns(ptr.target, parsed.records, remote.address);
  }

  absorbMdns(instanceName, records, fallbackAddress) {
    const srv = records.find(
      (record) => record.type === codec.TYPE.SRV && record.name === instanceName,
    );
    const txt = records.find(
      (record) => record.type === codec.TYPE.TXT && record.name === instanceName,
    );
    if (!srv) return;
    const fields = parseTxt(txt ? txt.entries : []);
    const id = fields.id || fallbackId(instanceName);
    if (id === this.deviceId) return;
    const target = srv.target || '';
    const addresses = [];
    for (const record of records) {
      if (record.type === codec.TYPE.A && record.name === target) addresses.push(record.address);
      if (record.type === codec.TYPE.A && record.name === instanceName) addresses.push(record.address);
    }
    if (addresses.length === 0 && target.endsWith('.local')) addresses.push(target);
    const unique = [...new Set(addresses)];
    const resolved = unique.length ? unique : [fallbackAddress];
    this.upsert({
      id,
      name: fields.name || instanceName.split('.')[0],
      port: srv.port,
      addresses: resolved,
      source: 'mdns',
    });
  }

  broadcastBeacon() {
    if (!this.beaconSocket) return;
    const payload = Buffer.from(
      JSON.stringify({
        t: 'lan-transfer',
        id: this.deviceId,
        name: this.deviceName,
        port: this.port,
        addresses: this.interfaces.map((iface) => iface.address),
        at: Date.now(),
      }),
      'utf8',
    );
    for (const address of broadcastAddresses(this.interfaces)) {
      this.beaconSocket.send(payload, BEACON_PORT, address, () => {});
    }
  }

  handleBeaconMessage(message, remote) {
    let parsed;
    try {
      parsed = JSON.parse(message.toString('utf8'));
    } catch {
      return;
    }
    if (parsed.t !== 'lan-transfer' || !parsed.id || parsed.id === this.deviceId) return;
    if (!Number.isInteger(parsed.port)) return;
    const addresses = Array.isArray(parsed.addresses) && parsed.addresses.length
      ? parsed.addresses
      : [remote.address];
    this.upsert({
      id: parsed.id,
      name: String(parsed.name || 'device'),
      port: parsed.port,
      addresses: [...new Set(addresses)],
      source: 'beacon',
    });
  }

  upsert(device) {
    const existing = this.devices.get(device.id);
    const now = Date.now();
    const merged = {
      id: device.id,
      name: device.name,
      port: device.port,
      addresses: device.addresses,
      source: device.source,
      firstSeen: existing ? existing.firstSeen : now,
      lastSeen: now,
    };
    this.devices.set(device.id, merged);
    this.onChange(this.list());
  }

  prune() {
    const now = Date.now();
    let changed = false;
    for (const [id, device] of [...this.devices]) {
      if (now - device.lastSeen > PRUNE_AFTER_MS) {
        this.devices.delete(id);
        changed = true;
      }
    }
    if (changed) this.onChange(this.list());
  }

  list() {
    return [...this.devices.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((device) => ({ ...device, addresses: [...device.addresses] }));
  }

  async close() {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    for (const socket of [this.mdnsSocket, this.beaconSocket]) {
      if (!socket) continue;
      await new Promise((resolve) => socket.close(resolve));
    }
    this.mdnsSocket = null;
    this.beaconSocket = null;
  }
}

function parseTxt(entries) {
  const fields = {};
  for (const entry of entries) {
    const index = entry.indexOf('=');
    if (index === -1) continue;
    fields[entry.slice(0, index)] = entry.slice(index + 1);
  }
  return fields;
}

function fallbackId(instanceName) {
  return crypto.createHash('sha1').update(instanceName).digest('hex').slice(0, 16);
}

function bind(socket, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      socket.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      socket.removeListener('error', onError);
      resolve();
    };
    socket.once('error', onError);
    socket.once('listening', onListening);
    socket.bind({ port, exclusive: false });
  });
}

module.exports = {
  BEACON_PORT,
  Discovery,
  MDNS_PORT,
  SERVICE_TYPE,
  broadcastAddresses,
  interfaceAddresses,
};
