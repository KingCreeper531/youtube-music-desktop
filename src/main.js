const {
  app, BrowserWindow, session, ipcMain, Tray, Menu, nativeImage, shell, net, dialog,
} = require('electron');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const { DiscordPresence } = require('./discord');
const updater = require('./updater');

const YTM_URL = 'https://music.youtube.com/';
const PARTITION = 'persist:ytmusic';
const ICON = path.join(__dirname, '..', 'build', 'icon.png');

app.setAppUserModelId('local.tunebox.ytmusic');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

// Developer test hook: run a separate copy alongside the installed app
if (process.env.TUNEBOX_USER_DATA) app.setPath('userData', process.env.TUNEBOX_USER_DATA);

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let win = null;
let settingsWin = null;
let tray = null;
let quitting = false;
let blocker = null;
let nowPlaying = null;

const logFile = () => path.join(app.getPath('userData'), 'tunebox.log');
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  try { fs.appendFileSync(logFile(), line); } catch { /* ignore */ }
}

const discord = new DiscordPresence(log);

// ---------------------------------------------------------------- user agent
// Google refuses sign-in from browsers that announce themselves as Electron,
// so present a plain Chrome user agent.
function cleanUserAgent(ua) {
  return ua
    .replace(/\s?Electron\/\S+/i, '')
    .replace(new RegExp(`\\s?${app.getName()}\\/\\S+`, 'i'), '')
    .replace(/\s?tunebox\/\S+/i, '');
}

// Google blocks sign-in from embedded Chromium ("This browser or app may not be
// secure"). It accepts Firefox, so the sign-in window identifies as Firefox and
// drops Chromium-only client-hint headers.
const SIGNIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0';
const isGoogleAccounts = (url) => {
  try { return /^accounts\.google\.[a-z.]+$/.test(new URL(url).hostname); } catch { return false; }
};

function setupSignInHeaders(ses) {
  ses.webRequest.onBeforeSendHeaders({ urls: ['https://accounts.google.com/*', 'https://*.google.com/*'] }, (details, cb) => {
    const fromSignIn = signInWin && !signInWin.isDestroyed() && details.webContentsId === signInWin.webContents.id;
    if (!fromSignIn && !isGoogleAccounts(details.url)) return cb({ requestHeaders: details.requestHeaders });
    const headers = {};
    for (const [k, v] of Object.entries(details.requestHeaders)) {
      if (!/^sec-ch-ua/i.test(k)) headers[k] = v;
    }
    headers['User-Agent'] = SIGNIN_UA;
    cb({ requestHeaders: headers });
  });
}

// Google blocks password sign-in in embedded browsers, so by default we offer
// to reuse the YouTube sign-in the user already has in Firefox.
async function signInWithFirefox() {
  const { importInto } = require('./firefox-signin');
  let res;
  try {
    res = await importInto(session.fromPartition(PARTITION));
  } catch (e) {
    res = { ok: false, reason: e.message };
  }
  if (res.ok) {
    log(`Imported Firefox sign-in (${res.imported} cookies)`);
    if (signInWin && !signInWin.isDestroyed()) signInWin.close();
    win?.loadURL(YTM_URL);
    showWindow();
    return { ok: true };
  }
  log(`Firefox sign-in import failed: ${res.reason}`);
  await dialog.showMessageBox(win || undefined, {
    type: 'info',
    title: 'YouTube Music',
    message: res.reason === 'not-signed-in'
      ? 'Firefox isn\'t signed in to YouTube yet.'
      : 'Couldn\'t read your Firefox sign-in.',
    detail: res.reason === 'not-signed-in'
      ? 'Open music.youtube.com in Firefox, sign in there, then click "Sign in with Firefox" again.'
      : `Details: ${res.reason}`,
  });
  return { ok: false };
}

async function promptSignIn(url) {
  const { response } = await dialog.showMessageBox(win || undefined, {
    type: 'question',
    title: 'Sign in',
    message: 'Sign in with your Firefox account?',
    detail: 'Google blocks password sign-in inside apps. YouTube Music can reuse the YouTube sign-in you already have in Firefox. It stays on this PC.',
    buttons: ['Sign in with Firefox', 'Try Google sign-in page', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });
  if (response === 0) await signInWithFirefox();
  else if (response === 1) openSignIn(url);
}

let signInWin = null;
function openSignIn(url) {
  if (signInWin && !signInWin.isDestroyed()) { signInWin.focus(); return; }
  signInWin = new BrowserWindow({
    width: 520,
    height: 720,
    title: 'Sign in — YouTube Music',
    icon: ICON,
    parent: win || undefined,
    backgroundColor: '#202124',
    autoHideMenuBar: true,
    webPreferences: {
      partition: PARTITION,
      preload: path.join(__dirname, 'signin-preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  signInWin.setMenuBarVisibility(false);
  signInWin.webContents.setUserAgent(SIGNIN_UA);
  signInWin.webContents.setWindowOpenHandler(({ url: u }) => {
    signInWin.loadURL(u);
    return { action: 'deny' };
  });
  // Once Google sends us back to YouTube Music, sign-in is done.
  signInWin.webContents.on('did-navigate', (_e, u) => {
    try {
      if (new URL(u).hostname === 'music.youtube.com') {
        signInWin.close();
        win?.loadURL(YTM_URL);
        log('Signed in');
      }
    } catch { /* ignore */ }
  });
  signInWin.on('closed', () => { signInWin = null; });
  signInWin.loadURL(url);
}

// ---------------------------------------------------------------- ad blocking
async function setupNetworkBlocking(ses) {
  const { ElectronBlocker } = require('@ghostery/adblocker-electron');
  const cachePath = path.join(app.getPath('userData'), 'adblock-engine.bin');
  try {
    blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(net.fetch.bind(net), {
      path: cachePath,
      read: fs.promises.readFile,
      write: fs.promises.writeFile,
    });
    if (config.get('networkBlocking')) blocker.enableBlockingInSession(ses);
    let count = 0;
    blocker.on('request-blocked', () => { count++; });
    setInterval(() => { if (count) { log(`Network blocker: ${count} requests blocked so far`); } }, 5 * 60 * 1000);
    log('Network ad/tracker blocking ready');
  } catch (e) {
    log(`Network blocking unavailable: ${e.message}`);
  }
}

// ---------------------------------------------------------------- main window
function createWindow() {
  const cfg = config.load();
  const ses = session.fromPartition(PARTITION);
  ses.setUserAgent(cleanUserAgent(ses.getUserAgent()));

  win = new BrowserWindow({
    ...cfg.bounds,
    minWidth: 400,
    minHeight: 300,
    title: 'YouTube Music',
    icon: ICON,
    backgroundColor: '#030303',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      partition: PARTITION,
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,   // keep playing smoothly when minimized
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  win.setMenuBarVisibility(false);
  if (cfg.maximized) win.maximize();

  win.once('ready-to-show', () => win.show());

  // Keep the YTM page title out of the taskbar; show song instead
  win.on('page-title-updated', (e) => {
    e.preventDefault();
  });

  const saveBounds = () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMaximized() || win.isMinimized() || win.isFullScreen()) {
      config.set({ maximized: win.isMaximized() });
    } else {
      config.set({ bounds: win.getBounds(), maximized: false });
    }
  };
  let boundsTimer;
  win.on('resize', () => { clearTimeout(boundsTimer); boundsTimer = setTimeout(saveBounds, 500); });
  win.on('move', () => { clearTimeout(boundsTimer); boundsTimer = setTimeout(saveBounds, 500); });

  win.on('close', (e) => {
    saveBounds();
    if (!quitting && config.get('closeToTray')) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => { win = null; });

  // Links that leave YouTube Music / Google sign-in open in the default browser
  const internal = (url) => {
    try {
      const h = new URL(url).hostname;
      return /(^|\.)(youtube\.com|google\.com|youtube-nocookie\.com|gstatic\.com|googleusercontent\.com|accounts\.google\.[a-z.]+)$/.test(h);
    } catch { return false; }
  };
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isGoogleAccounts(url)) {
      promptSignIn(url);
    } else if (internal(url)) {
      win.loadURL(url);
    } else {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  // Route Google sign-in (link click or server redirect) to the sign-in window
  const toSignIn = (e, url) => {
    if (isGoogleAccounts(url)) {
      e.preventDefault();
      promptSignIn(url);
      return true;
    }
    return false;
  };
  win.webContents.on('will-redirect', (e, url) => { toSignIn(e, url); });
  win.webContents.on('will-navigate', (e, url) => {
    if (toSignIn(e, url)) return;
    if (!internal(url)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });
  // youtube.com (non-music) pages after sign-in → bounce back to music
  win.webContents.on('did-navigate', (_e, url) => {
    try {
      const u = new URL(url);
      if (u.hostname === 'www.youtube.com' && (u.pathname === '/' || u.pathname === '/feed/home')) {
        win.loadURL(YTM_URL);
      }
    } catch { /* ignore */ }
  });

  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F5' || (input.control && input.key.toLowerCase() === 'r')) win.webContents.reload();
    if (input.key === 'F12') win.webContents.toggleDevTools();
    if (input.control && input.key === ',') openSettings();
    if (input.alt && input.key === 'ArrowLeft' && win.webContents.navigationHistory.canGoBack()) win.webContents.navigationHistory.goBack();
    if (input.alt && input.key === 'ArrowRight' && win.webContents.navigationHistory.canGoForward()) win.webContents.navigationHistory.goForward();
  });

  // Developer test hooks (not used in normal runs)
  if (process.env.TUNEBOX_MUTE) win.webContents.setAudioMuted(true);
  win.loadURL(process.env.TUNEBOX_START_URL || YTM_URL);
}

function showWindow() {
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// ---------------------------------------------------------------- settings
function openSettings() {
  if (settingsWin) { settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 520,
    height: 720,
    resizable: true,
    title: 'YouTube Music Settings',
    icon: ICON,
    backgroundColor: '#121212',
    autoHideMenuBar: true,
    parent: win || undefined,
    webPreferences: {
      preload: path.join(__dirname, 'settings-preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  settingsWin.setMenuBarVisibility(false);
  settingsWin.loadFile(path.join(__dirname, 'settings.html'));
  settingsWin.on('closed', () => { settingsWin = null; });
}

// ---------------------------------------------------------------- tray
function sendControl(action) {
  win?.webContents.send('tb:control', action);
}

function updateTray() {
  if (!tray) return;
  const np = nowPlaying;
  const label = np?.title ? `${np.title} — ${np.artist || ''}`.slice(0, 60) : 'Nothing playing';
  tray.setToolTip(np?.title ? `YouTube Music\n${label}` : 'YouTube Music');
  const up = updater.getState();
  const updateItems = up.status === 'available' || up.status === 'ready'
    ? [{ label: `Update to v${up.version}`, click: () => updater.install() }, { type: 'separator' }]
    : [];
  tray.setContextMenu(Menu.buildFromTemplate([
    ...updateItems,
    { label, enabled: false },
    { type: 'separator' },
    { label: np && !np.paused ? 'Pause' : 'Play', click: () => sendControl('playpause'), enabled: !!np },
    { label: 'Next', click: () => sendControl('next'), enabled: !!np },
    { label: 'Previous', click: () => sendControl('previous'), enabled: !!np },
    { type: 'separator' },
    { label: 'Show YouTube Music', click: showWindow },
    { label: 'Sign in with Firefox', click: () => signInWithFirefox() },
    { label: 'Settings…', click: openSettings },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
}

function createTray() {
  const img = nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.on('click', () => {
    if (win && win.isVisible() && win.isFocused()) win.hide();
    else showWindow();
  });
  updateTray();
}

// ---------------------------------------------------------------- now playing → Discord
function buildActivity(np) {
  if (!np || !np.title) return null;
  if (np.paused && config.get('discordHidePaused')) return null;

  const fit = (s, fallback) => {
    s = String(s || '').trim() || fallback;
    if (s.length < 2) s += '⠀';
    return s.length > 128 ? `${s.slice(0, 125)}...` : s;
  };

  const activity = {
    type: 2, // "Listening to"
    status_display_type: 2, // member list shows the song title
    details: fit(np.title, 'Unknown song'),
    state: fit(np.artist, 'Unknown artist'),
    assets: {
      large_image: np.artwork && /^https:\/\//.test(np.artwork) ? np.artwork : 'https://music.youtube.com/img/favicon_144.png',
      // While paused, the line under the artist reads "(Paused)" and the timer is hidden
      large_text: np.paused ? '(Paused)' : fit(np.album || np.title, 'YouTube Music'),
    },
    instance: false,
  };

  if (!np.paused && np.duration > 0 && np.duration < 24 * 3600) {
    const start = Date.now() - Math.round(np.currentTime * 1000);
    activity.timestamps = {
      // round to the second so tiny jitter doesn't trigger updates
      start: Math.round(start / 1000) * 1000,
      end: Math.round((start + np.duration * 1000) / 1000) * 1000,
    };
  }

  if (config.get('discordShowButton') && np.videoId) {
    activity.buttons = [{ label: 'Listen on YouTube Music', url: `https://music.youtube.com/watch?v=${np.videoId}` }];
  }
  return activity;
}

let lastStartSent = 0;
function onNowPlaying(np) {
  const prev = nowPlaying;
  nowPlaying = np;

  const trackChanged = !prev || prev.videoId !== np?.videoId || prev.title !== np?.title;
  const pauseChanged = !prev || prev.paused !== np?.paused;

  if (trackChanged || pauseChanged) {
    log(np?.title ? `Now playing: "${np.title}" by ${np.artist} [${np.paused ? 'paused' : 'playing'}] ${Math.round(np.duration)}s` : 'Nothing playing');
    updateTray();
    if (win) win.setTitle(np?.title ? `${np.title} — ${np.artist || ''} · YouTube Music` : 'YouTube Music');
  }

  const activity = buildActivity(np);
  // Only resend for a seek if the start time moved more than 3 seconds.
  if (!trackChanged && !pauseChanged && activity?.timestamps) {
    if (Math.abs(activity.timestamps.start - lastStartSent) < 3000) return;
  }
  if (activity?.timestamps) lastStartSent = activity.timestamps.start;
  discord.setActivity(activity);
}

// ---------------------------------------------------------------- SponsorBlock
const sbCache = new Map();
async function getSegments(videoId) {
  if (!config.get('sponsorBlock') || !/^[\w-]{11}$/.test(videoId || '')) return [];
  const cats = config.get('sponsorCategories') || ['music_offtopic'];
  const key = `${videoId}|${cats.join(',')}`;
  if (sbCache.has(key)) return sbCache.get(key);
  let segments = [];
  try {
    const url = `https://sponsor.ajay.app/api/skipSegments?videoID=${videoId}&categories=${encodeURIComponent(JSON.stringify(cats))}`;
    const res = await net.fetch(url);
    if (res.ok) {
      const data = await res.json();
      segments = data.map((s) => ({ start: s.segment[0], end: s.segment[1], category: s.category }));
    }
  } catch { /* offline or no segments */ }
  sbCache.set(key, segments);
  if (sbCache.size > 300) sbCache.delete(sbCache.keys().next().value);
  return segments;
}

// ---------------------------------------------------------------- IPC
ipcMain.on('tb:get-config', (e) => { e.returnValue = config.load(); });
ipcMain.on('tb:now-playing', (_e, np) => onNowPlaying(np));
ipcMain.on('tb:ad-skipped', (_e, how) => log(`Ad handled (${how})`));
ipcMain.handle('tb:segments', (_e, videoId) => getSegments(videoId));
ipcMain.handle('tb:settings-get', () => ({ config: config.load(), discordStatus: discord.status, version: app.getVersion() }));
ipcMain.handle('tb:settings-set', (_e, patch) => { config.set(patch); return { config: config.load(), discordStatus: discord.status }; });
ipcMain.handle('tb:open-external', (_e, url) => {
  if (/^https:\/\/(discord\.com|sponsor\.ajay\.app)\//.test(url)) shell.openExternal(url);
});
ipcMain.handle('tb:firefox-signin', () => signInWithFirefox());
ipcMain.handle('tb:update-get', () => updater.getState());
ipcMain.handle('tb:update-check', () => updater.check());
ipcMain.on('tb:update-install', () => updater.install());
ipcMain.handle('tb:clear-data', async () => {
  await session.fromPartition(PARTITION).clearStorageData();
  win?.loadURL(YTM_URL);
});

config.onChange((cfg, before) => {
  if (cfg.discord !== before.discord) discord.setEnabled(cfg.discord);
  if (cfg.discordClientId !== before.discordClientId) discord.setClientId(cfg.discordClientId);
  if (cfg.discordHidePaused !== before.discordHidePaused || cfg.discordShowButton !== before.discordShowButton) {
    discord.setActivity(buildActivity(nowPlaying));
  }
  if (cfg.networkBlocking !== before.networkBlocking && blocker) {
    const ses = session.fromPartition(PARTITION);
    if (cfg.networkBlocking && !blocker.isBlockingEnabled(ses)) blocker.enableBlockingInSession(ses);
    if (!cfg.networkBlocking && blocker.isBlockingEnabled(ses)) blocker.disableBlockingInSession(ses);
  }
  const pageAffecting = ['adblock', 'hideUpsells', 'sponsorBlock', 'noAfkPause', 'sponsorCategories'];
  if (pageAffecting.some((k) => JSON.stringify(cfg[k]) !== JSON.stringify(before[k]))) {
    sbCache.clear();
    win?.webContents.send('tb:config', cfg);
  }
});

// ---------------------------------------------------------------- app lifecycle
app.on('second-instance', showWindow);

app.whenReady().then(async () => {
  const ses = session.fromPartition(PARTITION);
  // Grant media keys / notifications etc. but nothing exotic
  ses.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(['media', 'mediaKeySystem', 'notifications', 'fullscreen', 'clipboard-sanitized-write'].includes(permission));
  });

  setupSignInHeaders(ses);
  await setupNetworkBlocking(ses);
  createWindow();
  createTray();

  discord.setClientId(config.get('discordClientId'));
  discord.setEnabled(config.get('discord'));
  updater.init({
    logger: log,
    onChange: (state) => {
      win?.webContents.send('tb:update', state);
      settingsWin?.webContents.send('tb:update', state);
      updateTray();
    },
    beforeInstall: () => {
      quitting = true;
      discord.setEnabled(false);
    },
  });
  if (!config.get('firstRunDone')) {
    config.set({ firstRunDone: true });
    win.webContents.once('did-finish-load', () => setTimeout(openSettings, 1500));
  }
  log(`YouTube Music ${app.getVersion()} started (Electron ${process.versions.electron})`);
});

app.on('before-quit', () => {
  quitting = true;
  discord.setEnabled(false);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && (quitting || !config.get('closeToTray'))) app.quit();
});
