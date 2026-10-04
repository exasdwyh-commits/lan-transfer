'use strict';

const os = require('node:os');
const path = require('node:path');

const { AppConfig } = require('../src/config');
const { start, localAddresses } = require('../src/http/server');

function parseArgs(argv) {
  const options = {
    port: null,
    host: '0.0.0.0',
    dir: null,
    name: null,
    discovery: null,
    noDiscovery: false,
    save: false,
    open: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[(index += 1)];
    switch (arg) {
      case '-p':
      case '--port':
        options.port = Number(next());
        break;
      case '-H':
      case '--host':
        options.host = String(next());
        break;
      case '-d':
      case '--dir':
        options.dir = String(next());
        break;
      case '-n':
      case '--name':
        options.name = String(next());
        break;
      case '--discovery':
        options.discovery = String(next());
        break;
      case '--no-discovery':
        options.noDiscovery = true;
        break;
      case '--save':
        options.save = true;
        break;
      case '--open':
        options.open = true;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      default:
        if (arg.startsWith('-')) {
          throw new Error(`unknown flag: ${arg}`);
        }
    }
  }
  return options;
}

function usage() {
  return `lan-transfer 局域网文件传输 (macOS <-> Windows)

用法:
  lan-transfer [选项]

选项:
  -p, --port <端口>        监听端口, 默认 47831
  -H, --host <地址>        监听地址, 默认 0.0.0.0 (所有网卡)
  -d, --dir <目录>         接收文件的保存目录, 默认 ~/Downloads/LANTransfer
  -n, --name <名称>        本机在设备列表中显示的名称, 默认为计算机名
      --discovery <模式>   mdns | beacon | both | off, 默认 both
      --no-discovery       关闭设备自动发现
      --save               把本次参数写入配置文件
      --open               启动后自动用默认浏览器打开
  -h, --help               显示本帮助

说明:
  启动后在另一台电脑的浏览器里打开下面任意一个地址即可。
  两台设备都跑本程序, 就能在界面里互相看到对方并直接拖拽传输。
`;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${usage()}`);
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  const overrides = {};
  if (options.port !== null) overrides.port = options.port;
  if (options.dir) overrides.downloadDir = path.resolve(os.homedir(), options.dir.replace(/^~/, os.homedir()));
  if (options.name) overrides.deviceName = options.name;
  if (options.discovery) overrides.discovery = options.discovery;
  if (options.noDiscovery) overrides.discovery = 'off';

  const config = AppConfig.load({ overrides });
  if (options.save) config.save();

  const app = await start({ config, port: options.port ?? undefined, host: options.host });

  const addresses = localAddresses();
  const info = {
    deviceName: config.get('deviceName'),
    deviceId: config.deviceId(),
    port: app.port,
    downloadDir: config.get('downloadDir'),
    discovery: config.get('discovery'),
    mdnsHealthy: app.ctx.discovery ? app.ctx.discovery.mdnsHealthy : false,
  };

  const line = '─'.repeat(58);
  process.stdout.write(`\n${line}\n  局域网文件传输已启动\n${line}\n`);
  process.stdout.write(`  本机名称   ${info.deviceName}\n`);
  process.stdout.write(`  保存目录   ${info.downloadDir}\n`);
  process.stdout.write(`  设备发现   ${info.discovery}${info.mdnsHealthy ? ' (mDNS 已就绪)' : ' (仅广播兜底)'}\n`);
  if (addresses.length === 0) {
    process.stdout.write('  访问地址   未检测到局域网网卡,请检查网络连接\n');
  } else {
    for (const address of addresses) {
      process.stdout.write(`  访问地址   http://${address}:${info.port}\n`);
    }
  }
  process.stdout.write(`  本机访问   http://127.0.0.1:${info.port}\n`);
  process.stdout.write(`${line}\n  在另一台电脑的浏览器打开上面的地址即可。\n  按 Ctrl+C 停止。\n${line}\n\n`);

  if (options.open) openBrowser(`http://127.0.0.1:${info.port}`);

  const shutdown = async (signal) => {
    process.stdout.write(`\n收到 ${signal},正在退出...\n`);
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

function openBrowser(url) {
  const { spawn } = require('node:child_process');
  const command = process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32'
      ? 'cmd'
      : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(command, args, { stdio: 'ignore', detached: true }).unref();
}

main().catch((error) => {
  process.stderr.write(`启动失败: ${error.message}\n`);
  if (error.code === 'EADDRINUSE') {
    process.stderr.write('端口已被占用,换个端口重试: lan-transfer -p 47832\n');
  }
  process.exit(1);
});
