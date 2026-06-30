# 🎸 SetFlow

> Build Spotify playlists from real live setlists. Pick your festival lineup, SetFlow pulls what each band actually plays on stage — most played songs first — so you know every word before the show.

\---

## What it does

SetFlow is a festival and tour playlist generator. Instead of pulling an artist's most-streamed songs, it checks **what they actually play live** using setlist.fm data — ranked by how often each song appears across recent shows. If no setlist data exists for a band, it falls back to Spotify's most-streamed tracks automatically.

* 🎤 **Setlist-first** — real songs from real shows, ranked by play frequency
* 📊 **Spotify fallback** — automatic if no live data is available
* 🎯 **Tier system** — assign headliner, support, or discovery slots per band
* ✦ **New releases** — optionally append each band's latest drop to the playlist
* 🔀 **Sort options** — order by name, fewest songs first, most songs first
* 🚫 **No live versions** — studio tracks only
* 🚫 **No duplicates** — same song from single vs album is caught and deduplicated



## API keys

|Key|Where to get it|Free tier|
|-|-|-|
|Spotify Client ID|[developer.spotify.com](https://developer.spotify.com/dashboard)|Yes — up to 5 users in dev mode|
|Setlist.fm API key|[api.setlist.fm](https://api.setlist.fm)|Yes — rate limited|



\---

## Project structure

```
setflow/
├── index.html          # UI
├── script-part1.js     # Auth, band grid, Spotify login
├── script-part2.js     # Setlist logic, track resolver, playlist generator
├── config.js           # ⚠️ Your API keys — NOT committed to git
├── config.example.js   # Safe template — commit this
└── .gitignore
```

\---

## Limitations (current)

* Spotify dev mode supports up to **5 users**. To open the app publicly, Extended Quota Mode is required (needs a registered business entity as of 2025).
* Setlist.fm free tier is rate-limited. A band cache via Supabase is planned to reduce API calls at scale.
* The setlist.fm proxy uses [corsproxy.io](https://corsproxy.io) for local/static hosting. A dedicated Cloudflare Worker proxy is planned for production.

\---

## Roadmap

* \[ ] Supabase band cache — store setlist lookups so each band is only fetched once ever
* \[ ] Full UI overhaul — mobile-first redesign
* \[ ] Playlist sort and band ordering controls
* \[ ] Cloudflare Worker proxy to replace corsproxy.io
* \[ ] Public launch via Spotify Extended Quota

\---

## Built with

* Vanilla JavaScript (no framework)
* Spotify Web API (PKCE OAuth)
* Setlist.fm REST API
* corsproxy.io (CORS proxy for setlist.fm)

\---

*Built for festival-goers who want to know every word before the first chord drops.* 🤘

