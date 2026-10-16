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
 * Following: the rider's dot glides from one position to the next (it never hops),
 * turns to face the way they are travelling, and the map keeps them in view until the
 * customer drags it. A "Follow rider" button brings the view back.
 *
 * Roads: the page asks the route Worker (route-worker.js) for the road route from the
 * rider to the delivery point. The dot is then placed on that road (so it follows the
 * street instead of wandering a few metres either side), the arrow follows the road's
 * direction, the line shows the way still to go, and the card shows a travel time. If the
 * Worker can't be reached, everything above quietly falls back to the plain moving dot.
 *
 * Map: drawn through swift-map.js: MapLibre vector map (OpenFreeMap tiles) when the phone supports it,
 * Leaflet + OpenStreetMap otherwise. Loaded only when a map is actually needed.
 */
(function () {
  'use strict';

  var STALE_AFTER_MS = 3 * 60 * 1000;     // no update for this long: say the rider's connection may be weak
  var CLOCK_SANITY_MS = 6 * 60 * 60 * 1000; // an "age" bigger than this means a wrong phone clock, not a stale rider
  var MIN_GLIDE_MS = 1200;                // the dot takes at least this long to travel to a new position...
  var MAX_GLIDE_MS = 6000;                // ...and at most this long (about one update interval)
  var ARRIVAL_M = 150;                    // the rider is "in delivery range" inside this distance (metres)
  var ARRIVAL_BEEP_MS = 3000;             // how long the arrival beep lasts
  var MAX_ACCEPTED_ACCURACY_M = 150;      // ignore (rare) very rough fixes once we already know where the rider is
  var ROUTE_API = 'https://swift-route.swiftimportersug.workers.dev/route';   // see route-worker.js
  var SNAP_MAX_M = 35;                    // within this of the route = "on the road": the dot is placed on it
  var ROUTE_REFRESH_MS = 45 * 1000;       // re-ask for the route at most this often while the rider is moving...
  var ROUTE_REFRESH_MOVE_M = 120;         // ...and only after they have moved at least this far
  var REROUTE_MIN_GAP_MS = 15 * 1000;     // when the rider leaves the route, wait at least this long between new routes
  var ROUTE_FAIL_PAUSE_MS = 90 * 1000;    // after a failure, leave the service alone for a while
  var SNAP_DISTANCE_M = 600;              // farther than this, jump rather than glide (e.g. coming back to the tab)

  // ── Leaflet, loaded once on demand ──
  // The shared map layer. Normally already on the page; loaded here if the page forgot it.
  var mapLayerPromise = null;
  function ensureMapLayer() {
    if (window.SwiftMap) return Promise.resolve(window.SwiftMap);
    if (mapLayerPromise) return mapLayerPromise;
    mapLayerPromise = new Promise(function (resolve, reject) {
      var js = document.createElement('script');
      js.src = '/swift-map.js?v=6';
      js.onload = function () { window.SwiftMap ? resolve(window.SwiftMap) : reject(new Error('swift-map.js did not load')); };
      js.onerror = function () { mapLayerPromise = null; reject(new Error('swift-map.js failed to load')); };
      document.head.appendChild(js);
    });
    return mapLayerPromise;
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
      '.srm-rider{position:relative;width:48px;height:48px;display:flex;align-items:center;justify-content:center;}' +
      '.srm-bike{width:40px;height:60px;will-change:transform;filter:drop-shadow(0 1px 2px rgba(0,0,0,.55));}' +
      '.srm-bike svg{display:block;width:100%;height:100%;}' +
      '.srm-mapbox{position:relative;}' +
      '.srm-follow{position:absolute;right:10px;bottom:10px;z-index:1000;background:#F0A93B;color:#1a1206;border:none;border-radius:18px;padding:8px 13px;font-size:0.74rem;font-weight:800;font-family:inherit;box-shadow:0 2px 8px rgba(0,0,0,.5);cursor:pointer;display:none;}' +
      '.srm-compass{position:absolute;right:10px;top:50px;z-index:5;width:34px;height:34px;border:0;border-radius:10px;background:rgba(255,255,255,.95);box-shadow:0 2px 8px rgba(0,0,0,.3);font-size:18px;line-height:1;cursor:pointer;touch-action:manipulation;display:none;}' +
      '.srm-compass span{display:block;transition:transform .15s linear;}' +
      '.srm-card .leaflet-container{font-family:inherit;}' +
      // Some pages set max-width:100% on everything, which squashes map markers to nothing.
      '.srm-card .leaflet-container *, .srm-card .maplibregl-map *{max-width:none;}' +
      // the vector map's own zoom buttons and credit line, sized to match the card
      '.srm-card .maplibregl-ctrl-attrib{font-size:10px;}';
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

  function metresBetween(a, b) {
    var dLat = (b[0] - a[0]) * 111320;
    var dLng = (b[1] - a[1]) * 111320 * Math.cos(((a[0] + b[0]) / 2) * Math.PI / 180);
    return Math.sqrt(dLat * dLat + dLng * dLng);
  }
  function bearingBetween(a, b) {
    var rad = Math.PI / 180;
    var p1 = a[0] * rad, p2 = b[0] * rad, dl = (b[1] - a[1]) * rad;
    var y = Math.sin(dl) * Math.cos(p2);
    var x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return (Math.atan2(y, x) / rad + 360) % 360;
  }
  // Signed shortest turn from angle a to angle b, in degrees.
  function angleDiff(a, b) { return ((b - a + 540) % 360) - 180; }

  // ── road route helpers ──
  // A route is { coords:[[lat,lng],...], cum:[metres from start at each point], total, distance, duration }.
  function buildRoute(coords, distance, duration) {
    var cum = [0];
    for (var i = 1; i < coords.length; i++) cum.push(cum[i - 1] + metresBetween(coords[i - 1], coords[i]));
    return { coords: coords, cum: cum, total: cum[cum.length - 1] || distance || 0, distance: distance, duration: duration };
  }
  // The closest point on the route to p: { dist (m from p to the road), s (m along the route), point, seg }.
  function projectOnRoute(route, p) {
    var best = null, kx = 111320 * Math.cos(p[0] * Math.PI / 180), ky = 111320;
    for (var i = 0; i < route.coords.length - 1; i++) {
      var a = route.coords[i], b = route.coords[i + 1];
      var ax = (a[1] - p[1]) * kx, ay = (a[0] - p[0]) * ky;
      var bx = (b[1] - p[1]) * kx, by = (b[0] - p[0]) * ky;
      var dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
      var t = len2 > 0 ? Math.max(0, Math.min(1, (-ax * dx - ay * dy) / len2)) : 0;
      var qx = ax + t * dx, qy = ay + t * dy, d = Math.sqrt(qx * qx + qy * qy);
      if (!best || d < best.dist) best = { dist: d, seg: i, t: t, s: route.cum[i] + t * Math.sqrt(len2), point: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])] };
    }
    return best;
  }
  // The point s metres along the route.
  function pointAtRoute(route, s) {
    var c = route.cum, n = c.length;
    if (s <= 0) return route.coords[0];
    if (s >= c[n - 1]) return route.coords[n - 1];
    var lo = 0, hi = n - 1;
    while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (c[mid] <= s) lo = mid; else hi = mid; }
    var seg = c[hi] - c[lo], t = seg > 0 ? (s - c[lo]) / seg : 0;
    var a = route.coords[lo], b = route.coords[hi];
    return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
  }
  // The part of the route still to travel, starting at s.
  function routeFrom(route, s) {
    var pts = [pointAtRoute(route, s)];
    for (var i = 0; i < route.coords.length; i++) if (route.cum[i] > s) pts.push(route.coords[i]);
    return pts;
  }
  function fmtEta(seconds, metres) {
    if (metres < 150) return 'Your rider is very close!';
    var min = Math.max(1, Math.round(seconds / 60));
    var dist = metres < 1000 ? (Math.round(metres / 10) * 10) + ' m' : (metres / 1000).toFixed(1) + ' km';
    return '≈ ' + min + ' min · ' + dist + ' by road';
  }


  // ── arrival beep (customer side) ──
  // A loud 3-second beep, once per order on this device, when the rider comes within
  // ARRIVAL_M of the delivery point. Only for customer pages (create(wrap, {arrivalBeep:true})).
  var audioCtx = null;
  function getAudioCtx() {
    if (audioCtx) return audioCtx;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { audioCtx = new AC(); } catch (e) { audioCtx = null; }
    return audioCtx;
  }
  // Browsers only allow sound after the customer has touched the page once, so get ready on the first touch.
  var audioUnlockArmed = false;
  function armAudioUnlock() {
    if (audioUnlockArmed) return;
    audioUnlockArmed = true;
    var unlock = function () {
      var ctx = getAudioCtx();
      if (ctx && ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
      ['touchstart', 'click', 'keydown'].forEach(function (ev) { document.removeEventListener(ev, unlock, true); });
    };
    ['touchstart', 'click', 'keydown'].forEach(function (ev) { document.addEventListener(ev, unlock, true); });
  }
  function playArrivalBeep() {
    try { if (navigator.vibrate) navigator.vibrate([400, 150, 400, 150, 400, 150, 400, 150, 400]); } catch (e) {}
    var ctx = getAudioCtx();
    if (!ctx) return false;
    try { if (ctx.state === 'suspended') ctx.resume(); } catch (e) {}
    try {
      var t0 = ctx.currentTime + 0.05;
      var master = ctx.createGain();
      master.gain.value = 1;
      master.connect(ctx.destination);
      // Six sharp beeps (0.3 s on, 0.2 s off) = 3 seconds. A square wave at 1900 Hz cuts through street noise.
      for (var i = 0; i < 6; i++) {
        var on = t0 + i * 0.5;
        var osc = ctx.createOscillator();
        var g = ctx.createGain();
        osc.type = 'square';
        osc.frequency.value = 1900;
        g.gain.setValueAtTime(0.0001, on);
        g.gain.linearRampToValueAtTime(0.9, on + 0.01);
        g.gain.setValueAtTime(0.9, on + 0.28);
        g.gain.linearRampToValueAtTime(0.0001, on + 0.3);
        osc.connect(g); g.connect(master);
        osc.start(on); osc.stop(on + 0.31);
      }
      return true;
    } catch (e) { return false; }
  }
  function arrivalKey(id) { return 'swift_arrival_beep_' + id; }
  function alreadyBeeped(id) { try { return !!localStorage.getItem(arrivalKey(id)); } catch (e) { return false; } }
  function markBeeped(id) { try { localStorage.setItem(arrivalKey(id), String(Date.now())); } catch (e) {} }

  function create(wrap, opts) {
    opts = opts || {};
    var arrivalStreak = 0, beepedThisSession = false;
    if (opts.arrivalBeep) armAudioUnlock();
    var orderId = null;
    var unsubscribe = null;
    var map = null, riderMarker = null, destMarker = null, accCircle = null, routeLine = null;
    var destLatLng = null;
    var loc = null;              // newest fix: { lat, lng, accuracy, updatedMs, receivedMs }
    var shown = null;            // where the dot is drawn right now: { lat, lng }
    var anim = null;             // the glide in progress: { from, to, t0, dur }
    var heading = null;          // direction the dot faces (degrees), null = unknown
    var targetHeading = null;
    var glideMs = 3000;          // typical gap between updates, learned as they arrive
    var rafId = null;
    var lastRouteDrawAt = 0;
    var mapRetryAt = 0;
    var route = null;            // road route from the rider to the delivery point (null = none yet / unavailable)
    var routeFetchedAt = 0, routeFetching = false, routeFailUntil = 0;
    var routedFrom = null;       // where the rider was when the route was fetched
    var offRouteCount = 0;
    var rerouteGapMs = REROUTE_MIN_GAP_MS;   // grows if the rider keeps being off every route we find (e.g. a road missing from the map)
    var shownS = null;           // how far along the route the dot is (m), when it is on the road
    var remainingM = null;       // road distance still to go, when known
    var followOn = true;
    var camBusyUntil = 0;
    var didFit = false;
    var lastPanAt = 0;
    var ageTimer = null;
    var mapStarted = false;
    var els = {};

    function stopLoop() { if (rafId) { cancelAnimationFrame(rafId); rafId = null; } }

    function teardown(hide) {
      if (unsubscribe) { try { unsubscribe(); } catch (e) {} unsubscribe = null; }
      if (ageTimer) { clearInterval(ageTimer); ageTimer = null; }
      stopLoop();
      if (resizeWatch) { try { resizeWatch.disconnect(); } catch (e) {} resizeWatch = null; }
      if (map) { try { map.remove(); } catch (e) {} map = null; }
      riderMarker = null; destMarker = null; accCircle = null; routeLine = null;
      loc = null; shown = null; anim = null; heading = null; targetHeading = null; glideMs = 3000;
      route = null; routeFetchedAt = 0; routeFetching = false; routeFailUntil = 0; routedFrom = null; offRouteCount = 0; rerouteGapMs = REROUTE_MIN_GAP_MS; shownS = null; remainingM = null;
      followOn = true; camBusyUntil = 0; didFit = false; mapStarted = false; mapRetryAt = 0; els = {};
      orderId = null; destLatLng = null; arrivalStreak = 0; beepedThisSession = false;
      if (hide && wrap) { wrap.style.display = 'none'; wrap.innerHTML = ''; }
    }

    function buildDom() {
      injectStyles();
      wrap.innerHTML =
        '<div class="srm-card">' +
          '<div class="srm-head"><span class="srm-title">📍 Live rider location</span><span class="srm-live stale" data-r="live">WAITING</span></div>' +
          '<div class="srm-mapbox" data-r="mapbox" style="display:none;"><div class="srm-map" data-r="map"></div><button type="button" class="srm-follow" data-r="follow">🎯 Follow rider</button><button type="button" class="srm-compass" data-r="compass" aria-label="Face north"><span>🧭</span></button></div>' +
          '<div class="srm-meta" data-r="meta" style="display:none;"><span class="srm-dist" data-r="dist"></span><span class="srm-age" data-r="age"></span></div>' +
          '<div class="srm-wait" data-r="wait">Your rider\'s live location will appear here as soon as they start sharing it.</div>' +
        '</div>';
      ['live', 'mapbox', 'map', 'follow', 'compass', 'meta', 'dist', 'age', 'wait'].forEach(function (k) { els[k] = wrap.querySelector('[data-r="' + k + '"]'); });
      els.follow.addEventListener('click', function () {
        followOn = true;
        els.follow.style.display = 'none';
        if (map && map.canRotate && shown) {
          // Back to "ride along": centred on the rider, facing the way they are going.
          camBusyUntil = Date.now() + 650;
          map.follow([shown.lat, shown.lng], heading, camOffsetY(), { animate: true, duration: 600 });
          setTimeout(ensureLoop, 700);
        } else frameBoth(true);
      });
      // Compass: tap to face north (and stop following until "Follow rider" is tapped).
      els.compass.addEventListener('click', function () {
        if (!map || !map.canRotate) return;
        followOn = false;
        els.follow.style.display = 'block';
        map.setBearing(0, { animate: true, duration: 0.5 });
      });
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
      return { html: '<div class="srm-pin ' + cls + '">' + emoji + '</div>', size: [34, 34] };
    }
    // A bike seen from above, nose pointing up. The whole drawing is turned to face the way the
    // rider is travelling. Dark outline, no white backing, so it stays clear on pale roads.
    var BIKE_SVG = '<svg viewBox="0 0 40 60" xmlns="http://www.w3.org/2000/svg">' +
      '<rect x="16.5" y="40" width="7" height="17" rx="3.5" fill="#1a1206"/>' +
      '<rect x="17" y="3" width="6" height="14" rx="3" fill="#1a1206"/>' +
      '<path d="M20 12 C28 16 29 31 25.5 45 L14.5 45 C11 31 12 16 20 12 Z" fill="#F0A93B" stroke="#1a1206" stroke-width="2" stroke-linejoin="round"/>' +
      '<rect x="7" y="17" width="26" height="3.6" rx="1.8" fill="#1a1206"/>' +
      '<ellipse cx="20" cy="34" rx="7.5" ry="8.5" fill="#1a1206"/>' +
      '<circle cx="20" cy="30" r="5" fill="#F0A93B" stroke="#1a1206" stroke-width="1.6"/>' +
      '</svg>';
    function makeRiderIcon() {
      return { html: '<div class="srm-rider"><div class="srm-bike">' + BIKE_SVG + '</div></div>', size: [48, 48] };
    }

    // If the turning/ride-along map ever fails on a phone, fall back (once) to the plain map that worked before.
    var rotateOK = true;
    function dropMap() {
      if (resizeWatch) { try { resizeWatch.disconnect(); } catch (e) {} resizeWatch = null; }
      if (map) { try { map.remove(); } catch (e) {} map = null; }
      riderMarker = null; destMarker = null; accCircle = null; routeLine = null;
      if (els.map) els.map.innerHTML = '';
    }
    var sizeRetries = 0, resizeWatch = null;
    function ensureMap() {
      if (map || mapStarted || Date.now() < mapRetryAt) return;
      var forOrder = orderId;
      els.mapbox.style.display = 'block';        // the map needs a visible box to measure
      // A map built inside a box that has no size yet (card still hidden / not laid out) breaks with
      // "failed to invert matrix". Wait until the box really has a size, then build.
      if (!(els.map.clientWidth > 0 && els.map.clientHeight > 0)) {
        mapRetryAt = Date.now() + 300;
        setTimeout(function () { if (orderId === forOrder && !map && !mapStarted && els.live) render(); }, 350);
        return;
      }
      mapStarted = true;
      ensureMapLayer().then(function (SM) {
        return SM.create(els.map, { center: destLatLng || (shown ? [shown.lat, shown.lng] : [0.3476, 32.5825]), zoom: 15, zoomControl: true, zoomPosition: 'topleft', pitch: 40, rotate: rotateOK });
      }).then(function (M) {
        if (orderId !== forOrder || !els.map) { M.remove(); return; }   // moved on while the map was starting
        map = M;
        try {
        // Only the customer's own touches count as "I want to look around" (not our own camera moves).
        var userTookOver = function () {
          if (!followOn) return;
          followOn = false;
          if (els.follow) els.follow.style.display = 'block';
        };
        map.on('dragstart', userTookOver);
        if (map.canRotate) {
          // Turning the map by hand takes over from "ride along" (zooming alone does not).
          map.on('rotatestart', function (ev) { if (ev && ev.originalEvent) userTookOver(); });
          map.on('rotate', function () { place(); updateCompass(); });
          els.compass.style.display = 'block';
        } else {
          els.map.addEventListener('wheel', userTookOver, { passive: true });
          els.map.addEventListener('touchstart', function (e) { if (e.touches && e.touches.length > 1) userTookOver(); }, { passive: true });
        }
        setTimeout(function () { if (map) map.invalidateSize(); }, 250);
        // If the box is resized later (rotating the phone, a panel opening), tell the map.
        try {
          if (window.ResizeObserver) {
            if (resizeWatch) resizeWatch.disconnect();
            resizeWatch = new ResizeObserver(function () { if (map) map.invalidateSize(); });
            resizeWatch.observe(els.map);
          }
        } catch (e4) {}
        sizeRetries = 0;
        els.mapbox.setAttribute('data-engine', M.kind);
        render();
        } catch (setupErr) { if (map) { try { map.remove(); } catch (e2) {} map = null; } throw setupErr; }
      }).catch(function (e) {
        console.error('[rider-map] map unavailable:', e);
        dropMap();
        mapStarted = false;
        var errText = String((e && e.message) || e);
        if (/invert|matrix|size|NaN|zero|width|height/i.test(errText) && sizeRetries < 8) {
          // The box was not ready (no size yet): not a rotation problem. Just try again in a moment.
          sizeRetries++;
          mapRetryAt = Date.now() + 1000;
          setTimeout(function () { if (orderId && !map && !mapStarted && els.live) render(); }, 1100);
          return;
        }
        if (rotateOK) {
          // Try again once with the plain (north-up) map before giving up.
          rotateOK = false;
          try {
            var note = document.createElement('div');
            note.style.cssText = 'position:absolute;left:8px;bottom:8px;z-index:6;max-width:70%;font:600 10px/1.3 system-ui,sans-serif;color:#fff;background:rgba(0,0,0,.55);padding:3px 6px;border-radius:6px;pointer-events:none';
            note.textContent = 'Map rotation off: ' + String((e && e.message) || e).slice(0, 90);
            els.mapbox.appendChild(note);
          } catch (e3) {}
          if (els.follow) els.follow.style.display = 'none';
          if (els.compass) els.compass.style.display = 'none';
          setTimeout(function () { if (orderId) ensureMap(); }, 50);
          return;
        }
        mapRetryAt = Date.now() + 30000;
        if (els.mapbox) els.mapbox.style.display = 'none';
        // No map: the distance and "last seen" line below still work.
      });
    }

    // While riding along, the rider sits a little below the middle so more of the road ahead shows.
    function camOffsetY() { return els.map ? Math.round(els.map.clientHeight * 0.16) : 0; }
    function updateCompass() {
      if (!map || !map.canRotate || !els.compass) return;
      var sp = els.compass.firstChild;
      if (sp) sp.style.transform = 'rotate(' + (-map.getBearing()).toFixed(1) + 'deg)';
    }

    // Keep both the rider and the delivery point in view (used on first sight and by "Follow rider").
    function frameBoth(animate) {
      if (!map || !shown) return;
      var pts = [[shown.lat, shown.lng]];
      if (destLatLng) pts.push(destLatLng);
      camBusyUntil = Date.now() + 1300;
      if (pts.length > 1) map.fitBounds(pts, { padding: [44, 44], maxZoom: 17, animate: !!animate, duration: 1, bearing: (map.canRotate && heading != null) ? heading : undefined });
      else map.setView(pts[0], 16, { animate: !!animate });
    }

    // Draws the dot (and the things that move with it) at its current in-between position.
    function place() {
      if (!map || !shown) return;
      var pos = [shown.lat, shown.lng];
      if (!riderMarker) { var ri = makeRiderIcon(); riderMarker = map.addMarker({ latlng: pos, html: ri.html, size: ri.size, z: 500, interactive: false }); }
      else riderMarker.setLatLng(pos);
      var el = riderMarker.getElement();
      var bike = el && el.querySelector('.srm-bike');
      var camB = (map.canRotate && map.getBearing) ? map.getBearing() : 0;
      if (bike) bike.style.transform = 'rotate(' + (((heading == null ? 0 : heading) - camB + 360) % 360).toFixed(1) + 'deg)';
      // With a road route the line is drawn by drawRoute() when a fix arrives; without one,
      // fall back to a dashed straight line that follows the dot.
      if (!route && destLatLng) {
        if (!routeLine || routeLine.__road) {
          if (routeLine) routeLine.remove();
          routeLine = map.addLine([pos, destLatLng], { color: '#F0A93B', weight: 3, opacity: 0.55, dash: [2, 8] });
          routeLine.__road = false;
        } else routeLine.setLatLngs([pos, destLatLng]);
      }
      if (accCircle) accCircle.setLatLng(pos);
    }

    // One animation frame: move the dot a little further along its glide, turn it a little, nudge the camera.
    function frame(ts) {
      rafId = null;
      var busy = false, routeFollow = false, finishedGlide = false;
      if (anim) {
        var p = Math.min(1, (performance.now() - anim.t0) / anim.dur);
        if (anim.route && anim.route === route) {
          // Along the road, so bends are followed instead of cut across.
          shownS = anim.s0 + (anim.s1 - anim.s0) * p;
          var rp = pointAtRoute(route, shownS);
          shown = { lat: rp[0], lng: rp[1] };
        } else {
          shown = { lat: anim.from.lat + (anim.to.lat - anim.from.lat) * p, lng: anim.from.lng + (anim.to.lng - anim.from.lng) * p };
        }
        if (p >= 1) { anim = null; routeFollow = true; finishedGlide = true; } else { busy = true; routeFollow = true; }
      }
      // On the road: face the way the road runs at the bike's own position, and redraw the
      // yellow line from the bike (not from where the newest reading was), so the two never drift apart.
      if (route && shownS != null && routeFollow) {
        var ahead = pointAtRoute(route, Math.min(route.total, shownS + 12));
        if (ahead && shown && metresBetween([shown.lat, shown.lng], ahead) > 3 && !finishedGlide) targetHeading = bearingBetween([shown.lat, shown.lng], ahead);
        if (finishedGlide || performance.now() - lastRouteDrawAt > 90) { lastRouteDrawAt = performance.now(); drawRoute(shownS); }
      }
      if (heading != null && targetHeading != null) {
        var d = angleDiff(heading, targetHeading);
        if (Math.abs(d) > 0.5) { heading = (heading + d * 0.3 + 360) % 360; busy = true; }
      }
      try { place(); } catch (e) { console.error('[rider-map] draw failed:', e); }
      // Camera, ride-along mode: centred on the rider and turned to face the way they are heading.
      if (map && map.canRotate && followOn && shown && Date.now() > camBusyUntil) {
        try { map.follow([shown.lat, shown.lng], heading, camOffsetY()); } catch (e) {}
      } else
      // Camera: while following, only move when the rider nears the edge, so the map doesn't shake.
      if (map && followOn && shown && Date.now() > camBusyUntil && ts - lastPanAt > 120) {
        lastPanAt = ts;
        try { map.panInside([shown.lat, shown.lng], { padding: [70, 70], animate: false }); } catch (e) {}
      }
      if (busy) rafId = requestAnimationFrame(frame);
    }
    function ensureLoop() { if (!rafId) rafId = requestAnimationFrame(frame); }

    // A new position arrived: glide to it over about one update interval.
    // onRoad (optional) = { route, s }: the position is on the road route, s metres along it.
    function moveTo(lat, lng, brgFromServer, onRoad) {
      var target = { lat: lat, lng: lng };
      if (!shown) { shown = target; anim = null; shownS = onRoad ? onRoad.s : null; }
      else {
        var gap = metresBetween([shown.lat, shown.lng], [lat, lng]);
        // Direction: the one given, else the one they just moved in.
        if (brgFromServer == null && gap >= 6) brgFromServer = bearingBetween([shown.lat, shown.lng], [lat, lng]);
        if (gap > SNAP_DISTANCE_M || document.hidden) { shown = target; anim = null; shownS = onRoad ? onRoad.s : null; }
        else if (gap > 0.3) {
          if (onRoad && onRoad.route === route && shownS != null) {
            var s1 = onRoad.s;
            if (s1 < shownS && shownS - s1 < 25) s1 = shownS;       // ignore small backward wobble
            anim = { route: route, s0: shownS, s1: s1, from: { lat: shown.lat, lng: shown.lng }, to: target, t0: performance.now(), dur: glideMs };
          } else {
            anim = { from: { lat: shown.lat, lng: shown.lng }, to: target, t0: performance.now(), dur: glideMs };
            shownS = onRoad ? onRoad.s : null;
          }
        }
      }
      if (brgFromServer != null) {
        targetHeading = brgFromServer;
        if (heading == null) heading = brgFromServer;
      }
      ensureLoop();
    }

    // ── road route ──
    function drawRoute(fromS) {
      if (!map || !route) return;
      var pts = routeFrom(route, fromS || 0);
      if (routeLine && !routeLine.__road) { routeLine.remove(); routeLine = null; }
      if (!routeLine) {
        routeLine = map.addLine(pts, { color: '#F0A93B', weight: 5, opacity: 0.95, casing: { color: '#ffffff', weight: 9, opacity: 0.85 } });
        routeLine.__road = true;
        if (riderMarker) riderMarker.setZ(500);
      } else routeLine.setLatLngs(pts);
    }

    function maybeFetchRoute(force) {
      if (routeFetching || !loc || !destLatLng || !orderId) return;
      var now = Date.now();
      if (now < routeFailUntil) return;
      var moved = routedFrom ? metresBetween(routedFrom, [loc.lat, loc.lng]) : 1e9;
      var due = false;
      if (!route) due = true;                                                                            // first route
      else if (offRouteCount >= 2 && now - routeFetchedAt > rerouteGapMs) { due = true; rerouteGapMs = Math.min(rerouteGapMs * 2, 120000); }   // rider left the route
      else if (now - routeFetchedAt > ROUTE_REFRESH_MS && moved > ROUTE_REFRESH_MOVE_M) due = true;      // keep time/distance fresh
      if (!due && !force) return;

      var forOrder = orderId, from = [loc.lat, loc.lng];
      routeFetching = true;
      var ctl = (typeof AbortController === 'function') ? new AbortController() : null;
      var killer = setTimeout(function () { if (ctl) ctl.abort(); }, 9000);
      fetch(ROUTE_API + '?from=' + from[0].toFixed(5) + ',' + from[1].toFixed(5) + '&to=' + destLatLng[0].toFixed(5) + ',' + destLatLng[1].toFixed(5), ctl ? { signal: ctl.signal } : undefined)
        .then(function (r) { if (!r.ok) throw new Error('route ' + r.status); return r.json(); })
        .then(function (data) {
          clearTimeout(killer);
          routeFetching = false;
          if (orderId !== forOrder) return;
          if (!data || !data.coords || data.coords.length < 2) throw new Error('empty route');
          route = buildRoute(data.coords, data.distance, data.duration);
          routeFetchedAt = Date.now();
          routedFrom = from;
          offRouteCount = 0;
          // Put the dot onto the new road straight away.
          if (loc) {
            var pr = projectOnRoute(route, [loc.lat, loc.lng]);
            if (pr && pr.dist <= SNAP_MAX_M) { shownS = pr.s; remainingM = Math.max(0, route.total - pr.s); }
            else { shownS = null; remainingM = null; }
            drawRoute(shownS || 0);
          }
          render();
        })
        .catch(function (e) {
          clearTimeout(killer);
          routeFetching = false;
          routeFailUntil = Date.now() + ROUTE_FAIL_PAUSE_MS;    // no road service: carry on without it
          console.warn('[rider-map] road route unavailable:', e && e.message);
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
        if (route && remainingM != null && route.total > 0) {
          els.dist.textContent = fmtEta(route.duration * Math.min(1, remainingM / route.total), remainingM);
        } else {
          els.dist.textContent = destLatLng ? fmtDistance(distanceKm([loc.lat, loc.lng], destLatLng)) : '';
        }
        els.age.textContent = fmtAge(age);
      }

      if (!map) return;

      if (destLatLng) {
        if (!destMarker) { var di = makeIcon('dest', '📍'); destMarker = map.addMarker({ latlng: destLatLng, html: di.html, size: di.size, interactive: false }); }
        else destMarker.setLatLng(destLatLng);
      }
      if (loc && shown) {
        // A faint circle shows how sure we are, but only when the reading is rough.
        var showRing = loc.accuracy >= 30;
        if (showRing && !accCircle) accCircle = map.addCircle([shown.lat, shown.lng], loc.accuracy, { color: '#F0A93B', weight: 1, opacity: 0.5, fillOpacity: 0.1 });
        else if (showRing) accCircle.setRadius(loc.accuracy);
        else if (accCircle) { accCircle.remove(); accCircle = null; }
        place();

        if (!didFit) {
          didFit = true;
          frameBoth(false);
          if (map.canRotate) ensureLoop();
        } else if (map.canRotate) {
          // ride-along mode keeps the rider centred itself (see frame())
          if (followOn) ensureLoop();
        } else if (followOn && destLatLng && Date.now() > camBusyUntil) {
          // Keep the delivery point in view too: re-frame (gently) if either has drifted out.
          if (!map.insideView([shown.lat, shown.lng], 0.06) || !map.insideView(destLatLng, 0.06)) {
            if (metresBetween([shown.lat, shown.lng], destLatLng) < 4000) frameBoth(true);
          }
        }
      }
    }

    // Beeps once when the rider is within ARRIVAL_M. Needs two fresh readings in a row, so one stray fix can't set it off.
    function checkArrival() {
      if (!opts.arrivalBeep || !loc || !destLatLng || !orderId) return;
      if (beepedThisSession || alreadyBeeped(orderId)) return;
      if (Date.now() - loc.updatedMs > 120000) { arrivalStreak = 0; return; }           // an old position doesn't count
      var straight = metresBetween([loc.lat, loc.lng], destLatLng);
      var d = (remainingM != null) ? Math.min(straight, remainingM) : straight;
      if (d <= ARRIVAL_M) arrivalStreak++; else arrivalStreak = 0;
      if (arrivalStreak >= 2) {
        beepedThisSession = true;
        markBeeped(orderId);
        playArrivalBeep();
      }
    }

    function subscribe() {
      var f = window.fbFns;
      if (!window.fbDb || !f || !f.onSnapshot || !f.doc) return;
      var forOrder = orderId;
      unsubscribe = f.onSnapshot(f.doc(window.fbDb, 'rider_locations', forOrder), function (snap) {
        if (orderId !== forOrder) return;
        if (!snap.exists()) { loc = null; shown = null; anim = null; if (riderMarker && map) { riderMarker.remove(); riderMarker = null; } render(); return; }
        var d = snap.data() || {};
        if (typeof d.lat !== 'number' || typeof d.lng !== 'number') return;
        var ms = (d.updatedAt && typeof d.updatedAt.toMillis === 'function') ? d.updatedAt.toMillis() : Date.now();
        var accuracy = (typeof d.accuracy === 'number') ? d.accuracy : 0;

        // Protect the map from a stray reading: an out-of-order update, or a very rough one.
        if (loc && ms < loc.updatedMs) return;
        if (loc && accuracy > MAX_ACCEPTED_ACCURACY_M) return;

        // Learn how often updates really arrive, so each glide lasts about one gap.
        var now = Date.now();
        if (loc) {
          var gap = Math.max(MIN_GLIDE_MS, Math.min(MAX_GLIDE_MS, now - loc.receivedMs));
          glideMs = glideMs * 0.5 + gap * 0.5;
        }
        loc = { lat: d.lat, lng: d.lng, accuracy: accuracy, updatedMs: ms, receivedMs: now };

        var moving = (typeof d.speed !== 'number') || d.speed >= 1.5;
        var brg = (typeof d.heading === 'number' && moving) ? d.heading : null;

        // On the road? Then place the dot on it and face along it.
        var onRoad = null, at = [d.lat, d.lng];
        if (route) {
          var pr = projectOnRoute(route, at);
          if (pr && pr.dist <= SNAP_MAX_M) {
            offRouteCount = 0;
            rerouteGapMs = REROUTE_MIN_GAP_MS;
            // The dot glides to each new reading, so on its own it always trails the real bike by one
            // update. While moving, aim a short way ahead (about 2 s of travel, at most 20 m) so it keeps up.
            var lead = (moving && typeof d.speed === 'number') ? Math.min(20, d.speed * 2) : 0;
            var sAim = Math.min(route.total, pr.s + lead);
            onRoad = { route: route, s: sAim };
            at = lead > 0 ? pointAtRoute(route, sAim) : pr.point;
            remainingM = Math.max(0, route.total - pr.s);
            if (moving) {
              var a = route.coords[pr.seg], b = route.coords[pr.seg + 1];
              brg = bearingBetween(a, b);
            }
          } else {
            offRouteCount++;
            remainingM = null;
          }
        }
        moveTo(at[0], at[1], brg, onRoad);
        if (route) drawRoute(shownS != null ? shownS : (onRoad ? onRoad.s : 0));
        render();
        checkArrival();
        maybeFetchRoute(false);
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

    return { sync: sync, destroy: function () { teardown(true); }, testBeep: playArrivalBeep };
  }

  window.SwiftRiderMap = { create: create };
})();
