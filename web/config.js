// Fills company details on public pages from the server settings, and lets phones install the site as an app.
(function () {
  'use strict';

  function each(sel, fn) {
    var nodes = document.querySelectorAll(sel);
    for (var i = 0; i < nodes.length; i++) fn(nodes[i]);
  }

  fetch('/api/site-config').then(function (r) { return r.json(); }).then(function (c) {
    var line = [c.company_name, c.rc_number ? 'RC ' + c.rc_number : '', c.sec_registration].filter(Boolean).join(' · ');
    each('[data-cfg]', function (el) {
      var key = el.getAttribute('data-cfg');
      var value = key === 'company_line' ? line : c[key];
      if (value) el.textContent = value;
    });
    if (c.support_email) {
      each('[data-cfg-mailto]', function (el) { el.setAttribute('href', 'mailto:' + c.support_email); });
    }
    var configured = !!c.company_name;
    each('[data-cfg-wa]', function (el) {
      if (c.support_whatsapp) {
        el.setAttribute('href', 'https://wa.me/' + c.support_whatsapp);
        var label = el.querySelector('[data-cfg-wa-text]');
        if (label) label.textContent = '+' + c.support_whatsapp;
      } else if (configured) {
        el.hidden = true; // set up, but no WhatsApp number: hide the tile instead of showing a placeholder
      }
    });
  }).catch(function () { /* placeholders stay */ });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').catch(function () { /* optional */ });
    });
  }
})();
