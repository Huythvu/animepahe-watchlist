console.log("Popup JS loaded");

import {
    generateSyncKey,
    getLocalSyncKey,
    saveLocalSyncKey,
    uploadWatchlist,
    syncWatchlist
} from "./sync.js";

const STORAGE_KEY = "recently_watched";
const SETTINGS_KEY = "apw_settings";

const DEFAULT_SETTINGS = {
    showCountdowns: true,
    showNewEpisodeBadges: true,
    showFilters: true,
    currentFilter: "watching"
};

const watchingCountEl = document.querySelector("#watchingCount");
const planCountEl = document.querySelector("#planCount");
const showCountdownsEl = document.querySelector("#showCountdowns");
const showBadgesEl = document.querySelector("#showBadges");
const statusEl = document.querySelector("#status");

// New sync UI
const createSyncBtn = document.querySelector("#createSync");
const openSyncFormBtn = document.querySelector("#openSyncForm");
const syncForm = document.querySelector("#syncForm");
const syncKeyInput = document.querySelector("#syncKey");
const syncNowBtn = document.querySelector("#syncNow");

// Phrase modal
const phraseModal = document.querySelector("#phraseModal");
const generatedPhraseEl = document.querySelector("#generatedPhrase");
const copyPhraseBtn = document.querySelector("#copyPhrase");
const closePhraseModalBtn = document.querySelector("#closePhraseModal");

let latestGeneratedPhrase = "";
let statusTimeout;

function setStatus(message) {
    statusEl.textContent = message;

    clearTimeout(statusTimeout);

    statusTimeout = setTimeout(() => {
        statusEl.textContent = "";
    }, 5000);
}

function setButtonLoading(button, isLoading, loadingText, normalText) {
    button.disabled = isLoading;
    button.textContent = isLoading ? loadingText : normalText;
}

async function getWatched() {
    const data = await chrome.storage.local.get([STORAGE_KEY]);
    return data[STORAGE_KEY] || [];
}

async function getSettings() {
    const data = await chrome.storage.local.get([SETTINGS_KEY]);

    return {
        ...DEFAULT_SETTINGS,
        ...(data[SETTINGS_KEY] || {})
    };
}

async function saveSettings(settings) {
    const current = await getSettings();

    await chrome.storage.local.set({
        [SETTINGS_KEY]: {
            ...current,
            ...settings
        }
    });
}

async function updatePopup() {
    const list = await getWatched();
    const settings = await getSettings();
    const syncKey = await getLocalSyncKey();

    const watchingCount = list.filter(item => (item.status || "watching") === "watching").length;
    const planCount = list.filter(item => item.status === "plan").length;

    watchingCountEl.textContent = watchingCount;
    planCountEl.textContent = planCount;

    showCountdownsEl.checked = settings.showCountdowns;
    showBadgesEl.checked = settings.showNewEpisodeBadges;

    if (syncKeyInput) {
        syncKeyInput.value = syncKey;
    }
}

showCountdownsEl.addEventListener("change", async () => {
    await saveSettings({
        showCountdowns: showCountdownsEl.checked
    });

    setStatus("Countdown setting saved");
});

showBadgesEl.addEventListener("change", async () => {
    await saveSettings({
        showNewEpisodeBadges: showBadgesEl.checked
    });

    setStatus("Badge setting saved");
});

// Generate phrase + auto upload
createSyncBtn.addEventListener("click", async () => {
    setButtonLoading(createSyncBtn, true, "Creating...", "Generate sync phrase");
    setStatus("Creating sync phrase and uploading watchlist...");

    try {
        const key = generateSyncKey();

        await saveLocalSyncKey(key);

        const count = await uploadWatchlist(key);

        latestGeneratedPhrase = key;
        generatedPhraseEl.textContent = key;
        phraseModal.classList.remove("hidden");

        if (count === 0) {
            setStatus("Sync phrase created. Your watchlist is currently empty.");
        } else {
            setStatus(`Sync phrase created. Uploaded ${count} item${count === 1 ? "" : "s"}.`);
        }
    } catch (err) {
        console.error("Create sync phrase failed:", err);
        setStatus(err.message || "Could not create sync phrase");
    } finally {
        setButtonLoading(createSyncBtn, false, "Creating...", "Generate sync phrase");
    }
});

// Copy generated phrase
copyPhraseBtn.addEventListener("click", async () => {
    try {
        await navigator.clipboard.writeText(latestGeneratedPhrase);

        copyPhraseBtn.textContent = "Copied!";
        setStatus("Sync phrase copied");

        setTimeout(() => {
            copyPhraseBtn.textContent = "Copy phrase";
        }, 1500);
    } catch (err) {
        console.error("Copy phrase failed:", err);
        setStatus("Could not copy phrase");
    }
});

// Close modal
closePhraseModalBtn.addEventListener("click", () => {
    phraseModal.classList.add("hidden");
    copyPhraseBtn.textContent = "Copy phrase";
});

// Show/hide sync form
openSyncFormBtn.addEventListener("click", () => {
    syncForm.classList.toggle("hidden");

    if (!syncForm.classList.contains("hidden")) {
        syncKeyInput.focus();
    }
});

// Sync with pasted phrase
syncNowBtn.addEventListener("click", async () => {
    setButtonLoading(syncNowBtn, true, "Syncing...", "Sync watchlist");
    setStatus("Syncing watchlist...");

    try {
        const key = syncKeyInput.value.trim();

        await saveLocalSyncKey(key);

        const count = await syncWatchlist(key);
await updatePopup();

if (count === 0) {
    setStatus("Synced. The watchlist is empty.");
} else {
    setStatus(`Synced ${count} item${count === 1 ? "" : "s"}. Refreshing page...`);
}

const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
});

if (tab?.id && tab.url?.includes("animepahe.pw")) {
    await chrome.tabs.reload(tab.id);
}
    } catch (err) {
        console.error("Sync failed:", err);
        setStatus(err.message || "Sync failed");
    } finally {
        setButtonLoading(syncNowBtn, false, "Syncing...", "Sync watchlist");
    }
});

updatePopup();