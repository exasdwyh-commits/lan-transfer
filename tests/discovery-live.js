'use strict';

const { Discovery } = require('../src/discovery/discovery');

function makePeer(name, port) {
  const peer = new Discovery({
    deviceId: name.toLowerCase().padEnd(16, '0'),
    deviceName: name,
    port,
    onChange: () => {},
  });
  return peer;
}

async function main() {
  const a = makePeer('Alpha', 40001);
  const b = makePeer('Bravo', 40002);
  await a.start();
  await b.start();

  const deadline = Date.now() + 12000;
  let seen = 0;
  while (Date.now() < deadline) {
    const devices = [...a.list(), ...b.list()];
    const aSeesB = a.list().some((device) => device.name === 'Bravo');
    const bSeesA = b.list().some((device) => device.name === 'Alpha');
    process.stdout.write(
      `\r A sees: ${a.list().map((d) => d.name).join(',') || '-'}  |  B sees: ${b.list().map((d) => d.name).join(',') || '-'}   `,
    );
    if (aSeesB && bSeesA) {
      console.log('\n\nPASS mutual discovery');
      console.log(JSON.stringify(a.list(), null, 2));
      seen = 1;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!seen) {
    console.log('\n\nFAIL no mutual discovery');
    console.log('A log:', a.log.map((l) => l.message).join(' | '));
    console.log('B log:', b.log.map((l) => l.message).join(' | '));
  }
  await a.close();
  await b.close();
  process.exit(seen ? 0 : 1);
}

main();
