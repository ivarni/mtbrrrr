# mtbrrrr

A private, mobile-first MTB trail map. Static site, no build step, no API key.

## Stack
- **MapLibre GL JS** — vector map engine (GPU, smooth on phones)
- **OpenFreeMap** (Liberty) — keyless global vector base tiles
- **AWS Terrarium DEM** — keyless hillshade rendered client-side
- **Overpass API** — live MTB trails (`highway=path/track/...`), colored by `mtb:scale`
- **Service worker** — cache-first for all map data → fast revisits + works offline in cached areas
- **PWA** — installable to your home screen, full-screen

## Features
- 📍 Live GPS location + heading (`GeolocateControl`)
- 🚵 Load MTB trails for the current view (works in any region with signal), difficulty-colored
- ⛰️ Hillshade relief
- 📈 Drop in a `.gpx` file to overlay a route

## Run locally
GPS + service workers require HTTPS or `localhost`:

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

Or with node: `npx serve .`

## Deploy (private)
Any static host works — all are free and give HTTPS:
- **Cloudflare Pages** / **Netlify**: drag-drop this folder, or connect a repo.
- **GitHub Pages**: push and enable Pages.

For "private", either use an unguessable URL, or put Cloudflare Access / Netlify password protection in front.

The **self-hosted Overpass server** is separate and lives on Scaleway, managed with Terraform —
`terraform apply` from `deploy/overpass/infra/`. See [`deploy/overpass/INFRA.md`](deploy/overpass/INFRA.md).

## License
Copyright © 2026 Ivar Nilsen.

This work is licensed under a
[Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International License](https://creativecommons.org/licenses/by-nc-sa/4.0/)
(CC BY-NC-SA 4.0) — see [`LICENSE`](LICENSE) for the full text. In short: share and adapt
freely with attribution, no commercial use, and derivatives under the same license.

Map data and tiles are covered by their own terms, not this license:
OpenFreeMap / Overpass data is © OpenStreetMap contributors ([ODbL](https://www.openstreetmap.org/copyright)),
and the Terrarium DEM tiles are subject to their respective source licenses.

## Notes / next steps
- **MapTiler upgrade:** swap the `style:` URL in `app.js` for a MapTiler Outdoor style (needs a free key, restrict it by HTTP referrer). Gives polished outdoor cartography + built-in contours.
- **Contour lines:** add `maplibre-contour` to draw contours client-side from the same DEM tiles.
- **Overpass etiquette:** the public Overpass endpoint is rate-limited and community-run. `deploy/overpass/` has a Terraform stack that stands up your own on Scaleway (Norway extract) — see [`INFRA.md`](deploy/overpass/INFRA.md). Set `SELF_HOSTED_OVERPASS` in `app.js` to its `overpass_url` output once it's up; the app keeps using public mirrors outside Norway.
