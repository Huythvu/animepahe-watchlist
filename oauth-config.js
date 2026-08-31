// Baked-in OAuth client IDs so users can just press "Log in" without pasting an ID.
//
// Client IDs are NOT secrets — they travel in the visible OAuth authorize URL, so it's safe to keep
// them in this committed file. The MAL client *secret* is confidential and MUST NOT live here (this
// is a public repo); it's entered once in the popup and stored only in the user's browser.

// AniList app's numeric Client ID (implicit grant — no secret needed → fully one-click).
export const ANILIST_CLIENT_ID = "";

// MyAnimeList app's Client ID. The confidential MAL *secret* is not here — it's injected at build
// time from a gitignored .env (VITE_MAL_CLIENT_SECRET); see .env.example.
export const MAL_CLIENT_ID = "60a8a82cc2f53b48dd0d099513318703";
