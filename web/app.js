// Kobodesk customer app: sign up, log in, sell crypto, track trades, settings.
// Plain JavaScript with no libraries. All server text is added with text nodes, never as HTML.
(function () {
  'use strict';

  var root = document.getElementById('root');
  var S = { token: null, user: null, mode: 'live', flash: null, timers: [] };
  var uid = 0;
  var STATUS = {
    awaiting_deposit: ['Waiting for your deposit', 'warn'],
    confirming: ['Deposit received, confirming', 'warn'],
    paying_out: ['Sending naira to your bank', 'warn'],
    paid_out: ['Paid', 'ok'],
    expired: ['Expired', 'bad'],
    payout_failed: ['Needs attention', 'bad']
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
    var tab = function (key, text, href) { return h('a', { href: href, class: key === active ? 'on' : '', 'aria-current': key === active ? 'page' : false }, text); };
    parts.push(h('div', { class: 'band' }, h('div', { class: 'wrap appbar' },
      h('a', { href: '#/sell', class: 'logo' }, LOGO(), h('span', null, 'Kobodesk')),
      h('button', { type: 'button', class: 'link-btn', onclick: function () {
        saveToken(null); S.user = null; S.flash = { kind: 'info', text: 'You are logged out.' }; go('#/login');
      } }, 'Log out'))));
    parts.push(h('main', { class: 'wrap app' },
      h('nav', { class: 'tabs', 'aria-label': 'Main' }, tab('sell', 'Sell', '#/sell'), tab('trades', 'My trades', '#/trades'), tab('settings', 'Settings', '#/settings')),
      flash ? msg(flash.kind, flash.text) : null,
      content));
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
    var btn = h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'Log in');
    var form = h('form', null, field('Email', email), field('Password', pw), codeWrap, btn);
    onSubmit(form, btn, err, function () {
      return api('/api/auth/login', { method: 'POST', anon: true, body: { email: email.value, password: pw.value, code: code.value || undefined } })
        .then(function (r) { saveToken(r.token); S.user = r.user; go('#/sell'); }, function (e) {
          if (e.code === 'totp_required') { codeWrap.hidden = false; code.focus(); e.kind = 'info'; }
          throw e;
        });
    });
    mount(card('Log in', err, form, h('div', null, link('Forgot your password?', '#/forgot'), link('Create an account', '#/signup'))), 'Log in');
  }

  function signupView() {
    var err = h('div');
    var email = input('email', 'email', { autocomplete: 'username', required: true, inputmode: 'email' });
    var pw = input('password', 'password', { autocomplete: 'new-password', required: true, minlength: '10' });
    var agree = h('input', { type: 'checkbox', required: true });
    var agreeId = 'f' + (++uid);
    agree.id = agreeId;
    var btn = h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'Create account');
    var form = h('form', null,
      field('Email', email), field('Password', pw, 'At least 10 characters.'),
      h('div', { class: 'field' }, h('label', { for: agreeId }, agree, ' I agree to the ', h('a', { href: '/terms.html' }, 'Terms'), ' and ', h('a', { href: '/privacy.html' }, 'Privacy Policy'), '.')),
      btn);
    onSubmit(form, btn, err, function () {
      return api('/api/auth/signup', { method: 'POST', anon: true, body: { email: email.value, password: pw.value } }).then(function (r) {
        saveToken(r.token); S.user = r.user;
        S.flash = { kind: 'info', text: 'Welcome. We sent a 6-digit code to ' + r.user.email + '.' };
        go('#/confirm');
      });
    });
    mount(card('Create your account', err, form, link('I already have an account', '#/login')), 'Sign up');
  }

  function forgotView() {
    var err = h('div');
    var email = input('email', 'email', { autocomplete: 'username', required: true, inputmode: 'email' });
    var btn = h('button', { type: 'submit', class: 'btn btn-primary btn-block' }, 'Send reset link');
    var form = h('form', null, field('Email', email), btn);
    var box = h('div', null, form);
    onSubmit(form, btn, err, function () {
      return api('/api/auth/forgot-password', { method: 'POST', anon: true, body: { email: email.value } }).then(function (r) {
        clear(box); add(box, msg('ok', r.message));
      });
    });
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
    Promise.all([api('/api/assets', { anon: true }), api('/api/banks', { anon: true }), api('/api/bank-accounts')]).then(function (r) {
      clear(holder);
      holder.appendChild(buildSell(r[0], r[1], r[2]));
    }, handleErr);
  }

  function buildSell(assets, banks, accounts) {
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
      err,
      submit);
    onSubmit(form, submit, err, function () {
      if (st.accountId === '__new') { var e = new Error('Choose a bank account, or save a new one first.'); throw e; }
      return api('/api/trades', { method: 'POST', body: { coin: st.coin, network: st.network, amount: amount.value.replace(/,/g, '').trim(), bank_account_id: st.accountId } })
        .then(function (t) { go('#/trade/' + t.id); });
    });

    drawCoins(); drawNetworks(); drawAccounts();
    return h('div', { class: 'wrap narrow', style: false }, h('div', { class: 'panel' }, h('h1', null, 'Sell crypto'), form));
  }

  // ---------- one trade ----------
  var TERMINAL = { paid_out: 1, expired: 1, payout_failed: 1 };

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

    if (t.status === 'paid_out') kids.push(msg('ok', 'Paid. ₦' + t.payout_naira + ' is on its way to your bank account.'));
    else if (t.status === 'payout_failed') kids.push(msg('warn', 'Your deposit arrived, but the bank transfer did not go through. We are looking into it. Contact support and quote the trade ID below.'));
    else if (t.status === 'expired') kids.push(msg('bad', 'This quote expired. If you already sent crypto, contact support with the trade ID below. Otherwise, start a new trade.'));
    else if (t.status === 'confirming') kids.push(msg('info', 'We saw your deposit. We are waiting for the network to confirm it. You can leave this page.'));
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
      h('p', { class: 'small muted' }, 'Your trade limit depends on your identity check. Identity checks are not open yet.')));

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
    kids.push(h('div', { class: 'panel' }, h('h2', null, 'Devices'), h('p', null, 'Lost a phone or used a shared computer? Log out everywhere.'), oBtn));

    holder.appendChild(h('div', { class: 'wrap narrow' }, h('h1', null, 'Settings'), kids));
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
    if (path === '/sell') return authed(sellView);
    if (path === '/trades') return authed(tradesView);
    if (path === '/settings') return authed(settingsView);
    if ((m = path.match(/^\/trade\/([\w-]+)$/))) return authed(function () { tradeView(m[1]); });
    return go(S.token ? '#/sell' : '#/login');
  }

  loadToken();
  window.addEventListener('hashchange', route);
  api('/api/health', { anon: true }).then(function (r) { S.mode = r.mode; }, function () { /* keep default */ }).then(route);
})();
