'use strict';

const REPLAY_LIMIT = 200;

function writeFrame({ event, data, id }) {
  let frame = '';
  if (id !== undefined) frame += `id: ${id}\n`;
  frame += `event: ${event}\n`;
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  for (const line of String(payload).split('\n')) frame += `data: ${line}\n`;
  return `${frame}\n`;
}

class EventHub {
  constructor({ replayLimit = REPLAY_LIMIT } = {}) {
    this.replayLimit = replayLimit;
    this.clients = new Set();
    this.replay = [];
    this.nextId = 1;
    this.nextClientId = 1;
  }

  handleEventStream(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    let warm = '';
    for (const entry of this.replay) warm += writeFrame(entry);
    res.write(warm || ': replay-empty\n\n');

    const client = { id: this.nextClientId++, res };
    this.clients.add(client);

    const heartbeat = setInterval(() => {
      try {
        res.write(`: ping ${Date.now()}\n\n`);
      } catch {
        cleanup();
      }
    }, 20000);
    heartbeat.unref?.();

    function cleanup() {
      clearInterval(heartbeat);
      this.clients.delete(client);
    }
    const cleanupBound = cleanup.bind(this);
    req.on('close', cleanupBound);
    req.on('error', cleanupBound);
    res.on('error', cleanupBound);
    res.on('close', cleanupBound);
  }

  broadcast(event, data) {
    const entry = { event, data, id: this.nextId++ };
    this.replay.push(entry);
    if (this.replay.length > this.replayLimit) this.replay.shift();
    const frame = writeFrame(entry);
    for (const client of [...this.clients]) {
      try {
        client.res.write(frame);
      } catch {
        this.clients.delete(client);
      }
    }
    return entry.id;
  }

  clientCount() {
    return this.clients.size;
  }

  closeAll() {
    for (const client of [...this.clients]) {
      try {
        client.res.end();
      } catch {
        this.clients.delete(client);
      }
    }
    this.clients.clear();
  }
}

module.exports = { EventHub };
