const STORAGE_KEY = "recently_watched";
const POSTER_CACHE_KEY = "apw_poster_cache";
const LATEST_EP_CACHE_KEY = "apw_latest_ep_cache";
const ANILIST_ID_CACHE_KEY = "apw_anilist_id_cache";
const ANILIST_AIRING_CACHE_KEY = "apw_anilist_airing_cache";
const ANILIST_TOTAL_EP_CACHE_KEY = "apw_anilist_total_ep_cache";
const SETTINGS_KEY = "apw_settings";
const ROTATION_LOG_KEY = "apw_rotation_log";
// Written by the popup on AniList login (see anilist-auth.js). Read here so the widget can show the
// logged-in user's AniList lists as rows.
const ANILIST_TOKEN_KEY = "apw_anilist_token";
const ANILIST_PROFILE_KEY = "apw_anilist_profile";
const ANILIST_LISTS_CACHE_KEY = "apw_anilist_lists_cache";

const ANILIST_AIRING_TTL_MS = 60 * 60 * 1000;
const LATEST_EP_CACHE_TTL_MS = 30 * 60 * 1000;
const ANILIST_LISTS_TTL_MS = 5 * 60 * 1000;

// The AniList list statuses that can be shown as widget rows, in display order. `key` is AniList's
// MediaListStatus; `filter` is the tab id (`al:` prefix distinguishes it from native watching/plan);
// `setting` is the per-row show/hide toggle in DEFAULT_SETTINGS.
const ANILIST_STATUSES = [
    { key: "CURRENT",   label: "Watching",   filter: "al:CURRENT",   setting: "alRowCURRENT" },
    { key: "PLANNING",  label: "Planning",   filter: "al:PLANNING",  setting: "alRowPLANNING" },
    { key: "COMPLETED", label: "Completed",  filter: "al:COMPLETED", setting: "alRowCOMPLETED" },
    { key: "PAUSED",    label: "Paused",     filter: "al:PAUSED",    setting: "alRowPAUSED" },
    { key: "DROPPED",   label: "Dropped",    filter: "al:DROPPED",   setting: "alRowDROPPED" },
    { key: "REPEATING", label: "Rewatching", filter: "al:REPEATING", setting: "alRowREPEATING" },
];

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
    showProgress: true,
    progressMode: "current",
    showSettingsButton: true,
    panelSide: "right",
    showAutoPlayPill: false,
    autoPlayNext: false,
    // Rows: the widget stacks each enabled list as its own horizontal row. The two native rows are
    // always available; AniList rows appear when signed in. `rowOrder` is the display order (ids),
    // filled in from the default order for any row it doesn't mention.
    rowWatching: true,
    rowPlan: true,
    rowOrder: null,
    // AniList rows: which of the logged-in user's lists show as rows. Watching + Planning on by
    // default; the rest opt-in (so the widget stays short until the user wants more).
    alRowCURRENT: true,
    alRowPLANNING: true,
    alRowCOMPLETED: false,
    alRowPAUSED: false,
    alRowDROPPED: false,
    alRowREPEATING: false,
    // Push AnimePahe watch progress up to the signed-in AniList account (never regresses AniList).
    pushToAnilist: true
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

// Beta diagnostic: record when a stored session no longer matches the freshly
// resolved one (i.e. AnimePahe rotated the link). Cheap passive counter.
async function getRotationLog() {
    return await storageGet(ROTATION_LOG_KEY, { count: 0, lastTs: null, lastTitle: null });
}

async function recordRotation(title) {
    const log = await getRotationLog();
    log.count = (log.count || 0) + 1;
    log.lastTs = Date.now();
    log.lastTitle = title || null;
    await storageSet(ROTATION_LOG_KEY, log);
}

// Merges duplicate entries (same animeId or same normalized title).
// Keeps the most recently updated entry; inherits thumb/animeId from any duplicate that has them.
function dedupList(list) {
    const best = new Map();

    for (const item of list) {
        const key = item.animeId != null
            ? `id:${item.animeId}`
            : `t:${(item.title || "").toLowerCase().trim()}`;

        if (!best.has(key)) {
            best.set(key, { ...item });
        } else {
            const cur = best.get(key);
            const curTs = Math.max(cur.ts || 0, cur.statusTs || 0);
            const itemTs = Math.max(item.ts || 0, item.statusTs || 0);

            if (itemTs > curTs) {
                best.set(key, {
                    ...item,
                    thumb: item.thumb || cur.thumb,
                    animeId: item.animeId ?? cur.animeId,
                });
            } else {
                if (!cur.thumb && item.thumb) cur.thumb = item.thumb;
                if (cur.animeId == null && item.animeId != null) cur.animeId = item.animeId;
            }
        }
    }

    return [...best.values()].sort((a, b) => (b.ts || 0) - (a.ts || 0));
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

    const validNativeFilter = ["watching", "plan"].includes(settings.currentFilter);
    const validAnilistFilter = typeof settings.currentFilter === "string" &&
        settings.currentFilter.startsWith("al:");
    if (!validNativeFilter && !validAnilistFilter) {
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
    const navAnimeId = sessionStorage.getItem("apw-nav-anime-id");
    sessionStorage.removeItem("apw-nav-anime-id");

    let existingEntry = existingList.find(item => item.animeUrl === animeHref);

    if (!existingEntry && navAnimeId) {
        existingEntry = existingList.find(item => String(item.animeId) === navAnimeId);
    }

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
                episodes
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

async function getAniListInfoForEntry(entry) {
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
    const cacheComplete = cached
        && Object.prototype.hasOwnProperty.call(cached, "totalEpisodes")
        && Object.prototype.hasOwnProperty.call(cached, "status");

    if (cached && cacheComplete && now - cached.ts < ANILIST_AIRING_TTL_MS) {
        return { airingAt: cached.airingAt ? cached.airingAt * 1000 : null, totalEpisodes: cached.totalEpisodes, nextAiringEp: cached.nextAiringEp ?? null, status: cached.status ?? null };
    }

    try {
        const info = await fetchAiringInfo(anilistId);
        const airingAt = info?.nextAiringEpisode?.airingAt || null;
        const totalEpisodes = info?.episodes ?? null;
        const nextAiringEp = info?.nextAiringEpisode?.episode ?? null;
        const status = info?.status ?? null;

        airingCache[anilistId] = { airingAt, totalEpisodes, nextAiringEp, status, ts: now };
        await storageSet(ANILIST_AIRING_CACHE_KEY, airingCache);

        return { airingAt: airingAt ? airingAt * 1000 : null, totalEpisodes, nextAiringEp, status };
    } catch (err) {
        console.warn("[APW] AniList fetch failed:", entry.title, err);
        return null;
    }
}

// ---------- AniList account (logged-in user's lists) ----------
// Login happens in the background service worker via the pairing relay and writes apw_anilist_token
// / apw_anilist_profile. The content script only *reads* the token to fetch and render the user's
// lists as widget rows; it never runs the OAuth flow itself (content scripts can't).

async function getAnilistToken() {
    return await storageGet(ANILIST_TOKEN_KEY, "");
}

async function isAnilistLoggedIn() {
    return !!(await getAnilistToken());
}

// Authenticated AniList GraphQL. Sends the Bearer token; on a 401 the token is cleared (expired or
// revoked) so the widget quietly drops back to the logged-out state on the next render.
async function anilistAuthRequest(query, variables) {
    const token = await getAnilistToken();
    const headers = { "Content-Type": "application/json", "Accept": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const res = await fetch("https://graphql.anilist.co", {
        method: "POST",
        headers,
        body: JSON.stringify({ query, variables })
    });

    if (res.status === 401) {
        await chrome.storage.local.remove([ANILIST_TOKEN_KEY]);
        throw new Error("AniList session expired");
    }

    const json = await res.json();
    if (json.errors) throw json.errors;
    return json.data;
}

async function getAnilistUserId() {
    const profile = await storageGet(ANILIST_PROFILE_KEY, null);
    if (profile?.id) return profile.id;
    // No cached profile (e.g. logged in on another device that shares this token) — resolve it once.
    const data = await anilistAuthRequest(`{ Viewer { id name } }`, {});
    return data?.Viewer?.id ?? null;
}

// Fetch the user's anime lists grouped by MediaListStatus. Cached for ANILIST_LISTS_TTL_MS so
// switching tabs / re-rendering doesn't re-hit AniList. Returns { CURRENT: [entry...], ... }.
async function fetchAnilistLists({ force = false } = {}) {
    if (!(await isAnilistLoggedIn())) return null;

    const cache = await storageGet(ANILIST_LISTS_CACHE_KEY, null);
    if (!force && cache && Date.now() - cache.ts < ANILIST_LISTS_TTL_MS) {
        return cache.lists;
    }

    const userId = await getAnilistUserId();
    if (!userId) return null;

    const query = `
        query ($userId: Int) {
            MediaListCollection(userId: $userId, type: ANIME, sort: UPDATED_TIME_DESC) {
                lists {
                    entries {
                        status
                        progress
                        media {
                            id
                            title { romaji english }
                            coverImage { large }
                            episodes
                            nextAiringEpisode { episode }
                        }
                    }
                }
            }
        }
    `;

    const data = await anilistAuthRequest(query, { userId });
    const rawLists = data?.MediaListCollection?.lists || [];

    const grouped = {};
    for (const { key } of ANILIST_STATUSES) grouped[key] = [];

    const seen = new Set();   // an entry can appear under a custom list too; dedupe by media id+status
    for (const list of rawLists) {
        for (const entry of (list.entries || [])) {
            const status = entry.status;
            if (!grouped[status]) continue;
            const media = entry.media;
            if (!media) continue;
            const dedupeKey = `${status}:${media.id}`;
            if (seen.has(dedupeKey)) continue;
            seen.add(dedupeKey);

            const airedEps = media.nextAiringEpisode?.episode
                ? media.nextAiringEpisode.episode - 1
                : (media.episodes || null);

            grouped[status].push({
                mediaId: media.id,
                title: media.title?.english || media.title?.romaji || "Untitled",
                cover: media.coverImage?.large || "",
                progress: entry.progress || 0,
                total: media.episodes || null,
                aired: airedEps,
            });
        }
    }

    await storageSet(ANILIST_LISTS_CACHE_KEY, { ts: Date.now(), lists: grouped });
    return grouped;
}

// ---------- AniList progress push ----------
// Bump progress on an existing list entry (leaves its status untouched).
const AL_SAVE_PROGRESS = `
    mutation ($mediaId: Int, $progress: Int) {
        SaveMediaListEntry(mediaId: $mediaId, progress: $progress) { id progress }
    }
`;
// Create/replace an entry as Watching with the given progress (for anime not on any list yet).
const AL_SAVE_NEW = `
    mutation ($mediaId: Int, $progress: Int) {
        SaveMediaListEntry(mediaId: $mediaId, progress: $progress, status: CURRENT) { id progress status }
    }
`;

// Per-session record of the highest episode we've reconciled with AniList for a media id, so repeat
// renders don't re-check or re-push the same progress.
const anilistPushedProgress = new Map();

// Patch the cached AniList lists so the row shows the new progress and the next render won't re-push.
async function patchAnilistListsCacheProgress(anilistId, progress) {
    const wrap = await storageGet(ANILIST_LISTS_CACHE_KEY, null);
    if (!wrap?.lists) return;
    for (const key of Object.keys(wrap.lists)) {
        const entry = (wrap.lists[key] || []).find(e => e.mediaId === anilistId);
        if (entry) {
            entry.progress = progress;
            await storageSet(ANILIST_LISTS_CACHE_KEY, wrap);
            return;
        }
    }
}

// Push a watch up to AniList when signed in and enabled. Never regresses: only writes when the local
// AniList-numbering episode is higher than what AniList already has for that anime.
async function maybePushAnilistProgress(animeUrl, anilistEp) {
    if (!Number.isFinite(anilistEp) || anilistEp < 1) return;

    const settings = await getSettings();
    if (settings.pushToAnilist === false) return;
    if (!(await isAnilistLoggedIn())) return;

    const idCache = await storageGet(ANILIST_ID_CACHE_KEY, {});
    const anilistId = idCache[animeUrl];
    if (!Number.isInteger(anilistId)) return;

    // Skip if this session already reconciled this media at or above this episode.
    if ((anilistPushedProgress.get(anilistId) ?? -1) >= anilistEp) return;

    let lists;
    try {
        lists = await fetchAnilistLists();
    } catch {
        return;
    }
    if (!lists) return;

    let entry = null;
    for (const s of ANILIST_STATUSES) {
        const hit = (lists[s.key] || []).find(e => e.mediaId === anilistId);
        if (hit) { entry = hit; break; }
    }
    const current = entry?.progress ?? 0;

    // Mark reconciled up to the higher of local/remote so we don't recheck this media needlessly.
    anilistPushedProgress.set(anilistId, Math.max(anilistEp, current));

    if (anilistEp <= current) return;   // AniList is already at or ahead — never regress

    try {
        await anilistAuthRequest(entry ? AL_SAVE_PROGRESS : AL_SAVE_NEW, { mediaId: anilistId, progress: anilistEp });
        await patchAnilistListsCacheProgress(anilistId, anilistEp);
    } catch (err) {
        console.warn("[APW] AniList progress push failed:", err);
        anilistPushedProgress.delete(anilistId);   // allow a retry on a later render
    }
}

// ---------- Row model ----------
// The widget stacks rows: two native ones (the local watchlist) plus one per enabled AniList list.

// Native rows first, then AniList lists in ANILIST_STATUSES order.
function defaultRowIds() {
    return ["watching", "plan", ...ANILIST_STATUSES.map(s => s.filter)];
}

// Static descriptor for a row id, or null if the id is unknown.
function rowDefById(id) {
    if (id === "watching") return { id, title: "Currently Watching", setting: "rowWatching", kind: "native", status: "watching" };
    if (id === "plan")     return { id, title: "Plan to Watch",      setting: "rowPlan",     kind: "native", status: "plan" };
    const s = ANILIST_STATUSES.find(x => x.filter === id);
    if (s) return { id, title: s.label, setting: s.setting, kind: "anilist", key: s.key };
    return null;
}

// The display order: the saved order, with any rows it doesn't mention appended in default order.
function orderedRowIds(settings) {
    const all = defaultRowIds();
    const saved = Array.isArray(settings.rowOrder) ? settings.rowOrder.filter(id => all.includes(id)) : [];
    for (const id of all) if (!saved.includes(id)) saved.push(id);
    return saved;
}

// AniList rows that exist for the manager UI (logged in). Native rows are always available.
async function availableRowDefs(settings) {
    const loggedIn = await isAnilistLoggedIn();
    return orderedRowIds(settings)
        .map(rowDefById)
        .filter(def => def && (def.kind === "native" || loggedIn));
}

async function getCountdownForEntry(entry) {
    const info = await getAniListInfoForEntry(entry);
    return info?.airingAt ?? null;
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

async function fetchReleasePage(animeSession, page) {
    const res = await fetch(`/api?m=release&id=${encodeURIComponent(animeSession)}&sort=episode_asc&page=${page}`, {
        credentials: "same-origin",
        headers: { "Accept": "application/json" }
    });
    if (!res.ok) throw new Error("Release request failed");
    return await res.json();
}

// Resolves the play session for a specific episode number within an anime entry.
// AnimePahe paginates the release list by POSITION (per_page), not by episode
// number, and later cours use continuous numbering (e.g. a 13-episode cour-3
// entry lists episodes 25–37). Computing the page from the episode number alone
// therefore fetches the wrong page for cours. Strategy:
//   1. Fetch page 1 — most short cours fit entirely here.
//   2. If not found and there are more pages, jump to the page implied by the
//      episode's position relative to page 1's first episode.
//   3. Fall back to a bounded sequential scan of the remaining pages.
async function findEpisodeSession(animeSession, epNum) {
    const findIn = list => {
        const hit = list.find(e => parseFloat(e.episode) === epNum);
        return hit?.session || null;
    };

    const first = await fetchReleasePage(animeSession, 1);
    const firstData = Array.isArray(first?.data) ? first.data : [];

    let session = findIn(firstData);
    if (session) return session;

    const lastPage = parseInt(first?.last_page, 10) || 1;
    if (lastPage <= 1 || !firstData.length) return null;

    const perPage = parseInt(first?.per_page, 10) || firstData.length || 30;
    const firstEp = parseFloat(firstData[0].episode);

    // Position-aware page guess using the entry's actual starting episode.
    let guess = null;
    if (!isNaN(firstEp)) {
        guess = Math.min(lastPage, Math.max(2, Math.ceil((epNum - firstEp + 1) / perPage)));
        const guessed = await fetchReleasePage(animeSession, guess);
        session = findIn(Array.isArray(guessed?.data) ? guessed.data : []);
        if (session) return session;
    }

    // Safety net: scan any remaining pages (handles gaps from recap/.5 episodes).
    for (let p = 2; p <= lastPage; p++) {
        if (p === guess) continue;
        const pageData = await fetchReleasePage(animeSession, p);
        session = findIn(Array.isArray(pageData?.data) ? pageData.data : []);
        if (session) return session;
    }

    return null;
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

        // Rotation detection (beta diagnostic): the stored anime URL holds the
        // session at save time. If the freshly searched session differs, the
        // link rotated.
        const storedSession = entry.animeUrl ? entry.animeUrl.replace(/^\/anime\//, "") : null;
        if (storedSession && match.session && storedSession !== match.session) {
            recordRotation(entry.title).catch(() => {});
        }

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
        const epSession = await findEpisodeSession(cached.session, epNum);
        if (epSession) cached.episodes.set(epNum, epSession);
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
            position: absolute;
            right: 0;
            top: 50%;
            transform: translateY(-50%);
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

        .apw-rows {
            width: 100%;
            max-width: ${viewportWidth}px;
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
        }

        .apw-row {
            width: 100%;
        }

        .apw-row-header {
            display: flex;
            align-items: baseline;
            gap: 0.5rem;
            margin-bottom: 0.55rem;
            padding: 0 4px;
        }

        .apw-row-title {
            font-size: 1.05rem;
            font-weight: 600;
        }

        .apw-row-count {
            font-size: 0.8rem;
            opacity: 0.5;
        }

        .apw-row-empty {
            font-size: 0.85rem;
            opacity: 0.5;
            padding: 0.4rem 4px 0.8rem;
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
            display: inline-flex;
            align-items: center;
            gap: 5px;
            transition: background 0.15s, opacity 0.15s, border-color 0.15s;
        }

        .apw-settings-tab-btn svg {
            width: 13px;
            height: 13px;
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

// One stacked row: a header (title + count) and its own horizontal slider. An empty row shows a
// short message instead of a slider.
function buildRow(def, cardsHtml, count) {
    const body = cardsHtml
        ? `
            <div class="apw-slider-wrap">
                <button class="apw-arrow apw-arrow-left" aria-label="Scroll left">‹</button>
                <div class="apw-viewport">
                    <div class="apw-list">${cardsHtml}</div>
                </div>
                <button class="apw-arrow apw-arrow-right" aria-label="Scroll right">›</button>
            </div>
        `
        : `<div class="apw-row-empty">${escapeHtml(rowEmptyText(def))}</div>`;

    return `
        <div class="apw-row" data-row="${escapeHtml(def.id)}">
            <div class="apw-row-header">
                <span class="apw-row-title">${escapeHtml(def.title)}</span>
                <span class="apw-row-count">${count}</span>
            </div>
            ${body}
        </div>
    `;
}

function rowEmptyText(def) {
    if (def.id === "plan") return "Nothing planned yet — add anime with the + Plan button.";
    if (def.id === "watching") return "No anime currently watching.";
    return "Nothing in this AniList list.";
}

// Build the HTML for every enabled, non-empty row in display order. Returns "" when there's nothing
// to show (so the caller can fall back to the empty-widget placeholder).
async function buildRows(watched, anilistLists) {
    const settings = await getSettings();
    const rows = [];

    for (const id of orderedRowIds(settings)) {
        const def = rowDefById(id);
        if (!def) continue;
        if (settings[def.setting] === false) continue;

        if (def.kind === "native") {
            const items = watched.filter(e => !e.deleted && (e.status || "watching") === def.status);
            if (!items.length) continue;   // hide empty rows (placeholder covers the all-empty case)
            const cardsHtml = items.map(e => buildCard(e, def.status)).join("");
            rows.push(buildRow(def, cardsHtml, items.length));
        } else {
            if (!anilistLists) continue;   // logged out or fetch failed
            const entries = anilistLists[def.key] || [];
            if (!entries.length) continue;   // hide empty AniList rows
            const cardsHtml = entries.map(e => buildAnilistCard(e, def.id, false)).join("");
            rows.push(buildRow(def, cardsHtml, entries.length));
        }
    }

    return rows.join("");
}

// Enable/disable a single row's arrows from its own list's scroll state.
function updateArrowsForList(list) {
    const wrap = list.closest(".apw-slider-wrap");
    if (!wrap) return;
    const leftBtn = wrap.querySelector(".apw-arrow-left");
    const rightBtn = wrap.querySelector(".apw-arrow-right");
    if (!leftBtn || !rightBtn) return;

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

// Refresh arrows for every row in the widget.
function updateArrows() {
    document.querySelectorAll("#animepahe-watchlist .apw-list").forEach(updateArrowsForList);
}

async function applyAlignment() {
    const lists = document.querySelectorAll("#animepahe-watchlist .apw-list");
    if (!lists.length) return;
    const settings = await getSettings();
    const align = `apw-align-${settings.cardAlignment || "center"}`;
    lists.forEach(list => {
        list.classList.remove("apw-align-left", "apw-align-center", "apw-align-right");
        list.classList.add(align);
    });
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

// ---------- Status / remove ----------
async function removeEntry(animeUrl) {
    const list = await getWatched();
    const idx = list.findIndex(item => item.animeUrl === animeUrl);
    if (idx !== -1) {
        // Tombstone rather than drop, so the deletion propagates to other clients (NyanTV / other
        // browsers) through the last-write-wins merge instead of being re-added from the cloud.
        list[idx].deleted = true;
        list[idx].statusTs = Date.now();
        await saveWatched(list);
    }

    // Rebuild: the card leaves its row, that row's count changes, and the row (or the whole widget)
    // may need to fall back to an empty state.
    refreshWatchlist();
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

    updateArrows();
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

    const watched = (await getWatched()).filter(item => (item.status || "watching") === "watching");

    for (const entry of watched) {
        const card = section.querySelector(`.apw-wrap[data-anime="${cssEscape(entry.animeUrl)}"]`);
        if (!card) continue;

        try {
            const info = await getAniListInfoForEntry(entry);
            if (info?.totalEpisodes != null) {
                card.dataset.totalEp = String(info.totalEpisodes);
            }
            if (info?.nextAiringEp != null) {
                card.dataset.nextAiringEp = String(info.nextAiringEp);
            }
            if (info?.status != null) {
                card.dataset.anilistStatus = info.status;
            }
            if (settings.showCountdowns) {
                setCardCountdown(card, entry.animeUrl, info?.airingAt ?? null);
            } else {
                updateProgressText(card);
            }
        } catch (err) {
            console.warn("[APW] AniList fetch failed:", entry.title, err);
        }
    }

    if (countdownTargets.size > 0) {
        startCountdownTicker();
    }

    updateArrows();
}

// ---------- Render ----------
async function renderWatchlist() {
    const widgetSettings = await getSettings();
    if (widgetSettings.widgetEnabled === false) return;

    let list = await getWatched();

    const deduped = dedupList(list);
    if (deduped.length !== list.length) {
        list = deduped;
        await saveWatched(list);
    }

    const cache = await getPosterCache();
    let mutated = false;

    // Backfill the AnimePahe link for entries pushed from another client (e.g. NyanTV): they carry an
    // anilistId but no animeUrl. Resolve once via search so they render and behave like native entries.
    for (const entry of list) {
        if (entry.deleted || entry.animeUrl || !Number.isInteger(entry.anilistId)) continue;
        try {
            const results = await searchAnimepahe(entry.title);
            const match = results[0];
            if (match && match.session) {
                entry.animeUrl = `/anime/${match.session}`;
                if (Number.isInteger(match.id)) entry.animeId = match.id;
                if (!entry.thumb && match.poster) entry.thumb = match.poster;
                mutated = true;
            }
        } catch (e) {
            // Couldn't resolve now (search failed / rate limited) — retried on the next render.
        }
    }

    for (const entry of list) {
        if (entry.deleted) continue;
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

    // Fetch the AniList lists once (a single call returns every list) so all enabled rows can render.
    const anilistLists = (await isAnilistLoggedIn())
        ? await fetchAnilistLists().catch(() => null)
        : null;

    waitFor(".latest-release", async latestRelease => {
        if (document.querySelector("#animepahe-watchlist")) return;

        const settings = await getSettings();
        const rowsHtml = await buildRows(list, anilistLists);
        const body = rowsHtml
            ? `<div class="apw-rows">${rowsHtml}</div>`
            : buildPlaceholder();

        const gear = settings.showSettingsButton !== false
            ? `<button class="apw-settings-gear apw-settings-gear-header" aria-label="Open settings">${GEAR_SVG}</button>`
            : "";

        const section = document.createElement("div");
        section.id = "animepahe-watchlist";

        section.innerHTML = `
            <div class="apw-header">
                <h2>Animepahe Watchlist</h2>
                ${gear}
            </div>

            ${body}
        `;

        const gearBtn = section.querySelector(".apw-settings-gear");
        if (gearBtn) gearBtn.addEventListener("click", togglePanel);

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

            // AniList card → search AnimePahe for the title and open it (no known local URL).
            const alOpen = e.target.closest(".apw-al-open");
            if (alOpen) {
                e.preventDefault();
                const wrap = alOpen.closest(".apw-wrap");
                const alTitle = wrap?.getAttribute("data-al-title");
                if (alTitle) {
                    wrap.classList.add("apw-resolving");
                    const opened = await openAnilistEntry(alTitle);
                    if (!opened) wrap.classList.remove("apw-resolving");   // no match — undo loading
                }
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
                    if (entry.animeId != null) sessionStorage.setItem("apw-nav-anime-id", String(entry.animeId));
                    window.location.href = freshUrl;
                } catch (err) {
                    console.error("[APW] URL resolution failed, opening stored URL:", err);
                    window.location.href = linkEl.href;
                }
            }
        });

        // Wire each row's slider independently (arrows + drag-scroll).
        const step = CARD_WIDTH + CARD_GAP;
        section.querySelectorAll(".apw-slider-wrap").forEach(wrap => {
            const arrowLeft = wrap.querySelector(".apw-arrow-left");
            const arrowRight = wrap.querySelector(".apw-arrow-right");
            const slider = wrap.querySelector(".apw-list");
            if (!(arrowLeft && arrowRight && slider)) return;

            arrowLeft.addEventListener("click", () => {
                slider.scrollBy({ left: -step * 3, behavior: "smooth" });
            });
            arrowRight.addEventListener("click", () => {
                slider.scrollBy({ left: step * 3, behavior: "smooth" });
            });
            slider.addEventListener("scroll", () => updateArrowsForList(slider));
            enableDragScroll(slider);
        });

        latestRelease.parentNode.insertBefore(section, latestRelease);

        requestAnimationFrame(async () => {
            updateArrows();
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
let panelSide = "right";

function hostCss(open, side = panelSide) {
    const isLeft = side === "left";
    const offscreen = isLeft ? "translateX(-100%)" : "translateX(100%)";
    return [
        "position:fixed",
        "top:0",
        isLeft ? "left:0" : "right:0",
        "height:100vh",
        `width:${PANEL_WIDTH}px`,
        "max-width:92vw",
        "margin:0",
        "padding:0",
        "border:none",
        "overflow:hidden",
        "background:#111",
        "z-index:2147483647",
        `box-shadow:${isLeft ? "6px" : "-6px"} 0 28px rgba(0,0,0,0.5)`,
        "transition:transform .22s ease",
        `transform:${open ? "translateX(0)" : offscreen}`
    ].map(d => `${d} !important`).join(";");
}

function applyPanelSide(side) {
    panelSide = side === "left" ? "left" : "right";
    if (panelHost) panelHost.style.cssText = hostCss(panelOpen);
}

function formatRotationTime(ts) {
    if (!ts) return "never";
    const d = new Date(ts);
    const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    return `${date}, ${time}`;
}

async function buildPanel() {
    if (panelHost) return;

    const initialSettings = await getSettings();
    panelSide = initialSettings.panelSide === "left" ? "left" : "right";

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

    const rotationLog = await getRotationLog();
    const rotationText = rotationLog.count
        ? `${rotationLog.count} detected · last ${formatRotationTime(rotationLog.lastTs)}`
        : "None detected yet";

    const anilistLoggedIn = await isAnilistLoggedIn();
    const anilistProfile = await storageGet(ANILIST_PROFILE_KEY, null);
    // The Rows manager lists every available row in display order: the two native rows always, and
    // the AniList lists when signed in. Each row has reorder controls and a show/hide toggle.
    const rowDefs = await availableRowDefs(settings);
    const rowManagerItems = rowDefs.map(def => `
        <div class="apw-row-item" data-row-id="${escapeHtml(def.id)}">
            <div class="apw-row-reorder">
                <button class="apw-row-up" aria-label="Move up" title="Move up">↑</button>
                <button class="apw-row-down" aria-label="Move down" title="Move down">↓</button>
            </div>
            <label class="apw-toggle apw-row-item-toggle"><span>${escapeHtml(def.title)}</span><input type="checkbox" data-setting="${def.setting}"></label>
        </div>
    `).join("");
    const rowsDesc = anilistLoggedIn
        ? `Signed in as ${escapeHtml(anilistProfile?.name || "AniList user")}. Reorder rows and choose which appear on the widget.`
        : `Reorder your rows and choose which appear. Log in from the extension popup (AniList section) to add your AniList lists as rows.`;

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
                <div class="apw-alignment-row">
                    <span class="apw-align-label">Panel side</span>
                    <div class="apw-align-btns">
                        <button class="apw-align-btn" data-side="left">Left</button>
                        <button class="apw-align-btn" data-side="right">Right</button>
                    </div>
                </div>
                <label class="apw-toggle"><span>Show settings button on widget</span><input type="checkbox" data-setting="showSettingsButton"></label>
                <label class="apw-toggle"><span>Show airing countdowns</span><input type="checkbox" data-setting="showCountdowns"></label>
                <label class="apw-toggle"><span>Show new episode badges</span><input type="checkbox" data-setting="showNewEpisodeBadges"></label>
                <label class="apw-toggle"><span>Show episode number</span><input type="checkbox" data-setting="showEpisodeNumber"></label>
                <div class="apw-combo-group">
                    <label class="apw-toggle apw-combo-toggle"><span>Show progress episodes</span><input type="checkbox" data-setting="showProgress"></label>
                    <div class="apw-alignment-row apw-combo-sub apw-progress-mode-row">
                        <span class="apw-align-label">Format</span>
                        <div class="apw-align-btns">
                            <button class="apw-align-btn" data-progress-mode="current" title="e.g. Watched 9 of 9">Current eps</button>
                            <button class="apw-align-btn" data-progress-mode="total" title="e.g. Watched 9 of 13">Total eps</button>
                        </div>
                    </div>
                </div>
                <label class="apw-toggle"><span>Show last watched time</span><input type="checkbox" data-setting="showLastWatched"></label>
            </section>
            <section class="apw-panel-section">
                <div class="apw-section-header">
                    <h3 class="apw-section-title">Player</h3>
                    <p class="apw-section-desc">Controls that appear on AnimePahe video pages.</p>
                </div>
                <label class="apw-toggle"><span>Show auto-play next on play page <span class="apw-section-badge">Beta</span></span><input type="checkbox" data-setting="showAutoPlayPill"></label>
                <label class="apw-toggle apw-toggle-disabled"><span>Resume from last position <span class="apw-section-badge">Coming soon</span></span><input type="checkbox" disabled></label>
                <label class="apw-toggle apw-toggle-disabled"><span>Skip intro / outro (AniSkip) <span class="apw-section-badge">Coming soon</span></span><input type="checkbox" disabled></label>
            </section>
            <section class="apw-panel-section">
                <div class="apw-section-header">
                    <h3 class="apw-section-title">Rows</h3>
                    <p class="apw-section-desc">${rowsDesc}</p>
                </div>
                <div class="apw-rows-manager">${rowManagerItems}</div>
            </section>
        </div>
        <footer class="apw-panel-footer">
            <span>v${version}</span>
        </footer>
    `;
    root.appendChild(wrap);

    const setActiveAlign = align => {
        wrap.querySelectorAll(".apw-align-btn[data-align]").forEach(btn => {
            btn.classList.toggle("apw-align-btn-active", btn.dataset.align === align);
        });
    };
    setActiveAlign(alignment);

    const setActiveSide = side => {
        wrap.querySelectorAll(".apw-align-btn[data-side]").forEach(btn => {
            btn.classList.toggle("apw-align-btn-active", btn.dataset.side === side);
        });
    };
    setActiveSide(panelSide);

    wrap.querySelectorAll(".apw-align-btn[data-align]").forEach(btn => {
        btn.addEventListener("click", async () => {
            await saveSettings({ cardAlignment: btn.dataset.align });
            setActiveAlign(btn.dataset.align);
        });
    });

    wrap.querySelectorAll(".apw-align-btn[data-side]").forEach(btn => {
        btn.addEventListener("click", async () => {
            await saveSettings({ panelSide: btn.dataset.side });
            setActiveSide(btn.dataset.side);
            applyPanelSide(btn.dataset.side);
        });
    });

    const setActiveProgressMode = mode => {
        wrap.querySelectorAll(".apw-align-btn[data-progress-mode]").forEach(btn => {
            btn.classList.toggle("apw-align-btn-active", btn.dataset.progressMode === mode);
        });
    };
    setActiveProgressMode(settings.progressMode || "current");

    wrap.querySelectorAll(".apw-align-btn[data-progress-mode]").forEach(btn => {
        btn.addEventListener("click", async () => {
            await saveSettings({ progressMode: btn.dataset.progressMode });
            setActiveProgressMode(btn.dataset.progressMode);
            document.querySelectorAll("#animepahe-watchlist .apw-wrap").forEach(card => updateProgressText(card));
        });
    });

    const progressModeRow = wrap.querySelector(".apw-progress-mode-row");
    const syncProgressModeVisibility = () => {
        const showProgressInput = wrap.querySelector("input[data-setting='showProgress']");
        if (progressModeRow) progressModeRow.classList.toggle("apw-combo-disabled", !showProgressInput?.checked);
    };

    wrap.querySelectorAll(".apw-toggle input").forEach(input => {
        const key = input.dataset.setting;
        input.checked = settings[key] !== false;
        input.addEventListener("change", async () => {
            await saveSettings({ [key]: input.checked });
            if (key === "showSettingsButton" && isHomePage) {
                refreshWatchlist();
            }
            if (key === "showAutoPlayPill" && isPlayPage) {
                if (input.checked) injectAutoPlayPill();
                else removeAutoPlayPill();
            }
            if (key === "showProgress") {
                syncProgressModeVisibility();
                document.querySelectorAll("#animepahe-watchlist .apw-wrap").forEach(card => updateProgressText(card));
            }
            // Toggling a row's visibility (native rowWatching/rowPlan or an alRow*) rebuilds the widget.
            if ((key.startsWith("row") || key.startsWith("alRow")) && isHomePage) {
                refreshWatchlist();
            }
        });
    });

    // Row reorder (↑/↓): move the item in the manager, persist the new order, rebuild the widget.
    wrap.querySelectorAll(".apw-row-up, .apw-row-down").forEach(btn => {
        btn.addEventListener("click", async () => {
            const item = btn.closest(".apw-row-item");
            const manager = item?.parentElement;
            if (!item || !manager) return;

            if (btn.classList.contains("apw-row-up")) {
                const prev = item.previousElementSibling;
                if (prev) manager.insertBefore(item, prev);
            } else {
                const next = item.nextElementSibling;
                if (next) manager.insertBefore(next, item);
            }

            const order = [...manager.querySelectorAll(".apw-row-item")].map(el => el.dataset.rowId);
            await saveSettings({ rowOrder: order });
            if (isHomePage) refreshWatchlist();
        });
    });

    syncProgressModeVisibility();

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

// A card for one of the logged-in user's AniList entries. Unlike native cards it has no
// remove/status-toggle buttons (the source of truth is AniList) and its links don't point at a
// known AnimePahe page — clicking searches AnimePahe for the title and opens the match.
function buildAnilistCard(entry, filter, hidden) {
    const title = escapeHtml(entry.title);
    const cover = escapeHtml(entry.cover || "");
    const total = entry.total || entry.aired;
    const progressText = total
        ? `${entry.progress} / ${total}`
        : `${entry.progress}`;
    const isLoading = cover ? "" : "apw-loading";

    return `
        <div
            class="apw-wrap apw-al-card${hidden ? " apw-hidden" : ""}"
            data-status="${escapeHtml(filter)}"
            data-al-title="${title}"
        >
            <div class="apw-episode">
                <div class="apw-snapshot ${isLoading}">
                    <img src="${cover}" alt="" loading="lazy" draggable="false" onerror="this.style.opacity=0.2">
                    <a href="#" class="apw-play-link apw-al-open">Open ${title}</a>
                </div>

                <div class="apw-label-wrap">
                    <div class="apw-title">
                        <a href="#" class="apw-al-open" title="${title}">${title}</a>
                    </div>

                    <div class="apw-episode-text">Ep. ${escapeHtml(String(entry.progress || 0))}</div>
                    <div class="apw-progress">${escapeHtml(progressText)}</div>
                </div>
            </div>
        </div>
    `;
}

// Search AnimePahe for an AniList entry's title and open the best match. Returns false if nothing
// resolved (AnimePahe has no plain search-results URL to fall back to), so the caller can undo the
// card's loading state.
async function openAnilistEntry(title) {
    try {
        const results = await searchAnimepahe(title);
        const match = results[0];
        if (match?.session) {
            window.location.href = `/anime/${match.session}`;
            return true;
        }
    } catch (err) {
        console.warn("[APW] AniList entry open failed:", title, err);
    }
    return false;
}

function buildCard(entry, currentFilter = "watching") {
    const status = entry.status || "watching";
    const isPlan = status === "plan";
    const hidden = status !== currentFilter;

    const thumb = entry.thumb || "";
    const animeUrl = entry.animeUrl || "#";
    const title = escapeHtml(entry.title);
    // Native AnimePahe episode wins; fall back to the AniList-numbering episode pushed by NyanTV.
    const ep = escapeHtml(String(entry.episode || entry.anilistEpisode || ""));
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

// Store the AniList-numbering episode on the watchlist entry so it syncs to other clients (NyanTV),
// and push the progress up to the signed-in AniList account (no-op when logged out / disabled).
async function persistAnilistEpisode(animeUrl, anilistEp) {
    const list = await getWatched();
    const idx = list.findIndex(item => item.animeUrl === animeUrl);
    if (idx !== -1 && list[idx].anilistEpisode !== anilistEp) {
        list[idx].anilistEpisode = anilistEp;
        await saveWatched(list);
    }
    // Reconcile with AniList every time (guarded internally): this also catches up entries whose
    // local episode was already stored before the user signed in.
    await maybePushAnilistProgress(animeUrl, anilistEp);
}

async function updateProgressText(card) {
    // AniList cards show their own "watched / total" from the account; the native-progress logic
    // below (which reads data-watchedEp) doesn't apply and would blank them.
    if (card.classList.contains("apw-al-card")) return;

    const progress = card.querySelector(".apw-progress");
    if (!progress) return;

    const settings = await getSettings();
    const watchedEp = parseFloat(card.dataset.watchedEp || "");
    const latestEp = parseFloat(card.dataset.latestEp || "");
    const anilistTotal = parseFloat(card.dataset.totalEp || "");
    const nextAiringEp = parseFloat(card.dataset.nextAiringEp || "");
    const anilistStatus = card.dataset.anilistStatus || "";
    const hasAiring = card.dataset.hasAiring === "true";

    if (isNaN(watchedEp) || isNaN(latestEp)) {
        progress.textContent = "";
        return;
    }

    // Calculate the offset between AnimePahe's continuous numbering and AniList's per-season numbering.
    // e.g. AniList says 13 eps in this cour and next ep is #14, but AnimePahe is on ep 37 → offset = 37 - 13 = 24
    let apTotal = null;
    if (!isNaN(anilistTotal)) {
        let offset = 0;
        if (!isNaN(nextAiringEp) && nextAiringEp > 1) {
            // Airing: AniList current = nextAiringEp - 1
            offset = Math.max(0, latestEp - (nextAiringEp - 1));
        } else if (anilistStatus === "FINISHED") {
            // Finished: latest AnimePahe ep - AniList total = offset (whole season is out)
            offset = Math.max(0, latestEp - anilistTotal);
        }
        apTotal = offset + anilistTotal;

        // Persist the AniList-numbering episode (continuous - offset) so other clients (NyanTV) can
        // resume at the right episode without AnimePahe's release data.
        const animeUrl = card.getAttribute("data-anime");
        const anilistEp = Math.max(1, Math.round(watchedEp - offset));
        if (animeUrl && Number.isFinite(anilistEp)) persistAnilistEpisode(animeUrl, anilistEp);
    }

    const totalMode = settings.progressMode === "total";
    const denominator = totalMode
        ? (apTotal !== null ? cleanEpisode(apTotal) : "?")
        : cleanEpisode(latestEp);

    if (latestEp > watchedEp || (latestEp === watchedEp && hasAiring) || (totalMode && (apTotal === null || apTotal > watchedEp))) {
        progress.textContent = `Watched ${cleanEpisode(watchedEp)} of ${denominator}`;
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

    // AniList login/logout happens in the popup; reflect it live on an open AnimePahe tab by
    // rebuilding the widget (adds/removes the AniList row tabs) after dropping any stale list cache.
    if (ANILIST_TOKEN_KEY in changes) {
        chrome.storage.local.remove([ANILIST_LISTS_CACHE_KEY]);
        refreshWatchlist();
        return;
    }

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

// ---------- Auto-play next episode (play page only) ----------
const AUTOPLAY_PILL_ID = "apw-autoplay-pill";
const AUTOPLAY_BAR_ID = "apw-player-bar-outer";
const AUTOPLAY_COUNTDOWN_SECONDS = 10;
const PLAY_PAGE_STYLES_ID = "apw-play-page-styles";
const AUTOPLAY_STORAGE_KEY = "apw_autoplay_next";
const AUTOPLAY_FS_STORAGE_KEY = "apw_autoplay_fullscreen";

let pendingNextUrl = null;
let autoPlayPending = false;
let autoFullscreenPending = false;
let playerIsFullscreen = false;

function getPlayerIframe() {
    return document.querySelector(".theatre .player iframe");
}

function startCountdownInIframe(nextUrl) {
    const iframe = getPlayerIframe();
    if (!iframe?.contentWindow) {
        window.location.href = nextUrl;
        return;
    }
    pendingNextUrl = nextUrl;
    iframe.contentWindow.postMessage({
        source: "apw-host",
        type: "startCountdown",
        seconds: AUTOPLAY_COUNTDOWN_SECONDS
    }, "*");
}

function cancelCountdownInIframe() {
    pendingNextUrl = null;
    const iframe = getPlayerIframe();
    iframe?.contentWindow?.postMessage({ source: "apw-host", type: "cancelCountdown" }, "*");
}

function injectPlayPageStyles() {
    if (document.getElementById(PLAY_PAGE_STYLES_ID)) return;
    const style = document.createElement("style");
    style.id = PLAY_PAGE_STYLES_ID;
    style.textContent = `
        .apw-player-bar {
            display: flex;
            align-items: center;
            justify-content: flex-end;
            gap: 8px;
            margin: 6px auto 2px;
        }
        .apw-autoplay-wrap { display: inline-flex; }
        .apw-autoplay-pill {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 5px 12px 5px 10px;
            border-radius: 999px;
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
            border: 1px solid rgba(79,140,255,0.4);
            background: rgba(79,140,255,0.14);
            color: #9cccff;
            transition: background 0.15s;
            font-family: inherit;
        }
        .apw-autoplay-pill:hover { background: rgba(79,140,255,0.22); }
        .apw-autoplay-pill:disabled { opacity: 0.45; cursor: not-allowed; }
        .apw-autoplay-pill.apw-autoplay-off {
            border-color: rgba(255,255,255,0.14);
            background: rgba(255,255,255,0.05);
            color: rgba(255,255,255,0.55);
        }
        .apw-autoplay-switch {
            width: 26px;
            height: 14px;
            border-radius: 999px;
            background: rgba(79,140,255,0.45);
            position: relative;
            flex-shrink: 0;
            transition: background 0.15s;
        }
        .apw-autoplay-switch::after {
            content: "";
            position: absolute;
            top: 1px;
            left: 13px;
            width: 12px;
            height: 12px;
            border-radius: 50%;
            background: #9cccff;
            transition: left 0.15s, background 0.15s;
        }
        .apw-autoplay-pill.apw-autoplay-off .apw-autoplay-switch {
            background: rgba(255,255,255,0.15);
        }
        .apw-autoplay-pill.apw-autoplay-off .apw-autoplay-switch::after {
            left: 1px;
            background: rgba(255,255,255,0.55);
        }
    `;
    document.head.appendChild(style);
}

function getNextEpisodeElement() {
    const active = document.querySelector(".episode-menu .dropdown-item.active");
    if (!active) return null;
    let sibling = active.nextElementSibling;
    while (sibling && !sibling.classList.contains("dropdown-item")) {
        sibling = sibling.nextElementSibling;
    }
    return sibling || null;
}

async function getNextEpisodeUrl() {
    const el = getNextEpisodeElement();
    if (!el) return null;

    // Extract the next episode number from the dropdown item text (e.g. "5").
    const numMatch = el.textContent.trim().match(/(\d+(?:\.\d+)?)/);
    const epNum = numMatch ? parseFloat(numMatch[1]) : NaN;
    if (isNaN(epNum)) return el.href || null;

    // Primary: resolve via the same search-based path the widget cards use.
    // This re-derives a fresh anime session every time, so it survives
    // AnimePahe rotating its session IDs while the episode was playing.
    const animeLink = document.querySelector('a[href^="/anime/"]');
    const animeHref = animeLink ? animeLink.getAttribute("href") : null;
    const titleMatch = (document.title || "").match(/^(.+?) Ep\.\s*\S+\s*::/);
    const pageTitle = titleMatch ? titleMatch[1].trim() : null;

    let entry = null;
    if (animeHref) {
        const list = await getWatched();
        entry = list.find(item => item.animeUrl === animeHref) || null;
    }

    if (entry) {
        // Known watched entry (usually carries animeId for an exact match).
        try {
            return await resolveFreshUrl({ ...entry, episode: epNum }, "play");
        } catch {}
    }

    // Secondary: resolve the episode against the current URL's anime session.
    // Accurate (definitely the right anime) and usually still fresh.
    const animeSession = window.location.pathname.split("/")[2];
    if (animeSession) {
        try {
            const epSession = await findEpisodeSession(animeSession, epNum);
            if (epSession) return `/play/${animeSession}/${epSession}`;
        } catch {}
    }

    // Tertiary: search by the page title (rotation-proof, no watched entry).
    if (pageTitle) {
        try {
            return await resolveFreshUrl({ title: pageTitle, animeUrl: animeHref, episode: epNum }, "play");
        } catch {}
    }

    // Last resort: the raw (possibly stale) dropdown href.
    return el.href || null;
}

async function injectAutoPlayPill() {
    const settings = await getSettings();
    if (settings.showAutoPlayPill === false) return;

    const player = document.querySelector(".theatre .player");
    if (!player) return;
    if (document.getElementById(AUTOPLAY_PILL_ID)) return;

    // Ensure iframe has autoplay permission for future navigations
    const iframe = getPlayerIframe();
    if (iframe && !iframe.allow?.includes("autoplay")) {
        iframe.allow = (iframe.allow ? iframe.allow + "; " : "") + "autoplay";
    }

    let bar = document.getElementById(AUTOPLAY_BAR_ID);
    if (!bar) {
        bar = document.createElement("div");
        bar.id = AUTOPLAY_BAR_ID;
        bar.className = "apw-player-bar";
        player.insertAdjacentElement("afterend", bar);

        const syncWidth = () => {
            bar.style.width = player.offsetWidth + "px";
        };
        syncWidth();
        if (typeof ResizeObserver !== "undefined") {
            new ResizeObserver(syncWidth).observe(player);
        } else {
            window.addEventListener("resize", syncWidth);
        }
    }

    const wrap = document.createElement("div");
    wrap.id = AUTOPLAY_PILL_ID;
    wrap.className = "apw-autoplay-wrap";

    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "apw-autoplay-pill";
    pill.innerHTML = `<span class="apw-autoplay-switch"></span><span class="apw-autoplay-label">Auto-play next</span>`;

    if (!getNextEpisodeElement()) {
        pill.disabled = true;
        pill.title = "No next episode available";
    }

    const applyState = enabled => {
        pill.classList.toggle("apw-autoplay-off", !enabled);
        pill.setAttribute("aria-pressed", String(enabled));
    };
    applyState(settings.autoPlayNext !== false);

    pill.addEventListener("click", async () => {
        if (pill.disabled) return;
        const current = await getSettings();
        const next = current.autoPlayNext === false ? true : false;
        await saveSettings({ autoPlayNext: next });
        applyState(next);
        if (!next) cancelCountdownInIframe();
    });

    wrap.appendChild(pill);
    bar.appendChild(wrap);
}

function removeAutoPlayPill() {
    document.getElementById(AUTOPLAY_PILL_ID)?.remove();
    const bar = document.getElementById(AUTOPLAY_BAR_ID);
    if (bar && !bar.children.length) bar.remove();
}

function sendAutoPlayToIframe() {
    const iframe = getPlayerIframe();
    if (!iframe?.contentWindow) return;
    if (!iframe.allow?.includes("autoplay")) {
        iframe.allow = (iframe.allow ? iframe.allow + "; " : "") + "autoplay";
    }
    iframe.contentWindow.postMessage({ source: "apw-host", type: "autoPlay" }, "*");
}

// Drive the two-stage autoplay:
//   1. Click .click-to-load until the overlay disappears (iframe starts loading).
//   2. Keep sending autoPlay to the iframe until playerReady clears the flag.
function tryAutoPlayInIframe(attempts = 0) {
    if (!autoPlayPending) return;

    const clickToLoad = document.querySelector(".theatre .click-to-load");
    if (clickToLoad) {
        clickToLoad.click();
    } else {
        sendAutoPlayToIframe();
    }

    if (attempts < 20) {
        setTimeout(() => tryAutoPlayInIframe(attempts + 1), 300);
    } else {
        autoPlayPending = false;
    }
}

window.addEventListener("message", async event => {
    if (event.data?.source !== "apw-player") return;
    if (!isPlayPage) return;

    const { type } = event.data;

    if (type === "videoEnded") {
        const settings = await getSettings();
        if (settings.autoPlayNext === false) return;
        if (settings.showAutoPlayPill === false) return;
        const nextUrl = await getNextEpisodeUrl();
        if (!nextUrl) return;
        startCountdownInIframe(nextUrl);
        return;
    }

    if (type === "countdownDone" && pendingNextUrl) {
        const target = pendingNextUrl;
        pendingNextUrl = null;
        sessionStorage.setItem(AUTOPLAY_STORAGE_KEY, "1");
        if (playerIsFullscreen) sessionStorage.setItem(AUTOPLAY_FS_STORAGE_KEY, "1");
        window.location.href = target;
        return;
    }

    if (type === "fullscreenState") {
        playerIsFullscreen = !!event.data.isFullscreen;
        return;
    }

    if (type === "countdownCancelled") {
        pendingNextUrl = null;
    }

    if (type === "playerReady") {
        if (autoPlayPending) {
            autoPlayPending = false;
            sendAutoPlayToIframe();
        }
        if (autoFullscreenPending) {
            autoFullscreenPending = false;
            const iframe = getPlayerIframe();
            iframe?.contentWindow?.postMessage(
                { source: "apw-host", type: "enterFullscreen" },
                "*"
            );
        }
    }
});

// ---------- Run ----------
if (isPlayPage) {
    getSettings().then(settings => {
        if (settings.widgetEnabled !== false) {
            trySaveWithRetry();
        }
    });
    checkAutoOpenFlag();
    injectPlayPageStyles();
    injectAutoPlayPill();
    const playPageObserver = new MutationObserver(() => injectAutoPlayPill());
    playPageObserver.observe(document.body, { childList: true, subtree: true });

    if (sessionStorage.getItem(AUTOPLAY_STORAGE_KEY)) {
        sessionStorage.removeItem(AUTOPLAY_STORAGE_KEY);
        autoPlayPending = true;
        if (sessionStorage.getItem(AUTOPLAY_FS_STORAGE_KEY)) {
            sessionStorage.removeItem(AUTOPLAY_FS_STORAGE_KEY);
            autoFullscreenPending = true;
        }
        tryAutoPlayInIframe();
    }
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