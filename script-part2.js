// WORKER_URL loaded from config.js
// SUPABASE_URL, SUPABASE_KEY, SETLIST_KEY live in Cloudflare Worker env vars

// ==========================
// URL HELPERS
// ==========================

function setlistUrl(path) {
  return `${WORKER_URL}/setlist${path}`;
}

// Routes all Spotify API calls through the Cloudflare Worker
// instead of directly from the browser — avoids browser-side
// rate limiting which is much stricter than server-side.
function spotifyUrl(path) {
  return `${WORKER_URL}/spotify${path}`;
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
        `Cache SAVED ✅ "${name}" (${(songs || []).length} songs, uris: ${uris ? uris.length : 0})`
      );
    }

  } catch (err) {
    console.warn(`Supabase SAVE exception: ${err.message}`);
  }
}

// ==========================
// RATE LIMITERS
// ==========================

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Setlist.fm ---
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

// Spotify calls now go through the Cloudflare Worker
// (spotifyUrl helper above) — no browser-side rate limiter needed.
// The Worker handles server-to-server calls which have
// a much higher rate limit than direct browser calls.
async function spotifyFetch(url, opts) {
  return fetch(url, opts);
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
// in-memory cache only —
// Supabase pre-population happens
// in resolveTracksForBand
// ==========================

async function getArtistId(artistName) {
  if (artistCache[artistName]) {
    return artistCache[artistName];
  }

  async function trySearch(query) {
    const params = new URLSearchParams({
      q: query,
      type: 'artist',
      limit: '3'
    });

    const res = await spotifyFetch(
      spotifyUrl(`/search?${params}`),
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (!res.ok) return null;

    const data = await res.json();
    const items = data.artists?.items || [];
    if (!items.length) return null;

    return items.find(
      (a) => a.name.toLowerCase() === artistName.toLowerCase()
    ) || items[0];
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

async function getSetlistSongs(artistName) {
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

      const data = await setlistRes.json();
      const shows = data.setlist || [];
      if (!shows.length) break;
      setlists.push(...shows);
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
      .sort((a, b) =>
        b.consistency !== a.consistency
          ? b.consistency - a.consistency
          : b.count - a.count
      )
      .map((e) => originalName[e.key]);

    console.log(
      `Setlist.fm "${artistName}": ${sorted.length} songs from ${totalShows} shows. Top 5: ${sorted.slice(0, 5).join(', ')}`
    );

    return sorted;

  } catch (err) {
    console.warn(`Setlist.fm exception for "${artistName}": ${err.message}`);
    return [];
  }
}

// ==========================
// SPOTIFY — FIND TRACK
// Verifies by artist ID.
// Prefers original over duets/remixes.
// Sorts candidates by popularity.
// ==========================

async function findTrack(artistName, songName) {
  const artistId = await getArtistId(artistName);

  function isAltVersion(name) {
    const lower = (name || '').toLowerCase();
    return (
      /\bfeat\.?\b/.test(lower) ||
      /\bft\.?\b/.test(lower) ||
      /\bremix\b/.test(lower) ||
      /\bedit\b/.test(lower) ||
      /\bsped up\b/.test(lower) ||
      /\bslowed\b/.test(lower)
    );
  }

  async function searchTrack(q) {
    const params = new URLSearchParams({
      q,
      type: 'track',
      limit: '10'
    });

    const res = await spotifyFetch(
      spotifyUrl(`/search?${params}`),
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (res.status === 429) {
      console.warn('Spotify still 429 — skipping track search');
      return null;
    }

    if (!res.ok) return null;

    const data = await res.json();
    const items = data.tracks?.items || [];

    const candidates = items.filter((t) => {
      if (isLiveTrack(t.name)) return false;
      if (isLiveTrack(t.album?.name)) return false;

      return artistId
        ? t.artists?.some((a) => a.id === artistId)
        : t.artists?.some(
            (a) => a.name.toLowerCase() === artistName.toLowerCase()
          );
    });

    if (!candidates.length) return null;

    const originals = candidates.filter((t) => !isAltVersion(t.name));
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
}

// ==========================
// SPOTIFY FALLBACK
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
      spotifyUrl(`/search?${params}`),
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (!res.ok || res.status === 429) break;

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
        artistName: track.artists?.[0]?.name || artistName
      });

      if (collected.length >= needed) break;
    }
  }

  // loose fallback
  if (collected.length < needed) {
    const params = new URLSearchParams({
      q: artistName,
      type: 'track',
      limit: '10'
    });

    const res = await spotifyFetch(
      spotifyUrl(`/search?${params}`),
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (res.ok && res.status !== 429) {
      const data = await res.json();
      const items = data.tracks?.items || [];

      for (const track of items) {
        if (!track.uri || seenUris.has(track.uri)) continue;
        if (isLiveTrack(track.name)) continue;

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
    spotifyUrl(`/artists/${artistId}/albums?include_groups=album,single&limit=10`),
    { headers: { Authorization: `Bearer ${accessToken}` } }
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
    spotifyUrl(`/albums/${latest.id}/tracks?limit=5`),
    { headers: { Authorization: `Bearer ${accessToken}` } }
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

  // fetch DB row once — reused throughout this function
  const cached = await dbGetBand(artistName);

  // FAST PATH: cached URIs → zero Spotify calls
  if (cached && cached.uris && cached.uris.length > 0) {
    console.log(
      `URI cache HIT ✅ "${artistName}": returning top ${amount} of ${cached.uris.length}`
    );
    return cached.uris.slice(0, amount);
  }

  // pre-populate artist ID from DB so getArtistId
  // skips the Spotify lookup for this band
  if (cached && cached.spotify_id) {
    artistCache[artistName] = cached.spotify_id;
    console.log(`Artist ID pre-loaded from cache: ${cached.spotify_id}`);
  }

  // resolve songs from setlist.fm (uses its own cache)
  const setlistSongs = await getSetlistSongs(artistName);
  const tracks = [];
  const seenNames = new Set();

  if (setlistSongs.length > 0) {
    status(`Matching ${artistName} songs on Spotify...`);

    for (const songName of setlistSongs) {
      // fetch more than requested so cache covers future larger requests
      if (tracks.length >= Math.max(amount, 20)) break;

      const key = songName.toLowerCase().trim();
      if (seenNames.has(key)) continue;
      seenNames.add(key);

      const track = await findTrack(artistName, songName);
      if (track) {
        tracks.push(track);
      } else {
        console.warn(`No match: "${songName}" by "${artistName}"`);
      }
    }

    console.log(`${artistName}: ${tracks.length} tracks from setlist.fm`);
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
    console.warn(`${artistName}: found nothing. Check spelling.`);
    return [];
  }

  // save URIs to cache — always, whether band was in DB or not
  const spotifyIdToSave =
    cached?.spotify_id || artistCache[artistName] || null;
  const songsToSave = cached?.songs || tracks.map((t) => t.name);

  await dbSaveBand(
    artistName,
    cached?.mbid || null,
    songsToSave,
    spotifyIdToSave,
    cached?.source || 'setlist',
    tracks
  );

  console.log(
    `${artistName}: ${tracks.length} tracks resolved + URIs saved to cache`
  );

  return tracks.slice(0, amount);
}

// ==========================
// CREATE PLAYLIST
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
// ADD TRACKS
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
        ${newReleaseCount > 0
          ? `<br>✦ New releases included: ${newReleaseCount}`
          : ''}
      `);

    } catch (err) {
      console.error(err);
      status(`Error: ${err.message}`);
    }

    btn.disabled = false;
  });
