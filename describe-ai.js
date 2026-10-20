/*
 * Swift Importers — automatic product descriptions (describe-ai.js)
 * Used by the admin and employee apps. Sends the product title to the describe Worker
 * (describe-worker.js) and fills the Description box with the answer.
 */
(function () {
  'use strict';
  // The Worker from describe-worker.js
  var API = 'https://swift-describe.swiftimportersug.workers.dev';

  function token() {
    var u = window.fbAuth && window.fbAuth.currentUser;
    if (!u) return Promise.reject(new Error('Please sign in again first'));
    return u.getIdToken();
  }
  function toast(msg, kind) {
    try { if (typeof window.showToast === 'function') window.showToast(msg, kind || 'info', 4000); } catch (e) {}
  }

  // Writes a description from the product name + category into the box. Resolves true when it filled it.
  function fillDescription() {
    var nameEl = document.getElementById('f-name'), box = document.getElementById('f-description'), catEl = document.getElementById('f-cat');
    var title = nameEl ? nameEl.value.trim() : '';
    if (!box || title.length < 3) return Promise.resolve(false);
    var cat = catEl && catEl.value && catEl.value !== '__add_new__' ? catEl.value : '';
    return token().then(function (t) {
      return fetch(API + '/describe', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title, category: cat })
      });
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok || !j.text) throw new Error(j.error || ('Could not write the description (' + r.status + ')'));
        return j.text;
      });
    }).then(function (text) {
      box.value = text;
      try { if (typeof window.updateDescWordCount === 'function') window.updateDescWordCount(box); } catch (e) {}
      box.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    });
  }

  // The "✨ Auto-write" button next to Insert Image / Color / Table.
  function writeClick(btn) {
    var box = document.getElementById('f-description');
    var nameEl = document.getElementById('f-name');
    if (!nameEl || nameEl.value.trim().length < 3) { toast('Type the product name first', 'error'); return; }
    var go = function () {
      var label = btn ? btn.textContent : '';
      if (btn) { btn.disabled = true; btn.textContent = '✨ Writing…'; }
      fillDescription().then(function () { toast('✨ Description written — read it through and edit anything you like', 'success'); })
        .catch(function (e) { toast('Could not write the description: ' + e.message, 'error'); })
        .then(function () { if (btn) { btn.disabled = false; btn.textContent = label; } });
    };
    if (box && box.value.trim() && typeof window.showAppConfirm === 'function') {
      window.showAppConfirm('Replace the description you already have with a new one written from the product name?', go, null, { icon: '✨', confirmText: 'Replace' });
    } else go();
  }

  window.SwiftAI = { fillDescription: fillDescription, writeClick: writeClick };
})();
