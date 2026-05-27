// Runs inside the kwik.cx iframe embedded on AnimePahe play pages.
// Detects when the video ends and notifies the parent (animepahe.pw).

const NEAR_END_THRESHOLD_SEC = 1.5;

let lastSentEndedAt = 0;

function postEnded() {
    const now = Date.now();
    if (now - lastSentEndedAt < 5000) return;
    lastSentEndedAt = now;

    try {
        window.parent.postMessage({ source: "apw-player", type: "videoEnded" }, "*");
    } catch {}
}

function attachToVideo(video) {
    if (video.dataset.apwBound === "1") return;
    video.dataset.apwBound = "1";

    video.addEventListener("ended", postEnded);

    video.addEventListener("timeupdate", () => {
        if (!isFinite(video.duration) || video.duration === 0) return;
        if (video.duration - video.currentTime <= NEAR_END_THRESHOLD_SEC && !video.paused) {
            // Fallback: some players don't always fire 'ended' cleanly.
            // We still gate on actual end via the threshold + paused check.
            if (video.duration - video.currentTime < 0.4) postEnded();
        }
    });
}

function scanForVideo() {
    const video = document.querySelector("video");
    if (video) attachToVideo(video);
}

scanForVideo();

const observer = new MutationObserver(scanForVideo);
observer.observe(document.documentElement, { childList: true, subtree: true });
