import { getLocalSyncKey, getLastSyncedAt, uploadWatchlist, syncWatchlist } from "./sync.js";

const STORAGE_KEY = "recently_watched";
const WARN_AFTER_MS = 75 * 24 * 60 * 60 * 1000;
const TTL_MS        = 90 * 24 * 60 * 60 * 1000;

let uploadTimeout = null;

console.log("Background service worker loaded");

async function checkExpiryBadge() {
    const syncKey = await getLocalSyncKey();

    if (!syncKey) {
        chrome.action.setBadgeText({ text: "" });
        return;
    }

    const lastSynced = await getLastSyncedAt();

    if (!lastSynced) {
        chrome.action.setBadgeText({ text: "" });
        return;
    }

    const age = Date.now() - lastSynced;

    if (age >= WARN_AFTER_MS) {
        const daysLeft = Math.max(0, Math.ceil((TTL_MS - age) / (24 * 60 * 60 * 1000)));
        chrome.action.setBadgeText({ text: "!" });
        chrome.action.setBadgeBackgroundColor({ color: "#e6a817" });
        console.log(`[APW] Sync expiry warning: ${daysLeft} days left`);
    } else {
        chrome.action.setBadgeText({ text: "" });
    }
}

chrome.runtime.onStartup.addListener(checkExpiryBadge);
chrome.runtime.onInstalled.addListener(checkExpiryBadge);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type !== "autoSync") return false;

    getLocalSyncKey().then(syncKey => {
        if (!syncKey) {
            sendResponse({ success: false, reason: "no_key" });
            return;
        }

        syncWatchlist(syncKey)
            .then(count => {
                checkExpiryBadge();
                sendResponse({ success: true, count });
            })
            .catch(err => sendResponse({ success: false, reason: err.message }));
    });

    return true;
});

chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (!changes[STORAGE_KEY]) return;

    clearTimeout(uploadTimeout);

    uploadTimeout = setTimeout(async () => {
        try {
            const syncKey = await getLocalSyncKey();

            if (!syncKey) return;

            await uploadWatchlist(syncKey);
            checkExpiryBadge();
        } catch (err) {
            console.error("Auto-sync failed:", err);
        }
    }, 1500);
});
