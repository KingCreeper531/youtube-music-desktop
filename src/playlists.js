// Imported playlists (from Spotify or files), each song matched to YouTube Music.
const { app, net } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ytm = require('./ytm-search');
const library = require('./library');

/** Look for the song among your own files in My Music. */
function findLocal(track) {
  const m = ytm.bestMatch(track, library.list());
  return m ? { source: 'local', localId: m.id, title: m.title, artist: m.artist, duration: m.duration } : null;
}

/** A queue key for a matched song: "y:<videoId>" (YouTube Music) or "l:<id>" (My Music). */
function keyOf(match) {
  if (!match) return null;
  return match.source === 'local' ? `l:${match.localId}` : `y:${match.videoId}`;
}

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

/** Re-check every "not found" song, e.g. after new files were added to My Music. */
function retryAllNotFound() {
  let any = false;
  for (const l of load()) {
    for (const t of l.tracks) if (t.status === 'notfound') { t.status = 'pending'; any = true; }
  }
  if (any) { save(); onChange({ type: 'list' }); kick(); }
}

/** Set a match by hand (from the "Find a match" window). */
function setMatch(id, index, match) {
  const l = load().find((x) => x.id === id);
  const t = l?.tracks[index];
  if (!t || !match) return null;
  if (match.source === 'local') {
    const f = library.list().find((x) => x.id === match.localId);
    if (!f) return null;
    t.match = { source: 'local', localId: f.id, title: f.title, artist: f.artist, duration: f.duration, manual: true };
  } else {
    if (!/^[\w-]{11}$/.test(match.videoId || '')) return null;
    t.match = {
      source: 'ytm', videoId: match.videoId, title: String(match.title || ''), artist: String(match.artist || ''),
      duration: Number(match.duration) || 0, thumbnail: String(match.thumbnail || ''), manual: true,
    };
  }
  t.status = 'matched';
  save();
  onChange({ type: 'playlist', id });
  onChange({ type: 'progress', id, summary: summary(l) });
  return t.match;
}

/** Queue keys of a playlist's matched songs, in order (skips My Music files that were removed). */
function keys(id) {
  const l = load().find((x) => x.id === id);
  if (!l) return [];
  const localIds = new Set(library.list().map((x) => x.id));
  return l.tracks
    .filter((t) => t.status === 'matched' && (t.match.source !== 'local' || localIds.has(t.match.localId)))
    .map((t) => keyOf(t.match));
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
        if (m) {
          t.match = { source: 'ytm', videoId: m.videoId, title: m.title, artist: m.artist, duration: m.duration, thumbnail: m.thumbnail };
        } else {
          t.match = findLocal(t); // not on YouTube Music: maybe it's one of your own files
        }
        t.status = t.match ? 'matched' : 'notfound';
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

/** Search for the "Find a match" window: YouTube Music results plus your own files. */
async function searchCandidates(query) {
  const q = String(query || '').trim();
  if (!q) return { ytm: [], local: [] };
  let found = [];
  try {
    const [songs, all] = await Promise.all([
      ytm.search(q, net.fetch.bind(net), 'songs').catch(() => []),
      ytm.search(q, net.fetch.bind(net), 'all').catch(() => []),
    ]);
    const seen = new Set();
    found = [...songs, ...all].filter((r) => !seen.has(r.videoId) && seen.add(r.videoId)).slice(0, 15);
  } catch { /* offline */ }
  const words = ytm.normalize(q).split(' ').filter(Boolean);
  const local = library.list()
    .map((f) => {
      const hay = ytm.normalize(`${f.title} ${f.artist} ${f.album}`);
      return { f, hits: words.filter((w) => hay.includes(w)).length };
    })
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, 10)
    .map(({ f }) => ({ localId: f.id, title: f.title, artist: f.artist, duration: f.duration, art: f.art }));
  return { ytm: found, local };
}

module.exports = { init, list, get, add, remove, rename, retry, retryAllNotFound, setMatch, keys, keyOf, searchCandidates };
