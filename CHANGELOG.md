# Changelog

## v1.5.0 — Player features (beta)

- Auto-play next episode: a countdown card appears in the last 10 seconds of the video and navigates to the next episode when it hits zero
- Countdown tracks the video — scrubbing back out of the last 10s hides it, scrubbing back in shows it again with the correct remaining time, and pausing freezes it
- Cancel button on the countdown card opts out for the current episode
- Auto-play toggle pill sits in the bottom-right of the player so it can be flipped on or off without leaving the page
- Next episode starts playing automatically after auto-navigation (no manual click required)
- Countdown stays visible in fullscreen, independent of the player's idle-fade
- Auto-play next is off by default and marked beta — enable it in Settings
- Resume from last position and Skip intro / outro (AniSkip) are listed in the Player section as upcoming

## v1.4.2 — Later-season link fix (hotfix)

- Fixes broken links for later seasons/cours (e.g. episode 31+) where the displayed episode number is cumulative — the resolver now finds the correct episode regardless of how AnimePahe paginates its episode list, instead of guessing the wrong page and falling back to a stale link

## v1.4.1 — Link rotation & duplicate fixes

- Fixes broken links when navigating to the next episode via auto-play — the episode URL is now resolved fresh at navigation time, so it keeps working after AnimePahe rotates its session IDs
- Duplicate watchlist entries from session rotations are now cleaned up automatically — no more needing to remove them manually
- Deduplication now matches by stable anime ID first (not just title), so entries with slightly different title formats are merged correctly

## v1.4.0 — Settings panel

- Settings moved into a dedicated side panel that slides in over AnimePahe
- Settings pill added next to the Currently Watching / Plan to Watch tabs
- Panel can open from the left or right side of the screen
- Progress text can now show either aired episodes (e.g. 9 of 9) or total planned episodes (e.g. 9 of 13)

## v1.3.0 — Duplicate fix

- Fixes a follow-up issue from v1.2.0 where clicking a stale card would correctly resolve the fresh URL, but the play page then saved a new entry alongside the old one. The widget now recognizes the same anime across session rotations and updates the existing entry in place.
- Existing duplicates already in your list need to be removed manually once.

## v1.2.0 — Stale link fix

- Fixes broken links when AnimePahe rotates its session IDs — cards now resolve the current URL before navigating
- Minor sync improvements to keep links accurate across devices

## v1.1.0 — Sync & customization update

- Separate caps: 20 Currently Watching + 50 Plan to Watch
- Widget toggle to disable the on-page widget without uninstalling
- Customize panel with card alignment and visibility toggles
- Two-way sync: opening AnimePahe now pulls cloud changes, not just pushes them
- Redesigned sync panel with Disconnect button and inline validation
- Minor UI polish and quality-of-life improvements

## v1.0.0 — Initial release

- Currently Watching / Plan to Watch widget on the AnimePahe homepage
- Auto-saves watched episodes with AniList posters and airing data
- Cloud sync via 5-word phrase
- Airing countdowns and new-episode badges
