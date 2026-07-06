// ==========================
// SETFLOW — CONFIG
// ==========================
// This file is safe to commit to GitHub.
// No secrets live here — all API keys
// are in the Cloudflare Worker env vars.
// ==========================

// --- Spotify ---
const CLIENT_ID = '4173f0358956439f9489d0c4a5041f15';
const REDIRECT_URI = 'https://yairyege.github.io/SetFlow/index.html';
// For the live GitHub Pages version use:
// const REDIRECT_URI = 'https://yairyege.github.io/SetFlow/index.html';

const SCOPES =
  'playlist-modify-public playlist-modify-private user-read-private';

const SPOTIFY_AUTH = 'https://accounts.spotify.com';
const SPOTIFY_API  = 'https://api.spotify.com/v1';

// --- Cloudflare Worker ---
// All other API keys (setlist.fm, Supabase) live inside
// the Worker's encrypted environment variables.
const WORKER_URL = 'https://setflow.yairyeger.workers.dev';
