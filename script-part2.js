// WORKER_URL loaded from config.js
// SUPABASE_URL and SUPABASE_KEY live in the Cloudflare Worker env vars

function setlistUrl(path) {
  return `${WORKER_URL}/setlist${path}`;
}

// ==========================
// SUPABASE BAND CACHE
//
// Flow for every band request:
//   1. Check Supabase for cached songs
//   2. If found and fresh (< 30 days) → use instantly
//   3. If missing or stale → hit setlist.fm → save to DB
//
// This means each band is only ever looked up
// on setlist.fm ONCE. After that it's instant.
// ==========================

const CACHE_MAX_AGE_DAYS = 30;

// In-memory memo of DB rows for this session.
// getArtistId, getSetlistSongs and resolveTracksForBand all
// need the band row — this guarantees ONE Supabase GET per band
// instead of 3 (which was hammering the Worker and causing 429s).
const dbRowCache = new Map();

// fetch wrapper for Worker/Supabase calls:
// small gap between calls + automatic retry on 429
let lastWorkerCall = 0;

async function workerFetch(url, opts) {
  const gap = Date.now() - lastWorkerCall;
  if (gap < 150) await wait(150 - gap);
  lastWorkerCall = Date.now();

  let res = await fetch(url, opts);

  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get('Retry-After') || '3');
    console.warn(`Worker/Supabase 429 — waiting ${retryAfter}s and retrying...`);
    await wait(retryAfter * 1000);
    lastWorkerCall = Date.now();
    res = await fetch(url, opts);
  }

  return res;
}

async function dbGetBand(name) {
  const key = name.toLowerCase().trim();

  // memo hit — zero network calls
  if (dbRowCache.has(key)) {
    return dbRowCache.get(key);
  }

  const row = await dbGetBandUncached(name, key);
  dbRowCache.set(key, row);
  return row;
}

async function dbGetBandUncached(name, key) {
  try {
    // calls go through the Cloudflare Worker
    // which holds SUPABASE_KEY server-side
    const res = await workerFetch(
      `${WORKER_URL}/supabase/bands?name=eq.${encodeURIComponent(key)}&select=*`
    );

    if (!res.ok) {
      console.warn(`Supabase GET failed: ${res.status}`);
      return null;
    }

    const rows = await res.json();
    if (!rows.length) return null;

    const row = rows[0];

    const updatedAt = new Date(row.updated_at);
    const ageMs = Date.now() - updatedAt.getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);

    if (ageDays > CACHE_MAX_AGE_DAYS) {
      console.log(`Cache stale (${Math.round(ageDays)}d) for "${name}" — refreshing`);
      return null;
    }

    console.log(`Cache HIT ✅ "${name}" (${Math.round(ageDays)}d old)`);
    return row;

  } catch (err) {
    console.warn(`Supabase GET exception: ${err.message}`);
    return null;
  }
}

async function dbSaveBand(name, mbid, songs, spotifyId, source, uris) {
  try {
    const key = name.toLowerCase().trim();

    const payload = {
      name: key,
      mbid: mbid || null,
      songs: songs,
      spotify_id: spotifyId || null,
      source: source || 'setlist',
      updated_at: new Date().toISOString(),
      // store matched Spotify URIs so we never need to
      // re-match song names → URIs for cached bands
      uris: uris || null
    };

    // calls go through the Cloudflare Worker
    // which holds SUPABASE_KEY server-side.
    // on_conflict=name makes merge-duplicates a real UPSERT keyed
    // on the band name — without it, saving an existing band was
    // failing silently with a duplicate-key conflict.
    const res = await workerFetch(
      `${WORKER_URL}/supabase/bands?on_conflict=name`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates'
        },
        body: JSON.stringify(payload)
      }
    );

    if (!res.ok) {
      const errText = await res.text();
      console.warn(`Supabase SAVE failed: ${res.status} — ${errText}`);
    } else {
      console.log(
        `Cache SAVED ✅ "${name}" (${(songs || []).length} songs, ` +
        `${(uris || []).length} URIs, source: ${source})`
      );
      // keep the in-memory memo in sync so later lookups
      // in this session see the fresh row without a network call
      dbRowCache.set(key, { ...payload });
    }

  } catch (err) {
    console.warn(`Supabase SAVE exception: ${err.message}`);
  }
}

// ==========================
// RATE LIMITERS + 429 RETRY
// ==========================

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Setlist.fm rate limiter ---
let lastSetlistCall = 0;

async function setlistFetch(url, opts) {
  const gap = Date.now() - lastSetlistCall;
  if (gap < 1200) await wait(1200 - gap);
  lastSetlistCall = Date.now();

  let res = await fetch(url, opts);

  if (res.status === 429) {
    console.warn('Setlist.fm 429 — waiting 6s and retrying...');
    await wait(6000);
    lastSetlistCall = Date.now();
    res = await fetch(url, opts);

    if (res.status === 429) {
      console.warn('Setlist.fm still 429 after retry — falling back to Spotify');
    }
  }

  return res;
}

// --- Spotify rate limiter ---
// Enforces a minimum gap between Spotify API calls
// and retries automatically on 429.
// Spotify's dev mode limit is roughly 30 req/s —
// we use 300ms gap (≈3/s) for dev mode safety.
let lastSpotifyCall = 0;

async function spotifyFetch(url, opts) {
  const gap = Date.now() - lastSpotifyCall;
  if (gap < 300) await wait(300 - gap);
  lastSpotifyCall = Date.now();

  let res = await fetch(url, opts);

  if (res.status === 429) {
    // check Retry-After header — Spotify sometimes sends it
    const retryAfter = parseInt(res.headers.get('Retry-After') || '5');
    const waitMs = retryAfter * 1000;
    console.warn(`Spotify 429 — waiting ${retryAfter}s and retrying...`);
    await wait(waitMs);
    lastSpotifyCall = Date.now();
    res = await fetch(url, opts);
  }

  return res;
}

// ==========================
// LIVE VERSION FILTER
// ==========================

function isLiveTrack(name) {
  if (!name) return false;

  const lower = name.toLowerCase();

  const livePatterns = [
    /\blive\b/,
    /\(live/,
    /- live/,
    /\bconcert\b/,
    /\bunplugged\b/,
    /\bacoustic\b/,
    /\brecorded at\b/,
    /\bat the\b.*\b(arena|stadium|festival|hall|theatre|theater|club|venue)\b/
  ];

  return livePatterns.some((pattern) => pattern.test(lower));
}

// ==========================
// NEW RELEASES STATE
// ==========================

let includeNewReleases = false;

document
  .getElementById('new-releases-btn')
  .addEventListener('click', () => {
    includeNewReleases = !includeNewReleases;

    document
      .getElementById('new-releases-btn')
      .classList.toggle('new-releases-active', includeNewReleases);

    console.log(`New releases: ${includeNewReleases ? 'ON' : 'OFF'}`);
  });

// ==========================
// SELECT ALL / CLEAR ALL
// ==========================

document
  .getElementById('select-all')
  .addEventListener('click', () => {
    document
      .querySelectorAll('.band-card:not(.hidden)')
      .forEach((card) => {
        const cb = card.querySelector('.band-checkbox');
        cb.checked = true;
        card.classList.add('selected');
      });
  });

document
  .getElementById('clear-all')
  .addEventListener('click', () => {
    document
      .querySelectorAll('.band-card')
      .forEach((card) => {
        const cb = card.querySelector('.band-checkbox');
        cb.checked = false;
        card.classList.remove('selected');
      });
  });

// ==========================
// ADD CUSTOM BAND
// ==========================

document
  .getElementById('add-band')
  .addEventListener('click', () => {
    const input = document.getElementById('new-band');
    const band = input.value.trim();
    if (!band) return;

    const exists = MASTER_BANDS.some(
      (b) => b.toLowerCase() === band.toLowerCase()
    );

    if (exists) {
      input.value = '';
      return;
    }

    MASTER_BANDS.push(band);
    MASTER_BANDS.sort();
    input.value = '';
    renderGrid();
  });

// ==========================
// GET ARTIST ID (Spotify)
// ==========================

async function getArtistId(artistName) {
  // 1. in-memory cache (fastest)
  if (artistCache[artistName]) {
    return artistCache[artistName];
  }

  // 2. Supabase cache — if we already have this band's
  //    spotify_id stored, use it with zero Spotify calls
  const cached = await dbGetBand(artistName);
  if (cached && cached.spotify_id) {
    console.log(`Artist ID cache HIT ✅ "${artistName}": ${cached.spotify_id}`);
    artistCache[artistName] = cached.spotify_id;
    return cached.spotify_id;
  }

  // 3. Fall back to Spotify API only if not cached
  async function trySearch(query) {
    const params = new URLSearchParams({
      q: query,
      type: 'artist',
      limit: '3'
    });

    const res = await spotifyFetch(
      `${SPOTIFY_API}/search?${params}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (!res.ok) return null;

    const data = await res.json();
    const items = data.artists?.items || [];
    if (!items.length) return null;

    const exact = items.find(
      (a) => a.name.toLowerCase() === artistName.toLowerCase()
    );

    return exact || items[0];
  }

  let artist = await trySearch(artistName);

  if (!artist) {
    const cleaned = artistName
      .replace(/[^a-zA-Z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (cleaned !== artistName) {
      artist = await trySearch(cleaned);
    }
  }

  if (!artist) {
    console.warn(`Spotify: artist NOT found — "${artistName}"`);
    return null;
  }

  console.log(`Spotify artist: "${artist.name}" id=${artist.id}`);
  artistCache[artistName] = artist.id;
  return artist.id;
}

// ==========================
// SETLIST.FM — MOST PLAYED LIVE SONGS
//
// Now cache-aware:
//   1. Check Supabase first
//   2. Cache hit → return instantly, zero setlist.fm calls
//   3. Cache miss → fetch setlist.fm → save to Supabase
// ==========================

// Returns { songs: string[], mbid: string|null }.
// Receives the band's DB row (already fetched by the caller) —
// it does NOT query the DB and does NOT save. The single save
// happens once, in resolveTracksForBand, with the URIs included.
async function getSetlistSongs(artistName, cached) {

  // --- CACHE CHECK (row passed in, zero DB calls) ---
  if (cached && cached.songs && cached.songs.length > 0) {
    return { songs: cached.songs, mbid: cached.mbid || null };
  }

  // --- CACHE MISS: fetch from setlist.fm ---
  try {
    const searchRes = await setlistFetch(
      setlistUrl(
        `/search/artists?artistName=${encodeURIComponent(artistName)}&p=1&sort=relevance`
      ),
      { headers: { 'Accept': 'application/json' } }
    );

    if (!searchRes.ok) {
      console.warn(`Setlist.fm search HTTP ${searchRes.status} for "${artistName}"`);
      return { songs: [], mbid: null };
    }

    const searchData = await searchRes.json();
    const artist = searchData.artist?.[0];

    if (!artist) {
      console.warn(`Setlist.fm: artist not found — "${artistName}"`);
      return { songs: [], mbid: null };
    }

    console.log(`Setlist.fm artist: "${artist.name}" mbid=${artist.mbid}`);

    // fetch page 1 and page 2 (~40 shows total)
    const setlists = [];

    for (const page of [1, 2]) {
      const setlistRes = await setlistFetch(
        setlistUrl(`/artist/${artist.mbid}/setlists?p=${page}`),
        { headers: { 'Accept': 'application/json' } }
      );

      if (!setlistRes.ok) {
        if (page === 1) {
          console.warn(`Setlist.fm setlists HTTP ${setlistRes.status} for "${artistName}"`);
          return { songs: [], mbid: null };
        }
        break;
      }

      const setlistData = await setlistRes.json();
      const pageShows = setlistData.setlist || [];
      if (!pageShows.length) break;
      setlists.push(...pageShows);
    }

    if (!setlists.length) {
      console.warn(`Setlist.fm: 0 setlists for "${artistName}"`);
      return { songs: [], mbid: null };
    }

    const totalShows = setlists.length;
    const playCount = {};
    const originalName = {};

    for (const show of setlists) {
      for (const set of (show.sets?.set || [])) {
        for (const song of (set.song || [])) {
          if (!song.name || song.cover) continue;

          const key = song.name.toLowerCase().trim();
          if (!originalName[key]) originalName[key] = song.name.trim();
          playCount[key] = (playCount[key] || 0) + 1;
        }
      }
    }

    if (!Object.keys(playCount).length) {
      console.warn(`Setlist.fm: empty sets for "${artistName}"`);
      return { songs: [], mbid: null };
    }

    // sort by consistency (% of shows) then raw count
    const sorted = Object.entries(playCount)
      .map(([key, count]) => ({
        key,
        count,
        consistency: count / totalShows
      }))
      .sort((a, b) => {
        if (b.consistency !== a.consistency) {
          return b.consistency - a.consistency;
        }
        return b.count - a.count;
      })
      .map((entry) => originalName[entry.key]);

    console.log(
      `Setlist.fm "${artistName}": ${sorted.length} songs from ${totalShows} shows. Top 5: ${sorted.slice(0, 5).join(', ')}`
    );

    // NOTE: no save here — resolveTracksForBand performs
    // the single save (songs + spotify_id + URIs together).
    return { songs: sorted, mbid: artist.mbid || null };

  } catch (err) {
    console.warn(`Setlist.fm exception for "${artistName}": ${err.message}`);
    return { songs: [], mbid: null };
  }
}

// ==========================
// SPOTIFY — FIND TRACK
// ==========================

async function findTrack(artistName, songName) {
  const artistId = await getArtistId(artistName);

  // Returns true if a track name looks like a duet,
  // remix, or featured version — we prefer the original.
  function isAltVersion(name) {
    const lower = (name || '').toLowerCase();
    return (
      /\bfeat\.?\b/.test(lower) ||
      /\bft\.?\b/.test(lower) ||
      /\bwith\b.{1,30}\bversion\b/.test(lower) ||
      /\bremix\b/.test(lower) ||
      /\bedit\b/.test(lower) ||
      /\bsped up\b/.test(lower) ||
      /\bslowed\b/.test(lower)
    );
  }

  async function searchTrack(q) {
    // fetch 10 candidates so we can pick the best one
    const params = new URLSearchParams({
      q,
      type: 'track',
      limit: '10'
    });

    const res = await spotifyFetch(
      `${SPOTIFY_API}/search?${params}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (!res.ok) return null;

    const data = await res.json();
    const items = data.tracks?.items || [];

    // filter: correct artist, not live, not an alt version
    const candidates = items.filter((t) => {
      if (isLiveTrack(t.name)) return false;
      if (isLiveTrack(t.album?.name)) return false;

      const isCorrectArtist = artistId
        ? t.artists?.some((a) => a.id === artistId)
        : t.artists?.some(
            (a) => a.name.toLowerCase() === artistName.toLowerCase()
          );

      return isCorrectArtist;
    });

    if (!candidates.length) return null;

    // prefer non-alt versions, sort by popularity descending
    // so we always get the highest-streamed original
    const originals = candidates.filter(
      (t) => !isAltVersion(t.name)
    );

    const pool = originals.length ? originals : candidates;

    pool.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));

    const best = pool[0];

    return {
      uri: best.uri,
      name: best.name,
      artistName: best.artists?.[0]?.name || artistName,
      popularity: best.popularity || 0
    };
  }

  // precise search first
  let track = await searchTrack(
    `track:"${songName}" artist:"${artistName}"`
  );

  // looser search if precise returns nothing
  if (!track) {
    track = await searchTrack(`${songName} ${artistName}`);
  }

  return track;
}

// ==========================
// SPOTIFY FALLBACK —
// MOST STREAMED TRACKS
// ==========================

async function getSpotifyFallbackTracks(artistName, needed) {
  if (
    topTracksCache[artistName] &&
    topTracksCache[artistName].length >= needed
  ) {
    return [...topTracksCache[artistName]];
  }

  const artistId = await getArtistId(artistName);
  const collected = [];
  const seenUris = new Set();

  for (
    let offset = 0;
    offset < 50 && collected.length < needed;
    offset += 10
  ) {
    const params = new URLSearchParams({
      q: artistId ? `artist:"${artistName}"` : artistName,
      type: 'track',
      limit: '10',
      offset: String(offset)
    });

    const res = await spotifyFetch(
      `${SPOTIFY_API}/search?${params}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (!res.ok) {
      console.warn(`Spotify fallback HTTP ${res.status} for "${artistName}"`);
      break;
    }

    const data = await res.json();
    const items = data.tracks?.items || [];
    if (!items.length) break;

    for (const track of items) {
      if (!track.uri || seenUris.has(track.uri)) continue;
      if (isLiveTrack(track.name)) continue;
      if (isLiveTrack(track.album?.name)) continue;

      const isCorrectArtist = artistId
        ? track.artists?.some((a) => a.id === artistId)
        : track.artists?.some(
            (a) => a.name.toLowerCase() === artistName.toLowerCase()
          );

      if (!isCorrectArtist) continue;

      seenUris.add(track.uri);
      collected.push({
        uri: track.uri,
        name: track.name,
        artistName: track.artists?.[0]?.name || artistName
      });

      if (collected.length >= needed) break;
    }
  }

  // loose fallback if strict filter left us short
  if (collected.length < needed) {
    const params = new URLSearchParams({
      q: artistName,
      type: 'track',
      limit: '10'
    });

    const res = await spotifyFetch(
      `${SPOTIFY_API}/search?${params}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (res.ok) {
      const data = await res.json();
      const items = data.tracks?.items || [];

      for (const track of items) {
        if (!track.uri || seenUris.has(track.uri)) continue;
        if (isLiveTrack(track.name)) continue;
        if (isLiveTrack(track.album?.name)) continue;

        seenUris.add(track.uri);
        collected.push({
          uri: track.uri,
          name: track.name,
          artistName: track.artists?.[0]?.name || artistName
        });

        if (collected.length >= needed) break;
      }
    }
  }

  if (!collected.length) {
    console.warn(`Spotify fallback: no tracks for "${artistName}"`);
    return [];
  }

  console.log(`Spotify fallback "${artistName}": ${collected.length} tracks`);
  topTracksCache[artistName] = collected;
  return [...collected];
}

// ==========================
// NEW RELEASES
// ==========================

async function getNewRelease(artistName) {
  const artistId = await getArtistId(artistName);
  if (!artistId) return null;

  const res = await spotifyFetch(
    `${SPOTIFY_API}/artists/${artistId}/albums?include_groups=album,single&limit=10&offset=0`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!res.ok) {
    console.warn(`New releases HTTP ${res.status} for "${artistName}"`);
    return null;
  }

  const data = await res.json();

  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 1);

  const recentAlbums = (data.items || [])
    .filter((a) => {
      if (isLiveTrack(a.name)) return false;
      return new Date(a.release_date) >= cutoff;
    })
    .sort((a, b) =>
      new Date(b.release_date) - new Date(a.release_date)
    );

  if (!recentAlbums.length) {
    console.warn(`New releases: nothing in last 12 months for "${artistName}"`);
    return null;
  }

  const latest = recentAlbums[0];

  const tracksRes = await spotifyFetch(
    `${SPOTIFY_API}/albums/${latest.id}/tracks?limit=5`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!tracksRes.ok) return null;

  const tracksData = await tracksRes.json();
  const tracks = (tracksData.items || []).filter(
    (t) => !isLiveTrack(t.name)
  );

  if (!tracks.length) return null;

  const t = tracks[0];

  console.log(
    `New release "${artistName}": "${t.name}" from "${latest.name}" (${latest.release_date})`
  );

  return {
    uri: t.uri,
    name: t.name,
    artistName: artistName,
    isNewRelease: true,
    releaseName: latest.name,
    releaseDate: latest.release_date
  };
}

// ==========================
// MAIN TRACK RESOLVER
// ==========================

async function resolveTracksForBand(artistName, amount) {
  status(`Checking setlists for ${artistName}...`);

  // fetch the band's DB row once and reuse it everywhere
  // so we don't make multiple Supabase calls per band
  const cached = await dbGetBand(artistName);

  // --- FAST PATH: cached URIs exist ---
  // return instantly with zero Spotify calls
  if (cached && cached.uris && cached.uris.length > 0) {
    console.log(
      `URI cache HIT ✅ "${artistName}": ${cached.uris.length} URIs, returning top ${amount}`
    );
    return cached.uris.slice(0, amount);
  }

  // pre-populate the in-memory artist ID cache from DB
  // so getArtistId never needs to call Spotify for this band
  if (cached && cached.spotify_id) {
    artistCache[artistName] = cached.spotify_id;
  }

  // --- NO URI CACHE: resolve from setlist + Spotify ---
  // pass the row we already fetched — getSetlistSongs makes
  // zero DB calls of its own now
  const setlistResult = await getSetlistSongs(artistName, cached);
  const setlistSongs = setlistResult.songs;
  const tracks = [];
  const seenNames = new Set();

  if (setlistSongs.length > 0) {
    status(`Matching ${artistName} setlist songs on Spotify...`);

    for (const songName of setlistSongs) {
      // fetch more than needed so we can cache a full set
      // even if the user only requested a few songs this time
      if (tracks.length >= Math.max(amount, 20)) break;

      const key = songName.toLowerCase().trim();
      if (seenNames.has(key)) continue;
      seenNames.add(key);

      const track = await findTrack(artistName, songName);

      if (track) {
        tracks.push(track);
      } else {
        console.warn(`No Spotify match: "${songName}" by "${artistName}"`);
      }
    }

    console.log(`${artistName}: ${tracks.length} tracks matched from setlist.fm`);
  }

  // top up from Spotify if short
  if (tracks.length < amount) {
    const stillNeed = amount - tracks.length;

    if (tracks.length > 0) {
      status(`Topping up ${artistName} with ${stillNeed} from Spotify...`);
    } else {
      status(`Using Spotify most streamed for ${artistName}...`);
    }

    const existingUris = new Set(tracks.map((t) => t.uri));
    const fallback = await getSpotifyFallbackTracks(artistName, amount);

    for (const t of fallback) {
      if (tracks.length >= amount) break;
      if (existingUris.has(t.uri)) continue;

      existingUris.add(t.uri);
      tracks.push(t);
    }
  }

  if (!tracks.length) {
    console.warn(`${artistName}: found nothing. Check spelling.`);
    return [];
  }

  // --- SAVE URIs TO CACHE ---
  // Single save per band. Works for NEW bands (cached === null)
  // and EXISTING bands alike — this was the bug: the old code
  // only saved when `cached` existed, so first-run bands never
  // got their URIs (or spotify_id) stored.
  const spotifyId =
    artistCache[artistName] ||        // populated by getArtistId during matching
    (cached && cached.spotify_id) ||  // or from the old row
    null;

  await dbSaveBand(
    artistName,
    setlistResult.mbid || (cached && cached.mbid) || null,
    setlistSongs.length ? setlistSongs : ((cached && cached.songs) || []),
    spotifyId,
    setlistSongs.length ? 'setlist' : 'spotify',
    tracks
  );

  console.log(`${artistName}: final ${tracks.length} tracks, URIs cached`);

  return tracks.slice(0, amount);
}

// ==========================
// CREATE PLAYLIST
// ==========================

async function createPlaylist(name, description) {
  const res = await spotifyFetch(
    `${SPOTIFY_API}/me/playlists`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name, description, public: true })
    }
  );

  if (!res.ok) throw new Error('Could not create playlist.');
  return await res.json();
}

// ==========================
// ADD TRACKS
// ==========================

async function addTracks(playlistId, uris) {
  if (!uris.length) return;

  for (let i = 0; i < uris.length; i += 100) {
    await spotifyFetch(
      `${SPOTIFY_API}/playlists/${playlistId}/items`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ uris: uris.slice(i, i + 100) })
      }
    );
  }
}

// ==========================
// GENERATE PLAYLIST
// ==========================

document
  .getElementById('generate-btn')
  .addEventListener('click', async () => {

    if (!accessToken) {
      status('Please connect Spotify first.');
      return;
    }

    const selected = [];

    document.querySelectorAll('.band-card').forEach((card) => {
      const cb = card.querySelector('.band-checkbox');
      if (!cb.checked) return;

      const select = card.querySelector('.tier-select');
      const custom = card.querySelector('.custom-input');

      let amount = select.value === 'custom'
        ? parseInt(custom.value) || 5
        : parseInt(select.value);

      amount = Math.max(1, Math.min(amount, 20));
      selected.push({ artist: cb.value, amount });
    });

    if (!selected.length) {
      status('Select at least one band.');
      return;
    }

    const sortOrder = document.getElementById('sort-order').value;

    if (sortOrder === 'name-asc') {
      selected.sort((a, b) => a.artist.localeCompare(b.artist));
    } else if (sortOrder === 'name-desc') {
      selected.sort((a, b) => b.artist.localeCompare(a.artist));
    } else if (sortOrder === 'songs-asc') {
      selected.sort((a, b) => a.amount - b.amount);
    } else if (sortOrder === 'songs-desc') {
      selected.sort((a, b) => b.amount - a.amount);
    }

    const btn = document.getElementById('generate-btn');
    btn.disabled = true;

    try {
      const finalTracks = [];
      const seenUris = new Set();
      const seenTitles = new Set();

      for (const band of selected) {
        const bandTracks = await resolveTracksForBand(
          band.artist,
          band.amount
        );

        for (const t of bandTracks) {
          if (!t.uri) continue;
          if (seenUris.has(t.uri)) continue;

          const cleanName = (t.name || '')
            .toLowerCase()
            .replace(/\s*[-\u2013([].*$/, '')
            .trim();

          const titleKey =
            (t.artistName || '').toLowerCase() + '|' + cleanName;

          if (seenTitles.has(titleKey)) continue;

          seenUris.add(t.uri);
          seenTitles.add(titleKey);
          finalTracks.push(t);
        }
      }

      // new releases appended after all bands
      if (includeNewReleases) {
        for (const band of selected) {
          status(`Fetching new release for ${band.artist}...`);

          const newRelease = await getNewRelease(band.artist);

          if (newRelease && !seenUris.has(newRelease.uri)) {
            const cleanName = (newRelease.name || '')
              .toLowerCase()
              .replace(/\s*[-\u2013([].*$/, '')
              .trim();

            const titleKey =
              (newRelease.artistName || '').toLowerCase() + '|' + cleanName;

            if (!seenTitles.has(titleKey)) {
              seenUris.add(newRelease.uri);
              seenTitles.add(titleKey);
              finalTracks.push(newRelease);
              console.log(`+ New release: "${newRelease.name}" by ${band.artist}`);
            }
          }
        }
      }

      const finalUris = finalTracks.map((t) => t.uri);

      const title =
        document.getElementById('playlist-name').value.trim() ||
        'Festival Tape';

      const desc =
        document.getElementById('playlist-desc').value.trim() || '';

      status('Creating playlist...');
      const playlist = await createPlaylist(title, desc);

      status('Adding songs...');
      await addTracks(playlist.id, finalUris);

      const newReleaseCount = finalTracks.filter((t) => t.isNewRelease).length;

      status(`
        Playlist created!
        <br><br>
        <a href="https://open.spotify.com/playlist/${playlist.id}" target="_blank">
          Open Playlist
        </a>
        <br><br>
        Songs added: ${finalUris.length}
        ${newReleaseCount > 0 ? `<br>✦ New releases included: ${newReleaseCount}` : ''}
      `);

    } catch (err) {
      console.error(err);
      status(`Error: ${err.message}`);
    }

    btn.disabled = false;
  });
