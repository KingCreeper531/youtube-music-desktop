// Imported playlists (from Spotify or files), each song matched to YouTube Music.
const { app, net } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ytm = require('./ytm-search');

const file = () => path.join(app.getPath('userData'), 'playlists.json');
let lists = null;
let onChange = () => {};
let log = () => {};

function load() {
  if (lists) return lists;
  try { lists = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { lists = []; }
  return lists;
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(file(), JSON.stringify(lists)); } catch { /* ignore */ }
  }, 500);
}

function init(opts) {
  onChange = opts.onChange;
  log = opts.log;
  load();
  // Resume matching anything left over from last time
  for (const l of lists) for (const t of l.tracks) if (t.status === 'searching') t.status = 'pending';
  kick();
}

function summary(l) {
  const matched = l.tracks.filter((t) => t.status === 'matched').length;
  const pending = l.tracks.filter((t) => t.status === 'pending' || t.status === 'searching').length;
  return {
    id: l.id, name: l.name, source: l.source, image: l.image, created: l.created,
    total: l.tracks.length, matched, pending, notFound: l.tracks.length - matched - pending,
  };
}

function list() {
  return load().map(summary);
}

function get(id) {
  const l = load().find((x) => x.id === id);
  return l ? { ...summary(l), tracks: l.tracks } : null;
}

function add(name, source, tracks, image = '') {
  load();
  const l = {
    id: crypto.randomUUID(),
    name: name || 'Imported playlist',
    source,
    image,
    created: Date.now(),
    tracks: tracks.map((t) => ({ ...t, status: 'pending', match: null })),
  };
  lists.unshift(l);
  save();
  onChange({ type: 'list' });
  kick();
  return summary(l);
}

function remove(id) {
  load();
  lists = lists.filter((l) => l.id !== id);
  save();
  onChange({ type: 'list' });
}

function rename(id, name) {
  const l = load().find((x) => x.id === id);
  if (l && name) { l.name = String(name).slice(0, 200); save(); onChange({ type: 'list' }); }
}

/** Retry songs that weren't found. */
function retry(id) {
  const l = load().find((x) => x.id === id);
  if (!l) return;
  for (const t of l.tracks) if (t.status === 'notfound' || t.status === 'error') t.status = 'pending';
  save();
  onChange({ type: 'playlist', id });
  kick();
}

/** The matched YouTube Music video ids of a playlist, in order. */
function videoIds(id) {
  const l = load().find((x) => x.id === id);
  return l ? l.tracks.filter((t) => t.status === 'matched').map((t) => t.match.videoId) : [];
}

// ---------------------------------------------------------------- background matching
const cache = new Map();
let running = false;

function nextPending() {
  for (const l of lists) {
    const t = l.tracks.find((x) => x.status === 'pending');
    if (t) return { l, t };
  }
  return null;
}

async function kick() {
  if (running) return;
  running = true;
  let failures = 0;
  try {
    let job;
    while ((job = nextPending())) {
      const { l, t } = job;
      t.status = 'searching';
      const key = `${t.title}|${t.artist}`.toLowerCase();
      try {
        let m = cache.get(key);
        if (m === undefined) {
          m = await ytm.findSong(t, net.fetch.bind(net));
          cache.set(key, m);
          await new Promise((r) => setTimeout(r, 250)); // be gentle with YouTube
        }
        t.status = m ? 'matched' : 'notfound';
        t.match = m ? { videoId: m.videoId, title: m.title, artist: m.artist, duration: m.duration, thumbnail: m.thumbnail } : null;
        failures = 0;
      } catch (e) {
        t.status = 'pending';
        if (++failures >= 5) { // offline or blocked: stop for now, try again later
          log(`Matching paused: ${e.message}`);
          setTimeout(() => kick(), 60 * 1000);
          break;
        }
        await new Promise((r) => setTimeout(r, 2000));
      }
      save();
      onChange({ type: 'progress', id: l.id, summary: summary(l) });
    }
  } finally {
    running = false;
  }
}

module.exports = { init, list, get, add, remove, rename, retry, videoIds };
