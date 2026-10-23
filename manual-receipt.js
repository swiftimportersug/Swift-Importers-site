/*
 * Swift Importers — manual receipt creator (manual-receipt.js)
 * Lets the admin/employee apps issue a receipt for a sale that didn't come through the storefront
 * cart (a counter sale, a phone order settled on the spot, etc.), using the exact same receipt
 * template, numbering and sharing as every other receipt (see receipt.js). It is saved in its own
 * "manual_receipts" collection — never "orders" — so it never touches stock, boda alerts, or the
 * open/closed orders lists.
 *
 * Needs receipt.js loaded first. Public API: window.ManualReceipt.open()
 */
(function () {
  'use strict';

  var TRANSPORT_OPTIONS = [
    { value: '', label: 'No delivery charge' },
    { value: 'boda', label: 'Boda' },
    { value: 'taxi', label: 'Taxi' },
    { value: 'bus', label: 'Bus' },
    { value: 'courier', label: 'Courier' },
    { value: 'van', label: 'Delivery Van' }
  ];

  var root = null, rowSeq = 0;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fmt(n) { return 'UGX ' + (Math.round(Number(n) || 0)).toLocaleString('en-UG'); }
  function toast(msg, kind) { try { if (window.showToast) window.showToast(msg, kind || 'success'); else if (window.showSuccessToast) window.showSuccessToast(msg); } catch (e) {} }

  function injectCss() {
    if (document.getElementById('mr-css')) return;
    var st = document.createElement('style'); st.id = 'mr-css';
    st.textContent =
      '#mr-modal{position:fixed;inset:0;z-index:100000;background:rgba(10,12,20,.72);display:none;align-items:flex-end;justify-content:center;}' +
      '#mr-modal.open{display:flex;}' +
      '#mr-box{background:#fff;width:100%;max-width:560px;max-height:94vh;border-radius:18px 18px 0 0;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 -10px 40px rgba(0,0,0,.35);}' +
      '#mr-head{display:flex;align-items:center;justify-content:space-between;padding:14px 16px 10px;border-bottom:1px solid #eee;font:800 1rem system-ui,sans-serif;color:#012e7b;}' +
      '#mr-head button{border:0;background:#f1f1f1;border-radius:50%;width:32px;height:32px;font-size:1rem;cursor:pointer;}' +
      '#mr-body{overflow:auto;padding:14px 16px;background:#fff;flex:1;font-family:system-ui,sans-serif;}' +
      '.mr-label{font-size:.74rem;font-weight:700;color:#666;margin:12px 0 5px;}' +
      '.mr-sublabel{font-size:.68rem;font-weight:600;color:#999;margin:6px 0 3px;}' +
      '.mr-input{width:100%;padding:10px 12px;border:1.5px solid #ddd;border-radius:8px;font-size:.88rem;box-sizing:border-box;}' +
      '.mr-card{border:1.5px solid #e8e8ec;border-radius:10px;padding:10px;margin-bottom:8px;background:#fafbfc;}' +
      '.mr-row{display:flex;gap:6px;align-items:center;}' +
      '.mr-row input{flex:1;min-width:0;}' +
      '.mr-row button{flex:0 0 auto;border:0;background:#fdeaea;color:#b03030;border-radius:8px;width:34px;height:34px;font-size:1rem;cursor:pointer;}' +
      '.mr-nums{display:grid;grid-template-columns:1fr 1.3fr 1.3fr;gap:6px;margin-top:6px;}' +
      '.mr-nums div{font-size:.66rem;font-weight:700;color:#999;margin-bottom:2px;}' +
      '#mr-add{margin-top:4px;border:1.5px dashed #bbb;background:#fafafa;color:#555;border-radius:8px;padding:9px;font-weight:700;font-size:.8rem;cursor:pointer;width:100%;}' +
      '#mr-total{margin-top:14px;padding-top:12px;border-top:1px solid #eee;text-align:right;font-weight:800;font-size:1rem;color:#012e7b;}' +
      '#mr-actions{padding:12px 16px calc(12px + env(safe-area-inset-bottom,0px));border-top:1px solid #eee;background:#fff;}' +
      '#mr-create{width:100%;border:0;border-radius:10px;padding:13px;background:#012e7b;color:#fff;font-weight:800;font-size:.9rem;cursor:pointer;}' +
      '#mr-create:disabled{opacity:.55;}' +
      '#mr-err{color:#b03030;font-size:.8rem;font-weight:600;margin-top:8px;display:none;}' +
      '.mr-grid2{display:grid;grid-template-columns:1fr 1fr;gap:8px;}';
    document.head.appendChild(st);
  }

  function rowHtml(id) {
    return '<div class="mr-card" data-row="' + id + '">' +
      '<div class="mr-row">' +
        '<input class="mr-input" placeholder="Item name" id="mr-name-' + id + '"/>' +
        '<button type="button" title="Remove" onclick="ManualReceipt.removeRow(' + id + ')">✕</button>' +
      '</div>' +
      '<div class="mr-sublabel">Small text under the name (optional — leave blank for the usual auto one)</div>' +
      '<input class="mr-input" placeholder="e.g. In-Ear Monitors" id="mr-desc-' + id + '"/>' +
      '<div class="mr-nums">' +
        '<div><div>Qty</div><input class="mr-input" type="number" min="1" value="1" id="mr-qty-' + id + '"/></div>' +
        '<div><div>Unit price</div><input class="mr-input" type="number" min="0" placeholder="0" id="mr-unit-' + id + '"/></div>' +
        '<div><div>Price paid (per item)</div><input class="mr-input" type="number" min="0" placeholder="same as unit price" id="mr-paid-' + id + '"/></div>' +
      '</div>' +
    '</div>';
  }

  function build() {
    if (root) return;
    injectCss();
    root = document.createElement('div');
    root.id = 'mr-modal';
    root.innerHTML =
      '<div id="mr-box">' +
        '<div id="mr-head"><span>🧾 Manual Receipt</span><button onclick="ManualReceipt.close()">✕</button></div>' +
        '<div id="mr-body">' +
          '<div class="mr-grid2">' +
            '<div><div class="mr-label">Customer name</div><input class="mr-input" id="mr-customer" placeholder="Customer name"/></div>' +
            '<div><div class="mr-label">Phone (optional, for WhatsApp)</div><input class="mr-input" id="mr-phone" placeholder="07XXXXXXXX"/></div>' +
          '</div>' +
          '<div class="mr-label">Items</div>' +
          '<div id="mr-rows"></div>' +
          '<button type="button" id="mr-add">+ Add item</button>' +
          '<div class="mr-grid2" style="margin-top:14px;">' +
            '<div><div class="mr-label">Delivery</div><select class="mr-input" id="mr-transport-type"></select></div>' +
            '<div><div class="mr-label">Delivery fee</div><input class="mr-input" type="number" min="0" id="mr-transport-amount" placeholder="0"/></div>' +
          '</div>' +
          '<div id="mr-total">Total: UGX 0</div>' +
          '<div id="mr-err"></div>' +
        '</div>' +
        '<div id="mr-actions"><button id="mr-create">Create Receipt</button></div>' +
      '</div>';
    document.body.appendChild(root);
    root.addEventListener('click', function (e) { if (e.target === root) close(); });
    var sel = document.getElementById('mr-transport-type');
    sel.innerHTML = TRANSPORT_OPTIONS.map(function (o) { return '<option value="' + o.value + '">' + esc(o.label) + '</option>'; }).join('');
    document.getElementById('mr-add').onclick = function () { addRow(); recalc(); };
    document.getElementById('mr-create').onclick = create;
    document.getElementById('mr-body').addEventListener('input', recalc);
  }

  function addRow() {
    rowSeq++;
    document.getElementById('mr-rows').insertAdjacentHTML('beforeend', rowHtml(rowSeq));
    return rowSeq;
  }
  function removeRow(id) {
    var el = document.querySelector('[data-row="' + id + '"]');
    if (el) el.remove();
    recalc();
  }

  function readRows() {
    var out = [];
    document.querySelectorAll('#mr-rows [data-row]').forEach(function (el) {
      var id = el.getAttribute('data-row');
      var name = (document.getElementById('mr-name-' + id) || {}).value || '';
      var desc = (document.getElementById('mr-desc-' + id) || {}).value || '';
      var qty = Number((document.getElementById('mr-qty-' + id) || {}).value) || 1;
      var unit = Number((document.getElementById('mr-unit-' + id) || {}).value) || 0;
      var paidRaw = (document.getElementById('mr-paid-' + id) || {}).value;
      if (name.trim()) out.push({ name: name.trim(), desc: desc.trim(), qty: qty, unit: unit, paid: (paidRaw === '' || paidRaw == null) ? null : Number(paidRaw) });
    });
    return out;
  }
  // "Price paid" is PER ITEM, same as unit price — it defaults to the unit price when left blank,
  // and the line's total is always (price paid × qty). Fill it in only to record a discount.
  function lineTotal(it) {
    var qty = Math.max(1, Math.round(it.qty));
    var paidPerUnit = (it.paid != null && !isNaN(it.paid)) ? Math.max(0, it.paid) : Math.max(0, it.unit);
    return paidPerUnit * qty;
  }
  function recalc() {
    var items = readRows();
    var sum = items.reduce(function (s, it) { return s + lineTotal(it); }, 0);
    var fee = Number((document.getElementById('mr-transport-amount') || {}).value) || 0;
    var t = document.getElementById('mr-total');
    if (t) t.textContent = 'Total: ' + fmt(sum + fee);
  }

  function resetForm() {
    document.getElementById('mr-customer').value = '';
    document.getElementById('mr-phone').value = '';
    document.getElementById('mr-transport-type').value = '';
    document.getElementById('mr-transport-amount').value = '';
    document.getElementById('mr-rows').innerHTML = '';
    document.getElementById('mr-err').style.display = 'none';
    rowSeq = 0;
    addRow();
    recalc();
  }

  function open() {
    build();
    resetForm();
    root.classList.add('open');
  }
  function close() { if (root) root.classList.remove('open'); }

  function showError(msg) {
    var e = document.getElementById('mr-err');
    e.textContent = msg; e.style.display = 'block';
  }

  function create() {
    if (!window.SwiftReceipt) { showError('Receipt system not ready — reload the page and try again.'); return; }
    var customerName = document.getElementById('mr-customer').value.trim();
    var phone = document.getElementById('mr-phone').value.trim();
    var items = readRows();
    var transportType = document.getElementById('mr-transport-type').value;
    var transportAmount = Number(document.getElementById('mr-transport-amount').value) || 0;
    if (!items.length) { showError('Add at least one item with a name.'); return; }
    if (items.some(function (it) { return it.unit <= 0; })) { showError('Every item needs a unit price above 0.'); return; }

    document.getElementById('mr-err').style.display = 'none';
    var btn = document.getElementById('mr-create');
    btn.disabled = true; btn.textContent = 'Creating…';
    window.SwiftReceipt.createManual({
      customerName: customerName, phone: phone, items: items,
      transportType: transportType, transportAmount: transportAmount
    }).then(function (r) {
      btn.disabled = false; btn.textContent = 'Create Receipt';
      close();
      toast('🧾 Receipt #' + r.snap.no + ' created');
      window.SwiftReceipt.openModal(r.id, { customerName: customerName, phone: phone }, []);
    }).catch(function (e) {
      btn.disabled = false; btn.textContent = 'Create Receipt';
      showError('Could not create the receipt: ' + (e && e.message || e));
    });
  }

  window.ManualReceipt = { open: open, close: close, removeRow: removeRow };
})();
