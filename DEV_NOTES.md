# Dev Notes

Troubleshooting notes for future me. Committed to the repo (fine if public).
Update freely.

---

## Beta versioning convention
While beta-testing the 1.5.x player features, **bump `manifest.json` version on
every meaningful change** (1.5.1, 1.5.2, ...). The Settings panel footer shows
`chrome.runtime.getManifest().version`, so this is how I confirm the loaded build
is the one I just changed. 1.4.0 = public/stable; 1.5.x = beta on
`claude/auto-sync-on-refresh-OkxlG`.

## Rotation diagnostic (beta)
Passive detection in `resolveFreshUrl`: the stored `entry.animeUrl` holds the
session at save time; if the freshly searched `match.session` differs, the link
rotated -> `recordRotation(title)` bumps a counter in
`chrome.storage.local["apw_rotation_log"]` = `{ count, lastTs, lastTitle }`.
Shown in the Settings panel under **Diagnostics** as "N detected · last <date>".
Note: the panel builds once per page load, so the count refreshes on next load
(which is exactly when rotation gets detected anyway — on card click -> navigate).
To inspect raw: DevTools -> Application -> Storage -> `apw_rotation_log`.

## The "rotating links" problem (most important thing to remember)

AnimePahe rotates its **session IDs** periodically. URLs look like:

- Anime page: `/anime/{animeSession}`
- Play page:  `/play/{animeSession}/{epSession}`

Both `animeSession` and `epSession` go stale after rotation. Any link we
**stored earlier** (widget card, dropdown href) can point at a dead session and
404 / misbehave when clicked later.

### Golden rule
**Never navigate to a stored/DOM href directly. Always re-resolve fresh first.**

The one rotation-proof primitive is `resolveFreshUrl(entry, type)` in
`content.js`. It does a **fresh search by title** to re-derive a current
`animeSession`, then a release lookup to get the current `epSession`. Because a
search is done live at click/navigation time, the result can't be stale.

```
searchAnimepahe(title)  -> /api?m=search&q=...   -> fresh animeSession + animeId
fetchEpisodeList(sess, epNum) -> /api?m=release&id=...&sort=episode_asc&page=N -> fresh epSession
```

`page = ceil(epNum / 30)` because the release API paginates 30 episodes/page.

### Caching note
`resolvedAnimeCache` (module-level Map) lives only for one page load. Every
episode navigation is a **full page reload**, so the cache starts empty on each
play page and the first resolution is always a live search. This is *why* it's
safe — the session is fetched seconds before we use it.

---

## Duplicate entries (the other half of the rotation problem)

Rotation also caused **duplicate watchlist entries**: an entry saved under an old
session would not be recognized when the same anime was opened later under a new
session, so a second copy got saved alongside the old one.

### Stable identity: `animeId`
`animeUrl` (`/anime/{session}`) is NOT stable — it rotates. The stable key is
`animeId` (the numeric AnimePahe id from search results, `a.id`). It's backfilled
onto entries by `resolveFreshUrl` -> `updateEntryAnimeId` the first time an entry
is resolved. **Always dedupe/match on `animeId` when available, title only as
fallback.**

### Three defenses (all in content.js)
1. **`dedupList(list)`** — runs on every `renderWatchlist`. Groups by
   `id:{animeId}` or `t:{normalized title}`, keeps the most recently updated
   entry, inherits `thumb`/`animeId` from discarded duplicates, re-sorts by `ts`.
   Saves back only if length changed. **This retroactively cleans pre-existing
   duplicates** — just open the homepage. (Earlier we told users to delete dupes
   manually; that's no longer needed.)
2. **`saveCurrentEpisode` three-tier match**: `animeUrl` -> `animeId` -> `title`.
   The middle tier catches rotated sessions even when the title is stored slightly
   differently (colons, dashes, regional variants).
3. **`sessionStorage["apw-nav-anime-id"]`** — card click stores the resolved
   `animeId` right before navigating; the play page reads it for an exact
   `animeId` match, then deletes it. Makes the first save after a card click exact
   even when both the url session and title differ.

---

## Navigation paths and their rotation-safety (audit map)

| Where | Function | Safe? |
|---|---|---|
| Widget card / title click | `resolveFreshUrl` (content.js ~1645) | ✅ search-based |
| Auto-play next episode | `getNextEpisodeUrl` -> `resolveFreshUrl` | ✅ search-based |
| Error fallbacks | raw stored href (1649, no-iframe 2157, last-resort) | ⚠️ stale, only on failure |

`getNextEpisodeUrl()` resolution order (best -> worst):
1. Matched watched entry (exact via `animeId`) -> `resolveFreshUrl` — rotation-proof
2. Current URL's `animeSession` + `fetchEpisodeList` — accurate, usually fresh
3. Title search via `resolveFreshUrl` — rotation-proof, no watched entry needed
4. Raw dropdown `href` — last resort only

### The bug that bit us (don't reintroduce)
First auto-play fix resolved the next ep using the **current URL's animeSession**.
But AnimePahe can rotate *during* the ~24-min episode, so by the time the video
ends that session is already stale -> release lookup empty -> fell back to the
stale dropdown href -> broken link. Fix: route through `resolveFreshUrl` so a
**fresh search** happens ~10s before navigating (videoEnded fires at 10s left).

---

## Auto-play next: how the pieces talk

Two scripts, cross-frame via `postMessage`:

- **content.js** runs on `animepahe.pw` (the parent page).
- **player.js** runs inside the **kwik.cx iframe** (where the `<video>` lives).
  Injected via manifest content script with `all_frames: true` + kwik.cx host
  permission.

Message flow (`source: "apw-player"` = from iframe, `source: "apw-host"` = from parent):

```
player.js: video bound           -> postParent {playerReady}
content.js: playerReady received -> if autoPlayPending -> sendAutoPlayToIframe()
                                    if autoFullscreenPending -> enterFullscreen msg

player.js: remaining < 10s        -> postParent {videoEnded}   (fires ONCE)
content.js: videoEnded            -> nextUrl = await getNextEpisodeUrl()
                                    -> startCountdownInIframe(nextUrl)  (sets pendingNextUrl)
content.js -> player.js           -> {startCountdown}
player.js: countdown overlay shown, driven by VIDEO TIME (not setInterval)
player.js: video ended            -> postParent {countdownDone}
content.js: countdownDone          -> set sessionStorage flags, navigate to pendingNextUrl
```

### Key state flags (content.js)
- `pendingNextUrl` — resolved next-ep URL, navigated to on countdownDone
- `autoPlayPending` / `AUTOPLAY_STORAGE_KEY` (sessionStorage) — carry "auto-play
  the next page" intent across the full page reload
- `autoFullscreenPending` / `AUTOPLAY_FS_STORAGE_KEY` — carry fullscreen intent
- `playerIsFullscreen` — synced from iframe `fullscreenState` messages

---

## Gotchas already solved (history — don't redo these)

- **Countdown driven by video time**, NOT setInterval. Uses
  timeupdate/seeked/play/pause. Seeking out of the last 10s resets state; seeking
  back re-arms with correct remaining. Pausing freezes it. One-shot `countdownState`
  flag prevents the "re-pops every 5s" bug.
- **Countdown visible in fullscreen**: uses the **Popover API** (`popover="manual"`
  + `showPopover()`) so it renders in the browser top layer, above kwik's
  idle-fade and fullscreen element.
- **Fullscreen target = `document.documentElement`** (NOT the video element).
  Fullscreening just the video drops kwik's controls and caused the black-screen-
  on-double-click-exit bug. Patched `requestFullscreen`/`webkitRequestFullscreen`
  on the video to redirect to documentElement (player.js `patchFullscreen`).
- **Autoplay unpause**: `startTryPlay()` clicks `.click-to-load` / play buttons
  then `video.play()`, looping until `currentTime > 0`. Capped at ~30 tries
  (~12s) — was higher, lowered to avoid runaway loops. Do NOT mute as a fallback
  (broke user volume). `autoPlayLoopActive` guard = pause stays possible.
- **Pill placement**: `apw-player-bar-outer` placed `afterend` of `.player`,
  width mirrored to `player.offsetWidth` via ResizeObserver so it stays aligned
  with the video at any viewport size.

---

## Versions
- **v1.4.0** = public/stable (Settings side panel). Shipping now.
- **v1.5.0** = beta on `claude/auto-sync-on-refresh-OkxlG` (player features:
  auto-play next, countdown, in-iframe fullscreen). NOT public yet.

## Testing reminders
- Can't hit the live AnimePahe API from the sandbox (cookie / DDoS-guard gated).
  All rotation fixes are verified by code analysis + `node --check`, not live.
  **Real verification = test an actual auto-play transition on the site.**
- Hard to test rotation directly (can't force AnimePahe to rotate). Symptoms to
  watch instead: old saved cards that 404, and duplicate entries appearing.
- Dedup retroactive cleanup: just open the AnimePahe homepage — `renderWatchlist`
  runs `dedupList` and saves the cleaned list. Existing dupes should collapse.
- Manifest V3, Shadow DOM panel (`panel.css` via `chrome.runtime.getURL`),
  Firebase Firestore sync, AniList GraphQL for posters/airing.

## Quick checks
```
node --check content.js
node --check player.js
```
