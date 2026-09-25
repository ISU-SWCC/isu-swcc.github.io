#!/usr/bin/env python3
"""Write the public SWCC site JSON from Website/Content.

Edit the files in Content/. This script copies listed vault files into
assets/ and writes data/*.json with editor-only keys removed.
On a case-insensitive disk, data/ must not be named Content/.
"""

from __future__ import annotations

import json
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
VAULT = ROOT.parents[2]
CONTENT = ROOT / "Content"
PUBLIC = ROOT / "data"
DROP = {"source", "note", "file", "boundaries_file"}
DATE = re.compile(r"^\d{4}-\d{2}(-\d{2})?$")
TIME = re.compile(r"^\d{2}:\d{2}$")


def load_json(name: str):
    path = CONTENT / name
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise SystemExit(f"{path.relative_to(ROOT)} is not valid JSON: {exc}") from exc


def require_source(item: dict, label: str) -> None:
    source = item.get("source")
    if not isinstance(source, str) or not source.strip():
        raise SystemExit(f"{label} needs a source string pointing at a vault record")


def strip(value):
    if isinstance(value, dict):
        return {key: strip(item) for key, item in value.items() if key not in DROP}
    if isinstance(value, list):
        return [strip(item) for item in value]
    return value


def write_json(name: str, value) -> None:
    text = json.dumps(value, indent=2, ensure_ascii=False) + "\n"
    if "picsum.photos" in text or "placeholder" in text.lower():
        raise SystemExit(f"{name} still contains a placeholder image or the word placeholder")
    PUBLIC.mkdir(exist_ok=True)
    (PUBLIC / name).write_text(text, encoding="utf-8")


def copy_vault_file(rel: str, dest_dir: Path) -> str:
    src = VAULT / rel
    if not src.is_file():
        raise SystemExit(f"Missing vault file: {rel}")
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / src.name
    shutil.copy2(src, dest)
    return dest.relative_to(ROOT).as_posix()


def local_asset(path: str | None, label: str) -> None:
    if not path:
        return
    if path.startswith(("http://", "https://", "mailto:")):
        raise SystemExit(f"{label} must be a file in this site, not {path}")
    if not (ROOT / path).is_file():
        raise SystemExit(f"{label} is missing: {path}")


def parse_about(text: str) -> dict:
    if "source:" not in text.split("-->", 1)[0]:
        raise SystemExit("Content/About.md needs an HTML comment: <!-- source: vault path -->")
    body = re.sub(r"<!--.*?-->", "", text, flags=re.S).strip()
    chunks = re.split(r"\n(?=## )", body)
    first = chunks[0].splitlines()
    if not first or not first[0].startswith("# "):
        raise SystemExit("Content/About.md needs an opening '# Title' line")
    title = first[0][2:].strip()
    intro_text = "\n".join(first[1:]).strip()
    intro = [part.strip() for part in re.split(r"\n\s*\n", intro_text) if part.strip()]
    sections = []
    for chunk in chunks[1:]:
        heading, _, rest = chunk.partition("\n")
        heading = heading[3:].strip()
        paragraphs = [part.strip() for part in re.split(r"\n\s*\n", rest.strip()) if part.strip()]
        slug = re.sub(r"[^a-z0-9]+", "-", heading.lower()).strip("-")
        sections.append({"id": slug, "heading": heading, "paragraphs": paragraphs})
    if not sections:
        raise SystemExit("Content/About.md needs at least one '## Section'")
    return {"title": title, "intro": intro, "sections": sections, "hero": "assets/logos/SWCC-Logo-NoText-NoBG-ZoomOut-Alpha.png"}


def build_products(raw: dict) -> dict:
    require_source(raw, "Products.json")
    items = []
    for index, item in enumerate(raw["items"], start=1):
        label = f"Products.json item {index} ({item.get('title', 'untitled')})"
        require_source(item, label)
        for key in ("title", "tag", "description"):
            if not item.get(key):
                raise SystemExit(f"{label} needs {key}")
        public = strip(item)
        if item.get("file"):
            public["link_href"] = copy_vault_file(item["file"], ROOT / "assets" / "forms")
        local_asset(public.get("image"), label + " image")
        local_asset(public.get("link_href"), label + " link")
        items.append(public)
    return {"intro": raw["intro"], "items": items}


def build_events(raw: dict) -> dict:
    require_source(raw, "Events.json")
    items = []
    for index, item in enumerate(raw["items"], start=1):
        label = f"Events.json item {index} ({item.get('title', 'untitled')})"
        require_source(item, label)
        if not DATE.match(item.get("date", "")):
            raise SystemExit(f"{label} date must be YYYY-MM-DD or YYYY-MM")
        if item.get("time") is not None and not TIME.match(item["time"]):
            raise SystemExit(f"{label} time must be HH:MM or null")
        if not item.get("title") or not item.get("description"):
            raise SystemExit(f"{label} needs title and description")
        public = strip(item)
        public["id"] = index
        local_asset(public.get("image"), label + " image")
        local_asset(public.get("thumbnail"), label + " thumbnail")
        items.append(public)
    return {"intro": raw.get("intro", ""), "items": items}


def build_officers(raw: dict) -> dict:
    require_source(raw, "Officers.json")
    people = []
    for index, item in enumerate(raw["people"], start=1):
        label = f"Officers.json person {index} ({item.get('name', 'unnamed')})"
        require_source(item, label)
        for key in ("name", "role", "description"):
            if not item.get(key):
                raise SystemExit(f"{label} needs {key}")
        local_asset(item.get("photo"), label + " photo")
        people.append(strip(item))
    return {"intro": raw["intro"], "people": people}


def build_model(raw: dict) -> dict:
    require_source(raw, "WatershedModel.json")
    rel = raw.get("boundaries_file")
    if not rel:
        raise SystemExit("WatershedModel.json needs boundaries_file")
    src = VAULT / rel
    if not src.is_file():
        raise SystemExit(f"Missing watershed boundaries: {rel}")
    try:
        collection = json.loads(src.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise SystemExit(f"{rel} is not valid JSON: {exc}") from exc
    if collection.get("type") != "FeatureCollection" or not isinstance(collection.get("features"), list):
        raise SystemExit(f"{rel} must be a GeoJSON FeatureCollection")
    public = strip(raw)
    public["boundaries_url"] = "data/watershed-boundaries.geojson"
    PUBLIC.mkdir(exist_ok=True)
    (PUBLIC / "watershed-boundaries.geojson").write_text(
        json.dumps(collection, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    return public


def main() -> None:
    if PUBLIC.name.casefold() == CONTENT.name.casefold():
        raise SystemExit("Public output cannot share a name with Content/. This disk ignores case.")
    site = load_json("Site.json")
    require_source(site, "Site.json")
    for key in ("title", "home_line", "meeting", "emails", "phone", "mail"):
        if not site.get(key):
            raise SystemExit(f"Site.json needs {key}")
    officers = build_officers(load_json("Officers.json"))
    events = build_events(load_json("Events.json"))
    products = build_products(load_json("Products.json"))
    about = parse_about((CONTENT / "About.md").read_text(encoding="utf-8"))
    local_asset(about["hero"], "About hero")
    model = build_model(load_json("WatershedModel.json"))

    write_json("site.json", strip(site))
    write_json("officers.json", officers)
    write_json("events.json", events)
    write_json("products.json", products)
    write_json("about.json", about)
    write_json("watershed-model.json", model)

    stale = ROOT / "events" / "events.json"
    if stale.exists():
        stale.unlink()
    print(
        f"Wrote {PUBLIC.relative_to(VAULT)} ({len(events['items'])} events, "
        f"{len(officers['people'])} officers, {len(products['items'])} products, "
        f"{len(json.loads((PUBLIC / 'watershed-boundaries.geojson').read_text())['features'])} boundaries)"
    )


if __name__ == "__main__":
    try:
        main()
    except SystemExit as exc:
        if exc.code not in (0, None):
            print(exc, file=sys.stderr)
        raise
