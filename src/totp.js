import crypto from 'node:crypto';

// Time-based one-time codes (RFC 6238), the kind Google Authenticator and similar apps produce.

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = String(str).replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error('Invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
    value &= (1 << bits) - 1;
  }
  return Buffer.from(out);
}

export function newSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function hotp(key, counter, digits) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(msg).digest();
  const off = h[h.length - 1] & 0xf;
  const code = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(code % 10 ** digits).padStart(digits, '0');
}

export function codeAt(secretBase32, timeMs, digits = 6) {
  return hotp(base32Decode(secretBase32), Math.floor(timeMs / 1000 / 30), digits);
}

// Returns the 30-second step number that matched, or null. Accepts one step either side for clock drift.
// Callers should store the step and refuse the same or an older one, so a code works only once.
export function verifyCode(secretBase32, code, lastStep = 0, timeMs = Date.now(), digits = 6) {
  const given = String(code ?? '').replace(/\s+/g, '');
  if (!/^\d+$/.test(given) || given.length !== digits) return null;
  const key = base32Decode(secretBase32);
  const nowStep = Math.floor(timeMs / 1000 / 30);
  for (const step of [nowStep, nowStep - 1, nowStep + 1]) {
    if (step <= lastStep) continue;
    const expected = hotp(key, step, digits);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given))) return step;
  }
  return null;
}

export function otpauthUri(secret, email, issuer = 'Kobodesk') {
  const label = encodeURIComponent(`${issuer}:${email}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
