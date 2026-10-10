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
    // Android always shows the app's own name above this automatically (a
    // security feature so it can never be faked to look like it's from
    // somewhere else) — so repeating the brand name again in our own title
    // was pure redundancy. This keeps it to one clear line of actual content.
    // Note: the box itself (colors, layout, shape) is drawn entirely by
    // Android — no app can restyle it, by design, so this text is the only
    // part of this screen anything can actually change.
    return Bio.verifyIdentity({
      reason: reason,
      title: 'Confirm it\'s you',
      subtitle: reason
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
  // Checks current permission WITHOUT ever prompting — for a page's silent,
  // no-gesture "was this already granted on a past visit?" init logic, exactly
  // mirroring how the browser version only checks Notification.permission
  // without calling requestPermission() itself.
  window.SwiftApp.pushPermissionGranted = function () {
    if (!Push) return Promise.resolve(false);
    return Push.checkPermissions().then(function (s) { return s.receive === 'granted'; }).catch(function () { return false; });
  };

  // Raw status ('granted' | 'denied' | 'prompt' | 'prompt-with-rationale') rather
  // than a collapsed true/false — a caller needs this distinction to auto-ask on
  // a genuinely first-ever login without ever re-pestering someone who already
  // said no once (repeatedly re-prompting after an explicit denial is both
  // against Android's own guidance and just an annoying experience).
  window.SwiftApp.pushPermissionStatus = function () {
    if (!Push) return Promise.resolve('unavailable');
    return Push.checkPermissions().then(function (s) { return s.receive; }).catch(function () { return 'unavailable'; });
  };

  window.SwiftApp.registerForPush = function (customChannel) {
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
          // The Workers name this same channel when sending. Waited on properly now
          // (previously fired-and-forgot) so registration can never complete a hair
          // before the channel it depends on actually exists on the device.
          //
          // A caller (boda) can pass its own channel config with a custom "sound"
          // (the resource name of an .m4a/.mp3/.wav bundled under
          // android/app/src/main/res/raw/, WITHOUT the file extension) to get its
          // own distinct tone. A channel's sound is locked the first time Android
          // creates it — changing this code later never retroactively changes it
          // on a phone that already has the old channel, which is exactly why this
          // uses its own channel id rather than reusing the shared default.
          var channelConfig = customChannel || {
            id: PUSH_CHANNEL_ID,
            name: 'Order updates',
            description: 'Order status and payment updates'
          };
          // A caller may also ask for extra channels (boda uses one for chat
          // messages, so a message ping doesn't ring the long job tone). Anything
          // that doesn't pass extraChannels behaves exactly as before.
          var extraChannels = channelConfig.extraChannels || [];
          var mainConfig = Object.assign({}, channelConfig);
          delete mainConfig.extraChannels;
          var channelPromise;
          try {
            channelPromise = Promise.all([mainConfig].concat(extraChannels).map(function (cfg) {
              return Promise.resolve(Push.createChannel(Object.assign({
                importance: 5,
                visibility: 1,
                vibration: true
              }, cfg))).catch(function () {});
            }));
          } catch (e) {
            channelPromise = Promise.resolve();
          }
          return Promise.resolve(channelPromise).catch(function () {}).then(function () {
            return Push.register();
          });
        }).catch(function (e) { clearTimeout(timer); finish(reject, e); });
      });
    });
  };
  // ── 4. Native full-screen job alert ──
  // Only the boda build ships this native plugin; everywhere else (storefront,
  // admin, employee, a normal browser, an older boda build) it's simply absent
  // and { available: false } lets pages skip the feature without checking anything else.
  var JobAlertPlugin = null;
  try {
    if (typeof cap.isPluginAvailable === 'function' && cap.isPluginAvailable('JobAlert')) JobAlertPlugin = getPlugin('JobAlert');
  } catch (e) { JobAlertPlugin = null; }
  window.SwiftApp.jobAlert = JobAlertPlugin ? {
    available: true,
    getStatus: function () { return JobAlertPlugin.getStatus(); },
    openOverlaySettings: function () { return JobAlertPlugin.openOverlaySettings(); },
    openFullScreenSettings: function () { return JobAlertPlugin.openFullScreenSettings(); },
    testAlert: function () { return JobAlertPlugin.testAlert(); },
    consumePendingAction: function () {
      return JobAlertPlugin.consumePendingAction().then(function (r) { return (r && r.action) || ''; });
    }
  } : { available: false };

  // ── 5. Native live location sharing (boda build only) ──
  // A foreground service uploads the rider's position even while the app is
  // minimised. Absent everywhere else, and in boda builds made before it existed.
  var LocationSharePlugin = null;
  try {
    if (typeof cap.isPluginAvailable === 'function' && cap.isPluginAvailable('LocationShare')) LocationSharePlugin = getPlugin('LocationShare');
  } catch (e) { LocationSharePlugin = null; }
  window.SwiftApp.locationShare = LocationSharePlugin ? {
    available: true,
    getStatus: function () { return LocationSharePlugin.getStatus(); },
    requestPermission: function () { return LocationSharePlugin.requestLocationPermission(); },
    start: function (opts) { return LocationSharePlugin.start(opts); },
    stop: function () { return LocationSharePlugin.stop(); },
    openLocationSettings: function () { return LocationSharePlugin.openLocationSettings(); },
    openAppSettings: function () { return LocationSharePlugin.openAppSettings(); }
  } : { available: false };
})();
