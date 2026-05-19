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
const clearDataBtn = document.querySelector("#clearData");
const resetSettingsBtn = document.querySelector("#resetSettings");
const statusEl = document.querySelector("#status");

function setStatus(message) {
    statusEl.textContent = message;

    setTimeout(() => {
        statusEl.textContent = "";
    }, 1800);
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

    const watchingCount = list.filter(item => (item.status || "watching") === "watching").length;
    const planCount = list.filter(item => item.status === "plan").length;

    watchingCountEl.textContent = watchingCount;
    planCountEl.textContent = planCount;

    showCountdownsEl.checked = settings.showCountdowns;
    showBadgesEl.checked = settings.showNewEpisodeBadges;
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

resetSettingsBtn.addEventListener("click", async () => {
    await chrome.storage.local.set({
        [SETTINGS_KEY]: DEFAULT_SETTINGS
    });

    await updatePopup();
    setStatus("Settings reset");
});

clearDataBtn.addEventListener("click", async () => {
    const confirmed = confirm("Clear your saved watchlist? This cannot be undone.");

    if (!confirmed) return;

    await chrome.storage.local.remove([
        "recently_watched",
        "apw_poster_cache",
        "apw_latest_ep_cache",
        "apw_anilist_id_cache",
        "apw_anilist_airing_cache"
    ]);

    await updatePopup();
    setStatus("Saved list cleared");
});

updatePopup();