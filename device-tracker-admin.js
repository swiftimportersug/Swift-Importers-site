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
  var headingOn = true;             // while on, the camera turns to face the way the phone is travelling
  var HEADING_MIN_SPEED = 1.3;      // m/s (~4.7 km/h) — below this, a GPS bearing is too noisy to trust

  // ---- smooth motion (glide the arrow between fixes instead of snapping, like the rider map) ----
  var shown = null;                 // {lat,lng} the position actually drawn right now (eases toward the real one)
  var anim = null;                  // {from,to,t0,dur} an in-progress glide
  var heading = null, targetHeading = null;   // degrees; `heading` eases toward `targetHeading` each frame
  var rafId = null;
  var glideMs = 2500;                // learned from the real gap between fixes as they arrive
  var lastFixAt = 0;
  var SNAP_DISTANCE_M = 400;          // farther than this in one jump = snap instead of gliding across it

  function metresBetween(a, b) {
    var dLat = (b[0] - a[0]) * 111320;
    var dLng = (b[1] - a[1]) * 111320 * Math.cos(((a[0] + b[0]) / 2) * Math.PI / 180);
    return Math.sqrt(dLat * dLat + dLng * dLng);
  }
  function angleDiff(a, b) { return ((b - a + 540) % 360) - 180; }   // signed shortest turn from a to b
  function resetMotion() { shown = null; anim = null; heading = null; targetHeading = null; glideMs = 2500; lastFixAt = 0; if (rafId) { cancelAnimationFrame(rafId); rafId = null; } }

  // Newer phones (with the compass-heading update) send an honest "hasHeading" flag — trust that.
  // Older phones never send that field at all, so fall back to the old guess: only trust GPS
  // bearing while clearly moving (it's noise or a silent 0 the rest of the time).
  function headingIsTrustworthy(d) {
    if (typeof d.hasHeading === 'boolean') return d.hasHeading;
    return typeof d.speed === 'number' && d.speed >= HEADING_MIN_SPEED;
  }

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
          '<button type="button" id="dt-compass" class="dt-compass" aria-label="Face north" onclick="DeviceTracker.faceNorth()" style="display:none;"><span>🧭</span></button>' +
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
    mapReady = window.SwiftMap.create(el, { center: [0.3476, 32.5825], zoom: 13, zoomControl: true, zoomPosition: 'bottomright', pitch: 35, rotate: true })
      .then(function (m) {
        map = m;
        try {
          if (m.canRotate) {
            var compassBtn = document.getElementById('dt-compass');
            if (compassBtn) compassBtn.style.display = 'flex';
            // Dragging the map by hand to turn it takes over from auto-facing the direction of travel.
            m.on('rotatestart', function (ev) { if (ev && ev.originalEvent) headingOn = false; });
            m.on('rotate', updateCompass);
          }
        } catch (e) {}
        return m;
      });
    return mapReady;
  }
  function updateCompass() {
    var btn = document.getElementById('dt-compass');
    if (!map || !map.canRotate || !btn) return;
    var sp = btn.firstChild;
    if (sp) sp.style.transform = 'rotate(' + (-map.getBearing()).toFixed(1) + 'deg)';
  }
  // How far down from centre to put the phone, so more of the road ahead is visible while facing its heading.
  function camOffsetY() {
    var el = document.getElementById('dt-map');
    return el ? Math.round(el.clientHeight * 0.14) : 0;
  }
  // A triangle arrow sits inside a halo; it turns to face the phone's heading once one is known.
  // While no reliable heading exists yet (just started / stopped), the triangle hides and only
  // the plain circle shows, so it never implies a direction that isn't real.
  var ARROW = '<div style="position:relative;width:30px;height:30px;">' +
    '<span style="position:absolute;inset:0;border-radius:50%;background:rgba(37,99,235,.28);animation:dtPulse 1.8s ease-out infinite;"></span>' +
    '<div class="dt-arrow" style="position:absolute;left:0;top:0;width:30px;height:30px;will-change:transform;">' +
      '<svg viewBox="0 0 30 30" width="30" height="30" style="display:block;filter:drop-shadow(0 2px 3px rgba(0,0,0,.5));">' +
        '<circle cx="15" cy="15" r="9" fill="#2563eb" stroke="#fff" stroke-width="2.5"/>' +
        '<path class="dt-arrow-tri" d="M15 2 L21 14 L15 10.5 L9 14 Z" fill="#2563eb" stroke="#fff" stroke-width="1.2"/>' +
      '</svg>' +
    '</div></div>';
  var lastAccuracy = 0;
  function injectCss() {
    if (document.getElementById('dt-css')) return;
    var st = document.createElement('style'); st.id = 'dt-css';
    st.textContent = '@keyframes dtPulse{0%{transform:scale(.5);opacity:.9}100%{transform:scale(1.6);opacity:0}}' +
      '.dt-arrow{transition:none;}' +
      '.dt-card{flex:1 1 200px;max-width:320px;border:1.5px solid var(--border);border-radius:10px;padding:10px 12px;background:#fff;cursor:pointer;}' +
      '.dt-card.sel{border-color:var(--gold);background:#fff8e6;}' +
      '.dt-chip{display:inline-block;font-size:.66rem;font-weight:800;padding:2px 8px;border-radius:10px;}' +
      '.dt-live{background:#dff5e6;color:#14532d;}.dt-off{background:#eceff3;color:#555;}' +
      '.dt-btn{background:#fff;border:1.5px solid var(--gold);color:var(--gold-dark);padding:8px 12px;border-radius:8px;font-size:.78rem;font-weight:700;cursor:pointer;}' +
      '.dt-btn.red{border-color:#e0a0a0;color:#b03030;}' +
      '.dt-compass{position:absolute;right:10px;top:54px;z-index:5;width:36px;height:36px;border:0;border-radius:10px;background:rgba(255,255,255,.95);box-shadow:0 2px 8px rgba(0,0,0,.3);font-size:18px;line-height:1;cursor:pointer;align-items:center;justify-content:center;touch-action:manipulation;}' +
      '.dt-compass span{display:block;transition:transform .15s linear;}';
    document.head.appendChild(st);
  }

  // Draws the arrow at its current in-between (glided) position, and rotates it to the current
  // smoothed heading, matching the pattern used for the live rider map.
  function place() {
    if (!map || !shown) return;
    var ll = [shown.lat, shown.lng];
    if (!marker) marker = map.addMarker({ latlng: ll, html: ARROW, size: [30, 30], z: 5 });
    else marker.setLatLng(ll);
    var el = marker.getElement && marker.getElement();
    var arrowEl = el && el.querySelector && el.querySelector('.dt-arrow');
    var triEl = el && el.querySelector && el.querySelector('.dt-arrow-tri');
    if (arrowEl) {
      if (heading == null) { arrowEl.style.transform = ''; if (triEl) triEl.style.display = 'none'; }
      else {
        var camB = (map.canRotate && map.getBearing) ? map.getBearing() : 0;
        arrowEl.style.transform = 'rotate(' + (((heading - camB + 360) % 360)).toFixed(1) + 'deg)';
        if (triEl) triEl.style.display = '';
      }
    }
    var r = Math.max(5, lastAccuracy || 0);
    if (!circle) circle = map.addCircle(ll, r, { color: '#2563eb', weight: 1, opacity: 0.5, fillOpacity: 0.1 });
    else { circle.setLatLng(ll); circle.setRadius(r); }
  }

  // A fresh fix arrived from Firestore: glide the arrow to it over about one reporting interval,
  // instead of snapping straight there. Jumps bigger than SNAP_DISTANCE_M (satellite re-lock,
  // coming back after the tab was hidden) still snap instantly.
  function moveTo(lat, lng, brg, headingOk) {
    var target = { lat: lat, lng: lng }, now = Date.now();
    if (!shown || document.hidden) { shown = target; anim = null; }
    else {
      var gap = metresBetween([shown.lat, shown.lng], [lat, lng]);
      if (gap > SNAP_DISTANCE_M) { shown = target; anim = null; }
      else if (gap > 0.3) anim = { from: { lat: shown.lat, lng: shown.lng }, to: target, t0: performance.now(), dur: glideMs };
    }
    if (lastFixAt) {
      var realGap = now - lastFixAt;
      if (realGap > 300 && realGap < 20000) glideMs = glideMs * 0.5 + Math.min(realGap, 8000) * 0.5;
    }
    lastFixAt = now;
    if (headingOk && typeof brg === 'number') { targetHeading = brg; if (heading == null) heading = brg; }
    // Otherwise keep whatever heading was last trusted, rather than snapping to 0/north.
  }

  var lastPanAt = 0;
  function frame(ts) {
    rafId = null;
    var busy = false;
    if (anim) {
      var p = Math.min(1, (performance.now() - anim.t0) / anim.dur);
      shown = { lat: anim.from.lat + (anim.to.lat - anim.from.lat) * p, lng: anim.from.lng + (anim.to.lng - anim.from.lng) * p };
      if (p >= 1) anim = null; else busy = true;
    }
    if (heading != null && targetHeading != null) {
      var dAngle = angleDiff(heading, targetHeading);
      if (Math.abs(dAngle) > 0.5) { heading = (heading + dAngle * 0.25 + 360) % 360; busy = true; }
    }
    try { place(); } catch (e) { console.warn('[tracker] draw failed', e); }
    if (map && shown) {
      if (headingOn && map.canRotate && follow && heading != null) {
        try { map.follow([shown.lat, shown.lng], heading, camOffsetY(), { animate: false }); } catch (e) {}
      } else if (follow && ts - lastPanAt > 120) {
        lastPanAt = ts;
        try { map.panInside([shown.lat, shown.lng], { padding: [80, 80] }); } catch (e) { try { map.setView([shown.lat, shown.lng], map.getZoom()); } catch (e2) {} }
      }
    }
    if (busy) rafId = requestAnimationFrame(frame);
  }
  function ensureLoop() { if (!rafId) rafId = requestAnimationFrame(frame); }

  function drawSelected(recenter) {
    var d = devices[selectedId];
    if (!d || typeof d.lat !== 'number' || typeof d.lng !== 'number') return;
    document.getElementById('dt-empty').style.display = 'none';
    lastAccuracy = Number(d.accuracy) || 0;
    ensureMap().then(function (m) {
      drawTrail(m);
      if (recenter) {
        // A deliberate jump (picking a device, or "Centre on phone") — snap straight there, no glide.
        shown = { lat: d.lat, lng: d.lng }; anim = null;
        heading = targetHeading = (headingIsTrustworthy(d) && typeof d.bearing === 'number') ? d.bearing : null;
        place();
        var bearing = (headingOn && m.canRotate && heading != null) ? heading : null;
        if (bearing != null) m.follow([d.lat, d.lng], bearing, camOffsetY(), { animate: true, duration: 600 });
        else m.setView([d.lat, d.lng], 17, { animate: true });
      } else {
        moveTo(d.lat, d.lng, d.bearing, headingIsTrustworthy(d));
        ensureLoop();
      }
      updateCompass();
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
      '<div style="margin-top:14px; padding-top:12px; border-top:1px solid var(--border);">' +
        '<div style="color:#888;font-size:.7rem;font-weight:700;margin-bottom:6px;">REMOTE ACTIONS <span style="font-weight:500;">— the phone checks for these about every 1–2 min, so there is a short delay</span></div>' +
        '<div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">' +
          '<button class="dt-btn" onclick="DeviceTracker.sendCmd(\'alarm\')">🔔 Ring phone</button>' +
          '<button class="dt-btn" onclick="DeviceTracker.sendCmd(\'bt_on\')">📶 Bluetooth on</button>' +
          '<button class="dt-btn" onclick="DeviceTracker.sendCmd(\'bt_off\')">📶 Bluetooth off</button>' +
        '</div>' +
        (d.cmd ? ('<div style="font-size:.72rem;color:#666;margin-top:6px;">Last sent: <b>' + esc(d.cmd) + '</b>' +
          (d.cmdDone ? (' — done ' + esc(ago(d.cmdDoneAt)) + (d.cmdResult ? ' (' + esc(d.cmdResult) + ')' : '')) : ' — waiting for the phone…') + '</div>') : '') +
        '<div style="font-size:.7rem;color:#999;margin-top:4px;">Bluetooth control only works on older Android versions — Android 13+ blocks apps from switching it silently, so "blocked_by_os" there is the phone\'s OS refusing it, not a bug.</div>' +
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
    if (changed) { if (marker) { marker.remove(); marker = null; } if (circle) { circle.remove(); circle = null; } resetMotion(); listenPoints(); }
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
    resetMotion();
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

  // ---------- "device is back online" notification (always on, not just while this page is open) ----------
  // The whole point of tracking a phone is to know the moment a lost/stolen one reconnects, so this
  // watches tracked_devices for as long as the admin app is open — whichever page staff happen to be on —
  // completely separate from the Device Tracker page's own listener above (open()/close()).
  var liveState = {};         // deviceId -> true/false, last known "Live" state
  var lastSeenData = {};      // deviceId -> last Firestore data we saw for it, so a pure timer tick (no new
                               // write) can still re-check "has this one gone stale" using the real clock
  var globalUnsub = null, globalRetry = null, audioCtx = null;

  function noteLive(id, d) {
    lastSeenData[id] = d;
    var liveNow = isLive(d);
    if (liveState[id] === false && liveNow === true) playBackOnlineChime(nameOf(id, d));
    liveState[id] = liveNow;
  }
  function recheckLiveState() {
    Object.keys(lastSeenData).forEach(function (id) { noteLive(id, lastSeenData[id]); });
  }

  // A short, synthesized two-note rising chime (A5 → E6) — made entirely in the browser with the Web
  // Audio API, so no sound file is needed and nothing to upload. It's deliberately distinct from every
  // other alert in the app (the boda delivery chime, the tracker's own "ring phone" alarm), so staff
  // instantly know it means "a tracked device just reconnected."
  function playTone(freq, startAt, dur, peakGain) {
    var osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, startAt);
    gain.gain.setValueAtTime(0, startAt);
    gain.gain.linearRampToValueAtTime(peakGain, startAt + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + dur);
    osc.connect(gain); gain.connect(audioCtx.destination);
    osc.start(startAt); osc.stop(startAt + dur + 0.03);
  }
  function playBackOnlineChime(name) {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(function () {});
      var now = audioCtx.currentTime;
      playTone(880.0, now, 0.16, 0.22);          // A5
      playTone(1318.5, now + 0.17, 0.18, 0.22);  // E6 — a perfect fifth up, "connected" feel
    } catch (e) { /* Web Audio unsupported or blocked — the toast below still shows */ }
    say('📡 ' + (name || 'A tracked device') + ' is back online', 'success');
  }

  function startGlobalWatch() {
    if (globalUnsub) return;
    if (!fns() || !db()) { globalRetry = setTimeout(startGlobalWatch, 1500); return; }
    var f = fns();
    try {
      globalUnsub = f.onSnapshot(f.collection(db(), 'tracked_devices'), function (snap) {
        snap.docs.forEach(function (x) { noteLive(x.id, x.data()); });
      }, function (e) { console.warn('[tracker] global watch failed', e); });
    } catch (e) { console.warn('[tracker] could not start global watch', e); }
    // Re-checks every 30s so a device that's gone quiet (no new writes at all) is correctly marked
    // offline from the clock alone — otherwise its later "I'm back" write wouldn't look like a transition.
    setInterval(recheckLiveState, 30000);
  }
  startGlobalWatch();

  window.DeviceTracker = {
    open: open, close: close, select: select, rename: rename, remove: remove, clearTrail: clearTrail,
    center: function () { headingOn = true; drawSelected(true); },
    setFollow: function (v) { follow = !!v; if (v) headingOn = true; },
    faceNorth: function () {
      headingOn = false;
      if (map && map.canRotate) map.setBearing(0, { animate: true, duration: 0.5 });
    },
    sendCmd: function (cmd) {
      if (!selectedId) return;
      var f = fns();
      f.updateDoc(f.doc(db(), 'tracked_devices', selectedId), { cmd: cmd, cmdAt: new Date().toISOString(), cmdDone: false, cmdResult: '' })
        .then(function () { say('📨 Sent — the phone will pick it up shortly'); })
        .catch(function (e) { say('Could not send: ' + (e && e.message || e), 'error'); });
    }
  };
})();
