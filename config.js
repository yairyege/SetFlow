// ==========================
// LIVE MIXTAPE STATION -- CONFIG (Live / GitHub Pages)
// ==========================
// This version is safe to commit since it contains
// no secret keys -- only the Spotify CLIENT_ID (public
// by PKCE design) and the public Worker URL.
// ==========================

// --- Spotify ---
const CLIENT_ID = '96ffdeb107d54909b65a95d930b40d04';
const REDIRECT_URI = 'https://yairyege.github.io/setflow/index.html';

const SCOPES =
  'playlist-modify-public playlist-modify-private user-read-private';

const SPOTIFY_AUTH = 'https://accounts.spotify.com';
const SPOTIFY_API  = 'https://api.spotify.com/v1';

// --- Setlist.fm (via Cloudflare Worker) ---
// The real setlist.fm key lives in the Worker's
// encrypted environment variables, not here.
const WORKER_URL = 'https://setflow.yairyeger.workers.dev';
