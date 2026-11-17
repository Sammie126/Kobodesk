import tls from 'node:tls';
import net from 'node:net';

// Sends transactional email (confirmation codes, password resets).
//
// MAIL_PROVIDER=smtp     Sends through any SMTP server. Works with a Gmail account: set SMTP_USER to the Gmail
//                        address and SMTP_PASS to a Google "app password" (see DEPLOY.md).
// MAIL_PROVIDER=resend   Sends through Resend's HTTP API. Needs MAIL_API_KEY and MAIL_FROM.
// MAIL_PROVIDER=console  Prints emails to the server log. Sandbox only, because the codes are secrets.
//
// The smtp and resend adapters have not been run against the real services from the build environment.
// The smtp adapter is tested against a local mock server. Send yourself a test email before you rely on it.

const clean = (s) => {
  const v = String(s);
  if (/[\r\n]/.test(v)) throw new Error('Line break in an email header');
  return v;
};
const address = (s) => (String(s).match(/<([^<>]+)>\s*$/)?.[1] ?? String(s)).trim();

export async function smtpSend({ host, port, secure, user, pass, from, to, subject, text, timeoutMs = 15000 }) {
  const sock = secure ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
  sock.setEncoding('utf8');
  sock.setTimeout(timeoutMs, () => sock.destroy(new Error('Email server timed out')));

  let buf = '';
  let closed = null;
  const waiters = [];
  const flush = () => {
    while (waiters.length) {
      const m = buf.match(/^(?:\d{3}-[^\n]*\n)*\d{3} [^\n]*\n/);
      if (!m) break;
      buf = buf.slice(m[0].length);
      waiters.shift().resolve(m[0]);
    }
  };
  sock.on('data', (d) => { buf += d.replace(/\r/g, ''); flush(); });
  sock.on('error', (e) => { closed = closed || e; waiters.splice(0).forEach((w) => w.reject(closed)); });
  sock.on('close', () => { closed = closed || new Error('Email server closed the connection'); waiters.splice(0).forEach((w) => w.reject(closed)); });

  const read = () => new Promise((resolve, reject) => {
    if (closed) return reject(closed);
    waiters.push({ resolve, reject });
    flush();
  });
  const expect = async (codes) => {
    const reply = await read();
    const code = reply.trim().split('\n').pop().slice(0, 3);
    if (!codes.includes(code)) throw new Error(`Email server said: ${reply.trim().split('\n').pop()}`);
    return reply;
  };
  const cmd = (line, codes) => { sock.write(line + '\r\n'); return expect(codes); };

  try {
    await expect(['220']);
    await cmd('EHLO kobodesk', ['250']);
    if (user) {
      await cmd('AUTH LOGIN', ['334']);
      await cmd(Buffer.from(user).toString('base64'), ['334']);
      await cmd(Buffer.from(pass).toString('base64'), ['235']);
    }
    await cmd(`MAIL FROM:<${address(clean(from))}>`, ['250']);
    await cmd(`RCPT TO:<${address(clean(to))}>`, ['250', '251']);
    await cmd('DATA', ['354']);
    const body = Buffer.from(String(text), 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
    const message = [
      `From: ${clean(from)}`, `To: ${clean(to)}`,
      `Subject: =?UTF-8?B?${Buffer.from(clean(subject), 'utf8').toString('base64')}?=`,
      `Date: ${new Date().toUTCString()}`, 'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', body,
    ].join('\r\n');
    await cmd(message + '\r\n.', ['250']);
    sock.write('QUIT\r\n');
  } finally {
    sock.end();
  }
}

export function createMailer(config) {
  if (config.mailProvider === 'smtp') {
    return {
      name: 'smtp',
      send: ({ to, subject, text }) => smtpSend({
        host: config.smtpHost, port: config.smtpPort, secure: config.smtpSecure,
        user: config.smtpUser, pass: config.smtpPass, from: config.mailFrom || config.smtpUser, to, subject, text,
      }),
    };
  }
  if (config.mailProvider === 'resend') {
    return {
      name: 'resend',
      async send({ to, subject, text }) {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { authorization: `Bearer ${config.mailApiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ from: config.mailFrom, to: [to], subject, text }),
        });
        if (!res.ok) throw new Error(`Mail provider answered ${res.status}`);
      },
    };
  }
  const outbox = [];
  return {
    name: 'console',
    outbox,
    async send(message) {
      outbox.push(message);
      if (!config.quiet) console.log(`[mail] to=${message.to} subject="${message.subject}"\n${message.text}\n`);
    },
  };
}
