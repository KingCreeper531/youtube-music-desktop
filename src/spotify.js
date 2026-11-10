// Reads your playlists from Spotify (official Web API, your own developer app)
// or from exported files (Exportify CSV, Spotify "Download your data" JSON).
const { app, shell, safeStorage, net } = require('electron');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = 43821;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;
const SCOPES = 'playlist-read-private playlist-read-collaborative user-library-read';
const tokenFile = () => path.join(app.getPath('userData'), 'spotify-token.bin');

let clientId = '';
let token = null; // { access, refresh, expires }

function setClientId(id) {
  id = String(id || '').trim();
  if (id !== clientId) {
    clientId = id;
  }
}

// ---------------------------------------------------------------- token storage (encrypted with Windows DPAPI)
function loadToken() {
  if (token) return token;
  try {
    const buf = fs.readFileSync(tokenFile());
    token = JSON.parse(safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString());
  } catch {
    token = null;
  }
  return token;
}

function saveToken(t) {
  token = t;
  try {
    const json = JSON.stringify(t);
    fs.writeFileSync(tokenFile(), safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(json) : json);
  } catch { /* ignore */ }
}

function signOut() {
  token = null;
  fs.rmSync(tokenFile(), { force: true });
}

function isConnected() {
  return !!loadToken()?.refresh;
}

// ---------------------------------------------------------------- sign-in (Authorization Code + PKCE, no secret needed)
let pendingServer = null;

function connect() {
  if (!/^[0-9a-f]{32}$/i.test(clientId)) {
    return Promise.reject(new Error('Paste your Spotify Client ID in Settings first.'));
  }
  if (pendingServer) { try { pendingServer.close(); } catch { /* ignore */ } }

  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('hex');

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, REDIRECT_URI);
      if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }
      const done = (ok, msg) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><title>YouTube Music</title>
          <body style="font:16px system-ui;background:#111;color:#eee;display:grid;place-content:center;height:90vh;text-align:center">
          <h2>${ok ? 'Connected to Spotify ✓' : 'Spotify sign-in failed'}</h2><p>${msg}</p></body>`);
        clearTimeout(timer);
        server.close();
        pendingServer = null;
      };
      if (url.searchParams.get('state') !== state) { done(false, 'Please try again from the app.'); reject(new Error('State mismatch')); return; }
      const code = url.searchParams.get('code');
      if (!code) { done(false, url.searchParams.get('error') || 'No code returned.'); reject(new Error(url.searchParams.get('error') || 'Cancelled')); return; }
      try {
        await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, client_id: clientId, code_verifier: verifier });
        done(true, 'You can close this tab and go back to YouTube Music.');
        resolve(true);
      } catch (e) {
        done(false, e.message);
        reject(e);
      }
    });
    const timer = setTimeout(() => { server.close(); pendingServer = null; reject(new Error('Sign-in timed out.')); }, 5 * 60 * 1000);
    server.on('error', (e) => { clearTimeout(timer); reject(new Error(`Couldn't start sign-in (${e.code}).`)); });
    server.listen(PORT, '127.0.0.1', () => {
      pendingServer = server;
      const auth = new URL('https://accounts.spotify.com/authorize');
      auth.search = new URLSearchParams({
        client_id: clientId, response_type: 'code', redirect_uri: REDIRECT_URI,
        code_challenge_method: 'S256', code_challenge: challenge, scope: SCOPES, state,
      }).toString();
      shell.openExternal(auth.toString());
    });
  });
}

async function tokenRequest(params) {
  const res = await net.fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description || data.error || `Spotify returned ${res.status}`);
  saveToken({
    access: data.access_token,
    refresh: data.refresh_token || token?.refresh,
    expires: Date.now() + (data.expires_in - 60) * 1000,
  });
}

async function accessToken() {
  const t = loadToken();
  if (!t?.refresh) throw new Error('Not connected to Spotify.');
  if (t.access && Date.now() < t.expires) return t.access;
  await tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: clientId });
  return token.access;
}

async function api(urlOrPath) {
  const url = urlOrPath.startsWith('http') ? urlOrPath : `https://api.spotify.com/v1${urlOrPath}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await net.fetch(url, { headers: { Authorization: `Bearer ${await accessToken()}` } });
    if (res.status === 429) { // rate limited: wait as asked
      await new Promise((r) => setTimeout(r, (Number(res.headers.get('retry-after')) || 2) * 1000));
      continue;
    }
    if (res.status === 401 && attempt === 0) { token.expires = 0; continue; }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const err = new Error(body.error?.message || `Spotify returned ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }
  throw new Error('Spotify is busy, try again in a minute.');
}

async function allPages(firstUrl, pick) {
  const out = [];
  let url = firstUrl;
  while (url) {
    const page = await api(url);
    out.push(...pick(page));
    url = page.next;
  }
  return out;
}

/** Your playlists, plus Liked Songs as the first entry. */
async function listPlaylists() {
  const me = await api('/me');
  const lists = await allPages('/me/playlists?limit=50', (p) => p.items || []);
  return [
    { id: 'liked', name: 'Liked Songs', owner: me.display_name || '', count: null, image: '' },
    ...lists.filter(Boolean).map((p) => ({
      id: p.id,
      name: p.name,
      owner: p.owner?.display_name || '',
      count: p.tracks?.total ?? p.items?.total ?? null,
      image: p.images?.[0]?.url || '',
    })),
  ];
}

function toTrack(t) {
  if (!t || t.type === 'episode' || !t.name) return null;
  return {
    title: t.name,
    artist: (t.artists || []).map((a) => a.name).join(', '),
    album: t.album?.name || '',
    durationMs: t.duration_ms || 0,
  };
}

/** All tracks in one playlist (or Liked Songs). */
async function playlistTracks(id) {
  if (id === 'liked') {
    return (await allPages('/me/tracks?limit=50', (p) => p.items || [])).map((i) => toTrack(i.track)).filter(Boolean);
  }
  const pick = (p) => (p.items || []).map((i) => toTrack(i.track || i.item));
  try {
    return (await allPages(`/playlists/${id}/tracks?limit=100`, pick)).filter(Boolean);
  } catch (e) {
    if (e.status === 404 || e.status === 403) {
      return (await allPages(`/playlists/${id}/items?limit=100`, pick)).filter(Boolean);
    }
    throw e;
  }
}

// ---------------------------------------------------------------- file import
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** Returns [{ name, tracks }] from an exported file. */
function readExportFile(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const base = path.basename(file, path.extname(file));

  if (/\.json$/i.test(file)) {
    const data = JSON.parse(text);
    // Spotify data download: Playlist1.json
    if (Array.isArray(data.playlists)) {
      return data.playlists.map((p) => ({
        name: p.name,
        tracks: (p.items || []).map((i) => i.track && {
          title: i.track.trackName, artist: i.track.artistName, album: i.track.albumName || '', durationMs: 0,
        }).filter((t) => t && t.title),
      })).filter((p) => p.tracks.length);
    }
    // Spotify data download: YourLibrary.json (liked songs)
    if (Array.isArray(data.tracks)) {
      return [{
        name: 'Liked Songs',
        tracks: data.tracks.map((t) => ({ title: t.track, artist: t.artist, album: t.album || '', durationMs: 0 })).filter((t) => t.title),
      }];
    }
    throw new Error('This JSON file isn\'t a Spotify playlist export.');
  }

  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('The file has no songs.');
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const col = (...names) => head.findIndex((h) => names.includes(h));
  const ti = col('track name', 'track', 'title', 'name', 'song');
  const ai = col('artist name(s)', 'artist name', 'artist', 'artists');
  const al = col('album name', 'album');
  const du = col('duration (ms)', 'duration_ms', 'duration');
  if (ti < 0 || ai < 0) throw new Error('Couldn\'t find "Track Name" and "Artist" columns in this CSV.');
  return [{
    name: base.replace(/_/g, ' '),
    tracks: rows.slice(1).map((r) => ({
      title: (r[ti] || '').trim(),
      artist: (r[ai] || '').replace(/;\s*/g, ', ').trim(),
      album: al >= 0 ? (r[al] || '').trim() : '',
      durationMs: du >= 0 ? Number(r[du]) || 0 : 0,
    })).filter((t) => t.title),
  }];
}

module.exports = {
  REDIRECT_URI, setClientId, connect, signOut, isConnected, listPlaylists, playlistTracks, readExportFile,
};
