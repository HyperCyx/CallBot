import dgram from 'node:dgram';
const host = process.argv[2];
const port = Number(process.argv[3] ?? 5060);
const sock = dgram.createSocket('udp4');
const callId = `probe-${Date.now()}@sipbot`;
const msg = [
  `OPTIONS sip:${host} SIP/2.0`,
  `Via: SIP/2.0/UDP probe.invalid;branch=z9hG4bK-${Date.now()};rport`,
  `From: <sip:probe@probe.invalid>;tag=${Date.now()}`,
  `To: <sip:${host}>`,
  `Call-ID: ${callId}`,
  'CSeq: 1 OPTIONS',
  'Max-Forwards: 1',
  'Content-Length: 0',
  '',
  '',
].join('\r\n');
const done = (text, code = 0) => { console.log(text); sock.close(); process.exit(code); };
sock.on('message', (buf) => {
  const first = buf.toString('utf8').split('\r\n')[0];
  done(`answered: ${first}${/^(SIP\/2\.0 4|SIP\/2\.0 5)/.test(first) ? ' (service UP - auth required, good)' : first.startsWith('SIP/2.0') ? ' (service UP)' : ''}`);
});
sock.on('error', (e) => done(`socket error: ${e.message}`, 2));
sock.send(msg, port, host, (err) => { if (err) done(`send failed: ${err.message}`, 2); });
setTimeout(() => done('no answer within 6s (UDP filtered or service down)', 3), 6000);
