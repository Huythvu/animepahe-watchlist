// Runs inside the kwik.cx iframe embedded on AnimePahe play pages.
// Detects when the video ends and notifies the parent (animepahe.pw).
// Renders the auto-play countdown overlay inside the iframe so it
// stays visible in fullscreen.

const COUNTDOWN_OVERLAY_ID = "apw-countdown-overlay";
const NEAR_END_THRESHOLD_SEC = 0.4;
const STYLE_ID = "apw-iframe-styles";

let lastSentEndedAt = 0;
let countdownTimer = null;

function postToParent(payload) {
    try {
        window.parent.postMessage({ source: "apw-player", ...payload }, "*");
    } catch {}
}

function postEnded() {
    const now = Date.now();
    if (now - lastSentEndedAt < 5000) return;
    lastSentEndedAt = now;
    postToParent({ type: "videoEnded" });
}

function attachToVideo(video) {
    if (video.dataset.apwBound === "1") return;
    video.dataset.apwBound = "1";

    video.addEventListener("ended", postEnded);

    video.addEventListener("timeupdate", () => {
        if (!isFinite(video.duration) || video.duration === 0) return;
        if (video.duration - video.currentTime < NEAR_END_THRESHOLD_SEC && !video.paused) {
            postEnded();
        }
    });
}

function scanForVideo() {
    const video = document.querySelector("video");
    if (video) attachToVideo(video);
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
            display: inline-flex;
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
    if (countdownTimer) {
        clearInterval(countdownTimer);
        countdownTimer = null;
    }
    document.getElementById(COUNTDOWN_OVERLAY_ID)?.remove();
    document.removeEventListener("fullscreenchange", onFullscreenChange);
    document.removeEventListener("webkitfullscreenchange", onFullscreenChange);
}

function onFullscreenChange() {
    const overlay = document.getElementById(COUNTDOWN_OVERLAY_ID);
    if (overlay) applyFullscreenPlacement(overlay);
}

function showCountdownOverlay(seconds) {
    injectStyles();
    removeOverlay();

    const overlay = document.createElement("div");
    overlay.id = COUNTDOWN_OVERLAY_ID;
    overlay.innerHTML = `
        <span class="apw-cd-text">Next episode in <span class="apw-cd-num">${seconds}</span>s</span>
        <button type="button" class="apw-cd-cancel" aria-label="Cancel">×</button>
        <div class="apw-cd-bar"><div class="apw-cd-bar-fill"></div></div>
    `;

    const numEl = overlay.querySelector(".apw-cd-num");
    const fillEl = overlay.querySelector(".apw-cd-bar-fill");

    overlay.querySelector(".apw-cd-cancel").addEventListener("click", () => {
        removeOverlay();
        postToParent({ type: "countdownCancelled" });
    });

    document.body.appendChild(overlay);
    applyFullscreenPlacement(overlay);

    document.addEventListener("fullscreenchange", onFullscreenChange);
    document.addEventListener("webkitfullscreenchange", onFullscreenChange);

    fillEl.style.transition = `width ${seconds}s linear`;
    requestAnimationFrame(() => { fillEl.style.width = "0%"; });

    let remaining = seconds;
    countdownTimer = setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) {
            removeOverlay();
            postToParent({ type: "countdownDone" });
            return;
        }
        numEl.textContent = String(remaining);
    }, 1000);
}

function tryPlay(tries = 0) {
    const video = document.querySelector("video");
    if (video) {
        video.play().catch(() => {});
        return;
    }
    if (tries < 30) setTimeout(() => tryPlay(tries + 1), 500);
}

window.addEventListener("message", event => {
    if (event.data?.source !== "apw-host") return;
    if (event.data?.type === "startCountdown") {
        showCountdownOverlay(event.data.seconds ?? 5);
    } else if (event.data?.type === "cancelCountdown") {
        removeOverlay();
    } else if (event.data?.type === "autoPlay") {
        tryPlay();
    }
});

scanForVideo();

const observer = new MutationObserver(scanForVideo);
observer.observe(document.documentElement, { childList: true, subtree: true });
