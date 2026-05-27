# Changelog

## v1.5.0 — Player features

- Auto-play next episode: a countdown card appears in the last 10 seconds of the video and navigates to the next episode when it hits zero
- Countdown tracks the video — scrubbing back out of the last 10s hides it, scrubbing back in shows it again with the correct remaining time, and pausing freezes it
- Cancel button on the countdown card opts out for the current episode
- Auto-play toggle pill sits in the bottom-right of the player so it can be flipped on or off without leaving the page
- Pill width mirrors the video player's width via ResizeObserver, so it stays right-aligned with the player at any viewport size
- Pill is visible immediately, even before the video has loaded
- Next episode starts playing automatically after auto-navigation (no manual click required)
- Countdown stays visible in fullscreen, independent of the player's idle-fade
- Panel option to hide the auto-play pill entirely if you never want it
- Resume from last position and Skip intro / outro (AniSkip) are listed in the Player section as upcoming

## v1.4.0 — Settings panel

- Widget customization settings moved out of the popup into a dedicated side panel that slides in over AnimePahe
- New Settings pill next to the Currently Watching / Plan to Watch tabs opens the panel, styled to match the existing tab pills
- "Settings ↗" pill in the popup opens the panel on the active AnimePahe tab, or opens AnimePahe first when used elsewhere
- Popup header reorganized: AnimePahe, Settings, and the widget enable toggle sit in a single row below the title
- Panel can be opened from the left or right side of the screen
- Option to hide the Settings pill on the homepage widget
- Progress text can now show either current aired episodes (9 of 9) or the total planned episode count (9 of 13)
- Total episode count is normalized to AnimePahe's continuous numbering across season parts (e.g. 31 of 37 instead of 31 of 13)
- Shows "?" when AniList doesn't expose a total to avoid implying a show has ended when it hasn't
- Panel uses Shadow DOM so its styling is fully isolated from AnimePahe

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
