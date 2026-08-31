// AniList account login + authenticated GraphQL for the extension.
//
// Login goes through NyanTV's pairing relay (see relay-auth.js): the relay holds the AniList client
// ID + secret and does the OAuth token exchange server-side, so the extension never handles a
// secret and doesn't need chrome.identity. AniList's implicit grant is rejected, so the code grant
// via the relay is the only path that works. Must be driven from the background service worker.

import { relayLogin } from "./relay-auth.js";

const TOKEN_KEY   = "apw_anilist_token";
const PROFILE_KEY = "apw_anilist_profile";

const GRAPHQL_URL = "https://graphql.anilist.co";

export async function getToken() {
    const data = await chrome.storage.local.get([TOKEN_KEY]);
    return data[TOKEN_KEY] || "";
}

export async function getProfile() {
    const data = await chrome.storage.local.get([PROFILE_KEY]);
    return data[PROFILE_KEY] || null;
}

export async function isLoggedIn() {
    return !!(await getToken());
}

/**
 * Log in to AniList via the relay. Runs the pairing flow (opens a consent tab, polls for the token),
 * stores the token, and returns the profile. Call from the background service worker.
 */
export async function login() {
    const { accessToken } = await relayLogin("anilist");
    if (!accessToken) throw new Error("AniList login did not return a token.");
    await chrome.storage.local.set({ [TOKEN_KEY]: accessToken });
    return fetchViewer();
}

export async function logout() {
    await chrome.storage.local.remove([TOKEN_KEY, PROFILE_KEY]);
}

/**
 * Authenticated AniList GraphQL call. Sends the Bearer token when logged in; returns the parsed
 * `data` object. On a 401 the stored token is cleared (expired/revoked) and an error is thrown.
 */
export async function anilistQuery(query, variables = {}) {
    const token = await getToken();
    const headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const resp = await fetch(GRAPHQL_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({ query, variables }),
    });

    if (resp.status === 401) {
        await logout();
        throw new Error("AniList session expired. Please log in again.");
    }
    if (!resp.ok) throw new Error(`AniList request failed (${resp.status}).`);

    const json = await resp.json();
    if (json.errors?.length) throw new Error(json.errors[0].message || "AniList error");
    return json.data;
}

/** Fetch the logged-in user's profile and cache it. Mirrors AnilistService.fetchUserProfile. */
export async function fetchViewer() {
    const data = await anilistQuery(`{
        Viewer {
            id
            name
            avatar { large }
            bannerImage
            statistics { anime { count episodesWatched meanScore } }
        }
    }`);

    const v = data?.Viewer;
    if (!v) throw new Error("Could not load AniList profile.");

    const profile = {
        id: v.id,
        name: v.name,
        avatar: v.avatar?.large || "",
        banner: v.bannerImage || "",
        animeCount: v.statistics?.anime?.count ?? null,
        episodesWatched: v.statistics?.anime?.episodesWatched ?? null,
        meanScore: v.statistics?.anime?.meanScore ?? null,
    };
    await chrome.storage.local.set({ [PROFILE_KEY]: profile });
    return profile;
}
