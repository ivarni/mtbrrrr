# MapTiler Outdoor base map

mtbrrrr can use **MapTiler Outdoor** for topo cartography (contour lines, hillshade,
nicer terrain — close to mtbmap.no). It needs a free API key. With no key set, the app
falls back to keyless OpenFreeMap Liberty, so it always works.

## Why the key must be restricted

The key lives in `app.js`, which ships to the browser on a static site — so it is
**public**. Anyone can read it. The mitigation is an **HTTP-referrer (origin) allow-list**
in MapTiler: the key only works when requests come from your site. Do this before
deploying, or someone can burn your free quota.

## Steps

1. Sign up (free) at https://www.maptiler.com/ and open **Account → Keys**.
2. Copy your key (or make a new one dedicated to mtbrrrr).
3. **Restrict it** — on the key's settings, set **Allowed origins (HTTP referrers)** to:
   - `http://localhost:8000` (local dev)
   - your deployed origin, e.g. `https://mtbrrrr.pages.dev` (and any custom domain)
4. Paste the key into `app.js`:
   ```js
   const MAPTILER_KEY = 'YOUR_KEY_HERE';
   ```
5. Reload. The base switches to Outdoor automatically (`USING_MAPTILER` becomes true).

## What changes when the key is set

- Base style → `https://api.maptiler.com/maps/outdoor-v2/style.json` (contours + hillshade
  built in, always on). Our custom Terrarium hillshade is skipped to avoid double shading.
- Panned areas cache at runtime via the service worker — `api.maptiler.com` is in the SW's
  cache-first host list.

## To revert to keyless

Set `MAPTILER_KEY = ''` — the app returns to OpenFreeMap Liberty + our own hillshade.
