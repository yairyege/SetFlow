// CONFIG is loaded from config.js
// Do NOT hardcode secrets here — see config.js

// ==========================
// STATE
// ==========================

let accessToken = null;
let currentMode = 'festival';

const artistCache = {};
const topTracksCache = {};

// ==========================
// DEFAULT BANDS — grouped by genre
//
// GENRE_BANDS is the source of truth. MASTER_BANDS is built FROM
// it (genre-major order, alphabetical within each genre) instead
// of one global alphabetical sort, so bands land near their
// stylistic neighbors in the grid. BAND_GENRES is the reverse
// lookup used to tag each card with data-genre for the genre
// filter dropdown in script-part2.js, which populates its options
// straight from these same keys.
// ==========================

const GENRE_BANDS = {
  'Thrash Metal': [
    'Metallica',
    'Megadeth',
    'Anthrax',
    'Slayer',
    'Trivium',
  ],

  'Heavy Metal': [
    'Iron Maiden',
    'Judas Priest',
    'Black Sabbath',
    'Motörhead',
    'Ozzy Osbourne',
    'Dio',
    'Saxon',
    'Accept',
    'Helloween',
    'Manowar',
    'Dokken',
    'Queensrÿche',
    'Rainbow',
    'W.A.S.P.',
    'Twisted Sister',
  ],

  'Groove Metal': [
    'Pantera',
    'Lamb of God',
    'Five Finger Death Punch',
  ],

  'Nu Metal': [
    'Slipknot',
    'System Of A Down',
    'Korn',
    'Linkin Park',
    'Limp Bizkit',
    'Deftones',
    'Disturbed',
    'Papa Roach',
    'Static-X',
    'Mudvayne',
    'P.O.D.',
    'Drowning Pool',
    'Nonpoint',
    'Hollywood Undead',
    'Coal Chamber',
    'Spite',
  ],

  'Metalcore': [
    'Avenged Sevenfold',
    'Bring Me The Horizon',
    'Parkway Drive',
    'Architects',
    'While She Sleeps',
    'Bullet For My Valentine',
    'As I Lay Dying',
    'August Burns Red',
    'All That Remains',
    'Killswitch Engage',
    'Bad Omens',
    'Spiritbox',
    'Motionless In White',
    'Ice Nine Kills',
    'Falling in Reverse',
    'I Prevail',
    'Beartooth',
    'Asking Alexandria',
    'Of Mice & Men',
    'Crown The Empire',
    'Wage War',
    'Code Orange',
    'Northlane',
    'Underoath',
    'Silverstein',
    'A Day To Remember',
    'Memphis May Fire',
    'We Came As Romans',
    'The Devil Wears Prada',
    'Miss May I',
    'Fit For A King',
    'Escape The Fate',
    'Attila',
    'Emmure',
    'Norma Jean',
    'Every Time I Die',
    'Comeback Kid',
    'Turnstile',
  ],

  'Deathcore': [
    'Whitechapel',
    'Chelsea Grin',
    'Thy Art Is Murder',
    'Shadow Of Intent',
    'Brand Of Sacrifice',
    'Aborted',
    'Knocked Loose',
    'Lorna Shore',
    'Slaughter To Prevail',
    'Suicide Silence',
    'Carnifex',
    'Signs Of The Swarm',
    'Bodysnatcher',
    'Angelmaker',
    'Ingested',
    'Kublai Khan',
    'Enterprise Earth',
    'Within Destruction',
  ],

  'Progressive Metal': [
    'Tool',
    'Mastodon',
    'Gojira',
    'Meshuggah',
    'Periphery',
    'Polyphia',
    'Animals As Leaders',
    'Intervals',
    'Veil Of Maya',
    'Sleep Token',
    'Erra',
    'Currents',
    'Dream Theater',
    'Opeth',
    'Between The Buried And Me',
    'TesseracT',
    'Karnivool',
    'Leprous',
    'Rivers Of Nihil',
    'Monuments',
    'Volumes',
    'The Contortionist',
  ],

  'Death Metal': [
    'Death',
    'Cannibal Corpse',
    'Obituary',
    'Morbid Angel',
    'Deicide',
    'Nile',
    'Suffocation',
    'Dying Fetus',
    'Behemoth',
    'Carcass',
    'Vader',
    'Immolation',
    'At The Gates',
    'Amon Amarth',
  ],

  'Black Metal': [
    'Mayhem',
    'Emperor',
    'Dimmu Borgir',
    'Immortal',
    'Darkthrone',
    'Watain',
  ],

  'Alternative Metal': [
    'Rage Against The Machine',
    'Alice In Chains',
    'Soundgarden',
    'Stone Temple Pilots',
    'Chevelle',
    'Godsmack',
    'Breaking Benjamin',
    'Shinedown',
    'Three Days Grace',
    'Seether',
    'Staind',
    'Sevendust',
    'Bad Wolves',
    'Grandson',
    'Nothing Nowhere',
    'Dead Poet Society',
    'Palaye Royale',
    'Starset',
  ],

  'Symphonic / Gothic Metal': [
    'Nightwish',
    'Within Temptation',
    'Evanescence',
    'Ghost',
    'In This Moment',
    'Halestorm',
  ],

  'Rock Icons': [
    'Guns N\' Roses',
    'AC/DC',
    'Aerosmith',
    'Van Halen',
    'Kiss',
    'Rammstein',
    'Alice Cooper',
    'Foo Fighters',
  ],

  'Hard Rock': [
    'Def Leppard',
    'Whitesnake',
    'Foreigner',
    'Bon Jovi',
    'Scorpions',
    'Thin Lizzy',
    'Poison',
    'Mötley Crüe',
    'Ratt',
    'Cinderella',
    'Skid Row',
    'Extreme',
    'Ted Nugent',
  ],
};

let MASTER_BANDS = Object.values(GENRE_BANDS)
  .flatMap((bands) => [...bands].sort())
  .filter((v, i, a) => a.indexOf(v) === i);

const BAND_GENRES = {};
Object.entries(GENRE_BANDS).forEach(([genre, bands]) => {
  bands.forEach((band) => { BAND_GENRES[band] = genre; });
});

function getBandGenre(band) {
  return BAND_GENRES[band] || 'Other';
}

// Case-insensitive lookup of an existing band's canonical name, so a
// saved "gojira" doesn't duplicate a hardcoded "Gojira".
function findExistingBand(name) {
  const lower = name.toLowerCase();
  return MASTER_BANDS.find((b) => b.toLowerCase() === lower) || null;
}

// Merge bands saved in Supabase (custom ones added in past sessions)
// into MASTER_BANDS + BAND_GENRES so they show up in the grid on load.
// dbGetAllBands lives in script-part2.js. Safe if it returns nothing.
async function mergeSavedBands() {
  if (typeof dbGetAllBands !== 'function') return;

  let saved = [];
  try {
    saved = await dbGetAllBands();
  } catch {
    return;
  }
  if (!saved.length) return;

  let added = 0;
  saved.forEach((row) => {
    if (!row || !row.name) return;

    // skip if we already have this band (case-insensitive)
    if (findExistingBand(row.name)) return;

    // Supabase stores names lowercase; title-case for display
    const display = row.name.replace(/\b\w/g, (c) => c.toUpperCase());
    const genre = row.genre || 'Added by me';

    MASTER_BANDS.push(display);
    BAND_GENRES[display] = genre;
    added++;
  });

  if (added > 0) {
    console.log(`Merged ${added} saved band(s) from Supabase into the grid.`);
    renderGrid();
  }
}

// ==========================
// TIERS
// ==========================

const TIER_CONFIGS = {
  festival: [
    { name: 'Discovery (3 Songs)', songs: 3 },
    { name: 'Small Band (7 Songs)', songs: 7 },
    { name: 'Big Band (8 Songs)', songs: 8 },
    { name: 'Co-Headliner (13 Songs)', songs: 13 },
    { name: 'Headliner (15 Songs)', songs: 15 },
    { name: 'Full Setlist (up to 20 Songs)', songs: 20 },
    { name: 'Custom Override...', songs: 'custom' }
  ],

  tour: [
    { name: 'Support #4 (5 Songs)', songs: 5 },
    { name: 'Support #3 (6 Songs)', songs: 6 },
    { name: 'Support #2 (7 Songs)', songs: 7 },
    { name: 'Support #1 (8 Songs)', songs: 8 },
    { name: 'Special Guest (11 Songs)', songs: 11 },
    { name: 'Headliner (15 Songs)', songs: 15 },
    { name: 'Full Setlist (up to 20 Songs)', songs: 20 },
    { name: 'Custom Override...', songs: 'custom' }
  ]
};

// ==========================
// HELPERS
// ==========================

function status(msg) {
  document.getElementById('status').innerHTML = msg;
}

function randomString(length) {
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

// ==========================
// SPOTIFY LOGIN (PKCE)
//
// No longer triggered on page load. This function is called
// by the "Sync to Spotify" flow in script-part2.js, AFTER the
// user has already built and previewed their setlist.
// The pending playlist is snapshotted to localStorage before
// the redirect, and restored in boot() when Spotify sends
// the user back with a ?code param.
// ==========================

async function startSpotifyLogin() {
  const verifier = randomString(64);
  const challenge = await sha256(verifier);

  localStorage.setItem('code_verifier', verifier);

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge_method: 'S256',
    code_challenge: challenge
  });

  window.location = `${SPOTIFY_AUTH}/authorize?${params}`;
}

// ==========================
// TOKEN EXCHANGE
// ==========================

async function exchangeToken(code) {
  const verifier = localStorage.getItem('code_verifier');

  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: 'authorization_code',
    code: code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier
  });

  const res = await fetch(`${SPOTIFY_AUTH}/api/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body
  });

  const data = await res.json();
  accessToken = data.access_token;
}

// ==========================
// PROFILE + CONNECTED BAR
// ==========================

function setConnectedUI(connected, label) {
  const dot = document.getElementById('connected-dot');
  const msg = document.getElementById('welcome-msg');

  if (connected) {
    dot.classList.remove('off');
    msg.textContent = label || 'Connected';
  } else {
    dot.classList.add('off');
    msg.textContent = label || 'Not connected — you\u2019ll sign in when syncing';
  }
}

async function loadProfile() {
  const res = await fetch(`${SPOTIFY_API}/me`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  const user = await res.json();
  setConnectedUI(true, `\u2714 Connected as ${user.display_name || user.id}`);
}

// ==========================
// BOOT
//
// The app view is visible from the start — no login wall.
// If we're returning from the Spotify OAuth redirect (?code=...),
// exchange the token and, if a pending playlist snapshot exists
// in localStorage, finish creating it automatically.
//
// NOTE: boot() is CALLED from the bottom of script-part2.js,
// because it needs functions defined there (resumePendingPlaylist).
// ==========================

async function boot() {
  renderGrid();
  setConnectedUI(false);

  // fold in custom bands saved in past sessions (non-blocking — the
  // grid already rendered above; these merge in when the fetch returns)
  mergeSavedBands();

  // shared setlist link → render it read-only and stop.
  //   #id=<slug>  short link, fetched from Supabase
  //   #s=<base64> self-contained fallback
  // Handlers live in script-part2.js.
  const hash = window.location.hash;
  if (hash.startsWith('#id=')) {
    try {
      await loadSharedById(hash.slice(4));
      return;
    } catch (err) {
      console.warn('Bad shared link:', err.message);
      status('That shared setlist couldn\u2019t be found. Build your own below.');
    }
  } else if (hash.startsWith('#s=')) {
    try {
      renderSharedInline(hash.slice(3));
      return;
    } catch (err) {
      console.warn('Bad shared link:', err.message);
      status('That shared link couldn\u2019t be read. Build your own setlist below.');
    }
  }

  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');

  if (!code) {
    status('Ready to build your setlist.');
    return;
  }

  status('Connecting to Spotify...');

  await exchangeToken(code);

  // clean the ?code=... out of the URL
  window.history.replaceState({}, document.title, window.location.pathname);

  if (!accessToken) {
    status('Spotify sign-in failed. Please try syncing again.');
    return;
  }

  await loadProfile();

  // defined in script-part2.js — creates the playlist that was
  // snapshotted to localStorage before the OAuth redirect
  await resumePendingPlaylist();
}

// ==========================
// RENDER BAND GRID
//
// IMPORTANT: this function rebuilds the entire grid
// from scratch every time it's called (mode switch,
// adding a custom band, etc). To prevent wiping out
// the user's picks, we snapshot every card's state
// BEFORE clearing the grid, then restore it after
// rebuilding — matched by band name.
// ==========================

function renderGrid() {
  const grid = document.getElementById('band-grid');

  // --- 1. SAVE current state before wiping ---
  const savedState = {};

  grid.querySelectorAll('.band-card').forEach((card) => {
    const checkbox = card.querySelector('.band-checkbox');
    const select = card.querySelector('.tier-select');
    const custom = card.querySelector('.custom-input');

    if (checkbox) {
      savedState[checkbox.value] = {
        checked: checkbox.checked,
        tierValue: select ? select.value : null,
        customValue: custom ? custom.value : null
      };
    }
  });

  // --- 2. WIPE and rebuild ---
  grid.innerHTML = '';

  MASTER_BANDS.forEach((band) => {
    const card = document.createElement('div');
    card.className = 'band-card';
    card.dataset.band = band.toLowerCase();
    card.dataset.genre = getBandGenre(band);

    let options = '';

    TIER_CONFIGS[currentMode].forEach((tier) => {
      options += `
        <option value="${tier.songs}">
          ${tier.name}
        </option>
      `;
    });

    card.innerHTML = `
      <div class="card-top">
        <input
          type="checkbox"
          class="band-checkbox"
          value="${band}"
        >
        <span class="card-band-name">${band}</span>
      </div>
      <select class="tier-select">
        ${options}
      </select>
      <input
        class="custom-input hidden"
        type="number"
        placeholder="Number of songs"
        value="5"
        min="1"
        max="40"
      >
    `;

    grid.appendChild(card);

    const checkbox = card.querySelector('.band-checkbox');
    const select = card.querySelector('.tier-select');
    const custom = card.querySelector('.custom-input');

    // --- 3. RESTORE saved state if this band had one ---
    const prev = savedState[band];

    if (prev) {
      checkbox.checked = prev.checked;
      card.classList.toggle('selected', prev.checked);

      // only restore tier value if that option still
      // exists in the current mode's tier list
      const optionExists = Array.from(select.options).some(
        (opt) => opt.value === prev.tierValue
      );

      if (optionExists) {
        select.value = prev.tierValue;
      }

      if (prev.customValue !== null) {
        custom.value = prev.customValue;
      }

      custom.classList.toggle('hidden', select.value !== 'custom');
    }

    checkbox.addEventListener('change', () => {
      card.classList.toggle('selected', checkbox.checked);
    });

    select.addEventListener('change', () => {
      custom.classList.toggle('hidden', select.value !== 'custom');
    });
  });

  // a rebuild resets DOM order — re-apply the user's active sort and
  // any search/genre filter so they aren't silently cleared
  if (typeof applyBandSort === 'function') applyBandSort();
  if (typeof applyGridFilters === 'function') applyGridFilters();
}

// ==========================
// MODES
// ==========================

document.getElementById('festival-btn').addEventListener('click', () => {
  if (currentMode === 'festival') return;

  currentMode = 'festival';

  document.getElementById('festival-btn').classList.add('active');
  document.getElementById('tour-btn').classList.remove('active');
  document.getElementById('playlist-name').value = 'Festival Lineup Tape';

  renderGrid();
});

document.getElementById('tour-btn').addEventListener('click', () => {
  if (currentMode === 'tour') return;

  currentMode = 'tour';

  document.getElementById('tour-btn').classList.add('active');
  document.getElementById('festival-btn').classList.remove('active');
  document.getElementById('playlist-name').value = 'Tour Route Mix';

  renderGrid();
});

// ==========================
// SEARCH + GENRE FILTER
//
// Both the text search and the genre dropdown (populated in
// script-part2.js from GENRE_BANDS) narrow the same grid, so a
// card only shows when it satisfies both at once.
// ==========================

function applyGridFilters() {
  const q = document.getElementById('catalog-search').value.trim().toLowerCase();
  const genreEl = document.getElementById('genre-filter');
  const genre = genreEl ? genreEl.value : 'all';

  document.querySelectorAll('.band-card').forEach((card) => {
    const matchesSearch = card.dataset.band.includes(q);
    const matchesGenre = genre === 'all' || card.dataset.genre === genre;
    card.classList.toggle('hidden', !(matchesSearch && matchesGenre));
  });
}

document.getElementById('catalog-search').addEventListener('input', applyGridFilters);

// ==========================
// BAND SORT
//
// Reorders the existing card elements in place rather than rebuilding
// the grid — so every checkbox/tier selection is preserved. "By Genre"
// restores the original MASTER_BANDS order (genre-grouped); A→Z / Z→A
// sort purely by band name and flatten the groups.
// ==========================

function applyBandSort() {
  const grid = document.getElementById('band-grid');
  const sortEl = document.getElementById('band-sort');
  const mode = sortEl ? sortEl.value : 'genre';

  const cards = Array.from(grid.querySelectorAll('.band-card'));

  cards.sort((a, b) => {
    const nameA = a.querySelector('.band-checkbox').value;
    const nameB = b.querySelector('.band-checkbox').value;

    if (mode === 'az') return nameA.localeCompare(nameB);
    if (mode === 'za') return nameB.localeCompare(nameA);

    // 'genre' → original MASTER_BANDS order (genre-grouped)
    return MASTER_BANDS.indexOf(nameA) - MASTER_BANDS.indexOf(nameB);
  });

  // re-append in new order (moving existing nodes keeps their state)
  cards.forEach((card) => grid.appendChild(card));
}

const bandSortEl = document.getElementById('band-sort');
if (bandSortEl) {
  bandSortEl.addEventListener('change', applyBandSort);
}
