/*
 * swift-call.js — free internet (VoIP) voice calls inside the Swift apps.
 *
 *   Rider  → customer   (rider taps "Call (free)" on a delivery)
 *   Rider  → the shop   (rider taps "Call the shop"; every signed-in admin/employee rings, first to answer takes it)
 *
 * How it works: WebRTC carries the voice directly phone-to-phone. Firestore (collection "calls")
 * only passes the set-up messages. The Cloudflare Worker hands out relay (TURN) credentials for
 * the calls that cannot connect directly, and sends the "someone is calling" push notification.
 *
 * Document  calls/{id}   (id = the order's id for customer calls, a random id for shop calls)
 *   kind 'customer' | 'staff'      orderId, riderId, callerName, label (e.g. "Order #AB12")
 *   status 'preparing' → 'ringing' → 'active' → 'ended'   (or 'declined' / 'missed' / 'cancelled')
 *   offer / answer {type, sdp}     callerIce / calleeIce [ JSON strings ]     createdAt (ms)
 *
 * Public API
 *   SwiftCall.init({ workerUrl, key, role: 'rider'|'customer'|'staff', name })
 *   SwiftCall.supported()
 *   SwiftCall.callCustomer(order)        rider app
 *   SwiftCall.callShop(order)            rider app
 *   SwiftCall.watchOrders(orders)        customer pages: pass the customer's orders; rings for their rider
 *   SwiftCall.watchStaff()               admin / employee pages
 *   SwiftCall.stopWatching()
 */
(function () {
  'use strict';
  if (window.SwiftCall) return;

  var STUN_ONLY = [{ urls: 'stun:stun.cloudflare.com:3478' }, { urls: 'stun:stun.l.google.com:19302' }];
  var RING_TIMEOUT_MS = 45000;      // the caller gives up after this long
  var FRESH_MS = 45000;             // rings for 45 s, then stops by itself; a call older than this is ignored by the person being called
  var cfg = { workerUrl: '', key: '', role: '', name: '' };
  var cur = null;                   // the call in progress on this phone (only ever one)
  var watchers = {};                // customer: orderId -> unsubscribe
  var staffUnsub = null;
  var dismissed = {};               // call ids the person already declined/ignored on this page
  var ui = null;

  // ── tiny helpers ──
  function db() { return window.fbDb; }
  function fns() { return window.fbFns || {}; }
  function ref(id) { return fns().doc(db(), 'calls', id); }
  function now() { return Date.now(); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function rand(n) { var a = 'abcdefghijklmnopqrstuvwxyz0123456789', s = ''; for (var i = 0; i < n; i++) s += a.charAt(Math.floor(Math.random() * a.length)); return s; }
  function supported() { return !!(window.RTCPeerConnection && navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.fbDb && fns().doc && fns().onSnapshot); }
  function fmtTime(sec) { var m = Math.floor(sec / 60), s = sec % 60; return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s; }
  function toast(msg) {
    try { if (typeof window.showToast === 'function') { window.showToast(msg); return; } } catch (e) {}
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;left:50%;bottom:90px;transform:translateX(-50%);background:#222;color:#fff;padding:10px 16px;border-radius:12px;font:600 14px system-ui,sans-serif;z-index:100001;max-width:86vw;text-align:center;';
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 3500);
  }

  // ── sounds: our three-bell chime for an incoming call, a soft double tone while we wait ──
  var actx = null, ringTimer = null;
  function audioCtx() {
    try {
      if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
    } catch (e) { actx = null; }
    return actx;
  }
  function bell(ctx, freq, start, dur, gain) {
    var parts = [[1, 1, 1], [2, 0.45, 0.7], [2.76, 0.3, 0.5], [4.07, 0.14, 0.35], [0.5, 0.25, 1.3]];
    parts.forEach(function (p) {
      var o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = freq * p[0];
      var t0 = ctx.currentTime + start, peak = gain * p[1] * 0.5;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(peak, t0 + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur * p[2]);
      o.connect(g); g.connect(ctx.destination);
      o.start(t0); o.stop(t0 + dur * p[2] + 0.05);
    });
  }
  // Incoming-call ring: the Swift Importers call tone (/sounds/swift-call.mp3), looped. The synthesized bells are a fallback.
  var callAudio = null;
  function startCallTone() {
    try {
      if (!callAudio) { callAudio = new Audio('/sounds/swift-call.mp3'); callAudio.loop = true; }
      callAudio.currentTime = 0;
      var p = callAudio.play();
      if (p && p.catch) p.catch(function () { synthChime(); });
      return true;
    } catch (e) { return false; }
  }
  function stopCallTone() { try { if (callAudio) callAudio.pause(); } catch (e) {} }
  function playChime() { if (callAudio && !callAudio.paused) return; synthChime(); }
  function synthChime() { var c = audioCtx(); if (!c) return; bell(c, 784, 0, 1.1, 0.9); bell(c, 1046.5, 0.3, 1.1, 0.9); bell(c, 1318.5, 0.6, 1.6, 0.9); }
  function playRingback() {
    var c = audioCtx(); if (!c) return;
    [0, 0.45].forEach(function (s) {
      var o = c.createOscillator(), g = c.createGain();
      o.type = 'sine'; o.frequency.value = 440;
      var t0 = c.currentTime + s;
      g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.18, t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.36);
      o.connect(g); g.connect(c.destination); o.start(t0); o.stop(t0 + 0.4);
    });
  }
  function startRinging(kind) {
    stopRinging();
    var fn = kind === 'incoming' ? playChime : playRingback, every = kind === 'incoming' ? 2800 : 3200;
    if (kind === 'incoming') { if (!startCallTone()) fn(); } else fn();
    if (kind === 'incoming') { try { navigator.vibrate && navigator.vibrate([400, 200, 400]); } catch (e) {} }
    ringTimer = setInterval(function () {
      fn();
      if (kind === 'incoming') { try { navigator.vibrate && navigator.vibrate([400, 200, 400]); } catch (e) {} }
    }, every);
  }
  function stopRinging() { stopCallTone(); if (ringTimer) { clearInterval(ringTimer); ringTimer = null; } try { navigator.vibrate && navigator.vibrate(0); } catch (e) {} }
  function endBeep() {
    var c = audioCtx(); if (!c) return;
    var o = c.createOscillator(), g = c.createGain();
    o.type = 'sine'; o.frequency.value = 330;
    g.gain.setValueAtTime(0.0001, c.currentTime); g.gain.exponentialRampToValueAtTime(0.2, c.currentTime + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.35);
    o.connect(g); g.connect(c.destination); o.start(); o.stop(c.currentTime + 0.4);
  }

  // ── the call screen ──
  function buildUi() {
    if (ui) return ui;
    var st = document.createElement('style');
    st.textContent =
      '#swc{position:fixed;inset:0;z-index:100000;display:none;flex-direction:column;align-items:center;justify-content:space-between;' +
      'padding:calc(env(safe-area-inset-top,0px) + 56px) 24px calc(env(safe-area-inset-bottom,0px) + 48px);background:linear-gradient(180deg,#14161c 0%,#0b0c10 100%);color:#fff;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;text-align:center;max-width:none}' +
      '#swc *{max-width:none;box-sizing:border-box}' +
      '#swc .swc-top{display:flex;flex-direction:column;align-items:center;gap:10px}' +
      '#swc .swc-avatar{width:112px;height:112px;border-radius:50%;background:#F0A93B;color:#1a1206;font-size:54px;display:flex;align-items:center;justify-content:center;box-shadow:0 0 0 0 rgba(240,169,59,.6)}' +
      '#swc.ringing .swc-avatar{animation:swcpulse 1.6s infinite}' +
      '@keyframes swcpulse{0%{box-shadow:0 0 0 0 rgba(240,169,59,.55)}100%{box-shadow:0 0 0 34px rgba(240,169,59,0)}}' +
      '#swc .swc-name{font-size:26px;font-weight:800;margin-top:10px}' +
      '#swc .swc-sub{font-size:14px;color:#9aa0ac}' +
      '#swc .swc-state{font-size:16px;color:#F0A93B;font-weight:700;margin-top:6px;min-height:22px}' +
      '#swc .swc-row{display:flex;gap:34px;align-items:center;justify-content:center}' +
      '#swc .swc-btn{display:flex;flex-direction:column;align-items:center;gap:8px;background:none;border:0;color:#fff;font:600 13px system-ui,sans-serif;cursor:pointer;touch-action:manipulation}' +
      '#swc .swc-circle{width:68px;height:68px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:28px;background:#2a2d36}' +
      '#swc .swc-circle.red{background:#e5392f}#swc .swc-circle.green{background:#1fbf4f}#swc .swc-circle.on{background:#fff;color:#111}';
    document.head.appendChild(st);
    var el = document.createElement('div');
    el.id = 'swc';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-live', 'polite');
    el.innerHTML =
      '<div class="swc-top"><div class="swc-avatar" id="swc-avatar">📞</div><div class="swc-name" id="swc-name"></div><div class="swc-sub" id="swc-sub"></div><div class="swc-state" id="swc-state"></div></div>' +
      '<div class="swc-row" id="swc-row"></div>' +
      '<audio id="swc-audio" autoplay playsinline style="display:none"></audio>';
    document.body.appendChild(el);
    ui = { el: el, name: el.querySelector('#swc-name'), sub: el.querySelector('#swc-sub'), state: el.querySelector('#swc-state'), row: el.querySelector('#swc-row'), audio: el.querySelector('#swc-audio'), avatar: el.querySelector('#swc-avatar') };
    return ui;
  }
  function btn(label, icon, cls, fn) {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'swc-btn';
    b.innerHTML = '<span class="swc-circle ' + cls + '">' + icon + '</span><span>' + esc(label) + '</span>';
    b.addEventListener('click', fn);
    return b;
  }
  function show(mode, name, sub, state, avatar) {
    buildUi();
    ui.el.style.display = 'flex';
    ui.el.className = (mode === 'incoming' || mode === 'calling') ? 'ringing' : '';
    ui.avatar.textContent = avatar || '📞';
    ui.name.textContent = name || '';
    ui.sub.textContent = sub || '';
    ui.state.textContent = state || '';
    ui.row.innerHTML = '';
    if (mode === 'incoming') {
      ui.row.appendChild(btn('Decline', '✕', 'red', function () { declineIncoming(); }));
      ui.row.appendChild(btn('Answer', '📞', 'green', function () { answerIncoming(); }));
    } else if (mode === 'calling' || mode === 'active') {
      var mute = btn('Mute', '🎤', '', function () {
        if (!cur || !cur.stream) return;
        var t = cur.stream.getAudioTracks()[0]; if (!t) return;
        t.enabled = !t.enabled;
        mute.querySelector('.swc-circle').className = 'swc-circle' + (t.enabled ? '' : ' on');
        mute.querySelector('.swc-circle').textContent = t.enabled ? '🎤' : '🔇';
      });
      ui.row.appendChild(mute);
      var au = audioNative();
      if (au) {
        var spk = btn('Speaker', '🔊', (cur && cur.speaker) ? 'on' : '', function () {
          if (!cur) return;
          cur.speaker = !cur.speaker;
          try { au.setSpeaker(cur.speaker).catch(function () {}); } catch (e) {}
          spk.querySelector('.swc-circle').className = 'swc-circle' + (cur.speaker ? ' on' : '');
        });
        ui.row.appendChild(spk);
      }
      ui.row.appendChild(btn(mode === 'calling' ? 'Cancel' : 'End', '✕', 'red', function () { hangUp(); }));
    }
  }
  // Earpiece / speaker choice (installed app only).
  function audioNative() { var a = window.SwiftApp && window.SwiftApp.callAudio; return a && a.available ? a : null; }
  function audioStart() { var a = audioNative(); if (a) { try { a.start(false).catch(function () {}); } catch (e) {} } }
  function audioStop() { var a = audioNative(); if (a) { try { a.stop().catch(function () {}); } catch (e) {} } }
  function setState(text) { if (ui) ui.state.textContent = text; }
  function hideUi(delay) {
    setTimeout(function () { if (!cur && ui) ui.el.style.display = 'none'; }, delay || 0);
  }

  // ── network helpers ──
  function post(body) {
    if (!cfg.workerUrl) return Promise.resolve(null);
    return fetch(cfg.workerUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Notify-Key': cfg.key }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); }).catch(function () { return null; });
  }
  function fetchIceServers(callId) {
    var timeout = new Promise(function (res) { setTimeout(function () { res(null); }, 6000); });
    return Promise.race([post({ turnCredentials: true, callId: callId }), timeout]).then(function (r) {
      return (r && Array.isArray(r.iceServers) && r.iceServers.length) ? r.iceServers : STUN_ONLY;
    });
  }
  function micErrorText(e) {
    var n = e && e.name;
    if (n === 'NotAllowedError' || n === 'SecurityError') return 'Microphone is blocked. Allow the microphone for this app in your phone settings, then try again.';
    if (n === 'NotFoundError') return 'No microphone found on this phone.';
    return 'Could not start the microphone.';
  }
  function getMic() {
    return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }, video: false });
  }
  // Voice-only audio settings: mono, with error correction so a weak mobile signal crackles less, at a bitrate made for speech.
  function tuneOpus(sdp) {
    try {
      var m = /a=rtpmap:(\d+) opus\/48000\/2/.exec(sdp);
      if (!m) return sdp;
      var pt = m[1], want = 'stereo=0;sprop-stereo=0;useinbandfec=1;usedtx=0;maxaveragebitrate=32000';
      var re = new RegExp('a=fmtp:' + pt + ' ([^\\r\\n]*)');
      if (re.test(sdp)) return sdp.replace(re, function (all, params) { return 'a=fmtp:' + pt + ' ' + params.replace(/;?(stereo|sprop-stereo|useinbandfec|usedtx|maxaveragebitrate)=[^;]*/g, '') + ';' + want; });
      return sdp.replace(m[0], m[0] + '\r\na=fmtp:' + pt + ' ' + want);
    } catch (e) { return sdp; }
  }

  // ── one peer connection, either side ──
  function makePeer(call, iceServers, iceField) {
    var pc = new RTCPeerConnection({ iceServers: iceServers });
    call.pc = pc;
    call.stream.getTracks().forEach(function (t) { pc.addTrack(t, call.stream); });
    pc.ontrack = function (e) {
      if (!ui) return;
      ui.audio.srcObject = e.streams[0] || new MediaStream([e.track]);
      var p = ui.audio.play(); if (p && p.catch) p.catch(function () {});
    };
    pc.onicecandidate = function (e) {
      if (!e.candidate || call.ended) return;
      var upd = {}; upd[iceField] = fns().arrayUnion(JSON.stringify(e.candidate));
      fns().updateDoc(ref(call.id), upd).catch(function () {});
    };
    pc.onconnectionstatechange = function () {
      if (call.ended) return;
      var s = pc.connectionState;
      if (s === 'connected') { markConnected(call); }
      else if (s === 'failed') { finish(call, 'Call could not connect. Check your internet and try again.', true); }
      else if (s === 'disconnected') {
        clearTimeout(call.dropTimer);
        call.dropTimer = setTimeout(function () { if (!call.ended && pc.connectionState !== 'connected') finish(call, 'Connection lost.', true); }, 9000);
      }
    };
    return pc;
  }
  function addRemoteIce(call, list) {
    if (!list) return;
    for (var i = call.iceSeen; i < list.length; i++) {
      try {
        var cand = JSON.parse(list[i]);
        if (call.pc.remoteDescription) call.pc.addIceCandidate(cand).catch(function () {});
        else call.pendingIce.push(cand);
      } catch (e) {}
    }
    call.iceSeen = list.length;
  }
  function flushIce(call) {
    var q = call.pendingIce; call.pendingIce = [];
    q.forEach(function (c) { call.pc.addIceCandidate(c).catch(function () {}); });
  }
  function markConnected(call) {
    if (call.connectedAt) return;
    clearTimeout(call.dropTimer);
    call.connectedAt = now();
    stopRinging();
    show('active', call.title, call.sub, '00:00', call.avatar);
    call.tick = setInterval(function () { setState(fmtTime(Math.floor((now() - call.connectedAt) / 1000))); }, 1000);
  }

  function finish(call, message, writeEnd) {
    if (!call || call.ended) return;
    call.ended = true;
    stopRinging();
    clearInterval(call.tick); clearTimeout(call.ringTimeout); clearTimeout(call.dropTimer);
    try { call.unsub && call.unsub(); } catch (e) {}
    if (call.side === 'callee') { var caDone = nativeCalls(); if (caDone && caDone.callFinished) { setTimeout(function () { try { caDone.callFinished().catch(function () {}); } catch (e) {} }, 1900); } }
    if (writeEnd) {
      var upd = { status: 'ended', endedAt: now(), endedBy: cfg.role };
      fns().updateDoc(ref(call.id), upd).catch(function () {});
    }
    audioStop();
    try { call.stream && call.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    try { call.pc && call.pc.close(); } catch (e) {}
    if (ui) { try { ui.audio.srcObject = null; } catch (e) {} }
    if (cur === call) cur = null;
    endBeep();
    show('ended', call.title, call.sub, message || 'Call ended', call.avatar);
    hideUi(1800);
  }

  // ── CALLER (rider) ──
  function startOutgoing(o) {
    if (cur) { toast('You are already on a call.'); return; }
    if (!supported()) { toast('Calls are not supported on this phone. Use the normal call button.'); return; }
    var call = cur = { id: o.id, side: 'caller', title: o.title, sub: o.sub, avatar: o.avatar, iceSeen: 0, pendingIce: [], ended: false };
    show('calling', o.title, o.sub, 'Starting…', o.avatar);
    audioStart();
    audioCtx(); // wake the audio engine inside the tap
    getMic().then(function (stream) {
      call.stream = stream;
      if (call.ended) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
      var doc0 = { kind: o.kind, orderId: o.orderId || '', riderId: o.riderId, callerName: o.callerName, label: o.label || '', status: 'preparing', createdAt: now(), callerIce: [], calleeIce: [] };
      return fns().setDoc(ref(o.id), doc0).then(function () { return fetchIceServers(o.id); }).then(function (servers) {
        if (call.ended) return;
        var pc = makePeer(call, servers, 'callerIce');
        return pc.createOffer({ offerToReceiveAudio: true }).then(function (offer) {
          var tunedOffer = { type: offer.type, sdp: tuneOpus(offer.sdp) };
          return pc.setLocalDescription(tunedOffer).then(function () {
            return fns().updateDoc(ref(o.id), { offer: tunedOffer, status: 'ringing' });
          });
        }).then(function () {
          if (call.ended) return;
          setState('Ringing…');
          startRinging('outgoing');
          post({ callAlert: true, callId: o.id });
          call.unsub = fns().onSnapshot(ref(o.id), function (snap) {
            if (call.ended || !snap.exists()) return;
            var d = snap.data();
            if (d.answer && !pc.remoteDescription) {
              pc.setRemoteDescription(d.answer).then(function () { flushIce(call); }).catch(function () {});
              setState('Connecting…');
              stopRinging();
              clearTimeout(call.ringTimeout);
            }
            addRemoteIce(call, d.calleeIce);
            if (d.status === 'declined') finish(call, 'Declined', false);
            else if (d.status === 'ended' && d.endedBy !== cfg.role) finish(call, 'Call ended', false);
          });
          call.ringTimeout = setTimeout(function () {
            if (call.ended || call.connectedAt) return;
            if (call.pc && call.pc.remoteDescription) return;
            fns().updateDoc(ref(o.id), { status: 'missed', endedAt: now(), endedBy: cfg.role }).then(function () { post({ callCancel: true, callId: o.id }); }).catch(function () {});
            finish(call, 'No answer', false);
          }, RING_TIMEOUT_MS);
        });
      });
    }).catch(function (e) {
      var msg = (e && /getUserMedia|Permission|NotAllowed|NotFound/i.test(String(e.name) + String(e.message))) ? micErrorText(e) : 'Could not place the call. Check your internet and try again.';
      console.warn('[swift-call] start failed:', e);
      finish(call, msg, false);
      if (call.id) fns().updateDoc(ref(call.id), { status: 'cancelled', endedAt: now(), endedBy: cfg.role }).catch(function () {});
    });
  }

  function hangUp() {
    if (!cur) { hideUi(0); return; }
    var call = cur;
    if (call.side === 'caller' && !call.connectedAt && !(call.pc && call.pc.remoteDescription)) {
      fns().updateDoc(ref(call.id), { status: 'cancelled', endedAt: now(), endedBy: cfg.role }).then(function () { post({ callCancel: true, callId: call.id }); }).catch(function () {});
      finish(call, 'Call cancelled', false);
    } else finish(call, 'Call ended', true);
  }

  // ── CALLEE (customer / staff) ──
  var incoming = null; // { id, data }
  function incomingNames(d) {
    var who = d.callerName || 'Swift rider';
    return { title: who, sub: d.kind === 'staff' ? ('Calling the shop' + (d.label ? ' · ' + d.label : '')) : ('Your delivery rider' + (d.label ? ' · ' + d.label : '')), avatar: '🏍️' };
  }
  function dkey(id, d) { return id + ':' + ((d && d.createdAt) || 0); }
  function offerIncoming(id, d) {
    if (cur || dismissed[dkey(id, d)]) return;
    if (!(d.status === 'ringing' && d.offer && d.createdAt && now() - d.createdAt < FRESH_MS)) return;
    incoming = { id: id, data: d };
    var n = incomingNames(d);
    if (autoAnswer && now() < autoAnswer.until && (!autoAnswer.id || autoAnswer.id === id)) {
      // The person already tapped Answer on the phone's own call screen: connect straight away
      // (no ringing, no Answer button: the call window just carries on from "Connecting…").
      autoAnswer = null;
      show('calling', n.title, n.sub, 'Connecting…', n.avatar);
      setTimeout(function () { if (incoming && incoming.id === id) answerIncoming(); }, 30);
      return;
    }
    show('incoming', n.title, n.sub, 'Incoming free call…', n.avatar);
    startIncomingRing();
    clearTimeout(incoming.timer);
    incoming.timer = setTimeout(function () { if (incoming && incoming.id === id) clearIncoming('Missed call'); }, Math.max(1000, FRESH_MS - (now() - d.createdAt)));
  }
  // In the installed app, when the app is not on screen the phone's own call screen is already ringing,
  // so the page stays quiet (otherwise you hear two rings, one soft and one loud).
  function startIncomingRing() {
    var ca = nativeCalls();
    if (!ca) { startRinging('incoming'); return; }
    if (document.hidden) return;
    ca.getStatus().then(function (st) {
      if (!incoming || cur) return;
      if (st && st.appVisible === false) return;
      startRinging('incoming');
    }).catch(function () { if (incoming && !cur) startRinging('incoming'); });
  }
  function clearIncoming(message) {
    if (!incoming) return;
    var caCancel = nativeCalls(); if (caCancel && caCancel.cancelRing) { try { caCancel.cancelRing().catch(function () {}); } catch (e) {} }
    clearTimeout(incoming.timer);
    var id = incoming.id; dismissed[dkey(id, incoming.data)] = true; incoming = null;
    stopRinging();
    if (!cur && ui) { show('ended', '', '', message || 'Call ended'); hideUi(1500); }
  }
  function declineIncoming() {
    if (!incoming) return;
    var id = incoming.id;
    fns().updateDoc(ref(id), { status: 'declined', endedAt: now(), endedBy: cfg.role }).catch(function () {});
    clearIncoming('Declined');
  }
  function answerIncoming() {
    if (!incoming || cur) return;
    var id = incoming.id, d = incoming.data, n = incomingNames(d);
    clearTimeout(incoming.timer); dismissed[dkey(id, d)] = true; incoming = null;
    stopRinging();
    var call = cur = { id: id, side: 'callee', title: n.title, sub: n.sub, avatar: n.avatar, iceSeen: 0, pendingIce: [], ended: false };
    show('calling', n.title, n.sub, 'Connecting…', n.avatar);
    audioStart();
    audioCtx();
    // Make sure nobody else answered first (shop calls ring several devices at once).
    var check = fns().getDoc ? fns().getDoc(ref(id)) : Promise.resolve(null);
    Promise.resolve(check).then(function (snap) {
      if (snap && snap.exists && snap.exists() && snap.data().status !== 'ringing') { finish(call, 'Already answered or ended', false); return null; }
      return getMic();
    }).then(function (stream) {
      if (!stream) return;
      call.stream = stream;
      return fetchIceServers(id).then(function (servers) {
        var pc = makePeer(call, servers, 'calleeIce');
        return pc.setRemoteDescription(d.offer).then(function () {
          addRemoteIce(call, d.callerIce);
          flushIce(call);
          return pc.createAnswer();
        }).then(function (answer) {
          var tunedAnswer = { type: answer.type, sdp: tuneOpus(answer.sdp) };
          return pc.setLocalDescription(tunedAnswer).then(function () {
            return fns().updateDoc(ref(id), { answer: tunedAnswer, status: 'active', answeredBy: cfg.name || cfg.role });
          });
        }).then(function () {
          call.unsub = fns().onSnapshot(ref(id), function (snap) {
            if (call.ended || !snap.exists()) return;
            var x = snap.data();
            addRemoteIce(call, x.callerIce);
            flushIce(call);
            if ((x.status === 'ended' || x.status === 'cancelled') && x.endedBy !== cfg.role) finish(call, 'Call ended', false);
          });
          call.ringTimeout = setTimeout(function () { if (!call.ended && !call.connectedAt) finish(call, 'Could not connect. Try again.', true); }, 20000);
        });
      });
    }).catch(function (e) {
      console.warn('[swift-call] answer failed:', e);
      finish(call, /NotAllowed|NotFound|Permission/i.test(String(e && e.name) + String(e && e.message)) ? micErrorText(e) : 'Could not connect the call.', false);
    });
  }

  // ── listeners ──
  function onCalleeSnapshot(id, snap) {
    if (!snap.exists()) { if (incoming && incoming.id === id) clearIncoming('Call ended'); return; }
    var d = snap.data();
    if (incoming && incoming.id === id) {
      if (d.status !== 'ringing') clearIncoming(d.status === 'active' ? 'Answered on another device' : d.status === 'cancelled' ? 'Caller hung up' : d.status === 'declined' ? 'Declined' : 'Missed call');
      return;
    }
    offerIncoming(id, d);
  }
  function watchOrders(orders) {
    checkPending();
    if (!db() || !fns().onSnapshot || !fns().doc) return;
    var wanted = {};
    (orders || []).forEach(function (o) {
      if (!o || !o.fbDocId || !o.bodaClaimedBy || !o.bodaClaimedBy.riderId) return;
      if (o.status === 'closed' || o.status === 'cancelled' || o.deliveryStage === 'delivered') return;
      wanted[o.fbDocId] = true;
    });
    Object.keys(watchers).forEach(function (id) { if (!wanted[id]) { try { watchers[id](); } catch (e) {} delete watchers[id]; } });
    Object.keys(wanted).forEach(function (id) {
      if (watchers[id]) return;
      watchers[id] = fns().onSnapshot(ref(id), function (snap) { onCalleeSnapshot(id, snap); }, function () {});
    });
  }
  // Add one order to the watch list without dropping the others (a guest looking at a single order).
  function watchOne(o) {
    if (!o || !o.fbDocId || !o.bodaClaimedBy || !o.bodaClaimedBy.riderId || !db() || !fns().onSnapshot) return;
    if (o.status === 'closed' || o.status === 'cancelled' || o.deliveryStage === 'delivered') return;
    if (watchers[o.fbDocId]) return;
    watchers[o.fbDocId] = fns().onSnapshot(ref(o.fbDocId), function (snap) { onCalleeSnapshot(o.fbDocId, snap); }, function () {});
  }
  function watchStaff() {
    checkPending();
    if (staffUnsub || !db() || !fns().query || !fns().where || !fns().collection) return;
    var q = fns().query(fns().collection(db(), 'calls'), fns().where('kind', '==', 'staff'), fns().where('status', '==', 'ringing'));
    staffUnsub = fns().onSnapshot(q, function (snap) {
      var live = {};
      snap.docs.forEach(function (d) { live[d.id] = true; offerIncoming(d.id, d.data()); });
      if (incoming && !live[incoming.id]) clearIncoming('Answered or ended');
    }, function (e) { console.warn('[swift-call] staff listener:', e && e.message); });
  }
  function stopWatching() {
    Object.keys(watchers).forEach(function (id) { try { watchers[id](); } catch (e) {} });
    watchers = {};
    if (staffUnsub) { try { staffUnsub(); } catch (e) {} staffUnsub = null; }
  }

  // ── the phone's own full-screen call screen (storefront / admin / employee apps) ──
  var autoAnswer = null;   // { id, until }: the person tapped Answer on the native call screen
  function nativeCalls() { var a = window.SwiftApp && window.SwiftApp.callAlert; return a && a.available ? a : null; }
  function checkPending() {
    var ca = nativeCalls();
    if (!ca) return;
    ca.consumePendingAction().then(function (r) {
      if (!r || r.action !== 'answer') return;
      beginAutoAnswer(r.callId || '');
    }).catch(function () {});
  }
  // The person tapped Answer on the phone's call screen. Put the call window up at once (so the shop's
  // home page never shows), then look the call up directly instead of waiting for the page to finish loading.
  var autoFetchTimer = null;
  function beginAutoAnswer(id) {
    autoAnswer = { id: id, until: now() + 30000 };
    if (incoming && (!id || id === incoming.id)) { autoAnswer = null; answerIncoming(); return; }
    if (cur) return;
    var put = function () { if (!cur && !incoming) show('calling', 'Swift Importers', 'Free internet call', 'Connecting…', '🏍️'); };
    if (document.body) put(); else document.addEventListener('DOMContentLoaded', put);
    clearInterval(autoFetchTimer);
    var started = now();
    var fetching = false;
    function endedNow(text) { autoAnswer = null; show('ended', '', '', text); hideUi(2200); }
    autoFetchTimer = setInterval(function () {
      if (cur || !autoAnswer) { clearInterval(autoFetchTimer); return; }
      if (now() - started > 20000) { clearInterval(autoFetchTimer); endedNow('Could not connect the call'); return; }
      if (fetching || !id || !db() || !fns().getDoc || !fns().doc) return;
      fetching = true;
      fns().getDoc(ref(id)).then(function (snap) {
        fetching = false;
        if (cur) { clearInterval(autoFetchTimer); return; }
        clearInterval(autoFetchTimer);
        var d = snap && snap.exists() ? snap.data() : null;
        if (d && d.status === 'ringing') {
          offerIncoming(id, d);
          if (!incoming && !cur) endedNow('Missed call');
          return;
        }
        var st = d && d.status;
        endedNow(st === 'cancelled' ? 'Caller hung up' : st === 'active' ? 'Answered on another device' : st === 'declined' ? 'Declined' : 'Call ended');
      }).catch(function () { fetching = false; });
    }, 250);
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return;
    checkPending();
    // Opened while a call was ringing quietly in the background: ring in the page now.
    if (incoming && !cur && !ringTimer) startRinging('incoming');
  });
  window.addEventListener('focus', function () { checkPending(); });

  // One gentle, dismissible reminder to allow the two Android settings that let a call ring over the lock screen.
  function setupPrompt() {
    var ca = nativeCalls();
    if (!ca) return;
    try { if (new URLSearchParams(location.search).get('calltest') === '1') ca.testCall(); } catch (e) {}
    if (window.SwiftSetup) return;   // the phone-setup checklist (swift-setup.js) covers these settings
    var KEY = 'swift_call_setup_ts';
    try { var last = Number(localStorage.getItem(KEY) || 0); if (last && now() - last < 2 * 24 * 3600 * 1000) return; } catch (e) {}
    ca.getStatus().then(function (st) {
      if (!st || (st.canOverlay && st.canFullScreen && st.notificationsEnabled)) return;
      if (document.getElementById('swc-setup')) return;
      var bar = document.createElement('div');
      bar.id = 'swc-setup';
      bar.style.cssText = 'position:fixed;left:12px;right:12px;bottom:calc(env(safe-area-inset-bottom,0px) + 14px);z-index:99990;background:#2a2118;color:#f7f1e6;border:2px solid #F0A93B;border-radius:14px;padding:12px 14px;font:600 13px/1.4 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.45);max-width:none';
      bar.innerHTML = '<div style="margin-bottom:8px">📞 To ring like a real phone call when the app is closed, allow <b>' +
        (!st.notificationsEnabled ? 'notifications' : (!st.canOverlay ? 'Display over other apps' : 'Full-screen notifications')) + '</b> for this app.</div>' +
        '<div style="display:flex;gap:8px"><button type="button" id="swc-setup-go" style="flex:1;background:#F0A93B;color:#1a1206;border:0;border-radius:10px;padding:10px;font:800 13px system-ui,sans-serif">Allow</button>' +
        '<button type="button" id="swc-setup-later" style="flex:0 0 auto;background:none;color:#a69c8c;border:1.5px solid #5a4e3c;border-radius:10px;padding:10px 14px;font:700 13px system-ui,sans-serif">Later</button></div>';
      document.body.appendChild(bar);
      try { localStorage.setItem(KEY, String(now())); } catch (e) {}
      bar.querySelector('#swc-setup-later').addEventListener('click', function () { bar.remove(); });
      bar.querySelector('#swc-setup-go').addEventListener('click', function () {
        bar.remove();
        if (!st.canOverlay) ca.openOverlaySettings(); else if (!st.canFullScreen) ca.openFullScreenSettings(); else ca.openOverlaySettings();
      });
    }).catch(function () {});
  }

  // ── public ──
  function callCustomer(order) {
    if (!order || !order.fbDocId || !order.bodaClaimedBy) return;
    startOutgoing({
      id: order.fbDocId, kind: 'customer', orderId: order.fbDocId, riderId: order.bodaClaimedBy.riderId,
      callerName: cfg.name || order.bodaClaimedBy.name || 'Your rider', label: order.refCode ? 'Order #' + order.refCode : '',
      title: order.customerName || 'Customer', sub: order.refCode ? 'Order #' + order.refCode : 'Free internet call', avatar: '👤'
    });
  }
  function callShop(order) {
    var rider = (order && order.bodaClaimedBy) || {};
    startOutgoing({
      id: 's' + rand(19), kind: 'staff', orderId: (order && order.fbDocId) || '', riderId: rider.riderId || '',
      callerName: cfg.name || rider.name || 'Swift rider', label: order && order.refCode ? 'Order #' + order.refCode : '',
      title: 'Swift Importers', sub: 'Calling the shop' + (order && order.refCode ? ' · Order #' + order.refCode : ''), avatar: '🏬'
    });
  }

  // Runs as soon as this file loads, so an Answer tapped on the lock screen shows the call window immediately.
  try { if (nativeCalls()) checkPending(); } catch (e) {}

  window.SwiftCall = {
    init: function (c) {
      cfg = Object.assign(cfg, c || {});
      if (cfg.role === 'customer' || cfg.role === 'staff') {
        var caCfg = nativeCalls();
        if (caCfg && caCfg.configure && cfg.workerUrl) { try { caCfg.configure({ workerUrl: cfg.workerUrl, key: cfg.key, role: cfg.role }).catch(function () {}); } catch (e) {} }
        checkPending(); setupPrompt();
      }
    },
    supported: supported,
    callCustomer: callCustomer,
    callShop: callShop,
    watchOrders: watchOrders,
    watchOne: watchOne,
    watchStaff: watchStaff,
    stopWatching: stopWatching,
    _state: function () { return { cur: cur, incoming: incoming }; }
  };
})();
