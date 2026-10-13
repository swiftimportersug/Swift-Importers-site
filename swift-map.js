/*
 * Swift Importers — shared map layer
 * ==================================
 * One small wrapper that gives the live rider map (rider-map.js) and the "confirm my
 * pin" map (pin-picker.js) the same map to draw on:
 *
 *   - MapLibre GL JS with free OpenFreeMap vector tiles: sharp at every zoom, modern
 *     colours, smooth zooming. Used whenever the phone supports WebGL.
 *   - Leaflet + OpenStreetMap pictures as a safety net: used automatically when WebGL is
 *     missing (some old phones), or the vector map cannot start (library or tile service
 *     unreachable). The page looks like it did before, and keeps working.
 *
 * Add  ?map=leaflet  to any page address to force the old map, or  ?map=vector  to insist
 * on the new one (handy when checking which one is showing).
 *
 * Usage:
 *     SwiftMap.create(containerEl, { center: [lat, lng], zoom: 15, zoomControl: true,
 *                                    zoomPosition: 'topleft' | 'bottomright' })
 *       .then(function (map) { ... });
 *
 * Everything takes and returns [lat, lng]. Zoom numbers are "Leaflet-style" (street level
 * is about 17-18) for both engines, so callers never need to care which one is running.
 *
 *   map.kind                                  'vector' | 'leaflet'
 *   map.setView([lat,lng], zoom, {animate, duration})
 *   map.getCenter() -> {lat, lng}             map.getZoom()
 *   map.fitBounds([[lat,lng],...], {padding, maxZoom, animate, duration})
 *   map.panInside([lat,lng], {padding:[x,y]}) nudge the map only if the point nears the edge
 *   map.insideView([lat,lng], fraction)       is the point comfortably on screen?
 *   map.on(event, fn)                         'dragstart' | 'movestart' | 'moveend'
 *   map.addMarker({latlng, html, size:[w,h], z, interactive}) -> {setLatLng, getElement, setZ, remove}
 *   map.addLine(points, {color, weight, opacity, dash:[a,b], casing:{color,weight,opacity}}) -> {setLatLngs, remove}
 *   map.addCircle([lat,lng], radiusMetres, {color, weight, opacity, fillOpacity}) -> {setLatLng, setRadius, remove}
 *   map.setSatellite(true|false)              aerial photos instead of the street map
 *   map.invalidateSize()                      call after the container changes size
 *   map.remove()
 */
(function () {
  if (window.SwiftMap) return;

  var ML_VERSION = '4.1.3';   // 4.x keeps working on phones that only have WebGL 1
  var ML_CSS = 'https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/' + ML_VERSION + '/maplibre-gl.css';
  var ML_JS = 'https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/' + ML_VERSION + '/maplibre-gl.js';
  var LF_CSS = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css';
  var LF_JS = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';

  // Free vector map style and tiles from OpenFreeMap (OpenStreetMap data, no key needed).
  // Alternatives from the same service: /styles/bright and /styles/positron.
  var STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
  var STREET_RASTER = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  var SAT_TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
  var STYLE_TIMEOUT_MS = 8000;

  // ── loading helpers ──
  var cache = {};
  function loadLib(key, cssUrl, jsUrl, ready) {
    if (ready()) return Promise.resolve();
    if (cache[key]) return cache[key];
    cache[key] = new Promise(function (resolve, reject) {
      var css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = cssUrl;
      document.head.appendChild(css);
      var js = document.createElement('script');
      js.src = jsUrl;
      js.onload = function () { ready() ? resolve() : reject(new Error(key + ' did not load')); };
      js.onerror = function () { cache[key] = null; reject(new Error(key + ' failed to load')); };
      document.head.appendChild(js);
    });
    return cache[key];
  }
  function loadMapLibre() { return loadLib('maplibre', ML_CSS, ML_JS, function () { return !!(window.maplibregl && window.maplibregl.Map); }); }
  function loadLeaflet() { return loadLib('leaflet', LF_CSS, LF_JS, function () { return !!(window.L && window.L.map); }); }

  function webglOk() {
    try {
      var c = document.createElement('canvas');
      return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl')));
    } catch (e) { return false; }
  }
  function forcedEngine() {
    try { return new URLSearchParams(window.location.search).get('map'); } catch (e) { return null; }
  }

  // ── small geometry helpers (shared) ──
  function circlePolygon(lat, lng, radiusM) {
    var pts = [], n = 64, dLat = radiusM / 111320, dLng = radiusM / (111320 * Math.max(0.01, Math.cos(lat * Math.PI / 180)));
    for (var i = 0; i <= n; i++) {
      var a = (i / n) * 2 * Math.PI;
      pts.push([lng + dLng * Math.cos(a), lat + dLat * Math.sin(a)]);
    }
    return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [pts] } };
  }
  function lineFeature(points) {
    if (!points || points.length < 2) return { type: 'FeatureCollection', features: [] };
    return { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: points.map(function (p) { return [p[1], p[0]]; }) } };
  }
  function padNumber(p) { return Array.isArray(p) ? (p[0] || 0) : (typeof p === 'number' ? p : 0); }

  // ════════════════════════════════════════════════════════════════
  //  VECTOR (MapLibre GL JS)
  // ════════════════════════════════════════════════════════════════
  function createVector(el, opts) {
    return loadMapLibre().then(function () {
      var ml = window.maplibregl;
      return new Promise(function (resolve, reject) {
        var settled = false, map = null;
        function fail(err) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try { if (map) map.remove(); } catch (e) {}
          reject(err);
        }
        var timer = setTimeout(function () { fail(new Error('map style did not load in time')); }, STYLE_TIMEOUT_MS);
        try {
          var c = opts.center || [0.3476, 32.5825];
          map = new ml.Map({
            container: el,
            style: STYLE_URL,
            center: [c[1], c[0]],
            zoom: (opts.zoom || 15) - 1,
            attributionControl: false,
            dragRotate: false, pitchWithRotate: false, touchPitch: false, maxPitch: 0,
            fadeDuration: 120
          });
          map.addControl(new ml.AttributionControl({ compact: true }), 'bottom-right');
          if (map.touchZoomRotate && map.touchZoomRotate.disableRotation) map.touchZoomRotate.disableRotation();
          if (opts.zoomControl) {
            map.addControl(new ml.NavigationControl({ showCompass: false, visualizePitch: false }), opts.zoomPosition === 'bottomright' ? 'bottom-right' : 'top-left');
          }
        } catch (e) { fail(e); return; }

        map.on('error', function (ev) {
          // Before the style is ready any error means we cannot draw the map; afterwards a single failed tile is not worth giving up for.
          if (!settled && ev && ev.error && !map.isStyleLoaded()) {
            var msg = String(ev.error.message || ev.error);
            if (/style|Failed to fetch|NetworkError|Unauthorized|forbidden|404|403/i.test(msg)) fail(new Error(msg));
          }
        });
        map.on('load', ready);
        map.on('style.load', ready);
        function ready() {
          if (settled) return;
          if (!map.isStyleLoaded()) return;
          settled = true;
          clearTimeout(timer);
          resolve(wrapVector(map, el, ml));
        }
      });
    });
  }

  function wrapVector(map, el, ml) {
    var uid = 0;
    var baseLayers = (map.getStyle().layers || []).map(function (l) { return { id: l.id, type: l.type }; });
    var satOn = false;

    function addGeoSource(id, data) { map.addSource(id, { type: 'geojson', data: data }); }
    function setData(id, data) { var s = map.getSource(id); if (s && s.setData) s.setData(data); }

    var M = {
      kind: 'vector',
      container: el,
      setView: function (ll, z, o) {
        o = o || {};
        var target = { center: [ll[1], ll[0]] };
        if (z != null) target.zoom = z - 1;
        if (o.animate) { target.duration = o.duration ? o.duration * 1000 : 600; map.easeTo(target); }
        else map.jumpTo(target);
      },
      getCenter: function () { var c = map.getCenter(); return { lat: c.lat, lng: c.lng }; },
      getZoom: function () { return map.getZoom() + 1; },
      fitBounds: function (pts, o) {
        o = o || {};
        if (!pts || !pts.length) return;
        var minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
        pts.forEach(function (p) { minLat = Math.min(minLat, p[0]); maxLat = Math.max(maxLat, p[0]); minLng = Math.min(minLng, p[1]); maxLng = Math.max(maxLng, p[1]); });
        try {
          map.fitBounds([[minLng, minLat], [maxLng, maxLat]], {
            padding: padNumber(o.padding) || 40,
            maxZoom: (o.maxZoom || 18) - 1,
            animate: !!o.animate,
            duration: (o.duration || 1) * 1000
          });
        } catch (e) { M.setView([(minLat + maxLat) / 2, (minLng + maxLng) / 2], o.maxZoom || 16, { animate: !!o.animate }); }
      },
      panInside: function (ll, o) {
        var pad = (o && o.padding) || [60, 60];
        var p = map.project([ll[1], ll[0]]), w = el.clientWidth, h = el.clientHeight, dx = 0, dy = 0;
        if (p.x < pad[0]) dx = p.x - pad[0]; else if (p.x > w - pad[0]) dx = p.x - (w - pad[0]);
        if (p.y < pad[1]) dy = p.y - pad[1]; else if (p.y > h - pad[1]) dy = p.y - (h - pad[1]);
        if (dx || dy) map.panBy([dx, dy], { animate: false });
      },
      insideView: function (ll, frac) {
        var p = map.project([ll[1], ll[0]]), w = el.clientWidth, h = el.clientHeight, mx = w * (frac || 0), my = h * (frac || 0);
        return p.x >= mx && p.x <= w - mx && p.y >= my && p.y <= h - my;
      },
      on: function (ev, fn) { map.on(ev, fn); },
      addMarker: function (o) {
        var node = document.createElement('div');
        node.style.width = o.size[0] + 'px';
        node.style.height = o.size[1] + 'px';
        if (o.interactive === false) node.style.pointerEvents = 'none';
        if (o.z != null) node.style.zIndex = String(o.z);
        node.innerHTML = o.html;
        var marker = new ml.Marker({ element: node, anchor: 'center' }).setLngLat([o.latlng[1], o.latlng[0]]).addTo(map);
        return {
          setLatLng: function (ll) { marker.setLngLat([ll[1], ll[0]]); },
          getElement: function () { return node; },
          setZ: function (z) { node.style.zIndex = String(z); },
          remove: function () { marker.remove(); }
        };
      },
      addLine: function (points, st) {
        st = st || {};
        var id = 'swl' + (++uid), casingId = id + 'c';
        addGeoSource(id, lineFeature(points));
        var weight = st.weight || 4;
        if (st.casing) {
          map.addLayer({ id: casingId, type: 'line', source: id,
            layout: { 'line-cap': 'round', 'line-join': 'round' },
            paint: { 'line-color': st.casing.color || '#fff', 'line-width': st.casing.weight || weight + 3, 'line-opacity': st.casing.opacity != null ? st.casing.opacity : 0.9 } });
        }
        var paint = { 'line-color': st.color || '#F0A93B', 'line-width': weight, 'line-opacity': st.opacity != null ? st.opacity : 1 };
        if (st.dash) paint['line-dasharray'] = st.dash.map(function (v) { return v / weight; });
        map.addLayer({ id: id, type: 'line', source: id, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: paint });
        return {
          setLatLngs: function (p) { setData(id, lineFeature(p)); },
          remove: function () { try { if (map.getLayer(id)) map.removeLayer(id); if (map.getLayer(casingId)) map.removeLayer(casingId); if (map.getSource(id)) map.removeSource(id); } catch (e) {} }
        };
      },
      addCircle: function (ll, radius, st) {
        st = st || {};
        var id = 'swc' + (++uid);
        var cur = { lat: ll[0], lng: ll[1], r: radius };
        addGeoSource(id, circlePolygon(cur.lat, cur.lng, cur.r));
        map.addLayer({ id: id, type: 'fill', source: id, paint: { 'fill-color': st.color || '#F0A93B', 'fill-opacity': st.fillOpacity != null ? st.fillOpacity : 0.1 } });
        map.addLayer({ id: id + 'o', type: 'line', source: id, paint: { 'line-color': st.color || '#F0A93B', 'line-width': st.weight || 1, 'line-opacity': st.opacity != null ? st.opacity : 0.6 } });
        function redraw() { setData(id, circlePolygon(cur.lat, cur.lng, cur.r)); }
        return {
          setLatLng: function (p) { cur.lat = p[0]; cur.lng = p[1]; redraw(); },
          setRadius: function (r) { cur.r = r; redraw(); },
          remove: function () { try { if (map.getLayer(id + 'o')) map.removeLayer(id + 'o'); if (map.getLayer(id)) map.removeLayer(id); if (map.getSource(id)) map.removeSource(id); } catch (e) {} }
        };
      },
      setSatellite: function (on) {
        on = !!on;
        if (on === satOn) return;
        satOn = on;
        try {
          if (on && !map.getSource('swsat')) {
            map.addSource('swsat', { type: 'raster', tiles: [SAT_TILES], tileSize: 256, maxzoom: 19, attribution: 'Imagery © Esri' });
            var firstSymbol = baseLayers.filter(function (l) { return l.type === 'symbol'; })[0];
            map.addLayer({ id: 'swsat', type: 'raster', source: 'swsat' }, firstSymbol ? firstSymbol.id : undefined);
          }
          // Hide the street drawing (keeping road and place names on top of the photos).
          baseLayers.forEach(function (l) { if (l.type !== 'symbol') map.setLayoutProperty(l.id, 'visibility', on ? 'none' : 'visible'); });
          if (map.getLayer('swsat')) map.setLayoutProperty('swsat', 'visibility', on ? 'visible' : 'none');
        } catch (e) { console.warn('[swift-map] satellite switch failed:', e && e.message); }
      },
      invalidateSize: function () { try { map.resize(); } catch (e) {} },
      remove: function () { try { map.remove(); } catch (e) {} }
    };
    return M;
  }

  // ════════════════════════════════════════════════════════════════
  //  LEAFLET (safety net: the map as it was before)
  // ════════════════════════════════════════════════════════════════
  function createLeaflet(el, opts) {
    return loadLeaflet().then(function () {
      var L = window.L;
      var c = opts.center || [0.3476, 32.5825];
      var map = L.map(el, { zoomControl: false, attributionControl: true, maxZoom: 19, zoomSnap: 0.5 }).setView(c, opts.zoom || 15);
      if (opts.zoomControl) L.control.zoom({ position: opts.zoomPosition || 'topleft' }).addTo(map);
      var street = L.tileLayer(STREET_RASTER, { maxZoom: 19, attribution: '© OpenStreetMap contributors' }).addTo(map);
      var sat = L.tileLayer(SAT_TILES, { maxZoom: 19, attribution: 'Imagery © Esri' });
      var satOn = false;

      function strokeOpts(st, weight) {
        var o = { color: st.color || '#F0A93B', weight: weight, opacity: st.opacity != null ? st.opacity : 1, lineCap: 'round', lineJoin: 'round' };
        if (st.dash) o.dashArray = st.dash.join(' ');
        return o;
      }

      return {
        kind: 'leaflet',
        container: el,
        setView: function (ll, z, o) { map.setView(ll, z != null ? z : map.getZoom(), { animate: !!(o && o.animate) }); },
        getCenter: function () { var c2 = map.getCenter(); return { lat: c2.lat, lng: c2.lng }; },
        getZoom: function () { return map.getZoom(); },
        fitBounds: function (pts, o) {
          o = o || {};
          if (!pts || !pts.length) return;
          if (pts.length === 1) { map.setView(pts[0], Math.min(o.maxZoom || 16, 16), { animate: !!o.animate }); return; }
          map.fitBounds(pts, { padding: Array.isArray(o.padding) ? o.padding : [o.padding || 40, o.padding || 40], maxZoom: o.maxZoom || 18, animate: !!o.animate, duration: o.duration || 1 });
        },
        panInside: function (ll, o) { try { map.panInside(ll, { padding: (o && o.padding) || [60, 60], animate: false }); } catch (e) {} },
        insideView: function (ll, frac) { return map.getBounds().pad(-(frac || 0)).contains(ll); },
        on: function (ev, fn) { map.on(ev, fn); },
        addMarker: function (o) {
          var icon = L.divIcon({ className: '', html: o.html, iconSize: o.size, iconAnchor: [o.size[0] / 2, o.size[1] / 2] });
          var m = L.marker(o.latlng, { icon: icon, keyboard: false, interactive: o.interactive !== false, zIndexOffset: o.z || 0 }).addTo(map);
          return {
            setLatLng: function (ll) { m.setLatLng(ll); },
            getElement: function () { return m.getElement(); },
            setZ: function (z) { m.setZIndexOffset(z); },
            remove: function () { map.removeLayer(m); }
          };
        },
        addLine: function (points, st) {
          st = st || {};
          var weight = st.weight || 4;
          var casing = st.casing ? L.polyline(points, { color: st.casing.color || '#fff', weight: st.casing.weight || weight + 3, opacity: st.casing.opacity != null ? st.casing.opacity : 0.9, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(map) : null;
          var line = L.polyline(points, Object.assign(strokeOpts(st, weight), { interactive: false })).addTo(map);
          return {
            setLatLngs: function (p) { if (casing) casing.setLatLngs(p); line.setLatLngs(p); },
            remove: function () { if (casing) map.removeLayer(casing); map.removeLayer(line); }
          };
        },
        addCircle: function (ll, radius, st) {
          st = st || {};
          var circ = L.circle(ll, { radius: radius, color: st.color || '#F0A93B', weight: st.weight || 1, opacity: st.opacity != null ? st.opacity : 0.6, fillColor: st.color || '#F0A93B', fillOpacity: st.fillOpacity != null ? st.fillOpacity : 0.1, interactive: false }).addTo(map);
          return {
            setLatLng: function (p) { circ.setLatLng(p); },
            setRadius: function (r) { circ.setRadius(r); },
            remove: function () { map.removeLayer(circ); }
          };
        },
        setSatellite: function (on) {
          on = !!on;
          if (on === satOn) return;
          satOn = on;
          if (on) { map.removeLayer(street); sat.addTo(map); } else { map.removeLayer(sat); street.addTo(map); }
        },
        invalidateSize: function () { map.invalidateSize(); },
        remove: function () { try { map.remove(); } catch (e) {} }
      };
    });
  }

  // ════════════════════════════════════════════════════════════════
  //  public entry point
  // ════════════════════════════════════════════════════════════════
  function create(el, opts) {
    opts = opts || {};
    var forced = forcedEngine();
    if (forced !== 'leaflet' && webglOk()) {
      return createVector(el, opts).catch(function (err) {
        if (forced === 'vector') throw err;
        console.warn('[swift-map] vector map unavailable, using the classic map:', err && err.message);
        el.innerHTML = '';
        return createLeaflet(el, opts);
      });
    }
    return createLeaflet(el, opts);
  }

  window.SwiftMap = { create: create, _circlePolygon: circlePolygon };
})();
