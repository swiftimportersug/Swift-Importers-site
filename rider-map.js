/*
 * Swift Importers — live rider map for customers
 * ==============================================
 * Shows where the rider is, on a map, while a delivery is under way. Used by both
 * the standalone tracking page (track.html) and the tracking pop-up on the main
 * storefront (index.html), so the two always behave the same.
 *
 * Usage (the page must already have window.fbDb and window.fbFns with doc + onSnapshot):
 *
 *     var mapCtl = SwiftRiderMap.create(document.getElementById('rider-map-wrap'));
 *     mapCtl.sync(order);     // call every time the order is (re)rendered; safe to repeat
 *     mapCtl.destroy();       // when leaving the order
 *
 * The map appears only while the order is with a rider between pickup and delivery,
 * and disappears the moment that ends. The rider's position comes from the
 * rider_locations/{orderId} document that the boda app keeps updated.
 *
 * Map: Leaflet + OpenStreetMap, loaded only when a map is actually needed.
 */
(function () {
  'use strict';

  var LEAFLET_CSS = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css';
  var LEAFLET_JS = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';
  var STALE_AFTER_MS = 3 * 60 * 1000;     // no update for this long: say the rider's connection may be weak
  var CLOCK_SANITY_MS = 6 * 60 * 60 * 1000; // an "age" bigger than this means a wrong phone clock, not a stale rider
  var USER_PAN_PAUSE_MS = 30 * 1000;      // after the customer moves the map, don't fight them for this long

  // ── Leaflet, loaded once on demand ──
  var leafletPromise = null;
  function loadLeaflet() {
    if (window.L && window.L.map) return Promise.resolve(window.L);
    if (leafletPromise) return leafletPromise;
    leafletPromise = new Promise(function (resolve, reject) {
      var css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = LEAFLET_CSS;
      document.head.appendChild(css);
      var js = document.createElement('script');
      js.src = LEAFLET_JS;
      js.onload = function () { window.L && window.L.map ? resolve(window.L) : reject(new Error('Leaflet did not load')); };
      js.onerror = function () { leafletPromise = null; reject(new Error('Leaflet failed to load')); };
      document.head.appendChild(js);
    });
    return leafletPromise;
  }

  // ── Styles (injected once; every class is prefixed srm- so nothing else is touched) ──
  function injectStyles() {
    if (document.getElementById('srm-styles')) return;
    var s = document.createElement('style');
    s.id = 'srm-styles';
    s.textContent =
      '.srm-card{background:#1C1815;border:1px solid #3A342C;border-radius:14px;overflow:hidden;color:#F7F1E6;font-family:Inter,system-ui,sans-serif;}' +
      '.srm-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:11px 14px;}' +
      '.srm-title{font-size:0.85rem;font-weight:800;}' +
      '.srm-live{font-size:0.66rem;font-weight:800;letter-spacing:.06em;color:#3ddc84;display:flex;align-items:center;gap:5px;}' +
      '.srm-live::before{content:"";width:8px;height:8px;border-radius:50%;background:#3ddc84;box-shadow:0 0 8px #3ddc84;animation:srm-pulse 1.6s ease-in-out infinite;}' +
      '.srm-live.stale{color:#A69C8C;}.srm-live.stale::before{background:#A69C8C;box-shadow:none;animation:none;}' +
      '@keyframes srm-pulse{0%,100%{opacity:1}50%{opacity:.35}}' +
      '.srm-map{height:230px;width:100%;background:#2a2118;}' +
      '.srm-meta{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 14px;font-size:0.78rem;}' +
      '.srm-dist{font-weight:800;color:#F0A93B;}' +
      '.srm-age{color:#A69C8C;text-align:right;}' +
      '.srm-wait{padding:0 14px 14px;font-size:0.8rem;color:#A69C8C;line-height:1.4;}' +
      '.srm-pin{display:flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:50%;font-size:18px;box-shadow:0 2px 8px rgba(0,0,0,.45);border:2px solid #fff;}' +
      '.srm-pin.rider{background:#F0A93B;}.srm-pin.dest{background:#ff5c5c;}' +
      '.srm-card .leaflet-container{font-family:inherit;}';
    document.head.appendChild(s);
  }

  // ── small helpers ──
  function parseDestination(o) {
    var m = o && o.exactLocation && String(o.exactLocation).match(/GPS:\s*(-?\d+\.\d+),\s*(-?\d+\.\d+)/);
    if (!m) return null;
    var lat = parseFloat(m[1]), lng = parseFloat(m[2]);
    return (isFinite(lat) && isFinite(lng)) ? [lat, lng] : null;
  }
  function distanceKm(a, b) {
    var R = 6371, rad = Math.PI / 180;
    var dLat = (b[0] - a[0]) * rad, dLng = (b[1] - a[1]) * rad;
    var x = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  }
  function fmtDistance(km) {
    if (km < 0.15) return 'Your rider is very close!';
    if (km < 1) return '≈ ' + (Math.round(km * 10) * 100) + ' m away';
    return '≈ ' + km.toFixed(1) + ' km away';
  }
  function fmtAge(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    if (s < 10) return 'Updated just now';
    if (s < 60) return 'Updated ' + s + 's ago';
    var m = Math.round(s / 60);
    if (m < 60) return 'Last seen ' + m + ' min ago';
    return 'Last seen over an hour ago';
  }
  // Only direct, rider-carried deliveries between pickup and delivery.
  function isEligible(o) {
    if (!o || !o.fbDocId || !o.bodaClaimedBy || !o.bodaClaimedBy.riderId) return false;
    if (o.status === 'closed' || o.status === 'cancelled') return false;
    if (o.delivery && (o.delivery.type === 'taxi' || o.delivery.type === 'bus')) return false;
    return o.deliveryStage === 'handed' || o.deliveryStage === 'on_the_way';
  }

  function create(wrap) {
    var orderId = null;
    var unsubscribe = null;
    var map = null, riderMarker = null, destMarker = null, L = null;
    var destLatLng = null;
    var loc = null;              // { lat, lng, updatedMs, receivedMs }
    var didFit = false;
    var userMovedAt = 0;
    var ageTimer = null;
    var mapStarted = false;
    var els = {};

    function teardown(hide) {
      if (unsubscribe) { try { unsubscribe(); } catch (e) {} unsubscribe = null; }
      if (ageTimer) { clearInterval(ageTimer); ageTimer = null; }
      if (map) { try { map.remove(); } catch (e) {} map = null; }
      riderMarker = null; destMarker = null; loc = null; didFit = false; mapStarted = false; els = {};
      orderId = null; destLatLng = null;
      if (hide && wrap) { wrap.style.display = 'none'; wrap.innerHTML = ''; }
    }

    function buildDom() {
      injectStyles();
      wrap.innerHTML =
        '<div class="srm-card">' +
          '<div class="srm-head"><span class="srm-title">📍 Live rider location</span><span class="srm-live stale" data-r="live">WAITING</span></div>' +
          '<div class="srm-map" data-r="map" style="display:none;"></div>' +
          '<div class="srm-meta" data-r="meta" style="display:none;"><span class="srm-dist" data-r="dist"></span><span class="srm-age" data-r="age"></span></div>' +
          '<div class="srm-wait" data-r="wait">Your rider\'s live location will appear here as soon as they start sharing it.</div>' +
        '</div>';
      ['live', 'map', 'meta', 'dist', 'age', 'wait'].forEach(function (k) { els[k] = wrap.querySelector('[data-r="' + k + '"]'); });
    }

    function ageMs() {
      if (!loc) return 0;
      var a = Date.now() - loc.updatedMs;
      // A customer phone with a badly wrong clock would make every rider look ancient (or from the future):
      // fall back to when WE last heard from them.
      if (a < 0 || a > CLOCK_SANITY_MS) a = Date.now() - loc.receivedMs;
      return a;
    }

    function makeIcon(cls, emoji) {
      return L.divIcon({ className: '', html: '<div class="srm-pin ' + cls + '">' + emoji + '</div>', iconSize: [34, 34], iconAnchor: [17, 17] });
    }

    function ensureMap() {
      if (map || mapStarted) return;
      mapStarted = true;
      var forOrder = orderId;
      loadLeaflet().then(function (Lib) {
        if (orderId !== forOrder || !els.map) return;   // moved on while Leaflet was loading
        L = Lib;
        els.map.style.display = 'block';
        map = L.map(els.map, { zoomControl: true, attributionControl: true }).setView(destLatLng || (loc ? [loc.lat, loc.lng] : [0.3476, 32.5825]), 15);
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(map);
        map.on('dragstart zoomstart', function () { userMovedAt = Date.now(); });
        setTimeout(function () { if (map) map.invalidateSize(); }, 250);
        render();
      }).catch(function (e) {
        console.error('[rider-map] map unavailable:', e);
        mapStarted = false;
        // No map: the distance and "last seen" line below still work.
      });
    }

    function render() {
      if (!els.live) return;
      var hasSomethingToDraw = !!(loc || destLatLng);
      if (hasSomethingToDraw) ensureMap();

      if (!loc) {
        els.live.textContent = 'WAITING';
        els.live.className = 'srm-live stale';
        els.meta.style.display = 'none';
        els.wait.style.display = 'block';
      } else {
        var age = ageMs();
        var stale = age > STALE_AFTER_MS;
        els.live.textContent = stale ? 'LAST SEEN' : 'LIVE';
        els.live.className = 'srm-live' + (stale ? ' stale' : '');
        els.wait.style.display = stale ? 'block' : 'none';
        els.wait.textContent = stale ? 'No fresh update from your rider for a few minutes. Their connection may be weak. You can still call or message them.' : '';
        els.meta.style.display = 'flex';
        els.dist.textContent = destLatLng ? fmtDistance(distanceKm([loc.lat, loc.lng], destLatLng)) : '';
        els.age.textContent = fmtAge(age);
      }

      if (!map || !L) return;

      if (destLatLng) {
        if (!destMarker) destMarker = L.marker(destLatLng, { icon: makeIcon('dest', '📍'), keyboard: false }).addTo(map);
        else destMarker.setLatLng(destLatLng);
      }
      if (loc) {
        var pos = [loc.lat, loc.lng];
        if (!riderMarker) riderMarker = L.marker(pos, { icon: makeIcon('rider', '🏍️'), keyboard: false, zIndexOffset: 500 }).addTo(map);
        else riderMarker.setLatLng(pos);
      }

      // Camera: frame both on first sight of the rider; afterwards only follow if the rider
      // has left the view, and never while the customer is exploring the map themselves.
      var pts = [];
      if (loc) pts.push([loc.lat, loc.lng]);
      if (destLatLng) pts.push(destLatLng);
      if (!pts.length) return;
      if (!didFit && loc) {
        didFit = true;
        if (pts.length > 1) map.fitBounds(pts, { padding: [44, 44], maxZoom: 17 });
        else map.setView(pts[0], 16);
      } else if (loc && Date.now() - userMovedAt > USER_PAN_PAUSE_MS && !map.getBounds().pad(-0.1).contains([loc.lat, loc.lng])) {
        if (pts.length > 1) map.fitBounds(pts, { padding: [44, 44], maxZoom: 17 });
        else map.panTo(pts[0]);
      }
    }

    function subscribe() {
      var f = window.fbFns;
      if (!window.fbDb || !f || !f.onSnapshot || !f.doc) return;
      var forOrder = orderId;
      unsubscribe = f.onSnapshot(f.doc(window.fbDb, 'rider_locations', forOrder), function (snap) {
        if (orderId !== forOrder) return;
        if (!snap.exists()) { loc = null; render(); return; }
        var d = snap.data() || {};
        if (typeof d.lat !== 'number' || typeof d.lng !== 'number') return;
        var ms = (d.updatedAt && typeof d.updatedAt.toMillis === 'function') ? d.updatedAt.toMillis() : Date.now();
        loc = { lat: d.lat, lng: d.lng, updatedMs: ms, receivedMs: Date.now() };
        render();
      }, function (e) { console.error('[rider-map] location listener failed:', e); });
      // Keeps "updated 12s ago" honest between updates.
      ageTimer = setInterval(function () { if (loc) render(); }, 5000);
    }

    function sync(order) {
      if (!wrap) return;
      if (!isEligible(order)) { teardown(true); return; }
      wrap.style.display = 'block';
      if (orderId !== order.fbDocId) {
        teardown(false);
        orderId = order.fbDocId;
        wrap.style.display = 'block';
        destLatLng = parseDestination(order);
        buildDom();
        subscribe();
        render();
      } else {
        var d = parseDestination(order);
        var changed = (!!d !== !!destLatLng) || (d && destLatLng && (d[0] !== destLatLng[0] || d[1] !== destLatLng[1]));
        if (changed) { destLatLng = d; render(); }
      }
    }

    return { sync: sync, destroy: function () { teardown(true); } };
  }

  window.SwiftRiderMap = { create: create };
})();
