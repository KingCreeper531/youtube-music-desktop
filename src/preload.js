// Preload for the YouTube Music window.
// Runs in an isolated world; injects `pageScript` into the page's own world
// before any of YouTube's scripts run.
const { ipcRenderer, contextBridge, webFrame } = require('electron');

let cfg = ipcRenderer.sendSync('tb:get-config');

// ============================================================================
// Page-world script. Must be self-contained: it is serialized and re-evaluated
// inside the page, so it can't reference anything outside this function.
// ============================================================================
function pageScript(initialCfg) {
  if (window.__tunebox) return;
  window.__tunebox = true;
  let cfg = initialCfg;

  const emit = (name, detail) =>
    document.dispatchEvent(new CustomEvent(name, { detail: JSON.stringify(detail) }));

  // Make patched functions look native to any integrity checks.
  const nativeToString = Function.prototype.toString;
  const disguised = new WeakMap();
  const fakeToString = function toString() {
    return disguised.has(this) ? nativeToString.call(disguised.get(this)) : nativeToString.call(this);
  };
  disguised.set(fakeToString, nativeToString);
  Function.prototype.toString = fakeToString;
  const patch = (obj, key, make) => {
    const orig = obj[key];
    const wrapped = make(orig);
    disguised.set(wrapped, orig);
    obj[key] = wrapped;
  };

  // --------------------------------------------------------------- ad pruning
  // Ads are delivered inside the player's JSON. Removing these keys before the
  // player reads them means it never knows there was an ad to play.
  const AD_KEYS = ['adPlacements', 'adSlots', 'playerAds', 'adBreakHeartbeatParams', 'adBreakParams'];
  let pruned = 0;
  const prune = (o) => {
    if (!cfg.adblock || !o || typeof o !== 'object') return o;
    const one = (x) => {
      if (!x || typeof x !== 'object') return;
      for (const k of AD_KEYS) {
        if (k in x) { delete x[k]; pruned++; }
      }
    };
    one(o);
    if (o.playerResponse) one(o.playerResponse);
    if (Array.isArray(o)) for (const x of o) { one(x); if (x && x.playerResponse) one(x.playerResponse); }
    return o;
  };

  patch(JSON, 'parse', (orig) => function parse(...args) {
    const r = orig.apply(this, args);
    try { prune(r); } catch { /* never break the page */ }
    return r;
  });
  patch(Response.prototype, 'json', (orig) => async function json() {
    const r = await orig.call(this);
    try { prune(r); } catch { /* ignore */ }
    return r;
  });
  for (const name of ['ytInitialPlayerResponse', 'playerResponse']) {
    let value;
    try {
      Object.defineProperty(window, name, {
        configurable: true,
        get: () => value,
        set: (v) => { value = prune(v); },
      });
    } catch { /* ignore */ }
  }

  // ------------------------------------------------- background play / no AFK
  try {
    Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get() { return cfg.noAfkPause ? false : this.webkitHidden; } });
    Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get() { return cfg.noAfkPause ? 'visible' : (this.webkitHidden ? 'hidden' : 'visible'); } });
    document.addEventListener('visibilitychange', (e) => { if (cfg.noAfkPause) e.stopImmediatePropagation(); }, true);
  } catch { /* ignore */ }
  setInterval(() => {
    if (cfg.noAfkPause && 'ytcfg' in window) {
      try { window._lact = Date.now(); } catch { /* ignore */ }
    }
  }, 30000);

  const player = () => document.getElementById('movie_player');

  // ------------------------------------------- fallback: skip anything left
  let mutedByUs = false;
  let lastAdLog = 0;
  setInterval(() => {
    const p = player();
    const video = document.querySelector('video');
    if (!p || !video) return;
    const adShowing = p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting');
    if (cfg.adblock && adShowing) {
      if (!video.muted) { video.muted = true; mutedByUs = true; }
      if (Number.isFinite(video.duration) && video.duration > 0 && video.currentTime < video.duration - 0.1) {
        video.currentTime = video.duration;
      }
      document.querySelectorAll('.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button, button[id^="skip-button"]')
        .forEach((b) => b.click());
      if (Date.now() - lastAdLog > 5000) { lastAdLog = Date.now(); emit('tb:ad', 'skipped'); }
    } else if (mutedByUs) {
      video.muted = false;
      mutedByUs = false;
    }
  }, 300);

  // -------------------------------------------------------- now-playing feed
  let lastPruned = 0;
  setInterval(() => {
    if (pruned !== lastPruned) { lastPruned = pruned; emit('tb:ad', 'removed from player data'); }
    const p = player();
    if (!p || typeof p.getVideoData !== 'function') return;
    let data;
    try { data = p.getVideoData(); } catch { return; }
    if (!data || !data.video_id) { emit('tb:state', null); return; }
    const md = navigator.mediaSession && navigator.mediaSession.metadata;
    const art = md && md.artwork && md.artwork.length ? md.artwork[md.artwork.length - 1].src : '';
    const state = typeof p.getPlayerState === 'function' ? p.getPlayerState() : -1;
    const adShowing = p.classList.contains('ad-showing');
    emit('tb:state', {
      videoId: data.video_id,
      title: (md && md.title) || data.title || '',
      artist: (md && md.artist) || data.author || '',
      album: (md && md.album) || '',
      artwork: art,
      currentTime: p.getCurrentTime ? p.getCurrentTime() : 0,
      duration: p.getDuration ? p.getDuration() : 0,
      // 1 = playing, 3 = buffering; everything else counts as paused
      paused: !(state === 1 || state === 3) || adShowing,
      adShowing,
    });
  }, 1000);

  // ----------------------------------------------------- remote control
  document.addEventListener('tb:control', (e) => {
    const p = player();
    if (!p) return;
    const action = e.detail;
    try {
      if (action === 'playpause') (p.getPlayerState() === 1 ? p.pauseVideo() : p.playVideo());
      else if (action === 'next') p.nextVideo();
      else if (action === 'previous') p.previousVideo();
    } catch { /* ignore */ }
  });
  document.addEventListener('tb:config', (e) => {
    try { cfg = JSON.parse(e.detail); } catch { /* ignore */ }
  });
}

contextBridge.executeInMainWorld({
  func: pageScript,
  args: [{ adblock: cfg.adblock, noAfkPause: cfg.noAfkPause }],
});

// ============================================================================
// Isolated-world side: DOM cleanup, SponsorBlock, bridge to the main process.
// ============================================================================

const UPSELL_CSS = `
  ytmusic-mealbar-promo-renderer,
  ytmusic-statement-banner-renderer,
  ytmusic-upsell-dialog-renderer,
  ytmusic-premium-upsell-banner-renderer,
  .ytmusic-popup-container ytmusic-mealbar-promo-renderer { display: none !important; }
`;
let upsellCssKey = null;
function applyCss() {
  if (cfg.hideUpsells && !upsellCssKey) {
    upsellCssKey = webFrame.insertCSS(UPSELL_CSS);
  } else if (!cfg.hideUpsells && upsellCssKey) {
    webFrame.removeInsertedCSS(upsellCssKey);
    upsellCssKey = null;
  }
}
applyCss();

// Close dialogs that only exist to sell Premium, and the "Are you still there?" prompt.
setInterval(() => {
  if (cfg.hideUpsells) {
    document.querySelectorAll('ytmusic-upsell-dialog-renderer, ytmusic-mealbar-promo-renderer').forEach((el) => {
      const dialog = el.closest('tp-yt-paper-dialog');
      if (dialog) {
        dialog.remove();
        document.querySelectorAll('tp-yt-iron-overlay-backdrop').forEach((b) => b.remove());
      }
    });
  }
  if (cfg.noAfkPause) {
    const youThere = document.querySelector('ytmusic-you-there-renderer');
    if (youThere && youThere.offsetParent !== null) {
      const btn = youThere.querySelector('button, yt-button-renderer, tp-yt-paper-button');
      if (btn) btn.click();
    }
  }
}, 1000);

// ----------------------------------------------------------- SponsorBlock
let segments = [];
let segmentsFor = null;
async function loadSegments(videoId) {
  if (videoId === segmentsFor) return;
  segmentsFor = videoId;
  segments = [];
  if (!cfg.sponsorBlock || !videoId) return;
  try {
    const res = await ipcRenderer.invoke('tb:segments', videoId);
    if (segmentsFor === videoId) segments = res || [];
  } catch { /* ignore */ }
}
setInterval(() => {
  if (!cfg.sponsorBlock || !segments.length || adShowing) return;
  const video = document.querySelector('video');
  if (!video || video.paused) return;
  const t = video.currentTime;
  for (const s of segments) {
    if (t >= s.start && t < s.end - 0.3) {
      // If the segment runs to the end, just skip to the next track.
      if (Number.isFinite(video.duration) && s.end >= video.duration - 1) {
        document.dispatchEvent(new CustomEvent('tb:control', { detail: 'next' }));
      } else {
        video.currentTime = s.end;
      }
      break;
    }
  }
}, 250);

// -------------------------------------------------------- now-playing bridge
let adShowing = false;
let lastSent = '';
let lastSentAt = 0;
document.addEventListener('tb:state', (e) => {
  let state = null;
  try { state = JSON.parse(e.detail); } catch { return; }
  adShowing = !!(state && state.adShowing);
  if (state) loadSegments(state.videoId);
  // Send when anything but the clock changes, or every 5s to correct drift.
  const key = state ? JSON.stringify({ ...state, currentTime: 0 }) : 'null';
  if (key !== lastSent || Date.now() - lastSentAt > 5000) {
    lastSent = key;
    lastSentAt = Date.now();
    ipcRenderer.send('tb:now-playing', state);
  }
});
document.addEventListener('tb:ad', (e) => {
  try { ipcRenderer.send('tb:ad-skipped', JSON.parse(e.detail)); } catch { /* ignore */ }
});

// ---------------------------------------------------------- green Update button
let updateState = null;
const UPDATE_BTN_ID = 'tb-update-button';
const DOWNLOAD_ICON_PATH = 'M12 3a1 1 0 0 1 1 1v9.59l3.3-3.3a1 1 0 1 1 1.4 1.42l-5 5a1 1 0 0 1-1.4 0l-5-5a1 1 0 1 1 1.4-1.42l3.3 3.3V4a1 1 0 0 1 1-1Zm-7 15a1 1 0 0 1 1 1v1h12v-1a1 1 0 1 1 2 0v2a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-2a1 1 0 0 1 1-1Z';
function makeIcon() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('fill', 'currentColor');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', DOWNLOAD_ICON_PATH);
  svg.appendChild(p);
  return svg;
}

function updateLabel(s) {
  if (!s) return null;
  if (s.status === 'available') return { text: 'Update', title: `Update to version ${s.version}`, busy: false };
  if (s.status === 'downloading') return { text: `Updating… ${s.percent || 0}%`, title: 'Downloading the update', busy: true };
  if (s.status === 'ready') return { text: 'Restart to update', title: `Version ${s.version} is ready`, busy: false };
  if (s.status === 'error' && s.version) return { text: 'Retry update', title: s.error || 'The update failed', busy: false };
  return null;
}

function renderUpdateButton() {
  const want = updateLabel(updateState);
  let btn = document.getElementById(UPDATE_BTN_ID);
  if (!want) { btn?.remove(); return; }

  if (!btn) {
    btn = document.createElement('button');
    btn.id = UPDATE_BTN_ID;
    btn.type = 'button';
    btn.style.cssText = [
      'display:inline-flex', 'align-items:center', 'gap:6px', 'height:36px', 'padding:0 16px',
      'margin:0 12px 0 0', 'border:0', 'border-radius:18px', 'background:#1ed760', 'color:#04210f',
      'font:600 14px/1 Roboto,"Segoe UI",sans-serif', 'cursor:pointer', 'white-space:nowrap',
      'box-shadow:none', 'transition:background .15s',
    ].join(';');
    btn.addEventListener('mouseenter', () => { if (!btn.disabled) btn.style.background = '#1bc456'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = '#1ed760'; });
    btn.addEventListener('click', () => ipcRenderer.send('tb:update-install'));
  }

  // Place it in the top bar, left of the cast / account buttons.
  const host = document.querySelector('ytmusic-nav-bar #right-content') || document.querySelector('ytmusic-nav-bar');
  if (host && btn.parentElement !== host) {
    host.insertBefore(btn, host.firstChild);
    btn.style.position = '';
  } else if (!host && !btn.isConnected && document.body) {
    btn.style.position = 'fixed';
    btn.style.top = '14px';
    btn.style.right = '200px';
    btn.style.zIndex = '9999';
    document.body.appendChild(btn);
  }

  const key = `${want.busy}|${want.text}`;
  if (btn.dataset.key !== key) {
    btn.dataset.key = key;
    btn.replaceChildren();
    if (!want.busy) btn.appendChild(makeIcon());
    const span = document.createElement('span');
    span.textContent = want.text;
    btn.appendChild(span);
  }
  btn.title = want.title;
  btn.disabled = want.busy;
  btn.style.cursor = want.busy ? 'default' : 'pointer';
  btn.style.opacity = want.busy ? '0.85' : '1';
}

ipcRenderer.on('tb:update', (_e, s) => { updateState = s; renderUpdateButton(); });
ipcRenderer.invoke('tb:update-get').then((s) => { updateState = s; renderUpdateButton(); }).catch(() => {});
// YouTube Music re-renders its top bar while you browse; keep the button in place.
setInterval(renderUpdateButton, 2000);

ipcRenderer.on('tb:control', (_e, action) => {
  document.dispatchEvent(new CustomEvent('tb:control', { detail: action }));
});
ipcRenderer.on('tb:config', (_e, next) => {
  cfg = next;
  applyCss();
  segmentsFor = null;
  document.dispatchEvent(new CustomEvent('tb:config', {
    detail: JSON.stringify({ adblock: cfg.adblock, noAfkPause: cfg.noAfkPause }),
  }));
});
