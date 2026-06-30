// ==========================
// LIVE MIXTAPE STATION -- CONFIG TEMPLATE
// ==========================
// This file IS safe to commit to GitHub.
//
// To run this project locally:
//   1. Copy this file and rename it to config.js
//   2. Fill in your own Spotify CLIENT_ID and Worker URL
//   3. config.js is in .gitignore -- it stays on your machine only
// ==========================

// --- Spotify ---
// Get yours at: https://developer.spotify.com/dashboard
const CLIENT_ID = 'YOUR_SPOTIFY_CLIENT_ID_HERE';
const REDIRECT_URI = 'http://127.0.0.1:5500/index.html';

const SCOPES =
  'playlist-modify-public playlist-modify-private user-read-private';

const SPOTIFY_AUTH = 'https://accounts.spotify.com';
const SPOTIFY_API  = 'https://api.spotify.com/v1';

// --- Setlist.fm (via Cloudflare Worker) ---
// Deploy your own Worker (see worker.js in this repo) and
// put its public URL here. The real setlist.fm key stays
// inside the Worker's encrypted environment variables.
const WORKER_URL = 'https://your-worker-name.your-subdomain.workers.dev';
