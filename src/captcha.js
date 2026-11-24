import { HttpError } from './errors.js';

// Cloudflare Turnstile check. Fails closed: if we cannot reach Cloudflare, the request is refused.
// Leave TURNSTILE_SECRET_KEY empty to turn the check off (sandbox only).
export async function verifyCaptcha(config, token, ip, fetchImpl = fetch) {
  if (!config.turnstileSecret) return true;
  if (typeof token !== 'string' || token.length < 10 || token.length > 4096) return false;
  const form = new URLSearchParams({ secret: config.turnstileSecret, response: token });
  if (ip && ip !== 'unknown') form.set('remoteip', ip);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetchImpl('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form, signal: ctrl.signal });
    const json = await res.json();
    return json && json.success === true;
  } catch {
    throw new HttpError(503, 'We could not run the bot check. Try again in a moment.', 'captcha_unavailable');
  } finally {
    clearTimeout(timer);
  }
}
