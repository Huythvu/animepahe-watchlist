// MyAnimeList account login for the extension popup.
//
// MAL can't use AniList's clean implicit grant — it requires the OAuth 2.0 Authorization Code flow
// with PKCE, a client secret, and refresh tokens. The good news: MAL only supports the `plain` PKCE
// method, so the code_challenge is just the code_verifier verbatim (no SHA-256 needed). All of it
// runs from the popup: `chrome.identity.launchWebAuthFlow` opens MAL's consent page and hands back
// the ?code=..., then a token POST exchanges it.
//
// One-time setup (personal use): create an API app at https://myanimelist.net/apps/register with
// App Type "Web", redirect URL = getRedirectUrl(), and paste its Client ID and Client Secret into
// the popup. The secret is stored locally only (never committed, never leaves the browser).

const CLIENT_ID_KEY = "apw_mal_client_id";
const CLIENT_SECRET_KEY = "apw_mal_client_secret";
const TOKEN_KEY = "apw_mal_token";
const REFRESH_KEY = "apw_mal_refresh";
const EXPIRES_KEY = "apw_mal_expires";
const PROFILE_KEY = "apw_mal_profile";

const AUTHORIZE_URL = "https://myanimelist.net/v1/oauth2/authorize";
const TOKEN_URL = "https://myanimelist.net/v1/oauth2/token";
const API_BASE = "https://api.myanimelist.net/v2";

export function getRedirectUrl() {
    return chrome.identity.getRedirectURL();
}

export async function getClientId() {
    return (await chrome.storage.local.get([CLIENT_ID_KEY]))[CLIENT_ID_KEY] || "";
}

export async function getClientSecret() {
    return (await chrome.storage.local.get([CLIENT_SECRET_KEY]))[CLIENT_SECRET_KEY] || "";
}

export async function setCredentials(clientId, clientSecret) {
    const id = String(clientId || "").trim();
    const secret = String(clientSecret || "").trim();
    if (!id) throw new Error("Client ID is required.");
    if (!secret) throw new Error("Client Secret is required.");
    await chrome.storage.local.set({ [CLIENT_ID_KEY]: id, [CLIENT_SECRET_KEY]: secret });
}

export async function getProfile() {
    return (await chrome.storage.local.get([PROFILE_KEY]))[PROFILE_KEY] || null;
}

export async function isLoggedIn() {
    return !!(await chrome.storage.local.get([TOKEN_KEY]))[TOKEN_KEY];
}

// A high-entropy PKCE code verifier (43–128 chars of the unreserved set). With MAL's `plain` method
// this doubles as the code_challenge.
function makeCodeVerifier() {
    const bytes = crypto.getRandomValues(new Uint8Array(64));
    const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    return Array.from(bytes, b => charset[b % charset.length]).join("");
}

export async function login() {
    const clientId = await getClientId();
    const clientSecret = await getClientSecret();
    if (!clientId || !clientSecret) throw new Error("Set your MAL Client ID and Secret first.");

    const redirectUri = getRedirectUrl();
    const codeVerifier = makeCodeVerifier();
    const state = makeCodeVerifier().slice(0, 24);

    const authUrl = `${AUTHORIZE_URL}?response_type=code` +
        `&client_id=${encodeURIComponent(clientId)}` +
        `&code_challenge=${encodeURIComponent(codeVerifier)}` +
        `&code_challenge_method=plain` +
        `&state=${encodeURIComponent(state)}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}`;

    const redirectResponse = await chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true });
    if (!redirectResponse) throw new Error("Login was cancelled.");

    // Code flow returns in the query string: https://<id>.chromiumapp.org/?code=...&state=...
    const url = new URL(redirectResponse);
    const returnedState = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    if (error) throw new Error(url.searchParams.get("message") || error);
    if (!code) throw new Error("MAL did not return an authorization code.");
    if (returnedState !== state) throw new Error("State mismatch — login aborted.");

    await exchangeCode(code, codeVerifier, redirectUri, clientId, clientSecret);
    return await fetchProfile();
}

async function exchangeCode(code, codeVerifier, redirectUri, clientId, clientSecret) {
    const body = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "authorization_code",
        code,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
    });
    const resp = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
    });
    if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`MAL token exchange failed (${resp.status}). ${text.slice(0, 200)}`);
    }
    await storeTokens(await resp.json());
}

async function storeTokens(data) {
    const expiresAt = Date.now() + (Number(data.expires_in || 0) * 1000);
    await chrome.storage.local.set({
        [TOKEN_KEY]: data.access_token,
        [REFRESH_KEY]: data.refresh_token || "",
        [EXPIRES_KEY]: expiresAt,
    });
}

// Refresh the access token when it's within a day of expiry. Returns a usable token, or "" if the
// session can't be renewed (caller should treat as logged out).
export async function getValidToken() {
    const data = await chrome.storage.local.get([TOKEN_KEY, REFRESH_KEY, EXPIRES_KEY]);
    const token = data[TOKEN_KEY];
    if (!token) return "";

    const expiresAt = data[EXPIRES_KEY] || 0;
    if (Date.now() < expiresAt - 24 * 60 * 60 * 1000) return token;   // still fresh

    const refresh = data[REFRESH_KEY];
    if (!refresh) return token;   // no refresh token — use what we have until it 401s

    const clientId = await getClientId();
    const clientSecret = await getClientSecret();
    try {
        const body = new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            grant_type: "refresh_token",
            refresh_token: refresh,
        });
        const resp = await fetch(TOKEN_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: body.toString(),
        });
        if (!resp.ok) return token;
        const json = await resp.json();
        await storeTokens(json);
        return json.access_token;
    } catch {
        return token;
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
