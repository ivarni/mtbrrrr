# mtbrrrr

A private, mobile-first MTB map for Norway. It is a static MapLibre app backed by a versioned PMTiles archive built from OpenStreetMap's Norway extract.

## What it does

- Shows Norwegian OSM paths, tracks, bridleways, cycleways and footways, coloured by `mtb:scale`
- Tracks your location and heading
- Lets you show or hide trails and load a GPX route
- Caches the app shell and base-map tiles for revisits

Trail data needs a connection. The app shell can open offline, but it does not promise offline trail coverage. Outside Norway, trail data is unavailable.

## Run locally

GPS and service workers require HTTPS or `localhost`:

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

The production trail archive is generated and deployed separately. See [the Rocky Linux runbook](deploy/rocky-linux/README.md) to build, inspect, and publish it. Its fixture preview uses Caddy because PMTiles needs HTTP byte ranges.

## Data and attribution

Trail data is derived from [OpenStreetMap](https://www.openstreetmap.org/copyright) and is available under the [ODbL](https://opendatacommons.org/licenses/odbl/). When distributing a PMTiles archive, retain this attribution and ODbL notice, and publish the matching `data/<release>/latest.json` so recipients can identify the Geofabrik PBF URL and source timestamp. Base-map and elevation tiles have their own terms.

## License

Copyright © 2026 Ivar Nilsen.

This work is licensed under a [Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International License](https://creativecommons.org/licenses/by-nc-sa/4.0/).
