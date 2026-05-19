console.log("Popup JS loaded");

import {
    generateSyncKey,
    getLocalSyncKey,
    clearLocalSyncKey,
    saveLocalSyncKey,
    validateSyncKey,
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

const MAX_ITEMS = 30;

const watchingCountEl = document.querySelector("#watchingCount");
const planCountEl = document.querySelector("#planCount");
const capWarningEl = document.querySelector("#capWarning");
const showCountdownsEl = document.querySelector("#showCountdowns");
const showBadgesEl = document.querySelector("#showBadges");
const statusEl = document.querySelector("#status");

const createSyncBtn = document.querySelector("#createSync");
const openSyncFormBtn = document.querySelector("#openSyncForm");
const syncForm = document.querySelector("#syncForm");
const syncKeyInput = document.querySelector("#syncKey");
const syncNowBtn = document.querySelector("#syncNow");
const syncError = document.querySelector("#syncError");

const syncIdle = document.querySelector("#syncIdle");
const syncActive = document.querySelector("#syncActive");
const phraseWordsEl = document.querySelector("#phraseWords");
const copyPhraseBtn = document.querySelector("#copyPhrase");
const disconnectBtn = document.querySelector("#disconnectSync");

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

function showSyncError(message) {
    syncError.textContent = message;
    syncError.classList.remove("hidden");
}

function clearSyncError() {
    syncError.textContent = "";
    syncError.classList.add("hidden");
}

function showActiveState(phrase) {
    const words = phrase.trim().split(/\s+/);

    phraseWordsEl.innerHTML = "";

    words.forEach((word, i) => {
        const span = document.createElement("span");
        span.className = "phrase-word";
        span.textContent = word;
        span.style.animationDelay = `${i * 0.06}s`;
        phraseWordsEl.appendChild(span);
    });

    syncIdle.classList.add("hidden");
    syncActive.classList.remove("hidden");
}

function showIdleState() {
    syncActive.classList.add("hidden");
    syncIdle.classList.remove("hidden");
    syncForm.classList.add("hidden");
    clearSyncError();
    syncKeyInput.value = "";
}

async function getWatched() {
    const data = await chrome.storage.local.get([STORAGE_KEY]);
    return data[STORAGE_KEY] || [];
}

async function getSettings() {
    const data = await chrome.storage.local.get([SETTINGS_KEY]);
    return { ...DEFAULT_SETTINGS, ...(data[SETTINGS_KEY] || {}) };
}

async function saveSettings(settings) {
    const current = await getSettings();
    await chrome.storage.local.set({ [SETTINGS_KEY]: { ...current, ...settings } });
}

async function updatePopup() {
    const list = await getWatched();
    const settings = await getSettings();
    const syncKey = await getLocalSyncKey();

    const watchingCount = list.filter(item => (item.status || "watching") === "watching").length;
    const planCount = list.filter(item => item.status === "plan").length;

    watchingCountEl.textContent = watchingCount;
    planCountEl.textContent = planCount;
    capWarningEl.classList.toggle("hidden", list.length < MAX_ITEMS);

    showCountdownsEl.checked = settings.showCountdowns;
    showBadgesEl.checked = settings.showNewEpisodeBadges;

    if (syncKey) {
        showActiveState(syncKey);
    } else {
        showIdleState();
    }
}

showCountdownsEl.addEventListener("change", async () => {
    await saveSettings({ showCountdowns: showCountdownsEl.checked });
    setStatus("Countdown setting saved");
});

showBadgesEl.addEventListener("change", async () => {
    await saveSettings({ showNewEpisodeBadges: showBadgesEl.checked });
    setStatus("Badge setting saved");
});

createSyncBtn.addEventListener("click", async () => {
    setButtonLoading(createSyncBtn, true, "Generating...", "Generate sync phrase");

    try {
        const key = generateSyncKey();
        await saveLocalSyncKey(key);
        await uploadWatchlist(key);
        showActiveState(key);
        setStatus("Sync phrase generated.");
    } catch (err) {
        console.error("Generate failed:", err);
        setStatus(err.message || "Could not generate sync phrase");
    } finally {
        setButtonLoading(createSyncBtn, false, "Generating...", "Generate sync phrase");
    }
});

openSyncFormBtn.addEventListener("click", () => {
    syncForm.classList.toggle("hidden");
    clearSyncError();

    if (!syncForm.classList.contains("hidden")) {
        syncKeyInput.focus();
    }
});

syncKeyInput.addEventListener("input", clearSyncError);

syncNowBtn.addEventListener("click", async () => {
    const key = syncKeyInput.value.trim();

    const error = validateSyncKey(key);

    if (error) {
        showSyncError(error);
        return;
    }

    setButtonLoading(syncNowBtn, true, "Syncing...", "Connect");
    clearSyncError();

    try {
        await saveLocalSyncKey(key);
        const count = await syncWatchlist(key);
        await updatePopup();

        if (count === 0) {
            setStatus("Synced. The watchlist is empty.");
        } else {
            setStatus(`Synced ${count} item${count === 1 ? "" : "s"}.`);
        }

        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

        if (tab?.id && tab.url?.includes("animepahe.pw")) {
            await chrome.tabs.reload(tab.id);
        }
    } catch (err) {
        console.error("Sync failed:", err);
        setStatus(err.message || "Sync failed");
    } finally {
        setButtonLoading(syncNowBtn, false, "Syncing...", "Connect");
    }
});

disconnectBtn.addEventListener("click", async () => {
    await clearLocalSyncKey();
    showIdleState();
    setStatus("Disconnected.");
});

copyPhraseBtn.addEventListener("click", async () => {
    const phrase = Array.from(phraseWordsEl.querySelectorAll(".phrase-word"))
        .map(el => el.textContent)
        .join(" ");

    try {
        await navigator.clipboard.writeText(phrase);
        copyPhraseBtn.textContent = "Copied!";
        setTimeout(() => { copyPhraseBtn.textContent = "Copy phrase"; }, 1500);
    } catch (err) {
        setStatus("Could not copy phrase");
    }
});

updatePopup();
