document.querySelector("#clearData").addEventListener("click", async () => {
    await chrome.storage.local.remove([
        "recently_watched",
        "rw_poster_cache",
        "rw_latest_ep_cache",
        "rw_anilist_id_cache",
        "rw_anilist_airing_cache"
    ]);

    console.log("Saved list cleared");
});

document.querySelector("#resetSettings").addEventListener("click", async () => {
    await chrome.storage.local.remove(["rw_settings"]);
    console.log("Settings reset");
});