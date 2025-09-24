# main.py
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from dotenv import load_dotenv
from pathlib import Path
import os, csv, json

# ---------- Config ----------
PROJECT_ROOT = Path(__file__).resolve().parent
TEMPLATES_DIR = PROJECT_ROOT / "templates"
STATIC_DIR = PROJECT_ROOT / "static"
DATA_DIR = PROJECT_ROOT / "data"                    # optional place for CSVs
STATIC_DATA_DIR = STATIC_DIR / "data"              # where the app serves GeoJSON from
CSV_CANDIDATES = [
    PROJECT_ROOT / "Consolidated_Roadside_Attractions_and_Rest_Areas CSV.csv",
    DATA_DIR / "Consolidated_Roadside_Attractions_and_Rest_Areas CSV.csv",
]
GEOJSON_PATH = STATIC_DATA_DIR / "base.geojson"

# ---------- Boot ----------
load_dotenv()  # reads MAPBOX_TOKEN from .env
MAPBOX_TOKEN = os.getenv("MAPBOX_TOKEN", "")

app = FastAPI()

# Ensure folders exist
STATIC_DIR.mkdir(parents=True, exist_ok=True)
STATIC_DATA_DIR.mkdir(parents=True, exist_ok=True)
TEMPLATES_DIR.mkdir(parents=True, exist_ok=True)

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
templates = Jinja2Templates(directory=str(TEMPLATES_DIR))


# ---------- CSV → GeoJSON helper ----------
def csv_to_geojson(csv_path: Path, out_path: Path) -> int:
    """
    Convert a CSV that has latitude/longitude columns into a GeoJSON FeatureCollection.
    Accepts column names: lat/latitude and lng/lon/longitude (case-insensitive).
    Returns number of features written.
    """
    if not csv_path.exists():
        raise FileNotFoundError(f"CSV not found: {csv_path}")

    features = []
    with csv_path.open(newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        # normalize headers once for fast lookups
        headers = {h.lower(): h for h in reader.fieldnames or []}

        lat_key = headers.get("lat") or headers.get("latitude")
        lon_key = headers.get("lng") or headers.get("lon") or headers.get("longitude")

        if not lat_key or not lon_key:
            raise ValueError(
                "CSV must contain 'lat'/'latitude' and 'lng'/'lon'/'longitude' columns."
            )

        for row in reader:
            try:
                lat = float(row[lat_key])
                lon = float(row[lon_key])
            except Exception:
                # skip rows with bad/missing coords
                continue

            # keep all non-coordinate fields as properties
            props = {
                k: v
                for k, v in row.items()
                if k not in (lat_key, lon_key)
            }

            features.append(
                {
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [lon, lat]},
                    "properties": props,
                }
            )

    geojson = {"type": "FeatureCollection", "features": features}
    out_path.write_text(json.dumps(geojson, ensure_ascii=False, indent=2), encoding="utf-8")
    return len(features)


def first_existing_csv() -> Path | None:
    for p in CSV_CANDIDATES:
        if p.exists():
            return p
    return None


# ---------- Routes ----------
@app.get("/", response_class=HTMLResponse)
def home(request: Request):
    if not MAPBOX_TOKEN.startswith("pk."):
        return HTMLResponse("<h2>Missing/invalid MAPBOX_TOKEN in .env</h2>", status_code=500)

    # Ensure we have a GeoJSON to load; try to build it once if missing.
    if not GEOJSON_PATH.exists():
        csv_path = first_existing_csv()
        if csv_path:
            try:
                csv_to_geojson(csv_path, GEOJSON_PATH)
            except Exception as e:
                # Don't hard-fail the homepage, just show a helpful message.
                return HTMLResponse(f"<h3>Failed to build GeoJSON: {e}</h3>", status_code=500)

    return templates.TemplateResponse(
        "index.html",
        {
            "request": request,
            "mapbox_token": MAPBOX_TOKEN,
            "data_url": "/static/data/base.geojson",  # front-end can fetch this
        },
    )


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/rebuild-geojson")
def rebuild_geojson():
    """
    Manually rebuild the GeoJSON from the CSV.
    Useful after you update/replace the CSV.
    """
    csv_path = first_existing_csv()
    if not csv_path:
        raise HTTPException(status_code=404, detail="CSV not found in expected locations.")
    try:
        count = csv_to_geojson(csv_path, GEOJSON_PATH)
        return JSONResponse({"ok": True, "features": count, "geojson": str(GEOJSON_PATH)})
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
