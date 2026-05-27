# Changelog

## v1.4.0 — Settings panel

- Widget customization settings moved out of the popup into a dedicated side panel that slides in over AnimePahe
- New settings pill next to the Currently Watching / Plan to Watch tabs opens the panel, styled to match the existing tab pills
- "Settings ↗" pill in the popup opens the panel on the active AnimePahe tab, or opens AnimePahe first when used elsewhere
- Popup header reorganized: AnimePahe, Settings, and the widget enable toggle sit in a single row below the title
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
