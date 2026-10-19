/*
 * Swift Importers — product picture upload + mover (image-upload.js)
 * Used by the admin and employee apps.
 *
 *  - SwiftImages.pickAndUpload()  : choose photos from the phone/computer, shrink them to WebP,
 *                                   store them in our R2 bucket, and add them to the product.
 *  - SwiftImages.openMigrate()    : (admin) copy every product picture that still lives on imgbb /
 *                                   Google Drive into our bucket and update the products.
 */
(function () {
  'use strict';

  // The Worker from image-upload-worker.js
  var API = 'https://swift-images.swiftimportersug.workers.dev';
  var MAX_SIDE = 1000;        // longest side in pixels
  var QUALITY = 0.82;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function token() {
    var u = window.fbAuth && window.fbAuth.currentUser;
    if (!u) return Promise.reject(new Error('Please sign in again first'));
    return u.getIdToken();
  }

  // ---- shrink to WebP in the browser ----
  function shrink(file) {
    return new Promise(function (resolve, reject) {
      var done = function (img, w, h) {
        var k = Math.min(1, MAX_SIDE / Math.max(w, h));
        var cw = Math.max(1, Math.round(w * k)), ch = Math.max(1, Math.round(h * k));
        var c = document.createElement('canvas'); c.width = cw; c.height = ch;
        var g = c.getContext('2d');
        g.fillStyle = '#fff'; g.fillRect(0, 0, cw, ch);          // transparent PNGs get a white background
        g.drawImage(img, 0, 0, cw, ch);
        c.toBlob(function (b) {
          if (b && b.type === 'image/webp') return resolve(b);
          c.toBlob(function (j) { j ? resolve(j) : reject(new Error('Could not process this picture')); }, 'image/jpeg', QUALITY);
        }, 'image/webp', QUALITY);
      };
      if (window.createImageBitmap) {
        createImageBitmap(file).then(function (bm) { done(bm, bm.width, bm.height); }, function () { viaImg(); });
      } else viaImg();
      function viaImg() {
        var url = URL.createObjectURL(file), im = new Image();
        im.onload = function () { done(im, im.naturalWidth, im.naturalHeight); URL.revokeObjectURL(url); };
        im.onerror = function () { URL.revokeObjectURL(url); reject(new Error('This file is not a picture')); };
        im.src = url;
      }
    });
  }

  function post(path, init) {
    return token().then(function (t) {
      init.headers = Object.assign({ Authorization: 'Bearer ' + t }, init.headers || {});
      init.method = 'POST';
      return fetch(API + path, init);
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok || !j.url) throw new Error(j.error || ('Upload failed (' + r.status + ')'));
        return j.url;
      });
    });
  }

  function uploadFile(file) {
    return shrink(file).then(function (blob) {
      return post('/upload', { body: blob, headers: { 'Content-Type': blob.type } });
    });
  }
  function copyFromUrl(url) {
    return post('/fetch', { body: JSON.stringify({ url: url }), headers: { 'Content-Type': 'application/json' } });
  }

  // ---- "Upload photos" button in the product form ----
  function setStatus(msg, bad) {
    var el = document.getElementById('img-upload-status');
    if (!el) return;
    el.style.display = msg ? 'block' : 'none';
    el.style.color = bad ? '#ff6b6b' : '#9be3a8';
    el.textContent = msg || '';
  }
  function pickAndUpload() {
    var inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = true;
    inp.onchange = function () {
      var files = Array.prototype.slice.call(inp.files || []);
      if (!files.length) return;
      var i = 0, ok = 0, failed = 0, lastErr = '';
      (function next() {
        if (i >= files.length) {
          setStatus('✅ ' + ok + ' photo' + (ok === 1 ? '' : 's') + ' uploaded and added below' + (failed ? ' — ' + failed + ' failed (' + lastErr + ')' : ''), failed > 0 && ok === 0);
          return;
        }
        setStatus('Uploading ' + (i + 1) + ' of ' + files.length + '…');
        uploadFile(files[i]).then(function (url) {
          ok++; if (typeof window.addImageRow === 'function') window.addImageRow(url);
        }).catch(function (e) { failed++; lastErr = e.message; console.error('[images]', e); })
          .then(function () { i++; next(); });
      })();
    };
    inp.click();
  }

  // ---- single "Upload" button next to a link box (warehouse cover photos, bundle picture, variant picture) ----
  // target: an <input> element or its id. The uploaded picture's link is written into the box and the
  // box's own "input" handlers run, so previews and saving behave exactly as if the link had been pasted.
  function pickInto(target, btn) {
    var box = typeof target === 'string' ? document.getElementById(target) : target;
    if (!box) return;
    var inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*';
    inp.onchange = function () {
      var f = inp.files && inp.files[0];
      if (!f) return;
      var label = btn ? btn.textContent : '';
      if (btn) { btn.disabled = true; btn.textContent = 'Uploading\u2026'; }
      uploadFile(f).then(function (url) {
        box.value = url;
        box.dispatchEvent(new Event('input', { bubbles: true }));
        box.dispatchEvent(new Event('change', { bubbles: true }));
        if (btn) btn.textContent = '\u2705 Uploaded';
        setTimeout(function () { if (btn) { btn.textContent = label; btn.disabled = false; } }, 1800);
      }).catch(function (e) {
        console.error('[images]', e);
        if (btn) { btn.textContent = label; btn.disabled = false; }
        var msg = 'Could not upload the picture: ' + e.message;
        try { if (typeof window.showAppAlert === 'function') window.showAppAlert(msg); else alert(msg); } catch (x) {}
      });
    };
    inp.click();
  }

  // ---- moving old pictures (admin) ----
  var OLD_HOST = /^https?:\/\/(?:[a-z0-9-]+\.)?(?:ibb\.co|imgbb\.com)\/|^https?:\/\/drive\.google\.com\/uc\?/i;
  function isOld(u) { return typeof u === 'string' && OLD_HOST.test(u.trim()); }

  function collectOld(p) {
    var set = {};
    if (isOld(p.image)) set[p.image] = 1;
    (p.images || []).forEach(function (u) { if (isOld(u)) set[u] = 1; });
    if (isOld(p.bundleImage)) set[p.bundleImage] = 1;
    (p.variants || []).forEach(function (v) { if (isOld(v.variantImage)) set[v.variantImage] = 1; });
    return Object.keys(set);
  }
  function applyMap(p, map) {
    var q = JSON.parse(JSON.stringify(p));
    var m = function (u) { return map[u] || u; };
    if (q.image) q.image = m(q.image);
    if (q.images) q.images = q.images.map(m);
    if (q.bundleImage) q.bundleImage = m(q.bundleImage);
    (q.variants || []).forEach(function (v) { if (v.variantImage) v.variantImage = m(v.variantImage); });
    return q;
  }

  var running = false;
  function openMigrate() {
    var list = (window.products || (typeof products !== 'undefined' ? products : [])) || [];
    var todo = list.filter(function (p) { return collectOld(p).length; });
    var m = document.getElementById('sim-modal');
    if (!m) {
      m = document.createElement('div'); m.id = 'sim-modal';
      m.style.cssText = 'position:fixed;inset:0;z-index:100001;background:rgba(0,0,0,.75);display:flex;align-items:center;justify-content:center;padding:16px;';
      document.body.appendChild(m);
    }
    m.style.display = 'flex';
    m.innerHTML = '<div style="background:#fff;max-width:520px;width:100%;max-height:90vh;display:flex;flex-direction:column;border-radius:14px;overflow:hidden;font-family:system-ui,sans-serif;">' +
      '<div style="padding:14px 16px;font-weight:800;border-bottom:1px solid #eee;display:flex;justify-content:space-between;">🚚 Move pictures to the new host<button id="sim-x" style="border:0;background:#eee;border-radius:50%;width:30px;height:30px;cursor:pointer;">✕</button></div>' +
      '<div style="padding:14px 16px;overflow:auto;font-size:.85rem;line-height:1.6;">' +
      '<div id="sim-summary"><strong>' + todo.length + '</strong> product' + (todo.length === 1 ? '' : 's') + ' still use pictures from imgbb / Google Drive.</div>' +
      '<div id="sim-bar" style="height:10px;background:#eee;border-radius:6px;margin:10px 0;overflow:hidden;"><div id="sim-fill" style="height:100%;width:0;background:#25a244;transition:width .2s;"></div></div>' +
      '<div id="sim-log" style="font-size:.74rem;color:#555;max-height:200px;overflow:auto;white-space:pre-wrap;"></div></div>' +
      '<div style="padding:12px 16px;border-top:1px solid #eee;display:flex;gap:8px;"><button id="sim-go" style="flex:1;background:#012e7b;color:#fff;border:0;border-radius:9px;padding:12px;font-weight:800;cursor:pointer;">Start moving</button></div></div>';
    document.getElementById('sim-x').onclick = function () { if (!running) m.style.display = 'none'; };
    var go = document.getElementById('sim-go');
    if (!todo.length) { go.disabled = true; go.textContent = 'Nothing to move 🎉'; return; }
    go.onclick = function () { if (!running) runMigrate(todo, go); };
  }

  async function copyWithRetry(u) {
    var last;
    for (var a = 0; a < 3; a++) {
      try { return await copyFromUrl(u); } catch (e) { last = e; await new Promise(function (r) { setTimeout(r, 600 * (a + 1)); }); }
    }
    throw last;
  }

  async function runMigrate(todo, go) {
    running = true; go.disabled = true; go.textContent = 'Moving\u2026 keep this window open';
    var log = document.getElementById('sim-log'), fill = document.getElementById('sim-fill');
    var say = function (t) { log.textContent += t + '\n'; log.scrollTop = log.scrollHeight; };
    var moved = 0, productsDone = 0, failed = 0, cache = {};
    for (var i = 0; i < todo.length; i++) {
      var p = todo[i], urls = collectOld(p), map = {}, pFail = 0;
      fill.style.width = Math.round(i / todo.length * 100) + '%';
      for (var j = 0; j < urls.length; j++) {
        var u = urls[j];
        if (cache[u]) { map[u] = cache[u]; continue; }
        try { map[u] = cache[u] = await copyWithRetry(u); }
        catch (e) { pFail++; say('\u2716 ' + (p.name || p.id) + ': ' + e.message + ' \u2014 ' + u.slice(0, 60)); }
      }
      var n = Object.keys(map).length;
      if (n) {
        try {
          var np = applyMap(p, map);
          await (window.fbSaveProduct ? window.fbSaveProduct(np) : fbSaveProduct(np));
          try { Object.assign(p, np); } catch (e) {}
          moved += n; productsDone++;
          say('\u2714 ' + (p.name || p.id) + ' \u2014 ' + n + ' picture(s)' + (pFail ? ', ' + pFail + ' failed' : ''));
        } catch (e) { pFail += n; say('\u2716 could not save ' + (p.name || p.id) + ': ' + e.message); }
      }
      failed += pFail;
    }
    fill.style.width = '100%';
    running = false;
    document.getElementById('sim-summary').innerHTML = '\u2705 Done. <strong>' + moved + '</strong> pictures moved across <strong>' + productsDone + '</strong> products' + (failed ? ', <strong style="color:#c0392b">' + failed + ' could not be moved</strong> (they keep their old link \u2014 run this again later to retry them).' : '.');
    go.textContent = 'Close'; go.disabled = false;
    go.onclick = function () { document.getElementById('sim-modal').style.display = 'none'; };
  }

  window.SwiftImages = { pickInto: pickInto, pickAndUpload: pickAndUpload, openMigrate: openMigrate, upload: uploadFile };
})();
