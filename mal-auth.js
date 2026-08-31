// MyAnimeList account login for the extension.
//
// Login goes through NyanTV's pairing relay (see relay-auth.js): the relay holds the MAL client ID
// + secret and does the PKCE token exchange (and refresh) server-side, so the extension never holds
// a secret and doesn't need chrome.identity. Must be driven from the background service worker.

import { relayLogin, relayRefresh } from "./relay-auth.js";

const TOKEN_KEY = "apw_mal_token";
const REFRESH_KEY = "apw_mal_refresh";
const EXPIRES_KEY = "apw_mal_expires";
const PROFILE_KEY = "apw_mal_profile";

const API_BASE = "https://api.myanimelist.net/v2";

export async function getProfile() {
    return (await chrome.storage.local.get([PROFILE_KEY]))[PROFILE_KEY] || null;
}

export async function isLoggedIn() {
    return !!(await chrome.storage.local.get([TOKEN_KEY]))[TOKEN_KEY];
}

/**
 * Log in to MAL via the relay. Runs the pairing flow, stores the tokens, and returns the profile.
 * Call from the background service worker.
 */
export async function login() {
    const tok = await relayLogin("mal");
    if (!tok.accessToken) throw new Error("MAL login did not return a token.");
    await storeTokens(tok);
    return fetchProfile();
}

async function storeTokens(tok) {
    const expiresAt = Date.now() + (Number(tok.expiresIn || 0) * 1000);
    await chrome.storage.local.set({
        [TOKEN_KEY]: tok.accessToken,
        [REFRESH_KEY]: tok.refreshToken || "",
        [EXPIRES_KEY]: expiresAt,
    });
}

// Return a usable access token, refreshing via the relay when it's within a day of expiry. Returns
// "" only when there's no token at all.
export async function getValidToken() {
    const data = await chrome.storage.local.get([TOKEN_KEY, REFRESH_KEY, EXPIRES_KEY]);
    const token = data[TOKEN_KEY];
    if (!token) return "";

    const expiresAt = data[EXPIRES_KEY] || 0;
    if (Date.now() < expiresAt - 24 * 60 * 60 * 1000) return token;   // still fresh

    const refresh = data[REFRESH_KEY];
    if (!refresh) return token;   // no refresh token — use what we have until it 401s

    try {
        const tok = await relayRefresh("mal", refresh);
        if (!tok.accessToken) return token;
        await storeTokens(tok);
        return tok.accessToken;
    } catch {
        return token;   // refresh failed — keep the current token until it 401s
    }
}

export async function logout() {
    await chrome.storage.local.remove([TOKEN_KEY, REFRESH_KEY, EXPIRES_KEY, PROFILE_KEY]);
}

// Authenticated MAL API GET. On 401 the session is cleared so the UI drops to logged-out.
export async function malApiGet(path) {
    const token = await getValidToken();
    if (!token) throw new Error("Not logged in to MAL.");

    const resp = await fetch(`${API_BASE}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (resp.status === 401) {
        await logout();
        throw new Error("MAL session expired. Please log in again.");
    }
    if (!resp.ok) throw new Error(`MAL request failed (${resp.status}).`);
    return await resp.json();
}

export async function fetchProfile() {
    const data = await malApiGet("/users/@me?fields=anime_statistics");
    const profile = {
        id: data.id,
        name: data.name || "MAL user",
        watching: data.anime_statistics?.num_items_watching ?? null,
        episodes: data.anime_statistics?.num_episodes ?? null,
    };
    await chrome.storage.local.set({ [PROFILE_KEY]: profile });
    return profile;
}
