/*
 * Swift Importers — Device Tracker page for the admin app (device-tracker-admin.js)
 * Shows the phones running the Swift Tracker app on a live map: where each one is right now, its battery,
 * how long ago it last reported, and the trail it has followed.
 *
 * Data: tracked_devices/{deviceId}            current position (updated live by the phone)
 *       tracked_devices/{deviceId}/points/*   history trail
 * Needs the Firestore rules from firestore.rules (owner-only reads).
 */
(function () {
  'use strict';

  var LIVE_MS = 6 * 60 * 1000;      // reported within the last 6 minutes = "Live"
  var root = null, devices = {}, selectedId = null;
  var unsubDevices = null, unsubPoints = null, tickTimer = null;
  var map = null, mapReady = null, marker = null, circle = null, line = null, follow = true, trail = [];

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fns() { return window.fbFns; }
  function db() { return window.fbDb; }

  function ago(iso) {
    var t = Date.parse(iso || '');
    if (!isFinite(t)) return 'never';
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return Math.round(s / 86400) + ' days ago';
  }
  function isLive(d) { var t = Date.parse(d.updatedAt || ''); return isFinite(t) && Date.now() - t < LIVE_MS; }
  function nameOf(id, d) { return (d && (d.label || d.name)) || ('Device ' + String(id).slice(0, 6)); }

  // ---------- page skeleton ----------
  function build() {
    root = document.getElementById('page-device-tracker');
    if (!root || root.getAttribute('data-built')) return;
    root.setAttribute('data-built', '1');
    root.innerHTML =
      '<div class="section-hdr"><h2>📍 Device Tracker</h2></div>' +
      '<div class="card" style="padding:14px;">' +
        '<div id="dt-list" style="display:flex; gap:10px; flex-wrap:wrap; margin-bottom:12px;"></div>' +
        '<div id="dt-map-wrap" style="position:relative; height:56vh; min-height:340px; border-radius:12px; overflow:hidden; border:1.5px solid var(--border); background:#e9edf3;">' +
          '<div id="dt-map" style="position:absolute; inset:0;"></div>' +
          '<div id="dt-empty" style="position:absolute; inset:0; display:flex; align-items:center; justify-content:center; text-align:center; padding:24px; color:#555; font-weight:600; font-size:0.9rem; background:rgba(255,255,255,.85);">No device has reported yet.<br/>Install the Swift Tracker app on the phone and open it once.</div>' +
        '</div>' +
        '<div id="dt-detail" style="margin-top:12px;"></div>' +
      '</div>';
  }

  // ---------- map ----------
  function ensureMap() {
    if (mapReady) return mapReady;
    var el = document.getElementById('dt-map');
    if (!el || !window.SwiftMap) return Promise.reject(new Error('Map not available'));
    mapReady = window.SwiftMap.create(el, { center: [0.3476, 32.5825], zoom: 13, zoomControl: true, zoomPosition: 'bottomright' }).then(function (m) { map = m; return m; });
    return mapReady;
  }
  var DOT = '<div style="position:relative;width:28px;height:28px;">' +
    '<span style="position:absolute;inset:0;border-radius:50%;background:rgba(37,99,235,.28);animation:dtPulse 1.8s ease-out infinite;"></span>' +
    '<span style="position:absolute;left:7px;top:7px;width:14px;height:14px;border-radius:50%;background:#2563eb;border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.45);"></span></div>';
  function injectCss() {
    if (document.getElementById('dt-css')) return;
    var st = document.createElement('style'); st.id = 'dt-css';
    st.textContent = '@keyframes dtPulse{0%{transform:scale(.5);opacity:.9}100%{transform:scale(1.6);opacity:0}}' +
      '.dt-card{flex:1 1 200px;max-width:320px;border:1.5px solid var(--border);border-radius:10px;padding:10px 12px;background:#fff;cursor:pointer;}' +
      '.dt-card.sel{border-color:var(--gold);background:#fff8e6;}' +
      '.dt-chip{display:inline-block;font-size:.66rem;font-weight:800;padding:2px 8px;border-radius:10px;}' +
      '.dt-live{background:#dff5e6;color:#14532d;}.dt-off{background:#eceff3;color:#555;}' +
      '.dt-btn{background:#fff;border:1.5px solid var(--gold);color:var(--gold-dark);padding:8px 12px;border-radius:8px;font-size:.78rem;font-weight:700;cursor:pointer;}' +
      '.dt-btn.red{border-color:#e0a0a0;color:#b03030;}';
    document.head.appendChild(st);
  }

  function drawSelected(recenter) {
    var d = devices[selectedId];
    if (!d || typeof d.lat !== 'number' || typeof d.lng !== 'number') return;
    document.getElementById('dt-empty').style.display = 'none';
    ensureMap().then(function (m) {
      var ll = [d.lat, d.lng];
      if (!marker) marker = m.addMarker({ latlng: ll, html: DOT, size: [28, 28], z: 5 }); else marker.setLatLng(ll);
      var r = Math.max(5, Number(d.accuracy) || 0);
      if (!circle) circle = m.addCircle(ll, r, { color: '#2563eb', weight: 1, opacity: 0.5, fillOpacity: 0.1 });
      else { circle.setLatLng(ll); circle.setRadius(r); }
      drawTrail(m);
      if (recenter) m.setView(ll, 17, { animate: true });
      else if (follow) { try { m.panInside(ll, { padding: [80, 80] }); } catch (e) { m.setView(ll, m.getZoom()); } }
      try { m.invalidateSize(); } catch (e) {}
    }).catch(function (e) { console.warn('[tracker] map failed', e); });
  }
  function drawTrail(m) {
    var pts = trail.map(function (p) { return [p.lat, p.lng]; });
    if (pts.length < 2) { if (line) { line.remove(); line = null; } return; }
    if (!line) line = m.addLine(pts, { color: '#2563eb', weight: 4, opacity: 0.75, dash: [2, 6] });
    else line.setLatLngs(pts);
  }

  // ---------- list + detail ----------
  function renderList() {
    var ids = Object.keys(devices).sort(function (a, b) { return String(devices[b].updatedAt || '').localeCompare(String(devices[a].updatedAt || '')); });
    var list = document.getElementById('dt-list');
    if (!list) return;
    list.innerHTML = ids.map(function (id) {
      var d = devices[id], live = isLive(d);
      return '<div class="dt-card' + (id === selectedId ? ' sel' : '') + '" onclick="DeviceTracker.select(\'' + id + '\')">' +
        '<div style="font-weight:800;font-size:.9rem;">📱 ' + esc(nameOf(id, d)) + '</div>' +
        '<div style="margin-top:4px;"><span class="dt-chip ' + (live ? 'dt-live' : 'dt-off') + '">' + (live ? '● Live' : 'Last seen ' + esc(ago(d.updatedAt))) + '</span>' +
        (typeof d.battery === 'number' ? ' <span style="font-size:.74rem;color:#555;">🔋 ' + Math.round(d.battery) + '%' + (d.charging ? '⚡' : '') + '</span>' : '') + '</div></div>';
    }).join('');
    document.getElementById('dt-empty').style.display = ids.length ? 'none' : 'flex';
  }

  function renderDetail() {
    var box = document.getElementById('dt-detail');
    var d = devices[selectedId];
    if (!box) return;
    if (!d) { box.innerHTML = ''; return; }
    var live = isLive(d);
    var speed = typeof d.speed === 'number' && d.speed > 0.5 ? Math.round(d.speed * 3.6) + ' km/h' : 'Not moving';
    var maps = typeof d.lat === 'number' ? 'https://www.google.com/maps?q=' + d.lat + ',' + d.lng : '';
    box.innerHTML =
      '<div style="display:flex; flex-wrap:wrap; gap:14px; font-size:.84rem; line-height:1.6;">' +
        '<div><div style="color:#888;font-size:.7rem;font-weight:700;">STATUS</div><span class="dt-chip ' + (live ? 'dt-live' : 'dt-off') + '">' + (live ? '● Live' : 'Offline / no signal') + '</span></div>' +
        '<div><div style="color:#888;font-size:.7rem;font-weight:700;">LAST UPDATE</div>' + esc(ago(d.updatedAt)) + '</div>' +
        '<div><div style="color:#888;font-size:.7rem;font-weight:700;">ACCURACY</div>' + (d.accuracy ? '±' + Math.round(d.accuracy) + ' m' : '—') + (d.provider ? ' (' + esc(d.provider) + ')' : '') + '</div>' +
        '<div><div style="color:#888;font-size:.7rem;font-weight:700;">SPEED</div>' + speed + '</div>' +
        '<div><div style="color:#888;font-size:.7rem;font-weight:700;">BATTERY</div>' + (typeof d.battery === 'number' ? Math.round(d.battery) + '%' + (d.charging ? ' ⚡ charging' : '') : '—') + '</div>' +
        '<div><div style="color:#888;font-size:.7rem;font-weight:700;">PHONE</div>' + esc(d.model || '—') + '</div>' +
      '</div>' +
      '<div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:12px; align-items:center;">' +
        '<button class="dt-btn" onclick="DeviceTracker.center()">🎯 Centre on phone</button>' +
        '<label style="font-size:.78rem;font-weight:700;display:flex;align-items:center;gap:6px;"><input type="checkbox" id="dt-follow" ' + (follow ? 'checked' : '') + ' onchange="DeviceTracker.setFollow(this.checked)" style="width:auto;"/> Follow</label>' +
        (maps ? '<a class="dt-btn" href="' + maps + '" target="_blank" rel="noopener" style="text-decoration:none;">🗺️ Open in Google Maps</a>' : '') +
        '<button class="dt-btn" onclick="DeviceTracker.clearTrail()">🧹 Clear trail</button>' +
      '</div>' +
      '<div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:10px;">' +
        '<input type="text" id="dt-name" value="' + esc(d.label || d.name || '') + '" placeholder="Device name" maxlength="40" style="flex:1 1 180px; padding:9px 12px; border:1.5px solid var(--border); border-radius:8px; font-size:.85rem;"/>' +
        '<button class="dt-btn" onclick="DeviceTracker.rename()">💾 Rename</button>' +
        '<button class="dt-btn red" onclick="DeviceTracker.remove()">🗑️ Remove device</button>' +
      '</div>' +
      '<div style="font-size:.72rem;color:#888;margin-top:8px;">Trail: ' + trail.length + ' point' + (trail.length === 1 ? '' : 's') + ' · the phone reports about every 15 s while moving and every 2 min when still.</div>';
  }

  // ---------- data ----------
  function listenPoints() {
    if (unsubPoints) { unsubPoints(); unsubPoints = null; }
    trail = [];
    if (line) { line.remove(); line = null; }
    if (!selectedId || !fns()) return;
    var f = fns();
    var q = f.query(f.collection(db(), 'tracked_devices', selectedId, 'points'), f.orderBy('t', 'desc'), f.limit(300));
    unsubPoints = f.onSnapshot(q, function (snap) {
      trail = snap.docs.map(function (x) { return x.data(); }).filter(function (p) { return typeof p.lat === 'number'; }).reverse();
      if (mapReady) mapReady.then(drawTrail);
      renderDetail();
    }, function (e) { console.warn('[tracker] trail listener failed', e); });
  }

  function select(id) {
    if (!devices[id]) return;
    var changed = id !== selectedId;
    selectedId = id;
    renderList(); renderDetail();
    if (changed) { if (marker) { marker.remove(); marker = null; } if (circle) { circle.remove(); circle = null; } listenPoints(); }
    drawSelected(true);
  }

  function open() {
    injectCss(); build();
    if (!fns() || !db()) return;
    if (!unsubDevices) {
      var f = fns();
      unsubDevices = f.onSnapshot(f.collection(db(), 'tracked_devices'), function (snap) {
        devices = {};
        snap.docs.forEach(function (x) { devices[x.id] = x.data(); });
        if (!selectedId || !devices[selectedId]) {
          var ids = Object.keys(devices).sort(function (a, b) { return String(devices[b].updatedAt || '').localeCompare(String(devices[a].updatedAt || '')); });
          if (ids.length) { select(ids[0]); return; }
          selectedId = null;
        }
        renderList(); renderDetail(); drawSelected(false);
      }, function (e) {
        console.warn('[tracker] listener failed', e);
        var em = document.getElementById('dt-empty');
        if (em) { em.style.display = 'flex'; em.textContent = 'Could not load devices: ' + (e && e.code === 'permission-denied' ? 'permission denied. Publish the updated Firestore rules (and make sure you are signed in as the owner).' : (e && e.message || e)); }
      });
    }
    if (!tickTimer) tickTimer = setInterval(function () { renderList(); renderDetail(); }, 20000);
    ensureMap().then(function (m) { setTimeout(function () { try { m.invalidateSize(); } catch (e) {} drawSelected(false); }, 150); }).catch(function () {});
  }
  function close() {
    if (unsubDevices) { unsubDevices(); unsubDevices = null; }
    if (unsubPoints) { unsubPoints(); unsubPoints = null; }
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  }

  // ---------- actions ----------
  function say(msg, kind) { try { if (window.showToast) window.showToast(msg, kind || 'success'); } catch (e) {} }
  function rename() {
    var v = (document.getElementById('dt-name') || {}).value || '';
    if (!selectedId) return;
    fns().updateDoc(fns().doc(db(), 'tracked_devices', selectedId), { label: v.trim() }).then(function () { say('✅ Renamed'); }, function (e) { say('Could not rename: ' + (e && e.message || e), 'error'); });
  }
  function remove() {
    if (!selectedId) return;
    var id = selectedId;
    var go = function () {
      clearTrail(true).then(function () { return fns().deleteDoc(fns().doc(db(), 'tracked_devices', id)); })
        .then(function () { selectedId = null; say('🗑️ Device removed (it will reappear if the phone is still sending)'); })
        .catch(function (e) { say('Could not remove: ' + (e && e.message || e), 'error'); });
    };
    if (window.showAppConfirm) window.showAppConfirm('Remove this device and its trail? If the phone is still running the app it will show up again.', go, null, { icon: '🗑️', confirmText: 'Remove' }); else go();
  }
  function clearTrail(silent) {
    if (!selectedId) return Promise.resolve();
    var f = fns(), id = selectedId;
    return f.getDocs(f.collection(db(), 'tracked_devices', id, 'points')).then(function (snap) {
      return Promise.all(snap.docs.map(function (x) { return f.deleteDoc(x.ref || f.doc(db(), 'tracked_devices', id, 'points', x.id)); }));
    }).then(function () { if (silent !== true) say('🧹 Trail cleared'); }, function (e) { if (silent !== true) say('Could not clear: ' + (e && e.message || e), 'error'); });
  }

  window.DeviceTracker = {
    open: open, close: close, select: select, rename: rename, remove: remove, clearTrail: clearTrail,
    center: function () { drawSelected(true); },
    setFollow: function (v) { follow = !!v; }
  };
})();
