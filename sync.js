import { doc, getDoc, setDoc } from "firebase/firestore";
import { db } from "./firebase-config.js";

const STORAGE_KEY = "recently_watched";
const SYNC_KEY = "apw_sync_key";
const LAST_SYNCED_KEY = "apw_last_synced";

const SYNC_WORDS = [
    "mango", "tiger", "cloud", "ramen", "orbit",
    "river", "pixel", "storm", "bamboo", "melon",
    "dragon", "paper", "sakura", "toast", "rocket",
    "forest", "lemon", "shadow", "silver", "panda",
    "ocean", "berry", "comet", "lantern", "noodle",
    "pearl", "sunny", "violet", "winter", "yuzu",
    "apple", "coral", "ember", "frost", "ginger",
    "hazel", "island", "jelly", "kiwi", "lotus",
    "maple", "night", "olive", "peach", "quiet",
    "rain", "snow", "tea", "umber", "velvet",
    "wave", "xenon", "yellow", "zen", "fox",
    "moon", "star", "breeze", "candy", "dango",
    "echo", "flame", "glow", "honey", "iris",
    "jade", "koala", "lime", "mist", "nova",
    "onyx", "plum", "quartz", "rose", "shell",
    "tulip", "unity", "valley", "willow", "zebra",
    "acorn", "blossom", "coconut", "dream", "eagle",
    "feather", "garden", "harbor", "ink", "jungle",
    "karma", "lagoon", "meadow", "neon", "orange",
    "penguin", "quokka", "ruby", "spirit", "temple",
    "umbrella", "vanilla", "whisper", "yarn", "zephyr"
];

export function generateSyncKey() {
    const words = [];

    for (let i = 0; i < 5; i++) {
        const randomNumber = crypto.getRandomValues(new Uint32Array(1))[0];
        const index = randomNumber % SYNC_WORDS.length;
        words.push(SYNC_WORDS[index]);
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

export async function getLastSyncedAt() {
    const data = await chrome.storage.local.get([LAST_SYNCED_KEY]);
    return data[LAST_SYNCED_KEY] || null;
}

async function saveLastSyncedAt() {
    await chrome.storage.local.set({ [LAST_SYNCED_KEY]: Date.now() });
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

export async function uploadWatchlist(syncKey) {
    const docId = await syncKeyToDocumentId(syncKey);

    const data = await chrome.storage.local.get([STORAGE_KEY]);
    const items = data[STORAGE_KEY] || [];
    const safeItems = sanitizeItems(items);

    await setDoc(doc(db, "watchlists", docId), {
        updatedAt: Date.now(),
        items: safeItems
    });

    await saveLastSyncedAt();
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

    const snap = await getDoc(doc(db, "watchlists", docId));

    const cloudItems = snap.exists() && Array.isArray(snap.data().items)
        ? snap.data().items
        : [];

    const mergedItems = mergeWatchlists(localItems, cloudItems);

    await chrome.storage.local.set({
        [STORAGE_KEY]: mergedItems
    });

    await setDoc(doc(db, "watchlists", docId), {
        updatedAt: Date.now(),
        items: sanitizeItems(mergedItems)
    });

    await saveLastSyncedAt();
    return mergedItems.length;
}

export async function autoUploadWatchlist() {
    const syncKey = await getLocalSyncKey();

    if (!syncKey) {
        console.log("Auto-upload skipped: no sync phrase saved");
        return false;
    }

    await uploadWatchlist(syncKey);
    return true;
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

function isValidSyncKey(syncKey) {
    const normalized = normalizeSyncKey(syncKey);
    const words = normalized.split(" ");

    return words.length === 5 &&
        words.every(word => SYNC_WORDS.includes(word));
}

function mergeWatchlists(localItems, cloudItems) {
    const map = new Map();

    for (const item of cloudItems || []) {
        if (!item.animeUrl) continue;
        map.set(item.animeUrl, item);
    }

    for (const item of localItems || []) {
        if (!item.animeUrl) continue;

        const existing = map.get(item.animeUrl);

        if (!existing) {
            map.set(item.animeUrl, item);
            continue;
        }

        const localTime = Math.max(item.ts || 0, item.statusTs || 0);
        const cloudTime = Math.max(existing.ts || 0, existing.statusTs || 0);

        map.set(item.animeUrl, localTime >= cloudTime ? item : existing);
    }

    return Array.from(map.values())
        .sort((a, b) => {
            const aTime = Math.max(a.ts || 0, a.statusTs || 0);
            const bTime = Math.max(b.ts || 0, b.statusTs || 0);
            return bTime - aTime;
        })
        .slice(0, 200);
}

function sanitizeItems(items) {
    return items
        .slice(0, 200)
        .map(item => ({
            title: String(item.title || ""),
            episode: item.episode ? String(item.episode) : "",
            playUrl: String(item.playUrl || ""),
            animeUrl: String(item.animeUrl || ""),
            thumb: String(item.thumb || ""),
            ts: Number(item.ts || Date.now()),
            status: item.status === "plan" ? "plan" : "watching",
            statusTs: Number(item.statusTs || item.ts || Date.now())
        }))
        .filter(item => item.title && item.animeUrl);
}