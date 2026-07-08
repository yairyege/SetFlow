// WORKER_URL loaded from config.js
// SUPABASE_URL, SUPABASE_KEY, SETLIST_KEY, SPOTIFY_CLIENT_SECRET live in Cloudflare Worker env vars

// ==========================
// URL HELPERS
// ==========================

function setlistUrl(path) {
  return `${WORKER_URL}/setlist${path}`;
}

// USER-token route — ONLY for playlist creation + adding tracks.
// Requires the user to be logged in (accessToken).
function spotifyUrl(path) {
  return `${WORKER_URL}/spotify${path}`;
}

// APP-token route — search, artist lookup, albums.
// The Worker injects its own client-credentials token,
// so NO user login is needed for any of this.
function spotifyAppUrl(path) {
  return `${WORKER_URL}/spotify-app${path}`;
}

// ==========================
// SUPABASE BAND CACHE
// ==========================

const CACHE_MAX_AGE_DAYS = 30;

async function dbGetBand(name) {
  try {
    const key = name.toLowerCase().trim();

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

    const ageDays =
      (Date.now() - new Date(row.updated_at).getTime()) /
      (1000 * 60 * 60 * 24);

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
      songs: songs || [],
      spotify_id: spotifyId || null,
      source: source || 'setlist',
      updated_at: new Date().toISOString(),
      uris: uris || null
    };

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
      console.log(
        `Cache SAVED ✅ "${name}" (mbid: ${mbid || 'none'}, ${(songs || []).length} songs, uris: ${uris ? uris.length : 0})`
      );
    }

  } catch (err) {
    console.warn(`Supabase SAVE exception: ${err.message}`);
  }
}

// ==========================
// RATE LIMITERS + ADVANCED RETRY ENGINE
// ==========================

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Setlist.fm Throttling ---
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
      console.warn('Setlist.fm still 429 — falling back to Spotify');
    }
  }

  return res;
}

// --- Spotify Throttling with Persistent Cooldown and True Multi-Attempt Loop ---
let lastSpotifyCall = 0;
let spotifyBackoff = 1200;
let spotify429Count = 0;

// Circuit breaker: trips when the Worker reports that Spotify app
// credentials aren't configured (e.g. no Spotify app exists yet).
// Once tripped, all Spotify lookups short-circuit instantly instead
// of burning pacing delays on calls that can only fail.
let spotifyAppUnavailable = false;

async function spotifyFetch(url, opts = {}, maxAttempts = 3) {
  let attempt = 0;

  while (attempt < maxAttempts) {
    attempt++;

    // Enforce current safety pacing gap
    const gap = Date.now() - lastSpotifyCall;
    if (gap < spotifyBackoff) await wait(spotifyBackoff - gap);
    lastSpotifyCall = Date.now();

    try {
      let res = await fetch(url, opts);

      // Worker says app credentials missing → trip the breaker
      if (
        res.status === 500 &&
        url.includes('/spotify-app/') &&
        !spotifyAppUnavailable
      ) {
        try {
          const errBody = await res.clone().json();
          if ((errBody.error || '').includes('credentials not set')) {
            spotifyAppUnavailable = true;
            console.warn(
              '⛔ Spotify app credentials not set in Worker env vars — ' +
              'skipping ALL Spotify calls for this session. ' +
              '(Expected until the new Spotify app exists. ' +
              'Setlist.fm + Supabase caching still work.)'
            );
          }
        } catch { /* body wasn't JSON — ignore */ }
        return res;
      }

      if (res.status === 429) {
        spotify429Count++;
        const retryAfter = parseInt(res.headers.get('Retry-After') || '5');

        // Force a wide safety padding for all subsequent requests
        // in this run. This breaks the rapid-fire cycle that trips
        // rolling windows.
        spotifyBackoff = Math.max(1500, spotifyBackoff);

        console.warn(
          `⚠️ Spotify 429 encountered (#${spotify429Count}) on attempt ${attempt}/${maxAttempts}.\n` +
          `Waiting ${retryAfter}s penalty window requested by API.\n` +
          `Baseline safety gap raised to ${spotifyBackoff}ms to protect subsequent songs.`
        );

        await wait(retryAfter * 1000);
        continue;
      }

      // If successful, slowly ease the safety backoff back down towards floor
      if (spotifyBackoff > 300) {
        spotifyBackoff = Math.max(300, spotifyBackoff - 50);
      }

      return res;

    } catch (err) {
      console.warn(`Fetch connection error on attempt ${attempt}/${maxAttempts}: ${err.message}`);
      if (attempt >= maxAttempts) throw err;
      await wait(2000);
    }
  }

  throw new Error(`Spotify API rate limits heavily exhausted after ${maxAttempts} consecutive retries.`);
}

// ==========================
// LIVE VERSION FILTER
// ==========================

function isLiveTrack(name) {
  if (!name) return false;
  const lower = name.toLowerCase();
  return [
    /\blive\b/,
    /\(live/,
    /- live/,
    /\bconcert\b/,
    /\bunplugged\b/,
    /\bacoustic\b/,
    /\brecorded at\b/,
    /\bat the\b.*\b(arena|stadium|festival|hall|theatre|theater|club|venue)\b/
  ].some((p) => p.test(lower));
}

// ==========================
// HTML ESCAPE (for preview rendering)
// ==========================

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ==========================
// SONG ENTRY NORMALIZER
//
// Cached rows saved before the stats upgrade store songs as plain
// strings; newer rows store { name, count, shows } objects. This
// makes both formats look the same to the resolver.
// ==========================

function normalizeSongEntries(songs) {
  return (songs || [])
    .map((s) =>
      typeof s === 'string'
        ? { name: s, count: null, shows: null }
        : s
    )
    .filter((s) => s && s.name);
}

// ==========================
// FEATURE TOGGLES
//
// Each toggle only ever FILTERS or ANNOTATES the setlist data we
// already fetch — none of them require Spotify. New features slot
// in here as more flags without touching the resolver's core.
// ==========================

let includeNewReleases = false;
let showSetlistStats = true;   // coverage % + per-song frequency
let tourYearOnly = false;      // scope setlists to one year
let selectedYear = null;       // chosen in the picker

document
  .getElementById('new-releases-btn')
  .addEventListener('click', () => {
    includeNewReleases = !includeNewReleases;
    document
      .getElementById('new-releases-btn')
      .classList.toggle('new-releases-active', includeNewReleases);
    console.log(`New releases: ${includeNewReleases ? 'ON' : 'OFF'}`);
  });

// --- Setlist stats toggle ---
const statsToggle = document.getElementById('stats-toggle');
if (statsToggle) {
  statsToggle.classList.toggle('toggle-on', showSetlistStats);
  statsToggle.addEventListener('click', () => {
    showSetlistStats = !showSetlistStats;
    statsToggle.classList.toggle('toggle-on', showSetlistStats);
    // re-render so existing preview reflects the change instantly
    if (previewTracks.length) renderPreview();
    console.log(`Setlist stats: ${showSetlistStats ? 'ON' : 'OFF'}`);
  });
}

// --- Tour-year toggle + picker ---
const tourToggle = document.getElementById('tour-toggle');
const yearPicker = document.getElementById('tour-year');

if (tourToggle) {
  tourToggle.addEventListener('click', () => {
    tourYearOnly = !tourYearOnly;
    tourToggle.classList.toggle('toggle-on', tourYearOnly);
    if (yearPicker) yearPicker.classList.toggle('hidden', !tourYearOnly);
    console.log(`Tour-year only: ${tourYearOnly ? 'ON' : 'OFF'}`);
  });
}

if (yearPicker) {
  // default the picker to a sensible recent span; it self-populates
  // with real years the first time a band with year data resolves
  const nowY = new Date().getFullYear();
  for (let y = nowY; y >= nowY - 6; y--) {
    const opt = document.createElement('option');
    opt.value = String(y);
    opt.textContent = String(y);
    yearPicker.appendChild(opt);
  }
  selectedYear = nowY;
  yearPicker.value = String(nowY);
  yearPicker.addEventListener('change', () => {
    selectedYear = parseInt(yearPicker.value) || null;
    console.log(`Tour year → ${selectedYear}`);
  });
}

// merge real show-years discovered during resolution into the picker,
// preserving the user's current choice
function syncYearPicker(years) {
  if (!yearPicker || !years || !years.length) return;
  const have = new Set(
    Array.from(yearPicker.options).map((o) => parseInt(o.value))
  );
  const keep = yearPicker.value;
  years.forEach((y) => {
    if (!have.has(y)) {
      const opt = document.createElement('option');
      opt.value = String(y);
      opt.textContent = String(y);
      yearPicker.appendChild(opt);
      have.add(y);
    }
  });
  // re-sort options newest-first
  const sorted = Array.from(yearPicker.options)
    .sort((a, b) => parseInt(b.value) - parseInt(a.value));
  yearPicker.innerHTML = '';
  sorted.forEach((o) => yearPicker.appendChild(o));
  yearPicker.value = keep;
}

// ==========================
// GENRE FILTER
//
// Options come straight from GENRE_BANDS (script-part1.js) — the
// same grouping MASTER_BANDS is genre-sorted by — so this dropdown
// can't drift out of sync with the actual band categories.
// ==========================

const genreFilterEl = document.getElementById('genre-filter');

Object.keys(GENRE_BANDS).forEach((genre) => {
  const option = document.createElement('option');
  option.value = genre;
  option.textContent = genre;
  genreFilterEl.appendChild(option);
});

genreFilterEl.addEventListener('change', applyGridFilters);

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

    // appended at the end (genre "Other") rather than re-sorted —
    // a global sort here would undo the genre-grouped order of
    // MASTER_BANDS built in script-part1.js
    MASTER_BANDS.push(band);
    input.value = '';
    renderGrid();
  });

// ==========================
// GET ARTIST ID (Spotify — APP TOKEN, no login)
// ==========================

async function getArtistId(artistName) {
  if (spotifyAppUnavailable) return null;

  if (artistCache[artistName]) {
    return artistCache[artistName];
  }

  async function trySearch(query) {
    const params = new URLSearchParams({
      q: query,
      type: 'artist',
      limit: '3'
    });

    try {
      const res = await spotifyFetch(spotifyAppUrl(`/search?${params}`));

      if (!res.ok) return null;

      const data = await res.json();
      const items = data.artists?.items || [];
      if (!items.length) return null;

      return items.find(
        (a) => a.name.toLowerCase() === artistName.toLowerCase()
      ) || items[0];
    } catch (err) {
      console.warn(`Artist ID lookup omitted due to pacing block: ${err.message}`);
      return null;
    }
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
// SETLIST.FM — MOST PLAYED
// ==========================

// setlist.fm eventDate is "DD-MM-YYYY" — pull the year out safely
function eventYear(show) {
  const d = show?.eventDate || '';
  const m = /^\d{2}-\d{2}-(\d{4})$/.exec(d);
  return m ? parseInt(m[1]) : null;
}

// filterYear (optional): only count shows from that calendar year.
// Returns songs with per-song play counts + the year list actually seen,
// so the UI can offer a year picker without a second fetch.
async function getSetlistSongs(artistName, filterYear = null) {
  try {
    const searchRes = await setlistFetch(
      setlistUrl(
        `/search/artists?artistName=${encodeURIComponent(artistName)}&p=1&sort=relevance`
      ),
      { headers: { 'Accept': 'application/json' } }
    );

    if (!searchRes.ok) {
      console.warn(`Setlist.fm search HTTP ${searchRes.status} for "${artistName}"`);
      return { mbid: null, songs: [], years: [] };
    }

    const searchData = await searchRes.json();
    const artist = searchData.artist?.[0];

    if (!artist) {
      console.warn(`Setlist.fm: artist not found — "${artistName}"`);
      return { mbid: null, songs: [], years: [] };
    }

    const artistMbid = artist.mbid;
    console.log(`Setlist.fm artist: "${artist.name}" mbid=${artistMbid}`);

    const setlists = [];

    for (const page of [1, 2]) {
      const setlistRes = await setlistFetch(
        setlistUrl(`/artist/${artistMbid}/setlists?p=${page}`),
        { headers: { 'Accept': 'application/json' } }
      );

      if (!setlistRes.ok) {
        if (page === 1) {
          console.warn(`Setlist.fm setlists HTTP ${setlistRes.status} for "${artistName}"`);
          return { mbid: artistMbid, songs: [], years: [] };
        }
        break;
      }

      const data = await setlistRes.json();
      const shows = data.setlist || [];
      if (!shows.length) break;
      setlists.push(...shows);
    }

    if (!setlists.length) {
      console.warn(`Setlist.fm: 0 setlists for "${artistName}"`);
      return { mbid: artistMbid, songs: [], years: [] };
    }

    // every distinct year present, newest first — for the picker
    const years = [...new Set(setlists.map(eventYear).filter(Boolean))]
      .sort((a, b) => b - a);

    // apply the year filter if one was requested (and that year exists)
    const scoped = filterYear
      ? setlists.filter((s) => eventYear(s) === filterYear)
      : setlists;

    // a show only counts toward totals if it actually lists songs
    const showsWithSongs = scoped.filter((show) =>
      (show.sets?.set || []).some((set) => (set.song || []).length)
    );

    const totalShows = showsWithSongs.length;

    if (!totalShows) {
      console.warn(
        `Setlist.fm: no song-bearing shows for "${artistName}"` +
        (filterYear ? ` in ${filterYear}` : '')
      );
      return { mbid: artistMbid, songs: [], years };
    }

    const playCount = {};
    const originalName = {};

    for (const show of showsWithSongs) {
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
      return { mbid: artistMbid, songs: [], years };
    }

    const sorted = Object.entries(playCount)
      .map(([key, count]) => ({
        key,
        count,
        consistency: count / totalShows
      }))
      .sort((a, b) =>
        b.consistency !== a.consistency
          ? b.consistency - a.consistency
          : b.count - a.count
      )
      .map((e) => ({
        name: originalName[e.key],
        count: e.count,
        shows: totalShows
      }));

    console.log(
      `Setlist.fm "${artistName}": ${sorted.length} songs from ${totalShows} shows` +
      (filterYear ? ` (year ${filterYear})` : '') + '.'
    );

    return { mbid: artistMbid, songs: sorted, years };

  } catch (err) {
    console.warn(`Setlist.fm exception for "${artistName}": ${err.message}`);
    return { mbid: null, songs: [], years: [] };
  }
}

// ==========================
// SPOTIFY — FIND SINGLE TRACK (APP TOKEN, no login)
// ==========================

async function findTrack(artistName, songName) {
  if (spotifyAppUnavailable) return null;

  const artistId = await getArtistId(artistName);

  async function search(query) {
    const params = new URLSearchParams({
      q: query,
      type: 'track',
      limit: '5'
    });

    const res = await spotifyFetch(spotifyAppUrl(`/search?${params}`));
    if (!res.ok) return null;

    const data = await res.json();
    const items = data.tracks?.items || [];

    for (const track of items) {
      if (!track.uri) continue;
      if (isLiveTrack(track.name)) continue;
      if (isLiveTrack(track.album?.name)) continue;

      const isCorrect = artistId
        ? track.artists?.some((a) => a.id === artistId)
        : track.artists?.some(
            (a) => a.name.toLowerCase() === artistName.toLowerCase()
          );

      if (!isCorrect) continue;

      return {
        uri: track.uri,
        name: track.name,
        artistName: track.artists?.[0]?.name || artistName,
        spotifyUrl: track.external_urls?.spotify ||
          (track.id ? `https://open.spotify.com/track/${track.id}` : null),
        album: track.album?.name || null,
        verified: true
      };
    }

    return null;
  }

  try {
    // strict field search first, then loose
    let track = await search(`track:"${songName}" artist:"${artistName}"`);
    if (!track) track = await search(`${songName} ${artistName}`);
    return track;
  } catch (err) {
    console.warn(`findTrack failed for "${songName}": ${err.message}`);
    return null;
  }
}

// ==========================
// SPOTIFY FALLBACK (APP TOKEN, no login)
// ==========================

async function getSpotifyFallbackTracks(artistName, needed) {
  if (spotifyAppUnavailable) return [];

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

    try {
      const res = await spotifyFetch(spotifyAppUrl(`/search?${params}`));

      if (!res.ok) break;

      const data = await res.json();
      const items = data.tracks?.items || [];
      if (!items.length) break;

      for (const track of items) {
        if (!track.uri || seenUris.has(track.uri)) continue;
        if (isLiveTrack(track.name)) continue;
        if (isLiveTrack(track.album?.name)) continue;

        const isCorrect = artistId
          ? track.artists?.some((a) => a.id === artistId)
          : track.artists?.some(
              (a) => a.name.toLowerCase() === artistName.toLowerCase()
            );

        if (!isCorrect) continue;

        seenUris.add(track.uri);
        collected.push({
          uri: track.uri,
          name: track.name,
          artistName: track.artists?.[0]?.name || artistName,
          source: 'top'
        });

        if (collected.length >= needed) break;
      }
    } catch (err) {
      console.warn(`Fallback parsing batch interrupted by rate limiting protection:`, err.message);
      break;
    }
  }

  // loose fallback execution
  if (collected.length < needed) {
    const params = new URLSearchParams({
      q: artistName,
      type: 'track',
      limit: '10'
    });

    try {
      const res = await spotifyFetch(spotifyAppUrl(`/search?${params}`));

      if (res.ok) {
        const data = await res.json();
        const items = data.tracks?.items || [];

        for (const track of items) {
          if (!track.uri || seenUris.has(track.uri)) continue;
          if (isLiveTrack(track.name)) continue;

          seenUris.add(track.uri);
          collected.push({
            uri: track.uri,
            name: track.name,
            artistName: track.artists?.[0]?.name || artistName,
            source: 'top'
          });

          if (collected.length >= needed) break;
        }
      }
    } catch (err) {
      console.warn(`Secondary loop fallback processing structural crash:`, err.message);
    }
  }

  if (!collected.length) {
    console.warn(`Spotify fallback: no tracks for "${artistName}"`);
    return [];
  }

  topTracksCache[artistName] = collected;
  return [...collected];
}

// ==========================
// NEW RELEASES (APP TOKEN, no login)
// ==========================

async function getNewRelease(artistName) {
  if (spotifyAppUnavailable) return null;

  const artistId = await getArtistId(artistName);
  if (!artistId) return null;

  try {
    const res = await spotifyFetch(
      spotifyAppUrl(`/artists/${artistId}/albums?include_groups=album,single&limit=10`)
    );

    if (!res.ok) return null;

    const data = await res.json();
    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - 1);

    const recent = (data.items || [])
      .filter((a) => !isLiveTrack(a.name) && new Date(a.release_date) >= cutoff)
      .sort((a, b) => new Date(b.release_date) - new Date(a.release_date));

    if (!recent.length) return null;

    const latest = recent[0];

    const tracksRes = await spotifyFetch(
      spotifyAppUrl(`/albums/${latest.id}/tracks?limit=5`)
    );

    if (!tracksRes.ok) return null;

    const tracksData = await tracksRes.json();
    const tracks = (tracksData.items || []).filter((t) => !isLiveTrack(t.name));

    if (!tracks.length) return null;

    const t = tracks[0];

    return {
      uri: t.uri,
      name: t.name,
      artistName: artistName,
      source: 'new-release',
      isNewRelease: true,
      releaseName: latest.name,
      releaseDate: latest.release_date
    };
  } catch (err) {
    console.warn(`Skipping new release query branch for "${artistName}" due to pacing lock.`);
    return null;
  }
}

// ==========================
// MAIN TRACK RESOLVER
//
// ⚠️ SINGLE definition. The old duplicate that shadowed the
// mbid fix has been removed — that duplicate was why mbid
// stayed null in Supabase and why the setlist branch never ran.
// Runs entirely on the app token — no user login required.
// ==========================

async function resolveTracksForBand(artistName, amount) {
  status(`Checking setlists for ${artistName}...`);

  // Tour-year mode scopes to a single year. The all-time caches
  // (URIs + songs) don't represent that slice, so in this mode we
  // bypass them for a fresh year-filtered fetch and DON'T write the
  // year-scoped result back to the all-time cache.
  const yearScoped = tourYearOnly && selectedYear;

  // fetch DB row once — reused throughout this function
  const cached = await dbGetBand(artistName);

  // FAST PATH: cached URIs exist → zero Spotify calls
  // (skipped in year-scoped mode — cache is all-time)
  if (!yearScoped && cached && cached.uris && cached.uris.length > 0) {
    console.log(
      `URI cache HIT ✅ "${artistName}": returning top ${amount} of ${cached.uris.length}`
    );
    return cached.uris.slice(0, amount);
  }

  // pre-populate artist ID from DB so getArtistId skips the Spotify lookup
  if (cached && cached.spotify_id) {
    artistCache[artistName] = cached.spotify_id;
    console.log(`Artist ID pre-loaded from cache: ${cached.spotify_id}`);
  }

  // resolve songs + mbid — reuse cached setlist data if a previous
  // run (e.g. warmSetlistsOnly) already fetched it, otherwise hit
  // setlist.fm. Saves a full setlist.fm round-trip per band.
  let setlistMbid = cached?.mbid || null;
  let setlistSongs = [];

  if (
    !yearScoped &&
    cached &&
    cached.mbid &&
    cached.source === 'setlist' &&
    Array.isArray(cached.songs) &&
    cached.songs.length > 0
  ) {
    setlistSongs = normalizeSongEntries(cached.songs);
    console.log(
      `Setlist songs loaded from cache ✅ "${artistName}" (${setlistSongs.length} songs, no setlist.fm call)`
    );
  } else {
    const result = await getSetlistSongs(
      artistName,
      yearScoped ? selectedYear : null
    );
    setlistMbid = result.mbid || setlistMbid;
    setlistSongs = result.songs;

    // keep the year picker in sync with real data the first time
    // we see this band's actual show years
    if (result.years && result.years.length) {
      syncYearPicker(result.years);
    }
  }

  const tracks = [];
  const seenNames = new Set();

  if (setlistSongs.length > 0) {
    status(`Matching ${artistName} songs on Spotify...`);

    for (const songEntry of setlistSongs) {
      // fetch more than requested so cache covers future larger requests
      if (tracks.length >= Math.max(amount, 20)) break;

      const key = songEntry.name.toLowerCase().trim();
      if (seenNames.has(key)) continue;
      seenNames.add(key);

      const track = await findTrack(artistName, songEntry.name);
      if (track) {
        // stats travel WITH the track — into the preview and the URI cache
        track.source = 'setlist';
        if (songEntry.count != null) {
          track.playCount = songEntry.count;
          track.totalShows = songEntry.shows;
        }
        tracks.push(track);
      } else {
        console.warn(`No match: "${songEntry.name}" by "${artistName}"`);
      }
    }

    console.log(`${artistName}: ${tracks.length} tracks matched from setlist.fm`);
  }

  // top up from Spotify if short
  if (tracks.length < amount) {
    const existingUris = new Set(tracks.map((t) => t.uri));

    if (tracks.length > 0) {
      status(`Topping up ${artistName}...`);
    } else {
      status(`Using Spotify for ${artistName}...`);
    }

    const fallback = await getSpotifyFallbackTracks(artistName, amount);

    for (const t of fallback) {
      if (tracks.length >= amount) break;
      if (existingUris.has(t.uri)) continue;
      existingUris.add(t.uri);
      tracks.push(t);
    }
  }

  if (!tracks.length) {
    // Spotify matched nothing (or is unavailable) — but if we DID
    // get setlist data, save it anyway so the setlist.fm fetch isn't
    // wasted. URIs stay empty; a future run fills them in without
    // touching setlist.fm again.
    // (Never cache year-scoped data — it's not the all-time picture.)
    if (!yearScoped && (setlistSongs.length > 0 || setlistMbid)) {
      await dbSaveBand(
        artistName,
        setlistMbid || cached?.mbid || null,
        setlistSongs.length ? setlistSongs : (cached?.songs || []),
        cached?.spotify_id || artistCache[artistName] || null,
        'setlist',
        cached?.uris || null
      );
      console.log(
        `${artistName}: setlist data cached (URIs pending — Spotify unavailable or no matches)`
      );
    } else if (!yearScoped) {
      console.warn(`${artistName}: found nothing. Check spelling.`);
    }
    return [];
  }

  // save to cache — freshly-found mbid takes priority over stale/null cache
  // (year-scoped runs skip the write: the all-time cache must stay all-time)
  if (!yearScoped) {
    const spotifyIdToSave =
      cached?.spotify_id || artistCache[artistName] || null;

    const songsToSave = setlistSongs.length > 0
      ? setlistSongs
      : (cached?.songs || tracks.map((t) => t.name));

    const source = setlistSongs.length > 0 ? 'setlist' : 'spotify';

    await dbSaveBand(
      artistName,
      setlistMbid || cached?.mbid || null,
      songsToSave,
      spotifyIdToSave,
      source,
      tracks
    );

    console.log(
      `${artistName}: ${tracks.length} tracks resolved + URIs saved to cache`
    );
  } else {
    console.log(`${artistName}: ${tracks.length} year-scoped tracks (not cached)`);
  }

  return tracks.slice(0, amount);
}

// ==========================
// CREATE PLAYLIST (USER TOKEN — needs login)
// ==========================

async function createPlaylist(name, description) {
  const res = await spotifyFetch(
    spotifyUrl(`/me/playlists`),
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
// ADD TRACKS (USER TOKEN — needs login)
// ==========================

async function addTracks(playlistId, uris) {
  if (!uris.length) return;

  for (let i = 0; i < uris.length; i += 100) {
    await spotifyFetch(
      spotifyUrl(`/playlists/${playlistId}/items`),
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
// PREVIEW STATE + BUILD SETLIST
//
// New flow: "Build Setlist" resolves everything WITHOUT login
// and renders a preview. "Sync to Spotify" (in the preview
// panel) is what triggers login — only if needed.
// ==========================

let previewTracks = [];

document
  .getElementById('build-btn')
  .addEventListener('click', async () => {

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

    const btn = document.getElementById('build-btn');
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

        // new release goes at the END of THIS band's section,
        // not appended to the end of the whole playlist
        if (includeNewReleases) {
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

      previewTracks = finalTracks;
      renderPreview();

      if (finalTracks.length) {
        status(
          `Setlist ready — ${finalTracks.length} songs. ` +
          `Review below, remove anything you don't want, then sync.`
        );
      } else {
        status('No tracks found for your selection. Check band spelling.');
      }

    } catch (err) {
      console.error(err);
      status(`Error building setlist: ${err.message}`);
    }

    btn.disabled = false;
  });

// ==========================
// RENDER PREVIEW PANEL
// ==========================

function renderPreview() {
  const panel = document.getElementById('preview-panel');
  const list = document.getElementById('preview-list');

  if (!previewTracks.length) {
    panel.classList.add('hidden');
    list.innerHTML = '';
    return;
  }

  panel.classList.remove('hidden');

  // group by band (case-insensitive so a band's new release joins
  // its section even if Spotify capitalizes the name differently)
  const order = [];
  const byArtist = new Map();

  for (const t of previewTracks) {
    const key = (t.artistName || 'Unknown').toLowerCase();
    if (!byArtist.has(key)) {
      byArtist.set(key, { display: t.artistName || 'Unknown', tracks: [] });
      order.push(key);
    }
    byArtist.get(key).tracks.push(t);
  }

  document.getElementById('preview-summary').textContent =
    `${previewTracks.length} songs · ${order.length} bands`;

  list.innerHTML = '';

  order.forEach((key) => {
    const group = byArtist.get(key);
    const tracks = group.tracks;

    // source tag: did this band's songs come from real setlists
    // or from the Spotify top-tracks fallback?
    const hasSetlist = tracks.some((t) => t.source === 'setlist');
    const hasTop = tracks.some((t) => t.source === 'top');

    let tagHtml = '';
    if (hasSetlist) {
      tagHtml = '<span class="preview-tag tag-setlist">setlist</span>';
      if (hasTop) {
        tagHtml += '<span class="preview-tag tag-top">+ top tracks</span>';
      }
    } else if (hasTop) {
      tagHtml = '<span class="preview-tag tag-top">top tracks</span>';
    }

    // COVERAGE STAT (setlist stats toggle):
    // of all the times this band stepped on stage (totalShows),
    // what share of those song-slots do the tracks we're including
    // account for? i.e. sum of play counts / (totalShows * tracks).
    // Simpler and more honest phrasing: the average show-frequency
    // of the songs we picked — "these N songs each appear in most shows."
    let coverageHtml = '';
    if (showSetlistStats) {
      const setlistTracks = tracks.filter(
        (t) => t.playCount != null && t.totalShows
      );
      if (setlistTracks.length) {
        const totalShows = setlistTracks[0].totalShows;
        const avgFreq =
          setlistTracks.reduce((s, t) => s + t.playCount, 0) /
          (setlistTracks.length * totalShows);
        const pct = Math.round(avgFreq * 100);
        coverageHtml =
          `<span class="preview-coverage">~${pct}% show avg · ${totalShows} shows</span>`;
      }
    }

    const section = document.createElement('div');
    section.className = 'preview-band';

    const header = document.createElement('div');
    header.className = 'preview-band-header';
    header.innerHTML = `
      <span class="preview-band-title">${escapeHtml(group.display)}${tagHtml}</span>
      <span class="preview-head-right">${coverageHtml}<span class="preview-count">${tracks.length}</span></span>
    `;
    section.appendChild(header);

    tracks.forEach((t) => {
      // per-track stats: "38/40 shows" for setlist songs,
      // "new release" for ✦ tracks, nothing for fallback songs
      // — all gated behind the setlist-stats toggle
      let meta = '';
      if (t.isNewRelease) {
        meta = '<span class="preview-plays preview-plays-new">new release</span>';
      } else if (showSetlistStats && t.playCount != null && t.totalShows) {
        meta = `<span class="preview-plays">${t.playCount}/${t.totalShows} shows</span>`;
      }

      const row = document.createElement('div');
      row.className = 'preview-track';

      // verification: a track with a Spotify URL is confirmed real —
      // the ✓ links straight to the track on Spotify so anyone can
      // check it's the right song. Tracks still awaiting a match
      // (no URI yet) show a muted "unmatched" dot instead.
      let verifyHtml = '';
      if (t.spotifyUrl) {
        verifyHtml =
          `<a class="preview-verify" href="${escapeHtml(t.spotifyUrl)}" ` +
          `target="_blank" rel="noopener" title="Verified on Spotify — click to hear it">✓</a>`;
      } else if (t.uri) {
        verifyHtml = `<span class="preview-verify" title="Matched on Spotify">✓</span>`;
      } else {
        verifyHtml = `<span class="preview-unmatched" title="Not yet matched on Spotify">○</span>`;
      }

      row.innerHTML = `
        <span class="preview-track-name">
          ${t.isNewRelease ? '<span class="preview-new">✦</span> ' : ''}${escapeHtml(t.name)}
        </span>
        ${meta}
        ${verifyHtml}
        <button class="preview-remove" title="Remove from playlist">✕</button>
      `;

      row.querySelector('.preview-remove').addEventListener('click', () => {
        previewTracks = previewTracks.filter((x) => x.uri !== t.uri);
        renderPreview();
        status(`${previewTracks.length} songs in your setlist.`);
      });

      section.appendChild(row);
    });

    list.appendChild(section);
  });

  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ==========================
// SHARED SETLIST LINK (receiving side)
//
// Two link formats are supported:
//   #id=<slug>  → fetch the stored setlist from Supabase (short link)
//   #s=<base64> → decode a self-contained setlist (fallback / offline)
// Both end up calling renderSharedPayload() with the compact object.
// ==========================

async function loadSharedById(id) {
  status('Loading shared setlist...');

  const res = await fetch(
    `${WORKER_URL}/supabase/shared_setlists?id=eq.${encodeURIComponent(id)}&select=payload`
  );

  if (!res.ok) throw new Error(`fetch failed (${res.status})`);

  const rows = await res.json();
  if (!rows.length) throw new Error('setlist not found');

  // best-effort view bump — don't block rendering on it
  fetch(
    `${WORKER_URL}/supabase/shared_setlists?id=eq.${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ views: (rows[0].views || 0) + 1 })
    }
  ).catch(() => {});

  renderSharedPayload(rows[0].payload);
}

function renderSharedInline(encoded) {
  const json = decodeURIComponent(escape(atob(encoded)));
  renderSharedPayload(JSON.parse(json));
}

function renderSharedPayload(compact) {
  previewTracks = [];
  (compact.b || []).forEach((band) => {
    (band.s || []).forEach((s) => {
      const [name, plays, isNew, url] = s;
      const track = {
        name,
        artistName: band.a,
        isNewRelease: !!isNew,
        spotifyUrl: url || null,
        uri: null   // shared links carry no URIs; sync stays disabled
      };
      if (plays && /^\d+\/\d+$/.test(plays)) {
        const [c, sh] = plays.split('/').map(Number);
        track.playCount = c;
        track.totalShows = sh;
      }
      previewTracks.push(track);
    });
  });

  if (compact.n) document.getElementById('playlist-name').value = compact.n;
  if (compact.d) document.getElementById('playlist-desc').value = compact.d;

  renderPreview();

  status(
    `Viewing a shared setlist — ${previewTracks.length} songs. ` +
    `Tweak the bands above to make it your own, or export it.`
  );
}

// ==========================
// EXPORT: PDF and SHAREABLE LINK
//
// Peers to Spotify sync — no login, no Spotify needed. They work
// entirely off the previewed setlist, so they function even for
// users who never connect Spotify at all.
// ==========================

function buildSetlistExport() {
  const name =
    document.getElementById('playlist-name').value.trim() || 'My Setlist';
  const desc =
    document.getElementById('playlist-desc').value.trim() || '';

  const order = [];
  const byArtist = new Map();

  for (const t of previewTracks) {
    const key = (t.artistName || 'Unknown').toLowerCase();
    if (!byArtist.has(key)) {
      byArtist.set(key, { artist: t.artistName || 'Unknown', songs: [] });
      order.push(key);
    }
    byArtist.get(key).songs.push({
      name: t.name,
      plays: (t.playCount != null && t.totalShows)
        ? `${t.playCount}/${t.totalShows}`
        : null,
      isNew: !!t.isNewRelease,
      url: t.spotifyUrl || null
    });
  }

  return {
    name,
    desc,
    total: previewTracks.length,
    bands: order.map((k) => byArtist.get(k))
  };
}

document
  .getElementById('export-pdf')
  .addEventListener('click', () => {
    if (!previewTracks.length) {
      status('Build a setlist first.');
      return;
    }

    const data = buildSetlistExport();
    const safeName = (data.name || 'setlist')
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase() || 'setlist';

    // Preferred path: jsPDF → real file, auto-downloads, no dialog.
    const jsPDFCtor = window.jspdf && window.jspdf.jsPDF;

    if (jsPDFCtor) {
      try {
        const doc = new jsPDFCtor({ unit: 'pt', format: 'a4' });
        const pageW = doc.internal.pageSize.getWidth();
        const pageH = doc.internal.pageSize.getHeight();
        const margin = 48;
        const bottom = pageH - 54;
        let y = margin;

        const newPageIfNeeded = (needed) => {
          if (y + needed > bottom) {
            doc.addPage();
            y = margin;
          }
        };

        // Title
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(22);
        doc.setTextColor(20, 20, 20);
        doc.text(data.name, margin, y);
        y += 12;

        // gold rule
        doc.setDrawColor(200, 169, 81);
        doc.setLineWidth(2);
        doc.line(margin, y, pageW - margin, y);
        y += 18;

        // meta line
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(10);
        doc.setTextColor(150, 150, 150);
        if (data.desc) {
          doc.text(data.desc, margin, y);
          y += 14;
        }
        doc.text(
          `${data.total} songs · ${data.bands.length} bands · built with SetFlow`,
          margin, y
        );
        y += 24;

        data.bands.forEach((b) => {
          newPageIfNeeded(40);

          // band header
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(12);
          doc.setTextColor(138, 114, 53);
          doc.text(b.artist.toUpperCase(), margin, y);
          doc.setTextColor(180, 180, 180);
          doc.text(String(b.songs.length), pageW - margin, y, { align: 'right' });
          y += 6;
          doc.setDrawColor(230, 230, 230);
          doc.setLineWidth(0.5);
          doc.line(margin, y, pageW - margin, y);
          y += 14;

          // songs
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(11);
          b.songs.forEach((s) => {
            newPageIfNeeded(16);
            doc.setTextColor(40, 40, 40);
            const label = (s.isNew ? '* ' : '') + s.name;
            doc.text(label, margin + 4, y);
            if (s.plays) {
              doc.setTextColor(160, 160, 160);
              doc.text(`${s.plays} shows`, pageW - margin, y, { align: 'right' });
            }
            y += 16;
          });
          y += 12;
        });

        // footer on every page
        const pages = doc.internal.getNumberOfPages();
        for (let p = 1; p <= pages; p++) {
          doc.setPage(p);
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(8);
          doc.setTextColor(170, 170, 170);
          doc.text(
            'Songs ranked by how often each band plays them live · SetFlow',
            pageW / 2, pageH - 28, { align: 'center' }
          );
        }

        doc.save(`${safeName}.pdf`);
        status('PDF downloaded.');
        return;
      } catch (err) {
        console.warn('jsPDF failed, falling back to print:', err.message);
        // fall through to print method
      }
    }

    // Fallback path: print window (used only if jsPDF didn't load)
    const bandsHtml = data.bands.map((b) => {
      const rows = b.songs.map((s) => `
        <tr>
          <td class="song">${s.isNew ? '✦ ' : ''}${escapeHtml(s.name)}</td>
          <td class="plays">${s.plays ? s.plays + ' shows' : ''}</td>
        </tr>`).join('');
      return `
        <section class="band">
          <h2>${escapeHtml(b.artist)} <span>${b.songs.length}</span></h2>
          <table>${rows}</table>
        </section>`;
    }).join('');

    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${escapeHtml(data.name)}</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; color:#111; padding:40px; }
  .head { border-bottom:3px solid #c8a951; padding-bottom:16px; margin-bottom:24px; }
  .head h1 { font-size:28px; letter-spacing:0.02em; }
  .head p { color:#666; margin-top:6px; font-size:14px; }
  .head .meta { color:#999; margin-top:4px; font-size:12px; }
  .band { margin-bottom:22px; break-inside:avoid; }
  .band h2 { font-size:15px; text-transform:uppercase; letter-spacing:0.08em;
             color:#8a7235; border-bottom:1px solid #eee; padding-bottom:5px; margin-bottom:8px; }
  .band h2 span { float:right; color:#bbb; }
  table { width:100%; border-collapse:collapse; }
  td { padding:4px 0; font-size:13px; vertical-align:top; }
  td.song { color:#222; }
  td.plays { text-align:right; color:#999; font-variant-numeric:tabular-nums; white-space:nowrap; width:90px; }
  .foot { margin-top:30px; padding-top:14px; border-top:1px solid #eee;
          color:#aaa; font-size:11px; text-align:center; }
  @media print { body { padding:20px; } }
</style></head>
<body>
  <div class="head">
    <h1>${escapeHtml(data.name)}</h1>
    ${data.desc ? `<p>${escapeHtml(data.desc)}</p>` : ''}
    <div class="meta">${data.total} songs · ${data.bands.length} bands · built with SetFlow</div>
  </div>
  ${bandsHtml}
  <div class="foot">Songs ranked by how often each band plays them live · setflow</div>
  <script>window.onload = () => { window.print(); };<\/script>
</body></html>`;

    const w = window.open('', '_blank');
    if (!w) {
      status('Popup blocked — allow popups to export PDF.');
      return;
    }
    w.document.write(html);
    w.document.close();
    status('PDF ready — use your browser\u2019s "Save as PDF" in the print dialog.');
  });

document
  .getElementById('export-link')
  .addEventListener('click', async () => {
    if (!previewTracks.length) {
      status('Build a setlist first.');
      return;
    }

    const btn = document.getElementById('export-link');
    btn.disabled = true;
    status('Creating share link...');

    const data = buildSetlistExport();

    const compact = {
      n: data.name,
      d: data.desc,
      b: data.bands.map((b) => ({
        a: b.artist,
        s: b.songs.map((s) => [s.name, s.plays || '', s.isNew ? 1 : 0, s.url || ''])
      }))
    };

    // short random slug — 8 chars from a-z0-9 (~2.8 trillion combos)
    function shortId() {
      const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
      let s = '';
      for (let i = 0; i < 8; i++) {
        s += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      return s;
    }

    let url;
    try {
      const id = shortId();

      const res = await fetch(`${WORKER_URL}/supabase/shared_setlists`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({ id, payload: compact })
      });

      if (!res.ok) throw new Error(`save failed (${res.status})`);

      url = `${window.location.origin}${window.location.pathname}#id=${id}`;
    } catch (err) {
      // Supabase save failed → fall back to the self-contained link
      // so sharing still works even if the table isn't set up yet.
      console.warn('Short link save failed, using inline link:', err.message);
      try {
        const enc = btoa(unescape(encodeURIComponent(JSON.stringify(compact))));
        url = `${window.location.origin}${window.location.pathname}#s=${enc}`;
      } catch {
        status('Could not build share link.');
        btn.disabled = false;
        return;
      }
    }

    try {
      await navigator.clipboard.writeText(url);
      status(
        `Share link copied to clipboard!<br>` +
        `<span style="color:var(--gold);font-size:13px;">${escapeHtml(url)}</span>`
      );
    } catch {
      status(
        `Here\u2019s your share link (copy it):<br>` +
        `<textarea readonly style="width:100%;margin-top:8px;height:44px;">${escapeHtml(url)}</textarea>`
      );
    }

    btn.disabled = false;
  });

// ==========================
// SYNC TO SPOTIFY
//
// If already logged in this session → create immediately.
// Otherwise → snapshot the pending playlist to localStorage,
// redirect to Spotify login, and boot() finishes the job
// when we land back with a ?code param.
// ==========================

document
  .getElementById('sync-btn')
  .addEventListener('click', async () => {

    if (!previewTracks.length) {
      status('Build a setlist first.');
      return;
    }

    // only sync tracks Spotify actually matched
    const syncable = previewTracks.filter((t) => t.uri);

    if (!syncable.length) {
      status(
        'None of these songs are matched on Spotify yet, so there\u2019s ' +
        'nothing to sync. You can still export a PDF or share a link.'
      );
      return;
    }

    const payload = {
      name:
        document.getElementById('playlist-name').value.trim() ||
        'Festival Tape',
      desc:
        document.getElementById('playlist-desc').value.trim() || '',
      uris: syncable.map((t) => t.uri),
      newReleaseCount: syncable.filter((t) => t.isNewRelease).length
    };

    if (accessToken) {
      await createPendingPlaylist(payload);
      return;
    }

    // snapshot survives the OAuth redirect
    localStorage.setItem('pending_playlist', JSON.stringify(payload));

    status('Redirecting to Spotify to sign in...');
    startSpotifyLogin();
  });

async function createPendingPlaylist(p) {
  const syncBtn = document.getElementById('sync-btn');
  syncBtn.disabled = true;

  try {
    status('Creating playlist...');
    const playlist = await createPlaylist(p.name, p.desc);

    status('Adding songs...');
    await addTracks(playlist.id, p.uris);

    status(`
      Playlist created!
      <br><br>
      <a href="https://open.spotify.com/playlist/${playlist.id}" target="_blank">
        Open Playlist
      </a>
      <br><br>
      Songs added: ${p.uris.length}
      ${p.newReleaseCount > 0
        ? `<br>✦ New releases included: ${p.newReleaseCount}`
        : ''}
    `);

  } catch (err) {
    console.error(err);
    status(`Error syncing playlist: ${err.message}`);
  }

  syncBtn.disabled = false;
}

// Called by boot() in script-part1.js after the OAuth redirect
// lands back with a fresh access token.
async function resumePendingPlaylist() {
  const pending = localStorage.getItem('pending_playlist');

  if (!pending) {
    status('Connected. Ready to build your setlist.');
    return;
  }

  let payload;
  try {
    payload = JSON.parse(pending);
  } catch {
    localStorage.removeItem('pending_playlist');
    status('Connected. Ready to build your setlist.');
    return;
  }

  localStorage.removeItem('pending_playlist');
  status('Welcome back — syncing your setlist...');
  await createPendingPlaylist(payload);
}

// ==========================
// CACHE WARMER (run from browser console)
//
// Pre-populates the Supabase URI cache for EVERY band in
// MASTER_BANDS, slowly — one band at a time with a pause
// between them. No login required. Run overnight:
//
//   warmCache()          // default 2s pause between bands
//   warmCache(5000)      // gentler: 5s pause
//
// Cached bands are skipped almost instantly (fast path),
// so re-running it is cheap and safe.
// ==========================

// --- PHASE 1 (works with NO Spotify app at all) ---
// Fetches setlist.fm songs + mbid for every band and saves them
// to Supabase, preserving any existing URIs/spotify_id. Run this
// from the console TODAY while Spotify is unavailable:
//
//   warmSetlistsOnly()
//
// Tomorrow, warmCache() (or normal app usage) will find these
// cached setlists and only need Spotify for the URI matching.
async function warmSetlistsOnly(delayMs = 1000) {
  console.log(`📋 Warming setlist data for ${MASTER_BANDS.length} bands (no Spotify needed)...`);
  let done = 0;
  let skipped = 0;

  for (const band of MASTER_BANDS) {
    done++;

    try {
      const cached = await dbGetBand(band);

      // already has real setlist data → nothing to do
      if (
        cached &&
        cached.mbid &&
        cached.source === 'setlist' &&
        Array.isArray(cached.songs) &&
        cached.songs.length > 0
      ) {
        skipped++;
        status(`Setlist warm: ${done}/${MASTER_BANDS.length} — ${band} (cached)`);
        continue;
      }

      status(`Setlist warm: ${done}/${MASTER_BANDS.length} — ${band}`);
      const { mbid, songs } = await getSetlistSongs(band);

      if (!mbid && !songs.length) {
        console.warn(`warmSetlistsOnly: nothing found for "${band}"`);
        continue;
      }

      // preserve existing uris/spotify_id so we don't wipe old cache rows
      await dbSaveBand(
        band,
        mbid || cached?.mbid || null,
        songs.length ? songs : (cached?.songs || []),
        cached?.spotify_id || null,
        songs.length ? 'setlist' : (cached?.source || 'setlist'),
        cached?.uris || null
      );

    } catch (err) {
      console.warn(`warmSetlistsOnly: "${band}" failed — ${err.message}`);
    }

    await wait(delayMs);
  }

  console.log(`📋 Setlist warm complete. ${skipped} already cached.`);
  status(`Setlist warm complete — ${done} bands processed, ${skipped} already cached.`);
}

// --- PHASE 2 (needs the Spotify app — run tomorrow) ---
async function warmCache(delayMs = 2000) {
  console.log(`🔥 Warming cache for ${MASTER_BANDS.length} bands...`);
  let done = 0;

  // the cache is always the ALL-TIME picture — force year mode off
  // for the duration of the warm, then restore whatever the UI had
  const prevTourOnly = tourYearOnly;
  tourYearOnly = false;

  try {
    for (const band of MASTER_BANDS) {
      try {
        await resolveTracksForBand(band, 20);
      } catch (err) {
        console.warn(`warmCache: "${band}" failed — ${err.message}`);
      }
      done++;
      status(`Warming cache: ${done}/${MASTER_BANDS.length} — ${band}`);
      await wait(delayMs);
    }
  } finally {
    tourYearOnly = prevTourOnly;
  }

  console.log('🔥 Cache warm complete.');
  status(`Cache warm complete — ${done} bands cached.`);
}

// ==========================
// BOOT
// boot() lives in script-part1.js but is called here, at the
// very end of the last script, so every function it depends on
// (resumePendingPlaylist, renderGrid) is guaranteed to exist.
// ==========================

boot();
