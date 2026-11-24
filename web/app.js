// Kobodesk customer app: sign up, log in, sell crypto, track trades, settings.
// Plain JavaScript with no libraries. All server text is added with text nodes, never as HTML.
(function () {
  'use strict';

  var root = document.getElementById('root');
  var S = { token: null, user: null, site: null, mode: 'live', flash: null, timers: [] };
  var uid = 0;
  var STATUS = {
    awaiting_deposit: ['Waiting for your deposit', 'warn'],
    confirming: ['Deposit received, confirming', 'warn'],
    paying_out: ['Sending naira to your bank', 'warn'],
    paid_out: ['Paid', 'ok'],
    expired: ['Expired', 'bad'],
    payout_failed: ['Needs attention', 'bad'],
    held_for_review: ['Under review', 'warn'],
    review_rejected: ['Not completed', 'bad']
  };

  // ---------- small helpers ----------
  function h(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        var v = attrs[k];
        if (v === false || v === null || v === undefined) continue;
        if (k === 'class') el.className = v;
        else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, v);
      }
    }
    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  // add(el, a, b, c) appends every child. Arrays are flattened, and null or false are skipped.
  function add(el) {
    for (var n = 1; n < arguments.length; n++) {
      var c = arguments[n];
      if (c === null || c === undefined || c === false) continue;
      if (Array.isArray(c)) { for (var i = 0; i < c.length; i++) add(el, c[i]); }
      else if (c.nodeType) el.appendChild(c);
      else el.appendChild(document.createTextNode(String(c)));
    }
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

  function loadToken() { try { S.token = localStorage.getItem('kd_token'); } catch (e) { S.token = null; } }
  function captureRef() {
    try { var m = location.search.match(/[?&]ref=([0-9A-Za-z]{10})/); if (m) localStorage.setItem('kd_ref', m[1].toUpperCase()); } catch (e) { /* private mode */ }
  }
  function getRef() { try { return localStorage.getItem('kd_ref') || undefined; } catch (e) { return undefined; } }
  function saveToken(t) {
    S.token = t;
    try { if (t) localStorage.setItem('kd_token', t); else localStorage.removeItem('kd_token'); } catch (e) { /* private mode */ }
  }

  function api(path, opts) {
    opts = opts || {};
    var headers = {};
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (S.token && !opts.anon) headers.authorization = 'Bearer ' + S.token;
    return fetch(path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (json) {
        if (!res.ok) {
          var e = new Error((json.error && json.error.message) || 'Something went wrong. Try again.');
          e.code = json.error && json.error.code;
          e.status = res.status;
          throw e;
        }
        return json;
      });
    }, function () {
      var e = new Error('We could not reach Kobodesk. Check your connection and try again.');
      e.code = 'network';
      throw e;
    });
  }

  function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }
  function clearTimers() {
    for (var i = 0; i < S.timers.length; i++) { clearTimeout(S.timers[i]); clearInterval(S.timers[i]); }
    S.timers = [];
  }
  function takeFlash() { var f = S.flash; S.flash = null; return f; }

  function msg(kind, text) { return h('div', { class: 'alert alert-' + kind, role: kind === 'bad' ? 'alert' : 'status' }, text); }
  function link(text, href) { return h('p', { class: 'center' }, h('a', { href: href }, text)); }

  function field(label, input, hint) {
    var id = 'f' + (++uid);
    input.id = id;
    return h('div', { class: 'field' }, h('label', { for: id }, label), input, hint ? h('p', { class: 'hint' }, hint) : null);
  }
  function input(type, name, attrs) {
    var a = { type: type, name: name };
    for (var k in (attrs || {})) a[k] = attrs[k];
    return h('input', a);
  }

  // Runs fn when the form is submitted. Shows errors in errBox and disables the button while it works.
  function onSubmit(form, btn, errBox, fn) {
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      clear(errBox);
      var label = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Please wait…';
      var done = function () { btn.disabled = false; btn.textContent = label; };
      Promise.resolve().then(fn).then(done, function (e) {
        done();
        if (e && e.status === 401 && e.code === 'unauthorized') return handleErr(e);
        add(errBox, msg((e && e.kind) || 'bad', (e && e.message) || 'Something went wrong. Try again.'));
      });
    });
  }

  function copyText(text, node, btn) {
    var label = btn.textContent;
    var done = function () { btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = label; }, 2000); };
    var fallback = function () {
      try {
        var range = document.createRange();
        range.selectNodeContents(node);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand('copy');
        done();
      } catch (e) { btn.textContent = 'Press and hold to copy'; }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback);
    else fallback();
  }

  function fmtDate(iso) {
    try { return new Date(iso).toLocaleString('en-NG', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }); }
    catch (e) { return iso; }
  }
  function badge(status) {
    var s = STATUS[status] || [status, 'warn'];
    return h('span', { class: 'badge badge-' + s[1] }, s[0]);
  }

  // ---------- bot check (Cloudflare Turnstile) ----------
  var turnstileState = 0; // 0 not asked, 1 loading, 2 ready, 3 failed
  var turnstileWaiters = [];
  function loadTurnstile(cb) {
    if (turnstileState === 2) return cb(true);
    if (turnstileState === 3) return cb(false);
    turnstileWaiters.push(cb);
    if (turnstileState === 1) return;
    turnstileState = 1;
    var sc = document.createElement('script');
    sc.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    sc.async = true;
    var finish = function (ok) { turnstileState = ok ? 2 : 3; var w = turnstileWaiters; turnstileWaiters = []; for (var i = 0; i < w.length; i++) w[i](ok); };
    sc.onload = function () { finish(!!window.turnstile); };
    sc.onerror = function () { finish(false); };
    document.head.appendChild(sc);
  }
  // Returns { node, needed, token(), reset() }. When no site key is set the check is off and node is empty.
  function captchaBox() {
    var key = S.site && S.site.captcha_site_key;
    var box = h('div', { class: 'captcha' });
    var st = { token: null, id: null };
    if (!key) return { node: box, needed: false, token: function () { return undefined; }, reset: function () {} };
    loadTurnstile(function (ok) {
      setTimeout(function () {
        if (!ok) { add(box, msg('warn', 'The security check could not load. Check your connection and reload the page.')); return; }
        st.id = window.turnstile.render(box, {
          sitekey: key,
          callback: function (t) { st.token = t; },
          'expired-callback': function () { st.token = null; },
          'error-callback': function () { st.token = null; }
        });
      }, 0);
    });
    return {
      node: box, needed: true,
      token: function () { return st.token || undefined; },
      reset: function () { st.token = null; try { if (st.id !== null && window.turnstile) window.turnstile.reset(st.id); } catch (e) { /* ignore */ } }
    };
  }
  // Wraps a submit handler: waits for the check, then clears it, since each check works once.
  function withCaptcha(cap, fn) {
    return function () {
      if (cap.needed && !cap.token()) throw new Error('Wait for the security check to finish, then try again.');
      return Promise.resolve().then(fn).then(function (r) { cap.reset(); return r; }, function (e) { cap.reset(); throw e; });
    };
  }

  // ---------- layout ----------
  var LOGO = function () {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '34'); svg.setAttribute('height', '34'); svg.setAttribute('viewBox', '0 0 34 34'); svg.setAttribute('aria-hidden', 'true');
    var rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('width', '34'); rect.setAttribute('height', '34'); rect.setAttribute('rx', '9'); rect.setAttribute('fill', '#0B3D2E');
    var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', 'M11 9v16M11 17l9-8M12.5 15.5L21 25'); p.setAttribute('stroke', '#F2B33D'); p.setAttribute('stroke-width', '2.6');
    p.setAttribute('stroke-linecap', 'round'); p.setAttribute('fill', 'none');
    svg.appendChild(rect); svg.appendChild(p);
    return svg;
  };

  function mount(node, title) {
    clear(root);
    root.appendChild(node);
    document.title = (title ? title + ' | ' : '') + 'Kobodesk';
    var h1 = root.querySelector('h1');
    if (h1) { h1.setAttribute('tabindex', '-1'); try { h1.focus(); } catch (e) { /* ignore */ } }
    window.scrollTo(0, 0);
  }

  // Page for signed-out screens: a centred card.
  function card(title, errBox, body, links) {
    var flash = takeFlash();
    return h('div', { class: 'wrap narrow auth-card' },
      h('a', { href: '/', class: 'logo' }, LOGO(), h('span', null, 'Kobodesk')),
      h('div', { class: 'spacer' }),
      h('div', { class: 'panel' }, h('h1', null, title), flash ? msg(flash.kind, flash.text) : null, errBox, body),
      links);
  }

  // The notice shown at the foot of every signed-in page.
  function disclaimer() {
    var site = S.site || {};
    var contact = [];
    if (site.support_email) contact.push('Email ' + site.support_email);
    if (site.support_whatsapp) contact.push('WhatsApp +' + site.support_whatsapp);
    if (site.support_hours) contact.push(site.support_hours);
    return h('footer', { class: 'wrap app-foot' },
      h('p', null, 'Kobodesk is not a bank. We do not hold deposits or pay interest. Crypto rates, and the coins, networks and payout options we support, can change without notice.'),
      contact.length ? h('p', null, 'Support: ' + contact.join(' · ')) : null,
      h('p', null, h('a', { href: '/terms.html' }, 'Terms'), ' · ', h('a', { href: '/privacy.html' }, 'Privacy'), ' · ', h('a', { href: '/security.html' }, 'Report a security issue')));
  }

  // Page for signed-in screens: banners, top bar, tabs.
  function shell(active, content) {
    var flash = takeFlash();
    var parts = [];
    if (S.mode === 'sandbox') {
      parts.push(h('div', { class: 'band banner banner-test' }, h('div', { class: 'wrap' }, 'Test mode: deposits and payouts are simulated. No real money moves.')));
    }
    if (S.user && !S.user.email_verified && location.hash !== '#/confirm') {
      parts.push(h('div', { class: 'band banner banner-verify' }, h('div', { class: 'wrap' },
        'Confirm your email to start trading. ', h('a', { href: '#/confirm' }, 'Enter your code'), '.')));
    }
    if (S.user && S.user.paused) {
      parts.push(h('div', { class: 'band banner banner-verify' }, h('div', { class: 'wrap' },
        'New trades are paused on your account while we complete a routine safety check. Contact support if you have questions.')));
    }
    var tab = function (key, text, href) { return h('a', { href: href, class: key === active ? 'on' : '', 'aria-current': key === active ? 'page' : false }, text); };
    parts.push(h('div', { class: 'band' }, h('div', { class: 'wrap appbar' },
      h('a', { href: '#/sell', class: 'logo' }, LOGO(), h('span', null, 'Kobodesk')),
      h('button', { type: 'button', class: 'link-btn', onclick: function () {
        saveToken(null); S.user = null; S.flash = { kind: 'info', text: 'You are logged out.' }; go('#/login');
      } }, 'Log out'))));
    parts.push(h('main', { class: 'wrap app' },
      h('nav', { class: 'tabs', 'aria-label': 'Main' }, tab('sell', 'Sell', '#/sell'), tab('trades', 'My trades', '#/trades'), tab('settings', 'Settings', '#/settings'), S.user && S.user.is_admin ? tab('admin', 'Admin', '#/admin') : null),
      flash ? msg(flash.kind, flash.text) : null,
      content));
    parts.push(disclaimer());
    return h('div', null, parts);
  }

  // ---------- signed-out screens ----------
  function loginView() {
    var err = h('div');
    var email = input('email', 'email', { autocomplete: 'username', required: true, inputmode: 'email' });
    var pw = input('password', 'password', { autocomplete: 'current-password', required: true });
    var code = input('text', 'code', { autocomplete: 'one-time-code', inputmode: 'numeric', maxlength: '6', pattern: '[0-9]*' });
    var codeWrap = field('6-digit code from your authenticator app', code);
    codeWrap.hidden = true;
    var cap = captchaBox();
    var btn = h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'Log in');
    var form = h('form', null, field('Email', email), field('Password', pw), codeWrap, cap.node, btn);
    onSubmit(form, btn, err, withCaptcha(cap, function () {
      return api('/api/auth/login', { method: 'POST', anon: true, body: { email: email.value, password: pw.value, code: code.value || undefined, captcha_token: cap.token() } })
        .then(function (r) { saveToken(r.token); S.user = r.user; go('#/sell'); }, function (e) {
          if (e.code === 'totp_required') { codeWrap.hidden = false; code.focus(); e.kind = 'info'; }
          throw e;
        });
    }));
    mount(card('Log in', err, form, h('div', null, link('Forgot your password?', '#/forgot'), link('Create an account', '#/signup'))), 'Log in');
  }

  function signupView() {
    var err = h('div');
    var email = input('email', 'email', { autocomplete: 'username', required: true, inputmode: 'email' });
    var pw = input('password', 'password', { autocomplete: 'new-password', required: true, minlength: '10' });
    var agree = h('input', { type: 'checkbox', required: true });
    var agreeId = 'f' + (++uid);
    agree.id = agreeId;
    var cap = captchaBox();
    var btn = h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'Create account');
    var form = h('form', null,
      field('Email', email), field('Password', pw, 'At least 10 characters.'),
      h('div', { class: 'field' }, h('label', { for: agreeId }, agree, ' I agree to the ', h('a', { href: '/terms.html' }, 'Terms'), ' and ', h('a', { href: '/privacy.html' }, 'Privacy Policy'), '.')),
      cap.node, btn);
    onSubmit(form, btn, err, withCaptcha(cap, function () {
      return api('/api/auth/signup', { method: 'POST', anon: true, body: { email: email.value, password: pw.value, ref: getRef(), captcha_token: cap.token() } }).then(function (r) {
        saveToken(r.token); S.user = r.user;
        S.flash = { kind: 'info', text: 'Welcome. We sent a 6-digit code to ' + r.user.email + '.' };
        go('#/confirm');
      });
    }));
    mount(card('Create your account', err, form, link('I already have an account', '#/login')), 'Sign up');
  }

  function forgotView() {
    var err = h('div');
    var email = input('email', 'email', { autocomplete: 'username', required: true, inputmode: 'email' });
    var cap = captchaBox();
    var btn = h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'Send reset link');
    var form = h('form', null, field('Email', email), cap.node, btn);
    var box = h('div', null, form);
    onSubmit(form, btn, err, withCaptcha(cap, function () {
      return api('/api/auth/forgot-password', { method: 'POST', anon: true, body: { email: email.value, captcha_token: cap.token() } }).then(function (r) {
        clear(box); add(box, msg('ok', r.message));
      });
    }));
    mount(card('Reset your password', err, box, link('Back to log in', '#/login')), 'Reset password');
  }

  function resetView(token) {
    history.replaceState(null, '', location.pathname); // keep the token out of the address bar and history
    var err = h('div');
    var pw = input('password', 'password', { autocomplete: 'new-password', required: true, minlength: '10' });
    var btn = h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'Save new password');
    var form = h('form', null, field('New password', pw, 'At least 10 characters.'), btn);
    var box = h('div', null, form);
    onSubmit(form, btn, err, function () {
      return api('/api/auth/reset-password', { method: 'POST', anon: true, body: { token: token, password: pw.value } }).then(function () {
        saveToken(null); S.user = null;
        clear(box); add(box, msg('ok', 'Your password is changed. You are logged out everywhere.'), h('a', { href: '#/login', class: 'btn btn-primary btn-block' }, 'Log in'));
      });
    });
    mount(card('Choose a new password', err, box), 'New password');
  }

  function verifyView(token) {
    history.replaceState(null, '', location.pathname);
    var box = h('div', null, h('p', null, 'Confirming your email…'));
    mount(card('Confirm your email', h('div'), box), 'Confirm email');
    api('/api/auth/verify-email', { method: 'POST', anon: true, body: { token: token } }).then(function () {
      if (S.user) S.user.email_verified = true;
      clear(box);
      add(box, msg('ok', 'Your email is confirmed.'), h('a', { href: S.token ? '#/sell' : '#/login', class: 'btn btn-primary btn-block' }, S.token ? 'Start selling' : 'Log in'));
    }, function (e) {
      clear(box);
      add(box, msg('bad', e.message), h('a', { href: S.token ? '#/settings' : '#/login', class: 'btn btn-primary btn-block' }, S.token ? 'Go to settings' : 'Log in'));
    });
  }

  // ---------- confirm email with the 6-digit code ----------
  function confirmView() {
    if (S.user.email_verified) return go('#/sell');
    var err = h('div');
    var code = input('text', 'code', { inputmode: 'numeric', maxlength: '6', pattern: '[0-9]*', autocomplete: 'one-time-code', required: true });
    var btn = h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'Confirm');
    var form = h('form', null,
      field('6-digit code', code, 'We sent it to ' + S.user.email + '. It works for 15 minutes. Check your spam folder too.'),
      err, btn);
    onSubmit(form, btn, err, function () {
      return api('/api/auth/verify-code', { method: 'POST', body: { code: code.value } }).then(function () {
        S.user.email_verified = true;
        S.flash = { kind: 'ok', text: 'Your email is confirmed. You can start selling.' };
        go('#/sell');
      });
    });
    var note = h('div');
    var resend = h('button', { type: 'button', class: 'link-btn', onclick: function () {
      resend.disabled = true; clear(note);
      api('/api/auth/resend-verification', { method: 'POST', body: {} }).then(
        function () { resend.disabled = false; add(note, msg('ok', 'We sent a new code to ' + S.user.email + '.')); },
        function (e) { resend.disabled = false; add(note, msg('bad', e.message)); });
    } }, 'Send a new code');
    mount(shell('', h('div', { class: 'wrap narrow' }, h('div', { class: 'panel' },
      h('h1', null, 'Confirm your email'), form, h('p', { class: 'center' }, resend), note))), 'Confirm email');
  }

  // ---------- sell ----------
  function sellView() {
    var holder = h('div', null, h('p', { class: 'muted' }, 'Loading…'));
    mount(shell('sell', holder), 'Sell crypto');
    var u = S.user;
    if (u.paused) {
      clear(holder);
      holder.appendChild(h('div', { class: 'wrap narrow' }, h('div', { class: 'panel' }, h('h1', null, 'Trades are paused'),
        msg('warn', 'We have paused new trades on your account while we complete a routine safety check. Contact support if you have questions.'))));
      return;
    }
    if (S.site && S.site.kyc_required && (u.kyc_status === 'unverified' || u.kyc_status === 'rejected')) {
      clear(holder);
      holder.appendChild(h('div', { class: 'wrap narrow' }, h('div', { class: 'panel' }, h('h1', null, 'Verify your identity first'),
        h('p', null, 'Before your first trade we need to check who you are. You will need your full name, your BVN or NIN, your address and a photo of your government ID. It takes a few minutes.'),
        h('a', { href: '#/verify', class: 'btn btn-primary btn-block' }, 'Verify my identity'))));
      return;
    }
    Promise.all([api('/api/assets', { anon: true }), api('/api/banks', { anon: true }), api('/api/bank-accounts'), api('/api/limits')]).then(function (r) {
      clear(holder);
      holder.appendChild(buildSell(r[0], r[1], r[2], r[3]));
    }, handleErr);
  }

  function buildSell(assets, banks, accounts, limits) {
    var st = { coin: assets[0].coin, network: assets[0].networks[0], accountId: accounts.length ? accounts[0].id : '__new' };
    var seq = 0, timer = null;
    var err = h('div');

    var chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Choose a coin' });
    var networkSel = h('select', { name: 'network' });
    var amount = input('text', 'amount', { inputmode: 'decimal', autocomplete: 'off', placeholder: '0.00', required: true });
    var quoteNum = h('b', null, '—');
    var quoteHint = h('span', { class: 'hint' }, 'Enter an amount to see what you will receive.');
    var quoteBox = h('div', { class: 'quote' }, h('span', { class: 'small muted' }, 'You will receive about'), quoteNum, quoteHint);
    var accountSel = h('select', { name: 'account' });
    var bankSel = h('select', { name: 'bank' });
    var acctNum = input('text', 'account_number', { inputmode: 'numeric', maxlength: '10', pattern: '[0-9]*', autocomplete: 'off' });
    var addErr = h('div');
    var saveBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-block' }, 'Save bank account');
    var addPanel = h('div', null,
      field('Bank', bankSel), field('Account number', acctNum, '10 digits. We show you the account name to check.'), addErr, saveBtn, h('div', { class: 'spacer' }));
    var cap = captchaBox();
    var submit = h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'Get deposit address');

    banks.forEach(function (b) { bankSel.appendChild(h('option', { value: b.code }, b.name)); });

    function drawCoins() {
      clear(chips);
      assets.forEach(function (a) {
        chips.appendChild(h('button', { type: 'button', class: 'chip' + (a.coin === st.coin ? ' on' : ''), 'aria-pressed': a.coin === st.coin ? 'true' : 'false', onclick: function () {
          st.coin = a.coin; st.network = a.networks[0]; drawCoins(); drawNetworks(); refreshQuote();
        } }, a.coin));
      });
    }
    function drawNetworks() {
      clear(networkSel);
      var a = assets.filter(function (x) { return x.coin === st.coin; })[0];
      a.networks.forEach(function (n) { networkSel.appendChild(h('option', { value: n, selected: n === st.network }, n)); });
    }
    function drawAccounts() {
      clear(accountSel);
      accounts.forEach(function (a) {
        accountSel.appendChild(h('option', { value: a.id, selected: a.id === st.accountId }, a.bank_name + ' · ' + a.account_number + ' · ' + a.account_name));
      });
      accountSel.appendChild(h('option', { value: '__new', selected: st.accountId === '__new' }, 'Add a new bank account…'));
      addPanel.hidden = st.accountId !== '__new';
    }
    function refreshQuote() {
      var mine = ++seq;
      var v = amount.value.replace(/,/g, '').trim();
      if (!v) { quoteNum.textContent = '—'; quoteHint.textContent = 'Enter an amount to see what you will receive.'; return; }
      api('/api/quote?coin=' + st.coin + '&network=' + st.network + '&amount=' + encodeURIComponent(v), { anon: true }).then(function (q) {
        if (mine !== seq) return;
        quoteNum.textContent = '₦' + q.quote_naira;
        quoteHint.textContent = 'Estimate. We lock the rate for ' + Math.round(q.valid_for_seconds / 60) + ' minutes when you continue.';
      }, function (e) {
        if (mine !== seq) return;
        quoteNum.textContent = '—';
        quoteHint.textContent = e.message;
      });
    }

    networkSel.addEventListener('change', function () { st.network = networkSel.value; refreshQuote(); });
    amount.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(refreshQuote, 300); S.timers.push(timer); });
    accountSel.addEventListener('change', function () { st.accountId = accountSel.value; addPanel.hidden = st.accountId !== '__new'; });
    saveBtn.addEventListener('click', function () {
      clear(addErr);
      saveBtn.disabled = true;
      api('/api/bank-accounts', { method: 'POST', body: { bank_code: bankSel.value, account_number: acctNum.value.trim() } }).then(function (a) {
        if (a.paused) {
          S.user.paused = true;
          S.flash = { kind: 'warn', text: 'We saved this bank account, but we need to review it before you can trade. We will be in touch.' };
          return sellView();
        }
        accounts.push(a); st.accountId = a.id; acctNum.value = ''; saveBtn.disabled = false; drawAccounts();
      }, function (e) { saveBtn.disabled = false; add(addErr, msg('bad', e.message)); });
    });

    var form = h('form', null,
      h('div', { class: 'field' }, h('label', null, 'Coin'), chips),
      field('Network', networkSel, 'Send on this network only. Other networks can lose your funds.'),
      field('Amount you will send', amount),
      quoteBox,
      field('Pay my naira to', accountSel),
      addPanel,
      cap.node,
      err,
      submit);
    onSubmit(form, submit, err, withCaptcha(cap, function () {
      if (st.accountId === '__new') { var e = new Error('Choose a bank account, or save a new one first.'); throw e; }
      return api('/api/trades', { method: 'POST', body: { coin: st.coin, network: st.network, amount: amount.value.replace(/,/g, '').trim(), bank_account_id: st.accountId, captcha_token: cap.token() } })
        .then(function (t) { go('#/trade/' + t.id); });
    }));

    drawCoins(); drawNetworks(); drawAccounts();
    return h('div', { class: 'wrap narrow', style: false }, h('div', { class: 'panel' }, h('h1', null, 'Sell crypto'),
      limits ? h('p', { class: 'small muted' }, 'You can sell up to \u20A6' + limits.remaining_today_naira + ' more in the next 24 hours (daily limit \u20A6' + limits.daily_naira + ').') : null,
      S.user.kyc_status === 'pending' ? msg('info', 'Your identity check is being reviewed. Larger trades will be possible once it is approved.') : null,
      form));
  }

  // ---------- one trade ----------
  var TERMINAL = { paid_out: 1, expired: 1, payout_failed: 1, review_rejected: 1 };

  function tradeView(id) {
    var holder = h('div', null, h('p', { class: 'muted' }, 'Loading…'));
    mount(shell('trades', holder), 'Trade');
    var lastKey = '';

    function draw(t) {
      var key = t.status + '|' + t.received_amount;
      if (key === lastKey) return;
      lastKey = key;
      clear(holder);
      holder.appendChild(renderTrade(t, function (updated) { draw(updated); poll(); }));
    }
    function poll() {
      var timer = setTimeout(function () {
        api('/api/trades/' + id).then(function (t) { draw(t); if (!TERMINAL[t.status]) poll(); }, function () { poll(); });
      }, 5000);
      S.timers.push(timer);
    }
    api('/api/trades/' + id).then(function (t) { draw(t); if (!TERMINAL[t.status]) poll(); }, handleErr);
  }

  function renderTrade(t, onUpdate) {
    var kids = [];
    var waiting = t.status === 'awaiting_deposit' || t.status === 'confirming';

    if (t.status === 'paid_out') {
      kids.push(msg('ok', 'Paid. ₦' + t.payout_naira + ' is on its way to your bank account.'),
        h('a', { href: '#/receipt/' + t.id, class: 'btn btn-primary btn-block' }, 'View receipt'), h('div', { class: 'spacer' }));
    }
    else if (t.status === 'payout_failed') kids.push(msg('warn', 'Your deposit arrived, but the bank transfer did not go through. We are looking into it. Contact support and quote the trade ID below.'));
    else if (t.status === 'expired') kids.push(msg('bad', 'This quote expired. If you already sent crypto, contact support with the trade ID below. Otherwise, start a new trade.'));
    else if (t.status === 'confirming') kids.push(msg('info', 'We saw your deposit. We are waiting for the network to confirm it. You can leave this page.'));
    else if (t.status === 'held_for_review') kids.push(msg('info', 'Your deposit is confirmed. Before we pay out, our team is completing a routine review of this trade. You do not need to send anything again. We will email you when it is done.'));
    else if (t.status === 'review_rejected') kids.push(msg('bad', 'We could not complete this trade after review. Contact support and quote the trade ID below so we can help with your deposit.'));
    else if (t.status === 'paying_out') kids.push(msg('info', 'Deposit confirmed. We are sending your naira now.'));

    if (waiting) {
      var addr = h('code', { class: 'addr' }, t.deposit_address);
      var copyBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-block', onclick: function () { copyText(t.deposit_address, addr, copyBtn); } }, 'Copy address');
      var cd = h('b', null, '');
      kids.push(
        msg('warn', 'Send only ' + t.coin + ' on the ' + t.network + ' network to this address. Anything else can be lost for good.'),
        h('div', { class: 'kv' }, h('span', null, 'Send exactly'), h('b', { class: 'mono' }, t.amount + ' ' + t.coin)),
        h('div', { class: 'kv' }, h('span', null, 'Network'), h('b', null, t.network)),
        h('p', { class: 'small muted' }, 'Deposit address'), addr, copyBtn, h('div', { class: 'spacer' }),
        h('div', { class: 'kv' }, h('span', null, 'You will receive'), h('b', { class: 'mono' }, '₦' + t.quote_naira)),
        h('div', { class: 'kv' }, h('span', null, 'Rate locked for'), cd));
      if (t.status === 'awaiting_deposit') {
        var tick = function () {
          var left = Math.floor((new Date(t.expires_at).getTime() - Date.now()) / 1000);
          if (left <= 0) { cd.textContent = 'Expired'; return; }
          cd.textContent = Math.floor(left / 60) + ':' + ('0' + (left % 60)).slice(-2);
        };
        tick();
        S.timers.push(setInterval(tick, 1000));
      } else {
        cd.textContent = 'Deposit received';
      }
    } else {
      kids.push(
        h('div', { class: 'kv' }, h('span', null, 'Amount'), h('b', { class: 'mono' }, t.amount + ' ' + t.coin)),
        h('div', { class: 'kv' }, h('span', null, 'Network'), h('b', null, t.network)),
        h('div', { class: 'kv' }, h('span', null, t.payout_naira ? 'Naira paid' : 'Quoted naira'), h('b', { class: 'mono' }, '₦' + (t.payout_naira || t.quote_naira))));
    }

    if (S.mode === 'sandbox' && (t.status === 'awaiting_deposit' || t.status === 'expired')) {
      var simBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-block', onclick: function () {
        simBtn.disabled = true;
        api('/api/sandbox/trades/' + t.id + '/deposit', { method: 'POST', body: {} }).then(function (r) { onUpdate(r.trade); }, function (e) { simBtn.disabled = false; alert(e.message); });
      } }, 'Simulate a deposit (test mode)');
      kids.push(h('div', { class: 'spacer' }), simBtn);
    }

    kids.push(h('p', { class: 'small muted' }, 'Trade ID: ', h('span', { class: 'mono' }, t.id), ' · Started ', fmtDate(t.created_at)));
    return h('div', { class: 'wrap narrow' }, h('div', { class: 'panel' },
      h('div', { class: 'row-top' }, h('h1', null, 'Sell ' + t.amount + ' ' + t.coin), badge(t.status)), kids));
  }

  // ---------- trade list ----------
  function tradesView() {
    var holder = h('div', null, h('p', { class: 'muted' }, 'Loading…'));
    mount(shell('trades', holder), 'My trades');
    api('/api/trades').then(function (list) {
      clear(holder);
      if (!list.length) {
        holder.appendChild(h('div', { class: 'panel' }, h('h1', null, 'My trades'), h('p', null, 'You have not sold anything yet.'), h('a', { href: '#/sell', class: 'btn btn-primary' }, 'Sell crypto')));
        return;
      }
      holder.appendChild(h('div', { class: 'panel' }, h('h1', null, 'My trades'), h('div', { class: 'list' }, list.map(function (t) {
        return h('a', { href: '#/trade/' + t.id, class: 'row' },
          h('div', { class: 'row-top' }, h('b', null, t.amount + ' ' + t.coin), badge(t.status)),
          h('span', { class: 'small muted' }, fmtDate(t.created_at) + ' · ₦' + (t.payout_naira || t.quote_naira)));
      }))));
    }, handleErr);
  }

  // ---------- settings ----------
  function settingsView() {
    var holder = h('div');
    mount(shell('settings', holder), 'Settings');
    var u = S.user;
    var kids = [];
    var KYC = { unverified: 'Not verified', pending: 'In review', verified: 'Verified', rejected: 'Not approved' };

    // Account
    kids.push(h('div', { class: 'panel' }, h('h2', null, 'Account'),
      h('div', { class: 'kv' }, h('span', null, 'Email'), h('b', null, u.email)),
      h('div', { class: 'kv' }, h('span', null, 'Email status'), h('b', null, u.email_verified ? 'Confirmed' : 'Not confirmed yet')),
      h('div', { class: 'kv' }, h('span', null, 'Identity check'), h('b', null, KYC[u.kyc_status] || u.kyc_status)),
      h('p', { class: 'small muted' }, 'Your trade limit depends on your identity check.')));

    kids.push(kycPanel(u));

    // Two-factor
    kids.push(twoFactorPanel(u));

    // Change password
    var pErr = h('div');
    var cur = input('password', 'current', { autocomplete: 'current-password', required: true });
    var nxt = input('password', 'next', { autocomplete: 'new-password', required: true, minlength: '10' });
    var pBtn = h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'Change password');
    var pForm = h('form', null, field('Current password', cur), field('New password', nxt, 'At least 10 characters. Changing it logs you out on other devices.'), pErr, pBtn);
    onSubmit(pForm, pBtn, pErr, function () {
      return api('/api/auth/change-password', { method: 'POST', body: { current: cur.value, next: nxt.value } }).then(function (r) {
        saveToken(r.token); cur.value = ''; nxt.value = ''; add(pErr, msg('ok', 'Password changed.'));
      });
    });
    kids.push(h('div', { class: 'panel' }, h('h2', null, 'Password'), pForm));

    // Sign out everywhere
    var oBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-block' }, 'Log out of all devices');
    var armed = false;
    oBtn.addEventListener('click', function () {
      if (!armed) { armed = true; oBtn.textContent = 'Tap again to log out everywhere'; return; }
      api('/api/auth/logout-all', { method: 'POST', body: {} }).then(function () {
        saveToken(null); S.user = null; S.flash = { kind: 'ok', text: 'You are logged out on every device.' }; go('#/login');
      }, handleErr);
    });
    kids.push(referralPanel());
    kids.push(h('div', { class: 'panel' }, h('h2', null, 'Devices'), h('p', null, 'Lost a phone or used a shared computer? Log out everywhere.'), oBtn));

    kids.push(deletionPanel());
    holder.appendChild(h('div', { class: 'wrap narrow' }, h('h1', null, 'Settings'), kids));
  }

  function deletionPanel() {
    var box = h('div');
    var btn = h('button', { type: 'button', class: 'btn btn-ghost btn-block' }, 'Request deletion of my data');
    var armed = false;
    btn.addEventListener('click', function () {
      if (!armed) { armed = true; btn.textContent = 'Tap again to send the request'; return; }
      btn.disabled = true;
      api('/api/account/deletion-request', { method: 'POST', body: {} }).then(function (r) { clear(box); add(box, msg('ok', r.message)); },
        function (e) { btn.disabled = false; add(box, msg('bad', e.message)); });
    });
    add(box, h('p', null, 'You can ask us to delete the personal data we hold about you. We may have to keep some records, such as trade and identity records, for the period the law requires. We will tell you what we deleted and what we kept.'), btn);
    return h('div', { class: 'panel' }, h('h2', null, 'Your data'), box, h('p', { class: 'small muted' }, h('a', { href: '/privacy.html' }, 'Read the Privacy Policy')));
  }

  function twoFactorPanel(u) {
    var box = h('div');
    var wrap = h('div', { class: 'panel' }, h('h2', null, 'Two-factor sign-in'), box);
    var refresh = function () {
      api('/api/me').then(function (me) { S.user = me; S.flash = { kind: 'ok', text: me.totp_enabled ? 'Two-factor sign-in is on.' : 'Two-factor sign-in is off.' }; settingsView(); }, handleErr);
    };

    if (u.totp_enabled) {
      var err = h('div');
      var pw = input('password', 'password', { autocomplete: 'current-password', required: true });
      var code = input('text', 'code', { inputmode: 'numeric', maxlength: '6', pattern: '[0-9]*', autocomplete: 'one-time-code', required: true });
      var btn = h('button', { type: 'submit', class: 'btn btn-ghost btn-block' }, 'Turn off');
      var form = h('form', null, field('Your password', pw), field('Code from your authenticator app', code), err, btn);
      onSubmit(form, btn, err, function () {
        return api('/api/2fa/disable', { method: 'POST', body: { password: pw.value, code: code.value } }).then(refresh);
      });
      add(box, h('p', null, 'On. You need a code from your authenticator app each time you log in.'), form);
      return wrap;
    }

    var start = h('button', { type: 'button', class: 'btn btn-primary btn-block' }, 'Set up two-factor sign-in');
    add(box, h('p', null, 'Off. Turn it on to protect your account even if someone learns your password. You need an authenticator app such as Google Authenticator, Microsoft Authenticator or Authy.'), start);
    start.addEventListener('click', function () {
      start.disabled = true;
      api('/api/2fa/setup', { method: 'POST', body: {} }).then(function (s) {
        clear(box);
        var err = h('div');
        var secret = h('code', { class: 'secret' }, s.secret);
        var copyBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-block', onclick: function () { copyText(s.secret, secret, copyBtn); } }, 'Copy key');
        var code = input('text', 'code', { inputmode: 'numeric', maxlength: '6', pattern: '[0-9]*', autocomplete: 'one-time-code', required: true });
        var btn = h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'Turn on');
        var form = h('form', null, field('6-digit code from the app', code), err, btn);
        onSubmit(form, btn, err, function () {
          return api('/api/2fa/enable', { method: 'POST', body: { code: code.value } }).then(refresh);
        });
        add(box,
          h('p', null, 'In your authenticator app, add a new account and choose “enter a setup key”. Paste this key:'),
          secret, copyBtn, h('div', { class: 'spacer' }),
          h('p', { class: 'small muted' }, 'Save the key somewhere safe. It is the only way to restore the app on a new phone.'),
          form);
      }, function (e) { start.disabled = false; add(box, msg('bad', e.message)); });
    });
    return wrap;
  }

  // ---------- identity check, invite friends ----------
  function kycPanel(u) {
    var box = h('div');
    var texts = {
      unverified: 'Verify your identity before your first trade. It also raises your limits.',
      pending: 'We are reviewing your details. You can trade within the lower limits meanwhile, and we will email you when the review is done.',
      verified: 'Your identity is verified. Your higher trade limit is active.',
      rejected: 'We could not verify you. Check your details and try again.'
    };
    add(box, h('p', null, texts[u.kyc_status] || ''));
    api('/api/kyc').then(function (k) {
      if (k.submission && k.submission.status === 'rejected' && k.submission.note) add(box, msg('warn', 'Reason: ' + k.submission.note));
    }, function () { /* the panel still works without the reason */ });
    if (u.kyc_status === 'unverified' || u.kyc_status === 'rejected') {
      add(box, h('a', { href: '#/verify', class: 'btn btn-primary btn-block' }, 'Verify my identity'));
    }
    return h('div', { class: 'panel' }, h('h2', null, 'Identity check'), box);
  }

  function referralPanel() {
    var box = h('div', null, h('p', { class: 'muted' }, 'Loading…'));
    api('/api/referrals').then(function (r) {
      clear(box);
      var linkBox = h('code', { class: 'addr' }, r.link);
      var btn = h('button', { type: 'button', class: 'btn btn-ghost btn-block', onclick: function () { copyText(r.link, linkBox, btn); } }, 'Copy my link');
      add(box,
        h('p', null, 'Share your link. People who sign up with it are counted here.'), linkBox, btn, h('div', { class: 'spacer' }),
        h('div', { class: 'kv' }, h('span', null, 'Sign-ups'), h('b', null, String(r.signups))),
        h('div', { class: 'kv' }, h('span', null, 'Completed a trade'), h('b', null, String(r.paid_trades))));
    }, function (e) { clear(box); add(box, msg('bad', e.message)); });
    return h('div', { class: 'panel' }, h('h2', null, 'Invite friends'), box);
  }

  // Reads the chosen ID file as base64 text. Checks the size before sending.
  function readIdFile(inputEl) {
    return new Promise(function (resolve, reject) {
      var f = inputEl.files && inputEl.files[0];
      if (!f) return reject(new Error('Choose a photo or PDF of your ID.'));
      if (f.size > 3 * 1024 * 1024) return reject(new Error('That file is over 3 MB. Use a smaller photo or a PDF.'));
      var rd = new FileReader();
      rd.onload = function () { resolve(String(rd.result).split(',')[1] || ''); };
      rd.onerror = function () { reject(new Error('We could not read that file. Try another.')); };
      rd.readAsDataURL(f);
    });
  }

  function verifyIdView() {
    if (!S.user.email_verified) { S.flash = { kind: 'info', text: 'Confirm your email first.' }; return go('#/confirm'); }
    if (S.user.kyc_status === 'verified' || S.user.kyc_status === 'pending') return go('#/settings');
    var err = h('div');
    var name = input('text', 'full_name', { autocomplete: 'name', required: true });
    var dob = input('date', 'dob', { autocomplete: 'bday', required: true });
    var type = h('select', { name: 'id_type' }, h('option', { value: 'BVN' }, 'BVN'), h('option', { value: 'NIN' }, 'NIN'));
    var num = input('text', 'id_number', { inputmode: 'numeric', maxlength: '11', pattern: '[0-9]*', autocomplete: 'off', required: true });
    var addr = h('textarea', { name: 'address', required: true, autocomplete: 'street-address', rows: '3' });
    var file = h('input', { type: 'file', name: 'id_document', accept: 'image/jpeg,image/png,application/pdf', required: true });
    var btn = h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'Submit for review');
    var form = h('form', null,
      field('Full name', name, 'As it appears on your ID.'), field('Date of birth', dob, 'If your phone shows no date picker, type it like 1994-03-21.'),
      field('ID type', type), field('ID number', num, '11 digits. We store it encrypted.'),
      field('Home address', addr),
      field('Photo or PDF of your government ID', file, 'A JPEG, PNG or PDF under 3 MB. We store it encrypted. Make sure all four corners and the text are clear.'), err, btn);
    onSubmit(form, btn, err, function () {
      return readIdFile(file).then(function (b64) {
        return api('/api/kyc', { method: 'POST', body: { full_name: name.value, dob: dob.value, id_type: type.value, id_number: num.value, address: addr.value, id_document: { data: b64 } } });
      }).then(function () {
        S.user.kyc_status = 'pending';
        S.flash = { kind: 'ok', text: 'Thank you. We are reviewing your details and will email you.' };
        go('#/settings');
      });
    });
    mount(shell('settings', h('div', { class: 'wrap narrow' }, h('div', { class: 'panel' }, h('h1', null, 'Verify your identity'),
      h('p', null, 'This raises your trade limit and helps keep Kobodesk safe. Use your own details.'), form))), 'Verify identity');
  }

  // ---------- receipt ----------
  function receiptView(id) {
    var holder = h('div', null, h('p', { class: 'muted' }, 'Loading…'));
    mount(shell('trades', holder), 'Receipt');
    api('/api/trades/' + id + '/receipt').then(function (r) {
      clear(holder);
      var row = function (k, v) { return h('div', { class: 'kv' }, h('span', null, k), h('b', null, v)); };
      holder.appendChild(h('div', { class: 'wrap narrow receipt' }, h('div', { class: 'panel' },
        h('h1', null, 'Receipt'),
        h('p', { class: 'small muted' }, r.receipt_no + (r.company_name ? ' · ' + r.company_name : '') + (r.rc_number ? ' · RC ' + r.rc_number : '')),
        row('Naira paid to your bank', '₦' + r.payout_naira),
        row('Date', fmtDate(r.date)), row('Sold', r.amount + ' ' + r.coin), row('Network', r.network),
        row('Rate', '₦' + r.rate_naira + ' per ' + r.coin), row('Fee', '₦' + r.fee_naira),
        row('Paid to', r.account_name + ', ' + r.bank_name + ', ending ' + r.account_last4),
        row('Customer', r.customer_email), row('Trade ID', r.trade_id), r.payout_ref ? row('Bank reference', r.payout_ref) : null,
        h('p', { class: 'small muted' }, 'This receipt confirms that the trade above was completed. Keep it for your records.'),
        h('button', { type: 'button', class: 'btn btn-primary btn-block noprint', onclick: function () { window.print(); } }, 'Print or save as PDF'),
        h('p', { class: 'center noprint' }, h('a', { href: '#/trade/' + id }, 'Back to trade')))));
    }, handleErr);
  }

  // ---------- admin ----------
  function adminView() {
    if (!S.user.is_admin) return go('#/sell');
    var holder = h('div', null, h('p', { class: 'muted' }, 'Loading…'));
    mount(shell('admin', holder), 'Admin');
    if (S.user.admin_needs_2fa) {
      clear(holder);
      holder.appendChild(h('div', { class: 'wrap narrow' }, h('div', { class: 'panel' }, h('h1', null, 'Turn on two-factor sign-in'),
        h('p', null, 'The admin page holds identity documents and can release payouts, so it needs two-factor sign-in.'),
        h('a', { href: '#/settings', class: 'btn btn-primary btn-block' }, 'Go to Settings'))));
      return;
    }
    Promise.all([
      api('/api/admin/overview'), api('/api/admin/trades?status=held_for_review'), api('/api/admin/flags'),
      api('/api/admin/trades?status=payout_failed'), api('/api/admin/kyc'), api('/api/admin/deletion-requests'), api('/api/admin/audit?limit=50')
    ]).then(function (r) {
      var o = r[0], held = r[1], flags = r[2], failed = r[3], pending = r[4], deletions = r[5], audit = r[6], by = o.trades_by_status || {};
      var kv = function (k, v) { return h('div', { class: 'kv' }, h('span', null, k), h('b', null, v)); };
      var btn = function (text, kind, fn) { return h('button', { type: 'button', class: 'btn ' + (kind || 'btn-ghost') + ' btn-block', onclick: fn }, text); };
      var note = function (label) { return h('textarea', { rows: '2', 'aria-label': label }); };
      clear(holder);

      // Trades waiting for a person to release or reject them.
      var heldList = held.length ? held.map(function (t) {
        var out = h('div'), n = note('Note (needed to reject)');
        var decide = function (d) {
          clear(out);
          api('/api/admin/trades/' + t.id + '/review', { method: 'POST', body: { decision: d, note: n.value } }).then(adminView, function (e) { add(out, msg('bad', e.message)); });
        };
        return h('div', { class: 'admin-item' },
          h('div', { class: 'row-top' }, h('b', null, t.amount + ' ' + t.coin), badge(t.status)),
          h('p', { class: 'small muted' }, t.user_email + ' · ₦' + (t.payout_naira || t.quote_naira) + ' · ' + t.id),
          msg('warn', 'Why held: ' + (t.hold_reason || 'not recorded')),
          h('div', { class: 'field' }, h('label', null, 'Note (needed to reject)'), n), out,
          btn('Release payout', 'btn-primary', function () { decide('release'); }), h('div', { class: 'spacer' }),
          btn('Reject', 'btn-ghost', function () { decide('reject'); }));
      }) : [h('p', { class: 'muted' }, 'No trades are waiting for review.')];

      // Accounts paused by the anti-money-laundering rules.
      var flagList = flags.length ? flags.map(function (f) {
        var out = h('div'), n = note('Why you are clearing this flag');
        return h('div', { class: 'admin-item' },
          h('b', null, f.email), h('p', { class: 'small muted' }, fmtDate(new Date(f.flagged_at).toISOString())),
          msg('warn', f.flag_reason),
          h('div', { class: 'field' }, h('label', null, 'Why you are clearing this flag'), n), out,
          btn('Clear flag', 'btn-ghost', function () {
            clear(out);
            api('/api/admin/users/' + f.id + '/flag', { method: 'POST', body: { action: 'clear', note: n.value } }).then(adminView, function (e) { add(out, msg('bad', e.message)); });
          }));
      }) : [h('p', { class: 'muted' }, 'No flagged accounts.')];

      var failedList = failed.length ? failed.map(function (t) {
        var out = h('div');
        return h('div', { class: 'admin-item' },
          h('div', { class: 'row-top' }, h('b', null, t.amount + ' ' + t.coin), badge(t.status)),
          h('p', { class: 'small muted' }, t.id + ' · ' + (t.failure_reason || 'No reason recorded')), out,
          btn('Retry payout', 'btn-ghost', function () {
            clear(out);
            api('/api/admin/trades/' + t.id + '/retry-payout', { method: 'POST', body: {} }).then(adminView, function (e) { add(out, msg('bad', e.message)); });
          }));
      }) : [h('p', { class: 'muted' }, 'No failed payouts.')];

      // Identity checks, including the uploaded ID file. Opening either is recorded in the audit log.
      var kycList = pending.length ? pending.map(function (k) {
        var det = h('div');
        var review = btn('Review details', 'btn-ghost', function () {
          review.disabled = true;
          api('/api/admin/kyc/' + k.user_id).then(function (d) {
            review.hidden = true;
            var n = note('Reason (needed to reject)'), out = h('div'), docBox = h('div');
            var decide = function (status) {
              clear(out);
              api('/api/admin/kyc/' + k.user_id + '/decision', { method: 'POST', body: { status: status, note: n.value } }).then(adminView, function (e) { add(out, msg('bad', e.message)); });
            };
            var viewDoc = btn('View ID file', 'btn-ghost', function () {
              viewDoc.disabled = true;
              api('/api/admin/kyc/' + k.user_id + '/document').then(function (f) {
                viewDoc.hidden = true;
                if (f.mime === 'application/pdf') {
                  try {
                    var bin = atob(f.data), arr = new Uint8Array(bin.length);
                    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
                    var url = URL.createObjectURL(new Blob([arr], { type: 'application/pdf' }));
                    add(docBox, h('a', { href: url, target: '_blank', rel: 'noopener', class: 'btn btn-primary btn-block' }, 'Open the PDF'));
                  } catch (e) { add(docBox, msg('bad', 'Could not open the PDF.')); }
                } else {
                  add(docBox, h('img', { src: 'data:' + f.mime + ';base64,' + f.data, alt: 'Uploaded ID', class: 'idimg' }));
                }
              }, function (e) { viewDoc.disabled = false; add(docBox, msg('bad', e.message)); });
            });
            add(det, kv('Name', d.full_name), kv('Date of birth', d.dob), kv(d.id_type, d.id_number), kv('Address', d.address),
              d.has_document ? viewDoc : msg('warn', 'No ID file was uploaded.'), docBox,
              h('div', { class: 'field' }, h('label', null, 'Reason (needed to reject)'), n), out,
              btn('Approve', 'btn-primary', function () { decide('verified'); }), h('div', { class: 'spacer' }),
              btn('Reject', 'btn-ghost', function () { decide('rejected'); }));
          }, function (e) { review.disabled = false; add(det, msg('bad', e.message)); });
        });
        return h('div', { class: 'admin-item' },
          h('div', { class: 'row-top' }, h('b', null, k.full_name), h('span', { class: 'badge badge-warn' }, k.id_type + ' ending ' + k.id_last4)),
          h('p', { class: 'small muted' }, k.email + ' · ' + fmtDate(new Date(k.submitted_at).toISOString())), det, review);
      }) : [h('p', { class: 'muted' }, 'No identity checks waiting.')];

      var delList = deletions.length ? deletions.map(function (d) {
        var out = h('div'), n = note('What you deleted, what you kept, and why');
        return h('div', { class: 'admin-item' },
          h('b', null, d.email), h('p', { class: 'small muted' }, 'Asked ' + fmtDate(new Date(d.requested_at).toISOString())),
          h('div', { class: 'field' }, h('label', null, 'What you deleted, what you kept, and why'), n), out,
          btn('Mark as done', 'btn-ghost', function () {
            clear(out);
            api('/api/admin/deletion-requests/' + d.id + '/close', { method: 'POST', body: { note: n.value } }).then(adminView, function (e) { add(out, msg('bad', e.message)); });
          }));
      }) : [h('p', { class: 'muted' }, 'No open requests.')];

      // The audit log: filter by trade ID to follow one trade from start to finish.
      var logBox = h('div');
      var drawLog = function (rows) {
        clear(logBox);
        if (!rows.length) return add(logBox, h('p', { class: 'muted' }, 'No entries.'));
        rows.forEach(function (e) {
          var d = e.detail == null ? '' : JSON.stringify(e.detail);
          add(logBox, h('div', { class: 'logrow' },
            h('b', null, e.type.replace(/_/g, ' ')), h('span', { class: 'small muted' }, ' ' + fmtDate(e.at) + (e.trade_id ? ' · ' + e.trade_id : '')),
            d ? h('div', { class: 'small mono logdetail' }, d.length > 200 ? d.slice(0, 200) + '…' : d) : null));
        });
      };
      drawLog(audit);
      var tid = input('text', 'trade_id', { placeholder: 'trd_…', autocomplete: 'off' });
      var logErr = h('div');
      var logForm = h('form', null, field('Trade ID (leave empty for the latest entries)', tid), logErr, h('button', { type: 'submit', class: 'btn btn-ghost btn-block' }, 'Show log'));
      logForm.addEventListener('submit', function (ev) {
        ev.preventDefault(); clear(logErr);
        api('/api/admin/audit?limit=200' + (tid.value.trim() ? '&trade_id=' + encodeURIComponent(tid.value.trim()) : '')).then(drawLog, function (e) { add(logErr, msg('bad', e.message)); });
      });

      holder.appendChild(h('div', { class: 'wrap narrow' },
        h('h1', null, 'Admin'),
        h('div', { class: 'panel' }, h('h2', null, 'Overview'),
          kv('Customers', String(o.users)), kv('Paid out', '₦' + o.paid_out_naira), kv('Paid trades', String(by.paid_out || 0)),
          kv('In progress', String((by.awaiting_deposit || 0) + (by.confirming || 0) + (by.paying_out || 0)))),
        h('div', { class: 'panel' }, h('h2', null, 'Trades held for review (' + held.length + ')'), h('p', { class: 'small muted' }, 'Large payouts and flagged accounts wait here. Rejecting does not return crypto: refund it by hand and tell the customer.'), heldList),
        h('div', { class: 'panel' }, h('h2', null, 'Flagged accounts (' + flags.length + ')'), flagList),
        h('div', { class: 'panel' }, h('h2', null, 'Failed payouts (' + failed.length + ')'), failedList),
        h('div', { class: 'panel' }, h('h2', null, 'Identity checks to review (' + pending.length + ')'), h('p', { class: 'small muted' }, 'Opening details or the ID file is recorded in the audit log.'), kycList),
        h('div', { class: 'panel' }, h('h2', null, 'Data deletion requests (' + deletions.length + ')'), delList),
        h('div', { class: 'panel' }, h('h2', null, 'Audit log'), logForm, h('div', { class: 'spacer' }), logBox)));
    }, handleErr);
  }

  // ---------- routing ----------
  function handleErr(e) {
    if (e && e.status === 401 && e.code === 'unauthorized') {
      saveToken(null); S.user = null;
      S.flash = { kind: 'info', text: 'Please log in again.' };
      return go('#/login');
    }
    var retry = h('button', { type: 'button', class: 'btn btn-primary', onclick: route }, 'Try again');
    mount(h('div', { class: 'wrap narrow auth-card' }, h('div', { class: 'panel' }, h('h1', null, 'Something went wrong'), msg('bad', (e && e.message) || 'Try again.'), retry)), 'Error');
  }

  function authed(fn) {
    if (!S.token) { return go('#/login'); }
    api('/api/me').then(function (u) { S.user = u; fn(); }, handleErr);
  }

  function route() {
    clearTimers();
    var hash = location.hash || '';
    var m;
    if ((m = hash.match(/^#verify=([\w-]+)$/))) return verifyView(m[1]);
    if ((m = hash.match(/^#reset=([\w-]+)$/))) return resetView(m[1]);
    var path = hash.replace(/^#/, '');
    var open = { '/login': loginView, '/signup': signupView, '/forgot': forgotView };
    if (open[path]) { if (S.token) return go('#/sell'); return open[path](); }
    if (path === '/confirm') return authed(confirmView);
    if (path === '/verify') return authed(verifyIdView);
    if (path === '/admin') return authed(adminView);
    if (path === '/sell') return authed(sellView);
    if (path === '/trades') return authed(tradesView);
    if (path === '/settings') return authed(settingsView);
    if ((m = path.match(/^\/receipt\/([\w-]+)$/))) return authed(function () { receiptView(m[1]); });
    if ((m = path.match(/^\/trade\/([\w-]+)$/))) return authed(function () { tradeView(m[1]); });
    return go(S.token ? '#/sell' : '#/login');
  }

  loadToken();
  captureRef();
  window.addEventListener('hashchange', route);
  Promise.all([
    api('/api/health', { anon: true }).then(function (r) { S.mode = r.mode; }, function () { /* keep default */ }),
    api('/api/site-config', { anon: true }).then(function (c) { S.site = c; }, function () { /* optional */ })
  ]).then(route);
})();
