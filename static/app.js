// ===== BASIC CONFIG =====
mapboxgl.accessToken = 'pk.eyJ1Ijoic2F2YWdldHJhdmVsZXIiLCJhIjoiY21mZzl2dXVvMDBmODJrcHVzbno1YzRkZyJ9.fGvMUrtwKnDgTf2qmOeQTA';
if (mapboxgl.setTelemetryEnabled) mapboxgl.setTelemetryEnabled(false);

// 'Steve Jobs' mode with speed tweaks
const AVERAGE_SPEED_MPH = 55;
const PROFILE = 'driving-traffic';
const MAX_GEO_WAYPOINTS = 5;
const BACKBONE_BIAS_MI = 6;            // preferred rejoin distance
const CORRIDOR_WIDTH_MI = 25;          // width to consider same-heading POIs
const CHAIN_LOOKAHEAD = 3;             // trimmed lookahead
const MAX_CHAIN_POIS = 3;              // cap per chain for speed
const REJOIN_PENALTY_MIN = 6;          // soft penalty for each freeway rejoin

const POI_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQptJKid_rUcBSdL2fzwSU2RhG3NqeiiRL_0OQ1yRleFNwBbZWxuMKzPqiAhYn15sfNkO8NzDgAZ0Qg/pub?output=csv';
const POI_CACHE_KEY = 'poi_cache_v4::' + POI_URL;
const POI_CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12h

// ===== FIELD KEYS FROM TILESET (Mapbox vector source) =====
const NAME_FIELD     = 'Name';
const CATEGORY_FIELD = 'Category';
const LAT_FIELD      = 'Latitude';
const LON_FIELD      = 'Longitude';
const DESC_FIELD     = 'Description';
const URL_FIELD      = 'Google Maps URL';


// ===== STATE & REFS =====
let start = null, end = null;
let routeFeature = null;               // current drawn route (final with detours)
let baseRouteFeature = null;           // backbone-only geometry (cached)
let baseKey = '';                      // hash of start+manual+end when base was computed

let startText = '', endText = '';
let baseDistanceM = 0, baseDurationSec = 0;

let pois = [];
let filteredPois = [];
let poiWaypoints = []; // {id,name,category,coord,along}
let waypoints = [];
let activeCats = new Set(['Rest Area','Roadside Attraction','Welcome Sign','Other']);

const $minutes = document.getElementById('minutes');
const $summary = document.getElementById('summary');
const $error = document.getElementById('error');
const $filters = document.getElementById('filters');
const $wpContainer = document.getElementById('waypoints');
const $selList = document.getElementById('selList');
const $selCount = document.getElementById('selCount');
const $routeBtn = document.getElementById('route');
const $toast = document.getElementById('toast');
const $busy = document.getElementById('busy');
const $busyMsg = document.getElementById('busyMsg');
const $openGMaps = document.getElementById('openGMaps');
const $copyLink = document.getElementById('copyLink');
let toastTimer = null;

// perf caches
const durCache = new Map();   // matrix/sequence cache

// ===== UTILS =====
//#region UTILS
const isFiniteNumber = (n) => typeof n === 'number' && isFinite(n);
function isLngLat(v){
  if (Array.isArray(v) && v.length === 2 && isFiniteNumber(v[0]) && isFiniteNumber(v[1])){
    const [lng,lat]=v; return lng>=-180 && lng<=180 && lat>=-90 && lat<=90;
  }
  if (v && typeof v === 'object'){
    const lng = isFiniteNumber(v.lng) ? v.lng : (isFiniteNumber(v.lon) ? v.lon : null);
    const lat = isFiniteNumber(v.lat) ? v.lat : null;
    if (lng==null || lat==null) return false;
    return lng>=-180 && lng<=180 && lat>=-90 && lat<=90;
  }
  return false;
}
function coordKey(c){ return isLngLat(c) ? (c[0].toFixed(5)+','+c[1].toFixed(5)) : ''; }
function hashBase(stops){ return stops.map(coordKey).join(';'); }

function debounce(fn, ms){
  let t=null;
  return function(...args){
    if (t) clearTimeout(t);
    t = setTimeout(()=> fn.apply(this,args), ms);
  }
}

function showErr(msg){ $error.style.display='block'; $error.textContent = String(msg||''); console.error(msg); }
function clearErr(){ $error.style.display='none'; $error.textContent=''; }
function showToast(msg, ms){
  if (toastTimer) clearTimeout(toastTimer);
  $toast.textContent = msg || '';
  $toast.classList.add('show');
  toastTimer = setTimeout(()=>{ $toast.classList.remove('show'); toastTimer=null; }, ms || 1000);
}
function showBusy(){ $busyMsg.textContent = 'One sec while we create your adventure!'; $busy.style.display='flex'; $busy.setAttribute('aria-hidden','false'); }
function hideBusy(){ $busy.style.display='none'; $busy.setAttribute('aria-hidden','true'); }
function updateRouteButtonLabel(){ $routeBtn.textContent = routeFeature ? 'Update route' : 'Lets Explore'; }
function setExportEnabled(on){
  $openGMaps.disabled = !on;
  $copyLink.disabled  = !on;
  const t = on ? 'Open in Google Maps' : 'Build a route first';
  $openGMaps.title = t; $copyLink.title = on ? 'Copy Google Maps route link' : t;
}
//#endregion

if (!mapboxgl.supported()) showErr('WebGL is disabled or unsupported in this browser.');

// ===== MAP INIT =====
//#region MAP INIT
const map = new mapboxgl.Map({
  container: 'map', style: 'mapbox://styles/mapbox/streets-v12',
  center: [-98.5795, 39.8283], zoom: 4
});
map.addControl(new mapboxgl.NavigationControl(), 'top-right');

function mapPadding(){
  const ui = document.querySelector('.ui'), panel = document.querySelector('.panel');
  const vw = map.getContainer().clientWidth;
  let left = 60;
  if (ui && panel) {
    const uiBox = ui.getBoundingClientRect();
    const panelW = panel.getBoundingClientRect().width;
    left = Math.round(uiBox.left + panelW + 12);
    left = Math.min(left, Math.round(vw * 0.45));
    left = Math.max(left, 60);
  }
  return { top: 60, right: 60, bottom: 60, left };
}
function maybeZoomToStops(){
  if (!(isLngLat(start) && isLngLat(end))) return;
  const b = new mapboxgl.LngLatBounds(); b.extend(start); b.extend(end);
  map.fitBounds(b, { padding: mapPadding(), duration: 600 });
}

let routeVersion = 0;

/* ===== Pulses ===== */
let selPulseHandle = null;
let startPulseHandle = null;
let endPulseHandle = null;

const prefersReducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');

function startSelectedPulse(){
  if (prefersReducedMotion && prefersReducedMotion.matches) return;
  const base = 14, amp = 6, baseOpacity = 0.65;
  function frame(t){
    const s = Math.sin((t || performance.now())/700);
    const radius = base + amp * (0.5 + 0.5*s);
    const opac   = baseOpacity * (0.85 + 0.15*(0.5 + 0.5*s));
    try{
      map.setPaintProperty('pois-sel-glow','circle-radius', radius);
      map.setPaintProperty('pois-sel-glow','circle-opacity', opac);
    }catch(_){}
    selPulseHandle = requestAnimationFrame(frame);
  }
  if (!selPulseHandle) selPulseHandle = requestAnimationFrame(frame);
}

function startStartPulse(){
  if (prefersReducedMotion && prefersReducedMotion.matches) return;
  const base = 20, amp = 8, baseOpacity = 0.6;
  function frame(t){
    const s = Math.sin((t || performance.now())/450);
    const radius = base + amp * (0.5 + 0.5*s);
    const opac   = baseOpacity * (0.80 + 0.20*(0.5 + 0.5*s));
    try{
      map.setPaintProperty('start-glow','circle-radius', radius);
      map.setPaintProperty('start-glow','circle-opacity', opac);
    }catch(_){ }
    startPulseHandle = requestAnimationFrame(frame);
  }
  if (!startPulseHandle) startPulseHandle = requestAnimationFrame(frame);
}

function startEndPulse(){
  if (prefersReducedMotion && prefersReducedMotion.matches) return;
  const base = 20, amp = 8, baseOpacity = 0.6;
  function frame(t){
    const s = Math.sin((t || performance.now())/900);
    const radius = base + amp * (0.5 + 0.5*s);
    const opac   = baseOpacity * (0.80 + 0.20*(0.5 + 0.5*s));
    try{
      map.setPaintProperty('end-glow','circle-radius', radius);
      map.setPaintProperty('end-glow','circle-opacity', opac);
    }catch(_){ }
    endPulseHandle = requestAnimationFrame(frame);
  }
  if (!endPulseHandle) endPulseHandle = requestAnimationFrame(frame);
}

function stopAllPulses(){
  if (selPulseHandle) cancelAnimationFrame(selPulseHandle), selPulseHandle = null;
  if (startPulseHandle) cancelAnimationFrame(startPulseHandle), startPulseHandle = null;
  if (endPulseHandle) cancelAnimationFrame(endPulseHandle), endPulseHandle = null;
}

if (prefersReducedMotion){
  prefersReducedMotion.addEventListener?.('change', e=>{
    stopAllPulses();
    if (!e.matches){ startSelectedPulse(); startStartPulse(); startEndPulse(); }
  });
}

map.on('load', function(){
  map.addSource('route', { type:'geojson', data: emptyFC() });
  map.addLayer({ id:'route', type:'line', source:'route',
    paint:{ 'line-color':'#3b9ddd', 'line-width':4 } });

  // Stops source
  map.addSource('stops', { type:'geojson', data: emptyFC() });

  /* Start (A) */
  map.addLayer({
    id:'start-glow', type:'circle', source:'stops',
    filter:['==',['get','label'],'A'],
    paint:{ 'circle-radius': 20, 'circle-color': ['literal', getComputedStyle(document.documentElement).getPropertyValue('--start-neon').trim() || '#fb4f14'], 'circle-opacity': 0.6, 'circle-blur': 0.85 }
  });
  map.addLayer({ id:'start-core', type:'circle', source:'stops', filter:['==',['get','label'],'A'], paint:{ 'circle-radius': 5, 'circle-color':['literal', getComputedStyle(document.documentElement).getPropertyValue('--start-neon').trim() || '#fb4f14'], 'circle-stroke-color':'#ffffff', 'circle-stroke-width':0 }});

  /* End (B) */
  map.addLayer({ id:'end-glow', type:'circle', source:'stops', filter:['==',['get','label'],'B'], paint:{ 'circle-radius': 20, 'circle-color': ['literal', getComputedStyle(document.documentElement).getPropertyValue('--end-neon').trim() || '#39ff14'], 'circle-opacity': 0.6, 'circle-blur': 0.8 }});
  map.addLayer({ id:'end-ring', type:'circle', source:'stops', filter:['==',['get','label'],'B'], paint:{ 'circle-radius': 10, 'circle-color':'transparent', 'circle-stroke-color':'#ffffff', 'circle-stroke-width':2 }});
  map.addLayer({ id:'end-core', type:'circle', source:'stops', filter:['==',['get','label'],'B'], paint:{ 'circle-radius': 5, 'circle-color':['literal', getComputedStyle(document.documentElement).getPropertyValue('--end-neon').trim() || '#39ff14'], 'circle-stroke-color':'#ffffff', 'circle-stroke-width':1 }});

  /* Other numbered waypoints */
  map.addLayer({ id:'stops-other', type:'circle', source:'stops', filter:['all', ['!=',['get','label'],'A'], ['!=',['get','label'],'B']], paint:{ 'circle-radius':6, 'circle-color':'#e74c3c', 'circle-stroke-width':1, 'circle-stroke-color':'#fff' } });
  map.addLayer({ id:'stops-labels', type:'symbol', source:'stops', layout:{ 'text-field':['get','label'], 'text-size':12, 'text-offset':[0,-1.2], 'text-allow-overlap': true }});

// ================== POIs (Vector tiles) + Candidate Layer ==================

// 1) Full tileset (shows ALL POIs fast)
map.addSource('pois', {
  type: 'vector',
  url: 'mapbox://savagetraveler.2wubp0yh'
});

map.addLayer({
  id: 'pois',
  type: 'circle',
  source: 'pois',
  'source-layer': 'Consolidated_Roadside_Attract-d7sy69', // tileset layer name
  paint: {
    'circle-radius': 5,
    'circle-stroke-width': 1,
    'circle-stroke-color': '#fff',
    // Color by tileset property "Category"
    'circle-color': [
      'match', ['get', 'Category'],
      'Rest Area', '#8b5cf6',
      'Roadside Attraction', '#3b82f6',
      'Welcome Sign', '#8b5e3c',
      'Other', '#9ca3af',
      '#9ca3af'
    ]
  }
});

// 2) Candidate POIs (ONLY those near route + matching filters)
//    We populate this from updateCandidateLayer() after a route exists.
map.addSource('pois-cand', { type: 'geojson', data: emptyFC() });

map.addLayer({
  id: 'pois-cand',
  type: 'circle',
  source: 'pois-cand',
  layout: { visibility: 'none' }, // hidden until a route is built
  paint: {
    'circle-radius': 5,
    'circle-stroke-width': 1,
    'circle-stroke-color': '#fff',
    // Color by our computed GeoJSON property "category"
    'circle-color': [
      'match', ['get', 'category'],
      'Rest Area', '#8b5cf6',
      'Roadside Attraction', '#3b82f6',
      'Welcome Sign', '#8b5e3c',
      'Other', '#9ca3af',
      '#9ca3af'
    ]
  }
});

// 3) Selected POIs (your existing highlight pins stay as-is)
map.addSource('pois-sel', { type: 'geojson', data: emptyFC() });
map.addLayer({ id:'pois-sel-glow', type:'circle', source:'pois-sel',
  paint:{
    'circle-radius': 14,
    'circle-color': ['coalesce',['get','glowColor'],['literal', getComputedStyle(document.documentElement).getPropertyValue('--sel-glow').trim() || '#f8c24a']],
    'circle-opacity': 0.65,
    'circle-blur': 0.7
  }
});
map.addLayer({ id:'pois-sel-ring', type:'circle', source:'pois-sel',
  paint:{ 'circle-radius': 8, 'circle-color':'transparent', 'circle-stroke-color':'#fff', 'circle-stroke-width':2 }
});
map.addLayer({ id:'pois-sel-core', type:'circle', source:'pois-sel',
  paint:{ 'circle-radius': 4, 'circle-color': '#111827', 'circle-stroke-width':1, 'circle-stroke-color':'#fff' }
});

  // Start pulses
  startSelectedPulse(); startStartPulse(); startEndPulse();

  

  // Hover teasers
  const hoverPopup = new mapboxgl.Popup({ closeButton:false, closeOnClick:false, offset:12 });
  map.on('mouseenter','pois', ()=> map.getCanvas().style.cursor='pointer');
  map.on('mouseleave','pois', ()=>{ map.getCanvas().style.cursor=''; hoverPopup.remove(); });
  map.on('mousemove','pois', (e)=>{
    const f = e.features && e.features[0]; if (!f) return;
    const coord = f.geometry && f.geometry.coordinates;
    if (isLngLat(coord)) hoverPopup.setLngLat(coord.slice()).setHTML(poiHoverHtml(f)).addTo(map);
  });

  // Selected POIs hover
  map.on('mouseenter','pois-sel-core', ()=> map.getCanvas().style.cursor='pointer');
  map.on('mouseleave','pois-sel-core', ()=>{ map.getCanvas().style.cursor=''; hoverPopup.remove(); });
  map.on('mousemove','pois-sel-core', (e)=>{
    const f = e.features && e.features[0]; if (!f) return;
    const coord = f.geometry && f.geometry.coordinates;
    const pseudo = { properties: { name: f.properties.name, category: f.properties.category, off: null } };
    if (isLngLat(coord)) hoverPopup.setLngLat(coord.slice()).setHTML(poiHoverHtml(pseudo)).addTo(map);
  });

  // CLICK: full popup for POIs (add/remove)
  let clickPopup = null;
  map.on('click','pois', (e)=>{
    const f = e.features && e.features[0]; if (!f) return;
    if (clickPopup) clickPopup.remove();
    const id = f.properties.id;
    const already = poiWaypoints.some(p => p.id === id);
    const coord = f.geometry && f.geometry.coordinates;
    clickPopup = new mapboxgl.Popup({ closeButton:true, closeOnClick:true, offset:14 });
    if (isLngLat(coord)) clickPopup.setLngLat(coord.slice());
    clickPopup.setHTML(poiActionHtml(f, already)).addTo(map);
    clickPopup.on('close', ()=>{ clickPopup = null; });
  });

  // Add/Remove from popup
  document.body.addEventListener('click', (evt)=>{
    const addBtn = evt.target.closest && evt.target.closest('[data-add-poi]');
    const remBtn = evt.target.closest && evt.target.closest('[data-remove-poi]');
    if (!addBtn && !remBtn) return;

    const id = addBtn ? addBtn.getAttribute('data-add-poi') : remBtn.getAttribute('data-remove-poi');
    const cand = filteredPois.find(p => p.id === id);
    if (!cand) return;

    if (addBtn) {
      if (!poiWaypoints.some(p => p.id === id)) {
        const coord = [cand.lon, cand.lat];
        if (isLngLat(coord)) poiWaypoints.push({ id, name:cand.name, category:cand.category, coord, along:cand.along || 0 });
        showToast('Added to route', 1000);
      }
    } else {
      const i = poiWaypoints.findIndex(p => p.id === id);
      if (i !== -1) { poiWaypoints.splice(i, 1); showToast('Removed', 900); }
    }
    updateSelectedPins();
    renderSelectedList();
    updateExportLink();

    if (clickPopup) { clickPopup.remove(); clickPopup = null; }
  }); // end document.body click handler

  // Initial data + layout tidy
  loadPoisFromUrl(false);
  setTimeout(() => map.resize(), 0);
}); // end map.on('load')
//#endregion MAP INIT

// ===== FILTERS & MINUTES =====
//#region FILTERS & MINUTES
const updateCandidateLayerDebounced = debounce(()=>{
  if (routeFeature) updateCandidateLayer();
}, 450);

$filters.addEventListener('change', (e)=>{
  const cb = e.target;
  if (!cb || cb.type !== 'checkbox') return;
  const cat = cb.getAttribute('data-cat');
  if (cb.checked) activeCats.add(cat); else activeCats.delete(cat);
  updateCandidateLayerDebounced();
});
$minutes.addEventListener('input', updateCandidateLayerDebounced);
$minutes.addEventListener('change', updateCandidateLayerDebounced);
//#endregion

// ===== SELECTED LIST ACTIONS =====
//#region SELECTED LIST
document.getElementById('clearSel').addEventListener('click', ()=>{
  poiWaypoints = [];
  updateSelectedPins();
  renderSelectedList();
  updateExportLink();
});
document.getElementById('applySel').addEventListener('click', ()=>{
  if (!(isLngLat(start) && isLngLat(end))) { showErr('Get a base route first.'); return; }
  showBusy();
  updateRouteWithSelections().catch(e=>showErr(e.message||String(e))).finally(()=>hideBusy());
});
//#endregion

// ===== ROUTE BUTTON =====
//#region ROUTE BUTTON
showToast('⏳ One sec while we build your adventure!', 1500);

document.getElementById('route').onclick = function(){
  clearErr();
  if (!(isLngLat(start) && isLngLat(end))) { showErr('Set both Start and End'); return; }
  showBusy();
  buildOrUpdateRoute().catch(e=>showErr(e.message||String(e))).finally(()=>hideBusy());
};

async function buildOrUpdateRoute(){
  const manual = waypoints.map(w=>w.coord).filter(isLngLat);
  await ensureBaseRoute([start].concat(manual).concat([end]));
  // If no POIs picked, just draw base
  if (!poiWaypoints.length){
    await drawFinalRoute([start].concat(manual).concat([end]));
    map.fitBounds(boundsOfFeature(routeFeature), { padding: mapPadding() });
    updateCandidateLayerDebounced();
    updateRouteButtonLabel();
    updateExportLink();
    return;
  }
  await updateRouteWithSelections(); // will use baseRouteFeature and avoid re-fetching base
}
//#endregion

// ===== GEOCODERS + PICK ON MAP =====
//#region GEOCODERS
let startGeocoder, endGeocoder, picking = null;
const geocoderReady = setInterval(function(){
  if (window.MapboxGeocoder) { clearInterval(geocoderReady); initStartEndGeocoders(); }
}, 50);

function initStartEndGeocoders(){
  startGeocoder = new MapboxGeocoder({
    accessToken: mapboxgl.accessToken, mapboxgl: mapboxgl, marker:false, flyTo:false,
    placeholder: "Enter start location", minLength: 3, limit: 5,
    proximity:{ longitude:-98.5795, latitude:39.8283 }, countries:"us"
  });
  endGeocoder = new MapboxGeocoder({
    accessToken: mapboxgl.accessToken, mapboxgl: mapboxgl, marker:false, flyTo:false,
    placeholder: "Enter destination", minLength: 3, limit: 5,
    proximity:{ longitude:-98.5795, latitude:39.8283 }, countries:"us"
  });
  document.getElementById('geo-start').appendChild(startGeocoder.onAdd(map));
  document.getElementById('geo-end').appendChild(endGeocoder.onAdd(map));

  startGeocoder.on('result', (e)=>{ const c=e.result&&e.result.center; if(!c) return; start=c; startText=e.result.place_name||''; drawStops(); maybeZoomToStops(); updateExportLink(); routeFeature=null; baseRouteFeature=null; });
  startGeocoder.on('clear', ()=>{ start=null; startText=''; routeFeature=null; baseRouteFeature=null; updateRouteButtonLabel(); drawStops(); updateExportLink(); });
  endGeocoder.on('result', (e)=>{ const c=e.result&&e.result.center; if(!c) return; end=c; endText=e.result.place_name||''; drawStops(); maybeZoomToStops(); updateExportLink(); routeFeature=null; baseRouteFeature=null; });
  endGeocoder.on('clear', ()=>{ end=null; endText=''; routeFeature=null; baseRouteFeature=null; updateRouteButtonLabel(); drawStops(); updateExportLink(); });
}

document.getElementById('useClickStart').addEventListener('click', ()=>{
  picking = (picking === 'start') ? null : 'start';
  document.getElementById('useClickStart').textContent = picking==='start' ? 'Click map: picking… (tap to cancel)' : 'Pick start on map';
  document.getElementById('useClickEnd').textContent = 'Pick end on map';
  map.getCanvas().style.cursor = picking ? 'crosshair' : '';
});
document.getElementById('useClickEnd').addEventListener('click', ()=>{
  picking = (picking === 'end') ? null : 'end';
  document.getElementById('useClickEnd').textContent = picking==='end' ? 'Click map: picking… (tap to cancel)' : 'Pick end on map';
  document.getElementById('useClickStart').textContent = 'Pick start on map';
  map.getCanvas().style.cursor = picking ? 'crosshair' : '';
});
map.on('click', (e)=>{
  if (!picking) return;
  const lngLat = [e.lngLat.lng, e.lngLat.lat];
  if (picking === 'start') { start = lngLat; startText = `${lngLat[1].toFixed(5)}, ${lngLat[0].toFixed(5)}`; startGeocoder?.setInput?.(startText); }
  else { end = lngLat; endText = `${lngLat[1].toFixed(5)}, ${lngLat[0].toFixed(5)}`; endGeocoder?.setInput?.(endText); }
  picking = null; map.getCanvas().style.cursor = ''; drawStops(); maybeZoomToStops(); updateExportLink(); routeFeature=null; baseRouteFeature=null;
  document.getElementById('useClickStart').textContent = 'Pick start on map';
  document.getElementById('useClickEnd').textContent = 'Pick end on map';
});

document.getElementById('useMyLocation').addEventListener('click', ()=>{
  if (!('geolocation' in navigator)) { showErr('Geolocation not available.'); return; }
  navigator.geolocation.getCurrentPosition(async (pos)=>{
    const {latitude, longitude} = pos.coords;
    const label = await reverseGeocode([longitude, latitude]).catch(()=>`${latitude.toFixed(5)}, ${longitude.toFixed(5)}`);
    start = [longitude, latitude]; startText = label;
    startGeocoder?.setInput?.(label);
    drawStops(); maybeZoomToStops(); updateExportLink(); routeFeature=null; baseRouteFeature=null;
  }, ()=> showErr('Could not get location.'), { enableHighAccuracy:true, timeout:15000, maximumAge:30000 });
});
async function reverseGeocode(lngLat){
  const url = 'https://api.mapbox.com/geocoding/v5/mapbox.places/'+lngLat[0]+','+lngLat[1]+'.json?access_token='+mapboxgl.accessToken+'&limit=1&types=address,place,locality,neighborhood,poi';
  const r = await fetch(url); if (!r.ok) throw 0; const j = await r.json();
  return j?.features?.[0]?.place_name || `${lngLat[1].toFixed(5)}, ${lngLat[0].toFixed(5)}`;
}
//#endregion

// ===== WAYPOINTS =====
//#region WAYPOINTS
document.getElementById('addWp').addEventListener('click', ()=>{
  if (waypoints.length >= MAX_GEO_WAYPOINTS) return;
  addWaypointGeocoder();
});
function addWaypointGeocoder(){
  const id = 'wp_'+Date.now()+'_'+Math.floor(Math.random()*1e6);
  const row = document.createElement('div');
  row.className = 'row';
  row.innerHTML =
    '<div style="width:12px;height:12px;border-radius:50%;background:#999"></div>'+
    '<div class="slot pill"><div id="'+id+'_geo"></div></div>'+
    '<button class="btn-sm wp-remove" title="Remove">×</button>';
  $wpContainer.appendChild(row);
  const gc = new MapboxGeocoder({
    accessToken: mapboxgl.accessToken, mapboxgl: mapboxgl, marker:false, flyTo:false,
    placeholder:"Add destination", minLength: 3, limit: 5,
    proximity:{ longitude:-98.5795, latitude:39.8283 }, countries:"us"
  });
  row.querySelector('#'+id+'_geo').appendChild(gc.onAdd(map));
  const wp = { id, el:row, geocoder:gc, coord:null, text:'' };
  waypoints.push(wp);
  gc.on('result', (e)=>{ const c=e.result&&e.result.center; if(!c) return; wp.coord=c; wp.text=e.result.place_name||''; drawStops(); maybeZoomToStops(); updateExportLink(); routeFeature=null; baseRouteFeature=null; });
  gc.on('clear', ()=>{ wp.coord=null; wp.text=''; drawStops(); maybeZoomToStops(); updateExportLink(); routeFeature=null; baseRouteFeature=null; });
  row.querySelector('.wp-remove').addEventListener('click', ()=>{
    try{ gc.clear?.(); gc.onRemove?.(map); }catch(e){}
    row.remove();
    const i=waypoints.findIndex(w=>w.id===id); if(i!==-1) waypoints.splice(i,1);
    drawStops(); maybeZoomToStops(); updateExportLink(); routeFeature=null; baseRouteFeature=null;
  });
}
//#endregion

// ===== CANDIDATE POIs =====
//#region POI FILTERING
function updateCandidateLayer(){
  // No route yet → clear and hide candidates
  if (!routeFeature) {
    filteredPois = [];
    const src0 = map.getSource('pois-cand');
    if (src0 && typeof src0.setData === 'function') src0.setData(emptyFC());
    try { map.setLayoutProperty('pois-cand', 'visibility', 'none'); } catch(_) {}
    return;
  }

  const oneWayMiles = (Math.max(5, Number($minutes.value) || 20) / 2) * (AVERAGE_SPEED_MPH / 60);
  const line = routeFeature;

  // Build a tight bbox around the route so we don’t scan the whole country
  const b = boundsOfFeature(line);
  const pad = 0.75; // degrees
  const bbox = [ b.getWest() - pad, b.getSouth() - pad, b.getEast() + pad, b.getNorth() + pad ];

  // Pull features from your Mapbox tileset (vector source)
  const raw = map.querySourceFeatures('pois', {
    sourceLayer: 'Consolidated_Roadside_Attract-d7sy69'
  });

  const out = [];
  for (let i = 0; i < raw.length; i++){
    const f = raw[i];
    if (!f || !f.geometry || !Array.isArray(f.geometry.coordinates)) continue;

    const [lon, lat] = f.geometry.coordinates;

    // quick bbox reject to limit work
    if (lon < bbox[0] || lon > bbox[2] || lat < bbox[1] || lat > bbox[3]) continue;

    const props = f.properties || {};
    const cat   = (props[CATEGORY_FIELD] || 'Other') + '';
    if (!activeCats.has(cat)) continue;

    // distance from the route (one-way)
    let offMiles = Infinity, along = 0;
    try {
      const np = turf.nearestPointOnLine(line, turf.point([lon, lat]), { units: 'miles' });
      offMiles = np.properties.dist;
      along    = np.properties.location || 0;
    } catch(_) {}

    if (offMiles <= oneWayMiles){
      out.push({
        id: 'poi_' + i,
        name: (props[NAME_FIELD] || 'POI') + '',
        category: cat,
        lat, lon, off: offMiles, along,
        description: (props[DESC_FIELD] || '') + '',
        url: (props[URL_FIELD] || '') + ''
      });
    }
  }

  // order by progress along route then by closest off-route
  out.sort((a,b) => a.along === b.along ? a.off - b.off : a.along - b.along);
  filteredPois = out;

  // write candidates to the GeoJSON source
  const candSrc = map.getSource('pois-cand');
  if (candSrc && typeof candSrc.setData === 'function'){
    candSrc.setData({
      type:'FeatureCollection',
      features: out.map(c => ({
        type:'Feature',
        geometry:{ type:'Point', coordinates:[c.lon, c.lat] },
        properties:{ id:c.id, name:c.name, category:c.category, description:c.description, off:c.off, url:c.url }
      }))
    });
  }

  // show only candidate points
  try { map.setLayoutProperty('pois', 'visibility', 'none'); } catch(_) {}
  try { map.setLayoutProperty('pois-cand', 'visibility', out.length ? 'visible' : 'none'); } catch(_) {}

  // keep the selected pins layer in sync
  updateSelectedPins();
}

// Selected POIs layer (small white-ring markers you already have)
function updateSelectedPins(){
  const src = map.getSource('pois-sel');
  if (!src) return;
  const feats = poiWaypoints
    .filter(p => isLngLat(p.coord))
    .map(p => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: p.coord },
      properties: { id: p.id, name: p.name, category: p.category }
    }));
  src.setData({ type:'FeatureCollection', features: feats });
}
//#endregion



 

// ===== BASE ROUTE HANDLING =====
//#region BASE ROUTE
async function ensureBaseRoute(stops){
  const k = hashBase(stops);
  if (baseRouteFeature && baseKey === k) return; // already fresh
  const f = await getDirectionsFeature(stops);
  baseRouteFeature = f;
  baseKey = k;

  // Debug toast
  showToast('✅ Base route updated', 1000);
}

async function drawFinalRoute(stops){
  const f = await getDirectionsFeature(stops);
  routeFeature = f;
  map.getSource('route').setData({ type:'FeatureCollection', features:[routeFeature] });

  // update summary from final route (best available)
  const km = turf.length(routeFeature, {units:'kilometers'});
  const mi = km*0.621371;
  $summary.textContent = 'Distance: '+mi.toFixed(1)+' mi ('+km.toFixed(1)+' km)';
  drawStops();
  updateRouteButtonLabel();

  // Debug toast
  showToast('✅ Route ready', 1000);
}

async function getDirectionsFeature(coords){
  if (!Array.isArray(coords) || coords.length < 2) throw new Error('Need at least start and end.');
  for (let i=0;i<coords.length;i++){ if (!isLngLat(coords[i])) throw new Error('Invalid coordinate at index '+i); }
  const coordStr = coords.map(c => c[0]+','+c[1]).join(';');
  const url = 'https://api.mapbox.com/directions/v5/mapbox/'+PROFILE+'/'+coordStr+'?geometries=geojson&overview=full&steps=false&access_token='+mapboxgl.accessToken;
  const res = await fetch(url);
  if (!res.ok) {
    if (res.status === 422) throw new Error('Directions temporarily unavailable. Please try again.');
    if (res.status === 403) throw new Error('403 from Mapbox. Check your token URL restrictions.');
    throw new Error('HTTP '+res.status+' fetching directions');
  }
  const data = await res.json();
  if (!(data.routes && data.routes.length)) throw new Error('No route found');
  const r = data.routes[0];
  return { type:'Feature', geometry:r.geometry, properties:{} };
}
//#endregion


// ===== CORRIDOR CHAINING (DETOURS) =====
//#region ROUTING CORE
async function updateRouteWithSelections(){
  const manual = waypoints.map(w=>w.coord).filter(isLngLat);
  const baseStops = [start].concat(manual).concat([end]);
  await ensureBaseRoute(baseStops);
  const baseLine = baseRouteFeature;

  // Project POIs along base route, order by progress
  const ordered = poiWaypoints.slice();
  for (let i=0;i<ordered.length;i++){
    try{
      const np = turf.nearestPointOnLine(baseLine, turf.point(ordered[i].coord), { units: 'miles' });
      ordered[i].along = np.properties.location || 0;
      ordered[i].off = np.properties.dist || 0;
    }catch(e){ ordered[i].along = 0; ordered[i].off = 0; }
  }
  ordered.sort((a,b)=> (a.along||0)-(b.along||0));

  const lineLenMi = turf.length(baseLine, {units:'miles'});

  // build chains (greedy forward) with cap
  const chains = [];
  let i = 0;
  while (i < ordered.length){
    const chain = [ordered[i]];
    let j = i + 1;
    while (j < ordered.length && chain.length < CHAIN_LOOKAHEAD){
      const prev = chain[chain.length-1];
      const cand = ordered[j];
      if ((cand.along - prev.along) < 0.1) { j++; continue; }
      if (Math.abs(cand.off) <= CORRIDOR_WIDTH_MI){ chain.push(cand); j++; }
      else break;
    }
    chains.push(chain.slice(0, MAX_CHAIN_POIS));
    i = j;
  }

  const finalStops = [start].concat(manual);

  for (let c = 0; c < chains.length; c++){
    const chain = chains[c];
    if (!chain.length) continue;

    const first = chain[0];
    const last = chain[chain.length-1];

    const entryAlong = Math.max(0, (first.along||0) - BACKBONE_BIAS_MI);
    const exitSoonAlong = Math.min(lineLenMi, (first.along||0) + BACKBONE_BIAS_MI);
    const exitLaterAlong = Math.min(lineLenMi, (last.along||0) + Math.max(BACKBONE_BIAS_MI*2, 20));
    const entryPt = turf.along(baseLine, entryAlong, {units:'miles'}).geometry.coordinates;
    const exitSoonPt = turf.along(baseLine, exitSoonAlong, {units:'miles'}).geometry.coordinates;
    const exitLaterPt = turf.along(baseLine, exitLaterAlong, {units:'miles'}).geometry.coordinates;

    // Build one matrix for both A and B
    const pts = [entryPt].concat(chain.map(x=>x.coord)).concat([exitSoonPt, exitLaterPt]);
    const M = await getMatrix(pts); // durations matrix

    function seqCost(idxArray){
      let total = 0;
      for (let k=0;k<idxArray.length-1;k++){
        const a = idxArray[k], b = idxArray[k+1];
        const d = M[a][b];
        if (d!=null && isFinite(d)) total += d;
      }
      return total;
    }

    // indices: [0]=entry, [1..n]=chain items, [n+1]=exitSoon, [n+2]=exitLater
    const n = chain.length;
    const costA = seqCost([0,1,n+1]) + REJOIN_PENALTY_MIN*60;            // entry -> first -> exitSoon
    const costB = seqCost([0].concat(Array.from({length:n}, (_,k)=>1+k)).concat([n+2])) + REJOIN_PENALTY_MIN*60; // entry -> all -> exitLater

    const pickB = costB <= costA;
    if (pickB){
      finalStops.push(entryPt);
      chain.forEach(p=> finalStops.push(p.coord));
      finalStops.push(exitLaterPt);
    } else {
      finalStops.push(entryPt);
      finalStops.push(chain[0].coord);
      finalStops.push(exitSoonPt);
      if (chain.length > 1){
        const remainder = chain.slice(1);
        chains.splice(c+1, 0, remainder);
      }
    }
  }

  // Append end
  finalStops.push(end);

  // Draw final route
  await drawFinalRoute(finalStops);
  map.fitBounds(boundsOfFeature(routeFeature), { padding: mapPadding() });
  updateCandidateLayerDebounced();
  renderSelectedList();
  updateRouteButtonLabel();
  updateExportLink();
}
//#endregion

// ===== MATRIX HELPERS =====
//#region MATRIX
async function getMatrix(points){
  const key = 'mx:'+points.map(coordKey).join('|');
  if (durCache.has(key)) return durCache.get(key);
  const coords = points.map(p=> p[0]+','+p[1]).join(';');
  const url = 'https://api.mapbox.com/directions-matrix/v1/mapbox/'+PROFILE+'/'+coords+'?annotations=duration&access_token='+mapboxgl.accessToken;
  const r = await fetch(url);
  if (!r.ok) throw new Error('Matrix HTTP '+r.status);
  const j = await r.json();
  const M = j && j.durations;
  if (!M) throw new Error('Matrix no durations');
  durCache.set(key, M);
  return M;
}
//#endregion

// ===== SELECTED LIST RENDER =====
//#region SELECTED RENDER
function renderSelectedList(){
  const items = poiWaypoints.slice().sort((a,b)=> (a.along||0)-(b.along||0));
  $selCount.textContent = '('+items.length+')';
  const tgt = document.getElementById('selList'); tgt.innerHTML = '';
  if (!items.length){ tgt.innerHTML = '<div class="stat" style="padding:8px 10px">No attractions selected yet.</div>'; return; }
  const frag = document.createDocumentFragment();
  for (let i=0;i<items.length;i++){
    const it = items[i];
    const row = document.createElement('div');
    row.className = 'sel-row';
    row.innerHTML =
      '<span class="sel-name" title="'+escapeHtml(it.name)+'">'+escapeHtml(it.name)+'</span>'+
      (it.category ? '<span class="stat">'+escapeHtml(it.category)+'</span>' : '')+
      '<button class="btn-sm" data-remove-sel="'+it.id+'" title="Remove">×</button>';
    frag.appendChild(row);
  }
  tgt.appendChild(frag);
}
document.body.addEventListener('click', function(evt){
  const btn = evt.target.closest && evt.target.closest('[data-remove-sel]');
  if (!btn) return;
  const id = btn.getAttribute('data-remove-sel');
  const i = poiWaypoints.findIndex(p=>p.id === id);
  if (i !== -1) poiWaypoints.splice(i, 1);
  updateSelectedPins();
  renderSelectedList();
  updateExportLink();
});
//#endregion

// ===== EXPORT TO GOOGLE MAPS =====
//#region EXPORT
document.getElementById('openGMaps').addEventListener('click', function(){
  const url = buildGoogleMapsUrl();
  if (!url) return;
  window.open(url, '_blank', 'noopener');
});
document.getElementById('copyLink').addEventListener('click', async function(){
  const url = buildGoogleMapsUrl();
  if (!url) return;
  try{ await navigator.clipboard.writeText(url); showToast('Link copied'); }
  catch(_){ const ta = document.createElement('textarea'); ta.value = url; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); showToast('Link copied'); }
});

function buildGoogleMapsUrl(){
  if (!(isLngLat(start) && isLngLat(end))) return null;
  const orderedPOIs = poiWaypoints.slice().sort((a,b)=> (a.along||0)-(b.along||0)).map(p=>p.coord).filter(isLngLat);
  const manual = waypoints.map(w=>w.coord).filter(isLngLat);
  const stops = [start].concat(manual).concat(orderedPOIs).concat([end]);
  const origin = latlon(stops[0]);
  const destination = latlon(stops[stops.length-1]);
  const mid = stops.slice(1, -1).slice(0, 20).map(latlon).filter(Boolean).join('|');
  const params = new URLSearchParams({ api:'1', origin, destination, travelmode:'driving' });
  if (mid) params.set('waypoints', mid);
  return 'https://www.google.com/maps/dir/?' + params.toString();
}
function latlon(c){ return (Array.isArray(c) && isLngLat(c)) ? (c[1].toFixed(6)+','+c[0].toFixed(6)) : ''; }
function updateExportLink(){ setExportEnabled(!!(isLngLat(start) && isLngLat(end))); }
//#endregion

// ===== HELPERS =====
//#region HELPERS
function poiHoverHtml(f){
  const name = (f.properties && f.properties.name) || 'POI';
  const category = (f.properties && f.properties.category) || 'Other';
  const off = (f.properties && typeof f.properties.off === 'number') ? f.properties.off : null;
  return '<div style="font:13px/1.3 system-ui,-apple-system,Segoe UI,Roboto,Arial)">'+
           '<div style="font-weight:700;margin-bottom:2px)">'+escapeHtml(name)+'</div>'+
           '<div style="color:#6b7280)">'+escapeHtml(category)+(off!=null? ' · ~'+off.toFixed(1)+' mi off-route':'')+'</div>'+
         '</div>';
}
function poiActionHtml(f, already){
  const coord = f.geometry.coordinates;
  const name = (f.properties && f.properties.name) || 'POI';
  const category = (f.properties && f.properties.category) || 'Other';
  const desc = (f.properties && f.properties.description) || '';
  const id = (f.properties && f.properties.id) || '';
  const url = (f.properties && f.properties.url && /^https?:\/\//i.test(f.properties.url)) ? f.properties.url : '';
  const lat = coord[1]; const lon = coord[0];
  const gmaps = (lat!=null && lon!=null) ? ('https://www.google.com/maps/search/?api=1&query='+lat.toFixed(6)+','+lon.toFixed(6)) : '#';
  const anchor = url ? '<a href="'+escapeAttr(url)+'" target="_blank" rel="noopener" style="color:#1a73e8;text-decoration:none">Open in Google Maps ↗</a>' : '<a href="'+gmaps+'" target="_blank" rel="noopener" style="color:#1a73e8;text-decoration:none">Open in Google Maps ↗</a>';
  const off = f.properties && f.properties.off;
  const btn = already ? '<button data-remove-poi="'+id+'" style="margin-top:8px">Remove from route</button>' : '<button data-add-poi="'+id+'" style="margin-top:8px">Add to route</button>';

  return ''+
    '<div style="font:13px/1.35 system-ui,-apple-system,Segoe UI,Roboto,Arial; max-width:260px)">'+
      '<div style="font-weight:700;margin-bottom:2px)">'+escapeHtml(name)+'</div>'+
      '<div style="color:#6b7280;margin-bottom:6px)">'+escapeHtml(category)+(typeof off==='number' ? ' · ~'+off.toFixed(1)+' mi off-route' : '')+'</div>'+
      (desc ? '<div style="margin:6px 0)">'+escapeHtml(desc)+'</div>' : '')+
      '<div style="display:flex; gap:10px; align-items:center; margin-top:6px; flex-wrap:wrap)">'+
        anchor+
        btn+
      '</div>'+
    '</div>';
}
function escapeHtml(str){
  return String(str || '').replace(/[&<>"']/g, s => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  })[s]);
}
function escapeAttr(str){ return String(str||'').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function emptyFC(){ return { type:'FeatureCollection', features: [] }; }
function boundsOfFeature(f){
  const b = new mapboxgl.LngLatBounds();
  if (f && f.geometry && f.geometry.type === 'LineString'){
    for (const c of f.geometry.coordinates){ if (isLngLat(c)) b.extend([c[0], c[1]]); }
  }
  return b;
}
function pt(label, lnglat){ return { type:'Feature', geometry:{ type:'Point', coordinates: lnglat }, properties:{ label } }; }

function drawStops(){
  const features = [];
  if (isLngLat(start)) features.push(pt('A', start));
  waypoints.forEach((w,i)=>{ if (isLngLat(w.coord)) features.push(pt(String(i+1), w.coord)); });
  if (isLngLat(end)) features.push(pt('B', end));
  const src = map.getSource('stops'); if (src) src.setData({ type:'FeatureCollection', features });
}

function normalizeCategory(raw){
  const s = (raw || '').toString().trim().toLowerCase();
  if (!s) return 'Other';
  if (/rest\s*area/.test(s)) return 'Rest Area';
  if (/roadside/.test(s)) return 'Roadside Attraction';
  if (/welcome\s*sign/.test(s)) return 'Welcome Sign';
  return 'Other';
}

function addRowsToPois(rows, fieldsOrder){
  if ((!fieldsOrder || !fieldsOrder.length) && rows && rows.length && typeof rows[0] === 'object'){ fieldsOrder = Object.keys(rows[0]); }
  const colHKey = (Array.isArray(fieldsOrder) && fieldsOrder.length >= 8) ? fieldsOrder[7] : null;

  for (let i=0;i<(rows||[]).length;i++){
    const r = rows[i];
    const lat = num(r.lat || r.latitude || r.Latitude || r.Y || r.y);
    const lon = num(r.lon || r.lng || r.longitude || r.Longitude || r.X || r.x);
    if (lat == null || lon == null || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;

    const name = (r.name || r.title || r.Name || r.Type || '').toString().trim() || 'POI';
    const category = normalizeCategory((r.category || r.Category || '').toString());
    const desc = (r.description || r.desc || '').toString().trim();

    let url = '';
    if (colHKey && r[colHKey]) {
      const candidateH = String(r[colHKey]).trim();
      if (/^https?:\/\//i.test(candidateH)) url = candidateH;
    }
    if (!url) {
      const known = (r.url || r.URL || r.link || r.Link || r.website || r.Website ||
                     r['Google Maps URL'] || r['GoogleMapsURL'] || r['Link URL'] || r['Hyperlink'] || '');
      const cand2 = String(known).trim();
      if (/^https?:\/\//i.test(cand2)) url = cand2;
    }
    if (!url) {
      const keys = (Array.isArray(fieldsOrder) && fieldsOrder.length) ? fieldsOrder : Object.keys(r);
      for (let k=0;k<keys.length;k++){
        const v = (r[keys[k]] != null ? String(r[keys[k]]).trim() : '');
        if (/^https?:\/\//i.test(v)) { url = v; break; }
      }
    }

    pois.push({ name, lat, lon, category, description:desc, url });
  }
}

function num(v){ if (v===undefined||v===null) return null; const s=String(v).trim().replace(/,/g,''); const n=Number(s); return isFinite(n)?n:null; }

function loadPoisFromUrl(force){
  force = !!force;
  const now = Date.now();
  const cached = localStorage.getItem(POI_CACHE_KEY);
  if (!force && cached){
    try{
      const obj = JSON.parse(cached);
      if (obj && Array.isArray(obj.pois) && obj.pois.length){
        const freshEnough = obj.ts && (now - obj.ts) < POI_CACHE_TTL_MS;
        if (freshEnough){
          pois = obj.pois;
          if (routeFeature) updateCandidateLayerDebounced();
          return Promise.resolve();
        }
      }
    }catch(e){}
  }
  return fetch(POI_URL, { mode: 'cors' }).then(res=>{
    if (!res.ok) throw new Error('HTTP '+res.status+' fetching POIs');
    return res.text();
  }).then(text=>{
    const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
    pois = [];
    addRowsToPois(parsed.data, (parsed.meta && parsed.meta.fields) ? parsed.meta.fields : []);
    localStorage.setItem(POI_CACHE_KEY, JSON.stringify({ pois, ts: now }));
    if (routeFeature) updateCandidateLayerDebounced();
  }).catch(err=>{
    const cached2 = localStorage.getItem(POI_CACHE_KEY);
    if (cached2){
      try{
        const obj2 = JSON.parse(cached2);
        if (obj2 && Array.isArray(obj2.pois) && obj2.pois.length){
          pois = obj2.pois;
          if (routeFeature) updateCandidateLayerDebounced();
          showErr('Live fetch failed ('+(err && err.message ? err.message : err)+'). Using cached POIs.');
          return;
        }
      }catch(e){}
    }
    showErr('Failed to load POIs from URL. '+(err && err.message ? err.message : err)+'.');
  });
}
//#endregion

// ===== INIT =====
//#region INIT
updateRouteButtonLabel();
setExportEnabled(false);
//#endregion
