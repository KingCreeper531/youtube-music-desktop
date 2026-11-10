// Finds songs on YouTube Music (anonymous search, no account needed).
// Used to match imported Spotify tracks to YouTube Music songs.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const SONGS_FILTER = 'EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D';
const FALLBACK_VERSION = '1.20251101.01.00';

let cfg = null;
let cfgAt = 0;

async function clientConfig(fetchImpl) {
  if (cfg && Date.now() - cfgAt < 6 * 3600 * 1000) return cfg;
  let version = FALLBACK_VERSION;
  let key = null;
  try {
    const html = await (await fetchImpl('https://music.youtube.com/', { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' } })).text();
    version = (html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/) || [])[1] || version;
    key = (html.match(/"INNERTUBE_API_KEY":"([^"]+)"/) || [])[1] || null;
  } catch { /* use fallback */ }
  cfg = { version, key };
  cfgAt = Date.now();
  return cfg;
}

function textOf(obj) {
  return (obj?.runs || []).map((r) => r.text).join('');
}

// Walk the response and collect every song row.
function collectRows(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const n of node) collectRows(n, out); return; }
  if (node.musicResponsiveListItemRenderer) out.push(node.musicResponsiveListItemRenderer);
  for (const k in node) {
    if (k !== 'musicResponsiveListItemRenderer') collectRows(node[k], out);
  }
}

function parseDuration(s) {
  const m = /^(\d+):(\d{2})(?::(\d{2}))?$/.exec(s.trim());
  if (!m) return 0;
  return m[3] ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : (+m[1]) * 60 + (+m[2]);
}

function parseRow(r) {
  const cols = r.flexColumns || [];
  const titleRuns = cols[0]?.musicResponsiveListItemFlexColumnRenderer?.text;
  const subRuns = cols[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
  const videoId = r.playlistItemData?.videoId
    || titleRuns?.runs?.[0]?.navigationEndpoint?.watchEndpoint?.videoId
    || r.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId;
  if (!videoId) return null;
  const parts = subRuns.map((x) => x.text).join('').split(' • ').map((s) => s.trim()).filter(Boolean);
  if (parts.length && /^(Song|Video|Single|EP)$/i.test(parts[0])) parts.shift();
  let duration = 0;
  if (parts.length && parseDuration(parts[parts.length - 1])) duration = parseDuration(parts.pop());
  const thumbs = r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
  return {
    videoId,
    title: textOf(titleRuns),
    artist: parts[0] || '',
    album: parts[1] || '',
    duration,
    thumbnail: thumbs.length ? thumbs[thumbs.length - 1].url : '',
  };
}

async function search(query, fetchImpl = fetch) {
  const { version, key } = await clientConfig(fetchImpl);
  const url = `https://music.youtube.com/youtubei/v1/search?prettyPrint=false${key ? `&key=${key}` : ''}`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': UA,
      Origin: 'https://music.youtube.com',
      Referer: 'https://music.youtube.com/',
      'X-YouTube-Client-Name': '67',
      'X-YouTube-Client-Version': version,
    },
    body: JSON.stringify({
      context: { client: { clientName: 'WEB_REMIX', clientVersion: version, hl: 'en', gl: 'US' } },
      query,
      params: decodeURIComponent(SONGS_FILTER),
    }),
  });
  if (!res.ok) throw new Error(`search failed (${res.status})`);
  const rows = [];
  collectRows(await res.json(), rows);
  return rows.map(parseRow).filter(Boolean).slice(0, 8);
}

// ---------------------------------------------------------------- matching
function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/\((feat|ft|with)[^)]*\)|\[(feat|ft|with)[^\]]*\]/g, ' ')
    .replace(/\s-\s.*(remaster|version|edit|mix|live|mono|stereo).*$/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function similarity(a, b) {
  const A = new Set(normalize(a).split(' ').filter(Boolean));
  const B = new Set(normalize(b).split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let both = 0;
  for (const w of A) if (B.has(w)) both++;
  return both / Math.max(A.size, B.size);
}

/** Picks the best YouTube Music result for a track, or null if nothing fits. */
function bestMatch(track, results) {
  let best = null;
  for (const r of results) {
    const titleScore = similarity(track.title, r.title);
    const artistScore = Math.max(...String(track.artist).split(/,\s*/).map((a) => similarity(a, r.artist)), 0);
    let durScore = 0.5;
    if (track.durationMs && r.duration) {
      const diff = Math.abs(track.durationMs / 1000 - r.duration);
      durScore = diff <= 3 ? 1 : diff <= 10 ? 0.7 : diff <= 30 ? 0.3 : 0;
    }
    const score = titleScore * 0.55 + artistScore * 0.3 + durScore * 0.15;
    if (!best || score > best.score) best = { ...r, score };
  }
  return best && best.score >= 0.45 ? best : null;
}

async function findSong(track, fetchImpl = fetch) {
  const query = `${track.title} ${String(track.artist).split(',')[0]}`.trim();
  const results = await search(query, fetchImpl);
  return bestMatch(track, results);
}

module.exports = { search, findSong, bestMatch, normalize };
