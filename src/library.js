// "My Music": your own audio files, copied into the app's library folder.
const { app, protocol, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');

const AUDIO_EXT = ['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'oga', 'opus', 'webm'];
const MIME = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', wav: 'audio/wav',
  ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', webm: 'audio/webm',
  jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
};

const root = () => path.join(app.getPath('userData'), 'library');
const filesDir = () => path.join(root(), 'files');
const artDir = () => path.join(root(), 'art');
const indexFile = () => path.join(root(), 'library.json');

let tracks = null;

function load() {
  if (tracks) return tracks;
  try {
    tracks = JSON.parse(fs.readFileSync(indexFile(), 'utf8'));
    // Drop entries whose files have gone missing
    tracks = tracks.filter((t) => fs.existsSync(path.join(filesDir(), t.file)));
  } catch {
    tracks = [];
  }
  return tracks;
}

function save() {
  fs.mkdirSync(root(), { recursive: true });
  fs.writeFileSync(indexFile(), JSON.stringify(tracks, null, 2));
}

function list() {
  return load().map(publicTrack);
}

function publicTrack(t) {
  return {
    id: t.id,
    title: t.title,
    artist: t.artist,
    album: t.album,
    duration: t.duration,
    added: t.added,
    src: `tbmedia://track/${t.id}`,
    art: t.art ? `tbmedia://art/${t.id}` : null,
  };
}

let mm = null;
async function readTags(file) {
  try {
    mm = mm || (await import('music-metadata'));
    const meta = await mm.parseFile(file, { duration: true, skipCovers: false });
    return meta;
  } catch {
    return null;
  }
}

async function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

/** Copies the given files into the library. Returns { added, skipped }. */
async function importFiles(paths) {
  load();
  fs.mkdirSync(filesDir(), { recursive: true });
  fs.mkdirSync(artDir(), { recursive: true });
  let added = 0;
  let skipped = 0;
  for (const src of paths) {
    const ext = path.extname(src).slice(1).toLowerCase();
    if (!AUDIO_EXT.includes(ext)) { skipped++; continue; }
    try {
      const hash = await hashFile(src);
      if (tracks.some((t) => t.hash === hash)) { skipped++; continue; } // already in the library

      const id = crypto.randomUUID();
      const file = `${id}.${ext}`;
      const dest = path.join(filesDir(), file);
      await fs.promises.copyFile(src, dest);

      const meta = await readTags(dest);
      const c = meta?.common || {};
      let art = null;
      const pic = c.picture?.[0];
      if (pic?.data?.length) {
        const artExt = /png/i.test(pic.format) ? 'png' : /webp/i.test(pic.format) ? 'webp' : 'jpg';
        art = `${id}.${artExt}`;
        await fs.promises.writeFile(path.join(artDir(), art), pic.data);
      }

      tracks.push({
        id,
        hash,
        file,
        art,
        title: (c.title || path.basename(src, path.extname(src))).trim(),
        artist: (c.artists?.join(', ') || c.artist || c.albumartist || 'Unknown artist').trim(),
        album: (c.album || '').trim(),
        duration: meta?.format?.duration || 0,
        added: Date.now(),
      });
      added++;
    } catch {
      skipped++;
    }
  }
  save();
  return { added, skipped };
}

async function pickAndImport(parentWindow) {
  const res = await dialog.showOpenDialog(parentWindow, {
    title: 'Add music',
    buttonLabel: 'Add to My Music',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Audio', extensions: AUDIO_EXT }],
  });
  if (res.canceled || !res.filePaths.length) return { added: 0, skipped: 0 };
  return importFiles(res.filePaths);
}

/** Removes the library's copy (the original file is untouched). */
function remove(id) {
  load();
  const t = tracks.find((x) => x.id === id);
  if (!t) return;
  tracks = tracks.filter((x) => x.id !== id);
  for (const f of [path.join(filesDir(), t.file), t.art && path.join(artDir(), t.art)]) {
    if (f) fs.promises.rm(f, { force: true }).catch(() => {});
  }
  save();
}

// ------------------------------------------------- tbmedia:// file server
function registerScheme() {
  protocol.registerSchemesAsPrivileged([{
    scheme: 'tbmedia',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  }]);
}

function serveFile(file, request) {
  const ext = path.extname(file).slice(1).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const size = fs.statSync(file).size;
  const range = /bytes=(\d*)-(\d*)/.exec(request.headers.get('range') || '');
  if (range) {
    const start = range[1] ? parseInt(range[1], 10) : 0;
    const end = range[2] ? Math.min(parseInt(range[2], 10), size - 1) : size - 1;
    if (start >= size || start > end) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    }
    return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), {
      status: 206,
      headers: {
        'Content-Type': type,
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
      },
    });
  }
  return new Response(Readable.toWeb(fs.createReadStream(file)), {
    status: 200,
    headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' },
  });
}

function handleProtocol(ses) {
  ses.protocol.handle('tbmedia', (request) => {
    const url = new URL(request.url);
    const id = url.pathname.replace(/^\//, '');
    const t = load().find((x) => x.id === id);
    if (!t) return new Response('Not found', { status: 404 });
    if (url.hostname === 'track') return serveFile(path.join(filesDir(), t.file), request);
    if (url.hostname === 'art' && t.art) return serveFile(path.join(artDir(), t.art), request);
    return new Response('Not found', { status: 404 });
  });
}

module.exports = { registerScheme, handleProtocol, list, importFiles, pickAndImport, remove, AUDIO_EXT };
