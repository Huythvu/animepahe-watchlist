import { getLocalSyncKey, uploadWatchlist, syncWatchlist } from "./sync.js";

const STORAGE_KEY = "recently_watched";

let uploadTimeout = null;

console.log("Background service worker loaded");

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

    return true; // keep message channel open for async response
});

chrome.storage.onChanged.addListener((changes, areaName) => {
    console.log("Storage changed:", changes, areaName);

    if (areaName !== "local") return;

    if (!changes[STORAGE_KEY]) {
        console.log("Change was not recently_watched");
        return;
    }

    console.log("recently_watched changed, preparing auto-sync");

    clearTimeout(uploadTimeout);

    uploadTimeout = setTimeout(async () => {
        try {
            const syncKey = await getLocalSyncKey();

            console.log("Saved sync phrase:", syncKey);

            if (!syncKey) {
                console.log("Auto-sync skipped: no sync phrase saved");
                return;
            }

            const count = await uploadWatchlist(syncKey);
            console.log(`Auto-synced ${count} items`);
        } catch (err) {
            console.error("Auto-sync failed:", err);
        }
    }, 1500);
});