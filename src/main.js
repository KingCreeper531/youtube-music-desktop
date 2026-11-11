const {
  app, BrowserWindow, WebContentsView, session, ipcMain, Tray, Menu, nativeImage, shell, net, dialog,
} = require('electron');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const config = require('./config');
const { DiscordPresence } = require('./discord');
const updater = require('./updater');
const library = require('./library');
const spotify = require('./spotify');
const playlists = require('./playlists');
const ytmSearch = require('./ytm-search');

library.registerScheme(); // must happen before the app is ready

const YTM_URL = 'https://music.youtube.com/';
const PARTITION = 'persist:ytmusic';
const ICON = path.join(__dirname, '..', 'build', 'icon.png');

const APP_ID = 'local.tunebox.ytmusic';
app.setAppUserModelId(APP_ID);

// Keep the Start Menu shortcut (what Windows search finds) in place; it can go
// missing after updates or cleanups. The desktop shortcut is only added once,
// so if you delete it, it stays deleted.
function ensureShortcuts() {
  if (process.platform !== 'win32' || !app.isPackaged || process.env.PORTABLE_EXECUTABLE_DIR) return;
  const opts = {
    target: process.execPath,
    cwd: path.dirname(process.execPath),
    description: 'YouTube Music',
    icon: process.execPath,
    iconIndex: 0,
    appUserModelId: APP_ID,
  };
  const fix = (lnk) => {
    let current = null;
    try { current = shell.readShortcutLink(lnk); } catch { /* missing */ }
    const ok = current
      && path.resolve(current.target).toLowerCase() === path.resolve(process.execPath).toLowerCase()
      && current.appUserModelId === APP_ID;
    if (!ok) {
      try {
        fs.mkdirSync(path.dirname(lnk), { recursive: true });
        shell.writeShortcutLink(lnk, current ? 'replace' : 'create', opts);
        log(`${current ? 'Repaired' : 'Created'} shortcut: ${lnk}`);
      } catch (e) { log(`Shortcut failed (${lnk}): ${e.message}`); }
    }
  };
  fix(path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'YouTube Music.lnk'));
  if (!config.get('desktopShortcutDone')) {
    fix(path.join(app.getPath('desktop'), 'YouTube Music.lnk'));
    config.set({ desktopShortcutDone: true });
  }
}
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

// "Closed to tray" = no app window is visible.
function isClosedToTray() {
  return !BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isVisible());
}
function onWindowHiddenChanged() {
  // Re-evaluate the Discord status (paused + hidden → cleared)
  setImmediate(() => discord.setActivity(buildActivity(nowPlaying)));
}

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
  const msg = {
    'no-firefox': ['Firefox isn\'t installed on this PC.',
      'Google doesn\'t allow signing in inside apps, so this app borrows your sign-in from Firefox (or Zen, LibreWolf, Waterfox or Floorp).\n\nInstall Firefox from firefox.com, sign in at music.youtube.com there, then click "Sign in with Firefox" again. You can also try "Try Google sign-in page".'],
    'not-signed-in': ['Firefox isn\'t signed in to YouTube.',
      'Open music.youtube.com in Firefox, sign in there, then click "Sign in with Firefox" again.\n\nKeep Firefox signed in afterwards: signing out of YouTube in Firefox signs this app out too.'],
  }[res.reason] || ['Couldn\'t read your Firefox sign-in.', `Close Firefox and try again.\n\nDetails: ${res.reason}`];
  const { response } = await dialog.showMessageBox(win || undefined, {
    type: 'info',
    title: 'YouTube Music',
    message: msg[0],
    detail: msg[1],
    buttons: ['OK', 'Try Google sign-in page'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (response === 1) openSignIn('https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fmusic.youtube.com%2F');
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
      onWindowHiddenChanged();
      if (!config.get('trayHintShown') && tray) {
        config.set({ trayHintShown: true });
        tray.displayBalloon({
          iconType: 'info',
          title: 'YouTube Music is still running',
          content: 'It keeps playing in the background. Right-click the tray icon and choose Quit to close it completely.',
        });
      }
    }
  });
  win.on('show', onWindowHiddenChanged);
  win.on('hide', onWindowHiddenChanged);
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
    if (input.control && input.key.toLowerCase() === 'l') openLibrary();
    if (input.control && input.key.toLowerCase() === 'i') openPlaylists();
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
  if (queue && (action === 'next' || action === 'previous')) queueStep(action === 'next' ? 1 : -1);
  else if (activeSource === 'local' && libraryView) libraryView.webContents.send('lib:control', action);
  else win?.webContents.send('tb:control', action);
}

// ---------------------------------------------------------------- imported playlist queue
// Plays an imported playlist's matched songs in order. Each entry is either a
// YouTube Music song ("y:<videoId>", played in the main window) or one of your
// own files ("l:<id>", played by the My Music player).
let queue = null; // { playlistId, name, keys, index, advancing, exitTimer }
const currentKey = () => (queue ? queue.keys[queue.index] : null);
const isLocalKey = (k) => !!k && k.startsWith('l:');

function setQueueFlag() {
  const k = currentKey();
  win?.webContents.send('tb:queue', !!queue && !isLocalKey(k));
  libraryView?.webContents.send('lib:queue', !!queue && isLocalKey(k));
  const q = queue && { playlistId: queue.playlistId, key: k };
  playlistsWin?.webContents.send('pl:queue', q);
}

function leaveQueue(why) {
  if (!queue) return;
  clearTimeout(queue.exitTimer);
  queue = null;
  setQueueFlag();
  log(why);
}

function playPlaylist({ id, key, shuffle }) {
  let keys = playlists.keys(id);
  if (!keys.length) return false;
  if (shuffle) {
    for (let i = keys.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [keys[i], keys[j]] = [keys[j], keys[i]]; }
  }
  let index = key ? Math.max(0, keys.indexOf(key)) : 0;
  if (shuffle && key) { keys = [keys[index], ...keys.filter((_, i) => i !== index)]; index = 0; }
  if (queue) clearTimeout(queue.exitTimer);
  queue = { playlistId: id, name: playlists.get(id)?.name, keys, index, advancing: true, exitTimer: null };
  queueLoad();
  log(`Playing imported playlist "${queue.name}" (${keys.length} songs)`);
  return true;
}

async function queueLoad() {
  const k = currentKey();
  queue.advancing = true; // ignore stray songs until the requested one is playing
  clearTimeout(queue.exitTimer);
  queue.exitTimer = null;
  if (isLocalKey(k)) {
    if (ytmNp && !ytmNp.paused) win?.webContents.send('tb:control', 'pause');
    activeSource = 'local';
    const lw = await ensureLibrary();
    lw.webContents.send('lib:control', `playid:${k.slice(2)}`);
  } else {
    if (localNp && !localNp.paused) libraryView?.webContents.send('lib:control', 'pause');
    activeSource = 'ytm';
    if (!win) createWindow();
    win.loadURL(`https://music.youtube.com/watch?v=${k.slice(2)}`);
  }
  setQueueFlag();
}

function queueStep(dir) {
  if (!queue) return;
  const k = currentKey();
  if (dir < 0) { // like a normal player: restart the song first
    if (isLocalKey(k) && localNp && localNp.currentTime > 3) { libraryView?.webContents.send('lib:control', 'restart'); return; }
    if (!isLocalKey(k) && ytmNp && ytmNp.currentTime > 3) { win?.webContents.send('tb:control', 'restart'); return; }
  }
  const next = queue.index + dir;
  if (next >= queue.keys.length) { // finished: YouTube Music carries on with its own radio
    leaveQueue('Imported playlist finished');
    return;
  }
  queue.index = Math.max(0, next);
  queueLoad();
}

/** YouTube Music reported a song. */
// ---------------------------------------------------------------- Song | Video switch
const counterpartCache = new Map();

async function switchVersion(info) {
  const { videoId, title, artist, type } = info || {};
  if (!/^[\w-]{11}$/.test(videoId || '') || !['song', 'video'].includes(type)) return { ok: false };
  let other = counterpartCache.get(videoId);
  if (other === undefined) {
    try {
      other = await ytmSearch.findCounterpart({ videoId, title: String(title || ''), artist: String(artist || ''), type }, net.fetch.bind(net));
    } catch {
      return { ok: false };
    }
    counterpartCache.set(videoId, other);
    if (other) counterpartCache.set(other.videoId, { ...info, videoId }); // switching back is instant
  }
  if (!other) return { ok: false };
  const t = Math.max(0, Number(info.currentTime) || 0);
  // Inside an imported playlist, the other version takes this song's place
  if (queue && currentKey() === `y:${videoId}`) {
    queue.keys[queue.index] = `y:${other.videoId}`;
    queue.advancing = true;
    setQueueFlag();
  }
  log(`Switched ${type === 'song' ? 'song → video' : 'video → song'}: "${title}"`);
  // Play the other version in place, starting at the same moment
  win?.webContents.send('tb:control', `load:${other.videoId}:${Math.floor(t)}`);
  return { ok: true, videoId: other.videoId };
}

function queueOnState(np) {
  if (!queue || !np?.videoId) return;
  const k = currentKey();
  if (isLocalKey(k)) {
    // The playlist is on one of your files; starting something in YouTube Music ends the playlist
    if (!np.paused && !queue.advancing) leaveQueue('Left imported playlist');
    return;
  }
  const yk = `y:${np.videoId}`;
  if (yk === k) { queue.advancing = false; return; }
  if (queue.advancing || queue.exitTimer) return;
  const at = queue.keys.indexOf(yk);
  if (at >= 0) { queue.index = at; setQueueFlag(); return; } // moved within the playlist
  // A song outside the playlist started. If that's YouTube Music's autoplay after
  // our song ended, the "ended" signal arrives within a moment; otherwise you
  // picked something else, so stop following the playlist.
  const q = queue;
  q.exitTimer = setTimeout(() => { if (queue === q) leaveQueue('Left imported playlist'); }, 2000);
}

/** My Music reported a song. */
function queueOnLocalState(np) {
  if (!queue || !np?.id) return;
  if (`l:${np.id}` === currentKey()) queue.advancing = false;
}

function queueOnEnded(videoId) {
  if (!queue || `y:${videoId}` !== currentKey()) return;
  clearTimeout(queue.exitTimer);
  queue.exitTimer = null;
  queueStep(1);
}

function queueOnLocalEnded(id) {
  if (queue && `l:${id}` === currentKey()) queueStep(1);
}

/** Makes sure the My Music player exists (hidden if it wasn't open) and has loaded. */
function ensureLibrary() {
  if (libraryView && !libraryView.webContents.isLoading()) return Promise.resolve(libraryView);
  if (!libraryView) openLibrary({ show: false });
  return new Promise((resolve) => libraryView.webContents.once('did-finish-load', () => resolve(libraryView)));
}

// ---------------------------------------------------------------- Playlists window
let playlistsWin = null;
function openPlaylists() {
  if (playlistsWin) { playlistsWin.show(); playlistsWin.focus(); return; }
  playlistsWin = new BrowserWindow({
    width: 1040,
    height: 700,
    minWidth: 640,
    minHeight: 420,
    title: 'Playlists',
    icon: ICON,
    backgroundColor: '#030303',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'playlists-preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  playlistsWin.setMenuBarVisibility(false);
  playlistsWin.loadFile(path.join(__dirname, 'playlists.html'));
  playlistsWin.webContents.on('will-navigate', (e) => e.preventDefault());
  playlistsWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\/(developer\.spotify\.com|exportify\.app|www\.spotify\.com|support\.spotify\.com)\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  playlistsWin.on('closed', () => { playlistsWin = null; });
}

// ---------------------------------------------------------------- My Music
// Part of the YouTube Music window: a panel over the page, just below YouTube
// Music's top bar. Leaving it only hides it, so your song keeps playing.
let libraryView = null;
let libraryShown = false;
let navBarHeight = 64; // CSS pixels; the page reports the real value

function layoutLibrary() {
  if (!libraryView || !win) return;
  const [w, h] = win.getContentSize();
  const top = Math.round(navBarHeight * win.webContents.getZoomFactor());
  libraryView.setBounds({ x: 0, y: top, width: w, height: Math.max(0, h - top) });
}

function createLibraryView() {
  if (!win) createWindow();
  libraryView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'library-preload.js'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false, // keep playing while hidden
      autoplayPolicy: 'no-user-gesture-required', // playlists can start your files without a click
    },
  });
  libraryView.setBackgroundColor('#030303');
  libraryView.setVisible(false);
  win.contentView.addChildView(libraryView);
  libraryView.webContents.loadFile(path.join(__dirname, 'library.html'));
  // Files dropped outside the drop zone must not navigate the panel away
  libraryView.webContents.on('will-navigate', (e) => e.preventDefault());
  libraryView.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'Escape' || (input.control && input.key.toLowerCase() === 'l')) { e.preventDefault(); hideLibrary(); }
    else if (input.control && input.key === ',') openSettings();
    else if (input.control && input.key.toLowerCase() === 'i') openPlaylists();
  });
  win.on('resize', layoutLibrary);
  win.once('closed', () => { libraryView = null; libraryShown = false; });
  layoutLibrary();
}

function openLibrary({ show = true } = {}) {
  if (!libraryView) createLibraryView();
  if (!show) return;
  showWindow();
  layoutLibrary();
  libraryView.setVisible(true);
  libraryShown = true;
  libraryView.webContents.focus();
  sendLibraryState();
}

function hideLibrary() {
  if (!libraryView || !libraryShown) return;
  libraryView.setVisible(false);
  libraryShown = false;
  win?.webContents.focus();
  sendLibraryState();
}

function toggleLibrary() {
  if (libraryShown) hideLibrary(); else openLibrary();
}

// Tells the page's My Music button whether the panel is open and what's playing
function sendLibraryState() {
  win?.webContents.send('tb:library-state', {
    open: libraryShown,
    playing: !!(localNp && !localNp.paused),
    title: localNp?.title || '',
    artist: localNp?.artist || '',
  });
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
    { label: 'My Music', click: openLibrary },
    { label: 'Playlists (Spotify import)', click: openPlaylists },
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
  // Paused with the window closed to the tray: you're not listening, so clear the status
  if (np.paused && isClosedToTray()) return null;

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

// Two sources can play: YouTube Music (the main window) and My Music (local files).
// Whichever started playing most recently is "active"; starting one pauses the other.
let ytmNp = null;
let localNp = null;
let activeSource = 'ytm';

function onYtmState(np) {
  ytmNp = np;
  queueOnState(np);
  if (np && !np.paused) {
    if (localNp && !localNp.paused) libraryView?.webContents.send('lib:control', 'pause');
    activeSource = 'ytm';
  }
  if (activeSource === 'ytm') onNowPlaying(np);
}

function onLocalState(np) {
  const wasPlaying = !!(localNp && !localNp.paused);
  const oldTitle = localNp?.title;
  localNp = np;
  queueOnLocalState(np);
  // Keep the My Music button in the top bar showing what's playing
  if (wasPlaying !== !!(np && !np.paused) || oldTitle !== np?.title) sendLibraryState();
  if (np && !np.paused) {
    if (ytmNp && !ytmNp.paused) win?.webContents.send('tb:control', 'pause');
    activeSource = 'local';
  }
  if (!np && activeSource === 'local') {
    activeSource = 'ytm';
    onNowPlaying(ytmNp);
    return;
  }
  if (activeSource === 'local') onNowPlaying(np);
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
    if (win && activeSource === 'ytm') win.setTitle(np?.title ? `${np.title} — ${np.artist || ''} · YouTube Music` : 'YouTube Music');
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
ipcMain.on('tb:now-playing', (_e, np) => onYtmState(np));
ipcMain.on('tb:open-library', () => toggleLibrary());
ipcMain.on('lib:close', () => hideLibrary());
ipcMain.on('tb:navbar-height', (_e, h) => { const n = Number(h); if (n > 20 && n < 200 && n !== navBarHeight) { navBarHeight = n; layoutLibrary(); } });
ipcMain.handle('tb:library-state', () => ({ open: libraryShown, playing: !!(localNp && !localNp.paused), title: localNp?.title || '', artist: localNp?.artist || '' }));
ipcMain.on('tb:open-playlists', () => openPlaylists());
ipcMain.on('tb:ended', (_e, videoId) => queueOnEnded(videoId));
ipcMain.on('tb:queue-step', (_e, dir) => queueStep(dir > 0 ? 1 : -1));
ipcMain.handle('tb:queue-get', () => !!queue);

// Imported playlists
ipcMain.handle('pl:list', () => playlists.list());
ipcMain.handle('pl:get', (_e, id) => playlists.get(String(id)));
ipcMain.handle('pl:remove', (_e, id) => { if (queue?.playlistId === id) { queue = null; setQueueFlag(); } playlists.remove(String(id)); });
ipcMain.handle('pl:rename', (_e, id, name) => playlists.rename(String(id), String(name)));
ipcMain.handle('pl:retry', (_e, id) => playlists.retry(String(id)));
// Upload My Music songs to your YouTube Music library (its own uploads feature).
// Uploaded songs show up in Library > Uploads and work in any YouTube Music playlist.
const uploadWaits = new Map();
ipcMain.on('tb:upload-result', (_e, res) => {
  const done = uploadWaits.get(res?.reqId);
  if (done) { uploadWaits.delete(res.reqId); done(res); }
});
function dropOnPage(files) {
  return new Promise((resolve) => {
    const reqId = crypto.randomUUID();
    const timer = setTimeout(() => { uploadWaits.delete(reqId); resolve({ ok: false, error: 'YouTube Music didn\'t respond' }); }, 20000);
    uploadWaits.set(reqId, (res) => { clearTimeout(timer); resolve(res); });
    win.webContents.send('tb:upload-files', { reqId, files });
  });
}
ipcMain.handle('lib:upload-ytm', async (_e, ids) => {
  if (!win || !Array.isArray(ids)) return { ok: false, error: 'YouTube Music isn\'t open' };
  const { files, skipped } = library.filesForUpload(ids.map(String));
  if (!files.length) return { ok: false, error: 'YouTube Music only takes MP3, M4A, FLAC, OGG and WMA files' };
  let sent = 0;
  for (let i = 0; i < files.length; i += 5) { // a few files at a time
    const batch = files.slice(i, i + 5).map((f) => ({ name: f.name, type: f.type, data: fs.readFileSync(f.path) }));
    const res = await dropOnPage(batch);
    if (!res.ok) return { ok: false, error: res.error, sent };
    sent += batch.length;
  }
  log(`Sent ${sent} song(s) to YouTube Music uploads${skipped ? `, skipped ${skipped} unsupported` : ''}`);
  return { ok: true, sent, skipped };
});
ipcMain.handle('pl:play', (_e, opts) => playPlaylist({ id: String(opts?.id), key: opts?.key ? String(opts.key) : null, shuffle: !!opts?.shuffle }));
ipcMain.handle('pl:queue', () => queue && { playlistId: queue.playlistId, key: currentKey() });
ipcMain.handle('tb:switch-version', (_e, info) => switchVersion(info));
ipcMain.handle('pl:search', (_e, query) => playlists.searchCandidates(String(query || '').slice(0, 200)));
ipcMain.handle('pl:set-match', (_e, id, index, match) => playlists.setMatch(String(id), Number(index), match));
ipcMain.on('lib:ended', (_e, id) => queueOnLocalEnded(String(id)));
ipcMain.on('lib:queue-step', (_e, dir) => queueStep(dir > 0 ? 1 : -1));
ipcMain.on('lib:queue-exit', () => leaveQueue('Left imported playlist'));
ipcMain.handle('pl:import-file', async () => {
  const res = await dialog.showOpenDialog(playlistsWin || win, {
    title: 'Import a playlist file',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Playlist exports', extensions: ['csv', 'json'] }],
  });
  if (res.canceled) return { imported: 0 };
  let imported = 0;
  const errors = [];
  for (const f of res.filePaths) {
    try {
      for (const p of spotify.readExportFile(f)) { playlists.add(p.name, 'file', p.tracks); imported++; }
    } catch (e) { errors.push(`${path.basename(f)}: ${e.message}`); }
  }
  return { imported, errors };
});

// Spotify account
ipcMain.handle('sp:status', () => ({ clientId: config.get('spotifyClientId'), connected: spotify.isConnected(), redirectUri: spotify.REDIRECT_URI }));
ipcMain.handle('sp:set-client-id', (_e, id) => {
  const v = String(id || '').trim();
  if (v !== config.get('spotifyClientId')) { config.set({ spotifyClientId: v }); spotify.setClientId(v); spotify.signOut(); }
});
ipcMain.handle('sp:connect', async () => {
  try { await spotify.connect(); playlistsWin?.focus(); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('sp:disconnect', () => spotify.signOut());
ipcMain.handle('sp:playlists', async () => {
  try { return { ok: true, playlists: await spotify.listPlaylists() }; } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('sp:import', async (_e, items) => {
  let imported = 0;
  const errors = [];
  for (const it of Array.isArray(items) ? items : []) {
    try {
      const tracks = await spotify.playlistTracks(String(it.id));
      if (tracks.length) { playlists.add(it.name, 'spotify', tracks, it.image || ''); imported++; }
      else errors.push(`${it.name}: no songs`);
    } catch (e) { errors.push(`${it.name}: ${e.message}`); }
  }
  return { imported, errors };
});
ipcMain.on('lib:now-playing', (_e, np) => onLocalState(np));
ipcMain.handle('lib:list', () => library.list());
// New files in My Music may be songs your imported playlists were missing
const afterLibraryAdd = (res) => { if (res?.added) playlists.retryAllNotFound(); return res; };
ipcMain.handle('lib:add', async () => afterLibraryAdd(await library.pickAndImport(win)));
ipcMain.handle('lib:add-paths', async (_e, paths) => {
  if (!Array.isArray(paths)) return { added: 0, skipped: 0 };
  return afterLibraryAdd(await library.importFiles(paths.filter((p) => typeof p === 'string' && p.length < 1024)));
});
ipcMain.handle('lib:remove', (_e, id) => library.remove(String(id)));
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
  library.handleProtocol(session.defaultSession);
  // Developer test hook: import files given on the environment (semicolon-separated)
  if (process.env.TUNEBOX_IMPORT) library.importFiles(process.env.TUNEBOX_IMPORT.split(';')).then((r) => log(`Test import: ${JSON.stringify(r)}`));
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
  ensureShortcuts();
  spotify.setClientId(config.get('spotifyClientId'));
  playlists.init({
    log,
    onChange: (ev) => {
      playlistsWin?.webContents.send('pl:changed', ev);
    },
  });
  // Developer test hook: import a playlist export file on startup
  if (process.env.TUNEBOX_IMPORT_PLAYLIST) {
    try { for (const p of spotify.readExportFile(process.env.TUNEBOX_IMPORT_PLAYLIST)) playlists.add(p.name, 'file', p.tracks); } catch (e) { log(`Test playlist import failed: ${e.message}`); }
  }
  // After each page load (e.g. moving through an imported playlist), re-send the queue flag
  win.webContents.on('did-finish-load', setQueueFlag);

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

// Clear the Discord status before the app exits. Hold the quit until Discord
// has received the clear (at most 1 second), otherwise it can stay stuck.
let discordCleared = false;
app.on('before-quit', (e) => {
  quitting = true;
  if (discordCleared) return;
  e.preventDefault();
  discord.shutdown().finally(() => {
    discordCleared = true;
    app.quit();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && (quitting || !config.get('closeToTray'))) app.quit();
});
