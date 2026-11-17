// Landing page: live rate calculator and FAQ. Plain JavaScript, no libraries.
(function () {
  'use strict';

  var coinsEl = document.getElementById('coins');
  var amt = document.getElementById('amt');
  var nairaEl = document.getElementById('naira');
  var rateLine = document.getElementById('rateLine');
  var assets = {};
  var coin = 'USDT';
  var timer = null;
  var seq = 0;

  function getJson(url) {
    return fetch(url).then(function (res) {
      return res.json().then(function (body) { return { ok: res.ok, body: body }; });
    });
  }

  function fmtNaira(kobo) {
    var s = String(Math.floor(kobo / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return '₦' + s;
  }

  function update() {
    var mine = ++seq;
    var network = assets[coin] && assets[coin][0];
    if (!network) return;
    getJson('/api/quote?coin=' + coin + '&network=' + network + '&amount=' + encodeURIComponent(amt.value.replace(/,/g, '')))
      .then(function (r) {
        if (mine !== seq) return; // a newer request replaced this one
        if (!r.ok) {
          nairaEl.textContent = '—';
          rateLine.textContent = r.body && r.body.error ? r.body.error.message : 'Enter an amount to see the estimate.';
          return;
        }
        var q = r.body;
        nairaEl.textContent = '₦' + q.quote_naira.replace(/\.00$/, '');
        rateLine.textContent = 'Estimate at 1 ' + coin + ' = ' + fmtNaira(q.rate_kobo) + '. We show the exact amount before you send.';
      })
      .catch(function () {
        if (mine !== seq) return;
        nairaEl.textContent = '—';
        rateLine.textContent = 'We could not load the rate. Check your connection and try again.';
      });
  }

  function pick(code) {
    coin = code;
    var btns = coinsEl.querySelectorAll('.coin');
    for (var i = 0; i < btns.length; i++) {
      var on = btns[i].getAttribute('data-coin') === code;
      btns[i].className = on ? 'coin on' : 'coin';
      btns[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    document.getElementById('coinName').textContent = code;
    document.getElementById('sellName').textContent = code;
    update();
  }

  getJson('/api/assets').then(function (r) {
    r.body.forEach(function (a) {
      assets[a.coin] = a.networks;
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'coin' + (a.coin === coin ? ' on' : '');
      b.setAttribute('data-coin', a.coin);
      b.setAttribute('aria-pressed', a.coin === coin ? 'true' : 'false');
      b.textContent = a.coin;
      b.addEventListener('click', function () { pick(a.coin); });
      coinsEl.appendChild(b);
    });
    update();
  }).catch(function () {
    rateLine.textContent = 'We could not load the rate. Check your connection and try again.';
  });

  getJson('/api/rates').then(function (r) {
    document.getElementById('rateTag').textContent = r.body.sample ? 'Sample rates' : 'Estimate';
  }).catch(function () {});

  function onType() {
    clearTimeout(timer);
    timer = setTimeout(update, 250);
  }
  amt.addEventListener('input', onType);
  amt.addEventListener('change', update);

  // FAQ
  var qs = document.querySelectorAll('#faqList .q');
  for (var k = 0; k < qs.length; k++) {
    qs[k].addEventListener('click', function () {
      var open = this.getAttribute('aria-expanded') === 'true';
      for (var m = 0; m < qs.length; m++) {
        qs[m].setAttribute('aria-expanded', 'false');
        qs[m].lastChild.textContent = '+';
        qs[m].nextElementSibling.hidden = true;
      }
      if (!open) {
        this.setAttribute('aria-expanded', 'true');
        this.lastChild.textContent = '−';
        this.nextElementSibling.hidden = false;
      }
    });
  }
})();

// Sideways sections: the arrow buttons scroll one card at a time.
(function () {
  'use strict';
  var navs = document.querySelectorAll('.railnav');
  for (var i = 0; i < navs.length; i++) {
    (function (nav) {
      var rail = document.getElementById(nav.getAttribute('data-rail'));
      if (!rail) return;
      var btns = nav.querySelectorAll('.railbtn');
      for (var j = 0; j < btns.length; j++) {
        btns[j].addEventListener('click', function () {
          var dir = Number(this.getAttribute('data-dir'));
          var card = rail.firstElementChild;
          var step = card ? card.getBoundingClientRect().width + 16 : rail.clientWidth * 0.8;
          try { rail.scrollBy({ left: dir * step, behavior: 'smooth' }); }
          catch (e) { rail.scrollLeft += dir * step; }
        });
      }
    })(navs[i]);
  }
})();
