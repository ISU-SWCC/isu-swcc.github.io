# SWCC website

Working copy of [isu-swcc.github.io](https://isu-swcc.github.io/). GitHub is the last published copy. Edit here.

Imported `main` at `2560d200f10dfb4be41d62ecbb8abb16b52774ae` on 2026-09-24. There is no `.git` directory in this folder. Procedure: [[../../../../Skills/SWCCWebsite]].

## Edit

Change `Content/`, then build:

```bash
python3 Data/Service/SWCC/Website/build_site.py
```

The script writes `data/*.json`, which the pages fetch, and copies any product `file` into `assets/forms/`. It removes `source` and `file` from the public JSON. On this Mac, `Content/` and `content/` are the same folder, so public JSON lives in `data/`.

| Public page | Edit | What may go on the page |
|-------------|---------|-------------------------|
| Home, contact block | `Content/Site.json` | Constitution for the affiliation. Order form for phone, mail, and `swccexec@iastate.edu`. A meeting room only after one room is written under `Meetings/`. |
| About | `Content/About.md` | `Constitution/2025 SWCC Constitution.docx`. Keep the `<!-- source: ... -->` comment. |
| Officers | `Content/Officers.json` | Seated roles. `Elections/` PDFs are applications, not results. Duties come from Constitution Article 6. |
| Events | `Content/Events.json` | A file under `Meetings/`, `Elections/`, or `Media/` that states the fact. No room or clock time the file does not state. |
| Products | `Content/Products.json` | `Forms/` or `Activities/`. Set `file` to a vault path and the build copies it. A page link uses `pages/...html`. |
| Watershed model | `Content/WatershedModel.json` and `Content/WatershedBoundaries.geojson` | Print material, quality grade, the Practice Kit, and the Contaminant Kit. PLA, PET, and ASA each have a Bulk price and an Enterprise price. The quote uses 15% infill, then a 10% reprint allowance, 10% packaging, a 10% safety factor, and 50% profit. The total includes a UPS Ground estimate from Ames to the ZIP nearest the watershed center. The GeoJSON is a `FeatureCollection` of `Polygon` or `MultiPolygon` in longitude/latitude, with `properties.name` and `properties.id`. The page opens on one example basin. Name and HUC search reads the simplified USGS outlines in `data/boundaries/`. The buyer sets the square count, not a ground distance. True north keeps north at the top. Largest fit turns the model. More than one square leaves a 1/2 inch outer border for the locks. `delineate_url` is the future pour-point service. The page has no payment control. Elevation is a pre-launch bake, described below. |

Each record needs a `source` string. The build stops without one.

## Elevation

Decided 2026-10-07. Procedure: [[../../../../Skills/SWCCWebsite]] section “Elevation.”

Before a basin is offered, bake it on EL4352-WS:

```bash
python Data/Service/SWCC/Website/bake_elevation.py --id example-basin --projection utm --utm-zone 15
```

The bake reads the club's Copernicus GLO-30 archive. Shop rasters stay off this site. The site receives only `data/elevation/<id>.json` and `data/elevation/<id>-streams.geojson`.

During a visit the browser fetches those two files. The slider does not fetch again. A basin without a bake shows “Elevation for this basin has not been baked.” There is no elevation query API. The cell budget is 4,000,000. Coarser rungs (30 m through 5 km) cover larger basins, including Amazon-scale basins at 2 km. Print CRS is UTM, with a zone of choice, or Albers. Order stays disabled. Do not publish the shop rasters or point the page at Cylo.

The base map is a second bake, `bake_map.py`. It averages Copernicus overview level 2 to 0.05 degree and writes zoom 0-4 PNG tiles to `data/map/<ramp>/`. Shop rasters stay off this site. The page opens on the DEM surface. White and DEM use those tiles. Satellite and USGS topo stay as they are. The basin window is still the detailed surface inside the watershed. Ocean is a flat blue and is not colored by the elevation ramp. Step 04 Surface is open on load. Its DEM color ramp uses the same stops on the overview and the basin, from 0 to 8,000 m. The choices are the QGIS topography ramps cd-a, sd-a, and the other ShadeMax base colors. Portions of this work include intellectual property of Jim Mossman and are used herein with permission. Copyright (C) 2005 Jim Mossman. All rights reserved. Step 03 is the print projection: UTM with a chosen zone, Albers fit to the basin, or CONUS Albers (EPSG:5070). The browser refits the squares. A different projection does not rebake the raster.

## Do not publish from here

Publishing is a separate request. Clone the GitHub repo outside this vault, copy this folder onto that clone without deleting its `.git`, and push only after review. `assets/background.mp4` is about 54 MB.
