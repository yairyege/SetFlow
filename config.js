// ==========================
// SETFLOW — CONFIG
// ==========================
// WARNING: This file is in .gitignore
//          NEVER commit this to GitHub.
// ==========================

// --- Spotify ---
const CLIENT_ID = '96ffdeb107d54909b65a95d930b40d04';
const REDIRECT_URI = 'https://yairyege.github.io/SetFlow/index.html';
// For the live GitHub Pages version use:
// const REDIRECT_URI = 'https://yairyege.github.io/SetFlow/index.html';

const SCOPES =
  'playlist-modify-public playlist-modify-private user-read-private';

const SPOTIFY_AUTH = 'https://accounts.spotify.com';
const SPOTIFY_API  = 'https://api.spotify.com/v1';

// --- Setlist.fm (via Cloudflare Worker) ---
const WORKER_URL = 'https://setflow.yairyeger.workers.dev';

// --- Supabase band cache ---
const SUPABASE_URL  = 'https://rgiwdjkmsegoypcnttks.supabase.co';
const SUPABASE_KEY  = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJnaXdkamttc2Vnb3lwY250dGtzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMyNDI5MDAsImV4cCI6MjA5ODgxODkwMH0.IIC68PHR6DlPcgzSHJGq7DUPMUCQNe6kQudnwtwMbJA';
