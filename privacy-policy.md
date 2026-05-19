# Privacy Policy for Animepahe Watchlist

_Last updated: May 19, 2026_

Animepahe Watchlist is a browser extension that helps users save and sync anime watchlist data while using Animepahe.

This privacy policy explains what data the extension stores, how it is used, and how sync works.

## Data the extension stores

Animepahe Watchlist may store the following data:

- Anime titles saved to your watchlist
- Watchlist status, such as “Currently Watching” or “Plan to Watch”
- Episode information
- Anime page URLs
- Thumbnail/image URLs
- Timestamps used for sorting and syncing
- Extension settings, such as countdown and badge preferences
- A 5-word sync phrase if you choose to use sync

The extension does not collect your name, email address, password, payment information, or personal account information.

## Local storage

By default, watchlist data is stored locally in your browser using Chrome/Brave extension storage.

This data stays on your device unless you choose to use the sync feature.

## Sync feature

Animepahe Watchlist includes an optional sync feature.

If you generate or enter a 5-word sync phrase, your watchlist can be synced using Firebase Firestore.

The sync phrase is used to create a hashed document ID. The raw phrase itself is not stored directly in Firebase.

However, anyone who knows your 5-word sync phrase can access, sync, and edit the same watchlist. You should keep your sync phrase private.

## Cloud storage

When sync is enabled, the extension may upload your watchlist data to Firebase Firestore.

The stored cloud data may include:

- Watchlist items
- Anime titles
- Episode information
- Anime URLs
- Thumbnail URLs
- Watchlist status
- Update timestamps

This data is used only to provide the sync feature.

## Data sharing

Animepahe Watchlist does not sell your data.

Animepahe Watchlist does not share your data with advertisers.

Cloud sync data is stored using Firebase Firestore, which is provided by Google Firebase.

## Third-party services

The extension may communicate with:

- Animepahe, to run the watchlist features on the Animepahe website
- AniList GraphQL API, if anime metadata or airing information is used
- Firebase Firestore, if sync is enabled

These third-party services may have their own privacy policies.

## User control

You can remove locally stored data by clearing the extension data from your browser or uninstalling the extension.

If you use sync, the synced watchlist is connected to your 5-word sync phrase. Anyone using the same phrase may continue to access that synced watchlist.

## Security note

The sync phrase system is designed for convenience, not high security.

Do not use the sync phrase for sensitive or private information. The extension is intended only for anime watchlist data.

## Changes to this policy

This privacy policy may be updated if the extension changes how it stores or syncs data.

