import {
    generateSyncKey,
    getLocalSyncKey,
    clearLocalSyncKey,
    saveLocalSyncKey,
    validateSyncKey,
    uploadWatchlist,
    syncWatchlist
} from "./sync.js";

const GENERATE_COOLDOWN_KEY = "apw_generate_cooldown";
const GENERATE_COOLDOWN_MS  = 60 * 1000;

const STORAGE_KEY = "recently_watched";
const SETTINGS_KEY = "apw_settings";

const DEFAULT_SETTINGS = {
    widgetEnabled: true
};

const MAX_WATCHING = 20;
const MAX_PLAN = 50;

const PANEL_OPEN_FLAG = "apw_open_panel_on_load";

// Stat elements
const watchingCountEl = document.querySelector("#watchingCount");
const planCountEl = document.querySelector("#planCount");
const watchingCapWarningEl = document.querySelector("#watchingCapWarning");
const planCapWarningEl = document.querySelector("#planCapWarning");
const statusEl = document.querySelector("#status");

// Header pills
const widgetToggle = document.querySelector("#widgetToggle");
const widgetDot = document.querySelector("#widgetDot");
const widgetLabel = document.querySelector("#widgetLabel");

// Open settings
const openSettingsBtn = document.querySelector("#openSettings");

// Sync elements
const createSyncBtn = document.querySelector("#createSync");
const openSyncFormBtn = document.querySelector("#openSyncForm");
const syncForm = document.querySelector("#syncForm");
const syncKeyInput = document.querySelector("#syncKey");
const syncNowBtn = document.querySelector("#syncNow");
const syncError = document.querySelector("#syncError");
const syncHint = document.querySelector("#syncHint");
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

    syncHint.classList.add("hidden");
    syncIdle.classList.add("hidden");
    syncActive.classList.remove("hidden");
}

function showIdleState() {
    syncActive.classList.add("hidden");
    syncHint.classList.remove("hidden");
    syncIdle.classList.remove("hidden");
    syncForm.classList.add("collapsed");
    clearSyncError();
    syncKeyInput.value = "";
}

function updateWidgetPill(enabled) {
    widgetDot.classList.toggle("pill-dot-off", !enabled);
    widgetLabel.textContent = enabled ? "Enabled" : "Disabled";
    widgetToggle.classList.toggle("pill-toggle-off", !enabled);
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
    watchingCapWarningEl.classList.toggle("hidden", watchingCount < MAX_WATCHING);
    planCapWarningEl.classList.toggle("hidden", planCount < MAX_PLAN);

    updateWidgetPill(settings.widgetEnabled !== false);

    if (syncKey) {
        showActiveState(syncKey);
    } else {
        showIdleState();
    }

    await updateGenerateCooldown();
}

// ---------- Generate cooldown ----------

let cooldownInterval = null;

async function updateGenerateCooldown() {
    const data = await chrome.storage.local.get([GENERATE_COOLDOWN_KEY]);
    const cooldownUntil = data[GENERATE_COOLDOWN_KEY] || 0;
    const remaining = cooldownUntil - Date.now();

    if (remaining <= 0) {
        createSyncBtn.disabled = false;
        createSyncBtn.textContent = "Generate sync phrase";
        return;
    }

    const tick = () => {
        const left = Math.ceil((cooldownUntil - Date.now()) / 1000);
        if (left <= 0) {
            createSyncBtn.disabled = false;
            createSyncBtn.textContent = "Generate sync phrase";
            clearInterval(cooldownInterval);
        } else {
            createSyncBtn.disabled = true;
            createSyncBtn.textContent = `Wait ${left}s`;
        }
    };

    tick();
    clearInterval(cooldownInterval);
    cooldownInterval = setInterval(tick, 1000);
}

// ---------- Widget toggle ----------

widgetToggle.addEventListener("click", async () => {
    const settings = await getSettings();
    const newValue = settings.widgetEnabled === false ? true : false;
    await saveSettings({ widgetEnabled: newValue });
    updateWidgetPill(newValue);
});

// ---------- Open settings ----------

openSettingsBtn.addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (tab?.id && tab.url?.includes("animepahe.pw")) {
        try {
            await chrome.tabs.sendMessage(tab.id, { type: "openSettingsPanel" });
        } catch {}
        window.close();
        return;
    }

    await chrome.storage.local.set({ [PANEL_OPEN_FLAG]: true });
    await chrome.tabs.create({ url: "https://animepahe.pw/" });
    window.close();
});

// ---------- Sync ----------

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
    syncForm.classList.toggle("collapsed");
    clearSyncError();

    if (!syncForm.classList.contains("collapsed")) {
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
        const count = await syncWatchlist(key);
        await saveLocalSyncKey(key);
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
    await chrome.storage.local.set({ [GENERATE_COOLDOWN_KEY]: Date.now() + GENERATE_COOLDOWN_MS });
    showIdleState();
    setStatus("Disconnected.");
    updateGenerateCooldown();
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
