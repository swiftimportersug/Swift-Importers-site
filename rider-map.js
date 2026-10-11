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
 * Map: Leaflet + OpenStreetMap, loaded only when a map is actually needed.
 */
(function () {
  'use strict';

  var LEAFLET_CSS = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css';
  var LEAFLET_JS = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';
  var STALE_AFTER_MS = 3 * 60 * 1000;     // no update for this long: say the rider's connection may be weak
  var CLOCK_SANITY_MS = 6 * 60 * 60 * 1000; // an "age" bigger than this means a wrong phone clock, not a stale rider
  var MIN_GLIDE_MS = 1200;                // the dot takes at least this long to travel to a new position...
  var MAX_GLIDE_MS = 6000;                // ...and at most this long (about one update interval)
  var MAX_ACCEPTED_ACCURACY_M = 150;      // ignore (rare) very rough fixes once we already know where the rider is
  var SNAP_DISTANCE_M = 600;              // farther than this, jump rather than glide (e.g. coming back to the tab)

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
      '.srm-rider{position:relative;width:52px;height:52px;display:flex;align-items:center;justify-content:center;}' +
      '.srm-arrow{position:absolute;left:0;top:0;width:52px;height:52px;opacity:0;transition:opacity .3s;will-change:transform;}' +
      '.srm-arrow.on{opacity:1;}' +
      '.srm-arrow::before{content:"";position:absolute;left:50%;top:-1px;margin-left:-8px;border-left:8px solid transparent;border-right:8px solid transparent;border-bottom:14px solid #F0A93B;filter:drop-shadow(0 1px 2px rgba(0,0,0,.5));}' +
      '.srm-mapbox{position:relative;}' +
      '.srm-follow{position:absolute;right:10px;bottom:10px;z-index:1000;background:#F0A93B;color:#1a1206;border:none;border-radius:18px;padding:8px 13px;font-size:0.74rem;font-weight:800;font-family:inherit;box-shadow:0 2px 8px rgba(0,0,0,.5);cursor:pointer;display:none;}' +
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

  function create(wrap) {
    var orderId = null;
    var unsubscribe = null;
    var map = null, riderMarker = null, destMarker = null, accCircle = null, routeLine = null, L = null;
    var destLatLng = null;
    var loc = null;              // newest fix: { lat, lng, accuracy, updatedMs, receivedMs }
    var shown = null;            // where the dot is drawn right now: { lat, lng }
    var anim = null;             // the glide in progress: { from, to, t0, dur }
    var heading = null;          // direction the dot faces (degrees), null = unknown
    var targetHeading = null;
    var glideMs = 3000;          // typical gap between updates, learned as they arrive
    var rafId = null;
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
      if (map) { try { map.remove(); } catch (e) {} map = null; }
      riderMarker = null; destMarker = null; accCircle = null; routeLine = null;
      loc = null; shown = null; anim = null; heading = null; targetHeading = null; glideMs = 3000;
      followOn = true; camBusyUntil = 0; didFit = false; mapStarted = false; els = {};
      orderId = null; destLatLng = null;
      if (hide && wrap) { wrap.style.display = 'none'; wrap.innerHTML = ''; }
    }

    function buildDom() {
      injectStyles();
      wrap.innerHTML =
        '<div class="srm-card">' +
          '<div class="srm-head"><span class="srm-title">📍 Live rider location</span><span class="srm-live stale" data-r="live">WAITING</span></div>' +
          '<div class="srm-mapbox" data-r="mapbox" style="display:none;"><div class="srm-map" data-r="map"></div><button type="button" class="srm-follow" data-r="follow">🎯 Follow rider</button></div>' +
          '<div class="srm-meta" data-r="meta" style="display:none;"><span class="srm-dist" data-r="dist"></span><span class="srm-age" data-r="age"></span></div>' +
          '<div class="srm-wait" data-r="wait">Your rider\'s live location will appear here as soon as they start sharing it.</div>' +
        '</div>';
      ['live', 'mapbox', 'map', 'follow', 'meta', 'dist', 'age', 'wait'].forEach(function (k) { els[k] = wrap.querySelector('[data-r="' + k + '"]'); });
      els.follow.addEventListener('click', function () {
        followOn = true;
        els.follow.style.display = 'none';
        frameBoth(true);
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
      return L.divIcon({ className: '', html: '<div class="srm-pin ' + cls + '">' + emoji + '</div>', iconSize: [34, 34], iconAnchor: [17, 17] });
    }
    function makeRiderIcon() {
      return L.divIcon({
        className: '',
        html: '<div class="srm-rider"><div class="srm-arrow"></div><div class="srm-pin rider">🏍️</div></div>',
        iconSize: [52, 52], iconAnchor: [26, 26]
      });
    }

    function ensureMap() {
      if (map || mapStarted) return;
      mapStarted = true;
      var forOrder = orderId;
      loadLeaflet().then(function (Lib) {
        if (orderId !== forOrder || !els.map) return;   // moved on while Leaflet was loading
        L = Lib;
        els.mapbox.style.display = 'block';
        map = L.map(els.map, { zoomControl: true, attributionControl: true }).setView(destLatLng || (shown ? [shown.lat, shown.lng] : [0.3476, 32.5825]), 15);
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(map);
        // Only the customer's own touches count as "I want to look around" (not our own camera moves).
        var userTookOver = function () {
          if (!followOn) return;
          followOn = false;
          if (els.follow) els.follow.style.display = 'block';
        };
        map.on('dragstart', userTookOver);
        els.map.addEventListener('wheel', userTookOver, { passive: true });
        els.map.addEventListener('touchstart', function (e) { if (e.touches && e.touches.length > 1) userTookOver(); }, { passive: true });
        setTimeout(function () { if (map) map.invalidateSize(); }, 250);
        render();
      }).catch(function (e) {
        console.error('[rider-map] map unavailable:', e);
        mapStarted = false;
        // No map: the distance and "last seen" line below still work.
      });
    }

    // Keep both the rider and the delivery point in view (used on first sight and by "Follow rider").
    function frameBoth(animate) {
      if (!map || !shown) return;
      var pts = [[shown.lat, shown.lng]];
      if (destLatLng) pts.push(destLatLng);
      camBusyUntil = Date.now() + 1300;
      if (pts.length > 1) map.fitBounds(pts, { padding: [44, 44], maxZoom: 17, animate: !!animate, duration: 1 });
      else map.setView(pts[0], 16, { animate: !!animate });
    }

    // Draws the dot (and the things that move with it) at its current in-between position.
    function place() {
      if (!map || !L || !shown) return;
      var pos = [shown.lat, shown.lng];
      if (!riderMarker) riderMarker = L.marker(pos, { icon: makeRiderIcon(), keyboard: false, zIndexOffset: 500 }).addTo(map);
      else riderMarker.setLatLng(pos);
      var el = riderMarker.getElement();
      var arrow = el && el.querySelector('.srm-arrow');
      if (arrow) {
        if (heading == null) arrow.classList.remove('on');
        else { arrow.classList.add('on'); arrow.style.transform = 'rotate(' + heading.toFixed(1) + 'deg)'; }
      }
      if (destLatLng) {
        if (!routeLine) routeLine = L.polyline([pos, destLatLng], { color: '#F0A93B', weight: 3, opacity: 0.55, dashArray: '2 8', lineCap: 'round' }).addTo(map);
        else routeLine.setLatLngs([pos, destLatLng]);
      }
      if (accCircle) accCircle.setLatLng(pos);
    }

    // One animation frame: move the dot a little further along its glide, turn it a little, nudge the camera.
    function frame(ts) {
      rafId = null;
      var busy = false;
      if (anim) {
        var p = Math.min(1, (performance.now() - anim.t0) / anim.dur);
        shown = { lat: anim.from.lat + (anim.to.lat - anim.from.lat) * p, lng: anim.from.lng + (anim.to.lng - anim.from.lng) * p };
        if (p >= 1) anim = null; else busy = true;
      }
      if (heading != null && targetHeading != null) {
        var d = angleDiff(heading, targetHeading);
        if (Math.abs(d) > 0.5) { heading = (heading + d * 0.18 + 360) % 360; busy = true; }
      }
      place();
      // Camera: while following, only move when the rider nears the edge, so the map doesn't shake.
      if (map && followOn && shown && Date.now() > camBusyUntil && ts - lastPanAt > 120) {
        lastPanAt = ts;
        try { map.panInside([shown.lat, shown.lng], { padding: [70, 70], animate: false }); } catch (e) {}
      }
      if (busy) rafId = requestAnimationFrame(frame);
    }
    function ensureLoop() { if (!rafId) rafId = requestAnimationFrame(frame); }

    // A new position arrived: glide to it over about one update interval.
    function moveTo(lat, lng, brgFromServer) {
      var target = { lat: lat, lng: lng };
      if (!shown) { shown = target; anim = null; }
      else {
        var gap = metresBetween([shown.lat, shown.lng], [lat, lng]);
        // Direction: the one the rider's phone reported, else the one they just moved in.
        if (brgFromServer == null && gap >= 6) brgFromServer = bearingBetween([shown.lat, shown.lng], [lat, lng]);
        if (gap > SNAP_DISTANCE_M || document.hidden) { shown = target; anim = null; }
        else if (gap > 0.3) anim = { from: { lat: shown.lat, lng: shown.lng }, to: target, t0: performance.now(), dur: glideMs };
      }
      if (brgFromServer != null) {
        targetHeading = brgFromServer;
        if (heading == null) heading = brgFromServer;
      }
      ensureLoop();
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
      if (loc && shown) {
        // A faint circle shows how sure we are, but only when the reading is rough.
        var showRing = loc.accuracy >= 30;
        if (showRing && !accCircle) accCircle = L.circle([shown.lat, shown.lng], { radius: loc.accuracy, color: '#F0A93B', weight: 1, opacity: 0.5, fillColor: '#F0A93B', fillOpacity: 0.1, interactive: false }).addTo(map);
        else if (showRing) accCircle.setRadius(loc.accuracy);
        else if (accCircle) { map.removeLayer(accCircle); accCircle = null; }
        place();

        if (!didFit) {
          didFit = true;
          frameBoth(false);
        } else if (followOn && destLatLng && Date.now() > camBusyUntil) {
          // Keep the delivery point in view too: re-frame (gently) if either has drifted out.
          var b = map.getBounds().pad(-0.06);
          if (!b.contains([shown.lat, shown.lng]) || !b.contains(destLatLng)) {
            if (metresBetween([shown.lat, shown.lng], destLatLng) < 4000) frameBoth(true);
          }
        }
      }
    }

    function subscribe() {
      var f = window.fbFns;
      if (!window.fbDb || !f || !f.onSnapshot || !f.doc) return;
      var forOrder = orderId;
      unsubscribe = f.onSnapshot(f.doc(window.fbDb, 'rider_locations', forOrder), function (snap) {
        if (orderId !== forOrder) return;
        if (!snap.exists()) { loc = null; shown = null; anim = null; if (riderMarker && map) { map.removeLayer(riderMarker); riderMarker = null; } render(); return; }
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
        moveTo(d.lat, d.lng, (typeof d.heading === 'number' && moving) ? d.heading : null);
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
