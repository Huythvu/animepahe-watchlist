import { doc, getDoc, setDoc, Timestamp, increment } from "firebase/firestore";
import { db } from "./firebase-config.js";

const STORAGE_KEY = "recently_watched";
const SYNC_KEY = "apw_sync_key";
const DEVICE_ID_KEY = "apw_device_id";

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
        lastDevicePlatform: platformOs,
        extensionVersion: chrome.runtime.getManifest().version,
        deviceId: await getDeviceId(),
        syncCount: increment(1)
    };
}

export async function uploadWatchlist(syncKey) {
    const docId = await syncKeyToDocumentId(syncKey);

    const data = await chrome.storage.local.get([STORAGE_KEY]);
    const items = data[STORAGE_KEY] || [];
    const safeItems = sanitizeItems(items);

    const docRef = doc(db, "watchlists", docId);
    const snap = await getDoc(docRef);
    const existingCreatedAt = snap.exists() ? snap.data().createdAt : null;
    const metadata = await buildMetadata();

    const writeData = {
        items: safeItems,
        updatedAt: Timestamp.now(),
        ...metadata
    };
    if (!existingCreatedAt) writeData.createdAt = Timestamp.now();

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
    const existingCreatedAt = snap.data().createdAt || null;

    const mergedItems = mergeWatchlists(localItems, cloudItems);

    await chrome.storage.local.set({
        [STORAGE_KEY]: mergedItems
    });

    const metadata = await buildMetadata();

    const writeData = {
        items: sanitizeItems(mergedItems),
        updatedAt: Timestamp.now(),
        ...metadata
    };
    if (!existingCreatedAt) writeData.createdAt = Timestamp.now();

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
            return out;
        })
        .filter(item => item.title && item.animeUrl);
}