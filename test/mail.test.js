import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { smtpSend } from '../src/mail.js';

// A tiny fake mail server that records what it is sent.
function fakeSmtp({ rejectPassword = false } = {}) {
  const log = { lines: [], data: '' };
  const server = net.createServer((sock) => {
    sock.setEncoding('utf8');
    let inData = false, buf = '';
    sock.write('220 fake ready\r\n');
    sock.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') { inData = false; sock.write('250 queued\r\n'); } else log.data += line + '\n';
          continue;
        }
        log.lines.push(line);
        if (line.startsWith('EHLO')) sock.write('250-fake\r\n250 AUTH LOGIN\r\n');
        else if (line === 'AUTH LOGIN') sock.write('334 VXNlcm5hbWU6\r\n');
        else if (log.lines[log.lines.length - 2] === 'AUTH LOGIN') sock.write('334 UGFzc3dvcmQ6\r\n');
        else if (log.lines[log.lines.length - 3] === 'AUTH LOGIN') sock.write(rejectPassword ? '535 bad login\r\n' : '235 ok\r\n');
        else if (line.startsWith('MAIL FROM') || line.startsWith('RCPT TO')) sock.write('250 ok\r\n');
        else if (line === 'DATA') { inData = true; sock.write('354 go\r\n'); }
        else if (line === 'QUIT') sock.end('221 bye\r\n');
      }
    });
  });
  return new Promise((r) => server.listen(0, () => r({ server, log, port: server.address().port })));
}

test('smtp adapter logs in, sends the message, and the body decodes back', async () => {
  const { server, log, port } = await fakeSmtp();
  try {
    await smtpSend({
      host: 'localhost', port, secure: false, user: 'me@gmail.com', pass: 'app-password',
      from: 'Kobodesk <me@gmail.com>', to: 'customer@gmail.com',
      subject: 'Your Kobodesk code is 123456', text: 'Your code is 123456.\n.\nA line that starts with a dot.',
    });
  } finally { server.close(); }
  assert.ok(log.lines.includes('MAIL FROM:<me@gmail.com>'));
  assert.ok(log.lines.includes('RCPT TO:<customer@gmail.com>'));
  assert.ok(log.lines.includes(Buffer.from('me@gmail.com').toString('base64')));
  assert.ok(log.lines.includes(Buffer.from('app-password').toString('base64')));
  const b64 = log.data.split('\n\n')[1].replace(/\s+/g, '');
  assert.equal(Buffer.from(b64, 'base64').toString(), 'Your code is 123456.\n.\nA line that starts with a dot.');
  assert.match(log.data, /Subject: =\?UTF-8\?B\?/);
});

test('smtp adapter reports a refused login and refuses header injection', async () => {
  const { server, port } = await fakeSmtp({ rejectPassword: true });
  try {
    await assert.rejects(
      smtpSend({ host: 'localhost', port, secure: false, user: 'me@gmail.com', pass: 'wrong', from: 'me@gmail.com', to: 'a@b.co', subject: 's', text: 't' }),
      /535/);
    await assert.rejects(
      smtpSend({ host: 'localhost', port, secure: false, user: '', pass: '', from: 'me@gmail.com', to: 'a@b.co\r\nBcc: x@y.z', subject: 's', text: 't' }),
      /Line break/);
  } finally { server.close(); }
});
