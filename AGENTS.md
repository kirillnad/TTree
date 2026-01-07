# AGENTS.md — Memus/TTree

This file contains persistent instructions for coding assistants.

## Cache Busting / Versions (PWA + Service Worker)

### App shell URLs
- Keep app shell assets **unversioned** (no `?v=`) in `client/index.html` and `client/uploads-sw.js`:
  - `/index.html`, `/style.css`, `/boot.js`, `/app.js`, `/manifest.webmanifest`, icons.

### One place to force client update
- The **single source of truth** for forcing a client refresh is `client/uploads-sw.js`:
  - bump `APP_VERSION` (a short ordinal number) when you need clients to definitely pick up new JS/CSS.
  - the Service Worker uses `APP_CACHE = "a" + APP_VERSION` for the app shell cache.

### Auto-bump rule (don’t forget)
- After any change that affects what ships to the browser (anything under `client/`), run `npm run gen:app-version`:
  - it bumps `APP_VERSION` only if the computed `APP_BUILD` hash changed.
- Sanity check: `npm run check:app-version` must pass before shipping.

### Sidebar version label semantics
- `sidebar-version` must reflect what the **client is actually running**:
  - Read `window.__BUILD_ID__` (set from the Service Worker `APP_VERSION`) and display it as `vN`.
  - If SW is not yet controlling the page, a fallback like `api vN` is acceptable temporarily.
