import {
    getLocalSyncKey,
    uploadWatchlist,
    syncWatchlist,
    checkForUpdate,
    dismissUpdate,
    isUpdateDismissed,
    CHROME_STORE_URL
} from "./sync.js";

const STORAGE_KEY = "recently_watched";

let uploadTimeout = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "autoSync") {
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
    }

    if (message.type === "checkUpdate") {
        (async () => {
            try {
                const info = await checkForUpdate();
                const dismissed = info.available ? await isUpdateDismissed(info.latest) : false;
                sendResponse({ ...info, dismissed, storeUrl: CHROME_STORE_URL });
            } catch (err) {
                sendResponse({ available: false, error: err.message });
            }
        })();
        return true;
    }

    if (message.type === "dismissUpdate") {
        dismissUpdate(message.version).then(() => sendResponse({ ok: true }));
        return true;
    }

    return false;
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
        } catch (err) {
            console.error("Auto-sync failed:", err);
        }
    }, 1500);
});
