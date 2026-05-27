const STORAGE_KEY = "recently_watched";
const POSTER_CACHE_KEY = "apw_poster_cache";
const LATEST_EP_CACHE_KEY = "apw_latest_ep_cache";
const ANILIST_ID_CACHE_KEY = "apw_anilist_id_cache";
const ANILIST_AIRING_CACHE_KEY = "apw_anilist_airing_cache";
const SETTINGS_KEY = "apw_settings";

const ANILIST_AIRING_TTL_MS = 60 * 60 * 1000;
const LATEST_EP_CACHE_TTL_MS = 30 * 60 * 1000;

const MAX_WATCHING = 20;
const MAX_PLAN = 50;
const VISIBLE_ITEMS = 6;
const CARD_WIDTH = 180;
const CARD_GAP = 17;
const PEEK_AMOUNT = 60;

const DEFAULT_SETTINGS = {
    showCountdowns: true,
    showNewEpisodeBadges: true,
    showFilters: true,
    currentFilter: "watching",
    widgetEnabled: true,
    cardAlignment: "center",
    showEpisodeNumber: true,
    showLastWatched: true,
    showProgress: true
};

let countdownTargets = new Map();
let countdownInterval = null;

// ---------- Storage helpers ----------
async function storageGet(key, fallback) {
    const data = await chrome.storage.local.get([key]);
    return data[key] ?? fallback;
}

async function storageSet(key, value) {
    await chrome.storage.local.set({ [key]: value });
}

async function getWatched() {
    return await storageGet(STORAGE_KEY, []);
}

async function saveWatched(list) {
    await storageSet(STORAGE_KEY, list);
}

async function getPosterCache() {
    return await storageGet(POSTER_CACHE_KEY, {});
}

async function savePosterCache(cache) {
    await storageSet(POSTER_CACHE_KEY, cache);
}

async function getSettings() {
    const settings = {
        ...DEFAULT_SETTINGS,
        ...(await storageGet(SETTINGS_KEY, {}))
    };

    if (!["watching", "plan"].includes(settings.currentFilter)) {
        settings.currentFilter = "watching";
    }

    return settings;
}

async function saveSettings(settings) {
    await storageSet(SETTINGS_KEY, {
        ...(await getSettings()),
        ...settings
    });
}

// ---------- Page detection ----------
const path = window.location.pathname;
const isPlayPage = path.startsWith("/play/");
const isHomePage = path === "/" || path === "";

// ---------- Relative time / countdown ----------
function relativeTime(ts) {
    if (!ts) return "";

    const diff = Date.now() - ts;
    const s = Math.floor(diff / 1000);

    if (s < 60) return "just now";

    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;

    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;

    const d = Math.floor(h / 24);
    if (d === 1) return "yesterday";
    if (d < 7) return `${d}d ago`;

    const w = Math.floor(d / 7);
    if (w < 5) return `${w}w ago`;

    const mo = Math.floor(d / 30);
    if (mo < 12) return `${mo}mo ago`;

    return `${Math.floor(d / 365)}y ago`;
}

function countdownText(targetMs) {
    const diff = targetMs - Date.now();

    if (diff <= 0) return "airing now";

    const s = Math.floor(diff / 1000);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);

    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;

    return `${m}m`;
}

// ---------- Save watched episode ----------
async function saveCurrentEpisode() {
    const titleTag = document.title || "";
    const match = titleTag.match(/^(.+?) Ep\.\s*(\S+)\s*::/);

    if (!match) return false;

    const animeTitle = match[1].trim();
    const episode = match[2].trim();

    const animeLink = document.querySelector('a[href^="/anime/"]');
    const animeHref = animeLink ? animeLink.getAttribute("href") : null;

    if (!animeHref) return false;

    const existingList = await getWatched();
    let existingEntry = existingList.find(item => item.animeUrl === animeHref);

    if (!existingEntry) {
        existingEntry = existingList.find(item => item.title === animeTitle);
    }

    if (!existingEntry) {
        const watchingCount = existingList.filter(item => (item.status || "watching") === "watching").length;

        if (watchingCount >= MAX_WATCHING) return false;
    }

    const entry = {
        title: animeTitle,
        episode,
        playUrl: window.location.pathname,
        animeUrl: animeHref,
        thumb: existingEntry?.thumb || "",
        ts: Date.now(),
        status: existingEntry?.status || "watching",
        statusTs: existingEntry?.statusTs || Date.now()
    };

    if (existingEntry?.animeId) entry.animeId = existingEntry.animeId;

    let list = existingList.filter(item =>
        item !== existingEntry && item.animeUrl !== entry.animeUrl
    );
    list.unshift(entry);

    await saveWatched(list);

    fetchPoster(location.origin + animeHref).then(async poster => {
        if (!poster) return;

        const updated = await getWatched();
        const idx = updated.findIndex(item => item.animeUrl === entry.animeUrl);

        if (idx !== -1) {
            updated[idx].thumb = poster;
            await saveWatched(updated);
        }
    });

    return true;
}

function trySaveWithRetry() {
    let attempts = 0;

    const run = async () => {
        attempts++;

        const saved = await saveCurrentEpisode();

        if (saved || attempts >= 10) {
            clearInterval(intervalId);
        }
    };

    const intervalId = setInterval(run, 500);
    run();
}

// ---------- Poster fetching ----------
async function fetchPoster(animeUrl) {
    if (!animeUrl) return "";

    const cache = await getPosterCache();
    if (cache[animeUrl]) return cache[animeUrl];

    try {
        const res = await fetch(animeUrl, { credentials: "same-origin" });
        const html = await res.text();
        const doc = new DOMParser().parseFromString(html, "text/html");

        let poster = "";

        const ogImg = doc.querySelector('meta[property="og:image"]');
        if (ogImg && !ogImg.content.includes("<?php")) {
            poster = ogImg.content;
        }

        if (!poster) {
            const posterImg = doc.querySelector(".anime-poster img, .anime-info img, header img.cover");
            if (posterImg) {
                poster = posterImg.getAttribute("data-src") || posterImg.getAttribute("src") || "";
            }
        }

        if (poster) {
            cache[animeUrl] = poster;
            await savePosterCache(cache);
        }

        return poster;
    } catch (err) {
        console.warn("[APW] Poster fetch failed:", err);
        return "";
    }
}

// ---------- AniList ----------
async function anilistRequest(query, variables) {
    const res = await fetch("https://graphql.anilist.co", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Accept": "application/json"
        },
        body: JSON.stringify({ query, variables })
    });

    const json = await res.json();

    if (json.errors) {
        throw json.errors;
    }

    return json.data;
}

async function lookupAniListId(animeTitle) {
    const query = `
        query ($search: String) {
            Media(search: $search, type: ANIME) {
                id
                title {
                    romaji
                    english
                    native
                }
            }
        }
    `;

    const data = await anilistRequest(query, { search: animeTitle });
    return data && data.Media ? data.Media.id : null;
}

async function fetchAiringInfo(anilistId) {
    const query = `
        query ($id: Int) {
            Media(id: $id, type: ANIME) {
                id
                nextAiringEpisode {
                    airingAt
                    episode
                    timeUntilAiring
                }
                status
            }
        }
    `;

    const data = await anilistRequest(query, { id: anilistId });
    return data && data.Media ? data.Media : null;
}

async function getCountdownForEntry(entry) {
    const idCache = await storageGet(ANILIST_ID_CACHE_KEY, {});
    const airingCache = await storageGet(ANILIST_AIRING_CACHE_KEY, {});
    const now = Date.now();

    let anilistId = idCache[entry.animeUrl];

    if (anilistId === undefined) {
        try {
            anilistId = await lookupAniListId(entry.title);
        } catch (err) {
            console.warn("[APW] AniList ID lookup failed:", entry.title, err);
            anilistId = null;
        }

        idCache[entry.animeUrl] = anilistId;
        await storageSet(ANILIST_ID_CACHE_KEY, idCache);
    }

    if (!anilistId) return null;

    const cached = airingCache[anilistId];

    if (cached && now - cached.ts < ANILIST_AIRING_TTL_MS) {
        return cached.airingAt ? cached.airingAt * 1000 : null;
    }

    try {
        const info = await fetchAiringInfo(anilistId);
        const airingAt = info?.nextAiringEpisode?.airingAt || null;

        airingCache[anilistId] = { airingAt, ts: now };
        await storageSet(ANILIST_AIRING_CACHE_KEY, airingCache);

        return airingAt ? airingAt * 1000 : null;
    } catch (err) {
        console.warn("[APW] Airing fetch failed:", entry.title, err);
        return null;
    }
}

// ---------- URL resolution ----------
const resolvedAnimeCache = new Map();

async function searchAnimepahe(title) {
    const res = await fetch(`/api?m=search&q=${encodeURIComponent(title)}`, {
        credentials: "same-origin",
        headers: { "Accept": "application/json" }
    });
    if (!res.ok) throw new Error("Search request failed");
    const data = await res.json();
    return Array.isArray(data?.data) ? data.data : [];
}

async function fetchEpisodeList(animeSession, episodeNumber) {
    const page = Math.max(1, Math.ceil(parseFloat(episodeNumber) / 30));
    const res = await fetch(`/api?m=release&id=${encodeURIComponent(animeSession)}&sort=episode_asc&page=${page}`, {
        credentials: "same-origin",
        headers: { "Accept": "application/json" }
    });
    if (!res.ok) throw new Error("Release request failed");
    const data = await res.json();
    return Array.isArray(data?.data) ? data.data : [];
}

async function updateEntryAnimeId(animeUrl, animeId) {
    const list = await getWatched();
    const idx = list.findIndex(item => item.animeUrl === animeUrl);
    if (idx === -1 || list[idx].animeId === animeId) return;
    list[idx].animeId = animeId;
    await saveWatched(list);
}

async function resolveFreshUrl(entry, type) {
    const cacheKey = entry.animeId ?? entry.title;
    let cached = resolvedAnimeCache.get(cacheKey);

    if (!cached) {
        const results = await searchAnimepahe(entry.title);
        if (!results.length) throw new Error("Anime not found in search");

        const match = entry.animeId
            ? results.find(a => a.id === entry.animeId)
            : results[0];

        if (!match) throw new Error("Anime not found in search");

        cached = { session: match.session, id: match.id, episodes: new Map() };
        resolvedAnimeCache.set(cacheKey, cached);
        resolvedAnimeCache.set(match.id, cached);

        if (!entry.animeId) {
            updateEntryAnimeId(entry.animeUrl, match.id).catch(() => {});
        }
    }

    if (type === "anime") {
        return `/anime/${cached.session}`;
    }

    const epNum = parseFloat(entry.episode);
    if (isNaN(epNum)) throw new Error("Invalid episode number");

    if (!cached.episodes.has(epNum)) {
        const episodes = await fetchEpisodeList(cached.session, epNum);
        episodes.forEach(ep => {
            const n = parseFloat(ep.episode);
            if (!isNaN(n)) cached.episodes.set(n, ep.session);
        });
    }

    const epSession = cached.episodes.get(epNum);
    if (!epSession) throw new Error("Episode not found on site");

    return `/play/${cached.session}/${epSession}`;
}

// ---------- Styles ----------
function injectStyles() {
    if (document.querySelector("#apw-styles")) return;

    const viewportWidth = (CARD_WIDTH * VISIBLE_ITEMS) + (CARD_GAP * (VISIBLE_ITEMS - 1)) + CARD_GAP + PEEK_AMOUNT;

    const style = document.createElement("style");
    style.id = "apw-styles";

    style.textContent = `
        #animepahe-watchlist {
            margin-bottom: 2rem;
            display: flex;
            flex-direction: column;
            align-items: center;
        }

        .apw-header {
            width: 100%;
            max-width: ${viewportWidth}px;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 0.6rem;
            margin-bottom: 0.75rem;
            position: relative;
        }

        .apw-header h2 {
            margin: 0;
            font-size: 1.7rem;
            text-align: center;
        }

        .apw-settings-gear-header {
            background: transparent;
            border: none;
            color: rgba(255, 255, 255, 0.45);
            cursor: pointer;
            padding: 4px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            border-radius: 6px;
            transition: color 0.15s, background 0.15s;
        }

        .apw-settings-gear-header:hover {
            color: #fff;
            background: rgba(255, 255, 255, 0.06);
        }

        .apw-settings-tab-btn {
            border: 1px solid rgba(255,255,255,0.14);
            background: rgba(255,255,255,0.04);
            color: inherit;
            border-radius: 999px;
            padding: 5px 11px;
            font-size: 0.78em;
            font-family: inherit;
            cursor: pointer;
            opacity: 0.75;
            transition: background 0.15s, opacity 0.15s, border-color 0.15s;
        }

        .apw-settings-tab-btn:hover {
            opacity: 1;
            background: rgba(255,255,255,0.08);
        }

        .apw-controls {
            width: 100%;
            max-width: ${viewportWidth}px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 1rem;
            margin-bottom: 0.9rem;
        }

        .apw-tabs {
            display: flex;
            align-items: center;
            gap: 6px;
            flex-wrap: wrap;
        }

        .apw-tab {
            border: 1px solid rgba(255,255,255,0.14);
            background: rgba(255,255,255,0.04);
            color: inherit;
            border-radius: 999px;
            padding: 5px 11px;
            font-size: 0.78em;
            cursor: pointer;
            opacity: 0.75;
            transition: background 0.15s, opacity 0.15s, border-color 0.15s;
        }

        .apw-tab:hover {
            opacity: 1;
            background: rgba(255,255,255,0.08);
        }

        .apw-tab.apw-active {
            opacity: 1;
            background: rgba(108, 182, 255, 0.16);
            border-color: rgba(108, 182, 255, 0.45);
            color: #9cccff;
        }

        .apw-tab-count {
            margin-left: 4px;
            opacity: 0.7;
            font-size: 0.9em;
        }

        .apw-meta {
            font-size: 0.78em;
            opacity: 0.6;
            white-space: nowrap;
        }

        .apw-meta-capped {
            opacity: 1;
            color: rgba(255, 200, 80, 0.85);
        }

        .apw-body {
            width: 100%;
            display: flex;
            justify-content: center;
        }

        .apw-slider-wrap {
            position: relative;
            width: 100%;
            max-width: ${viewportWidth}px;
        }

        .apw-viewport {
            overflow: hidden;
            width: 100%;
        }

        .apw-list {
            display: flex;
            flex-wrap: nowrap;
            gap: ${CARD_GAP}px;
            overflow-x: auto;
            scroll-behavior: smooth;
            scrollbar-width: none;
            -ms-overflow-style: none;
            padding-bottom: 8px;
            cursor: grab;
            user-select: none;
        }

        .apw-list::-webkit-scrollbar {
            display: none;
        }

        .apw-list.apw-dragging {
            cursor: grabbing;
            scroll-behavior: auto;
        }

        .apw-list.apw-centered.apw-align-center { justify-content: center; }
        .apw-list.apw-centered.apw-align-right  { justify-content: flex-end; }

        #animepahe-watchlist.apw-hide-badges .apw-new-badge   { display: none; }
        #animepahe-watchlist.apw-hide-airing .apw-airing-badge { display: none; }
        #animepahe-watchlist.apw-hide-episode .apw-episode-text { display: none; }
        #animepahe-watchlist.apw-hide-when .apw-when           { display: none; }
        #animepahe-watchlist.apw-hide-progress .apw-progress   { display: none; }

        .apw-list a,
        .apw-list img {
            -webkit-user-drag: none;
            user-drag: none;
        }

        .apw-wrap {
            flex: 0 0 ${CARD_WIDTH}px;
            width: ${CARD_WIDTH}px;
            box-sizing: border-box;
            position: relative;
        }

        .apw-episode {
            position: relative;
        }

        .apw-snapshot {
            position: relative;
            overflow: hidden;
            aspect-ratio: 2 / 3;
            background: #222;
            border-radius: 6px;
            transition: transform 0.25s ease, box-shadow 0.25s ease;
        }

        .apw-snapshot:hover {
            transform: translateY(-5px);
            box-shadow: 0 8px 16px rgba(0, 0, 0, 0.4);
        }

        .apw-snapshot img {
            width: 100%;
            height: 100%;
            display: block;
            object-fit: cover;
            transition: opacity 0.2s;
            pointer-events: none;
        }

        .apw-snapshot.apw-loading {
            background: linear-gradient(90deg, #202020, #2f2f2f, #202020);
            background-size: 200% 100%;
            animation: apw-shimmer 1.5s infinite linear;
        }

        .apw-snapshot.apw-loading img {
            opacity: 0;
        }

        @keyframes apw-shimmer {
            from { background-position: 200% 0; }
            to { background-position: -200% 0; }
        }

        .apw-play-link {
            position: absolute;
            inset: 0;
            text-indent: -9999px;
            overflow: hidden;
        }

        .apw-remove {
            position: absolute;
            top: 6px;
            right: 6px;
            z-index: 5;
            width: 24px;
            height: 24px;
            border: none;
            border-radius: 50%;
            background: rgba(0, 0, 0, 0.7);
            color: #fff;
            font-size: 15px;
            line-height: 1;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            opacity: 0;
            transition: opacity 0.15s, background 0.15s;
            padding: 0;
        }

        .apw-wrap:hover .apw-remove {
            opacity: 1;
        }

        .apw-remove:hover {
            background: rgba(200, 0, 0, 0.9);
        }

        .apw-status-toggle {
            position: absolute;
            top: 36px;
            right: 6px;
            z-index: 5;
            border: none;
            border-radius: 999px;
            background: rgba(0, 0, 0, 0.7);
            color: #fff;
            font-size: 0.68em;
            font-weight: 700;
            cursor: pointer;
            padding: 4px 7px;
            opacity: 0;
            transition: opacity 0.15s, background 0.15s;
        }

        .apw-wrap:hover .apw-status-toggle {
            opacity: 1;
        }

        .apw-status-toggle:hover {
            background: rgba(108, 182, 255, 0.85);
        }

        .apw-badge-stack {
            position: absolute;
            top: 6px;
            left: 6px;
            z-index: 4;
            display: flex;
            flex-direction: column;
            align-items: flex-start;
            gap: 4px;
        }

        .apw-new-badge,
        .apw-airing-badge {
            padding: 2px 7px;
            font-size: 0.7em;
            font-weight: 700;
            color: #fff;
            border-radius: 3px;
            letter-spacing: 0.02em;
            box-shadow: 0 1px 3px rgba(0,0,0,0.4);
        }

        .apw-new-badge {
            background: #d9534f;
        }

        .apw-airing-badge {
            background: rgba(0, 0, 0, 0.75);
            color: #9cccff;
        }

        .apw-label-wrap {
            padding-top: 8px;
            text-align: center;
        }

        .apw-title {
            font-size: 1em;
            font-weight: 500;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            margin-bottom: 5px;
        }

        .apw-title a {
            color: inherit;
            text-decoration: none;
        }

        .apw-title a:hover {
            text-decoration: underline;
        }

        .apw-episode-text,
        .apw-plan-text {
            font-size: 0.82em;
            font-weight: 600;
            color: #9cccff;
            margin-bottom: 2px;
        }

        .apw-progress {
            font-size: 0.74em;
            opacity: 0.62;
            margin-top: 2px;
        }

        .apw-when {
            font-size: 0.72em;
            opacity: 0.55;
            margin-top: 2px;
        }

        .apw-progress:empty {
            display: none;
        }

        .apw-arrow {
            position: absolute;
            top: 0;
            bottom: 58px;
            width: 42px;
            border: none;
            background: rgba(0, 0, 0, 0.55);
            color: #fff;
            cursor: pointer;
            font-size: 26px;
            line-height: 1;
            z-index: 10;
            display: flex;
            align-items: center;
            justify-content: center;
            opacity: 0;
            transition: opacity 0.15s, background 0.15s;
            padding: 0;
        }

        .apw-slider-wrap:hover .apw-arrow:not([disabled]) {
            opacity: 1;
        }

        .apw-arrow:hover {
            background: rgba(0, 0, 0, 0.8);
        }

        .apw-arrow[disabled] {
            opacity: 0 !important;
            pointer-events: none;
        }

        .apw-arrow-left {
            left: 0;
            border-radius: 0 4px 4px 0;
        }

        .apw-arrow-right {
            right: 0;
            border-radius: 4px 0 0 4px;
        }

        .apw-empty,
        .apw-filter-empty {
            width: 100%;
            max-width: ${viewportWidth}px;
            text-align: center;
            padding: 1.6rem 1rem;
            opacity: 0.72;
            border: 1px dashed rgba(255,255,255,0.12);
            border-radius: 8px;
            background: rgba(255,255,255,0.03);
        }

        .apw-filter-empty {
            margin-top: 0.5rem;
        }

        .apw-empty-title,
        .apw-filter-empty-title {
            font-size: 1em;
            font-weight: 700;
            margin-bottom: 4px;
        }

        .apw-empty-text,
        .apw-filter-empty-text {
            font-size: 0.86em;
            opacity: 0.75;
        }

        .apw-hidden {
            display: none !important;
        }

        .apw-toast {
            display: none;
            width: 100%;
            max-width: ${viewportWidth}px;
            margin-bottom: 8px;
            padding: 7px 14px;
            border-radius: 8px;
            background: rgba(255, 180, 0, 0.08);
            border: 1px solid rgba(255, 180, 0, 0.22);
            color: rgba(255, 200, 80, 0.9);
            font-size: 0.82em;
            text-align: center;
        }

        .apw-toast.apw-toast-visible {
            display: block;
        }

        .apw-wrap.apw-resolving {
            opacity: 0.6;
            pointer-events: none;
            transition: opacity 0.12s ease;
        }
    `;

    document.head.appendChild(style);
}

// ---------- UI helpers ----------
function buildPlaceholder() {
    return `
        <div class="apw-empty">
            <div class="apw-empty-title">No anime saved yet.</div>
            <div class="apw-empty-text">Watch an episode and it will appear here automatically.</div>
        </div>
    `;
}

async function buildControls(list) {
    const settings = await getSettings();

    if (!settings.showFilters) {
        return "";
    }

    const watchingCount = list.filter(item => (item.status || "watching") === "watching").length;
    const planCount = list.filter(item => item.status === "plan").length;

    return `
        <div class="apw-controls">
            <div class="apw-tabs" aria-label="Anime list filters">
                <button class="apw-tab ${settings.currentFilter === "watching" ? "apw-active" : ""}" data-filter="watching">
                    Currently Watching <span class="apw-tab-count">${watchingCount}</span>
                </button>

                <button class="apw-tab ${settings.currentFilter === "plan" ? "apw-active" : ""}" data-filter="plan">
                    Plan to Watch <span class="apw-tab-count">${planCount}</span>
                </button>

                <button class="apw-settings-gear apw-settings-tab-btn" aria-label="Open settings">Settings</button>
            </div>

            <div class="apw-meta"></div>
        </div>
    `;
}

async function updateTabCounts() {
    const list = await getWatched();

    const watchingCount = list.filter(item => (item.status || "watching") === "watching").length;
    const planCount = list.filter(item => item.status === "plan").length;

    const watchingTab = document.querySelector('.apw-tab[data-filter="watching"] .apw-tab-count');
    const planTab = document.querySelector('.apw-tab[data-filter="plan"] .apw-tab-count');

    if (watchingTab) watchingTab.textContent = watchingCount;
    if (planTab) planTab.textContent = planCount;
}

function updateArrows() {
    const list = document.querySelector("#animepahe-watchlist .apw-list");
    const leftBtn = document.querySelector("#animepahe-watchlist .apw-arrow-left");
    const rightBtn = document.querySelector("#animepahe-watchlist .apw-arrow-right");

    if (!list || !leftBtn || !rightBtn) return;

    const overflowing = list.scrollWidth > list.clientWidth + 1;
    list.classList.toggle("apw-centered", !overflowing);

    if (!overflowing) {
        leftBtn.disabled = true;
        rightBtn.disabled = true;
        return;
    }

    leftBtn.disabled = list.scrollLeft <= 0;
    rightBtn.disabled = list.scrollLeft >= list.scrollWidth - list.clientWidth - 1;
}

async function updateMeta() {
    const meta = document.querySelector("#animepahe-watchlist .apw-meta");
    if (!meta) return;

    const visibleCards = document.querySelectorAll("#animepahe-watchlist .apw-wrap:not(.apw-hidden)").length;

    if (!visibleCards) {
        meta.textContent = "";
        meta.classList.remove("apw-meta-capped");
        return;
    }

    const settings = await getSettings();
    const cap = settings.currentFilter === "plan" ? MAX_PLAN : MAX_WATCHING;

    if (visibleCards >= cap) {
        meta.textContent = `${visibleCards}/${cap} · Capped`;
        meta.classList.add("apw-meta-capped");
    } else {
        meta.textContent = `${visibleCards} shown`;
        meta.classList.remove("apw-meta-capped");
    }
}

async function applyAlignment() {
    const list = document.querySelector("#animepahe-watchlist .apw-list");
    if (!list) return;
    const settings = await getSettings();
    list.classList.remove("apw-align-left", "apw-align-center", "apw-align-right");
    list.classList.add(`apw-align-${settings.cardAlignment || "center"}`);
    updateArrows();
}

async function applySettingsClasses() {
    const section = document.querySelector("#animepahe-watchlist");
    if (!section) return;
    const settings = await getSettings();
    section.classList.toggle("apw-hide-badges", !settings.showNewEpisodeBadges);
    section.classList.toggle("apw-hide-airing", !settings.showCountdowns);
    section.classList.toggle("apw-hide-episode", settings.showEpisodeNumber === false);
    section.classList.toggle("apw-hide-when", settings.showLastWatched === false);
    section.classList.toggle("apw-hide-progress", settings.showProgress === false);
}

function enableDragScroll(slider) {
    let isDown = false;
    let startX = 0;
    let startScroll = 0;
    let dragged = false;
    let suppressNextClick = false;

    slider.addEventListener("mousedown", e => {
        if (e.target.closest(".apw-remove, .apw-arrow, .apw-status-toggle")) return;

        e.preventDefault();

        isDown = true;
        dragged = false;
        startX = e.pageX - slider.offsetLeft;
        startScroll = slider.scrollLeft;

        slider.classList.add("apw-dragging");
    });

    const endDrag = () => {
        if (!isDown) return;

        isDown = false;
        slider.classList.remove("apw-dragging");

        if (dragged) suppressNextClick = true;
    };

    slider.addEventListener("mouseup", endDrag);
    slider.addEventListener("mouseleave", endDrag);

    slider.addEventListener("mousemove", e => {
        if (!isDown) return;

        e.preventDefault();

        const x = e.pageX - slider.offsetLeft;
        const walk = x - startX;

        if (Math.abs(walk) > 5) dragged = true;

        slider.scrollLeft = startScroll - walk;
    });

    slider.addEventListener("click", e => {
        if (suppressNextClick) {
            e.preventDefault();
            e.stopPropagation();
            suppressNextClick = false;
        }
    }, true);

    slider.addEventListener("dragstart", e => e.preventDefault());
}

async function applyFilters() {
    const settings = await getSettings();

    const list = document.querySelector("#animepahe-watchlist .apw-list");
    const emptyState = document.querySelector("#animepahe-watchlist .apw-filter-empty");
    const emptyTitle = document.querySelector("#animepahe-watchlist .apw-filter-empty-title");
    const emptyText = document.querySelector("#animepahe-watchlist .apw-filter-empty-text");

    if (!list) return;

    const cards = Array.from(list.querySelectorAll(".apw-wrap"));
    let visibleCount = 0;

    cards.forEach(card => {
        const status = card.dataset.status || "watching";
        const shouldShow = status === settings.currentFilter;

        card.classList.toggle("apw-hidden", !shouldShow);

        if (shouldShow) visibleCount++;
    });

    if (emptyState && emptyTitle && emptyText) {
        const isEmpty = visibleCount === 0;

        emptyState.classList.toggle("apw-hidden", !isEmpty);

        if (isEmpty && settings.currentFilter === "plan") {
            emptyTitle.textContent = "No anime in Plan to Watch yet.";
            emptyText.textContent = "Move an anime here with the + Plan button.";
        }

        if (isEmpty && settings.currentFilter === "watching") {
            emptyTitle.textContent = "No anime currently watching.";
            emptyText.textContent = "Move an anime back here with the ▶ Watch button.";
        }
    }

    requestAnimationFrame(() => {
        updateArrows();
        updateMeta();
        updateTabCounts();
    });
}

// ---------- Status / remove ----------
async function removeEntry(animeUrl) {
    const list = (await getWatched()).filter(item => item.animeUrl !== animeUrl);
    await saveWatched(list);

    const el = document.querySelector(`#animepahe-watchlist .apw-wrap[data-anime="${cssEscape(animeUrl)}"]`);
    if (el) el.remove();

    if (!list.length) {
        const body = document.querySelector("#animepahe-watchlist .apw-body");
        if (body) body.innerHTML = buildPlaceholder();

        const controls = document.querySelector("#animepahe-watchlist .apw-controls");
        if (controls) controls.remove();
    }

    updateArrows();
    updateMeta();
    await updateTabCounts();
    await applyFilters();
}

async function toggleEntryStatus(animeUrl) {
    const list = await getWatched();
    const idx = list.findIndex(item => item.animeUrl === animeUrl);

    if (idx === -1) return;

    const currentStatus = list[idx].status || "watching";
    const nextStatus = currentStatus === "plan" ? "watching" : "plan";
    const cap = nextStatus === "watching" ? MAX_WATCHING : MAX_PLAN;
    const targetCount = list.filter(item => (item.status || "watching") === nextStatus).length;

    if (targetCount >= cap) {
        const label = nextStatus === "plan" ? "Plan to Watch" : "Currently Watching";
        showWidgetToast(`${label} is full (${cap}/${cap})`);
        return;
    }

    list[idx].status = nextStatus;
    list[idx].statusTs = Date.now();

    const [entry] = list.splice(idx, 1);
    list.unshift(entry);

    await saveWatched(list);
    refreshWatchlist();
}

function showWidgetToast(message) {
    const section = document.querySelector("#animepahe-watchlist");
    if (!section) return;

    let toast = section.querySelector(".apw-toast");

    if (!toast) {
        toast = document.createElement("div");
        toast.className = "apw-toast";
        section.querySelector(".apw-header").insertAdjacentElement("afterend", toast);
    }

    toast.textContent = message;
    toast.classList.add("apw-toast-visible");

    clearTimeout(toast._hideTimeout);
    toast._hideTimeout = setTimeout(() => toast.classList.remove("apw-toast-visible"), 3000);
}

// ---------- Latest episode badges ----------
function pass1FromHomepage() {
    const latestCards = document.querySelectorAll(".latest-release .episode-wrap");

    if (!latestCards.length) return {};

    const latestMap = {};

    latestCards.forEach(card => {
        const animeLink = card.querySelector('.episode-title a[href^="/anime/"]');
        const epDiv = card.querySelector(".episode-number");

        if (!animeLink || !epDiv) return;

        const animeUrl = animeLink.getAttribute("href");

        const visibleText = Array.from(epDiv.childNodes)
            .filter(node => node.nodeType === Node.TEXT_NODE)
            .map(node => node.textContent)
            .join("")
            .trim();

        const epMatch = visibleText.match(/(\d+(?:\.\d+)?)/);

        if (!epMatch) return;

        latestMap[animeUrl] = parseFloat(epMatch[1]);
    });

    return latestMap;
}

async function fetchLatestEpisodeViaApi(animeUrl) {
    const session = animeUrl.replace(/^\/anime\//, "");

    if (!session) return null;

    try {
        const res = await fetch(`/api?m=release&id=${encodeURIComponent(session)}&sort=episode_desc&page=1`, {
            credentials: "same-origin",
            headers: {
                "Accept": "application/json"
            }
        });

        if (!res.ok) return null;

        const data = await res.json();

        if (!data || !data.data || !data.data.length) return null;

        const ep = parseFloat(data.data[0].episode);

        return isNaN(ep) ? null : ep;
    } catch (err) {
        console.warn("[APW] API fetch failed:", animeUrl, err);
        return null;
    }
}

function addOrUpdateNewBadge(card, watchedEp, latestEp) {
    const badgeStack = getOrCreateBadgeStack(card);
    let newBadge = badgeStack.querySelector(".apw-new-badge");

    card.dataset.watchedEp = String(watchedEp);
    card.dataset.latestEp = String(latestEp);

    if (latestEp > watchedEp) {
        const diff = +(latestEp - watchedEp).toFixed(1);
        const label = diff === 1 ? "+1 ep" : `+${diff} eps`;

        card.dataset.hasNew = "true";

        if (newBadge) {
            newBadge.textContent = label;
        } else {
            newBadge = document.createElement("div");
            newBadge.className = "apw-new-badge";
            newBadge.textContent = label;
            badgeStack.prepend(newBadge);
        }
    } else {
        card.dataset.hasNew = "false";

        if (newBadge) {
            newBadge.remove();
        }
    }

    updateProgressText(card);
    cleanupBadgeStack(card);
}

async function applyNewEpisodeBadges(section) {
    const settings = await getSettings();

    if (!settings.showNewEpisodeBadges) return;

    const watched = (await getWatched()).filter(item => (item.status || "watching") === "watching");

    if (!watched.length) return;

    const cache = await storageGet(LATEST_EP_CACHE_KEY, {});
    const now = Date.now();

    const homepageMap = pass1FromHomepage();

    section.querySelectorAll(".apw-wrap").forEach(card => {
        const animeUrl = card.getAttribute("data-anime");
        const status = card.dataset.status || "watching";

        if (status === "plan") return;

        const entry = watched.find(item => item.animeUrl === animeUrl);
        if (!entry) return;

        const latestEp = homepageMap[animeUrl];
        if (latestEp === undefined) return;

        const watchedEp = parseFloat(entry.episode);

        if (isNaN(watchedEp) || isNaN(latestEp)) return;

        addOrUpdateNewBadge(card, watchedEp, latestEp);
    });

    for (const entry of watched) {
        if (!entry.animeUrl) continue;

        const watchedEp = parseFloat(entry.episode);
        if (isNaN(watchedEp)) continue;

        let latestEp = null;
        const cached = cache[entry.animeUrl];

        if (cached && now - cached.ts < LATEST_EP_CACHE_TTL_MS) {
            latestEp = cached.ep;
        } else {
            latestEp = await fetchLatestEpisodeViaApi(entry.animeUrl);

            if (latestEp !== null) {
                cache[entry.animeUrl] = { ep: latestEp, ts: now };
                await storageSet(LATEST_EP_CACHE_KEY, cache);
            }
        }

        if (latestEp === null) continue;

        const card = section.querySelector(`.apw-wrap[data-anime="${cssEscape(entry.animeUrl)}"]`);
        if (!card) continue;

        addOrUpdateNewBadge(card, watchedEp, latestEp);
    }

    await applyFilters();
}

function waitForLatestAndApplyBadges(section, tries = 30) {
    const cards = document.querySelectorAll(".latest-release .episode-wrap");

    if (cards.length) {
        applyNewEpisodeBadges(section);
        return;
    }

    if (tries > 0) {
        setTimeout(() => waitForLatestAndApplyBadges(section, tries - 1), 300);
    } else {
        applyNewEpisodeBadges(section);
    }
}

// ---------- Countdown badges ----------
function setCardCountdown(card, animeUrl, targetMs) {
    if (!targetMs) {
        countdownTargets.delete(animeUrl);

        card.dataset.hasAiring = "false";
        card.dataset.airingAt = "";

        const airingBadge = card.querySelector(".apw-airing-badge");
        if (airingBadge) airingBadge.remove();

        updateProgressText(card);
        cleanupBadgeStack(card);
        return;
    }

    countdownTargets.set(animeUrl, targetMs);

    card.dataset.hasAiring = "true";
    card.dataset.airingAt = String(targetMs);

    const badgeStack = getOrCreateBadgeStack(card);
    let airingBadge = badgeStack.querySelector(".apw-airing-badge");

    if (!airingBadge) {
        airingBadge = document.createElement("div");
        airingBadge.className = "apw-airing-badge";
        badgeStack.appendChild(airingBadge);
    }

    airingBadge.textContent = `Next ep in ${countdownText(targetMs)}`;

    updateProgressText(card);
}

function refreshAllCountdowns() {
    countdownTargets.forEach((targetMs, animeUrl) => {
        const card = document.querySelector(`#animepahe-watchlist .apw-wrap[data-anime="${cssEscape(animeUrl)}"]`);

        if (!card) {
            countdownTargets.delete(animeUrl);
            return;
        }

        const airingBadge = card.querySelector(".apw-airing-badge");

        if (airingBadge) {
            airingBadge.textContent = `Next ep in ${countdownText(targetMs)}`;
        }
    });
}

function startCountdownTicker() {
    if (countdownInterval) return;
    countdownInterval = setInterval(refreshAllCountdowns, 60 * 1000);
}

async function applyCountdowns(section) {
    const settings = await getSettings();

    if (!settings.showCountdowns) return;

    const watched = (await getWatched()).filter(item => (item.status || "watching") === "watching");

    for (const entry of watched) {
        const card = section.querySelector(`.apw-wrap[data-anime="${cssEscape(entry.animeUrl)}"]`);
        if (!card) continue;

        try {
            const targetMs = await getCountdownForEntry(entry);
            setCardCountdown(card, entry.animeUrl, targetMs);
        } catch (err) {
            console.warn("[APW] Countdown failed:", entry.title, err);
        }
    }

    if (countdownTargets.size > 0) {
        startCountdownTicker();
    }

    await applyFilters();
}

// ---------- Render ----------
async function renderWatchlist() {
    const widgetSettings = await getSettings();
    if (widgetSettings.widgetEnabled === false) return;

    let list = await getWatched();

    const cache = await getPosterCache();
    let mutated = false;

    for (const entry of list) {
        if (!entry.status) {
            entry.status = "watching";
            mutated = true;
        }

        if (!entry.statusTs) {
            entry.statusTs = entry.ts || Date.now();
            mutated = true;
        }

        if (!entry.thumb && entry.animeUrl) {
            const fullAnimeUrl = location.origin + entry.animeUrl;
            const cached = cache[entry.animeUrl] || cache[fullAnimeUrl];

            if (cached) {
                entry.thumb = cached;
                mutated = true;
            } else {
                fetchPoster(fullAnimeUrl).then(async poster => {
                    if (!poster) return;

                    const updated = await getWatched();
                    const idx = updated.findIndex(item => item.animeUrl === entry.animeUrl);

                    if (idx !== -1 && !updated[idx].thumb) {
                        updated[idx].thumb = poster;
                        await saveWatched(updated);

                        const imgs = document.querySelectorAll(`#animepahe-watchlist .apw-wrap[data-anime="${cssEscape(entry.animeUrl)}"] img`);

                        imgs.forEach(img => {
                            img.src = poster;
                            img.style.opacity = 1;

                            const snapshot = img.closest(".apw-snapshot");
                            if (snapshot) snapshot.classList.remove("apw-loading");
                        });
                    }
                });
            }
        }
    }

    if (mutated) {
        await saveWatched(list);
    }

    const waitFor = (selector, cb, tries = 20) => {
        const el = document.querySelector(selector);

        if (el) return cb(el);

        if (tries <= 0) return;

        setTimeout(() => waitFor(selector, cb, tries - 1), 250);
    };

    waitFor(".latest-release", async latestRelease => {
        if (document.querySelector("#animepahe-watchlist")) return;

        const controls = list.length ? await buildControls(list) : "";

        const body = list.length
            ? `
                <div class="apw-slider-wrap">
                    <button class="apw-arrow apw-arrow-left" aria-label="Scroll left">‹</button>

                    <div class="apw-viewport">
                        <div class="apw-list">${list.map(entry => buildCard(entry, widgetSettings.currentFilter)).join("")}</div>
                    </div>

                    <button class="apw-arrow apw-arrow-right" aria-label="Scroll right">›</button>

                    <div class="apw-filter-empty apw-hidden">
                        <div class="apw-filter-empty-title"></div>
                        <div class="apw-filter-empty-text"></div>
                    </div>
                </div>
            `
            : buildPlaceholder();

        const section = document.createElement("div");
        section.id = "animepahe-watchlist";

        section.innerHTML = `
            <div class="apw-header">
                <h2>Animepahe Watchlist</h2>
            </div>

            ${controls}

            <div class="apw-body">
                ${body}
            </div>
        `;

        const tabGear = section.querySelector(".apw-settings-gear");
        if (tabGear) tabGear.addEventListener("click", togglePanel);

        section.addEventListener("click", async e => {
            const removeBtn = e.target.closest(".apw-remove");

            if (removeBtn) {
                e.preventDefault();
                e.stopPropagation();

                const wrap = removeBtn.closest(".apw-wrap");
                const animeUrl = wrap?.getAttribute("data-anime");

                if (animeUrl) await removeEntry(animeUrl);
                return;
            }

            const statusBtn = e.target.closest(".apw-status-toggle");

            if (statusBtn) {
                e.preventDefault();
                e.stopPropagation();

                const wrap = statusBtn.closest(".apw-wrap");
                const animeUrl = wrap?.getAttribute("data-anime");

                if (animeUrl) await toggleEntryStatus(animeUrl);
                return;
            }

            const tab = e.target.closest(".apw-tab");

            if (tab) {
                e.preventDefault();

                await saveSettings({ currentFilter: tab.dataset.filter });

                section.querySelectorAll(".apw-tab").forEach(t => {
                    t.classList.toggle("apw-active", t === tab);
                });

                await applyFilters();
                return;
            }

            const playLink = e.target.closest(".apw-play-link");
            const titleLink = e.target.closest(".apw-title a");
            const linkEl = playLink || titleLink;

            if (linkEl) {
                e.preventDefault();

                const wrap = linkEl.closest(".apw-wrap");
                const animeUrl = wrap?.getAttribute("data-anime");
                if (!animeUrl) return;

                const list = await getWatched();
                const entry = list.find(item => item.animeUrl === animeUrl);
                if (!entry) return;

                const isPlan = (entry.status || "watching") === "plan";
                const type = (playLink && !isPlan) ? "play" : "anime";

                wrap.classList.add("apw-resolving");

                try {
                    const freshUrl = await resolveFreshUrl(entry, type);
                    window.location.href = freshUrl;
                } catch (err) {
                    console.error("[APW] URL resolution failed, opening stored URL:", err);
                    window.location.href = linkEl.href;
                }
            }
        });

        const arrowLeft = section.querySelector(".apw-arrow-left");
        const arrowRight = section.querySelector(".apw-arrow-right");
        const slider = section.querySelector(".apw-list");
        const step = CARD_WIDTH + CARD_GAP;

        if (arrowLeft && arrowRight && slider) {
            arrowLeft.addEventListener("click", () => {
                slider.scrollBy({ left: -step * 3, behavior: "smooth" });
            });

            arrowRight.addEventListener("click", () => {
                slider.scrollBy({ left: step * 3, behavior: "smooth" });
            });

            slider.addEventListener("scroll", updateArrows);
            enableDragScroll(slider);
        }

        latestRelease.parentNode.insertBefore(section, latestRelease);

        requestAnimationFrame(async () => {
            updateArrows();
            updateMeta();
            await updateTabCounts();
            await applyFilters();
            await applyAlignment();
            await applySettingsClasses();
        });

        window.addEventListener("resize", updateArrows);

        if (list.length) {
            waitForLatestAndApplyBadges(section);
            applyCountdowns(section);
        }
    });
}

// ---------- Settings panel (shadow DOM overlay) ----------

const PANEL_HOST_ID = "apw-panel-host";
const PANEL_WIDTH = 380;
const PANEL_OPEN_FLAG = "apw_open_panel_on_load";

const GEAR_SVG = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;

let panelHost = null;
let panelOpen = false;

function hostCss(open) {
    return [
        "position:fixed",
        "top:0",
        "right:0",
        "height:100vh",
        `width:${PANEL_WIDTH}px`,
        "max-width:92vw",
        "margin:0",
        "padding:0",
        "border:none",
        "overflow:hidden",
        "background:#111",
        "z-index:2147483647",
        "box-shadow:-6px 0 28px rgba(0,0,0,0.5)",
        "transition:transform .22s ease",
        `transform:${open ? "translateX(0)" : "translateX(100%)"}`
    ].map(d => `${d} !important`).join(";");
}

async function buildPanel() {
    if (panelHost) return;

    panelHost = document.createElement("div");
    panelHost.id = PANEL_HOST_ID;
    panelHost.style.cssText = hostCss(false);

    const root = panelHost.attachShadow({ mode: "open" });
    (document.documentElement || document.body).appendChild(panelHost);

    let css = "";
    try {
        css = await fetch(chrome.runtime.getURL("panel.css")).then(r => r.text());
    } catch {}

    const style = document.createElement("style");
    style.textContent = css;
    root.appendChild(style);

    const version = chrome.runtime.getManifest().version;
    const settings = await getSettings();
    const alignment = settings.cardAlignment || "center";

    const wrap = document.createElement("div");
    wrap.className = "apw-panel";
    wrap.innerHTML = `
        <header class="apw-panel-header">
            <div>
                <h2 class="apw-panel-title">Settings</h2>
                <p class="apw-panel-subtitle">Animepahe Watchlist</p>
            </div>
            <button class="apw-panel-close" aria-label="Close">×</button>
        </header>
        <div class="apw-panel-body">
            <section class="apw-panel-section">
                <div class="apw-section-header">
                    <h3 class="apw-section-title">Widget</h3>
                    <p class="apw-section-desc">Appearance and content shown on the AnimePahe homepage.</p>
                </div>
                <div class="apw-alignment-row">
                    <span class="apw-align-label">Card alignment</span>
                    <div class="apw-align-btns">
                        <button class="apw-align-btn" data-align="left">Left</button>
                        <button class="apw-align-btn" data-align="center">Center</button>
                        <button class="apw-align-btn" data-align="right">Right</button>
                    </div>
                </div>
                <label class="apw-toggle"><span>Show airing countdowns</span><input type="checkbox" data-setting="showCountdowns"></label>
                <label class="apw-toggle"><span>Show new episode badges</span><input type="checkbox" data-setting="showNewEpisodeBadges"></label>
                <label class="apw-toggle"><span>Show episode number</span><input type="checkbox" data-setting="showEpisodeNumber"></label>
                <label class="apw-toggle"><span>Show progress text</span><input type="checkbox" data-setting="showProgress"></label>
                <label class="apw-toggle"><span>Show last watched time</span><input type="checkbox" data-setting="showLastWatched"></label>
            </section>
            <section class="apw-panel-section apw-section-preview">
                <div class="apw-section-header">
                    <h3 class="apw-section-title">Player <span class="apw-section-badge">Coming in v1.5.0</span></h3>
                    <p class="apw-section-desc">Features for the AnimePahe video player page.</p>
                </div>
                <label class="apw-toggle apw-toggle-disabled"><span>Resume from last position</span><input type="checkbox" disabled></label>
                <label class="apw-toggle apw-toggle-disabled"><span>Skip intro / outro (AniSkip)</span><input type="checkbox" disabled></label>
                <label class="apw-toggle apw-toggle-disabled"><span>Auto-play next episode</span><input type="checkbox" disabled></label>
                <label class="apw-toggle apw-toggle-disabled"><span>Show progress bar on cards</span><input type="checkbox" disabled></label>
            </section>
        </div>
        <footer class="apw-panel-footer">
            <span>v${version}</span>
        </footer>
    `;
    root.appendChild(wrap);

    const setActiveAlign = align => {
        wrap.querySelectorAll(".apw-align-btn").forEach(btn => {
            btn.classList.toggle("apw-align-btn-active", btn.dataset.align === align);
        });
    };
    setActiveAlign(alignment);

    wrap.querySelectorAll(".apw-align-btn").forEach(btn => {
        btn.addEventListener("click", async () => {
            await saveSettings({ cardAlignment: btn.dataset.align });
            setActiveAlign(btn.dataset.align);
        });
    });

    wrap.querySelectorAll(".apw-toggle input").forEach(input => {
        const key = input.dataset.setting;
        input.checked = settings[key] !== false;
        input.addEventListener("change", async () => {
            await saveSettings({ [key]: input.checked });
        });
    });

    wrap.querySelector(".apw-panel-close").addEventListener("click", closePanel);

    void panelHost.offsetWidth;
}

async function openPanel() {
    await buildPanel();
    panelHost.style.cssText = hostCss(true);
    panelOpen = true;
}

function closePanel() {
    if (!panelHost) return;
    panelHost.style.cssText = hostCss(false);
    panelOpen = false;
}

function togglePanel() {
    if (panelOpen) closePanel();
    else openPanel();
}

document.addEventListener("pointerdown", event => {
    if (!panelOpen || !panelHost) return;
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    if (path.includes(panelHost)) return;
    if (event.target.closest?.(".apw-settings-gear")) return;
    closePanel();
}, true);

document.addEventListener("keydown", event => {
    if (event.key === "Escape" && panelOpen) closePanel();
});

function refreshWatchlist() {
    const section = document.querySelector("#animepahe-watchlist");

    if (section) section.remove();

    countdownTargets.clear();

    if (isHomePage) {
        renderWatchlist();
    }
}

function buildCard(entry, currentFilter = "watching") {
    const status = entry.status || "watching";
    const isPlan = status === "plan";
    const hidden = status !== currentFilter;

    const thumb = entry.thumb || "";
    const animeUrl = entry.animeUrl || "#";
    const title = escapeHtml(entry.title);
    const ep = escapeHtml(entry.episode || "");
    const animeAttr = escapeHtml(entry.animeUrl || "");
    const playUrl = isPlan ? animeUrl : escapeHtml(entry.playUrl || animeUrl || "#");

    const when = relativeTime(isPlan ? (entry.statusTs || entry.ts) : entry.ts);
    const isLoading = !thumb ? "apw-loading" : "";
    const statusButtonText = isPlan ? "▶ Watch" : "+ Plan";

    const cardContent = isPlan
        ? `
            <div class="apw-plan-text">Plan to Watch</div>
            ${when ? `<div class="apw-when">Added ${escapeHtml(when)}</div>` : ""}
        `
        : `
            <div class="apw-episode-text">Ep. ${ep}</div>
            <div class="apw-progress"></div>
            ${when ? `<div class="apw-when">Last watched ${escapeHtml(when)}</div>` : ""}
        `;

    return `
        <div
            class="apw-wrap${hidden ? " apw-hidden" : ""}"
            data-anime="${animeAttr}"
            data-status="${status}"
            data-has-new="false"
            data-has-airing="false"
            data-airing-at=""
            data-watched-ep="${ep}"
            data-latest-ep=""
        >
            <button class="apw-remove" title="Remove from list" aria-label="Remove">×</button>
            <button class="apw-status-toggle" title="Move list" aria-label="Move list">${statusButtonText}</button>

            <div class="apw-episode">
                <div class="apw-snapshot ${isLoading}">
                    <img src="${thumb}" alt="" loading="lazy" draggable="false" onerror="this.style.opacity=0.2">
                    <a href="${playUrl}" class="apw-play-link">${isPlan ? `Open ${title}` : `Watch ${title} - Episode ${ep}`}</a>
                </div>

                <div class="apw-label-wrap">
                    <div class="apw-title">
                        <a href="${animeUrl}" title="${title}">${title}</a>
                    </div>

                    ${cardContent}
                </div>
            </div>
        </div>
    `;
}

// ---------- Badge / progress helpers ----------
function getOrCreateBadgeStack(card) {
    let badgeStack = card.querySelector(".apw-badge-stack");

    if (!badgeStack) {
        badgeStack = document.createElement("div");
        badgeStack.className = "apw-badge-stack";
        card.querySelector(".apw-episode").appendChild(badgeStack);
    }

    return badgeStack;
}

function cleanupBadgeStack(card) {
    const badgeStack = card.querySelector(".apw-badge-stack");

    if (!badgeStack) return;

    if (!badgeStack.children.length) {
        badgeStack.remove();
    }
}

function updateProgressText(card) {
    const progress = card.querySelector(".apw-progress");

    if (!progress) return;

    const watchedEp = parseFloat(card.dataset.watchedEp || "");
    const latestEp = parseFloat(card.dataset.latestEp || "");
    const hasAiring = card.dataset.hasAiring === "true";

    if (isNaN(watchedEp) || isNaN(latestEp)) {
        progress.textContent = "";
        return;
    }

    if (latestEp > watchedEp) {
        progress.textContent = `Watched ${cleanEpisode(watchedEp)} of ${cleanEpisode(latestEp)}`;
        return;
    }

    if (latestEp === watchedEp && hasAiring) {
        progress.textContent = `Watched ${cleanEpisode(watchedEp)} of ${cleanEpisode(latestEp)}`;
        return;
    }

    progress.textContent = "";
}

function cleanEpisode(ep) {
    const n = parseFloat(ep);

    if (isNaN(n)) return ep;

    return Number.isInteger(n) ? String(n) : String(n);
}

function cssEscape(str) {
    if (window.CSS && CSS.escape) {
        return CSS.escape(str);
    }

    return String(str).replace(/["\\]/g, "\\$&");
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

// ---------- Settings change listener ----------
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !isHomePage) return;
    if (!(SETTINGS_KEY in changes)) return;

    const newSettings = changes[SETTINGS_KEY].newValue || {};
    const oldSettings = changes[SETTINGS_KEY].oldValue || {};

    if (newSettings.widgetEnabled !== oldSettings.widgetEnabled) {
        if (newSettings.widgetEnabled !== false) {
            injectStyles();
            renderWatchlist();
        } else {
            const section = document.querySelector("#animepahe-watchlist");
            if (section) section.remove();
            countdownTargets.clear();
            if (countdownInterval) {
                clearInterval(countdownInterval);
                countdownInterval = null;
            }
        }
        return;
    }

    if (newSettings.cardAlignment !== oldSettings.cardAlignment) {
        applyAlignment();
    }

    applySettingsClasses();
});

// ---------- Panel open requests ----------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "openSettingsPanel") {
        openPanel();
        sendResponse({ ok: true });
    }
});

async function checkAutoOpenFlag() {
    try {
        const data = await chrome.storage.local.get([PANEL_OPEN_FLAG]);
        if (data[PANEL_OPEN_FLAG]) {
            await chrome.storage.local.remove(PANEL_OPEN_FLAG);
            openPanel();
        }
    } catch {}
}

// ---------- Run ----------
if (isPlayPage) {
    getSettings().then(settings => {
        if (settings.widgetEnabled !== false) {
            trySaveWithRetry();
        }
    });
    checkAutoOpenFlag();
}

if (isHomePage) {
    injectStyles();
    renderWatchlist();
    checkAutoOpenFlag();

    chrome.runtime.sendMessage({ type: "autoSync" }, response => {
        if (chrome.runtime.lastError) return; // extension reloaded / no background
        if (response?.success) refreshWatchlist();
    });
}