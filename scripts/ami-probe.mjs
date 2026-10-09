import net from 'node:net';

const host = process.argv[2];
const port = Number(process.argv[3] ?? 5038);
const user = process.argv[4];
const secret = process.argv[5]; // never printed

const sock = net.createConnection({ host, port });
sock.setTimeout(7000);

let buffer = '';
const log = [];

function drain() {
  let idx = buffer.search(/\r?\n\r?\n/);
  while (idx !== -1) {
    const block = buffer.slice(0, idx).replace(/Secret:.*/i, 'Secret: <redacted>');
    log.push(block);
    buffer = buffer.slice(idx + 2);
    idx = buffer.search(/\r?\n\r?\n/);
  }
}

async function main() {
  sock.on('data', (d) => { buffer += d.toString('utf8'); drain(); });
  await new Promise((resolve, reject) => {
    sock.once('connect', resolve);
    sock.once('error', reject);
    sock.once('timeout', () => reject(new Error('connect timeout')));
  });
  await new Promise((r) => setTimeout(r, 800));



  const send = (action, extra = {}) => {
    const lines = [`Action: ${action}`, `ActionID: ${action}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      ...Object.entries(extra).map(([k, v]) => `${k}: ${v}`)];
    sock.write(lines.join('\r\n') + '\r\n\r\n');
  };

  send('Login', { Username: user, Secret: secret, Events: 'off' });
  await new Promise((r) => setTimeout(r, 1500));

  send('CoreShowChannels');
  await new Promise((r) => setTimeout(r, 2000));

  send('Logoff');
  await new Promise((r) => setTimeout(r, 500));
  sock.destroy();
}

main().then(() => {
  console.log(log.join('\n---\n') || '(no data received)');
  if (!log.some((b) => /Response: Success/i.test(b))) { console.error('NO SUCCESS RESPONSE'); process.exit(1); }
}).catch((err) => {
  console.log(log.join('\n---\n'));
  console.error('PROBE FAILED:', err.message);
  process.exit(2);
});
