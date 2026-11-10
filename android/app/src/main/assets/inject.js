// Injected into music.youtube.com before the page's own scripts run.
// Talks to the app through window.TBAndroid (see Bridge.java).
(function () {
  if (window.__tunebox) return;
  window.__tunebox = true;
  var native = window.TBAndroid;

  // ------------------------------------------------ make patches look native
  var nativeToString = Function.prototype.toString;
  var disguised = new WeakMap();
  var fakeToString = function toString() {
    return disguised.has(this) ? nativeToString.call(disguised.get(this)) : nativeToString.call(this);
  };
  disguised.set(fakeToString, nativeToString);
  Function.prototype.toString = fakeToString;
  function patch(obj, key, make) {
    var orig = obj[key];
    var wrapped = make(orig);
    disguised.set(wrapped, orig);
    obj[key] = wrapped;
  }

  // ------------------------------------------------------------ ad pruning
  // Ads arrive inside the player's JSON; remove them before the player reads it.
  var AD_KEYS = ['adPlacements', 'adSlots', 'playerAds', 'adBreakHeartbeatParams', 'adBreakParams'];
  function stripOne(x) {
    if (!x || typeof x !== 'object') return;
    for (var i = 0; i < AD_KEYS.length; i++) if (AD_KEYS[i] in x) delete x[AD_KEYS[i]];
  }
  function prune(o) {
    if (!o || typeof o !== 'object') return o;
    stripOne(o);
    if (o.playerResponse) stripOne(o.playerResponse);
    if (Array.isArray(o)) o.forEach(function (x) { stripOne(x); if (x && x.playerResponse) stripOne(x.playerResponse); });
    return o;
  }
  patch(JSON, 'parse', function (orig) {
    return function parse() {
      var r = orig.apply(this, arguments);
      try { prune(r); } catch (e) { /* never break the page */ }
      return r;
    };
  });
  patch(Response.prototype, 'json', function (orig) {
    return function json() {
      return orig.call(this).then(function (r) { try { prune(r); } catch (e) {} return r; });
    };
  });
  ['ytInitialPlayerResponse', 'playerResponse'].forEach(function (name) {
    var value;
    try {
      Object.defineProperty(window, name, {
        configurable: true,
        get: function () { return value; },
        set: function (v) { value = prune(v); }
      });
    } catch (e) {}
  });

  // ------------------------------------------- background play, no AFK pause
  try {
    Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: function () { return false; } });
    Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get: function () { return 'visible'; } });
    document.addEventListener('visibilitychange', function (e) { e.stopImmediatePropagation(); }, true);
    window.addEventListener('pagehide', function (e) { e.stopImmediatePropagation(); }, true);
    window.addEventListener('blur', function (e) { e.stopImmediatePropagation(); }, true);
  } catch (e) {}
  setInterval(function () { try { window._lact = Date.now(); } catch (e) {} }, 30000);

  function player() { return document.getElementById('movie_player'); }

  // --------------------------------------- skip any ad that still gets through
  var mutedByUs = false;
  setInterval(function () {
    var p = player();
    var v = document.querySelector('video');
    if (!p || !v) return;
    var ad = p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting');
    if (ad) {
      if (!v.muted) { v.muted = true; mutedByUs = true; }
      if (isFinite(v.duration) && v.duration > 0 && v.currentTime < v.duration - 0.1) v.currentTime = v.duration;
      document.querySelectorAll('.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button, button[id^="skip-button"]')
        .forEach(function (b) { b.click(); });
    } else if (mutedByUs) {
      v.muted = false;
      mutedByUs = false;
    }
  }, 300);

  // ------------------------------------------- hide Premium upsells, "you there?"
  function addStyle() {
    if (document.getElementById('tb-style') || !document.head) return;
    var s = document.createElement('style');
    s.id = 'tb-style';
    s.textContent =
      'ytmusic-mealbar-promo-renderer, ytmusic-statement-banner-renderer, ytmusic-upsell-dialog-renderer,' +
      'ytmusic-premium-upsell-banner-renderer { display: none !important; }';
    document.head.appendChild(s);
  }
  setInterval(function () {
    addStyle();
    document.querySelectorAll('ytmusic-upsell-dialog-renderer, ytmusic-mealbar-promo-renderer').forEach(function (el) {
      var d = el.closest('tp-yt-paper-dialog');
      if (d) {
        d.remove();
        document.querySelectorAll('tp-yt-iron-overlay-backdrop').forEach(function (b) { b.remove(); });
      }
    });
    var you = document.querySelector('ytmusic-you-there-renderer');
    if (you && you.offsetParent !== null) {
      var btn = you.querySelector('button, yt-button-renderer, tp-yt-paper-button');
      if (btn) btn.click();
    }
  }, 1000);

  // ------------------------------------------------------------ SponsorBlock
  var segments = [];
  var segmentsFor = null;
  var adShowing = false;
  window.__tbSegments = function (videoId, list) {
    if (videoId === segmentsFor) segments = list || [];
  };
  setInterval(function () {
    if (!segments.length || adShowing) return;
    var v = document.querySelector('video');
    if (!v || v.paused) return;
    var t = v.currentTime;
    for (var i = 0; i < segments.length; i++) {
      var s = segments[i];
      if (t >= s.start && t < s.end - 0.3) {
        if (isFinite(v.duration) && s.end >= v.duration - 1) window.__tbControl('next');
        else v.currentTime = s.end;
        break;
      }
    }
  }, 250);

  // ------------------------------------------------------ now playing → app
  var lastKey = '';
  var lastSent = 0;
  setInterval(function () {
    if (!native) return;
    var p = player();
    if (!p || typeof p.getVideoData !== 'function') return;
    var data;
    try { data = p.getVideoData(); } catch (e) { return; }
    if (!data || !data.video_id) return;
    if (data.video_id !== segmentsFor) {
      segmentsFor = data.video_id;
      segments = [];
      native.requestSegments(data.video_id);
    }
    var md = navigator.mediaSession && navigator.mediaSession.metadata;
    var art = md && md.artwork && md.artwork.length ? md.artwork[md.artwork.length - 1].src : '';
    var st = typeof p.getPlayerState === 'function' ? p.getPlayerState() : -1;
    adShowing = p.classList.contains('ad-showing');
    var state = {
      videoId: data.video_id,
      title: (md && md.title) || data.title || '',
      artist: (md && md.artist) || data.author || '',
      album: (md && md.album) || '',
      artwork: art,
      position: p.getCurrentTime ? p.getCurrentTime() : 0,
      duration: p.getDuration ? p.getDuration() : 0,
      playing: (st === 1 || st === 3) && !adShowing
    };
    var key = JSON.stringify([state.videoId, state.title, state.artist, state.artwork, state.playing, Math.round(state.duration)]);
    if (key !== lastKey || Date.now() - lastSent > 5000) {
      lastKey = key;
      lastSent = Date.now();
      native.onState(JSON.stringify(state));
    }
  }, 1000);

  // ---------------------------------------------------------- remote control
  window.__tbControl = function (action, arg) {
    var p = player();
    if (!p) return;
    try {
      if (action === 'play') p.playVideo();
      else if (action === 'pause') p.pauseVideo();
      else if (action === 'toggle') (p.getPlayerState() === 1 ? p.pauseVideo() : p.playVideo());
      else if (action === 'next') p.nextVideo();
      else if (action === 'previous') p.previousVideo();
      else if (action === 'seek') p.seekTo(arg, true);
    } catch (e) {}
  };

  // ------------------------------------------------------ green Update button
  var update = null;
  var BTN_ID = 'tb-update-button';
  function label(s) {
    if (!s) return null;
    if (s.status === 'available') return { text: 'Update', busy: false };
    if (s.status === 'downloading') return { text: 'Updating… ' + (s.percent || 0) + '%', busy: true };
    if (s.status === 'ready') return { text: 'Install update', busy: false };
    if (s.status === 'error' && s.version) return { text: 'Retry update', busy: false };
    return null;
  }
  function icon() {
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('fill', 'currentColor');
    var path = document.createElementNS(NS, 'path');
    path.setAttribute('d', 'M12 3a1 1 0 0 1 1 1v9.59l3.3-3.3a1 1 0 1 1 1.4 1.42l-5 5a1 1 0 0 1-1.4 0l-5-5a1 1 0 1 1 1.4-1.42l3.3 3.3V4a1 1 0 0 1 1-1Zm-7 15a1 1 0 0 1 1 1v1h12v-1a1 1 0 1 1 2 0v2a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-2a1 1 0 0 1 1-1Z');
    svg.appendChild(path);
    return svg;
  }
  function renderButton() {
    var want = label(update);
    var btn = document.getElementById(BTN_ID);
    if (!want) { if (btn) btn.remove(); return; }
    if (!document.body) return;
    if (!btn) {
      btn = document.createElement('button');
      btn.id = BTN_ID;
      btn.type = 'button';
      btn.style.cssText = 'display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 14px;' +
        'border:0;border-radius:16px;background:#1ed760;color:#04210f;box-shadow:none;' +
        'font:600 13px/1 Roboto,sans-serif;white-space:nowrap;cursor:pointer;';
      btn.addEventListener('click', function () { if (native) native.installUpdate(); });
    }
    var host = document.querySelector('ytmusic-nav-bar #right-content');
    if (host) {
      btn.style.position = '';
      btn.style.order = '-1'; // left of Sign in / account, never off the edge
      btn.style.margin = '0 8px';
      btn.style.flexShrink = '0';
      if (btn.parentElement !== host) host.insertBefore(btn, host.firstChild);
    } else if (!btn.isConnected) {
      btn.style.position = 'fixed';
      btn.style.top = '10px';
      btn.style.right = '96px';
      btn.style.zIndex = '9999';
      document.body.appendChild(btn);
    }
    var key = want.busy + '|' + want.text;
    if (btn.dataset.key !== key) {
      btn.dataset.key = key;
      btn.replaceChildren();
      if (!want.busy) btn.appendChild(icon());
      var span = document.createElement('span');
      span.textContent = want.text;
      btn.appendChild(span);
    }
    btn.disabled = want.busy;
    btn.style.opacity = want.busy ? '0.85' : '1';
  }
  window.__tbUpdate = function (s) { update = s; renderButton(); };

  // ------------------------------------------------------ My Music button
  var LIB_ID = 'tb-library-button';
  function renderLibraryButton() {
    var host = document.querySelector('ytmusic-nav-bar #right-content');
    if (!host || !native) return;
    var btn = document.getElementById(LIB_ID);
    if (!btn) {
      btn = document.createElement('button');
      btn.id = LIB_ID;
      btn.type = 'button';
      btn.setAttribute('aria-label', 'My Music');
      btn.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;' +
        'padding:0;margin:0 4px;border:1px solid rgba(255,255,255,.25);border-radius:50%;background:transparent;' +
        'color:#fff;cursor:pointer;flex-shrink:0;order:-2;';
      var NS = 'http://www.w3.org/2000/svg';
      var svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('width', '20');
      svg.setAttribute('height', '20');
      svg.setAttribute('fill', 'currentColor');
      var p = document.createElementNS(NS, 'path');
      p.setAttribute('d', 'M12 3v10.6A4 4 0 1 0 14 17V7h4V3h-6Z');
      svg.appendChild(p);
      btn.appendChild(svg);
      btn.addEventListener('click', function () { native.openLibrary(); });
    }
    if (btn.parentElement !== host) host.insertBefore(btn, host.firstChild);
  }

  setInterval(function () { renderButton(); renderLibraryButton(); }, 2000);
  if (native) {
    try { update = JSON.parse(native.updateState()); } catch (e) {}
  }
})();
