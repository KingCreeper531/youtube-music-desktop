const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  // Ad blocking
  adblock: true,            // strip ads from player data + skip any that slip through
  networkBlocking: true,    // EasyList / tracker blocking (Ghostery engine)
  hideUpsells: true,        // hide "Get Premium" banners & popups
  // Playback
  sponsorBlock: true,       // skip non-music parts of music videos
  sponsorCategories: ['music_offtopic'],
  noAfkPause: true,         // never show "Are you still there?"
  // Discord
  discord: true,
  discordClientId: '',
  discordHidePaused: false, // false = keep showing the song with "(Paused)"
  discordShowButton: true,
  // Spotify import
  spotifyClientId: '',
  // Window
  closeToTray: true,
  bounds: { width: 1280, height: 800 },
  maximized: false,
};

const file = () => path.join(app.getPath('userData'), 'config.json');
let data = null;
const listeners = new Set();

function load() {
  if (data) return data;
  try {
    data = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file(), 'utf8')) };
  } catch {
    data = { ...DEFAULTS };
  }
  watchForOutsideChanges();
  return data;
}

let saveTimer = null;
let lastWritten = null; // our own last save, so the file watcher can ignore it
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(file()), { recursive: true });
      lastWritten = JSON.stringify(data, null, 2);
      fs.writeFileSync(file(), lastWritten);
    } catch (e) {
      console.error('config save failed', e);
    }
  }, 250);
}

// Settings can also be changed from outside the app (the Ranch Launcher edits this
// file). Pick those changes up and apply them like any change made in Settings.
let watching = false;
function watchForOutsideChanges() {
  if (watching) return;
  watching = true;
  try {
    const dir = path.dirname(file());
    fs.mkdirSync(dir, { recursive: true });
    let timer = null;
    fs.watch(dir, { persistent: false }, (_event, name) => {
      if (name && name !== 'config.json') return;
      clearTimeout(timer);
      timer = setTimeout(reloadFromDisk, 150);
    });
  } catch { /* watching isn't available; changes apply on next start */ }
}

function reloadFromDisk() {
  let text;
  try { text = fs.readFileSync(file(), 'utf8'); } catch { return; }
  if (text === lastWritten) return;
  let parsed;
  try { parsed = JSON.parse(text); } catch { return; } // half-written; the next event retries
  const before = { ...load() };
  const next = { ...DEFAULTS, ...parsed };
  if (JSON.stringify(next) === JSON.stringify(before)) return;
  data = next;
  lastWritten = text;
  for (const fn of listeners) fn(data, before);
}

function get(key) {
  return load()[key];
}

function set(patch) {
  const before = { ...load() };
  Object.assign(data, patch);
  save();
  for (const fn of listeners) fn(data, before);
}

function onChange(fn) {
  listeners.add(fn);
}

module.exports = { load, get, set, onChange, DEFAULTS };
