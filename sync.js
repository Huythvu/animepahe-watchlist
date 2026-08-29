import { doc, getDoc, setDoc, Timestamp, increment, deleteField } from "firebase/firestore";
import { db } from "./firebase-config.js";

const STORAGE_KEY = "recently_watched";
const SYNC_KEY = "apw_sync_key";
const DEVICE_ID_KEY = "apw_device_id";
// content.js caches resolved AniList ids here (animeUrl -> anilistId | null). We fold them into the
// synced record so other clients (e.g. NyanTV) can match entries by AniList id instead of title.
const ANILIST_ID_CACHE_KEY = "apw_anilist_id_cache";

async function getAniListIdCache() {
    const data = await chrome.storage.local.get([ANILIST_ID_CACHE_KEY]);
    return data[ANILIST_ID_CACHE_KEY] || {};
}

const SYNC_WORDS = [
    "mango", "tiger", "cloud", "ramen", "orbit",
    "river", "pixel", "storm", "melon", "paper",
    "toast", "lemon", "panda", "ocean", "berry",
    "comet", "pearl", "sunny", "yuzu", "apple",
    "coral", "ember", "frost", "hazel", "jelly",
    "kiwi", "lotus", "maple", "night", "olive",
    "peach", "quiet", "rain", "snow", "tea",
    "umber", "wave", "xenon", "zen", "fox",
    "moon", "star", "candy", "dango", "echo",
    "flame", "glow", "honey", "iris", "jade",
    "koala", "lime", "mist", "nova", "onyx",
    "plum", "rose", "shell", "tulip", "unity",
    "zebra", "acorn", "dream", "eagle", "ink",
    "karma", "neon", "ruby", "yarn", "dawn",
    "dusk", "fern", "cove", "grove", "cedar"
];

export function generateSyncKey() {
    const pool = [...SYNC_WORDS];
    const words = [];

    for (let i = 0; i < 5; i++) {
        const randomNumber = crypto.getRandomValues(new Uint32Array(1))[0];
        const index = randomNumber % pool.length;
        words.push(pool.splice(index, 1)[0]);
    }

    return words.join(" ");
}

export async function getLocalSyncKey() {
    const data = await chrome.storage.local.get([SYNC_KEY]);
    return data[SYNC_KEY] || "";
}

export async function clearLocalSyncKey() {
    await chrome.storage.local.remove(SYNC_KEY);
}

export function validateSyncKey(syncKey) {
    const normalized = normalizeSyncKey(syncKey);
    const words = normalized.split(" ");

    if (!normalized || words.length !== 5) {
        return "Phrase must be exactly 5 words";
    }

    const invalid = words.filter(w => !SYNC_WORDS.includes(w));

    if (invalid.length > 0) {
        return `Unknown word${invalid.length > 1 ? "s" : ""}: ${invalid.join(", ")}`;
    }

    if (new Set(words).size !== words.length) {
        return "Phrase cannot contain repeated words";
    }

    return null;
}

export async function saveLocalSyncKey(syncKey) {
    const normalized = normalizeSyncKey(syncKey);

    if (!isValidSyncKey(normalized)) {
        throw new Error("Sync phrase must be 5 valid words");
    }

    await chrome.storage.local.set({
        [SYNC_KEY]: normalized
    });
}

async function getDeviceId() {
    const data = await chrome.storage.local.get([DEVICE_ID_KEY]);
    if (data[DEVICE_ID_KEY]) return data[DEVICE_ID_KEY];
    const id = crypto.randomUUID();
    await chrome.storage.local.set({ [DEVICE_ID_KEY]: id });
    return id;
}

async function buildMetadata() {
    let platformOs = "unknown";
    try {
        const platform = await chrome.runtime.getPlatformInfo();
        platformOs = platform.os || "unknown";
    } catch {}

    return {
        "3_syncCount": increment(1),
        "4_extensionVersion": chrome.runtime.getManifest().version,
        "5_lastDevicePlatform": platformOs,
        "6_deviceId": await getDeviceId()
    };
}

const LEGACY_FIELD_CLEANUP = {
    createdAt: deleteField(),
    updatedAt: deleteField(),
    syncCount: deleteField(),
    extensionVersion: deleteField(),
    lastDevicePlatform: deleteField(),
    deviceId: deleteField()
};

export async function uploadWatchlist(syncKey) {
    const docId = await syncKeyToDocumentId(syncKey);

    const data = await chrome.storage.local.get([STORAGE_KEY]);
    const items = data[STORAGE_KEY] || [];
    const safeItems = sanitizeItems(items, await getAniListIdCache());

    const docRef = doc(db, "watchlists", docId);
    const snap = await getDoc(docRef);
    const existingCreatedAt = snap.exists()
        ? (snap.data()["1_createdAt"] || snap.data().createdAt)
        : null;
    const metadata = await buildMetadata();

    const writeData = {
        items: safeItems,
        "2_updatedAt": Timestamp.now(),
        ...metadata,
        ...LEGACY_FIELD_CLEANUP
    };
    if (!existingCreatedAt) writeData["1_createdAt"] = Timestamp.now();

    await setDoc(docRef, writeData, { merge: true });

    return safeItems.length;
}

export async function downloadWatchlist(syncKey) {
    const docId = await syncKeyToDocumentId(syncKey);

    const snap = await getDoc(doc(db, "watchlists", docId));

    if (!snap.exists()) {
        await chrome.storage.local.set({
            [STORAGE_KEY]: []
        });

        return 0;
    }

    const data = snap.data();
    const items = sanitizeItems(Array.isArray(data.items) ? data.items : []);

    await chrome.storage.local.set({
        [STORAGE_KEY]: items
    });

    return items.length;
}

export async function syncWatchlist(syncKey) {
    const docId = await syncKeyToDocumentId(syncKey);

    const localData = await chrome.storage.local.get([STORAGE_KEY]);
    const localItems = localData[STORAGE_KEY] || [];

    const docRef = doc(db, "watchlists", docId);
    const snap = await getDoc(docRef);

    if (!snap.exists()) {
        throw new Error("No watchlist found for this phrase. Use Generate to create one.");
    }

    const cloudItems = Array.isArray(snap.data().items) ? snap.data().items : [];
    const existingCreatedAt = snap.data()["1_createdAt"] || snap.data().createdAt || null;

    const mergedItems = mergeWatchlists(localItems, cloudItems);

    await chrome.storage.local.set({
        [STORAGE_KEY]: mergedItems
    });

    const metadata = await buildMetadata();

    const writeData = {
        items: sanitizeItems(mergedItems, await getAniListIdCache()),
        "2_updatedAt": Timestamp.now(),
        ...metadata,
        ...LEGACY_FIELD_CLEANUP
    };
    if (!existingCreatedAt) writeData["1_createdAt"] = Timestamp.now();

    await setDoc(docRef, writeData, { merge: true });

    return mergedItems.length;
}

// Push local changes to the cloud WITHOUT clobbering cloud-only entries (e.g. watches pushed from
// NyanTV): pull the cloud doc, merge, and write the union back. Unlike syncWatchlist it does NOT
// write local storage, so it can be triggered by a local-storage change without looping.
export async function mergeUpload(syncKey) {
    const docId = await syncKeyToDocumentId(syncKey);

    const localData = await chrome.storage.local.get([STORAGE_KEY]);
    const localItems = localData[STORAGE_KEY] || [];

    const docRef = doc(db, "watchlists", docId);
    const snap = await getDoc(docRef);
    const cloudItems = snap.exists() && Array.isArray(snap.data().items) ? snap.data().items : [];
    const existingCreatedAt = snap.exists()
        ? (snap.data()["1_createdAt"] || snap.data().createdAt)
        : null;

    const mergedItems = mergeWatchlists(localItems, cloudItems);
    const metadata = await buildMetadata();

    const writeData = {
        items: sanitizeItems(mergedItems, await getAniListIdCache()),
        "2_updatedAt": Timestamp.now(),
        ...metadata,
        ...LEGACY_FIELD_CLEANUP
    };
    if (!existingCreatedAt) writeData["1_createdAt"] = Timestamp.now();

    await setDoc(docRef, writeData, { merge: true });

    return mergedItems.length;
}

async function syncKeyToDocumentId(syncKey) {
    const normalized = normalizeSyncKey(syncKey);

    if (!isValidSyncKey(normalized)) {
        throw new Error("Sync phrase must be 5 valid words");
    }

    const encoded = new TextEncoder().encode(normalized);
    const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
    const hashArray = Array.from(new Uint8Array(hashBuffer));

    const hashHex = hashArray
        .map(byte => byte.toString(16).padStart(2, "0"))
        .join("");

    return `sync_${hashHex}`;
}

function normalizeSyncKey(syncKey) {
    return String(syncKey || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z\s-]/g, "")
        .replace(/-/g, " ")
        .replace(/\s+/g, " ");
}

function isValidSyncKey(normalized) {
    const words = normalized.split(" ");

    return words.length === 5 &&
        words.every(word => SYNC_WORDS.includes(word));
}

// Identity for merging. Prefer the AnimePahe URL (native entries); fall back to the AniList id so
// entries pushed from another client (e.g. NyanTV) that have no animeUrl yet still merge/dedup.
function itemKey(item) {
    if (item.animeUrl) return item.animeUrl;
    if (Number.isInteger(item.anilistId)) return `al:${item.anilistId}`;
    return null;
}

function mergeWatchlists(localItems, cloudItems) {
    const map = new Map();

    for (const item of cloudItems || []) {
        const key = itemKey(item);
        if (!key) continue;
        map.set(key, item);
    }

    for (const item of localItems || []) {
        const key = itemKey(item);
        if (!key) continue;

        const existing = map.get(key);

        if (!existing) {
            map.set(key, item);
            continue;
        }

        const localTime = Math.max(item.ts || 0, item.statusTs || 0);
        const cloudTime = Math.max(existing.ts || 0, existing.statusTs || 0);

        map.set(key, localTime >= cloudTime ? item : existing);
    }

    return Array.from(map.values())
        .sort((a, b) => {
            const aTime = Math.max(a.ts || 0, a.statusTs || 0);
            const bTime = Math.max(b.ts || 0, b.statusTs || 0);
            return bTime - aTime;
        })
        .slice(0, 200);

}

function sanitizeItems(items, anilistIdByUrl = {}) {
    return items
        .slice(0, 200)
        .map(item => {
            const out = {
                title: String(item.title || ""),
                episode: item.episode ? String(item.episode) : "",
                playUrl: String(item.playUrl || ""),
                animeUrl: String(item.animeUrl || ""),
                thumb: String(item.thumb || ""),
                ts: Number(item.ts || Date.now()),
                status: item.status === "plan" ? "plan" : "watching",
                statusTs: Number(item.statusTs || item.ts || Date.now())
            };
            if (Number.isInteger(item.animeId)) out.animeId = item.animeId;
            // Cross-client join key: use the entry's own id, else the cached lookup for its animeUrl.
            const anilistId = Number.isInteger(item.anilistId)
                ? item.anilistId
                : anilistIdByUrl[item.animeUrl];
            if (Number.isInteger(anilistId) && anilistId > 0) out.anilistId = anilistId;
            // Episode in AniList-entry numbering, pushed by other clients (NyanTV) — shown when the
            // entry has no native AnimePahe episode.
            if (Number.isInteger(item.anilistEpisode) && item.anilistEpisode > 0) out.anilistEpisode = item.anilistEpisode;
            return out;
        })
        // Keep native entries (have an animeUrl) and cross-client entries (have an AniList id but no
        // animeUrl yet — the content script backfills the link on demand).
        .filter(item => item.title && (item.animeUrl || Number.isInteger(item.anilistId)));
}