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

// Fetch every saved band's name + genre from Supabase, so custom bands
// added in past sessions reappear in the grid instead of needing re-entry.
// Lightweight: only pulls name + genre columns, not full song data.
async function dbGetAllBands() {
  try {
    const res = await fetch(
      `${WORKER_URL}/supabase/bands?select=name,genre`
    );
    if (!res.ok) {
      console.warn(`Supabase GET all bands failed: ${res.status}`);
      return [];
    }
    const rows = await res.json();
    return rows || [];
  } catch (err) {
    console.warn(`Supabase GET all bands exception: ${err.message}`);
    return [];
  }
}

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

async function dbSaveBand(name, mbid, songs, spotifyId, source, uris, genre) {
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

    // only include genre if provided — keeps existing rows untouched
    // when a save doesn't specify one
    if (genre) payload.genre = genre;

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

// Lightweight upsert of just a band's name + genre. Used when you add a
// custom band before it's ever built — records the category so it
// reappears next session. Uses merge-duplicates so it won't clobber the
// songs/uris of a band that already has data.
async function dbSaveBandGenre(name, genre) {
  try {
    const key = name.toLowerCase().trim();
    const res = await fetch(
      `${WORKER_URL}/supabase/bands`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates'
        },
        body: JSON.stringify({
          name: key,
          genre: genre || 'Added by me',
          updated_at: new Date().toISOString()
        })
      }
    );
    if (res.ok) {
      console.log(`Band category saved: "${name}" → ${genre}`);
    } else {
      console.warn(`Save band genre failed: ${res.status}`);
    }
  } catch (err) {
    console.warn(`Save band genre exception: ${err.message}`);
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

  // setlist.fm rate-limits more readily than Spotify but recovers fast.
  // Retry up to twice, honoring the Retry-After header when present,
  // with a growing fallback wait. Most 429s clear on the first retry.
  let attempt = 0;
  while (res.status === 429 && attempt < 2) {
    attempt++;
    const retryAfter = parseInt(res.headers.get('Retry-After') || '0');
    // header value (seconds) if given, else escalating fallback: 6s, 12s
    const waitMs = retryAfter > 0
      ? Math.min(retryAfter * 1000, 30000)
      : attempt * 6000;

    console.warn(
      `Setlist.fm 429 — waiting ${Math.round(waitMs / 1000)}s and retrying (attempt ${attempt}/2)...`
    );
    await wait(waitMs);
    lastSetlistCall = Date.now();
    res = await fetch(url, opts);
  }

  if (res.status === 429) {
    console.warn('Setlist.fm still rate-limited after retries — this band may need a moment.');
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

// Hard rate-limit cooldown: trips when Spotify returns a large
// Retry-After (a real penalty, not a blip). While active, Spotify
// calls short-circuit so we never freeze the app or dig the hole
// deeper. Cached setlists/URIs keep working the whole time.
let spotifyRateLimited = false;
let spotifyCooldownUntil = 0;

function spotifyOnCooldown() {
  if (!spotifyRateLimited) return false;
  if (Date.now() >= spotifyCooldownUntil) {
    // penalty window elapsed — clear it and allow calls again
    spotifyRateLimited = false;
    spotifyCooldownUntil = 0;
    console.log('✅ Spotify cooldown elapsed — resuming normal calls.');
    return false;
  }
  return true;
}

async function spotifyFetch(url, opts = {}, maxAttempts = 3) {
  // hard cooldown active → don't even try; let callers fall back to cache
  if (spotifyOnCooldown()) {
    const mins = Math.ceil((spotifyCooldownUntil - Date.now()) / 60000);
    throw new Error(`Spotify on cooldown (~${mins} min left)`);
  }

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

        // A large Retry-After means we've hit a HARD rate limit, not a
        // momentary blip. Waiting it out (could be hours) would freeze
        // the app. Instead: trip a session cooldown so all further
        // Spotify calls short-circuit, and bail out of this request.
        // Setlist data still loads from cache; only URI matching pauses.
        if (retryAfter > 120) {
          spotifyRateLimited = true;
          spotifyCooldownUntil = Date.now() + retryAfter * 1000;
          console.warn(
            `⛔ Spotify HARD rate limit — Retry-After ${retryAfter}s (` +
            `${Math.round(retryAfter / 60)} min). Pausing ALL Spotify calls ` +
            `for this session. Cached setlists still work; try URI matching ` +
            `again later. Do NOT keep rebuilding — it extends the penalty.`
          );
          return res;
        }

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
let recentInOrder = false;     // single most-recent show, in played order
let selectedYear = null;       // chosen in the picker
let setlistOnly = true;        // DEFAULT SAFE: setlist-only, zero Spotify calls
let warmingInProgress = false; // true only during a deliberate warmCache run
let spotifyModeOn = false;     // master Spotify toggle — inverse of setlistOnly

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

// --- MASTER SPOTIFY TOGGLE (off by default, never remembered) ---
// Off  → setlistOnly = true  → builds run on setlist.fm + cache, ZERO Spotify.
// On   → setlistOnly = false → builds match songs to Spotify (rate-limitable).
// Always starts OFF on every load so you can never accidentally hit Spotify.
const spotifyToggle = document.getElementById('spotify-toggle');
const spotifyBar = document.getElementById('spotify-bar');
const spotifyBarState = document.getElementById('spotify-bar-state');

function applySpotifyMode() {
  setlistOnly = !spotifyModeOn;
  if (spotifyToggle) spotifyToggle.classList.toggle('toggle-on', spotifyModeOn);
  if (spotifyBar) spotifyBar.classList.toggle('on', spotifyModeOn);
  if (spotifyBarState) spotifyBarState.textContent = spotifyModeOn ? 'on' : 'off';

  const desc = spotifyBar?.querySelector('.spotify-bar-desc');
  if (desc) {
    desc.textContent = spotifyModeOn
      ? 'On — songs will be matched to Spotify so you can sync a playlist. Uses your Spotify quota.'
      : 'Off — building runs on live setlists only, never rate-limited. Turn on to match & sync songs to Spotify.';
  }

  applySetlistOnlyUI();
  // reflect resolve/sync availability in any open preview
  if (previewTracks.length) renderPreview();
  console.log(`Spotify mode: ${spotifyModeOn ? 'ON' : 'OFF'} (setlistOnly=${setlistOnly})`);
}

if (spotifyToggle) {
  spotifyToggle.addEventListener('click', () => {
    spotifyModeOn = !spotifyModeOn;
    applySpotifyMode();
  });
}

// reflect the mode in the build button + Spotify sync/resolve availability
function applySetlistOnlyUI() {
  const buildBtn = document.getElementById('build-btn');
  const syncBtn = document.getElementById('sync-btn');
  if (buildBtn) {
    buildBtn.textContent = setlistOnly ? 'SHOW SETLISTS' : 'BUILD SETLIST';
  }
  if (syncBtn) {
    // Sync needs at least one Spotify-matched (URI) track AND Spotify mode on.
    const hasResolved = previewTracks.some((t) => t.uri);
    const canSync = spotifyModeOn && hasResolved;
    syncBtn.disabled = !canSync;
    syncBtn.title = !spotifyModeOn
      ? 'Turn on Spotify mode to sync'
      : (hasResolved ? 'Create this playlist in your Spotify' : 'Resolve songs to Spotify first');
    syncBtn.style.opacity = canSync ? '' : '0.4';
    syncBtn.style.cursor = canSync ? '' : 'not-allowed';
  }
}

// --- Setlist source picker (all-time / year / most-recent-in-order) ---
// setlistSource drives the build. tourYearOnly + recentInOrder are derived
// from it so the resolver logic downstream stays simple.
let setlistSource = 'alltime';
const yearPicker = document.getElementById('tour-year');

function applySetlistSource(value) {
  setlistSource = value;
  tourYearOnly = (value === 'year');
  recentInOrder = (value === 'recent');
  if (yearPicker) yearPicker.classList.toggle('hidden', value !== 'year');
  console.log(`Setlist source → ${value}`);
}

document.querySelectorAll('input[name="setlist-source"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    if (radio.checked) applySetlistSource(radio.value);
  });
});

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
    updateSelectedCount();
    if (!document.getElementById('selected-panel').classList.contains('hidden')) {
      renderSelectedPanel();
    }
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
    updateSelectedCount();
    if (!document.getElementById('selected-panel').classList.contains('hidden')) {
      renderSelectedPanel();
    }
  });

// ==========================
// SELECTED BANDS PANEL
//
// A live view of the bands you've picked, with each one's tier and
// a quick way to drop it. Needs no Spotify — pure DOM state — so it
// works even while Spotify is rate-limited. The badge on the button
// always reflects the current count.
// ==========================

function getSelectedCards() {
  return Array.from(document.querySelectorAll('.band-card')).filter(
    (card) => card.querySelector('.band-checkbox')?.checked
  );
}

function updateSelectedCount() {
  const badge = document.getElementById('selected-count');
  if (!badge) return;
  const n = getSelectedCards().length;
  badge.textContent = String(n);
  badge.classList.toggle('empty', n === 0);
}

function renderSelectedPanel() {
  const list = document.getElementById('selected-list');
  if (!list) return;

  const cards = getSelectedCards();
  list.innerHTML = '';

  if (!cards.length) {
    list.innerHTML =
      '<div class="selected-empty">No bands picked yet. ' +
      'Check some bands in the grid below.</div>';
    return;
  }

  cards.forEach((card) => {
    const name = card.querySelector('.band-checkbox').value;
    const select = card.querySelector('.tier-select');
    const custom = card.querySelector('.custom-input');
    const tierLabel = select.value === 'custom'
      ? `${custom.value || '5'} songs`
      : (select.options[select.selectedIndex]?.textContent || '').trim();

    const item = document.createElement('div');
    item.className = 'selected-item';
    item.innerHTML = `
      <span class="selected-item-name">${escapeHtml(name)}</span>
      <span class="selected-item-tier">${escapeHtml(tierLabel)}</span>
      <button class="selected-item-remove" title="Remove">✕</button>
    `;

    item.querySelector('.selected-item-remove').addEventListener('click', () => {
      const cb = card.querySelector('.band-checkbox');
      cb.checked = false;
      card.classList.remove('selected');
      updateSelectedCount();
      renderSelectedPanel();
    });

    list.appendChild(item);
  });
}

document
  .getElementById('show-selected')
  .addEventListener('click', () => {
    const panel = document.getElementById('selected-panel');
    const willShow = panel.classList.contains('hidden');
    panel.classList.toggle('hidden', !willShow);
    if (willShow) renderSelectedPanel();
  });

document
  .getElementById('selected-close')
  .addEventListener('click', () => {
    document.getElementById('selected-panel').classList.add('hidden');
  });

// keep the badge current whenever any checkbox changes (grid uses
// event delegation on the container so custom-added bands work too)
document.getElementById('band-grid').addEventListener('change', (e) => {
  if (e.target.classList.contains('band-checkbox')) {
    updateSelectedCount();
    if (!document.getElementById('selected-panel').classList.contains('hidden')) {
      renderSelectedPanel();
    }
  }
});

// ==========================
// ADD CUSTOM BAND
// ==========================

// populate the genre picker from the existing genre categories,
// plus an "Added by me" catch-all option
(function populateNewBandGenre() {
  const sel = document.getElementById('new-band-genre');
  if (!sel) return;
  Object.keys(GENRE_BANDS).forEach((genre) => {
    const opt = document.createElement('option');
    opt.value = genre;
    opt.textContent = genre;
    sel.appendChild(opt);
  });
  const custom = document.createElement('option');
  custom.value = 'Added by me';
  custom.textContent = 'Added by me';
  sel.appendChild(custom);
})();

// auto toggle: when on, hide/disable the genre picker (everything → "Added by me")
document
  .getElementById('new-band-auto')
  .addEventListener('change', (e) => {
    const sel = document.getElementById('new-band-genre');
    if (sel) sel.style.display = e.target.checked ? 'none' : '';
  });

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

    // decide the category: auto-toggle → "Added by me", else the picker
    const auto = document.getElementById('new-band-auto')?.checked;
    const genreSel = document.getElementById('new-band-genre');
    const genre = auto
      ? 'Added by me'
      : (genreSel ? genreSel.value : 'Added by me');

    // add to the in-memory grid immediately
    MASTER_BANDS.push(band);
    if (typeof BAND_GENRES !== 'undefined') BAND_GENRES[band] = genre;
    input.value = '';
    renderGrid();

    // remember this band's category in Supabase so it reappears next
    // session. We save a lightweight row now (name + genre); the full
    // setlist/songs get filled in when the band is first built.
    if (typeof dbSaveBandGenre === 'function') {
      dbSaveBandGenre(band, genre);
    }
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
async function getSetlistSongs(artistName, filterYear = null, mostRecentInOrder = false) {
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

    // a show only counts if it actually lists songs
    const songBearing = setlists.filter((show) =>
      (show.sets?.set || []).some((set) => (set.song || []).length)
    );

    // ---- MOST RECENT SHOW, IN ORDER ----
    // Take the single latest song-bearing show and return its songs in the
    // exact order played (opener → encore). No frequency ranking here — the
    // whole point is the real flow of one recent concert.
    if (mostRecentInOrder) {
      if (!songBearing.length) {
        console.warn(`Setlist.fm: no song-bearing show for "${artistName}"`);
        return { mbid: artistMbid, songs: [], years };
      }

      // setlist.fm returns newest-first, but sort by date to be safe
      const withDates = songBearing
        .map((s) => ({ show: s, y: eventYear(s) || 0 }))
        .sort((a, b) => b.y - a.y);

      const latest = withDates[0].show;
      const orderedSongs = [];
      const seen = new Set();

      for (const set of (latest.sets?.set || [])) {
        for (const song of (set.song || [])) {
          if (!song.name || song.cover) continue;
          const key = song.name.toLowerCase().trim();
          if (seen.has(key)) continue;
          seen.add(key);
          orderedSongs.push({ name: song.name.trim(), count: null, shows: null });
        }
      }

      const showDate = latest.eventDate || '';
      const venue = latest.venue?.name || '';
      console.log(
        `Setlist.fm "${artistName}": most-recent show ${showDate}` +
        (venue ? ` @ ${venue}` : '') + ` — ${orderedSongs.length} songs in order.`
      );

      return {
        mbid: artistMbid,
        songs: orderedSongs,
        years,
        showDate,
        venue,
        inOrder: true
      };
    }

    // apply the year filter if one was requested (and that year exists)
    const scoped = filterYear
      ? songBearing.filter((s) => eventYear(s) === filterYear)
      : songBearing;

    // a show only counts toward totals if it actually lists songs
    const showsWithSongs = scoped;

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

  // Tour-year mode scopes to a single year; recent-in-order takes one
  // show. Both are different from the all-time cache (URIs + songs), so
  // we bypass the cache for a fresh fetch and DON'T write these back.
  const yearScoped = tourYearOnly && selectedYear;
  const orderMode = recentInOrder;
  const bypassCache = yearScoped || orderMode;

  // fetch DB row once — reused throughout this function
  const cached = await dbGetBand(artistName);

  // FAST PATH: cached URIs exist AND cover this request → zero Spotify calls.
  // (skipped in year-scoped / order mode — cache is all-time aggregated)
  // (skipped in setlist-only mode — we want song data, not URIs)
  // Since live builds now cache only what was asked, a later LARGER request
  // may find fewer URIs than it needs — in that case we fall through and
  // resolve more, then re-save the bigger set.
  if (
    !bypassCache && !setlistOnly &&
    cached && cached.uris && cached.uris.length >= amount
  ) {
    console.log(
      `URI cache HIT ✅ "${artistName}": returning top ${amount} of ${cached.uris.length}`
    );
    return cached.uris.slice(0, amount);
  }

  // Partial cache: we have some URIs but not enough for this bigger request.
  // Seed from them so we don't re-search songs we already resolved.
  const cachedUris = (!bypassCache && !setlistOnly && cached && Array.isArray(cached.uris))
    ? cached.uris
    : [];
  if (cachedUris.length > 0 && cachedUris.length < amount) {
    console.log(
      `URI cache PARTIAL "${artistName}": have ${cachedUris.length}, need ${amount} — topping up`
    );
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
  let freshSetlistFetch = false;  // true only when we hit setlist.fm this call

  if (
    !bypassCache &&
    cached &&
    cached.mbid &&
    cached.source === 'setlist' &&
    Array.isArray(cached.songs) &&
    cached.songs.length > 0
  ) {
    setlistSongs = normalizeSongEntries(cached.songs);
    const withStats = setlistSongs.filter((s) => s.count != null).length;
    if (withStats === 0 && setlistSongs.length > 0) {
      console.log(
        `Setlist songs loaded from cache ✅ "${artistName}" (${setlistSongs.length} songs) ` +
        `— ⚠️ no play-count stats (old cache format). Run warmSetlistsOnly() to refresh stats.`
      );
    } else {
      console.log(
        `Setlist songs loaded from cache ✅ "${artistName}" (${setlistSongs.length} songs, ${withStats} with stats, no setlist.fm call)`
      );
    }
  } else {
    const result = await getSetlistSongs(
      artistName,
      yearScoped ? selectedYear : null,
      orderMode
    );
    setlistMbid = result.mbid || setlistMbid;
    setlistSongs = result.songs;
    freshSetlistFetch = true;   // we just hit setlist.fm — worth caching

    // keep the year picker in sync with real data the first time
    // we see this band's actual show years
    if (result.years && result.years.length) {
      syncYearPicker(result.years);
    }
  }

  const tracks = [];
  const seenNames = new Set();

  // Seed from partial cache (non-setlist-only): reuse URIs we already
  // resolved so a larger request only searches the NEW songs.
  if (!setlistOnly && cachedUris.length > 0 && cachedUris.length < amount) {
    for (const t of cachedUris) {
      tracks.push(t);
      if (t.name) seenNames.add(t.name.toLowerCase().trim());
    }
  }

  // SETLIST-ONLY MODE: build the result straight from setlist data,
  // making ZERO Spotify calls. No URIs, no ✓ links, no sync — just
  // the honest "what this band plays live" answer. This is what makes
  // SetFlow useful without ever touching Spotify.
  if (setlistOnly) {
    for (const songEntry of setlistSongs) {
      if (tracks.length >= amount) break;
      const key = songEntry.name.toLowerCase().trim();
      if (seenNames.has(key)) continue;
      seenNames.add(key);

      tracks.push({
        name: songEntry.name,
        artistName: artistName,
        uri: null,                 // no Spotify match in this mode
        source: 'setlist',
        playCount: songEntry.count != null ? songEntry.count : null,
        totalShows: songEntry.shows != null ? songEntry.shows : null
      });
    }
    console.log(`${artistName}: ${tracks.length} setlist-only songs (no Spotify).`);

    // Persist the setlist data we just fetched (mbid + songs, no URIs),
    // so a band built in setlist-only mode still gets cached and doesn't
    // hit setlist.fm again next time. Same rules as elsewhere: don't cache
    // year/order snapshots over good all-time data, but DO fill an empty
    // row for a brand-new band.
    const hasGoodCacheSO =
      cached &&
      Array.isArray(cached.songs) &&
      cached.songs.length > 0 &&
      cached.source === 'setlist' &&
      cached.songs.some((s) => s && typeof s === 'object' && s.count != null);

    const shouldWriteSO =
      freshSetlistFetch &&
      (!bypassCache || !hasGoodCacheSO) &&
      setlistSongs.length > 0;

    if (shouldWriteSO) {
      await dbSaveBand(
        artistName,
        setlistMbid || cached?.mbid || null,
        setlistSongs,
        cached?.spotify_id || artistCache[artistName] || null,
        'setlist',
        cached?.uris || null   // preserve any URIs already cached; don't clear them
      );
      console.log(`${artistName}: setlist data cached (setlist-only mode, URIs pending).`);
    }

    return tracks.slice(0, amount);
  }

  if (setlistSongs.length > 0) {
    status(`Matching ${artistName} songs on Spotify...`);

    // How many to resolve: live builds fetch exactly what's asked (cheap).
    // Only a deliberate warm run over-fetches to pre-fill the cache for
    // future larger requests — and that runs slowly, one band at a time.
    const resolveTarget = warmingInProgress
      ? Math.max(amount, 20)
      : amount;

    for (const songEntry of setlistSongs) {
      if (tracks.length >= resolveTarget) break;

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

  // top up from Spotify if short.
  // Fix 1: skip the fallback when setlist matching already got us close
  // enough (within 1 song of the target). Those extra searches to pad
  // the very last slot rarely help and cost 3-6 calls. If setlist gave
  // us most of what was asked, that's a better playlist than padding it
  // with top-tracks anyway.
  const closeEnough = tracks.length >= amount - 1 && tracks.length > 0;

  if (tracks.length < amount && !closeEnough) {
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
    // wasted. URIs stay empty; a future run fills them in.
    // Normally year/order snapshots don't write, but a brand-new band
    // with no cache yet should still capture its songs + mbid.
    const hasGoodCacheNoTracks =
      cached &&
      Array.isArray(cached.songs) &&
      cached.songs.length > 0 &&
      cached.source === 'setlist';

    const shouldWriteNoTracks =
      (!bypassCache || !hasGoodCacheNoTracks) &&
      (setlistSongs.length > 0 || setlistMbid);

    if (shouldWriteNoTracks) {
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
    } else if (!bypassCache) {
      console.warn(`${artistName}: found nothing. Check spelling.`);
    }
    return [];
  }

  // save to cache — freshly-found mbid takes priority over stale/null cache
  //
  // Normal (all-time) builds cache everything. Year/order builds are
  // snapshots, so they normally DON'T write — BUT if the band has no
  // cached data yet (a brand-new band you just added), we still save
  // what we found so the row isn't left empty. We never let a snapshot
  // OVERWRITE existing good all-time data.
  const hasGoodCache =
    cached &&
    Array.isArray(cached.songs) &&
    cached.songs.length > 0 &&
    cached.source === 'setlist';

  const shouldWrite = !bypassCache || !hasGoodCache;

  if (shouldWrite) {
    const spotifyIdToSave =
      cached?.spotify_id || artistCache[artistName] || null;

    const songsToSave = setlistSongs.length > 0
      ? setlistSongs
      : (cached?.songs || tracks.map((t) => t.name));

    const source = setlistSongs.length > 0 ? 'setlist' : 'spotify';

    // year/order snapshots: keep the mbid + songs but don't attach URIs
    // to the all-time row (they're scoped, not the general picture)
    const urisToSave = bypassCache ? (cached?.uris || null) : tracks;

    await dbSaveBand(
      artistName,
      setlistMbid || cached?.mbid || null,
      songsToSave,
      spotifyIdToSave,
      source,
      urisToSave
    );

    console.log(
      bypassCache
        ? `${artistName}: new band — snapshot data saved (mbid + songs; URIs pending an all-time build)`
        : `${artistName}: ${tracks.length} tracks resolved + URIs saved to cache`
    );
  } else {
    console.log(`${artistName}: ${tracks.length} year/order tracks (existing all-time cache kept)`);
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
          // In setlist-only mode tracks have no URI — dedup by title only.
          // Otherwise dedup by URI first, then title.
          if (t.uri) {
            if (seenUris.has(t.uri)) continue;
          }

          const cleanName = (t.name || '')
            .toLowerCase()
            .replace(/\s*[-\u2013([].*$/, '')
            .trim();

          const titleKey =
            (t.artistName || '').toLowerCase() + '|' + cleanName;

          if (seenTitles.has(titleKey)) continue;

          if (t.uri) seenUris.add(t.uri);
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
// APPEND TRACKS (shared dedup helper)
// Merges new band tracks into previewTracks without duplicates.
// ==========================

function appendTracksToPreview(bandTracks) {
  const seenUris = new Set(previewTracks.filter(t => t.uri).map(t => t.uri));
  const seenTitles = new Set(previewTracks.map(t => {
    const cleanName = (t.name || '').toLowerCase()
      .replace(/\s*[-\u2013([].*$/, '').trim();
    return (t.artistName || '').toLowerCase() + '|' + cleanName;
  }));

  let added = 0;
  for (const t of bandTracks) {
    if (t.uri && seenUris.has(t.uri)) continue;
    const cleanName = (t.name || '').toLowerCase()
      .replace(/\s*[-\u2013([].*$/, '').trim();
    const titleKey = (t.artistName || '').toLowerCase() + '|' + cleanName;
    if (seenTitles.has(titleKey)) continue;
    if (t.uri) seenUris.add(t.uri);
    seenTitles.add(titleKey);
    previewTracks.push(t);
    added++;
  }
  return added;
}

// ==========================
// RESOLVE TO SPOTIFY (prune-then-resolve)
//
// In setlist-only mode you browse + prune with ZERO Spotify calls.
// This button takes ONLY the songs currently in the preview (after
// you've removed the ones you don't want) and resolves those exact
// songs to Spotify — so it calls Spotify once per KEPT song, never
// for songs you already ditched.
// ==========================

document
  .getElementById('resolve-btn')
  .addEventListener('click', async () => {
    // hard guard: Spotify mode must be on
    if (!spotifyModeOn) {
      status('Turn on Spotify mode (above the build button) to resolve songs.');
      return;
    }

    // songs still needing a Spotify match (no uri yet)
    const toResolve = previewTracks.filter((t) => !t.uri && !t.isNewRelease);

    if (!toResolve.length) {
      status('These songs are already on Spotify — hit Spotify to sync.');
      return;
    }

    if (spotifyAppUnavailable || spotifyOnCooldown()) {
      status('Spotify is unavailable right now. Try again shortly.');
      return;
    }

    const btn = document.getElementById('resolve-btn');
    btn.disabled = true;

    let resolved = 0;
    let failed = 0;

    try {
      for (let i = 0; i < toResolve.length; i++) {
        const t = toResolve[i];
        status(`Resolving ${i + 1}/${toResolve.length}: ${t.name}...`);

        const match = await findTrack(t.artistName, t.name);

        if (match && match.uri) {
          // upgrade the existing track in place — keep its stats
          t.uri = match.uri;
          t.spotifyUrl = match.spotifyUrl || null;
          t.album = match.album || null;
          t.verified = true;
          resolved++;
        } else {
          failed++;
          console.warn(`Resolve: no match for "${t.name}" by ${t.artistName}`);
        }

        renderPreview();  // live update ✓ marks as they resolve
      }

      const matchedNow = previewTracks.filter((t) => t.uri).length;
      status(
        `Resolved ${resolved} song${resolved === 1 ? '' : 's'} to Spotify` +
        (failed ? ` (${failed} not found)` : '') +
        `. ${matchedNow} ready to sync — hit Spotify.`
      );
    } catch (err) {
      console.error(err);
      status(`Stopped resolving: ${err.message}. Already-resolved songs are kept.`);
    }

    btn.disabled = false;
    applySetlistOnlyUI();
  });

// ==========================
// ADD A BAND to the existing setlist (no full rebuild)
// ==========================

// populate the preview tier dropdown from the current mode's tiers
function populatePreviewTierSelect() {
  const sel = document.getElementById('preview-new-tier');
  if (!sel) return;
  sel.innerHTML = '';
  TIER_CONFIGS[currentMode].forEach((tier) => {
    if (tier.songs === 'custom') return;  // skip custom in this quick-add
    const opt = document.createElement('option');
    opt.value = String(tier.songs);
    opt.textContent = tier.name;
    sel.appendChild(opt);
  });
  // default to a small tier
  sel.value = '7';
}
populatePreviewTierSelect();

document
  .getElementById('preview-add-btn')
  .addEventListener('click', async () => {
    const input = document.getElementById('preview-new-band');
    const artist = input.value.trim();
    if (!artist) return;

    const amount = Math.max(1, Math.min(
      parseInt(document.getElementById('preview-new-tier').value) || 7, 20
    ));

    const btn = document.getElementById('preview-add-btn');
    btn.disabled = true;
    status(`Adding ${artist} to your setlist...`);

    try {
      const bandTracks = await resolveTracksForBand(artist, amount);

      if (!bandTracks.length) {
        status(`Couldn't find setlist data for "${artist}". Check spelling.`);
        btn.disabled = false;
        return;
      }

      const added = appendTracksToPreview(bandTracks);
      input.value = '';
      renderPreview();

      status(
        added
          ? `Added ${added} song${added === 1 ? '' : 's'} from ${artist}.` +
            (setlistOnly ? ' Hit "Resolve to Spotify" when ready.' : '')
          : `${artist}'s songs were already in your setlist.`
      );
    } catch (err) {
      console.error(err);
      status(`Couldn't add ${artist}: ${err.message}`);
    }

    btn.disabled = false;
  });

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

  // Resolve bar: show whenever there are songs still needing a Spotify
  // match. Framed so PDF/Link read as complete exports on their own and
  // Spotify is the optional extra — not the default destination.
  const resolveBar = document.getElementById('resolve-bar');
  const resolveBtn = document.getElementById('resolve-btn');
  const resolveNote = resolveBar ? resolveBar.querySelector('.resolve-note') : null;
  if (resolveBar && resolveBtn) {
    const unresolved = previewTracks.filter((t) => !t.uri && !t.isNewRelease).length;
    resolveBar.classList.toggle('hidden', unresolved === 0);

    if (unresolved > 0) {
      if (spotifyModeOn) {
        resolveBtn.textContent = `♫ Resolve ${unresolved} to Spotify`;
        resolveBtn.disabled = false;
        resolveBtn.style.opacity = '';
        resolveBtn.style.cursor = '';
        if (resolveNote) {
          resolveNote.textContent = 'Export as PDF or Link with no Spotify needed — or';
        }
      } else {
        // Spotify mode off → resolve greyed out with a hint
        resolveBtn.textContent = `♫ Resolve ${unresolved} to Spotify`;
        resolveBtn.disabled = true;
        resolveBtn.style.opacity = '0.4';
        resolveBtn.style.cursor = 'not-allowed';
        if (resolveNote) {
          resolveNote.textContent = 'Turn on Spotify mode above to resolve these songs — or just';
        }
      }
    }
  }

  // keep the sync button enabled/disabled in step with resolved tracks
  applySetlistOnlyUI();

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
        // remove THIS track by object identity — works whether or not it
        // has a URI (setlist-only tracks all share uri:null, so filtering
        // by uri would wrongly remove every track).
        previewTracks = previewTracks.filter((x) => x !== t);
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

      // Does this band already have GOOD data — songs WITH play counts?
      // Old cache rows stored songs as plain strings (or objects with
      // count:null), which show no "38/40 shows" stats. Those need a
      // re-warm even though they technically "have songs". So we only
      // skip when the songs carry real play-count data.
      const hasStatsData =
        cached &&
        cached.mbid &&
        cached.source === 'setlist' &&
        Array.isArray(cached.songs) &&
        cached.songs.length > 0 &&
        cached.songs.some(
          (s) => s && typeof s === 'object' && s.count != null
        );

      if (hasStatsData) {
        skipped++;
        status(`Setlist warm: ${done}/${MASTER_BANDS.length} — ${band} (has stats)`);
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
  // for the duration of the warm, then restore whatever the UI had.
  // warmingInProgress lets the resolver over-fetch (20 songs) to pre-fill
  // the cache — something we only want during a deliberate, paced warm.
  const prevTourOnly = tourYearOnly;
  const prevSetlistOnly = setlistOnly;
  tourYearOnly = false;
  setlistOnly = false;         // warming needs real URIs, not setlist-only
  warmingInProgress = true;

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
    setlistOnly = prevSetlistOnly;
    warmingInProgress = false;
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

updateSelectedCount();
applySpotifyMode();  // start in safe setlist-only state, UI reflects OFF
boot();
