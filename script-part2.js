// WORKER_URL is loaded from config.js
// e.g. 'https://setflow.yairyeger.workers.dev'
//
// The Worker holds the real setlist.fm API key
// server-side, so it never appears in this file
// or in the browser.

function setlistUrl(path) {
  return `${WORKER_URL}/setlist${path}`;
}

// Rate limiter + 429 retry for setlist.fm
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let lastSetlistCall = 0;

async function setlistFetch(url, opts) {
  const gap = Date.now() - lastSetlistCall;
  if (gap < 1200) await wait(1200 - gap);
  lastSetlistCall = Date.now();

  let res = await fetch(url, opts);

  if (res.status === 429) {
    console.warn('Setlist.fm 429 — waiting 6s and retrying...');
    await wait(6000);
    // push lastSetlistCall forward so the next band
    // also waits a full gap after this retry
    lastSetlistCall = Date.now();
    res = await fetch(url, opts);

    // if still 429 after retry, return the response
    // so the caller logs it and falls back to Spotify
    if (res.status === 429) {
      console.warn('Setlist.fm still 429 after retry — skipping to Spotify fallback');
    }
  }

  return res;
}

// ==========================
// LIVE VERSION FILTER
//
// Returns true if a track name looks
// like a live recording, acoustic,
// unplugged, or concert version.
// Used to exclude these everywhere.
// ==========================

function isLiveTrack(name) {
  if (!name) return false;

  const lower = name.toLowerCase();

  const livePatterns = [
    /\blive\b/,         // "live", "live at", "live from"
    /\(live/,           // "(Live", "(Live At"
    /- live/,           // "- Live"
    /\bconcert\b/,      // "concert version"
    /\bunplugged\b/,    // "unplugged"
    /\bacoustic\b/,     // "acoustic version"
    /\brecorded at\b/,  // "recorded at"
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
      .classList.toggle(
        'new-releases-active',
        includeNewReleases
      );

    console.log(
      `New releases: ${includeNewReleases ? 'ON' : 'OFF'}`
    );
  });

// ==========================
// SELECT ALL
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

// ==========================
// CLEAR ALL
// ==========================

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
  if (artistCache[artistName]) {
    return artistCache[artistName];
  }

  async function trySearch(query) {
    const params = new URLSearchParams({
      q: query,
      type: 'artist',
      limit: '3'
    });

    const res = await fetch(
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

    const setlistRes = await setlistFetch(
      setlistUrl(`/artist/${artist.mbid}/setlists?p=1`),
      { headers: { 'Accept': 'application/json' } }
    );

    if (!setlistRes.ok) {
      console.warn(`Setlist.fm setlists HTTP ${setlistRes.status} for "${artistName}"`);
      return [];
    }

    const setlistData = await setlistRes.json();
    const setlists = setlistData.setlist || [];

    if (!setlists.length) {
      console.warn(`Setlist.fm: 0 setlists for "${artistName}"`);
      return [];
    }

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
      .sort((a, b) => b[1] - a[1])
      .map(([key]) => originalName[key]);

    console.log(
      `Setlist.fm "${artistName}": ${sorted.length} songs from ${setlists.length} shows. Top 5: ${sorted.slice(0, 5).join(', ')}`
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
// Skips live versions.
// ==========================

async function findTrack(artistName, songName) {
  const artistId = await getArtistId(artistName);

  async function searchTrack(q) {
    const params = new URLSearchParams({
      q,
      type: 'track',
      limit: '5'
    });

    const res = await fetch(
      `${SPOTIFY_API}/search?${params}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (!res.ok) return null;

    const data = await res.json();
    const items = data.tracks?.items || [];

    for (const t of items) {
      // skip live versions
      if (isLiveTrack(t.name)) continue;
      if (isLiveTrack(t.album?.name)) continue;

      const isCorrectArtist = artistId
        ? t.artists?.some((a) => a.id === artistId)
        : t.artists?.some(
            (a) => a.name.toLowerCase() === artistName.toLowerCase()
          );

      if (!isCorrectArtist) continue;

      return {
        uri: t.uri,
        name: t.name,
        artistName: t.artists?.[0]?.name || artistName
      };
    }

    return null;
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
// SPOTIFY FALLBACK —
// MOST STREAMED TRACKS
// Verifies by artist ID.
// Skips live versions.
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

    const res = await fetch(
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

      // skip live versions
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

    const res = await fetch(
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
// NEW RELEASES —
// LATEST TRACK FOR A BAND
//
// Fetches the artist's most recently
// released single or album track.
// Returns one track object or null.
// Skips live versions automatically.
// ==========================

async function getNewRelease(artistName) {
  const artistId = await getArtistId(artistName);
  if (!artistId) return null;

  // fetch more candidates so we can find a truly recent one
  const res = await fetch(
    `${SPOTIFY_API}/artists/${artistId}/albums?include_groups=album,single&limit=10&offset=0`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!res.ok) {
    console.warn(`New releases HTTP ${res.status} for "${artistName}"`);
    return null;
  }

  const data = await res.json();

  // filter out live albums, then sort by release_date descending
  // so we always get the genuinely newest release
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 1); // 12 months ago

  const recentAlbums = (data.items || [])
    .filter((a) => {
      if (isLiveTrack(a.name)) return false;
      const releaseDate = new Date(a.release_date);
      return releaseDate >= cutoff;
    })
    .sort((a, b) =>
      new Date(b.release_date) - new Date(a.release_date)
    );

  if (!recentAlbums.length) {
    console.warn(
      `New releases: no releases in last 12 months for "${artistName}"`
    );
    return null;
  }

  const latest = recentAlbums[0];

  // get tracks from that release
  const tracksRes = await fetch(
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

  const setlistSongs = await getSetlistSongs(artistName);
  const tracks = [];
  const seenNames = new Set();

  if (setlistSongs.length > 0) {
    status(`Matching ${artistName} setlist songs on Spotify...`);

    for (const songName of setlistSongs) {
      if (tracks.length >= amount) break;

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

    console.log(`${artistName}: ${tracks.length}/${amount} from setlist.fm`);
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

    console.log(
      `${artistName}: final ${tracks.length}/${amount} tracks`
    );
  }

  if (!tracks.length) {
    console.warn(`${artistName}: found nothing. Check spelling.`);
  }

  // hard cap — never return more than requested
  // regardless of what setlist or Spotify gave us
  return tracks.slice(0, amount);
}

// ==========================
// CREATE PLAYLIST
// ==========================

async function createPlaylist(name, description) {
  const res = await fetch(
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
    await fetch(
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

      amount = Math.max(1, Math.min(amount, 10));
      selected.push({ artist: cb.value, amount });
    });

    if (!selected.length) {
      status('Select at least one band.');
      return;
    }

    // sort the selected bands before generating
    const sortOrder =
      document.getElementById('sort-order').value;

    if (sortOrder === 'name-asc') {
      selected.sort((a, b) =>
        a.artist.localeCompare(b.artist)
      );
    } else if (sortOrder === 'name-desc') {
      selected.sort((a, b) =>
        b.artist.localeCompare(a.artist)
      );
    } else if (sortOrder === 'songs-asc') {
      selected.sort((a, b) => a.amount - b.amount);
    } else if (sortOrder === 'songs-desc') {
      selected.sort((a, b) => b.amount - a.amount);
    }
    // 'as-selected' keeps the grid order

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

      // --- NEW RELEASES ---
      // fetched separately AFTER all bands are done
      // so they never inflate per-band song counts.
      // Each band gets at most 1 new release appended.
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
              (newRelease.artistName || '').toLowerCase() +
              '|' + cleanName;

            if (!seenTitles.has(titleKey)) {
              seenUris.add(newRelease.uri);
              seenTitles.add(titleKey);
              finalTracks.push(newRelease);

              console.log(
                `+ New release: "${newRelease.name}" by ${band.artist}`
              );
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

      const newReleaseCount = finalTracks.filter(
        (t) => t.isNewRelease
      ).length;

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
