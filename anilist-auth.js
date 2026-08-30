// AniList account login + authenticated GraphQL for the extension.
//
// This is the extension-native port of NyanTV's AnilistService. NyanTV uses a *confidential* OAuth
// code flow (client_id + client_secret) routed through a pair-server, because an Android TV can't
// catch a browser redirect. A Chrome extension can do the far simpler **implicit grant**:
// `chrome.identity.launchWebAuthFlow` opens AniList's consent page and hands back the redirect URL
// with the access token in its fragment — no secret, no relay server.
//
// One-time setup (personal use): register an AniList API client at
// https://anilist.co/settings/developer with the redirect URL that `getRedirectUrl()` returns
// (shown in the popup), then paste that client's numeric ID into the popup. The client ID is not a
// secret in the implicit flow, so storing it locally is fine.

const CLIENT_ID_KEY = "apw_anilist_client_id";
const TOKEN_KEY     = "apw_anilist_token";
const PROFILE_KEY   = "apw_anilist_profile";

const AUTHORIZE_URL = "https://anilist.co/api/v2/oauth/authorize";
const GRAPHQL_URL   = "https://graphql.anilist.co";

/** The redirect URL Chrome assigns this extension: https://<extension-id>.chromiumapp.org/ */
export function getRedirectUrl() {
    return chrome.identity.getRedirectURL();
}

export async function getClientId() {
    const data = await chrome.storage.local.get([CLIENT_ID_KEY]);
    return data[CLIENT_ID_KEY] || "";
}

export async function setClientId(clientId) {
    const cleaned = String(clientId || "").trim();
    if (!/^\d+$/.test(cleaned)) throw new Error("Client ID must be the numeric ID from AniList.");
    await chrome.storage.local.set({ [CLIENT_ID_KEY]: cleaned });
}

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
 * Run the AniList OAuth implicit grant. Must be called from an extension page (popup/background),
 * never a content script. Resolves with the stored profile on success; throws on cancel/failure.
 */
export async function login() {
    const clientId = await getClientId();
    if (!clientId) throw new Error("Set your AniList Client ID first.");

    const redirectUri = getRedirectUrl();
    const url = `${AUTHORIZE_URL}?client_id=${encodeURIComponent(clientId)}` +
                `&redirect_uri=${encodeURIComponent(redirectUri)}` +
                `&response_type=token`;

    const redirectResponse = await chrome.identity.launchWebAuthFlow({ url, interactive: true });
    if (!redirectResponse) throw new Error("Login was cancelled.");

    // Implicit grant returns the token in the URL fragment:
    //   https://<id>.chromiumapp.org/#access_token=...&token_type=Bearer&expires_in=...
    const hash = redirectResponse.split("#")[1] || "";
    const params = new URLSearchParams(hash);
    const token = params.get("access_token");
    const error = params.get("error");
    if (error) throw new Error(params.get("error_description") || error);
    if (!token) throw new Error("AniList did not return a token. Check the redirect URL is registered.");

    await chrome.storage.local.set({ [TOKEN_KEY]: token });

    const profile = await fetchViewer();
    return profile;
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
