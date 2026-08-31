// Relay-based OAuth for the extension.
//
// Instead of holding any client secret or running chrome.identity, the extension logs in through
// NyanTV's pairing relay (the same Vercel service NyanTV uses). The relay holds the client IDs and
// secrets and does the token exchange server-side ("token" mode), so the extension only ever sees
// the finished access token. Flow: POST /api/pair/new?provider=…&mode=token → open the returned
// verifyUrl in a tab so the user approves in a real browser → poll /api/pair/poll until the relay
// has exchanged the code → get { accessToken, refreshToken, expiresIn }.
//
// This MUST run in the background service worker: opening the consent tab closes the action popup,
// which would kill a poll loop running there.

const RELAY_BASE = "https://nyan-tv.vercel.app";
const POLL_INTERVAL_MS = 2500;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

// Run the relay pairing flow for "anilist" | "mal". Resolves with { accessToken, refreshToken,
// expiresIn }. Throws on cancel/timeout/error.
export async function relayLogin(provider) {
    const startResp = await fetch(
        `${RELAY_BASE}/api/pair/new?provider=${encodeURIComponent(provider)}&mode=token`,
        { method: "POST" },
    );
    if (!startResp.ok) throw new Error(`Login service unavailable (${startResp.status}).`);
    const session = await startResp.json();
    if (!session.code || !session.verifyUrl) throw new Error("Login service did not start a session.");

    const tab = await chrome.tabs.create({ url: session.verifyUrl });
    const timeoutMs = session.expiresIn ? session.expiresIn * 1000 : DEFAULT_TIMEOUT_MS;
    try {
        return await pollForToken(session.code, timeoutMs);
    } finally {
        if (tab?.id != null) { try { await chrome.tabs.remove(tab.id); } catch {} }
    }
}

async function pollForToken(code, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS);

        let data;
        try {
            const resp = await fetch(`${RELAY_BASE}/api/pair/poll?code=${encodeURIComponent(code)}`);
            data = await resp.json();
        } catch {
            continue;   // transient network blip — keep polling
        }

        if (data.status === "pending") continue;
        if (data.status === "expired") throw new Error("Login timed out. Please try again.");
        if (data.status === "error") throw new Error(data.error || "Sign-in failed.");
        if (data.status === "done") {
            if (!data.accessToken) {
                // Old relay without server-side token mode returns a raw code instead of a token.
                throw new Error("Login service is not returning tokens yet (relay needs the token-mode update).");
            }
            return {
                accessToken: data.accessToken,
                refreshToken: data.refreshToken ?? null,
                expiresIn: data.expiresIn ?? null,
            };
        }
    }
    throw new Error("Login timed out. Please try again.");
}

// Renew an access token through the relay (MAL). Returns { accessToken, refreshToken, expiresIn }.
export async function relayRefresh(provider, refreshToken) {
    const resp = await fetch(`${RELAY_BASE}/api/pair/refresh?provider=${encodeURIComponent(provider)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
    });
    if (!resp.ok) throw new Error(`Token refresh failed (${resp.status}).`);
    return await resp.json();
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
