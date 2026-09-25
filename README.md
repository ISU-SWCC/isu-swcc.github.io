# SWCC website

Working copy of [isu-swcc.github.io](https://isu-swcc.github.io/). GitHub is the last published copy. Edit here.

Imported `main` at `2560d200f10dfb4be41d62ecbb8abb16b52774ae` on 2026-09-24. There is no `.git` directory in this folder. Procedure: [[../../../Skills/SWCCWebsite]].

## Edit

Change `Content/`, then build:

```bash
python3 Service/SWCC/Website/build_site.py
```

The script writes `data/*.json`, which the pages fetch, and copies any product `file` into `assets/forms/`. It removes `source` and `file` from the public JSON. On this Mac, `Content/` and `content/` are the same folder, so public JSON lives in `data/`.

| Public page | Edit | What may go on the page |
|-------------|---------|-------------------------|
| Home, contact block | `Content/Site.json` | Constitution for the affiliation. Order form for phone, mail, and `swccexec@iastate.edu`. A meeting room only after one room is written under `Meetings/`. |
| About | `Content/About.md` | `Constitution/2025 SWCC Constitution.docx`. Keep the `<!-- source: ... -->` comment. |
| Officers | `Content/Officers.json` | Seated roles. `Elections/` PDFs are applications, not results. Duties come from Constitution Article 6. |
| Events | `Content/Events.json` | A file under `Meetings/`, `Elections/`, or `Media/` that states the fact. No room or clock time the file does not state. |
| Products | `Content/Products.json` | `Forms/` or `Activities/`. Set `file` to a vault path and the build copies it. A page link uses `pages/...html`. |
| Watershed model | `Content/WatershedModel.json` and `Content/WatershedBoundaries.geojson` | Rates, kit, and shipping rows. The GeoJSON is a `FeatureCollection` of `Polygon` or `MultiPolygon` in longitude/latitude, with `properties.name`. The page ships with one example basin. The buyer sets the square count, not a ground distance. True north keeps north at the top. Largest fit turns the model. More than one square leaves a 1/2 inch outer border for the locks. `delineate_url` is the future pour-point service. The page has no payment control. |

Each record needs a `source` string. The build stops without one.

## Do not publish from here

Publishing is a separate request. Clone the GitHub repo outside this vault, copy this folder onto that clone without deleting its `.git`, and push only after review. `assets/background.mp4` is about 54 MB.
