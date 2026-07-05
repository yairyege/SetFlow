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

async function dbGetBand(name) {
  try {
    const key = name.toLowerCase().trim();

    // calls go through the Cloudflare Worker
    // which holds SUPABASE_KEY server-side
    const res = await fetch(
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
    // which holds SUPABASE_KEY server-side
    const res = await fetch(
      `${WORKER_URL}/supabase/bands`,
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
      console.log(`Cache SAVED ✅ "${name}" (${songs.length} songs, source: ${source})`);
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
// Enforces a minimum gap between Spotify API calls.
// Tracks consecutive 429s and backs off exponentially.
let lastSpotifyCall = 0;
let spotifyBackoff = 300;      // current gap in ms, starts at 300
let spotify429Count = 0;       // consecutive 429 counter

async function spotifyFetch(url, opts) {
  const gap = Date.now() - lastSpotifyCall;
  if (gap < spotifyBackoff) await wait(spotifyBackoff - gap);
  lastSpotifyCall = Date.now();

  let res = await fetch(url, opts);

  if (res.status === 429) {
    spotify429Count++;

    // read Retry-After header if Spotify sends one
    const retryAfter = parseInt(res.headers.get('Retry-After') || '10');

    // exponential backoff: each consecutive 429 doubles the gap
    // up to a max of 10 seconds between calls
    spotifyBackoff = Math.min(spotifyBackoff * 2, 10000);

    console.warn(
      `Spotify 429 (#${spotify429Count}) — waiting ${retryAfter}s, backoff now ${spotifyBackoff}ms`
    );

    await wait(retryAfter * 1000);
    lastSpotifyCall = Date.now();

    res = await fetch(url, opts);

    // if still 429 after retry, return the 429 response
    // so callers can handle it gracefully rather than
    // hammering Spotify further
    if (res.status !== 429) {
      // successful call — slowly recover the backoff
      spotifyBackoff = Math.max(spotifyBackoff / 2, 300);
      spotify429Count = 0;
    }
  } else {
    // successful call — slowly recover backoff
    if (spotifyBackoff > 300) {
      spotifyBackoff = Math.max(spotifyBackoff / 2, 300);
    }
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

async function getArtistId(artistName, cachedRow = null) {
  // 1. in-memory cache (fastest)
  if (artistCache[artistName]) {
    return artistCache[artistName];
  }

  // 2. Use passed row or fall back to Supabase cache
  const cached = cachedRow || await dbGetBand(artistName);
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

async function getSetlistSongs(artistName, cachedRow = null) {
  // --- CACHE CHECK ---
  const cached = cachedRow || await dbGetBand(artistName);

  if (cached && cached.songs && cached.songs.length > 0) {
    return cached.songs; // array of song name strings
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
      return [];
    }

    const searchData = await searchRes.json();
    const artist = searchData.artist?.[0];

    if (!artist) {
      console.warn(`Setlist.fm: artist not found — "${artistName}"`);
      return [];
    }

    console.log(`Setlist.fm artist: "${artist.name}" mbid=${artist.mbid}`);

    const setlists = [];

    for (const page of [1, 2]) {
      const setlistRes = await setlistFetch(
        setlistUrl(`/artist/${artist.mbid}/setlists?p=${page}`),
        { headers: { 'Accept': 'application/json' } }
      );

      if (!setlistRes.ok) {
        if (page === 1) {
          console.warn(`Setlist.fm setlists HTTP ${setlistRes.status} for "${artistName}"`);
          return [];
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
      return [];
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
      return [];
    }

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
      `Setlist.fm "${artistName}": ${sorted.length} songs from ${totalShows} shows.`
    );

    // --- SAVE TO CACHE ---
    const spotifyId = await getArtistId(artistName, cached);
    await dbSaveBand(artistName, artist.mbid, sorted, spotifyId, 'setlist');

    return sorted;

  } catch (err) {
    console.warn(`Setlist.fm exception for "${artistName}": ${err.message}`);
    return [];
  }
}

// ==========================
// SETLIST.FM — MOST PLAYED LIVE SONGS
//
// Now cache-aware:
//   1. Check Supabase first
//   2. Cache hit → return instantly, zero setlist.fm calls
//   3. Cache miss → fetch setlist.fm → save to Supabase
// ==========================

async function getSetlistSongs(artistName) {

  // --- CACHE CHECK ---
  const cached = await dbGetBand(artistName);

  if (cached && cached.songs && cached.songs.length > 0) {
    return cached.songs; // array of song name strings
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
      return [];
    }

    const searchData = await searchRes.json();
    const artist = searchData.artist?.[0];

    if (!artist) {
      console.warn(`Setlist.fm: artist not found — "${artistName}"`);
      return [];
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
          return [];
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
      return [];
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
      return [];
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

    // --- SAVE TO CACHE ---
    // get Spotify ID to store alongside the songs
    const spotifyId = await getArtistId(artistName);
    await dbSaveBand(artistName, artist.mbid, sorted, spotifyId, 'setlist');

    return sorted;

  } catch (err) {
    console.warn(`Setlist.fm exception for "${artistName}": ${err.message}`);
    return [];
  }
}

// ==========================
// SPOTIFY — FIND TRACK
// ==========================

async function findTrack(artistName, songName, artistId) {
  // Remove the old intra-function getArtistId call

  function isAltVersion(name) {
    const lower = (name || '').toLowerCase();
    return (
      / feat\.? /.test(lower) ||
      / ft\.? /.test(lower) ||
      / with .{1,30} version /.test(lower) ||
      / remix /.test(lower) ||
      / edit /.test(lower) ||
      / sped up /.test(lower) ||
      / slowed /.test(lower)
    );
  }

  async function searchTrack(q) {
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

  let track = await searchTrack(
    `track:"${songName}" artist:"${artistName}"`
  );

  if (!track) {
    track = await searchTrack(`${songName} ${artistName}`);
  }

  return track;
}}

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

  // 1. Fetch the band's DB row once at the start
  const cached = await dbGetBand(artistName);

  // --- FAST PATH: cached URIs exist ---
  if (cached && cached.uris && cached.uris.length > 0) {
    console.log(
      `URI cache HIT ✅ "${artistName}": ${cached.uris.length} URIs, returning top ${amount}`
    );
    return cached.uris.slice(0, amount);
  }

  // Pre-populate the in-memory artist ID cache if we have the ID
  if (cached && cached.spotify_id) {
    artistCache[artistName] = cached.spotify_id;
  }

  // --- NO URI CACHE: resolve from setlist + Spotify ---
  const setlistSongs = await getSetlistSongs(artistName);
  const tracks = [];
  const seenNames = new Set();

  if (setlistSongs.length > 0) {
    status(`Matching ${artistName} setlist songs on Spotify...`);

    for (const songName of setlistSongs) {
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

  // Top up from Spotify if short
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

  // --- FIX: SAVE URIs TO CACHE FOR BOTH NEW & EXISTING BANDS ---
  // If the band was brand new, getSetlistSongs just inserted it. 
  // We fetch the fresh row state so we have the valid mbid and songs array.
  const targetRow = cached || await dbGetBand(artistName);

  if (targetRow) {
    await dbSaveBand(
      artistName,
      targetRow.mbid,
      targetRow.songs,
      targetRow.spotify_id,
      targetRow.source,
      tracks // Permanently commits the resolved array of track objects
    );
    console.log(`${artistName}: final ${tracks.length} tracks, URIs safely cached!`);
  } else {
    console.warn(`Could not save URIs: Band row missing from database initialization.`);
  }

  return tracks.slice(0, amount);
}}

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
