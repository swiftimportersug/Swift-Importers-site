/**
 * Swift Importers — native app bridge
 * ------------------------------------------------
 * Loaded by every page. In a normal browser this file does nothing at all.
 * Inside the Capacitor Android app it connects the website to the phone:
 *
 *   1. The hardware Back button. Once a page listens for it, Capacitor stops
 *      handling it by default, so this decides what Back means: close the
 *      top-most popup/overlay first (pages define window.appHandleBack for
 *      that), otherwise go back a page, otherwise exit the app.
 *
 *   2. Native push notifications. Browser web-push does not exist inside an
 *      Android WebView, so the app registers with Firebase natively instead
 *      and hands the resulting token to the same Firestore fields the web
 *      version already uses (window.SwiftApp.registerForPush()).
 *
 * Because the app loads the live website, editing this file and pushing it to
 * GitHub updates the app instantly — no rebuild needed for changes here.
 * (Only NEW native plugins or permissions require rebuilding the app.)
 */
(function () {
  var cap = window.Capacitor;
  var isNative = !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
  window.SwiftApp = { isNative: isNative };
  if (!isNative) return;

  var PUSH_CHANNEL_ID = 'swift-orders';

  function getPlugin(name) {
    try {
      return (cap.Plugins && cap.Plugins[name]) || cap.registerPlugin(name);
    } catch (e) {
      console.error('[app-bridge] plugin unavailable:', name, e);
      return null;
    }
  }

  // Adds a listener without letting a missing plugin cause noisy errors.
  function safeAddListener(plugin, eventName, fn) {
    try {
      var result = plugin.addListener(eventName, fn);
      if (result && typeof result.catch === 'function') {
        result.catch(function (e) { console.error('[app-bridge] listener failed:', eventName, e); });
      }
      return result;
    } catch (e) {
      console.error('[app-bridge] listener failed:', eventName, e);
      return null;
    }
  }

  // ── 1. Hardware Back button ──
  var AppPlugin = getPlugin('App');
  window.SwiftApp.exit = function () {
    try { if (AppPlugin) AppPlugin.exitApp(); } catch (e) { console.error('[app-bridge] exitApp failed:', e); }
  };
  if (AppPlugin) {
    safeAddListener(AppPlugin, 'backButton', function (ev) {
      // Page-specific first: close popups, overlays, dialogs.
      try {
        if (typeof window.appHandleBack === 'function' && window.appHandleBack()) return;
      } catch (e) {
        console.error('[app-bridge] appHandleBack failed:', e);
      }
      // Otherwise behave like a browser: go back a page if there is one...
      if (ev && ev.canGoBack) { window.history.back(); return; }
      // ...and leave the app only when there is genuinely nowhere left to go.
      try { AppPlugin.exitApp(); } catch (e) { console.error('[app-bridge] exitApp failed:', e); }
    });
  }

  // ── 2. Native push notifications ──
  var Push = getPlugin('PushNotifications');
  if (Push) {
    // Tapping a notification opens the page the message points to.
    safeAddListener(Push, 'pushNotificationActionPerformed', function (action) {
      var data = action && action.notification && action.notification.data;
      if (data && data.url) window.location.href = data.url;
    });
    // Android doesn't draw a notification while the app is open, so show it in-page.
    safeAddListener(Push, 'pushNotificationReceived', function (n) {
      var text = ((n && n.title) || '') + (n && n.body ? ' — ' + n.body : '');
      if (text && typeof window.showToastMessage === 'function') window.showToastMessage('🔔 ' + text, '#2a9d50');
    });
  }

  // ── 3. Native fingerprint / face sign-in ──
  // Browser WebAuthn doesn't exist inside an Android WebView, so the site uses the phone's
  // own biometric prompt instead. The prompt only answers "is this the phone's owner?" —
  // it can't say WHICH account — so a random token is kept in the phone's secure storage
  // (Android Keystore) when sign-in is turned on, and handed back after a successful scan.
  // Like the browser version it replaces, this is a convenience layer on top of the
  // existing phone-number sign-in, not bank-grade security.
  var Bio = getPlugin('NativeBiometric');
  var BIO_SERVER = 'swiftimporters.com';
  window.SwiftApp.biometricAvailable = false;
  if (Bio) {
    try {
      Bio.isAvailable().then(function (r) {
        window.SwiftApp.biometricAvailable = !!(r && r.isAvailable);
      }).catch(function () {});
    } catch (e) {}
  }
  function bioPrompt(reason) {
    return Bio.verifyIdentity({
      reason: reason,
      title: 'Swift Importers',
      subtitle: 'Confirm it\'s you',
      description: reason
    });
  }
  window.SwiftApp.biometric = {
    // Scan first, then store the token. Rejects if the scan fails or is cancelled.
    enroll: function (token) {
      if (!Bio) return Promise.reject(new Error('biometric plugin missing'));
      return bioPrompt('Use your fingerprint or face to turn on quick sign-in').then(function () {
        return Bio.setCredentials({ username: 'swift-account', password: token, server: BIO_SERVER });
      });
    },
    // Scan, then resolve with the stored token. Rejects if the scan fails or is cancelled.
    authenticate: function () {
      if (!Bio) return Promise.reject(new Error('biometric plugin missing'));
      return bioPrompt('Use your fingerprint or face to sign in').then(function () {
        return Bio.getCredentials({ server: BIO_SERVER });
      }).then(function (c) { return (c && c.password) || null; });
    },
    remove: function () {
      if (!Bio) return Promise.resolve();
      try { return Bio.deleteCredentials({ server: BIO_SERVER }).catch(function () {}); }
      catch (e) { return Promise.resolve(); }
    }
  };

  // Asks permission, registers with Firebase, resolves with the device's push token.
  window.SwiftApp.registerForPush = function () {
    if (!Push) return Promise.reject(new Error('push plugin missing'));
    return Push.checkPermissions().then(function (status) {
      if (status.receive === 'granted') return status;
      return Push.requestPermissions();
    }).then(function (status) {
      if (status.receive !== 'granted') throw new Error('denied');
      return new Promise(function (resolve, reject) {
        var handles = [];
        var finished = false;
        function finish(fn, value) {
          if (finished) return;
          finished = true;
          handles.forEach(function (h) { try { h.remove(); } catch (e) {} });
          fn(value);
        }
        var timer = setTimeout(function () { finish(reject, new Error('timeout')); }, 20000);
        Promise.all([
          Push.addListener('registration', function (t) { clearTimeout(timer); finish(resolve, t.value); }),
          Push.addListener('registrationError', function (e) { clearTimeout(timer); finish(reject, new Error((e && e.error) || 'registration failed')); })
        ]).then(function (hs) {
          handles = hs;
          // High-importance channel so order updates pop up with sound, not silently.
          // The Workers name this same channel when sending.
          try {
            var ch = Push.createChannel({
              id: PUSH_CHANNEL_ID,
              name: 'Order updates',
              description: 'Order status and payment updates',
              importance: 5,
              visibility: 1,
              vibration: true
            });
            if (ch && typeof ch.catch === 'function') ch.catch(function () {});
          } catch (e) {}
          return Push.register();
        }).catch(function (e) { clearTimeout(timer); finish(reject, e); });
      });
    });
  };
})();
