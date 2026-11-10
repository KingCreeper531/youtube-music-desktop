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
  return data;
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(file()), { recursive: true });
      fs.writeFileSync(file(), JSON.stringify(data, null, 2));
    } catch (e) {
      console.error('config save failed', e);
    }
  }, 250);
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
