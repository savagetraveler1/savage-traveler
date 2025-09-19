from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from dotenv import load_dotenv
import os

load_dotenv()  # reads MAPBOX_TOKEN from .env in this folder
MAPBOX_TOKEN = os.getenv("MAPBOX_TOKEN", "")

app = FastAPI()

# ensure a local static dir exists (ok if it already does)
if not os.path.isdir("static"):
    os.makedirs("static", exist_ok=True)

app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

@app.get("/", response_class=HTMLResponse)
def home(request: Request):
    if not MAPBOX_TOKEN.startswith("pk."):
        return HTMLResponse("<h2>Missing/invalid MAPBOX_TOKEN in .env</h2>", status_code=500)
    return templates.TemplateResponse(
        "index.html",
        {"request": request, "mapbox_token": MAPBOX_TOKEN}
    )

@app.get("/health")
def health():
    return {"ok": True}
