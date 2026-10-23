/*
 * Swift Importers — receipt engine (receipt.js)
 *
 * Builds the receipt from the official template (Swift_Importers_Receipt_Template_2026.pdf):
 *   - static artwork (logos, RECEIPT/BILL TO/TOTAL headings, watermark, Thank you, terms)
 *     comes from /receipt-bg.jpg, the template with its editable parts blanked out;
 *   - every editable part is drawn as REAL text using the same fonts, sizes, colours and
 *     positions as the template (Helvetica, Times, Courier standard PDF fonts);
 *   - the PAID stamp is the template's own stamp (/receipt-stamp.jpg + /receipt-stamp-mask.jpg).
 *
 * Used by the admin app, the employee app and the public receipt page (/receipt/).
 * Public API: window.SwiftReceipt
 */
(function () {
  'use strict';

  var BASE = (location.protocol === 'http:' || location.protocol === 'https:') ? location.origin : 'https://swiftimporters.com';
  var ASSET_V = '?v=1';
  var PW = 595, PH = 842;
  var FIRST_NO = 3898;            // template shows #3897, so the first generated receipt is #3898
  var ROW_PITCH = 43.2;           // template spacing between rows
  var ROW_SPAN = 180;             // vertical room for rows (first name baseline to last name baseline)
  var MIN_SCALE = 0.45;            // smallest the rows are allowed to shrink
  var STAMP_OPACITY = 0.22;       // PAID stamp is faint so text can sit over it

  var GREY = [0.439216, 0.439216, 0.439216];
  var LGREY = [0.521569, 0.521569, 0.521569];
  var BLACK = [0, 0, 0];
  var NAVY = [0.003922, 0.113725, 0.341176];

  // ---------- small helpers ----------
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function fmtDate(d) { d = d || new Date(); return pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + '/' + d.getFullYear(); }
  function money(n) { n = Math.round(Number(n) || 0); return String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') ; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  // ---------- item name shortening (3-4 words max) ----------
  function shortName(name) {
    var s = String(name || '').replace(/\(.*?\)/g, ' ').replace(/\[.*?\]/g, ' ');
    s = s.split(/\s[-–—|:]\s|[,;|+\/]/)[0];
    s = s.split(/\s+(?:with|for|and|&|featuring|w\/)\s+/i)[0];
    var words = s.replace(/[^\w\s.'+#-]/g, ' ').split(/\s+/).filter(Boolean);
    if (words.length > 4) words = words.slice(0, 4);
    while (words.length > 1 && /^(with|for|and|the|a|an|of|-)$/i.test(words[words.length - 1])) words.pop();
    var out = words.join(' ').trim();
    if (!out) out = String(name || 'Item').trim().split(/\s+/).slice(0, 4).join(' ');
    return out;
  }

  // ---------- small description under the item name (from category / item type) ----------
  var CAT_DESC = {
    'smartphones': 'Smartphones', 'phones': 'Smartphones', 'laptops': 'Laptop Computers', 'tvs': 'Televisions',
    'audio': 'Audio Devices', 'printers': 'Printers', 'accessories': 'Accessories', 'cameras': 'Cameras',
    'home appliances': 'Home Appliances', 'other': 'General Items'
  };
  var KEYWORD_DESC = [
    [/\b(iem|iems|in[- ]?ear|earphone|earphones|earbud|earbuds)\b/i, 'In-Ear Monitors'],
    [/\b(headphones?|headsets?)\b/i, 'Headphones'],
    [/\b(speakers?|soundbars?|subwoofers?)\b/i, 'Speakers'],
    [/\b(microphones?|mics?)\b/i, 'Microphones'],
    [/\b(cables?|cords?|wires?|extensions?)\b/i, 'Cables & Cords'],
    [/\b(chargers?|adapters?|adaptors?)\b/i, 'Chargers & Adapters'],
    [/\bpower ?bank\b/i, 'Power Banks'],
    [/\b(cases?|covers?|protectors?)\b/i, 'Protective Cases'],
    [/\b(keyboards?|mouse|mice)\b/i, 'Computer Accessories'],
    [/\b(watch|watches|bands?)\b/i, 'Smart Wearables'],
    [/\b(printers?|toner|ink)\b/i, 'Printing']
  ];
  function describe(category, name) {
    var n = String(name || '');
    var cat = String(category || '').trim().toLowerCase();
    // category decides first for big-ticket categories; keywords refine audio/accessory items
    if (cat === 'smartphones' || cat === 'laptops' || cat === 'tvs' || cat === 'cameras' || cat === 'home appliances' || cat === 'printers') {
      return CAT_DESC[cat];
    }
    // accessories: cables/chargers/cases win over the product they go with (e.g. "IEMs Extensions 3 Meter Cables")
    if (cat === 'accessories' || cat === 'other' || !cat) {
      for (var j = 0; j < KEYWORD_DESC.length; j++) {
        if (KEYWORD_DESC[j][1] === 'Cables & Cords' || KEYWORD_DESC[j][1] === 'Chargers & Adapters' || KEYWORD_DESC[j][1] === 'Power Banks' || KEYWORD_DESC[j][1] === 'Protective Cases') {
          if (KEYWORD_DESC[j][0].test(n)) return KEYWORD_DESC[j][1];
        }
      }
    }
    for (var i = 0; i < KEYWORD_DESC.length; i++) if (KEYWORD_DESC[i][0].test(n)) return KEYWORD_DESC[i][1];
    if (CAT_DESC[cat]) return CAT_DESC[cat];
    return category ? String(category) : 'General Items';
  }

  // ---------- snapshot of an order (what the receipt shows) ----------
  var TRANSPORT_LABEL = { boda: 'Boda', taxi: 'Taxi', bus: 'Bus', courier: 'Courier', van: 'Delivery Van' };
  function buildSnapshot(order, products, meta) {
    order = order || {};
    meta = meta || {};
    products = products || [];
    var raw = Array.isArray(order.cartItems) ? order.cartItems.filter(function (c) { return c && c.name; }) : [];

    var discount = (Number(order.promoDiscount) || 0) + (Number(order.memberDiscount) || 0);
    if (!discount && order.pricing && Number(order.pricing.discount) > 0) discount = Number(order.pricing.discount);

    var anyLineTotal = raw.some(function (c) { return c.lineTotal != null; });
    var grossSum = raw.reduce(function (s, c) { return s + (Number(c.price) || 0) * (Number(c.qty) || 1); }, 0);
    var running = 0;
    var lines = raw.map(function (c, idx) {
      var qty = Math.max(1, Number(c.qty) || 1);
      var unit = Number(c.listPrice || c.price) || 0;      // price before any discount
      var gross = (Number(c.price) || 0) * qty;              // what the item cost after its own sale price
      var price;
      if (c.lineTotal != null) {
        price = Number(c.lineTotal) || 0;
      } else if (discount > 0 && grossSum > 0 && !anyLineTotal) {
        price = idx === raw.length - 1 ? Math.max(0, grossSum - discount - running) : Math.round(gross - discount * (gross / grossSum));
      } else {
        price = gross;
      }
      running += price;
      var prod = products.filter(function (p) { return p && p.id === c.id; })[0];
      var category = (prod && prod.category) || c.category || '';
      return { name: shortName(c.name), desc: describe(category, c.name), qty: qty, unit: Math.round(unit), price: Math.round(price) };
    });

    // orders saved without per-item prices (older converted import orders): fall back to the order total
    var priced = lines.reduce(function (x, l) { return x + l.price; }, 0);
    var orderAmt = Number(order.orderTotal || (order.pricing && order.pricing.total) || 0);
    if (lines.length && priced === 0 && orderAmt > 0) {
      var totalQty = lines.reduce(function (x, l) { return x + l.qty; }, 0) || 1;
      lines.forEach(function (l, i) { l.unit = Math.round(orderAmt / totalQty); l.price = i === lines.length - 1 ? orderAmt - lines.slice(0, i).reduce(function (x, y) { return x + y.price; }, 0) : l.unit * l.qty; });
    }
    if (!lines.length) {
      var amt = Number(order.orderTotal || (order.pricing && order.pricing.total) || order.amountPaid || 0);
      lines.push({ name: shortName(order.productsWanted || order.products || 'Order items'), desc: 'General Items', qty: 1, unit: Math.round(amt), price: Math.round(amt) });
    }

    var transports = transportsFor(order);
    var total = lines.reduce(function (s, l) { return s + l.price; }, 0) + sumAmounts(transports);

    return {
      no: meta.no || null,
      date: meta.date || fmtDate(new Date()),
      billTo: String(order.customerName || order.name || 'Customer').trim(),
      lines: lines, transports: transports, transport: transports[0] || null, total: total
    };
  }

  // Transport rows for the receipt, taken from the order's Delivery Info:
  //  - one transport:  "Transport" / "Boda delivery" (or Taxi / Bus delivery)
  //  - two transports (a boda takes it to a taxi/bus stage first): "Transport 1" Boda to taxi stage, "Transport 2" Taxi to customer
  function transportsFor(order) {
    var d = order && order.delivery, out = [];
    if (!d || d.type === 'selfpick') return out;
    var mode = TRANSPORT_LABEL[d.type] || 'Delivery';
    var fee = Math.round(Number(d.bodaFee) || 0), first = Math.round(Number(d.firstLegFee) || 0);
    var vehicle = d.type === 'taxi' || d.type === 'bus';
    if (first > 0 && vehicle) {
      out.push({ name: 'Transport 1', label: 'Boda to ' + mode.toLowerCase() + ' stage', amount: first });
      if (fee > 0) out.push({ name: 'Transport 2', label: mode + ' to customer', amount: fee });
    } else if (fee > 0) {
      out.push({ name: 'Transport', label: mode + ' delivery', amount: fee });
    }
    return out;
  }
  function sumAmounts(list) { return (list || []).reduce(function (x, t) { return x + (Number(t.amount) || 0); }, 0); }
  function snapTransports(snap) { return snap && (snap.transports || (snap.transport ? [snap.transport] : [])) || []; }
  function sameTransports(a, b) {
    var k = function (l) { return JSON.stringify((l || []).map(function (t) { return [t.name || '', t.label, Number(t.amount)]; })); };
    return k(a) === k(b);
  }
  // Keeps an already-issued receipt in step with the order's Delivery Info (receipt number and date never change).
  function syncTransport(docId, order) {
    var snap = order && order.receipt;
    if (!snap || !snap.no) return Promise.resolve(snap || null);
    var want = transportsFor(order);
    if (sameTransports(want, snapTransports(snap))) return Promise.resolve(snap);
    var total = (snap.lines || []).reduce(function (x, l) { return x + (Number(l.price) || 0); }, 0) + sumAmounts(want);
    snap.transports = want; snap.transport = want[0] || null; snap.total = total;
    var f = window.fbFns, db = window.fbDb;
    if (!f || !db || !f.updateDoc || !docId) return Promise.resolve(snap);
    return f.updateDoc(f.doc(db, 'orders', docId), { 'receipt.transports': want, 'receipt.transport': want[0] || null, 'receipt.total': total })
      .then(function () { return snap; })
      .catch(function (e) { console.warn('[receipt] could not update transport on the receipt', e); return snap; });
  }

  // ---------- font metrics (enough for right-aligning numbers & fitting names) ----------
  // Exact character widths (per 1000 units) of the standard PDF fonts, ASCII 32-126, so names are fitted
  // to the real width they will have on the page and can never run into the quantity.
  var AFM = {"F1":[278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584],"F2":[278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584],"F3":[250,333,408,500,500,833,778,180,333,333,500,564,250,333,250,278,500,500,500,500,500,500,500,500,500,500,278,278,564,564,564,444,921,722,667,667,722,611,556,722,722,333,389,722,611,889,722,722,556,722,667,556,611,722,722,944,722,722,611,333,278,333,469,500,333,444,500,444,500,444,333,500,500,278,278,500,278,778,500,500,500,500,333,389,278,500,500,722,500,500,444,480,200,480,541],"F4":[250,333,555,500,500,1000,833,278,333,333,500,570,250,333,250,278,500,500,500,500,500,500,500,500,500,500,333,333,570,570,570,500,930,722,667,722,722,667,611,778,778,389,500,778,667,944,722,778,611,778,722,556,667,722,722,1000,722,722,667,333,278,333,581,500,333,500,556,444,556,444,333,500,556,278,333,556,278,833,556,500,556,556,444,389,333,556,500,722,500,500,444,394,220,394,520]};
  function textWidth(font, size, str) {
    str = String(str);
    if (font === 'F5' || font === 'F6' || font === 'F7') return str.length * 0.6 * size;
    var tbl = AFM[font] || AFM.F1, w = 0;
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      w += (c >= 32 && c <= 126) ? tbl[c - 32] : 556;
    }
    return w * size / 1000;
  }

  // ---------- layout: list of drawing operations per page (PDF coordinates, origin bottom-left) ----------
  function layout(snap) {
    var rows = snap.lines.map(function (l) { return { kind: 'item', l: l }; });
    snapTransports(snap).forEach(function (t) { rows.push({ kind: 'transport', t: t }); });
    // Up to 5 rows use the template's own sizes. More rows -> every row shrinks so they all fit
    // on one page; only beyond what fits at the smallest size does it continue on a second page.
    var maxPerPage = Math.floor(ROW_SPAN / (ROW_PITCH * MIN_SCALE)) + 1;
    var n = Math.min(rows.length, maxPerPage);
    var scale = n <= 5 ? 1 : Math.max(MIN_SCALE, ROW_SPAN / (n - 1) / ROW_PITCH);
    var pages = [];
    for (var s = 0; s < rows.length; s += maxPerPage) pages.push(rows.slice(s, s + maxPerPage));
    if (!pages.length) pages.push([]);

    return pages.map(function (pageRows, pi) {
      var last = pi === pages.length - 1;
      var ops = [];
      function T(font, size, color, x, y, text, align) {
        text = String(text);
        if (align === 'r') x = x - textWidth(font, size, text);
        ops.push({ f: font, s: size, c: color, x: x, y: y, t: text });
      }
      // header values
      T('F2', 18, GREY, 56.7, 643.7, snap.billTo.length > 28 ? snap.billTo.slice(0, 28) : snap.billTo);
      T('F6', 12, GREY, 532, 665.8, snap.no != null ? snap.no : '', 'r');
      T('F6', 12, GREY, 531.4, 646.2, snap.date, 'r');

      pageRows.forEach(function (r, i) {
        var nb = 567.4 - ROW_PITCH * scale * i;               // name baseline
        var name, desc, unit, price, qty = null;
        if (r.kind === 'item') { name = r.l.name; desc = r.l.desc; unit = r.l.unit; price = r.l.price; qty = r.l.qty; }
        else { name = r.t.name || 'Transport'; desc = r.t.label; unit = r.t.amount; price = r.t.amount; }
        // bullet
        T('F1', 13 * scale, BLACK, 56.2, nb - 2 * scale, '°');
        // name (shrinks to fit the column before the quantity)
        var ns = Math.max(10, 22 * scale);
        while (ns > 9 && textWidth('F4', ns, name) > 176) ns -= 0.5;
        T('F4', ns, GREY, 66.2, nb, name);
        var ds = Math.max(7, 13 * scale);
        while (ds > 6 && textWidth('F3', ds, desc) > 156) ds -= 0.5;
        T('F3', ds, GREY, 83.5, nb - 11.3 * scale, desc);
        if (qty != null) T('F7', Math.max(9, 18 * scale), GREY, 248.8, nb + 2.6 * scale, 'X' + qty);
        T('F5', Math.max(7, 11 * scale), LGREY, 320.5, nb + 5.1 * scale, money(unit));
        T('F1', Math.max(10, 18 * scale), BLACK, 533, nb + 1.7 * scale, money(price), 'r');
      });

      if (last) {
        var big = money(snap.total) + '.';
        var ts = 24;                                   // shrink a very large total so it never touches the TOTAL label
        while (ts > 12 && textWidth('F2', ts, big) > 92) ts -= 0.5;
        T('F2', ts, NAVY, 529.2, 350.3, big, 'r');
        T('F1', ts * 0.625, NAVY, 529.8, 350.3, '0');
      }
      return { ops: ops, stamp: last };
    });
  }

  // ---------- assets ----------
  var assetCache = {};
  function fetchBytes(path) {
    if (!assetCache[path]) {
      assetCache[path] = fetch(BASE + path + ASSET_V).then(function (r) {
        if (!r.ok) throw new Error('Receipt asset missing: ' + path);
        return r.arrayBuffer();
      }).then(function (b) { return new Uint8Array(b); });
    }
    return assetCache[path];
  }
  var imgCache = {};
  function loadImg(path) {
    if (!imgCache[path]) {
      imgCache[path] = new Promise(function (res, rej) {
        var im = new Image();
        im.onload = function () { res(im); };
        im.onerror = function () { rej(new Error('Receipt image failed: ' + path)); };
        im.src = BASE + path + ASSET_V;
      });
    }
    return imgCache[path];
  }

  // ---------- canvas preview ----------
  var CANVAS_FONT = {
    F1: 'Helvetica, Arial, sans-serif', F2: 'bold Helvetica, Arial, sans-serif',
    F3: 'Times New Roman, Times, serif', F4: 'bold Times New Roman, Times, serif',
    F5: 'Courier New, Courier, monospace', F6: 'bold Courier New, Courier, monospace',
    F7: 'italic Courier New, Courier, monospace'
  };
  function canvasFont(f, size) {
    var fam = CANVAS_FONT[f], m = fam.match(/^(bold |italic )?(.*)$/);
    return (m[1] || '') + size + 'px ' + m[2];
  }
  function rgb(c) { return 'rgb(' + Math.round(c[0] * 255) + ',' + Math.round(c[1] * 255) + ',' + Math.round(c[2] * 255) + ')'; }

  function renderPage(snap, pageIndex, widthPx) {
    var pages = layout(snap), pg = pages[pageIndex || 0];
    var k = (widthPx || 900) / PW;
    return Promise.all([loadImg('/receipt-bg.jpg'), pg.stamp ? loadImg('/receipt-stamp.jpg') : null, pg.stamp ? loadImg('/receipt-stamp-mask.jpg') : null]).then(function (a) {
      var cv = document.createElement('canvas');
      cv.width = Math.round(PW * k); cv.height = Math.round(PH * k);
      var c = cv.getContext('2d');
      c.fillStyle = '#fff'; c.fillRect(0, 0, cv.width, cv.height);
      c.drawImage(a[0], 0, 0, cv.width, cv.height);
      if (pg.stamp && a[1] && a[2]) {
        var sw = Math.round(216 * k), sh = Math.round(106.6 * k), sx = 189.7 * k, sy = (PH - 367.8 - 106.6) * k;
        var t = document.createElement('canvas'); t.width = sw; t.height = sh;
        var tc = t.getContext('2d');
        tc.drawImage(a[1], 0, 0, sw, sh);
        var col = tc.getImageData(0, 0, sw, sh);
        var m = document.createElement('canvas'); m.width = sw; m.height = sh;
        var mc = m.getContext('2d'); mc.drawImage(a[2], 0, 0, sw, sh);
        var md = mc.getImageData(0, 0, sw, sh).data;
        for (var i = 0; i < col.data.length; i += 4) col.data[i + 3] = md[i];
        tc.putImageData(col, 0, 0);
        c.globalAlpha = STAMP_OPACITY;
        c.drawImage(t, sx, sy);
        c.globalAlpha = 1;
      }
      pg.ops.forEach(function (o) {
        c.font = canvasFont(o.f, o.s * k);
        c.fillStyle = rgb(o.c);
        c.textBaseline = 'alphabetic';
        c.fillText(o.t, o.x * k, (PH - o.y) * k);
      });
      return cv;
    });
  }

  // ---------- PDF writer (vector text, standard fonts, embedded JPEG artwork) ----------
  function jpegSize(b) {
    var i = 2;
    while (i < b.length) {
      if (b[i] !== 0xFF) { i++; continue; }
      var mk = b[i + 1];
      if (mk >= 0xC0 && mk <= 0xCF && mk !== 0xC4 && mk !== 0xC8 && mk !== 0xCC) return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8] };
      i += 2 + ((b[i + 2] << 8) | b[i + 3]);
    }
    return { w: 1, h: 1 };
  }
  function latin1(s) {
    return String(s).replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')
      .replace(/[^\x20-\x7E -ÿ]/g, '?');
  }
  function pdfStr(s) { return '(' + latin1(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)') + ')'; }
  function enc(str) { var u = new Uint8Array(str.length); for (var i = 0; i < str.length; i++) u[i] = str.charCodeAt(i) & 255; return u; }
  function n3(v) { return (Math.round(v * 1000) / 1000).toString(); }

  var FONTS = { F1: 'Helvetica', F2: 'Helvetica-Bold', F3: 'Times-Roman', F4: 'Times-Bold', F5: 'Courier', F6: 'Courier-Bold', F7: 'Courier-Oblique' };

  function buildPdf(snap) {
    var pages = layout(snap);
    return Promise.all([fetchBytes('/receipt-bg.jpg'), fetchBytes('/receipt-stamp.jpg'), fetchBytes('/receipt-stamp-mask.jpg')]).then(function (a) {
      var bg = a[0], st = a[1], sm = a[2];
      var parts = [], offsets = [], len = 0;
      function push(x) { var u = typeof x === 'string' ? enc(x) : x; parts.push(u); len += u.length; }
      function obj(n, dictStr, streamBytes) {
        offsets[n] = len;
        push(n + ' 0 obj\n');
        if (streamBytes) { push(dictStr.replace('>>', '/Length ' + streamBytes.length + ' >>') + '\nstream\n'); push(streamBytes); push('\nendstream\nendobj\n'); }
        else push(dictStr + '\nendobj\n');
      }
      push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
      var nObjs = 12 + pages.length * 2;
      var kids = [];
      for (var p = 0; p < pages.length; p++) kids.push((14 + p * 2) + ' 0 R');
      obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
      obj(2, '<< /Type /Pages /Kids [' + kids.join(' ') + '] /Count ' + pages.length + ' >>');
      var fi = 3, fontRes = [];
      Object.keys(FONTS).forEach(function (k) {
        obj(fi, '<< /Type /Font /Subtype /Type1 /BaseFont /' + FONTS[k] + ' /Encoding /WinAnsiEncoding >>');
        fontRes.push('/' + k + ' ' + fi + ' 0 R'); fi++;
      });
      var bs = jpegSize(bg), ss = jpegSize(st);
      obj(10, '<< /Type /XObject /Subtype /Image /Width ' + bs.w + ' /Height ' + bs.h + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode >>', bg);
      obj(11, '<< /Type /XObject /Subtype /Image /Width ' + ss.w + ' /Height ' + ss.h + ' /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /DCTDecode >>', sm);
      obj(12, '<< /Type /XObject /Subtype /Image /Width ' + ss.w + ' /Height ' + ss.h + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /SMask 11 0 R >>', st);
      obj(13, '<< /Producer (Swift Importers) /Title (Swift Importers Receipt' + (snap.no ? ' #' + snap.no : '') + ') >>');
      pages.forEach(function (pg, i) {
        var cs = 'q ' + PW + ' 0 0 ' + PH + ' 0 0 cm /Bg Do Q\n';
        if (pg.stamp) cs += 'q /GS1 gs 216 0 0 106.6 189.7 367.8 cm /St Do Q\n';
        pg.ops.forEach(function (o) {
          cs += 'BT /' + o.f + ' ' + n3(o.s) + ' Tf ' + n3(o.c[0]) + ' ' + n3(o.c[1]) + ' ' + n3(o.c[2]) + ' rg 1 0 0 1 ' + n3(o.x) + ' ' + n3(o.y) + ' Tm ' + pdfStr(o.t) + ' Tj ET\n';
        });
        var cn = 14 + i * 2 + 1, pn = 14 + i * 2;
        obj(cn, '<< >>', enc(cs));
        obj(pn, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + PW + ' ' + PH + '] /Contents ' + cn + ' 0 R /Resources << /Font << ' + fontRes.join(' ') + ' >> /XObject << /Bg 10 0 R /St 12 0 R >> /ExtGState << /GS1 << /ca ' + STAMP_OPACITY + ' /CA ' + STAMP_OPACITY + ' >> >> >> >>');
      });
      var xref = len;
      push('xref\n0 ' + (nObjs + 2) + '\n0000000000 65535 f \n');
      for (var n = 1; n <= nObjs + 1; n++) {
        var off = offsets[n] != null ? offsets[n] : 0;
        push(('0000000000' + off).slice(-10) + ' 00000 n \n');
      }
      push('trailer\n<< /Size ' + (nObjs + 2) + ' /Root 1 0 R /Info 13 0 R >>\nstartxref\n' + xref + '\n%%EOF');
      return new Blob(parts, { type: 'application/pdf' });
    });
  }

  // ---------- manual receipts (not tied to a storefront order — a counter sale, a phone order, etc.) ----------
  // Stored in their own collection (never in "orders"), so they never touch stock, boda alerts, the
  // open/closed orders lists or finance totals. Still numbered from the exact same shared counter as
  // every other receipt, so numbers stay unique and sequential across the whole business.
  var MANUAL_PREFIX = 'm_';
  function isManualId(id) { return typeof id === 'string' && id.indexOf(MANUAL_PREFIX) === 0; }
  function randomManualId() {
    var chars = '0123456789abcdefghijklmnopqrstuvwxyz', out = MANUAL_PREFIX;
    for (var i = 0; i < 20; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
    return out;
  }
  // data = { customerName, phone, items:[{name, qty, unit}], transportType, transportAmount }
  function createManual(data) {
    data = data || {};
    var f = window.fbFns, db = window.fbDb;
    if (!f || !db || !f.runTransaction) return Promise.reject(new Error('Database not ready'));
    var items = (data.items || []).filter(function (it) { return it && String(it.name || '').trim(); });
    if (!items.length) return Promise.reject(new Error('Add at least one item'));
    var id = randomManualId();
    var manualRef = f.doc(db, 'manual_receipts', id);
    var counterRef = f.doc(db, 'counters', 'receipts');
    var customerName = String(data.customerName || '').trim() || 'Customer';
    var fakeOrder = {
      customerName: customerName,
      cartItems: items.map(function (it) {
        // price/listPrice are PER-UNIT (buildSnapshot multiplies by qty itself); lineTotal pins the
        // exact total so its own discount-splitting math is bypassed — there's no discount here.
        var qty = Math.max(1, Math.round(Number(it.qty) || 1)), unit = Math.max(0, Number(it.unit) || 0);
        return { name: it.name, qty: qty, price: unit, listPrice: unit, lineTotal: unit * qty };
      }),
      delivery: (Number(data.transportAmount) > 0) ? { type: data.transportType || 'courier', bodaFee: Number(data.transportAmount) } : null
    };
    return f.runTransaction(db, function (tx) {
      return tx.get(counterRef).then(function (cs) {
        var cd = cs.exists() ? cs.data() : null;
        var no = cd && cd.next ? cd.next : FIRST_NO;
        var snap = buildSnapshot(fakeOrder, [], { no: no, date: fmtDate(new Date()) });
        tx.set(counterRef, { next: no + 1, startedAt: (cd && cd.startedAt) || new Date().toISOString(), updatedAt: new Date().toISOString() });
        tx.set(manualRef, { receipt: snap, customerName: customerName, phone: String(data.phone || '').trim(), manual: true, createdAt: new Date().toISOString() });
        return { id: id, snap: snap };
      });
    });
  }
  function fetchManual(docId) {
    var f = window.fbFns, db = window.fbDb;
    if (!f || !db || !f.getDoc) return Promise.reject(new Error('Database not ready'));
    return f.getDoc(f.doc(db, 'manual_receipts', docId)).then(function (s) {
      var d = s.exists() ? s.data() : null;
      if (!d || !d.receipt || !d.receipt.no) throw new Error('This receipt is not available.');
      return { snap: d.receipt, order: { customerName: d.customerName, phone: d.phone } };
    });
  }

  // ---------- numbering + saving the receipt on the order ----------
  function isEligible(o) {
    if (!o || o.status === 'cancelled') return false;
    if (Number(o.balanceDue) > 0) return false;
    return o.paymentStatus === 'paid' || o.status === 'closed';
  }

  var onGenerated = null;
  function ensure(docId, order, products) {
    if (order && order.receipt && order.receipt.no) return Promise.resolve(order.receipt);
    var f = window.fbFns, db = window.fbDb;
    if (!f || !db || !f.runTransaction) return Promise.reject(new Error('Database not ready'));
    var orderRef = f.doc(db, 'orders', docId);
    var counterRef = f.doc(db, 'counters', 'receipts');
    // build the snapshot outside the transaction from the latest order we know
    return f.runTransaction(db, function (tx) {
      return tx.get(orderRef).then(function (os) {
        var o = os.data() || {};
        if (o.receipt && o.receipt.no) return o.receipt;
        return tx.get(counterRef).then(function (cs) {
          var cd = cs.exists() ? cs.data() : null;
          var no = cd && cd.next ? cd.next : FIRST_NO;
          var snap = buildSnapshot(o, products, { no: no, date: fmtDate(new Date()) });
          tx.set(counterRef, { next: no + 1, startedAt: (cd && cd.startedAt) || new Date().toISOString(), updatedAt: new Date().toISOString() });
          tx.update(orderRef, { receipt: snap });
          return snap;
        });
      });
    }).then(function (snap) {
      if (order) order.receipt = snap;
      if (typeof onGenerated === 'function') { try { onGenerated(snap, docId); } catch (e) {} }
      return snap;
    });
  }

  // Auto-generation: call with the full orders array (each with fbDocId) on every snapshot.
  var watchPrev = null, watchBusy = {}, watchStart = null;
  function watch(orders, products) {
    var f = window.fbFns, db = window.fbDb;
    if (!f || !db || !f.runTransaction || !Array.isArray(orders)) return;
    var first = watchPrev === null;
    var prev = watchPrev || {};
    var next = {};
    var todo = [];
    orders.forEach(function (o) {
      var el = isEligible(o);
      next[o.fbDocId] = el;
      if (!el || (o.receipt && o.receipt.no) || watchBusy[o.fbDocId]) return;
      var transitioned = !first && prev[o.fbDocId] !== true;     // became paid (or arrived paid) while we were watching
      if (transitioned) todo.push(o);
      else if (first) todo.push(o);                             // decide below against the go-live time
    });
    watchPrev = next;
    if (!todo.length) return;
    var gate = first ? f.getDoc(f.doc(db, 'counters', 'receipts')).then(function (s) { return s.exists() ? (s.data().startedAt || null) : null; }).catch(function () { return null; }) : Promise.resolve(null);
    gate.then(function (startedAt) {
      var chain = Promise.resolve();
      todo.forEach(function (o) {
        if (first) { if (!startedAt || !o.timestamp || o.timestamp < startedAt) return; }  // never back-fill history
        watchBusy[o.fbDocId] = true;
        chain = chain.then(function () { return ensure(o.fbDocId, o, products); })
          .catch(function (e) { console.warn('[receipt] auto-generate failed', e); })
          .then(function () { delete watchBusy[o.fbDocId]; });
      });
    });
  }

  // ---------- links, download, share ----------
  function link(docId) { return 'https://swiftimporters.com/receipt/?o=' + encodeURIComponent(docId); }
  function fileName(snap) { return 'Swift-Importers-Receipt-' + (snap.no || 'draft') + '.pdf'; }
  function isNative() { return !!(window.SwiftApp && window.SwiftApp.isNative) || !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()); }
  function isMobileWeb() { return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || ''); }
  function isInAppView() { return isNative() || /FBAN|FBAV|Instagram|WhatsApp|Line\/|MicroMessenger|; wv\)/i.test(navigator.userAgent || ''); }

  // Saves one or more files the way each kind of device can actually do it:
  //  1. inside our Android apps: the phone's share sheet (via app-bridge.js + the Filesystem/Share plugins)
  //  2. a phone's own browser: its share sheet if it can share files, else a normal download
  //  3. a computer: a normal download
  //  4. anywhere a download can't work (in-app browsers): a picture of the receipt to press-and-hold, plus the link
  function saveFiles(items, title, docId) {
    var A = window.SwiftApp;
    var viaApp = A && A.shareFiles ? A.shareFiles(items, title).catch(function () { return false; }) : Promise.resolve(false);
    return viaApp.then(function (done) {
      if (done) return true;
      if (isMobileWeb() && navigator.canShare && window.File) {
        try {
          var files = items.map(function (it) { return new File([it.blob], it.filename, { type: it.blob.type }); });
          if (navigator.canShare({ files: files })) {
            return navigator.share({ files: files, title: title }).then(function () { return true; }, function (e) { return !!(e && e.name === 'AbortError'); });
          }
        } catch (e) {}
      }
      return false;
    }).then(function (done) {
      if (done) return;
      items.forEach(function (it, i) {
        setTimeout(function () {
          var url = URL.createObjectURL(it.blob), a = document.createElement('a');
          a.href = url; a.download = it.filename; a.style.display = 'none'; document.body.appendChild(a); a.click();
          setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 8000);
        }, i * 400);
      });
      if (isInAppView()) showSaveHelp(items, docId);
    });
  }

  function showSaveHelp(items, docId) {
    var old = document.getElementById('sr-help'); if (old) old.remove();
    var url = docId ? link(docId) : '';
    var d = document.createElement('div');
    d.id = 'sr-help';
    d.style.cssText = 'position:fixed;inset:0;z-index:100002;background:rgba(10,12,20,.82);display:flex;align-items:center;justify-content:center;padding:16px;font-family:system-ui,sans-serif;';
    d.innerHTML = '<div style="background:#fff;border-radius:16px;max-width:420px;width:100%;max-height:90vh;overflow:auto;padding:18px;text-align:center;">' +
      '<div style="font-weight:800;color:#012e7b;font-size:1.05rem;margin-bottom:8px;">Saving needs your browser</div>' +
      '<div style="font-size:.84rem;color:#444;line-height:1.55;margin-bottom:12px;">This screen can\'t save files by itself. Copy the receipt link and open it in Chrome, then tap Download PDF there.</div>' +
      (url ? '<input readonly value="' + url + '" style="width:100%;padding:10px;border:1.5px solid #ccd;border-radius:8px;font-size:.78rem;text-align:center;margin-bottom:8px;" onfocus="this.select()"/>' +
        '<button id="sr-help-copy" style="width:100%;border:0;border-radius:10px;padding:12px;background:#012e7b;color:#fff;font-weight:800;margin-bottom:8px;">🔗 Copy link</button>' : '') +
      '<button id="sr-help-x" style="width:100%;border:0;border-radius:10px;padding:11px;background:#eee;color:#333;font-weight:700;">Close</button></div>';
    document.body.appendChild(d);
    d.querySelector('#sr-help-x').onclick = function () { d.remove(); };
    var c = d.querySelector('#sr-help-copy');
    if (c) c.onclick = function () {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(function () { c.textContent = '✓ Copied'; }, function () { d.querySelector('input').select(); });
      else d.querySelector('input').select();
    };
  }

  // The four buttons shared by the staff receipt window and the customer receipt page
  function actWhatsApp(order, snap, docId) {
    var url = waLink(order || {}, snap, docId);
    if (isNative()) window.location.href = url; else window.open(url, '_blank');
  }
  function actShare(snap, docId) {
    var text = 'Your Swift Importers receipt #' + snap.no;
    return shareText(text, text, link(docId));
  }
  function actCopy(docId) {
    var url = link(docId);
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(url).then(function () { toast('🔗 Receipt link copied'); }, function () { prompt('Copy this link', url); });
    prompt('Copy this link', url);
    return Promise.resolve();
  }

  // A small bar at the bottom: "Saved to Downloads — Open"
  function savedBar(saved) {
    var old = document.getElementById('sr-saved'); if (old) old.remove();
    var d = document.createElement('div');
    d.id = 'sr-saved';
    d.style.cssText = 'position:fixed;left:12px;right:12px;bottom:calc(16px + env(safe-area-inset-bottom,0px));z-index:100003;background:#1f2937;color:#fff;border-radius:12px;padding:12px 14px;display:flex;align-items:center;gap:10px;font:600 .85rem system-ui,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.4);';
    d.innerHTML = '<span style="flex:1;line-height:1.35;">✅ Saved to your Downloads folder<br><span style="font-weight:500;opacity:.8;font-size:.74rem;word-break:break-all;">' + esc(saved.name) + '</span></span>' +
      '<button id="sr-saved-open" style="border:0;border-radius:8px;padding:9px 14px;background:#25a244;color:#fff;font-weight:800;">Open</button>' +
      '<button id="sr-saved-x" style="border:0;background:none;color:#fff;font-size:1.1rem;padding:4px 6px;">✕</button>';
    document.body.appendChild(d);
    var close = function () { d.remove(); };
    d.querySelector('#sr-saved-x').onclick = close;
    d.querySelector('#sr-saved-open').onclick = function () { window.SwiftApp.openDownloaded(saved.uri, saved.mime).then(function (ok) { if (!ok) toast('No app found to open PDFs — find it in Files → Downloads'); }); };
    setTimeout(close, 9000);
  }

  function download(snap, docId) {
    return buildPdf(snap).then(function (blob) {
      var A = window.SwiftApp;
      // inside our app: a real download into the Downloads folder (share sheet only if that isn't available)
      if (A && A.saveToDownloads) {
        return A.saveToDownloads(blob, fileName(snap), 'application/pdf').then(function (saved) {
          if (saved) { savedBar(saved); return; }
          return saveFiles([{ blob: blob, filename: fileName(snap) }], 'Receipt #' + snap.no, docId);
        });
      }
      return saveFiles([{ blob: blob, filename: fileName(snap) }], 'Receipt #' + snap.no, docId);
    });
  }
  function canvasBlob(c) { return new Promise(function (res) { c.toBlob(function (b) { res(b); }, 'image/png'); }); }
  function saveImages(snap, docId) {
    var n = layout(snap).length, jobs = [];
    for (var i = 0; i < n; i++) jobs.push(renderPage(snap, i, 1100).then(canvasBlob));
    return Promise.all(jobs).then(function (blobs) {
      return saveFiles(blobs.map(function (b, i) {
        return { blob: b, filename: 'Swift-Importers-Receipt-' + snap.no + (n > 1 ? '-p' + (i + 1) : '') + '.png' };
      }), 'Receipt #' + snap.no, docId);
    });
  }
  // Share a link + message: the phone's share sheet (apps), the browser's, or WhatsApp's own page.
  function shareText(title, text, url, fallbackWa) {
    var A = window.SwiftApp;
    var app = A && A.shareText ? A.shareText(title, text, url).catch(function () { return false; }) : Promise.resolve(false);
    return app.then(function (done) {
      if (done) return;
      if (navigator.share) return navigator.share({ title: title, text: text, url: url }).catch(function () {});
      var wa = fallbackWa || ('https://wa.me/?text=' + encodeURIComponent(text + ' ' + url));
      if (isNative()) window.location.href = wa; else window.open(wa, '_blank');
    });
  }
  function waPhone(p) {
    var d = String(p || '').replace(/\D/g, '');
    if (!d) return '';
    if (d.indexOf('256') === 0) return d;
    if (d.charAt(0) === '0') return '256' + d.slice(1);
    return d;
  }
  function waLink(order, snap, docId) {
    var msg = 'Hello ' + (snap.billTo || '') + ', thank you for shopping with Swift Importers! 🧾 Here is your receipt #' + snap.no + ':\n' + link(docId);
    var ph = waPhone(order && order.phone);
    return 'https://wa.me/' + ph + '?text=' + encodeURIComponent(msg);
  }

  // ---------- modal UI (admin + employee) ----------
  var uiReady = false;
  function injectUi() {
    if (uiReady) return; uiReady = true;
    var st = document.createElement('style');
    st.textContent =
      '#sr-modal{position:fixed;inset:0;z-index:100000;background:rgba(10,12,20,.72);display:none;align-items:flex-end;justify-content:center;}' +
      '#sr-modal.open{display:flex;}' +
      '#sr-box{background:#fff;width:100%;max-width:560px;max-height:94vh;border-radius:18px 18px 0 0;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 -10px 40px rgba(0,0,0,.35);}' +
      '#sr-head{display:flex;align-items:center;justify-content:space-between;padding:calc(14px + var(--sat,0px) * 0) 16px 10px;border-bottom:1px solid #eee;font:800 1rem system-ui,sans-serif;color:#012e7b;}' +
      '#sr-head button{border:0;background:#f1f1f1;border-radius:50%;width:32px;height:32px;font-size:1rem;cursor:pointer;}' +
      '#sr-body{overflow:auto;padding:12px;background:#eef1f6;flex:1;}' +
      '#sr-body canvas{width:100%;height:auto;display:block;border-radius:6px;box-shadow:0 2px 12px rgba(0,0,0,.18);margin-bottom:10px;background:#fff;}' +
      '#sr-msg{padding:30px 10px;text-align:center;font:600 .9rem system-ui,sans-serif;color:#555;}' +
      '#sr-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:12px 12px calc(12px + var(--sab,0px));border-top:1px solid #eee;background:#fff;}' +
      '#sr-actions button{border:0;border-radius:10px;padding:12px 8px;font:800 .82rem system-ui,sans-serif;cursor:pointer;color:#fff;}' +
      '#sr-actions .a{background:#012e7b;}#sr-actions .b{background:#25a244;}#sr-actions .c{background:#555;}#sr-actions .d{background:#8a6fd6;}' +
      '#sr-actions button:disabled{opacity:.5;}';
    document.head.appendChild(st);
    var m = document.createElement('div');
    m.id = 'sr-modal';
    m.innerHTML = '<div id="sr-box"><div id="sr-head"><span id="sr-title">🧾 Receipt</span><button onclick="SwiftReceipt.closeModal()">✕</button></div><div id="sr-body"><div id="sr-msg">Preparing receipt…</div></div>' +
      '<div id="sr-actions"><button class="a" id="sr-dl">⬇️ Download PDF</button><button class="b" id="sr-wa">💬 Send on WhatsApp</button><button class="d" id="sr-share">📤 Share link</button><button class="c" id="sr-copy">🔗 Copy link</button></div></div>';
    m.addEventListener('click', function (e) { if (e.target === m) closeModal(); });
    document.body.appendChild(m);
  }
  function closeModal() { var m = document.getElementById('sr-modal'); if (m) m.classList.remove('open'); }
  function toast(msg) { try { if (typeof window.showSuccessToast === 'function') window.showSuccessToast(msg); else alert(msg); } catch (e) {} }

  function openModal(docId, order, products) {
    injectUi();
    var m = document.getElementById('sr-modal'), body = document.getElementById('sr-body');
    m.classList.add('open');
    body.innerHTML = '<div id="sr-msg">Preparing receipt…</div>';
    var btns = ['sr-dl', 'sr-wa', 'sr-share', 'sr-copy'].map(function (i) { var b = document.getElementById(i); b.disabled = true; return b; });
    var manual = isManualId(docId);
    var p = manual ? fetchManual(docId).then(function (r) { order = r.order; return r.snap; })
      : (order && order.receipt && order.receipt.no ? syncTransport(docId, order) : ensure(docId, order, products));
    return p.then(function (snap) {
      document.getElementById('sr-title').textContent = '🧾 Receipt #' + snap.no;
      var n = layout(snap).length, jobs = [];
      for (var i = 0; i < n; i++) jobs.push(renderPage(snap, i, 1000));
      return Promise.all(jobs).then(function (cvs) {
        body.innerHTML = '';
        cvs.forEach(function (c) { body.appendChild(c); });
        btns.forEach(function (b) { b.disabled = false; });
        document.getElementById('sr-dl').onclick = function () { download(snap, docId).catch(function (e) { toast('Could not create the PDF: ' + e.message); }); };
        document.getElementById('sr-wa').onclick = function () { actWhatsApp(order, snap, docId); };
        document.getElementById('sr-share').onclick = function () { actShare(snap, docId); };
        document.getElementById('sr-copy').onclick = function () { actCopy(docId); };
      });
    }).catch(function (e) {
      body.innerHTML = '<div id="sr-msg">Could not prepare the receipt.<br><small>' + esc(e && e.message) + '</small></div>';
      console.error('[receipt]', e);
    });
  }

  window.SwiftReceipt = {
    build: buildSnapshot, shortName: shortName, describe: describe, layout: layout,
    renderPage: renderPage, pdfBlob: buildPdf, pageCount: function (s) { return layout(s).length; },
    isEligible: isEligible, ensure: ensure, watch: watch, link: link, syncTransport: syncTransport, transportsFor: transportsFor, download: download, saveFiles: saveFiles, whatsapp: actWhatsApp, shareLink: actShare, copyLink: actCopy,
    openModal: openModal, closeModal: closeModal, fmtDate: fmtDate,
    setOnGenerated: function (fn) { onGenerated = fn; },
    createManual: createManual, isManualId: isManualId
  };
})();
