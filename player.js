// Runs inside the kwik.cx iframe embedded on AnimePahe play pages.
// Detects when the video ends and notifies the parent (animepahe.pw).
// Renders the auto-play countdown overlay inside the iframe so it
// stays visible in fullscreen.

const COUNTDOWN_OVERLAY_ID = "apw-countdown-overlay";
const NEAR_END_THRESHOLD_SEC = 10;
const STYLE_ID = "apw-iframe-styles";

let countdownState = null; // null | { armed: bool, cancelled: bool }
let activeVideo = null;

function postToParent(payload) {
    try {
        window.parent.postMessage({ source: "apw-player", ...payload }, "*");
    } catch {}
}

function getFullscreenTarget(video) {
    // Wrap the video's parent in our own container so the overlay can be a
    // sibling of (not a descendant of) the player's fading wrapper.
    const original = video.parentElement;
    if (!original) return null;

    let host = document.getElementById("apw-fs-host");
    if (host && host.contains(video)) return host;

    host = document.createElement("div");
    host.id = "apw-fs-host";
    host.style.cssText = `
        position: relative;
        width: 100%;
        height: 100%;
        margin: 0;
        padding: 0;
        background: #000;
    `;
    original.parentNode.insertBefore(host, original);
    host.appendChild(original);
    return host;
}

function patchFullscreen(video) {
    const host = getFullscreenTarget(video);
    if (!host) return;

    if (typeof video.requestFullscreen === "function") {
        video.requestFullscreen = function(opts) {
            return host.requestFullscreen(opts);
        };
    }
    if (typeof video.webkitRequestFullscreen === "function") {
        video.webkitRequestFullscreen = function() {
            return host.webkitRequestFullscreen?.();
        };
    }
    if (typeof video.webkitEnterFullscreen === "function") {
        video.webkitEnterFullscreen = function() {
            return host.webkitRequestFullscreen?.() || host.requestFullscreen?.();
        };
    }
}

function getRemaining(video) {
    if (!video || !isFinite(video.duration) || video.duration === 0) return null;
    return Math.max(0, video.duration - video.currentTime);
}

function handleTimeChange() {
    const video = activeVideo;
    const remaining = getRemaining(video);
    if (remaining === null) return;

    if (remaining < NEAR_END_THRESHOLD_SEC) {
        if (!countdownState) {
            countdownState = { armed: false, cancelled: false };
            postToParent({ type: "videoEnded" });
        } else if (countdownState.armed && !countdownState.cancelled) {
            updateCountdown(remaining);
        }
    } else if (countdownState) {
        // User seeked back out of the near-end window: reset entirely.
        countdownState = null;
        removeOverlay();
    }
}

function attachToVideo(video) {
    if (video.dataset.apwBound === "1") return;
    video.dataset.apwBound = "1";

    activeVideo = video;
    patchFullscreen(video);

    video.addEventListener("ended", () => {
        if (countdownState?.armed && !countdownState.cancelled) {
            removeOverlay();
            postToParent({ type: "countdownDone" });
            countdownState = null;
        }
    });

    ["timeupdate", "seeked", "play", "pause"].forEach(evt => {
        video.addEventListener(evt, handleTimeChange);
    });
}

function scanForVideo() {
    const video = document.querySelector("video");
    if (video) {
        const wasBound = video.dataset.apwBound === "1";
        attachToVideo(video);
        if (!wasBound) postToParent({ type: "playerReady" });
    }
}

function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
        #${COUNTDOWN_OVERLAY_ID} {
            position: fixed;
            right: 20px;
            bottom: 75px;
            z-index: 2147483647;
            display: inline-flex !important;
            align-items: center;
            gap: 10px;
            padding: 7px 8px 7px 14px;
            border-radius: 999px;
            background: rgba(15, 15, 20, 0.78);
            border: 1px solid rgba(79, 140, 255, 0.45);
            color: #fff;
            font-family: system-ui, sans-serif;
            font-size: 13px;
            font-weight: 600;
            backdrop-filter: blur(8px);
            -webkit-backdrop-filter: blur(8px);
            overflow: hidden;
            box-shadow: 0 6px 20px rgba(0, 0, 0, 0.5);
            animation: apw-cd-in 0.18s ease;
            opacity: 1 !important;
            visibility: visible !important;
            pointer-events: auto !important;
        }
        #${COUNTDOWN_OVERLAY_ID} * {
            opacity: 1 !important;
            visibility: visible !important;
        }
        #${COUNTDOWN_OVERLAY_ID}.apw-cd-fullscreen {
            right: 28px;
            bottom: 95px;
        }
        @keyframes apw-cd-in {
            from { opacity: 0; transform: translateY(6px); }
            to   { opacity: 1; transform: translateY(0); }
        }
        #${COUNTDOWN_OVERLAY_ID} .apw-cd-text {
            white-space: nowrap;
            color: rgba(255, 255, 255, 0.9);
        }
        #${COUNTDOWN_OVERLAY_ID} .apw-cd-num {
            color: #9cccff;
            font-weight: 700;
            margin: 0 2px;
        }
        #${COUNTDOWN_OVERLAY_ID} .apw-cd-cancel {
            width: 22px;
            height: 22px;
            border-radius: 50%;
            border: none;
            background: rgba(255, 255, 255, 0.1);
            color: rgba(255, 255, 255, 0.75);
            font-size: 15px;
            line-height: 1;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            padding: 0;
            font-family: inherit;
        }
        #${COUNTDOWN_OVERLAY_ID} .apw-cd-cancel:hover {
            background: rgba(255, 255, 255, 0.2);
            color: #fff;
        }
        #${COUNTDOWN_OVERLAY_ID} .apw-cd-bar {
            position: absolute;
            left: 0;
            right: 0;
            bottom: 0;
            height: 2px;
        }
        #${COUNTDOWN_OVERLAY_ID} .apw-cd-bar-fill {
            height: 100%;
            width: 100%;
            background: linear-gradient(90deg, #4f8cff, #9cccff);
        }
    `;
    document.head.appendChild(style);
}

function getFullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function applyFullscreenPlacement(overlay) {
    const fsEl = getFullscreenElement();
    overlay.classList.toggle("apw-cd-fullscreen", !!fsEl);

    const targetParent = fsEl || document.body;
    if (overlay.parentNode !== targetParent) {
        targetParent.appendChild(overlay);
    }
}

function removeOverlay() {
    document.getElementById(COUNTDOWN_OVERLAY_ID)?.remove();
    document.removeEventListener("fullscreenchange", onFullscreenChange);
    document.removeEventListener("webkitfullscreenchange", onFullscreenChange);
}

function onFullscreenChange() {
    const overlay = document.getElementById(COUNTDOWN_OVERLAY_ID);
    if (overlay) applyFullscreenPlacement(overlay);
}

function showCountdownOverlay() {
    injectStyles();
    if (document.getElementById(COUNTDOWN_OVERLAY_ID)) return;

    const overlay = document.createElement("div");
    overlay.id = COUNTDOWN_OVERLAY_ID;
    overlay.innerHTML = `
        <span class="apw-cd-text">Next episode in <span class="apw-cd-num">${NEAR_END_THRESHOLD_SEC}</span>s</span>
        <button type="button" class="apw-cd-cancel" aria-label="Cancel">×</button>
        <div class="apw-cd-bar"><div class="apw-cd-bar-fill"></div></div>
    `;

    const fillEl = overlay.querySelector(".apw-cd-bar-fill");
    fillEl.style.transition = "width 0.3s linear";

    overlay.querySelector(".apw-cd-cancel").addEventListener("click", () => {
        if (countdownState) countdownState.cancelled = true;
        removeOverlay();
        postToParent({ type: "countdownCancelled" });
    });

    document.body.appendChild(overlay);
    applyFullscreenPlacement(overlay);

    document.addEventListener("fullscreenchange", onFullscreenChange);
    document.addEventListener("webkitfullscreenchange", onFullscreenChange);

    const remaining = getRemaining(activeVideo);
    if (remaining !== null) updateCountdown(remaining);
}

function updateCountdown(remaining) {
    const overlay = document.getElementById(COUNTDOWN_OVERLAY_ID);
    if (!overlay) return;
    const numEl = overlay.querySelector(".apw-cd-num");
    const fillEl = overlay.querySelector(".apw-cd-bar-fill");
    if (numEl) numEl.textContent = String(Math.max(0, Math.ceil(remaining)));
    if (fillEl) {
        const pct = Math.max(0, Math.min(100, (remaining / NEAR_END_THRESHOLD_SEC) * 100));
        fillEl.style.width = pct + "%";
    }
}

function tryPlay(tries = 0) {
    const video = document.querySelector("video");

    if (video && !video.paused && video.currentTime > 0) return;

    // Click any visible play overlay kwik renders before the video starts.
    const playSelectors = [
        ".plyr__control--overlaid",
        '[data-plyr="play"]',
        ".vjs-big-play-button",
        ".jw-icon-playback",
        ".play-button",
        ".play-btn"
    ];
    for (const sel of playSelectors) {
        const btn = document.querySelector(sel);
        if (btn) { btn.click(); break; }
    }

    if (video) {
        video.play().catch(() => {});
    }

    if (tries < 40) setTimeout(() => tryPlay(tries + 1), 400);
}

window.addEventListener("message", event => {
    if (event.data?.source !== "apw-host") return;
    if (event.data?.type === "startCountdown") {
        if (countdownState) countdownState.armed = true;
        showCountdownOverlay();
    } else if (event.data?.type === "cancelCountdown") {
        if (countdownState) countdownState.cancelled = true;
        removeOverlay();
    } else if (event.data?.type === "autoPlay") {
        tryPlay();
    }
});

scanForVideo();

const observer = new MutationObserver(scanForVideo);
observer.observe(document.documentElement, { childList: true, subtree: true });
