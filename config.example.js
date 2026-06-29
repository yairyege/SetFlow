// ==========================
// LIVE MIXTAPE STATION — CONFIG TEMPLATE
// ==========================
// This file IS safe to commit to GitHub.
// It shows others what config.js should look like.
//
// To run this project locally:
//   1. Copy this file and rename it to config.js
//   2. Fill in your own API keys below
//   3. config.js is in .gitignore — it stays on your machine only
// ==========================

// --- Spotify ---
// Get yours at: https://developer.spotify.com/dashboard
const CLIENT_ID = 'YOUR_SPOTIFY_CLIENT_ID_HERE';
const REDIRECT_URI = 'https://yairyege.github.io/SetFlow/';

const SCOPES =
  'playlist-modify-public playlist-modify-private user-read-private';

const SPOTIFY_AUTH = 'https://accounts.spotify.com';
const SPOTIFY_API  = 'https://api.spotify.com/v1';

// --- Setlist.fm ---
// Get yours at: https://api.setlist.fm
const SETLIST_API  = 'https://api.setlist.fm/rest/1.0';
const SETLIST_KEY  = 'YOUR_SETLISTFM_API_KEY_HERE';
const CORS_PROXY   = 'https://corsproxy.io/?';
