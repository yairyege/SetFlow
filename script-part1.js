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
// DEFAULT BANDS
// ==========================

let MASTER_BANDS = [
  // Big 4 / Legacy
  'Metallica',
  'Slipknot',
  'System Of A Down',
  'Korn',
  'Avenged Sevenfold',
  'Iron Maiden',
  'Judas Priest',
  'Pantera',
  'Rage Against The Machine',
  'Tool',
  'Deftones',
  'Linkin Park',
  'Limp Bizkit',
  'Disturbed',
  'Five Finger Death Punch',

  // Modern Metal / Metalcore
  'Bring Me The Horizon',
  'Parkway Drive',
  'Architects',
  'Trivium',
  'Lamb of God',
  'Mastodon',
  'Gojira',
  'Meshuggah',
  'Periphery',
  'While She Sleeps',
  'Bullet For My Valentine',
  'As I Lay Dying',
  'August Burns Red',
  'All That Remains',
  'Killswitch Engage',

  // New Wave / Scene
  'Sleep Token',
  'Bad Omens',
  'Spiritbox',
  'Knocked Loose',
  'Lorna Shore',
  'Motionless In White',
  'Ice Nine Kills',
  'Slaughter To Prevail',
  'Falling in Reverse',
  'I Prevail',
  'Papa Roach',
  'Beartooth',
  'Asking Alexandria',
  'Of Mice & Men',
  'Crown The Empire',
  'Wage War',
  'Code Orange',
  'Spite',

  // Post-Hardcore / Prog
  'Architects',
  'Northlane',
  'Polyphia',
  'Animals As Leaders',
  'Intervals',
  'Veil Of Maya',

  // Deathcore / Blackened
  'Whitechapel',
  'Chelsea Grin',
  'Thy Art Is Murder',
  'Shadow Of Intent',
  'Brand Of Sacrifice',
  'Aborted',

  // Rock crossover
  'Turnstile',
  'Grandson',
  'Nothing Nowhere',
  'Dead Poet Society',
  'Bad Wolves',
  'Starset',
  'Palaye Royale',

].filter((v, i, a) => a.indexOf(v) === i).sort();

// ==========================
// TIERS
// ==========================

const TIER_CONFIGS = {
  festival: [
    { name: 'Full Setlist (up to 20 Songs)', songs: 20 },
    { name: 'Headliner (15 Songs)', songs: 15 },
    { name: 'Co-Headliner (13 Songs)', songs: 13 },
    { name: 'Big Band (8 Songs)', songs: 8 },
    { name: 'Small Band (7 Songs)', songs: 7 },
    { name: 'Discovery (3 Songs)', songs: 3 },
    { name: 'Custom Override...', songs: 'custom' }
  ],

  tour: [
    { name: 'Full Setlist (up to 20 Songs)', songs: 20 },
    { name: 'Headliner (15 Songs)', songs: 15 },
    { name: 'Special Guest (11 Songs)', songs: 11 },
    { name: 'Support #1 (8 Songs)', songs: 8 },
    { name: 'Support #2 (7 Songs)', songs: 7 },
    { name: 'Support #3 (6 Songs)', songs: 6 },
    { name: 'Support #4 (5 Songs)', songs: 5 },
    { name: 'Custom Override...', songs: 'custom' }
  ]
};

// ==========================
// HELPERS
// ==========================

function status(msg) {
  document.getElementById('status')
    .innerHTML = msg;
}

function randomString(length) {
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

  let result = '';

  for (let i = 0; i < length; i++) {
    result += chars.charAt(
      Math.floor(
        Math.random() *
        chars.length
      )
    );
  }

  return result;
}

async function sha256(text) {
  const data =
    new TextEncoder().encode(text);

  const digest =
    await crypto.subtle.digest(
      'SHA-256',
      data
    );

  return btoa(
    String.fromCharCode(
      ...new Uint8Array(digest)
    )
  )
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

// ==========================
// SPOTIFY LOGIN
// ==========================

document
  .getElementById('login-btn')
  .addEventListener(
    'click',
    async () => {

      const verifier =
        randomString(64);

      const challenge =
        await sha256(verifier);

      localStorage.setItem(
        'code_verifier',
        verifier
      );

      const params =
        new URLSearchParams({
          client_id:
            CLIENT_ID,
          response_type:
            'code',
          redirect_uri:
            REDIRECT_URI,
          scope:
            SCOPES,
          code_challenge_method:
            'S256',
          code_challenge:
            challenge
        });

      window.location =
        `${SPOTIFY_AUTH}/authorize?${params}`;
    }
  );

// ==========================
// TOKEN EXCHANGE
// ==========================

async function exchangeToken(
  code
) {
  const verifier =
    localStorage.getItem(
      'code_verifier'
    );

  const body =
    new URLSearchParams({
      client_id:
        CLIENT_ID,
      grant_type:
        'authorization_code',
      code:
        code,
      redirect_uri:
        REDIRECT_URI,
      code_verifier:
        verifier
    });

  const res =
    await fetch(
      `${SPOTIFY_AUTH}/api/token`,
      {
        method: 'POST',
        headers: {
          'Content-Type':
            'application/x-www-form-urlencoded'
        },
        body
      }
    );

  const data =
    await res.json();

  accessToken =
    data.access_token;
}

// ==========================
// PROFILE
// ==========================

async function loadProfile() {
  const res =
    await fetch(
      `${SPOTIFY_API}/me`,
      {
        headers: {
          Authorization:
            `Bearer ${accessToken}`
        }
      }
    );

  const user =
    await res.json();

  document
    .getElementById(
      'welcome-msg'
    )
    .textContent =
    `✔ Connected as ${
      user.display_name ||
      user.id
    }`;
}

// ==========================
// AUTH CHECK
// ==========================

async function boot() {
  const params =
    new URLSearchParams(
      window.location.search
    );

  const code =
    params.get('code');

  if (!code) {
    renderGrid();
    return;
  }

  status(
    'Connecting to Spotify...'
  );

  await exchangeToken(code);

  window.history.replaceState(
    {},
    document.title,
    window.location.pathname
  );

  document
    .getElementById(
      'auth-view'
    )
    .classList.add(
      'hidden'
    );

  document
    .getElementById(
      'app-view'
    )
    .classList.remove(
      'hidden'
    );

  await loadProfile();

  renderGrid();

  status(
    'Ready.'
  );
}

boot();

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
  const grid =
    document.getElementById(
      'band-grid'
    );

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

  MASTER_BANDS.forEach(
    (band) => {

      const card =
        document.createElement(
          'div'
        );

      card.className =
        'band-card';

      card.dataset.band =
        band.toLowerCase();

      let options = '';

      TIER_CONFIGS[
        currentMode
      ].forEach(
        (tier) => {

          options += `
            <option value="${tier.songs}">
              ${tier.name}
            </option>
          `;
        }
      );

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

      grid.appendChild(
        card
      );

      const checkbox =
        card.querySelector(
          '.band-checkbox'
        );

      const select =
        card.querySelector(
          '.tier-select'
        );

      const custom =
        card.querySelector(
          '.custom-input'
        );

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

        custom.classList.toggle(
          'hidden',
          select.value !== 'custom'
        );
      }

      checkbox.addEventListener(
        'change',
        () => {

          card.classList.toggle(
            'selected',
            checkbox.checked
          );
        }
      );

      select.addEventListener(
        'change',
        () => {

          custom.classList.toggle(
            'hidden',
            select.value !==
              'custom'
          );
        }
      );
    }
  );
}

// ==========================
// MODES
// ==========================

document
  .getElementById(
    'festival-btn'
  )
  .addEventListener(
    'click',
    () => {

      if (
        currentMode ===
        'festival'
      )
        return;

      currentMode =
        'festival';

      document
        .getElementById(
          'festival-btn'
        )
        .classList.add(
          'active'
        );

      document
        .getElementById(
          'tour-btn'
        )
        .classList.remove(
          'active'
        );

      document
        .getElementById(
          'playlist-name'
        )
        .value =
        'Festival Lineup Tape';

      renderGrid();
    }
  );

document
  .getElementById(
    'tour-btn'
  )
  .addEventListener(
    'click',
    () => {

      if (
        currentMode ===
        'tour'
      )
        return;

      currentMode =
        'tour';

      document
        .getElementById(
          'tour-btn'
        )
        .classList.add(
          'active'
        );

      document
        .getElementById(
          'festival-btn'
        )
        .classList.remove(
          'active'
        );

      document
        .getElementById(
          'playlist-name'
        )
        .value =
        'Tour Route Mix';

      renderGrid();
    }
  );

// ==========================
// SEARCH
// ==========================

document
  .getElementById(
    'catalog-search'
  )
  .addEventListener(
    'input',
    (e) => {

      const q =
        e.target.value
          .trim()
          .toLowerCase();

      document
        .querySelectorAll(
          '.band-card'
        )
        .forEach(
          (card) => {

            const show =
              card.dataset.band.includes(
                q
              );

            card.classList.toggle(
              'hidden',
              !show
            );
          }
        );
    }
  );
