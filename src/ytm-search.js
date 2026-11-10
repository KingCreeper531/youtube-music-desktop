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

// Walk the response and collect every song row, plus the big "top result" card.
function collectRows(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const n of node) collectRows(n, out); return; }
  if (node.musicResponsiveListItemRenderer) out.push(node.musicResponsiveListItemRenderer);
  if (node.musicCardShelfRenderer) out.push({ __card: node.musicCardShelfRenderer });
  for (const k in node) {
    if (k !== 'musicResponsiveListItemRenderer') collectRows(node[k], out);
  }
}

function parseCard(c) {
  const ep = c.title?.runs?.[0]?.navigationEndpoint?.watchEndpoint;
  if (!ep?.videoId) return null;
  const mvType = (JSON.stringify(ep).match(/MUSIC_VIDEO_TYPE_[A-Z_]+/) || [])[0] || '';
  const parts = textOf(c.subtitle).split(' • ').map((s) => s.trim()).filter(Boolean);
  if (parts.length && /^(Song|Video|Single|EP)$/i.test(parts[0])) parts.shift();
  let duration = 0;
  if (parts.length && parseDuration(parts[parts.length - 1])) duration = parseDuration(parts.pop());
  if (parts.length > 1 && /\bviews?$/i.test(parts[parts.length - 1])) parts.pop();
  const thumbs = c.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
  return {
    videoId: ep.videoId,
    mvType,
    type: mvType === 'MUSIC_VIDEO_TYPE_ATV' ? 'song' : /OMV|UGC/.test(mvType) ? 'video' : 'other',
    title: textOf(c.title),
    artist: parts[0] || '',
    album: parts[1] || '',
    duration,
    thumbnail: thumbs.length ? thumbs[thumbs.length - 1].url : '',
  };
}

function parseDuration(s) {
  const m = /^(\d+):(\d{2})(?::(\d{2}))?$/.exec(s.trim());
  if (!m) return 0;
  return m[3] ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : (+m[1]) * 60 + (+m[2]);
}

function parseRow(r) {
  if (r.__card) return parseCard(r.__card);
  const cols = r.flexColumns || [];
  const titleRuns = cols[0]?.musicResponsiveListItemFlexColumnRenderer?.text;
  const subRuns = cols[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
  const videoId = r.playlistItemData?.videoId
    || titleRuns?.runs?.[0]?.navigationEndpoint?.watchEndpoint?.videoId
    || r.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId;
  if (!videoId) return null;
  // ATV = the song (audio), OMV = official music video, UGC = other uploads
  const mvType = (JSON.stringify(r.overlay || titleRuns || {}).match(/MUSIC_VIDEO_TYPE_[A-Z_]+/) || [])[0] || '';
  const parts = subRuns.map((x) => x.text).join('').split(' • ').map((s) => s.trim()).filter(Boolean);
  if (parts.length && /^(Song|Video|Single|EP)$/i.test(parts[0])) parts.shift();
  let duration = 0;
  if (parts.length && parseDuration(parts[parts.length - 1])) duration = parseDuration(parts.pop());
  const thumbs = r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
  // Video rows read "Artist • 51M views • 3:19": the views count isn't an album
  if (parts.length > 1 && /\bviews?$/i.test(parts[parts.length - 1])) parts.pop();
  return {
    videoId,
    mvType,
    type: mvType === 'MUSIC_VIDEO_TYPE_ATV' ? 'song' : /OMV|UGC/.test(mvType) ? 'video' : 'other',
    title: textOf(titleRuns),
    artist: parts[0] || '',
    album: parts[1] || '',
    duration,
    thumbnail: thumbs.length ? thumbs[thumbs.length - 1].url : '',
  };
}

/** filter: 'songs' (default) or 'all' (also music videos, live versions, uploads). */
async function search(query, fetchImpl = fetch, filter = 'songs') {
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
      ...(filter === 'songs' ? { params: decodeURIComponent(SONGS_FILTER) } : {}),
    }),
  });
  if (!res.ok) throw new Error(`search failed (${res.status})`);
  const rows = [];
  collectRows(await res.json(), rows);
  const seen = new Set();
  return rows.map(parseRow).filter((r) => r && !seen.has(r.videoId) && seen.add(r.videoId)).slice(0, 12);
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

// Words in video titles/channel names that say nothing about which song it is
const NOISE = /\b(official|video|music|audio|lyrics?|lyric|visuali[sz]er|hd|hq|4k|mv|topic|vevo|explicit|clean)\b/g;
const clean = (s) => normalize(s).replace(NOISE, ' ').replace(/\s+/g, ' ').trim();
const VERSION_WORDS = ['instrumental', 'karaoke', 'live', 'remix', 'cover', 'acoustic', 'sped up', 'slowed', 'reverb',
  'nightcore', '8d', 'extended', 'tabata', 'piano', 'lofi', 'lo fi', 'reaction', 'tutorial', 'parody', 'mashup', 'edit'];

/** Picks the best YouTube Music result for a track, or null if nothing fits. */
function bestMatch(track, results) {
  let best = null;
  const artists = String(track.artist).split(/,\s*/).filter(Boolean);
  for (const r of results) {
    // Video titles are often "Artist - Song (Official Video)": take the artist out first
    let rTitle = clean(r.title);
    let artistInTitle = false;
    for (const a of artists) {
      const na = clean(a);
      if (na && rTitle.includes(na)) { rTitle = rTitle.replace(na, ' ').trim(); artistInTitle = true; }
    }
    const titleScore = Math.max(similarity(track.title, r.title), similarity(clean(track.title), rTitle));
    const artistScore = Math.max(artistInTitle ? 1 : 0, ...artists.map((a) => similarity(clean(a), clean(r.artist))), 0);
    let durScore = 0.5;
    if (track.durationMs && r.duration) {
      const diff = Math.abs(track.durationMs / 1000 - r.duration);
      durScore = diff <= 3 ? 1 : diff <= 10 ? 0.7 : diff <= 30 ? 0.3 : 0;
    }
    let score = titleScore * 0.55 + artistScore * 0.3 + durScore * 0.15;
    // A different version (instrumental, live, remix, cover...) only counts if you asked for that version
    const wanted = normalize(track.title);
    const theirs = normalize(r.title);
    for (const w of VERSION_WORDS) {
      if (theirs.includes(w) && !wanted.includes(w)) { score -= 0.35; break; }
    }
    if (!best || score > best.score) best = { ...r, score };
  }
  return best && best.score >= 0.45 ? best : null;
}

async function findSong(track, fetchImpl = fetch) {
  const query = `${track.title} ${String(track.artist).split(',')[0]}`.trim();
  // 1. Official songs  2. everything else (music videos, live versions, uploads)
  const songs = bestMatch(track, await search(query, fetchImpl, 'songs'));
  if (songs) return songs;
  return bestMatch(track, await search(query, fetchImpl, 'all'));
}

/**
 * The other version of what's playing: the music video of a song, or the song
 * of a music video. Both are free to play; this just finds the matching one.
 */
async function findCounterpart({ videoId, title, artist, type }, fetchImpl = fetch) {
  const track = { title, artist, durationMs: 0 }; // videos often have intros, so ignore length
  const mainArtist = String(artist).split(/,|&/)[0].trim();
  if (type === 'song') {
    const results = (await search(`${title} ${mainArtist} official video`, fetchImpl, 'all'))
      .filter((r) => r.type === 'video' && r.videoId !== videoId);
    return bestMatch(track, results.filter((r) => r.mvType === 'MUSIC_VIDEO_TYPE_OMV')) || bestMatch(track, results);
  }
  const results = (await search(`${clean(title)} ${mainArtist}`, fetchImpl, 'songs'))
    .filter((r) => r.videoId !== videoId);
  return bestMatch(track, results);
}

module.exports = { search, findSong, findCounterpart, bestMatch, normalize, similarity };
