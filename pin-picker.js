/*
 * Swift Importers — "confirm my pin" map
 * ======================================
 * A full-screen map where the customer checks, and if needed corrects, the delivery
 * spot before it is saved. The pin stays fixed in the middle of the screen and the
 * customer moves the MAP underneath it (the way ride-hailing apps do), which is
 * easier and more exact with a thumb than dragging a tiny marker.
 *
 *   SwiftPinPicker.open({
 *     lat, lng,              // where to start (the phone's GPS reading, or a saved pin)
 *     accuracy,              // optional: GPS accuracy in metres, drawn as a faint circle
 *     onConfirm(lat, lng, info),   // info = { moved: metres between the start and the chosen spot }
 *     onCancel(),            // closed without confirming
 *     onUnavailable(),       // the map could not load (offline): the caller should use the plain GPS reading
 *     openOverlay(el, cleanup), closeOverlay(el)   // optional: lets the page's own back-button handling manage it
 *   });
 *
 * Map: drawn through swift-map.js (MapLibre vector map when the phone supports it, Leaflet otherwise),
 * with a satellite view so a customer can recognise their own roof or gate. Loaded only when opened.
 */
(function () {
  var KAMPALA = [0.3476, 32.5825];
  var FAR_WARNING_M = 300;       // gently warn if the chosen spot is this far from where the phone says it is

  // The shared map layer. Normally already on the page; loaded here if the page forgot it.
  var mapLayerPromise = null;
  function ensureMapLayer() {
    if (window.SwiftMap) return Promise.resolve(window.SwiftMap);
    if (mapLayerPromise) return mapLayerPromise;
    mapLayerPromise = new Promise(function (resolve, reject) {
      var js = document.createElement('script');
      js.src = '/swift-map.js?v=1';
      js.onload = function () { window.SwiftMap ? resolve(window.SwiftMap) : reject(new Error('swift-map.js did not load')); };
      js.onerror = function () { mapLayerPromise = null; reject(new Error('swift-map.js failed to load')); };
      document.head.appendChild(js);
    });
    return mapLayerPromise;
  }

  // How far in to start: close enough to see the street and the gate.
  function zoomFor(acc) {
    if (!(acc > 0)) return 18;
    if (acc <= 60) return 18;
    if (acc <= 200) return 17;
    return 16;
  }

  function metres(a1, o1, a2, o2) {
    var dLat = (a2 - a1) * 111320;
    var dLng = (o2 - o1) * 111320 * Math.cos(((a1 + a2) / 2) * Math.PI / 180);
    return Math.sqrt(dLat * dLat + dLng * dLng);
  }

  var styled = false;
  function addStyles() {
    if (styled) return;
    styled = true;
    var css = document.createElement('style');
    css.textContent =
      '.swpp{position:fixed;inset:0;z-index:100000;display:none;flex-direction:column;background:#0f1218;color:#f2f2f2;font-family:inherit;}' +
      '.swpp.open{display:flex;}' +
      '.swpp *, .swpp .maplibregl-map *{max-width:none;}' +
      '.swpp-head{padding:14px 16px 10px;background:#161a22;border-bottom:1px solid rgba(255,255,255,.08);}' +
      '.swpp-title{font-size:1.02rem;font-weight:700;}' +
      '.swpp-sub{font-size:.8rem;opacity:.75;margin-top:3px;line-height:1.35;}' +
      '.swpp-mapwrap{position:relative;flex:1;min-height:0;}' +
      '.swpp-map{position:absolute;inset:0;background:#1b2029;}' +
      '.swpp-pin{position:absolute;left:calc(50% - 17px);top:calc(50% - 46px);width:34px;height:46px;z-index:1000;pointer-events:none;}' +
      '.swpp-pin svg{position:absolute;left:0;top:0;width:34px;height:46px;display:block;filter:drop-shadow(0 3px 3px rgba(0,0,0,.45));transition:transform .15s ease;}' +
      '.swpp.moving .swpp-pin svg{transform:translateY(-8px);}' +
      '.swpp-pin i{position:absolute;left:12px;top:43px;width:10px;height:6px;border-radius:50%;background:rgba(0,0,0,.4);transition:transform .15s ease,opacity .15s;}' +
      '.swpp.moving .swpp-pin i{transform:scale(.6);opacity:.6;}' +
      '.swpp-fab{position:absolute;right:12px;z-index:1000;border:none;border-radius:12px;background:#fff;color:#222;font-weight:700;font-size:.78rem;padding:9px 11px;box-shadow:0 2px 8px rgba(0,0,0,.35);cursor:pointer;}' +
      '.swpp-sat{top:12px;}.swpp-me{top:56px;}' +
      '.swpp-hint{position:absolute;left:12px;right:70px;top:12px;z-index:1000;background:rgba(15,18,24,.85);border-radius:10px;padding:7px 10px;font-size:.76rem;line-height:1.3;pointer-events:none;}' +
      '.swpp-foot{padding:12px 14px calc(12px + env(safe-area-inset-bottom,0px));background:#161a22;border-top:1px solid rgba(255,255,255,.08);}' +
      '.swpp-info{font-size:.78rem;min-height:1.1em;margin-bottom:9px;opacity:.85;}' +
      '.swpp-info.warn{color:#ffb454;opacity:1;}' +
      '.swpp-you{background:#2b7fff;border:3px solid #fff;border-radius:50%;box-shadow:0 0 0 1px rgba(0,0,0,.25);}' +
      '.swpp-row{display:flex;gap:10px;}' +
      '.swpp-btn{flex:1;border-radius:12px;padding:13px;font-size:.95rem;font-weight:700;cursor:pointer;border:1.5px solid rgba(255,255,255,.25);background:transparent;color:#f2f2f2;}' +
      '.swpp-btn.go{flex:2;background:#F0A93B;border-color:#F0A93B;color:#1a1305;}' +
      '.swpp .leaflet-container, .swpp .maplibregl-map{font-family:inherit;background:#1b2029;}';
    document.head.appendChild(css);
  }

  var PIN_SVG = '<svg viewBox="0 0 34 46" xmlns="http://www.w3.org/2000/svg"><path d="M17 1C8.7 1 2 7.6 2 15.8 2 27 17 45 17 45s15-18 15-29.2C32 7.6 25.3 1 17 1z" fill="#e5383b" stroke="#fff" stroke-width="2.2"/><circle cx="17" cy="16" r="5.5" fill="#fff"/></svg>';

  var el = null, active = null;

  function buildDom() {
    if (el) return el;
    addStyles();
    el = document.createElement('div');
    el.className = 'swpp';
    el.innerHTML =
      '<div class="swpp-head"><div class="swpp-title">Confirm your delivery spot</div>' +
      '<div class="swpp-sub">Drag the map so the red pin sits right on your door or gate. Zoom in for a closer look.</div></div>' +
      '<div class="swpp-mapwrap"><div class="swpp-map"></div>' +
      '<div class="swpp-pin">' + PIN_SVG + '<i></i></div>' +
      '<button type="button" class="swpp-fab swpp-sat" data-a="sat">🛰️ Satellite</button>' +
      '<button type="button" class="swpp-fab swpp-me" data-a="me">📍 My spot</button>' +
      '</div>' +
      '<div class="swpp-foot"><div class="swpp-info"></div>' +
      '<div class="swpp-row"><button type="button" class="swpp-btn" data-a="cancel">Cancel</button>' +
      '<button type="button" class="swpp-btn go" data-a="ok">✅ Confirm this spot</button></div></div>';
    document.body.appendChild(el);
    return el;
  }

  function open(o) {
    o = o || {};
    if (active) return;
    var hasStart = typeof o.lat === 'number' && typeof o.lng === 'number' && isFinite(o.lat) && isFinite(o.lng);
    var start = hasStart ? [o.lat, o.lng] : KAMPALA;
    var startZoom = hasStart ? zoomFor(o.accuracy) : 12;
    active = { pending: true };

    ensureMapLayer().then(function (SM) {
      var root = buildDom();
      var mapDiv = root.querySelector('.swpp-map');
      var info = root.querySelector('.swpp-info');
      var satBtn = root.querySelector('[data-a="sat"]');
      var meBtn = root.querySelector('[data-a="me"]');
      var confirmed = false, closed = false, satellite = false;
      var map = null, ring = null, youDot = null;
      var locating = false, userMoved = false;

      // The blue dot: where the phone says the customer is right now.
      function showYou(lat, lng, acc) {
        if (!map) return;
        if (youDot) youDot.setLatLng([lat, lng]);
        else youDot = map.addMarker({ latlng: [lat, lng], html: '<div class="swpp-you" style="width:18px;height:18px;"></div>', size: [18, 18], z: -100, interactive: false });
        if (ring) { ring.remove(); ring = null; }
        if (acc > 0 && acc < 400) ring = map.addCircle([lat, lng], acc, { color: '#2b7fff', weight: 1, opacity: 0.6, fillOpacity: 0.1 });
      }

      // Finds the customer and zooms in on them. Used when there was no starting point, and by "My spot".
      function locateMe(centre) {
        if (!navigator.geolocation || locating) return;
        locating = true; readout();
        function got(pos, final) {
          if (!map) return;
          var lat = pos.coords.latitude, lng = pos.coords.longitude, acc = Math.round(pos.coords.accuracy || 0);
          o.lat = lat; o.lng = lng; o.accuracy = acc; hasStart = true; start = [lat, lng];
          meBtn.style.display = '';
          showYou(lat, lng, acc);
          if (centre && !userMoved) { map.setView(start, zoomFor(acc), { animate: true }); }
          if (final) locating = false;
          readout();
        }
        // A quick rough fix first (so the map jumps to the right neighbourhood at once), then a precise one.
        navigator.geolocation.getCurrentPosition(function (pos) { got(pos, false); fine(); }, function () { fine(); }, { enableHighAccuracy: false, maximumAge: 120000, timeout: 6000 });
        function fine() {
          navigator.geolocation.getCurrentPosition(function (pos) { got(pos, true); }, function () {
            locating = false; if (map) readout();
            if (!hasStart) info.textContent = 'Could not find your location. Move the map to your spot, or allow Location for this site.';
          }, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
        }
      }

      function cleanup() {
        if (closed) return;
        closed = true;
        active = null;
        document.removeEventListener('keydown', onKey, true);
        root.removeEventListener('click', onClick);
        if (map) { try { map.remove(); } catch (e) {} map = null; }
        mapDiv.innerHTML = '';
        root.classList.remove('open', 'moving');
        if (!confirmed && o.onCancel) { try { o.onCancel(); } catch (e) { console.error(e); } }
      }
      function close() {
        if (o.closeOverlay) o.closeOverlay(root); else cleanup();
        cleanup();       // idempotent: covers hosts that finish closing a moment later
      }

      function readout() {
        if (!map) return;
        var c = map.getCenter();
        if (!hasStart) {
          info.className = 'swpp-info';
          info.textContent = locating ? 'Finding where you are…' : 'Move the map until the pin is on your exact spot.';
          return;
        }
        var d = metres(o.lat, o.lng, c.lat, c.lng);
        if (d > FAR_WARNING_M) {
          info.className = 'swpp-info warn';
          info.textContent = 'This is ' + (d < 1000 ? Math.round(d / 10) * 10 + ' m' : (d / 1000).toFixed(1) + ' km') + ' from where your phone says you are. Make sure this is where we should deliver.';
        } else {
          info.className = 'swpp-info';
          info.textContent = d < 8 ? 'Pin is on your phone’s location.' : 'You moved the pin about ' + Math.round(d) + ' m from your phone’s location.';
        }
      }

      function onClick(e) {
        var b = e.target.closest ? e.target.closest('[data-a]') : null;
        if (!b) return;
        var a = b.getAttribute('data-a');
        if (a === 'cancel') { close(); return; }
        if (!map) return;                         // still starting up
        if (a === 'ok') {
          var c = map.getCenter();
          var moved = hasStart ? metres(o.lat, o.lng, c.lat, c.lng) : 0;
          confirmed = true;
          close();
          if (o.onConfirm) { try { o.onConfirm(c.lat, c.lng, { moved: moved }); } catch (err) { console.error(err); } }
          return;
        }
        if (a === 'sat') {
          satellite = !satellite;
          map.setSatellite(satellite);
          satBtn.textContent = satellite ? '🗺️ Streets' : '🛰️ Satellite';
          return;
        }
        if (a === 'me') { userMoved = false; if (hasStart) map.setView(start, Math.max(map.getZoom(), zoomFor(o.accuracy)), { animate: true }); locateMe(true); }
      }
      function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); close(); } }

      meBtn.style.display = '';
      satBtn.textContent = '🛰️ Satellite';
      info.className = 'swpp-info';
      info.textContent = 'Loading the map…';

      // Show it first (through the page's own overlay handling when given, so the phone's
      // Back button closes just this map), because the map needs a visible box to measure.
      if (o.openOverlay) o.openOverlay(root, cleanup); else root.classList.add('open');
      root.addEventListener('click', onClick);
      document.addEventListener('keydown', onKey, true);
      active = { close: close };

      SM.create(mapDiv, { center: start, zoom: startZoom, zoomControl: true, zoomPosition: 'bottomright', layerToggle: false }).then(function (M) {
        if (closed) { M.remove(); return; }       // closed again before the map was ready
        map = M;
        root.setAttribute('data-engine', M.kind);
        if (hasStart) showYou(o.lat, o.lng, o.accuracy);
        map.on('dragstart', function () { userMoved = true; });
        // Any touch on the map also means "I'm placing it myself": don't re-centre on a later, more precise reading.
        ['touchstart', 'mousedown', 'wheel'].forEach(function (ev) { mapDiv.addEventListener(ev, function () { userMoved = true; }, { passive: true }); });
        map.on('movestart', function () { root.classList.add('moving'); });
        map.on('moveend', function () { root.classList.remove('moving'); readout(); });
        readout();
        setTimeout(function () { if (map) { map.invalidateSize(); map.setView(start, startZoom); readout(); } }, 80);
        if (!hasStart) locateMe(true);
      }).catch(function (e) {
        console.warn('[pin-picker] map unavailable:', e && e.message);
        if (!closed) { confirmed = true; close(); }   // nothing to confirm: close quietly, then let the caller carry on
        if (o.onUnavailable) { try { o.onUnavailable(); } catch (err) { console.error(err); } }
      });
    }).catch(function (e) {
      active = null;
      console.warn('[pin-picker] map unavailable:', e && e.message);
      if (o.onUnavailable) { try { o.onUnavailable(); } catch (err) { console.error(err); } }
    });
  }

  window.SwiftPinPicker = { open: open };
})();
