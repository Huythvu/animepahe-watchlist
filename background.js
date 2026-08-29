import { getLocalSyncKey, mergeUpload, syncWatchlist } from "./sync.js";

const STORAGE_KEY = "recently_watched";

let uploadTimeout = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type !== "autoSync") return false;

    getLocalSyncKey().then(syncKey => {
        if (!syncKey) {
            sendResponse({ success: false, reason: "no_key" });
            return;
        }

        syncWatchlist(syncKey)
            .then(count => sendResponse({ success: true, count }))
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
            // Merge cloud in before pushing, so cloud-only entries (e.g. pushed from NyanTV) aren't
            // overwritten by our local list.
            await mergeUpload(syncKey);
        } catch (err) {
            console.error("Auto-sync failed:", err);
        }
    }, 1500);
});
