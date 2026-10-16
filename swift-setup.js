/*
 * swift-setup.js — "Get this phone ready"
 * ---------------------------------------
 * Inside the installed Android apps, shows a short checklist of the phone settings the app needs so calls,
 * messages and job alerts arrive on time (notifications, show over other apps, battery, auto-start, ...).
 * Every row has a button that jumps straight to the right Android screen, the list re-checks itself when the
 * person comes back, and it keeps coming back each time the app opens until the important ones are done.
 *
 *   SwiftSetup.start('customer' | 'staff' | 'rider')   // call once the person is signed in (customer: on load)
 *
 * Needs the native AppSetup plugin (install-app-setup.js). In a normal browser it does nothing.
 */
(function () {
  'use strict';
  if (window.SwiftSetup) return;

  var role = '';
  var status = null;
  var sheet = null, chip = null, pollTimer = null, started = false, sheetOpen = false;
  var openedFor = '';           // row the person is currently visiting in Settings
  var expanded = {};            // rows whose steps are showing

  function native() { var a = window.SwiftApp && window.SwiftApp.appSetup; return a && a.available ? a : null; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  var OEM_NAME = { transsion: 'Tecno / Infinix / itel', xiaomi: 'Xiaomi / Redmi / Poco', oppo: 'Oppo / Realme / OnePlus', vivo: 'Vivo / iQOO', huawei: 'Huawei / Honor' };
  var AUTOSTART_STEPS = {
    transsion: 'In the screen that opens (Phone Master / Auto-start), find “{app}” and switch it ON. If it does not open, go to Phone Master → Manage → Auto-start (or App launch).',
    xiaomi: 'Find “{app}” in the Autostart list and switch it ON. Then open Settings → Apps → Manage apps → {app} → Battery saver → choose “No restrictions”.',
    oppo: 'Find “{app}” and switch ON “Allow auto-start” (or “Allow background activity”).',
    vivo: 'Find “{app}” and switch it ON. Also open Settings → Battery → Background power consumption → {app} → Allow.',
    huawei: 'Find “{app}”, switch OFF “Manage automatically”, then switch ON Auto-launch, Secondary launch and Run in background.'
  };

  // ── the checklist ──
  function items() {
    var s = status || {};
    var app = s.appName || 'this app';
    var what = role === 'rider' ? 'new delivery requests' : (role === 'staff' ? 'rider calls and new orders' : 'calls from your rider and order updates');
    var list = [];
    list.push({ id: 'notifications', icon: '🔔', title: 'Notifications', why: 'So you hear ' + what + '.', req: true, done: !!s.notifications, open: 'notifications', btn: 'Allow',
      how: 'Tap Allow on the pop-up. If it does not appear, switch notifications ON for “' + app + '”.' });
    list.push({ id: 'overlay', icon: '📲', title: 'Show over other apps', why: role === 'rider' ? 'Lets a new job request open on your screen even while you use another app.' : 'Lets a call open on your screen even while you use another app.', req: true, done: !!s.overlay, open: 'overlay', btn: 'Open settings',
      how: 'Find “' + app + '” in the list, switch it ON, then come back.' });
    list.push({ id: 'fullScreen', icon: '🔒', title: 'Full-screen alerts on the lock screen', why: 'Lets calls and job requests light up a locked phone.', req: true, done: s.fullScreen !== false, open: 'fullscreen', btn: 'Open settings',
      how: 'Switch “Full-screen notifications” ON for “' + app + '”, then come back.' });
    list.push({ id: 'battery', icon: '🔋', title: 'Keep running in the background', why: 'Stops Android putting the app to sleep, which is what makes calls and alerts arrive late or not at all.', req: true, done: !!s.battery, open: 'battery', btn: 'Allow',
      how: 'Tap Allow on the pop-up. If you see a battery list instead, choose “' + app + '” → Unrestricted (or Don’t optimise).' });
    if (s.oem && OEM_NAME[s.oem]) {
      var steps = (AUTOSTART_STEPS[s.oem] || 'Find “{app}” and allow auto-start / background launch.').replace(/\{app\}/g, app);
      list.push({ id: 'autostart', icon: '🚀', title: 'Allow auto-start', why: 'On ' + OEM_NAME[s.oem] + ' phones the app is shut down in the background unless you allow this.', req: true, manual: true, done: lsGet('swift_setup_autostart') === '1', open: 'autostart', btn: 'Open settings',
        how: steps });
    }
    if ((s.sdk || 0) >= 30) {
      list.push({ id: 'hibernation', icon: '💤', title: 'Don’t pause the app if unused', why: 'Android can switch off an app’s permissions when it has not been opened for a while.', req: false, done: !!s.hibernationExempt, open: 'hibernation', btn: 'Open settings',
        how: 'Switch OFF “Pause app activity if unused” (or turn ON “Keep permissions”), then come back.' });
    }
    list.push({ id: 'microphone', icon: '🎤', title: 'Microphone', why: 'Needed for the free internet calls.', req: false, done: !!s.microphone, open: 'microphone', btn: 'Allow',
      how: 'Tap Allow on the pop-up. If it does not appear: Permissions → Microphone → Allow.' });
    if (role === 'rider') {
      list.push({ id: 'location', icon: '📍', title: 'Location: Allow all the time', why: 'So customers can follow you on the map even when your screen is off or you are in another app.', req: true, done: !!s.locationAlways, open: 'location', btn: s.locationFine ? 'Open settings' : 'Allow',
        how: s.locationFine ? 'Tap Permissions → Location → choose “Allow all the time” (and keep Precise ON).' : 'Tap Allow on the pop-up (choose Precise), then tap this button again for “Allow all the time”.' });
      list.push({ id: 'gps', icon: '🛰️', title: 'Phone location (GPS) switched on', why: 'The phone’s location switch must be ON for tracking to work.', req: true, done: s.gpsOn !== false, open: 'gps', btn: 'Open settings',
        how: 'Switch Location ON, then come back.' });
    }
    if (s.dataSaver) {
      list.push({ id: 'datasaver', icon: '📶', title: 'Allow data in the background', why: 'Data Saver is on and blocks the app when it is not on screen.', req: true, done: false, open: 'datasaver', btn: 'Open settings',
        how: 'Switch ON “Unrestricted data” for “' + app + '”, then come back.' });
    }
    return list;
  }
  function counts(list) {
    var reqMissing = 0, recMissing = 0, done = 0;
    list.forEach(function (i) { if (i.done) done++; else if (i.req) reqMissing++; else recMissing++; });
    return { reqMissing: reqMissing, recMissing: recMissing, done: done, total: list.length };
  }

  // ── look ──
  function styles() {
    if (document.getElementById('sws-style')) return;
    var st = document.createElement('style');
    st.id = 'sws-style';
    st.textContent =
      '#sws{position:fixed;inset:0;z-index:99980;display:none;align-items:flex-end;justify-content:center;background:rgba(0,0,0,.6);font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:none}' +
      '#sws *{box-sizing:border-box;max-width:none}' +
      '#sws .sws-card{width:100%;max-width:560px;max-height:92vh;display:flex;flex-direction:column;background:#17140f;color:#f7f1e6;border-radius:20px 20px 0 0;border:1px solid #3a342c;border-bottom:0;box-shadow:0 -10px 40px rgba(0,0,0,.5);padding-bottom:env(safe-area-inset-bottom,0px)}' +
      '#sws .sws-head{padding:18px 18px 10px}' +
      '#sws .sws-title{font-size:19px;font-weight:800;margin:0}' +
      '#sws .sws-sub{font-size:13px;color:#a69c8c;margin-top:4px;line-height:1.4}' +
      '#sws .sws-bar{height:6px;border-radius:3px;background:#2a2118;margin-top:12px;overflow:hidden}' +
      '#sws .sws-bar i{display:block;height:100%;background:#F0A93B;border-radius:3px;transition:width .3s}' +
      '#sws .sws-list{overflow-y:auto;padding:4px 12px 8px;-webkit-overflow-scrolling:touch}' +
      '#sws .sws-row{display:flex;gap:12px;align-items:flex-start;padding:12px 8px;border-bottom:1px solid #2a2520}' +
      '#sws .sws-ic{flex:0 0 38px;height:38px;border-radius:50%;background:#2a2118;display:flex;align-items:center;justify-content:center;font-size:19px}' +
      '#sws .sws-row.done .sws-ic{background:#143a22}' +
      '#sws .sws-main{flex:1 1 auto;min-width:0}' +
      '#sws .sws-t{font-size:15px;font-weight:700;display:flex;gap:6px;align-items:center;flex-wrap:wrap}' +
      '#sws .sws-tag{font-size:10px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:#F0A93B;border:1px solid #6b5420;border-radius:6px;padding:1px 5px}' +
      '#sws .sws-why{font-size:12.5px;color:#a69c8c;margin-top:3px;line-height:1.4}' +
      '#sws .sws-how{font-size:12.5px;color:#e8dcc4;background:#241d14;border:1px solid #3a2f1d;border-radius:10px;padding:8px 10px;margin-top:8px;line-height:1.45}' +
      '#sws .sws-act{flex:0 0 auto;align-self:center}' +
      '#sws .sws-btn{border:0;border-radius:11px;padding:10px 14px;font:800 13px system-ui,sans-serif;background:#F0A93B;color:#1a1206;cursor:pointer;touch-action:manipulation;white-space:nowrap}' +
      '#sws .sws-btn.alt{background:#2a2d36;color:#fff}' +
      '#sws .sws-ok{color:#3ddc84;font-weight:800;font-size:13px;white-space:nowrap}' +
      '#sws .sws-foot{display:flex;gap:10px;padding:12px 16px 16px;border-top:1px solid #2a2520}' +
      '#sws .sws-foot .sws-btn{flex:1 1 0;padding:13px}' +
      '#sws .sws-link{background:none;border:0;color:#a69c8c;font:600 12.5px system-ui,sans-serif;text-decoration:underline;padding:6px 0;cursor:pointer;display:block;margin:6px auto 0}' +
      '#swschip{position:fixed;left:12px;bottom:calc(env(safe-area-inset-bottom,0px) + 14px);z-index:99970;display:none;border:2px solid #F0A93B;background:#2a2118;color:#f7f1e6;border-radius:22px;padding:9px 14px;font:800 12.5px system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.45);cursor:pointer;max-width:none}';
    document.head.appendChild(st);
  }

  function render() {
    if (!sheet) return;
    var list = items(), c = counts(list);
    var pct = Math.round(c.done / Math.max(1, c.total) * 100);
    var allReq = c.reqMissing === 0;
    var html = '<div class="sws-card" role="dialog" aria-label="Get this phone ready">' +
      '<div class="sws-head"><h2 class="sws-title">' + (allReq ? '✅ Phone is ready' : '⚙️ Get this phone ready') + '</h2>' +
      '<div class="sws-sub">' + (allReq
        ? (c.recMissing ? 'The important settings are done. ' + c.recMissing + ' optional tip' + (c.recMissing > 1 ? 's' : '') + ' left.' : 'Everything is set. You will not miss a call or alert.')
        : 'A few Android settings decide whether calls and alerts reach you. Tap each button, switch it on, and come back. ' + c.done + ' of ' + c.total + ' done.') + '</div>' +
      '<div class="sws-bar"><i style="width:' + pct + '%"></i></div></div><div class="sws-list">';
    list.forEach(function (it) {
      var showHow = !it.done && (expanded[it.id] || openedFor === it.id);
      html += '<div class="sws-row' + (it.done ? ' done' : '') + '"><div class="sws-ic">' + (it.done ? '✅' : it.icon) + '</div><div class="sws-main">' +
        '<div class="sws-t">' + esc(it.title) + (!it.done && it.req ? '<span class="sws-tag">Needed</span>' : '') + '</div>' +
        '<div class="sws-why">' + esc(it.why) + '</div>' +
        (showHow ? '<div class="sws-how">' + esc(it.how) + '</div>' : '') +
        (showHow && it.manual ? '<div style="margin-top:8px"><button type="button" class="sws-btn alt" data-confirm="' + it.id + '">I have switched it on ✓</button></div>' : '') +
        '</div><div class="sws-act">' + (it.done ? '<span class="sws-ok">Done</span>' : '<button type="button" class="sws-btn" data-fix="' + it.id + '">' + esc(it.btn) + '</button>') + '</div></div>';
    });
    html += '</div><div class="sws-foot">' +
      (allReq ? '<button type="button" class="sws-btn" data-close="1">Done</button>' : '<button type="button" class="sws-btn alt" data-close="1">Remind me later</button>') +
      '</div>' + ((allReq && (role === 'customer' || role === 'staff') && window.SwiftApp && window.SwiftApp.callAlert && window.SwiftApp.callAlert.available) ? '<button type="button" class="sws-link" data-test="1">Send myself a test call</button>' : '') + '</div>';
    sheet.innerHTML = html;
  }

  function onSheetClick(e) {
    var t = e.target;
    while (t && t !== sheet && !(t.getAttribute && (t.getAttribute('data-fix') || t.getAttribute('data-close') || t.getAttribute('data-confirm') || t.getAttribute('data-test')))) t = t.parentNode;
    if (!t || t === sheet) { if (e.target === sheet) closeSheet(); return; }
    var fix = t.getAttribute('data-fix'), conf = t.getAttribute('data-confirm');
    if (t.getAttribute('data-close')) { closeSheet(); return; }
    if (t.getAttribute('data-test')) { try { window.SwiftApp.callAlert.testCall(); closeSheet(); } catch (er) {} return; }
    if (conf) { if (conf === 'autostart') lsSet('swift_setup_autostart', '1'); render(); updateChip(); return; }
    if (fix) {
      var it = items().filter(function (x) { return x.id === fix; })[0];
      if (!it) return;
      openedFor = it.id; expanded[it.id] = true;
      render();
      var n = native();
      if (n) { try { n.open(it.open).catch(function () {}); } catch (er) {} }
    }
  }

  function buildSheet() {
    styles();
    if (sheet) return;
    sheet = document.createElement('div');
    sheet.id = 'sws';
    sheet.addEventListener('click', onSheetClick);
    document.body.appendChild(sheet);
  }
  function openSheet() {
    buildSheet(); sheetOpen = true;
    sheet.style.display = 'flex';
    render();
    clearInterval(pollTimer);
    pollTimer = setInterval(refresh, 1500);
    updateChip();
  }
  function closeSheet() {
    sheetOpen = false;
    if (sheet) sheet.style.display = 'none';
    clearInterval(pollTimer); pollTimer = null;
    openedFor = '';
    updateChip();
  }

  // The small reminder button that stays on screen until the important settings are done.
  function updateChip() {
    var c = counts(items());
    var need = c.reqMissing;
    if (!chip) {
      styles();
      chip = document.createElement('button');
      chip.type = 'button'; chip.id = 'swschip';
      chip.addEventListener('click', function () { openSheet(); });
      document.body.appendChild(chip);
    }
    if (need > 0 && !sheetOpen) {
      chip.textContent = '⚠ Finish phone setup (' + need + ')';
      chip.style.display = 'block';
    } else chip.style.display = 'none';
  }

  function refresh() {
    var n = native(); if (!n) return Promise.resolve();
    return n.getStatus().then(function (st) {
      var before = JSON.stringify(status);
      status = st || status;
      if (JSON.stringify(status) !== before) {
        var prev = openedFor;
        if (prev) { var it = items().filter(function (x) { return x.id === prev; })[0]; if (it && it.done) openedFor = ''; }
        if (sheetOpen) render();
      }
      updateChip();
    }).catch(function () {});
  }

  function start(r) {
    var n = native();
    if (!n) return;
    role = r || role || 'customer';
    if (started) { refresh(); return; }
    started = true;
    refresh().then(function () {
      var c = counts(items());
      var firstRun = lsGet('swift_setup_seen') !== '1';
      if (c.reqMissing > 0 || (firstRun && c.recMissing > 0)) {
        lsSet('swift_setup_seen', '1');
        setTimeout(openSheet, 600);
      }
      updateChip();
    });
    // Coming back from an Android settings screen: re-check straight away.
    document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });
    window.addEventListener('focus', refresh);
  }

  window.SwiftSetup = { start: start, open: function () { if (native()) { refresh().then(openSheet); } }, refresh: refresh, _items: items };
})();
