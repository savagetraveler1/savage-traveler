// ===== BASIC CONFIG =====
mapboxgl.accessToken =
  'pk.eyJ1Ijoic2F2YWdldHJhdmVsZXIiLCJhIjoiY21mZzl2dXVvMDBmODJrcHVzbno1YzRkZyJ9.fGvMUrtwKnDgTf2qmOeQTA'

// ===== POI VECTOR CONFIG =====
// These two names tell Mapbox what to call the POI layer
const POI_VECTOR_SOURCE_ID = 'pois'
const POI_VECTOR_LAYER_ID = 'Consolidated_Roadside_Attract-d7sy69'

// 'Steve Jobs' mode with speed tweaks
const AVERAGE_SPEED_MPH = 55
const PROFILE = 'driving-traffic'
const MAX_GEO_WAYPOINTS = 5
const BACKBONE_BIAS_MI = 6 // preferred rejoin distance
const CORRIDOR_WIDTH_MI = 25 // width to consider same-heading POIs
const CHAIN_LOOKAHEAD = 3 // trimmed lookahead
const MAX_CHAIN_POIS = 3 // cap per chain for speed
const REJOIN_PENALTY_MIN = 6 // soft penalty for each freeway rejoin

const POI_URL =
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vQptJKid_rUcBSdL2fzwSU2RhG3NqeiiRL_0OQ1yRleFNwBbZWxuMKzPqiAhYn15sfNkO8NzDgAZ0Qg/pub?output=csv'
const POI_CACHE_KEY = 'poi_cache_v4::' + POI_URL
const POI_CACHE_TTL_MS = 12 * 60 * 60 * 1000 // 12h

// ===== FIELD KEYS FROM TILESET (Mapbox vector source) =====
const NAME_FIELD = 'Name'
const CATEGORY_FIELD = 'Category'
const LAT_FIELD = 'Latitude'
const LON_FIELD = 'Longitude'
const DESC_FIELD = 'Description'
const URL_FIELD = 'Google Maps URL'

// ===== STATE & REFS =====
let start = null,
  end = null
let routeFeature = null // current drawn route (final with detours)
let baseRouteFeature = null // backbone-only geometry (cached)
let baseKey = '' // hash of start+manual+end when base was computed

let startText = '',
  endText = ''
let baseDistanceM = 0,
  baseDurationSec = 0

let pois = []
let filteredPois = []
let poiWaypoints = [] // {id,name,category,coord,along}
let waypoints = []
let activeCats = new Set(['Rest Area', 'Roadside Attraction', 'Welcome Sign', 'Other'])

const $minutes = document.getElementById('minutes')
const $summary = document.getElementById('summary')
const $error = document.getElementById('error')
const $filters = document.getElementById('filters')
const $wpContainer = document.getElementById('waypoints')
const $selList = document.getElementById('selList')
const $selCount = document.getElementById('selCount')
const $routeBtn = document.getElementById('route')
const $toast = document.getElementById('toast')
const $busy = document.getElementById('busy')
const $busyMsg = document.getElementById('busyMsg')
const $openGMaps = document.getElementById('openGMaps')
const $copyLink = document.getElementById('copyLink')
// Rebuild candidates & corridor when minutes change

let toastTimer = null
let _poisCandRetryTimer = null

// perf caches
const durCache = new Map() // matrix/sequence cache

// ===== UTILS =====
// TODO [UTILS]
//#region UTILS
const isFiniteNumber = n => typeof n === 'number' && isFinite(n)
function isLngLat(v) {
  if (Array.isArray(v) && v.length === 2 && isFiniteNumber(v[0]) && isFiniteNumber(v[1])) {
    const [lng, lat] = v
    return lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90
  }
  if (v && typeof v === 'object') {
    const lng = isFiniteNumber(v.lng) ? v.lng : isFiniteNumber(v.lon) ? v.lon : null
    const lat = isFiniteNumber(v.lat) ? v.lat : null
    if (lng == null || lat == null) return false
    return lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90
  }
  return false
}
function coordKey(c) {
  return isLngLat(c) ? c[0].toFixed(5) + ',' + c[1].toFixed(5) : ''
}
function hashBase(stops) {
  return stops.map(coordKey).join(';')
}

function debounce(fn, ms) {
  let t = null
  return function (...args) {
    if (t) clearTimeout(t)
    t = setTimeout(() => fn.apply(this, args), ms)
  }
}

function showErr(msg) {
  $error.style.display = 'block'
  $error.textContent = String(msg || '')
  console.error(msg)
}
function clearErr() {
  $error.style.display = 'none'
  $error.textContent = ''
}
function showToast(msg, ms) {
  if (toastTimer) clearTimeout(toastTimer)
  $toast.textContent = msg || ''
  $toast.classList.add('show')
  toastTimer = setTimeout(() => {
    $toast.classList.remove('show')
    toastTimer = null
  }, ms || 1000)
}
function showBusy() {
  $busyMsg.textContent = 'One sec while we create your adventure!'
  $busy.style.display = 'flex'
  $busy.setAttribute('aria-hidden', 'false')
}
function hideBusy() {
  $busy.style.display = 'none'
  $busy.setAttribute('aria-hidden', 'true')
}
function updateRouteButtonLabel() {
  $routeBtn.textContent = routeFeature ? 'Update route' : 'Lets Explore'
}
function setExportEnabled(on) {
  $openGMaps.disabled = !on
  $copyLink.disabled = !on
  const t = on ? 'Open in Google Maps' : 'Build a route first'
  $openGMaps.title = t
  $copyLink.title = on ? 'Copy Google Maps route link' : t
}
//#endregion

if (!mapboxgl.supported()) showErr('WebGL is disabled or unsupported in this browser.')

// ===== MAP INIT =====
// TODO [MAP_INIT]
//#region MAP INIT
const map = new mapboxgl.Map({
  container: 'map',
  style: 'mapbox://styles/mapbox/streets-v12',
  center: [-98.5795, 39.8283],
  zoom: 4,
})
map.addControl(new mapboxgl.NavigationControl(), 'top-right')

function mapPadding() {
  const ui = document.querySelector('.ui'),
    panel = document.querySelector('.panel')
  const vw = map.getContainer().clientWidth
  let left = 60
  if (ui && panel) {
    const uiBox = ui.getBoundingClientRect()
    const panelW = panel.getBoundingClientRect().width
    left = Math.round(uiBox.left + panelW + 12)
    left = Math.min(left, Math.round(vw * 0.45))
    left = Math.max(left, 60)
  }
  return { top: 60, right: 60, bottom: 60, left }
}
function maybeZoomToStops() {
  if (!(isLngLat(start) && isLngLat(end))) return
  const b = new mapboxgl.LngLatBounds()
  b.extend(start)
  b.extend(end)
  map.fitBounds(b, { padding: mapPadding(), duration: 600 })
}

let routeVersion = 0

/* ===== Pulses ===== */
let selPulseHandle = null
let startPulseHandle = null
let endPulseHandle = null

const prefersReducedMotion =
  window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)')

function startSelectedPulse() {
  if (prefersReducedMotion && prefersReducedMotion.matches) return
  const base = 14,
    amp = 6,
    baseOpacity = 0.65
  function frame(t) {
    const s = Math.sin((t || performance.now()) / 700)
    const radius = base + amp * (0.5 + 0.5 * s)
    const opac = baseOpacity * (0.85 + 0.15 * (0.5 + 0.5 * s))
    try {
      map.setPaintProperty('pois-sel-glow', 'circle-radius', radius)
      map.setPaintProperty('pois-sel-glow', 'circle-opacity', opac)
    } catch (_) {}
    selPulseHandle = requestAnimationFrame(frame)
  }
  if (!selPulseHandle) selPulseHandle = requestAnimationFrame(frame)
}

function startStartPulse() {
  if (prefersReducedMotion && prefersReducedMotion.matches) return
  const base = 20,
    amp = 8,
    baseOpacity = 0.6
  function frame(t) {
    const s = Math.sin((t || performance.now()) / 450)
    const radius = base + amp * (0.5 + 0.5 * s)
    const opac = baseOpacity * (0.8 + 0.2 * (0.5 + 0.5 * s))
    try {
      map.setPaintProperty('start-glow', 'circle-radius', radius)
      map.setPaintProperty('start-glow', 'circle-opacity', opac)
    } catch (_) {}
    startPulseHandle = requestAnimationFrame(frame)
  }
  if (!startPulseHandle) startPulseHandle = requestAnimationFrame(frame)
}

function startEndPulse() {
  if (prefersReducedMotion && prefersReducedMotion.matches) return
  const base = 20,
    amp = 8,
    baseOpacity = 0.6
  function frame(t) {
    const s = Math.sin((t || performance.now()) / 900)
    const radius = base + amp * (0.5 + 0.5 * s)
    const opac = baseOpacity * (0.8 + 0.2 * (0.5 + 0.5 * s))
    try {
      map.setPaintProperty('end-glow', 'circle-radius', radius)
      map.setPaintProperty('end-glow', 'circle-opacity', opac)
    } catch (_) {}
    endPulseHandle = requestAnimationFrame(frame)
  }
  if (!endPulseHandle) endPulseHandle = requestAnimationFrame(frame)
}

function stopAllPulses() {
  if (selPulseHandle) cancelAnimationFrame(selPulseHandle), (selPulseHandle = null)
  if (startPulseHandle) cancelAnimationFrame(startPulseHandle), (startPulseHandle = null)
  if (endPulseHandle) cancelAnimationFrame(endPulseHandle), (endPulseHandle = null)
}

if (prefersReducedMotion) {
  prefersReducedMotion.addEventListener?.('change', e => {
    stopAllPulses()
    if (!e.matches) {
      startSelectedPulse()
      startStartPulse()
      startEndPulse()
    }
  })
}

map.on('load', function () {
  // ---- Route source/layer ----
  map.addSource('route', { type: 'geojson', data: emptyFC() })
  map.addLayer({
    id: 'route',
    type: 'line',
    source: 'route',
    paint: { 'line-color': '#3b9ddd', 'line-width': 4 },
  })

  // ---- Route corridor (highlight band) ----
  // Source holds the buffered polygon around the current route
  map.addSource('route-corridor', { type: 'geojson', data: emptyFC() })

  // Soft highlighter fill (very light yellow)
  // Inserted *below* the route line by using the 'beforeId' of 'route'
  map.addLayer(
    {
      id: 'route-corridor-fill',
      type: 'fill',
      source: 'route-corridor',
      paint: {
        'fill-color': '#fef9c3', // light yellow
        'fill-opacity': 0.1, // very subtle
      },
    },
    'route' // beforeId → draw under the route line
  )

  // Golden border to show exact corridor edge
  map.addLayer(
    {
      id: 'route-corridor-outline',
      type: 'line',
      source: 'route-corridor',
      paint: {
        'line-color': '#facc15', // darker yellow/gold
        'line-opacity': 0.4,
        'line-width': 2,
      },
    },
    'route' // keep under the crisp route line
  )

  // ---- Stops source ----
  map.addSource('stops', { type: 'geojson', data: emptyFC() })

  /* Start (A) */
  map.addLayer({
    id: 'start-glow',
    type: 'circle',
    source: 'stops',
    filter: ['==', ['get', 'label'], 'A'],
    paint: {
      'circle-radius': 20,
      'circle-color': [
        'literal',
        getComputedStyle(document.documentElement).getPropertyValue('--start-neon').trim() ||
          '#fb4f14',
      ],
      'circle-opacity': 0.6,
      'circle-blur': 0.85,
    },
  })
  map.addLayer({
    id: 'start-core',
    type: 'circle',
    source: 'stops',
    filter: ['==', ['get', 'label'], 'A'],
    paint: {
      'circle-radius': 5,
      'circle-color': [
        'literal',
        getComputedStyle(document.documentElement).getPropertyValue('--start-neon').trim() ||
          '#fb4f14',
      ],
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 0,
    },
  })

  /* End (B) */
  map.addLayer({
    id: 'end-glow',
    type: 'circle',
    source: 'stops',
    filter: ['==', ['get', 'label'], 'B'],
    paint: {
      'circle-radius': 20,
      'circle-color': [
        'literal',
        getComputedStyle(document.documentElement).getPropertyValue('--end-neon').trim() ||
          '#39ff14',
      ],
      'circle-opacity': 0.6,
      'circle-blur': 0.8,
    },
  })
  map.addLayer({
    id: 'end-ring',
    type: 'circle',
    source: 'stops',
    filter: ['==', ['get', 'label'], 'B'],
    paint: {
      'circle-radius': 10,
      'circle-color': 'transparent',
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 2,
    },
  })
  map.addLayer({
    id: 'end-core',
    type: 'circle',
    source: 'stops',
    filter: ['==', ['get', 'label'], 'B'],
    paint: {
      'circle-radius': 5,
      'circle-color': [
        'literal',
        getComputedStyle(document.documentElement).getPropertyValue('--end-neon').trim() ||
          '#39ff14',
      ],
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 1,
    },
  })

  /* Other numbered waypoints */
  map.addLayer({
    id: 'stops-other',
    type: 'circle',
    source: 'stops',
    filter: ['all', ['!=', ['get', 'label'], 'A'], ['!=', ['get', 'label'], 'B']],
    paint: {
      'circle-radius': 6,
      'circle-color': '#e74c3c',
      'circle-stroke-width': 1,
      'circle-stroke-color': '#fff',
    },
  })
  map.addLayer({
    id: 'stops-labels',
    type: 'symbol',
    source: 'stops',
    layout: {
      'text-field': ['get', 'label'],
      'text-size': 12,
      'text-offset': [0, -1.2],
      'text-allow-overlap': true,
    },
  })

  // ================== POIs (Vector tiles) + Candidate Layer ==================

  // 1) Full tileset (shows ALL POIs fast)
  map.addSource('pois', {
    type: 'vector',
    url: 'mapbox://savagetraveler.2wubp0yh',
  })

  // Default hidden on load
  map.addLayer({
    id: 'pois',
    type: 'circle',
    source: 'pois',
    /* TODO[FIX-002]: Use the shared vector layer constant */
    'source-layer': POI_VECTOR_LAYER_ID,

    layout: { visibility: 'none' }, // <-- keep POIs hidden initially
    paint: {
      'circle-radius': 5,
      'circle-stroke-width': 1,
      'circle-stroke-color': '#fff',
      // Color by tileset property "Category"
      'circle-color': [
        'match',
        ['get', 'Category'],
        'Rest Area',
        '#8b5cf6',
        'Roadside Attraction',
        '#3b82f6',
        'Welcome Sign',
        '#8b5e3c',
        'Other',
        '#9ca3af',
        '#9ca3af',
      ],
    },
  })

  // Safety net: ensure hidden even if style reloads before gating flips them on
  if (typeof setPoiVisibility === 'function') {
    setPoiVisibility(false)
  }

  // 2) Candidate POIs (ONLY those near route + matching filters)
  //    We populate this from updateCandidateLayer() after a route exists.
  map.addSource('pois-cand', { type: 'geojson', data: emptyFC() })

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
        'match',
        ['get', 'category'],
        'Rest Area',
        '#8b5cf6',
        'Roadside Attraction',
        '#3b82f6',
        'Welcome Sign',
        '#8b5e3c',
        'Other',
        '#9ca3af',
        '#9ca3af',
      ],
    },
  })

  // 3) Selected POIs (your existing highlight pins stay as-is)
  map.addSource('pois-sel', { type: 'geojson', data: emptyFC() })
  map.addLayer({
    id: 'pois-sel-glow',
    type: 'circle',
    source: 'pois-sel',
    paint: {
      'circle-radius': 14,
      'circle-color': [
        'coalesce',
        ['get', 'glowColor'],
        [
          'literal',
          getComputedStyle(document.documentElement).getPropertyValue('--sel-glow').trim() ||
            '#f8c24a',
        ],
      ],
      'circle-opacity': 0.65,
      'circle-blur': 0.7,
    },
  })
  map.addLayer({
    id: 'pois-sel-ring',
    type: 'circle',
    source: 'pois-sel',
    paint: {
      'circle-radius': 8,
      'circle-color': 'transparent',
      'circle-stroke-color': '#fff',
      'circle-stroke-width': 2,
    },
  })
  map.addLayer({
    id: 'pois-sel-core',
    type: 'circle',
    source: 'pois-sel',
    paint: {
      'circle-radius': 4,
      'circle-color': '#111827',
      'circle-stroke-width': 1,
      'circle-stroke-color': '#fff',
    },
  })

  // Start pulses
  startSelectedPulse()
  startStartPulse()
  startEndPulse()

  // Hover teasers (bind to corridor candidates)
  const hoverPopup = new mapboxgl.Popup({ closeButton: false, closeOnClick: false, offset: 12 })
  map.on('mouseenter', 'pois-cand', () => (map.getCanvas().style.cursor = 'pointer'))
  map.on('mouseleave', 'pois-cand', () => {
    map.getCanvas().style.cursor = ''
    hoverPopup.remove()
  })
  map.on('mousemove', 'pois-cand', e => {
    const f = e.features && e.features[0]
    if (!f) return
    const coord = f.geometry && f.geometry.coordinates
    if (isLngLat(coord)) hoverPopup.setLngLat(coord.slice()).setHTML(poiHoverHtml(f)).addTo(map)
  })

  // Selected POIs hover
  map.on('mouseenter', 'pois-sel-core', () => (map.getCanvas().style.cursor = 'pointer'))
  map.on('mouseleave', 'pois-sel-core', () => {
    map.getCanvas().style.cursor = ''
    hoverPopup.remove()
  })
  map.on('mousemove', 'pois-sel-core', e => {
    const f = e.features && e.features[0]
    if (!f) return
    const coord = f.geometry && f.geometry.coordinates
    const pseudo = {
      properties: { name: f.properties.name, category: f.properties.category, off: null },
    }
    if (isLngLat(coord))
      hoverPopup.setLngLat(coord.slice()).setHTML(poiHoverHtml(pseudo)).addTo(map)
  })

  // CLICK: full popup for POIs (add/remove) — bind to corridor candidates
  let clickPopup = null
  map.on('click', 'pois-cand', e => {
    const f = e.features && e.features[0]
    if (!f) return
    if (clickPopup) clickPopup.remove()
    const id = f.properties.id
    const already = poiWaypoints.some(p => p.id === id)
    const coord = f.geometry && f.geometry.coordinates
    clickPopup = new mapboxgl.Popup({ closeButton: true, closeOnClick: true, offset: 14 })
    if (isLngLat(coord)) clickPopup.setLngLat(coord.slice())
    clickPopup.setHTML(poiActionHtml(f, already)).addTo(map)
    clickPopup.on('close', () => {
      clickPopup = null
    })
  })

  // Add/Remove from popup
  document.body.addEventListener('click', evt => {
    const addBtn = evt.target.closest && evt.target.closest('[data-add-poi]')
    const remBtn = evt.target.closest && evt.target.closest('[data-remove-poi]')
    if (!addBtn && !remBtn) return

    const id = addBtn ? addBtn.getAttribute('data-add-poi') : remBtn.getAttribute('data-remove-poi')
    const cand = filteredPois.find(p => p.id === id)
    if (!cand) return

    if (addBtn) {
      if (!poiWaypoints.some(p => p.id === id)) {
        const coord = [cand.lon, cand.lat]
        if (isLngLat(coord))
          poiWaypoints.push({
            id,
            name: cand.name,
            category: cand.category,
            coord,
            along: cand.along || 0,
          })
        showToast('Added to route', 1000)
      }
    } else {
      const i = poiWaypoints.findIndex(p => p.id === id)
      if (i !== -1) {
        poiWaypoints.splice(i, 1)
        showToast('Removed', 900)
      }
    }
    updateSelectedPins()
    renderSelectedList()
    updateExportLink()

    if (clickPopup) {
      clickPopup.remove()
      clickPopup = null
    }
  }) // end document.body click handler

  // Initial data + layout tidy
  loadPoisFromUrl(false)
  setTimeout(() => map.resize(), 0)
}) // end map.on('load')
//#endregion MAP INIT

// ===== FILTERS & MINUTES =====
//#region FILTERS & MINUTES
const updateCandidateLayerDebounced = debounce(() => {
  if (routeFeature) updateCandidateLayer()
}, 450)

$filters.addEventListener('change', e => {
  const cb = e.target
  if (!cb || cb.type !== 'checkbox') return
  const cat = cb.getAttribute('data-cat')
  if (cb.checked) activeCats.add(cat)
  else activeCats.delete(cat)
  updateCandidateLayerDebounced()
})
$minutes.addEventListener('input', updateCandidateLayerDebounced)
$minutes.addEventListener('change', updateCandidateLayerDebounced)
//#endregion

// ===== SELECTED LIST ACTIONS =====
//#region SELECTED LIST
document.getElementById('clearSel').addEventListener('click', () => {
  poiWaypoints = []
  updateSelectedPins()
  renderSelectedList()
  updateExportLink()
})
document.getElementById('applySel').addEventListener('click', () => {
  if (!(isLngLat(start) && isLngLat(end))) {
    showErr('Get a base route first.')
    return
  }
  showBusy()
  updateRouteWithSelections()
    .catch(e => showErr(e.message || String(e)))
    .finally(() => hideBusy())
})
//#endregion

// ===== ROUTE BUTTON =====
// TODO [ROUTE_BUTTON]
//#region ROUTE BUTTON
showToast('⏳ One sec while we build your adventure!', 1500)

document.getElementById('route').onclick = function () {
  clearErr()
  if (!(isLngLat(start) && isLngLat(end))) {
    showErr('Set both Start and End')
    return
  }
  showBusy()
  buildOrUpdateRoute()
    .catch(e => showErr(e.message || String(e)))
    .finally(() => hideBusy())
}

async function buildOrUpdateRoute() {
  const manual = waypoints.map(w => w.coord).filter(isLngLat)
  await ensureBaseRoute([start].concat(manual).concat([end]))
  // If no POIs picked, just draw base
  if (!poiWaypoints.length) {
    await drawFinalRoute([start].concat(manual).concat([end]))
    map.fitBounds(boundsOfFeature(routeFeature), { padding: mapPadding() })
    updateCandidateLayerDebounced()
    updateRouteButtonLabel()
    updateExportLink()
    return
  }
  await updateRouteWithSelections() // will use baseRouteFeature and avoid re-fetching base
}
//#endregion

// ===== GEOCODERS + PICK ON MAP =====
// TODO [GEOCODERS]
//#region GEOCODERS
let startGeocoder,
  endGeocoder,
  picking = null
const geocoderReady = setInterval(function () {
  if (window.MapboxGeocoder) {
    clearInterval(geocoderReady)
    initStartEndGeocoders()
  }
}, 50)

function initStartEndGeocoders() {
  startGeocoder = new MapboxGeocoder({
    accessToken: mapboxgl.accessToken,
    mapboxgl: mapboxgl,
    marker: false,
    flyTo: false,
    placeholder: 'Enter start location',
    minLength: 3,
    limit: 5,
    proximity: { longitude: -98.5795, latitude: 39.8283 },
    countries: 'us',
  })
  endGeocoder = new MapboxGeocoder({
    accessToken: mapboxgl.accessToken,
    mapboxgl: mapboxgl,
    marker: false,
    flyTo: false,
    placeholder: 'Enter destination',
    minLength: 3,
    limit: 5,
    proximity: { longitude: -98.5795, latitude: 39.8283 },
    countries: 'us',
  })
  document.getElementById('geo-start').appendChild(startGeocoder.onAdd(map))
  document.getElementById('geo-end').appendChild(endGeocoder.onAdd(map))

  startGeocoder.on('result', e => {
    const c = e.result && e.result.center
    if (!c) return
    start = c
    startText = e.result.place_name || ''
    drawStops()
    maybeZoomToStops()
    updateExportLink()
    routeFeature = null
    baseRouteFeature = null
  })
  startGeocoder.on('clear', () => {
    start = null
    startText = ''
    routeFeature = null
    baseRouteFeature = null
    updateRouteButtonLabel()
    drawStops()
    updateExportLink()
  })
  endGeocoder.on('result', e => {
    const c = e.result && e.result.center
    if (!c) return
    end = c
    endText = e.result.place_name || ''
    drawStops()
    maybeZoomToStops()
    updateExportLink()
    routeFeature = null
    baseRouteFeature = null
  })
  endGeocoder.on('clear', () => {
    end = null
    endText = ''
    routeFeature = null
    baseRouteFeature = null
    updateRouteButtonLabel()
    drawStops()
    updateExportLink()
  })
}

document.getElementById('useClickStart').addEventListener('click', () => {
  picking = picking === 'start' ? null : 'start'
  document.getElementById('useClickStart').textContent =
    picking === 'start' ? 'Click map: picking… (tap to cancel)' : 'Pick start on map'
  document.getElementById('useClickEnd').textContent = 'Pick end on map'
  map.getCanvas().style.cursor = picking ? 'crosshair' : ''
})
document.getElementById('useClickEnd').addEventListener('click', () => {
  picking = picking === 'end' ? null : 'end'
  document.getElementById('useClickEnd').textContent =
    picking === 'end' ? 'Click map: picking… (tap to cancel)' : 'Pick end on map'
  document.getElementById('useClickStart').textContent = 'Pick start on map'
  map.getCanvas().style.cursor = picking ? 'crosshair' : ''
})
map.on('click', e => {
  if (!picking) return
  const lngLat = [e.lngLat.lng, e.lngLat.lat]
  if (picking === 'start') {
    start = lngLat
    startText = `${lngLat[1].toFixed(5)}, ${lngLat[0].toFixed(5)}`
    startGeocoder?.setInput?.(startText)
  } else {
    end = lngLat
    endText = `${lngLat[1].toFixed(5)}, ${lngLat[0].toFixed(5)}`
    endGeocoder?.setInput?.(endText)
  }
  picking = null
  map.getCanvas().style.cursor = ''
  drawStops()
  maybeZoomToStops()
  updateExportLink()
  routeFeature = null
  baseRouteFeature = null
  document.getElementById('useClickStart').textContent = 'Pick start on map'
  document.getElementById('useClickEnd').textContent = 'Pick end on map'
})

/* TODO[FIX-001]: Correct button id + null-safe binding */
const useMyLocBtn = document.getElementById('btnUseMyLocation')
if (useMyLocBtn) {
  useMyLocBtn.addEventListener('click', () => {
    if (!('geolocation' in navigator)) {
      showErr('Geolocation not available.')
      return
    }
    navigator.geolocation.getCurrentPosition(
      async pos => {
        const { latitude, longitude } = pos.coords
        const label = await reverseGeocode([longitude, latitude]).catch(
          () => `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`
        )
        start = [longitude, latitude]
        startText = label
        startGeocoder?.setInput?.(label)
        drawStops()
        maybeZoomToStops()
        updateExportLink()
        routeFeature = null
        baseRouteFeature = null
      },
      () => showErr('Could not get location.'),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 }
    )
  })
} else {
  console.warn('btnUseMyLocation not found in DOM')
}

async function reverseGeocode(lngLat) {
  const url =
    'https://api.mapbox.com/geocoding/v5/mapbox.places/' +
    lngLat[0] +
    ',' +
    lngLat[1] +
    '.json?access_token=' +
    mapboxgl.accessToken +
    '&limit=1&types=address,place,locality,neighborhood,poi'
  const r = await fetch(url)
  if (!r.ok) throw 0
  const j = await r.json()
  return j?.features?.[0]?.place_name || `${lngLat[1].toFixed(5)}, ${lngLat[0].toFixed(5)}`
}
//#endregion

// ===== WAYPOINTS =====
// TODO [WAYPOINTS]
//#region WAYPOINTS
document.getElementById('addWp').addEventListener('click', () => {
  if (waypoints.length >= MAX_GEO_WAYPOINTS) return
  addWaypointGeocoder()
})
function addWaypointGeocoder() {
  const id = 'wp_' + Date.now() + '_' + Math.floor(Math.random() * 1e6)
  const row = document.createElement('div')
  row.className = 'row'
  row.innerHTML =
    '<div style="width:12px;height:12px;border-radius:50%;background:#999"></div>' +
    '<div class="slot pill"><div id="' +
    id +
    '_geo"></div></div>' +
    '<button class="btn-sm wp-remove" title="Remove">×</button>'
  $wpContainer.appendChild(row)
  const gc = new MapboxGeocoder({
    accessToken: mapboxgl.accessToken,
    mapboxgl: mapboxgl,
    marker: false,
    flyTo: false,
    placeholder: 'Add destination',
    minLength: 3,
    limit: 5,
    proximity: { longitude: -98.5795, latitude: 39.8283 },
    countries: 'us',
  })
  row.querySelector('#' + id + '_geo').appendChild(gc.onAdd(map))
  const wp = { id, el: row, geocoder: gc, coord: null, text: '' }
  waypoints.push(wp)
  gc.on('result', e => {
    const c = e.result && e.result.center
    if (!c) return
    wp.coord = c
    wp.text = e.result.place_name || ''
    drawStops()
    maybeZoomToStops()
    updateExportLink()
    routeFeature = null
    baseRouteFeature = null
  })
  gc.on('clear', () => {
    wp.coord = null
    wp.text = ''
    drawStops()
    maybeZoomToStops()
    updateExportLink()
    routeFeature = null
    baseRouteFeature = null
  })
  row.querySelector('.wp-remove').addEventListener('click', () => {
    try {
      gc.clear?.()
      gc.onRemove?.(map)
    } catch (e) {}
    row.remove()
    const i = waypoints.findIndex(w => w.id === id)
    if (i !== -1) waypoints.splice(i, 1)
    drawStops()
    maybeZoomToStops()
    updateExportLink()
    routeFeature = null
    baseRouteFeature = null
  })
}
//#endregion

// ===== CANDIDATE POIs =====
//#region POI FILTERING
function updateCandidateLayer(retry = 0) {
  // (debug removed)

  // (Warm POI tiles invisibly so there is no flash)
  try {
    if (map.isStyleLoaded && map.isStyleLoaded() && map.getLayer('pois')) {
      // Demand tiles but keep the layer fully transparent
      map.setLayoutProperty('pois', 'visibility', 'visible')
      map.setPaintProperty('pois', 'circle-opacity', 0)
      map.setPaintProperty('pois', 'circle-stroke-opacity', 0)
    }
  } catch (_) {}

  // No route yet → clear and hide candidates + corridor
  if (!routeFeature) {
    filteredPois = []

    // clear candidate geojson
    const candSrc = map.getSource('pois-cand')
    if (candSrc && typeof candSrc.setData === 'function')
      candSrc.setData({ type: 'FeatureCollection', features: [] })
    try {
      if (map.getLayer('pois-cand')) map.setLayoutProperty('pois-cand', 'visibility', 'none')
    } catch (_) {}

    // clear corridor geojson
    const corSrc = map.getSource('route-corridor')
    if (corSrc && typeof corSrc.setData === 'function')
      corSrc.setData({ type: 'FeatureCollection', features: [] })
    try {
      if (map.getLayer('route-corridor-fill'))
        map.setLayoutProperty('route-corridor-fill', 'visibility', 'none')
      if (map.getLayer('route-corridor-outline'))
        map.setLayoutProperty('route-corridor-outline', 'visibility', 'none')
    } catch (_) {}

    return // <- this return is safely inside the function
  }

  // … keep the rest of updateCandidateLayer here (corridor build, querySourceFeatures, filtering, etc.)

  // Corridor width from minutes (one-way)
  const minutesRaw = parseFloat($minutes.value)
  const minutesSafe = Number.isFinite(minutesRaw) && minutesRaw > 0 ? minutesRaw : 20
  const oneWayMiles = minutesSafe * (AVERAGE_SPEED_MPH / 60)
  const line = routeFeature

  // Build/update the corridor polygon and show it
  try {
    const corridor = turf.buffer(line, oneWayMiles, { units: 'miles' })
    window.ROUTE_BUFFER = corridor
    const corSrc = map.getSource('route-corridor')
    if (corSrc && typeof corSrc.setData === 'function') corSrc.setData(corridor)
    try {
      if (map.getLayer('route-corridor-fill'))
        map.setLayoutProperty('route-corridor-fill', 'visibility', 'visible')
      if (map.getLayer('route-corridor-outline'))
        map.setLayoutProperty('route-corridor-outline', 'visibility', 'visible')
    } catch (_) {}
  } catch (err) {
    console.warn('Corridor build failed:', err)
  }

  // ... your existing code below here remains unchanged ...

  // Build a tight bbox around the route so we don’t scan the whole country
  const b = boundsOfFeature(line)
  const pad = 0.75 // degrees
  const bbox = [b.getWest() - pad, b.getSouth() - pad, b.getEast() + pad, b.getNorth() + pad]

  // ---- Pull features from your Mapbox tileset (discover source + layer at runtime) ----
  function _findPoiLayerInfo() {
    const style = map.getStyle && map.getStyle()
    if (!style || !Array.isArray(style.layers)) return null

    // Heuristics: circle/symbol layer whose id or source-layer looks like POIs
    const looksPoi = l =>
      /poi|attract|rest|welcome|roadside/i.test(l.id) ||
      /poi|attract|rest|welcome|roadside/i.test(l['source-layer'] || '')

    const candidates = style.layers.filter(
      l =>
        (l.type === 'circle' || l.type === 'symbol') && looksPoi(l) && l.source && l['source-layer']
    )

    // Prefer literal 'pois' id if present, else first candidate
    const layer = candidates.find(l => l.id === 'pois') || candidates[0]
    if (!layer) return null

    return { id: layer.id, srcId: layer.source, srcLayer: layer['source-layer'] }
  }

  const poiInfo = _findPoiLayerInfo()

  // If the POI layer isn't in the style yet, wait and retry
  if (!poiInfo) {
    console.info(
      '[POI] Base layer not in style yet (retry=%d). Waiting for style/layers…',
      retry || 0
    )
    if ((retry || 0) < 20) {
      clearTimeout(_poisCandRetryTimer)
      _poisCandRetryTimer = setTimeout(() => updateCandidateLayer((retry || 0) + 1), 350)
      return
    } else {
      console.warn('[POI] Gave up after retries — no POI layer found in style.')
      return
    }
  }

  // (Keep the POI base layer visible so the tiles can load; we'll hide again later)
  try {
    if (map.isStyleLoaded() && map.getLayer('pois')) {
      map.setLayoutProperty('pois', 'visibility', 'visible')
    }
  } catch (_) {}
  const _loadedCount = map.querySourceFeatures(poiInfo.srcId, {
    sourceLayer: poiInfo.srcLayer,
  }).length
  if (_loadedCount === 0) {
    // tiles not here yet — wait a tick and try again
    if ((retry || 0) < 15) {
      clearTimeout(_poisCandRetryTimer)
      _poisCandRetryTimer = setTimeout(() => updateCandidateLayer((retry || 0) + 1), 250)
      return
    } else {
      console.warn('[POI] No tiles after retries; continuing anyway.')
    }
  }

  // tiles are present — now do the real query
  const raw = map.querySourceFeatures(poiInfo.srcId, { sourceLayer: poiInfo.srcLayer }) || []

  const out = []

  for (let i = 0; i < raw.length; i++) {
    const f = raw[i]
    if (!f || !f.geometry || !Array.isArray(f.geometry.coordinates)) continue

    const [lon, lat] = f.geometry.coordinates

    // quick bbox reject to limit work
    if (lon < bbox[0] || lon > bbox[2] || lat < bbox[1] || lat > bbox[3]) continue

    const props = f.properties || {}
    const rawCat = props[CATEGORY_FIELD] || 'Other'
    const cat = normalizeCategory(rawCat)
    if (!activeCats.has(cat)) continue

    // distance from the route (one-way)
    let offMiles = Infinity,
      along = 0
    try {
      const np = turf.nearestPointOnLine(line, turf.point([lon, lat]), { units: 'miles' })
      offMiles = np.properties.dist
      along = np.properties.location || 0
    } catch (_) {}

    if (offMiles <= oneWayMiles) {
      out.push({
        id: 'poi_' + i,
        name: (props[NAME_FIELD] || 'POI') + '',
        category: cat,
        lat,
        lon,
        off: offMiles,
        along,
        description: (props[DESC_FIELD] || '') + '',
        url: (props[URL_FIELD] || '') + '',
      })
    }
  }

  // order by progress along route then by closest off-route
  out.sort((a, b) => (a.along === b.along ? a.off - b.off : a.along - b.along))
  filteredPois = out

  // write candidates to the GeoJSON source
  const candSrc = map.getSource('pois-cand')
  if (candSrc && typeof candSrc.setData === 'function') {
    candSrc.setData({
      type: 'FeatureCollection',
      features: out.map(c => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [c.lon, c.lat] },
        properties: {
          id: c.id,
          name: c.name,
          category: c.category,
          description: c.description,
          off: c.off,
          url: c.url,
        },
      })),
    })
  }

  // Make sure the candidates are actually visible and on top;
  // keep the base POIs fully hidden so there’s no flash.
  try {
    if (map.getLayer('pois-cand')) {
      map.setLayoutProperty('pois-cand', 'visibility', 'visible')
      map.moveLayer('pois-cand') // bring above any base layer
    }
    if (map.getLayer('pois')) {
      map.setPaintProperty('pois', 'circle-opacity', 0)
      map.setPaintProperty('pois', 'circle-stroke-opacity', 0)
      map.setLayoutProperty('pois', 'visibility', 'none')
    }
  } catch (_) {}

  // show only candidate points
  try {
    map.setLayoutProperty('pois', 'visibility', 'none')
  } catch (_) {}
  try {
    map.setLayoutProperty('pois-cand', 'visibility', out.length ? 'visible' : 'none')
  } catch (_) {}

  // keep the selected pins layer in sync
  updateSelectedPins()
}

// Selected POIs layer (small white-ring markers you already have)
function updateSelectedPins() {
  const src = map.getSource('pois-sel')
  if (!src) return
  const feats = poiWaypoints
    .filter(p => isLngLat(p.coord))
    .map(p => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: p.coord },
      properties: { id: p.id, name: p.name, category: p.category },
    }))
  src.setData({ type: 'FeatureCollection', features: feats })
}
//#endregion

// ===== BASE ROUTE HANDLING =====
// TODO [BASE_ROUTE]
//#region BASE ROUTE
async function ensureBaseRoute(stops) {
  const k = hashBase(stops)
  if (baseRouteFeature && baseKey === k) return // already fresh
  const f = await getDirectionsFeature(stops)
  baseRouteFeature = f
  baseKey = k

  // Debug toast
  showToast('✅ Base route updated', 1000)
}

async function drawFinalRoute(stops) {
  const f = await getDirectionsFeature(stops)
  routeFeature = f
  map.getSource('route').setData({ type: 'FeatureCollection', features: [routeFeature] })
  updateCandidateLayer(0) // build corridor + candidate POIs with current minutes

  // --- Corridor: simple fixed-width buffer to verify rendering ---
  // Uses turf to buffer the current route line into a polygon band.
  // For now, use a fixed 10 miles so we can visually confirm the layer works.

  // update summary from final route (best available)
  const km = turf.length(routeFeature, { units: 'kilometers' })
  const mi = km * 0.621371
  $summary.textContent = 'Distance: ' + mi.toFixed(1) + ' mi (' + km.toFixed(1) + ' km)'
  drawStops()
  updateRouteButtonLabel()

  // Debug toast
  showToast('✅ Route ready', 1000)
}

async function getDirectionsFeature(coords) {
  if (!Array.isArray(coords) || coords.length < 2) throw new Error('Need at least start and end.')
  for (let i = 0; i < coords.length; i++) {
    if (!isLngLat(coords[i])) throw new Error('Invalid coordinate at index ' + i)
  }
  const coordStr = coords.map(c => c[0] + ',' + c[1]).join(';')
  const url =
    'https://api.mapbox.com/directions/v5/mapbox/' +
    PROFILE +
    '/' +
    coordStr +
    '?geometries=geojson&overview=full&steps=false&access_token=' +
    mapboxgl.accessToken
  const res = await fetch(url)
  if (!res.ok) {
    if (res.status === 422) throw new Error('Directions temporarily unavailable. Please try again.')
    if (res.status === 403) throw new Error('403 from Mapbox. Check your token URL restrictions.')
    throw new Error('HTTP ' + res.status + ' fetching directions')
  }
  const data = await res.json()
  if (!(data.routes && data.routes.length)) throw new Error('No route found')
  const r = data.routes[0]
  return { type: 'Feature', geometry: r.geometry, properties: {} }
}
//#endregion

// ===== CORRIDOR CHAINING (DETOURS) =====
// TODO [ROUTING_CORE]
//#region ROUTING CORE
async function updateRouteWithSelections() {
  const manual = waypoints.map(w => w.coord).filter(isLngLat)
  const baseStops = [start].concat(manual).concat([end])
  await ensureBaseRoute(baseStops)
  const baseLine = baseRouteFeature

  // Project POIs along base route, order by progress
  const ordered = poiWaypoints.slice()
  for (let i = 0; i < ordered.length; i++) {
    try {
      const np = turf.nearestPointOnLine(baseLine, turf.point(ordered[i].coord), { units: 'miles' })
      ordered[i].along = np.properties.location || 0
      ordered[i].off = np.properties.dist || 0
    } catch (e) {
      ordered[i].along = 0
      ordered[i].off = 0
    }
  }
  ordered.sort((a, b) => (a.along || 0) - (b.along || 0))

  const lineLenMi = turf.length(baseLine, { units: 'miles' })

  // build chains (greedy forward) with cap
  const chains = []
  let i = 0
  while (i < ordered.length) {
    const chain = [ordered[i]]
    let j = i + 1
    while (j < ordered.length && chain.length < CHAIN_LOOKAHEAD) {
      const prev = chain[chain.length - 1]
      const cand = ordered[j]
      if (cand.along - prev.along < 0.1) {
        j++
        continue
      }
      if (Math.abs(cand.off) <= CORRIDOR_WIDTH_MI) {
        chain.push(cand)
        j++
      } else break
    }
    chains.push(chain.slice(0, MAX_CHAIN_POIS))
    i = j
  }

  const finalStops = [start].concat(manual)

  for (let c = 0; c < chains.length; c++) {
    const chain = chains[c]
    if (!chain.length) continue

    const first = chain[0]
    const last = chain[chain.length - 1]

    const entryAlong = Math.max(0, (first.along || 0) - BACKBONE_BIAS_MI)
    const exitSoonAlong = Math.min(lineLenMi, (first.along || 0) + BACKBONE_BIAS_MI)
    const exitLaterAlong = Math.min(
      lineLenMi,
      (last.along || 0) + Math.max(BACKBONE_BIAS_MI * 2, 20)
    )
    const entryPt = turf.along(baseLine, entryAlong, { units: 'miles' }).geometry.coordinates
    const exitSoonPt = turf.along(baseLine, exitSoonAlong, { units: 'miles' }).geometry.coordinates
    const exitLaterPt = turf.along(baseLine, exitLaterAlong, { units: 'miles' }).geometry
      .coordinates

    // Build one matrix for both A and B
    const pts = [entryPt].concat(chain.map(x => x.coord)).concat([exitSoonPt, exitLaterPt])
    const M = await getMatrix(pts) // durations matrix

    function seqCost(idxArray) {
      let total = 0
      for (let k = 0; k < idxArray.length - 1; k++) {
        const a = idxArray[k],
          b = idxArray[k + 1]
        const d = M[a][b]
        if (d != null && isFinite(d)) total += d
      }
      return total
    }

    // indices: [0]=entry, [1..n]=chain items, [n+1]=exitSoon, [n+2]=exitLater
    const n = chain.length
    const costA = seqCost([0, 1, n + 1]) + REJOIN_PENALTY_MIN * 60 // entry -> first -> exitSoon
    const costB =
      seqCost([0].concat(Array.from({ length: n }, (_, k) => 1 + k)).concat([n + 2])) +
      REJOIN_PENALTY_MIN * 60 // entry -> all -> exitLater

    const pickB = costB <= costA
    if (pickB) {
      finalStops.push(entryPt)
      chain.forEach(p => finalStops.push(p.coord))
      finalStops.push(exitLaterPt)
    } else {
      finalStops.push(entryPt)
      finalStops.push(chain[0].coord)
      finalStops.push(exitSoonPt)
      if (chain.length > 1) {
        const remainder = chain.slice(1)
        chains.splice(c + 1, 0, remainder)
      }
    }
  }

  // Append end
  finalStops.push(end)

  // Draw final route
  await drawFinalRoute(finalStops)
  map.fitBounds(boundsOfFeature(routeFeature), { padding: mapPadding() })
  updateCandidateLayerDebounced()
  renderSelectedList()
  updateRouteButtonLabel()
  updateExportLink()
}
//#endregion

// ===== MATRIX HELPERS =====
// TODO [MATRIX]
//#region MATRIX
async function getMatrix(points) {
  const key = 'mx:' + points.map(coordKey).join('|')
  if (durCache.has(key)) return durCache.get(key)
  const coords = points.map(p => p[0] + ',' + p[1]).join(';')
  const url =
    'https://api.mapbox.com/directions-matrix/v1/mapbox/' +
    PROFILE +
    '/' +
    coords +
    '?annotations=duration&access_token=' +
    mapboxgl.accessToken
  const r = await fetch(url)
  if (!r.ok) throw new Error('Matrix HTTP ' + r.status)
  const j = await r.json()
  const M = j && j.durations
  if (!M) throw new Error('Matrix no durations')
  durCache.set(key, M)
  return M
}
//#endregion

// ===== SELECTED LIST RENDER =====
// TODO [SELECTED_RENDER]
//#region SELECTED RENDER
function renderSelectedList() {
  const items = poiWaypoints.slice().sort((a, b) => (a.along || 0) - (b.along || 0))
  $selCount.textContent = '(' + items.length + ')'
  const tgt = document.getElementById('selList')
  tgt.innerHTML = ''
  if (!items.length) {
    tgt.innerHTML = '<div class="stat" style="padding:8px 10px">No attractions selected yet.</div>'
    return
  }
  const frag = document.createDocumentFragment()
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    const row = document.createElement('div')
    row.className = 'sel-row'
    row.innerHTML =
      '<span class="sel-name" title="' +
      escapeHtml(it.name) +
      '">' +
      escapeHtml(it.name) +
      '</span>' +
      (it.category ? '<span class="stat">' + escapeHtml(it.category) + '</span>' : '') +
      '<button class="btn-sm" data-remove-sel="' +
      it.id +
      '" title="Remove">×</button>'
    frag.appendChild(row)
  }
  tgt.appendChild(frag)
}
document.body.addEventListener('click', function (evt) {
  const btn = evt.target.closest && evt.target.closest('[data-remove-sel]')
  if (!btn) return
  const id = btn.getAttribute('data-remove-sel')
  const i = poiWaypoints.findIndex(p => p.id === id)
  if (i !== -1) poiWaypoints.splice(i, 1)
  updateSelectedPins()
  renderSelectedList()
  updateExportLink()
})
//#endregion

// ===== EXPORT TO GOOGLE MAPS =====
// TODO [EXPORT]
//#region EXPORT
document.getElementById('openGMaps').addEventListener('click', function () {
  const url = buildGoogleMapsUrl()
  if (!url) return
  window.open(url, '_blank', 'noopener')
})
document.getElementById('copyLink').addEventListener('click', async function () {
  const url = buildGoogleMapsUrl()
  if (!url) return
  try {
    await navigator.clipboard.writeText(url)
    showToast('Link copied')
  } catch (_) {
    const ta = document.createElement('textarea')
    ta.value = url
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
    showToast('Link copied')
  }
})

function buildGoogleMapsUrl() {
  if (!(isLngLat(start) && isLngLat(end))) return null
  const orderedPOIs = poiWaypoints
    .slice()
    .sort((a, b) => (a.along || 0) - (b.along || 0))
    .map(p => p.coord)
    .filter(isLngLat)
  const manual = waypoints.map(w => w.coord).filter(isLngLat)
  const stops = [start].concat(manual).concat(orderedPOIs).concat([end])
  const origin = latlon(stops[0])
  const destination = latlon(stops[stops.length - 1])
  const mid = stops.slice(1, -1).slice(0, 20).map(latlon).filter(Boolean).join('|')
  const params = new URLSearchParams({ api: '1', origin, destination, travelmode: 'driving' })
  if (mid) params.set('waypoints', mid)
  return 'https://www.google.com/maps/dir/?' + params.toString()
}
function latlon(c) {
  return Array.isArray(c) && isLngLat(c) ? c[1].toFixed(6) + ',' + c[0].toFixed(6) : ''
}
function updateExportLink() {
  setExportEnabled(!!(isLngLat(start) && isLngLat(end)))
}
//#endregion

// ===== HELPERS =====
// TODO [HELPERS]
/* TODO[FIX-003B-1]: Normalize category labels from tiles */
function normalizeCategory(raw) {
  const s = String(raw || '')
    .trim()
    .toLowerCase()
  if (s.startsWith('rest')) return 'Rest Area'
  if (s.includes('roadside')) return 'Roadside Attraction'
  if (s.includes('welcome')) return 'Welcome Sign'
  return 'Other'
}

//#region HELPERS
function poiHoverHtml(f) {
  const p = (f && f.properties) || {}
  const name = p.name || p.Name || p.title || p.Title || 'POI'
  const category = p.category || p.Category || p.type || p.Type || 'Other'
  const desc = p.description || p.Description || p.desc || p.Desc || ''
  const off = typeof p.off === 'number' ? p.off : null

  return (
    '<div style="font:13px/1.3 system-ui,-apple-system,Segoe UI,Roboto,Arial)">' +
    '<div style="font-weight:700;margin-bottom:2px)">' +
    escapeHtml(name) +
    '</div>' +
    '<div style="color:#6b7280)">' +
    escapeHtml(category) +
    (off != null ? ' · ~' + off.toFixed(1) + ' mi off-route' : '') +
    '</div>' +
    '</div>'
  )
}
function poiActionHtml(f, already) {
  const coord = f.geometry.coordinates
  const name =
    (f.properties &&
      (f.properties.name || f.properties.Name || f.properties.title || f.properties.Title)) ||
    'POI'
  const category =
    (f.properties &&
      (f.properties.category || f.properties.Category || f.properties.type || f.properties.Type)) ||
    'Other'
  const desc =
    (f.properties &&
      (f.properties.description ||
        f.properties.Description ||
        f.properties.desc ||
        f.properties.Desc)) ||
    ''
  const id = (f.properties && f.properties.id) || ''
  // Prefer explicit Google link from data; fallback handled below
  const urlRaw =
    (f.properties &&
      (f.properties['Google Maps URL'] ||
        f.properties.GoogleMapsURL ||
        f.properties.URL ||
        f.properties.Link ||
        f.properties.Website ||
        f.properties.url)) ||
    ''
  const url = typeof urlRaw === 'string' && /^https?:\/\//i.test(urlRaw.trim()) ? urlRaw.trim() : ''
  // (if empty, we fall back to the lat/lng gmaps link below)

  const lat = coord[1]
  const lon = coord[0]
  const gmaps =
    lat != null && lon != null
      ? 'https://www.google.com/maps/search/?api=1&query=' + lat.toFixed(6) + ',' + lon.toFixed(6)
      : '#'
  const anchor = url
    ? '<a href="' +
      escapeAttr(url) +
      '" target="_blank" rel="noopener" style="color:#1a73e8;text-decoration:none">Open in Google Maps ↗</a>'
    : '<a href="' +
      gmaps +
      '" target="_blank" rel="noopener" style="color:#1a73e8;text-decoration:none">Open in Google Maps ↗</a>'
  const off = f.properties && f.properties.off
  const btn = already
    ? '<button data-remove-poi="' + id + '" style="margin-top:8px">Remove from route</button>'
    : '<button data-add-poi="' + id + '" style="margin-top:8px">Add to route</button>'

  return (
    '' +
    '<div style="font:13px/1.35 system-ui,-apple-system,Segoe UI,Roboto,Arial; max-width:260px)">' +
    '<div style="font-weight:700;margin-bottom:2px)">' +
    escapeHtml(name) +
    '</div>' +
    '<div style="color:#6b7280;margin-bottom:6px)">' +
    escapeHtml(category) +
    (typeof off === 'number' ? ' · ~' + off.toFixed(1) + ' mi off-route' : '') +
    '</div>' +
    (desc ? '<div style="margin:6px 0)">' + escapeHtml(desc) + '</div>' : '') +
    '<div style="display:flex; gap:10px; align-items:center; margin-top:6px; flex-wrap:wrap)">' +
    anchor +
    btn +
    '</div>' +
    '</div>'
  )
}
function escapeHtml(str) {
  return String(str || '').replace(
    /[&<>"']/g,
    s =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;',
      }[s])
  )
}
function escapeAttr(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function emptyFC() {
  return { type: 'FeatureCollection', features: [] }
}
function boundsOfFeature(f) {
  const b = new mapboxgl.LngLatBounds()
  if (f && f.geometry && f.geometry.type === 'LineString') {
    for (const c of f.geometry.coordinates) {
      if (isLngLat(c)) b.extend([c[0], c[1]])
    }
  }
  return b
}
function pt(label, lnglat) {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: lnglat },
    properties: { label },
  }
}

function drawStops() {
  const features = []
  if (isLngLat(start)) features.push(pt('A', start))
  waypoints.forEach((w, i) => {
    if (isLngLat(w.coord)) features.push(pt(String(i + 1), w.coord))
  })
  if (isLngLat(end)) features.push(pt('B', end))
  const src = map.getSource('stops')
  if (src) src.setData({ type: 'FeatureCollection', features })
}

function normalizeCategory(raw) {
  const s = (raw || '').toString().trim().toLowerCase()
  if (!s) return 'Other'
  if (/rest\s*area/.test(s)) return 'Rest Area'
  if (/roadside/.test(s)) return 'Roadside Attraction'
  if (/welcome\s*sign/.test(s)) return 'Welcome Sign'
  return 'Other'
}

function addRowsToPois(rows, fieldsOrder) {
  if ((!fieldsOrder || !fieldsOrder.length) && rows && rows.length && typeof rows[0] === 'object') {
    fieldsOrder = Object.keys(rows[0])
  }
  const colHKey = Array.isArray(fieldsOrder) && fieldsOrder.length >= 8 ? fieldsOrder[7] : null

  for (let i = 0; i < (rows || []).length; i++) {
    const r = rows[i]
    const lat = num(r.lat || r.latitude || r.Latitude || r.Y || r.y)
    const lon = num(r.lon || r.lng || r.longitude || r.Longitude || r.X || r.x)
    if (lat == null || lon == null || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue

    const name = (r.name || r.title || r.Name || r.Type || '').toString().trim() || 'POI'
    const category = normalizeCategory((r.category || r.Category || '').toString())
    const desc = (r.description || r.desc || '').toString().trim()

    let url = ''
    if (colHKey && r[colHKey]) {
      const candidateH = String(r[colHKey]).trim()
      if (/^https?:\/\//i.test(candidateH)) url = candidateH
    }
    if (!url) {
      const known =
        r.url ||
        r.URL ||
        r.link ||
        r.Link ||
        r.website ||
        r.Website ||
        r['Google Maps URL'] ||
        r['GoogleMapsURL'] ||
        r['Link URL'] ||
        r['Hyperlink'] ||
        ''
      const cand2 = String(known).trim()
      if (/^https?:\/\//i.test(cand2)) url = cand2
    }
    if (!url) {
      const keys = Array.isArray(fieldsOrder) && fieldsOrder.length ? fieldsOrder : Object.keys(r)
      for (let k = 0; k < keys.length; k++) {
        const v = r[keys[k]] != null ? String(r[keys[k]]).trim() : ''
        if (/^https?:\/\//i.test(v)) {
          url = v
          break
        }
      }
    }

    pois.push({ name, lat, lon, category, description: desc, url })
  }
}

function num(v) {
  if (v === undefined || v === null) return null
  const s = String(v).trim().replace(/,/g, '')
  const n = Number(s)
  return isFinite(n) ? n : null
}

function loadPoisFromUrl(force) {
  force = !!force
  const now = Date.now()
  const cached = localStorage.getItem(POI_CACHE_KEY)
  if (!force && cached) {
    try {
      const obj = JSON.parse(cached)
      if (obj && Array.isArray(obj.pois) && obj.pois.length) {
        const freshEnough = obj.ts && now - obj.ts < POI_CACHE_TTL_MS
        if (freshEnough) {
          pois = obj.pois
          if (routeFeature) updateCandidateLayerDebounced()
          return Promise.resolve()
        }
      }
    } catch (e) {}
  }
  return fetch(POI_URL, { mode: 'cors' })
    .then(res => {
      if (!res.ok) throw new Error('HTTP ' + res.status + ' fetching POIs')
      return res.text()
    })
    .then(text => {
      const parsed = Papa.parse(text, { header: true, skipEmptyLines: true })
      pois = []
      addRowsToPois(parsed.data, parsed.meta && parsed.meta.fields ? parsed.meta.fields : [])
      localStorage.setItem(POI_CACHE_KEY, JSON.stringify({ pois, ts: now }))
      if (routeFeature) updateCandidateLayerDebounced()
    })
    .catch(err => {
      const cached2 = localStorage.getItem(POI_CACHE_KEY)
      if (cached2) {
        try {
          const obj2 = JSON.parse(cached2)
          if (obj2 && Array.isArray(obj2.pois) && obj2.pois.length) {
            pois = obj2.pois
            if (routeFeature) updateCandidateLayerDebounced()
            showErr(
              'Live fetch failed (' +
                (err && err.message ? err.message : err) +
                '). Using cached POIs.'
            )
            return
          }
        } catch (e) {}
      }
      showErr('Failed to load POIs from URL. ' + (err && err.message ? err.message : err) + '.')
    })
}
//#endregion

// ===== INIT =====
// TODO [INIT]
//#region INIT
updateRouteButtonLabel()
setExportEnabled(false)

// ---- POI gate state (declare once safely) ----
if (!window.POI_GATE) window.POI_GATE = { hasRoute: false, whatsAround: false }
const PG = window.POI_GATE // use PG inside this file

// ---- Show/Hide all POI layers together ----
function setPoiVisibility(visible) {
  const v = visible ? 'visible' : 'none'
  ;['pois', 'pois-cand'].forEach(id => {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', v)
  })
}

// ---- Helpers to choose which POI layer is shown ----
function showPoisForRoute(show) {
  if (map.getLayer('pois-cand')) {
    map.setLayoutProperty('pois-cand', 'visibility', show ? 'visible' : 'none')
  }
  if (map.getLayer('pois')) {
    map.setLayoutProperty('pois', 'visibility', 'none') // keep full set hidden in route mode
  }
}

function showPoisAround(show) {
  if (map.getLayer('pois')) {
    map.setLayoutProperty('pois', 'visibility', show ? 'visible' : 'none')
  }
  if (map.getLayer('pois-cand')) {
    map.setLayoutProperty('pois-cand', 'visibility', 'none') // hide candidates in around-me mode
  }
}

// ---- True when a real route exists (start+finish picked and route built) ----
function routeReady() {
  // Mapbox Directions (if you ever use it)
  try {
    if (
      window.directions &&
      typeof window.directions.getRoutes === 'function' &&
      window.directions.getRoutes().length > 0
    )
      return true
  } catch (e) {}

  // Our own route built via fetch/drawFinalRoute (NOT on window)
  try {
    if (
      typeof routeFeature !== 'undefined' &&
      routeFeature &&
      routeFeature.geometry &&
      Array.isArray(routeFeature.geometry.coordinates) &&
      routeFeature.geometry.coordinates.length > 1
    ) {
      return true
    }
  } catch (e) {}

  // Fallback: inspect the GeoJSON source 'route'
  try {
    const src = map.getSource('route')
    if (src) {
      const data = src._data || (src.serialize && src.serialize().data) || null
      if (data) {
        let coords = null
        if (
          data.type === 'FeatureCollection' &&
          Array.isArray(data.features) &&
          data.features[0] &&
          data.features[0].geometry
        ) {
          coords = data.features[0].geometry.coordinates
        } else if (data.type === 'Feature' && data.geometry) {
          coords = data.geometry.coordinates
        }
        if (Array.isArray(coords) && coords.length > 1) return true
      }
    }
  } catch (e) {}

  return false
}

// Show near-route candidates when route + minutes are ready; otherwise hide (or show full for Around Me)
function ensurePoisVisibility() {
  // Route is “ready” when we’ve drawn our own line
  const hasRoute = !!(
    routeFeature &&
    routeFeature.geometry &&
    Array.isArray(routeFeature.geometry.coordinates) &&
    routeFeature.geometry.coordinates.length > 1
  )

  // Keep the POI layers above the route for clarity
  try {
    if (map.getLayer('pois-cand')) map.moveLayer('pois-cand')
    if (map.getLayer('pois')) map.moveLayer('pois')
  } catch (_) {}

  if (hasRoute) {
    // Make sure base POI source is visible so vector tiles load (guarded)
    try {
      if (map.isStyleLoaded && map.isStyleLoaded()) {
        if (map.getLayer('pois')) map.setLayoutProperty('pois', 'visibility', 'visible')
        if (map.getLayer('pois-cand')) map.setLayoutProperty('pois-cand', 'visibility', 'visible')
      }
    } catch (_) {}

    // Build corridor + candidates using the current minutes
    updateCandidateLayer(0)
  } else {
    // Hide candidate POIs
    try {
      if (map.getLayer('pois-cand')) map.setLayoutProperty('pois-cand', 'visibility', 'none')
    } catch (_) {}
    // Hide full POIs in “no route” mode
    try {
      if (map.getLayer('pois')) map.setLayoutProperty('pois', 'visibility', 'none')
    } catch (_) {}

    // Clear/hide the corridor band
    {
      const corSrc = map.getSource('route-corridor')
      if (corSrc && typeof corSrc.setData === 'function') {
        corSrc.setData({ type: 'FeatureCollection', features: [] })
      }
      if (map.getLayer('route-corridor-fill')) {
        map.setLayoutProperty('route-corridor-fill', 'visibility', 'none')
      }
      if (map.getLayer('route-corridor-outline')) {
        map.setLayoutProperty('route-corridor-outline', 'visibility', 'none')
      }
    }

    // Enable/disable manual “Reload POIs” if present
    const reloadBtn = document.getElementById('reloadPois')
    if (reloadBtn) reloadBtn.disabled = !hasRoute
  }

  // ---- Startup & listeners ----

  // ====== START: POI init + listeners (paste this whole block) ======

  // Hide on first paint; ensure candidate source/layer exist; then run our check
  map.on('load', () => {
    // --- Candidate POIs (near-route only; GeoJSON we control) ---
    if (!map.getSource('pois-cand')) {
      map.addSource('pois-cand', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      })
    }

    if (!map.getLayer('pois-cand')) {
      map.addLayer({
        id: 'pois-cand',
        type: 'circle',
        source: 'pois-cand',
        layout: { visibility: 'none' }, // start hidden; gate will show when ready
        paint: {
          'circle-radius': 5,
          'circle-stroke-width': 1,
          'circle-stroke-color': '#fff',
          'circle-color': [
            'match',
            ['get', 'category'],
            'Rest Area',
            '#8b5cf6',
            'Roadside Attraction',
            '#3b82f6',
            'Welcome Sign',
            '#8b5e3c',
            'Other',
            '#9ca3af',
            '#9ca3af',
          ],
        },
      })
    }

    // --- Vector tileset with your POIs (Mapbox tileset) ---
    // Make sure the vector source exists BEFORE adding the 'pois' layer.
    if (!map.getSource(POI_VECTOR_SOURCE_ID)) {
      map.addSource(POI_VECTOR_SOURCE_ID, {
        type: 'vector',
        url: 'mapbox://savagetraveler.2wubp0yh', // your tileset ID
      })
    }

    // Base POI layer (faint dots so the tiles load; we keep it hidden until ready)
    if (!map.getLayer('pois')) {
      map.addLayer({
        id: 'pois',
        type: 'circle',
        source: POI_VECTOR_SOURCE_ID,
        'source-layer': 'Consolidated_Roadside_Attract-d7sy69',
        layout: { visibility: 'none' },
        paint: {
          'circle-radius': 3,
          'circle-color': '#6699ff',
          'circle-opacity': 0.15,
        },
      })
    }

    // Keep base POIs hidden on load; candidates will be shown by corridor logic only
    if (map.getLayer('pois')) {
      map.setLayoutProperty('pois', 'visibility', 'none')
    }
    // Keep candidates hidden until corridor logic runs (will be shown by updateCandidateLayer)
    if (map.getLayer('pois-cand')) map.setLayoutProperty('pois-cand', 'visibility', 'none')

    // First pass once style is ready
    ensurePoisVisibility()
  })

  // Re-check whenever style/layers churn
  map.on('styledata', ensurePoisVisibility)

  // Debounce during tile/source updates
  let _uiReadyTimer = null
  map.on('sourcedata', () => {
    clearTimeout(_uiReadyTimer)
    _uiReadyTimer = setTimeout(ensurePoisVisibility, 150)
  })

  // After everything settles for a frame
  // --- Final visibility decision for near-route candidates ---
  try {
    const hasRoute = !!(window.POI_GATE && window.POI_GATE.hasRoute)
    const candCount =
      map.getSource('pois-cand') &&
      map.getSource('pois-cand')._data &&
      Array.isArray(map.getSource('pois-cand')._data.features)
        ? map.getSource('pois-cand')._data.features.length
        : 0

    if (map.getLayer('pois-cand')) {
      map.setLayoutProperty(
        'pois-cand',
        'visibility',
        hasRoute && candCount > 0 ? 'visible' : 'none'
      )
    }
  } catch (_) {}
}
// <-- closes: function ensurePoisVisibility() { ... }

// Mapbox Directions events
try {
  if (window.directions && typeof window.directions.on === 'function') {
    // When a route is found: mark gate, refresh, and unhide candidates
    window.directions.on('route', () => {
      ;(window.POI_GATE ||= { hasRoute: false, whatsAround: false }).hasRoute = true
      ensurePoisVisibility()
      if (typeof updateCandidateLayer === 'function') updateCandidateLayer(0)

      // Make sure candidate layer is visible and on top
      try {
        if (map.getLayer('pois-cand')) {
          map.setLayoutProperty('pois-cand', 'visibility', 'visible')
          map.moveLayer('pois-cand')
        }
      } catch (_) {}
    })

    // When the route is cleared: reset and hide candidates
    window.directions.on('clear', () => {
      ;(window.POI_GATE ||= { hasRoute: false, whatsAround: false }).hasRoute = false
      try {
        if (map.getLayer('pois-cand')) {
          map.setLayoutProperty('pois-cand', 'visibility', 'none')
        }
      } catch (_) {}
      ensurePoisVisibility()
    })
  }
} catch (_) {}

// Minutes input changes
const minutesEl = document.getElementById('minutes')
if (minutesEl) {
  const onMinutes = () => ensurePoisVisibility()
  minutesEl.addEventListener('input', onMinutes)
  minutesEl.addEventListener('change', onMinutes)
}

// Rebuild near-route POIs when category checkboxes change (if container exists)
const filtersEl = document.getElementById('filters')
if (filtersEl) {
  filtersEl.addEventListener('change', () => {
    if (window.POI_GATE?.hasRoute) updateCandidateLayer(0)
  })
}

// Manual refresh link (optional)
const reloadBtnEl = document.getElementById('reloadPois')
if (reloadBtnEl) {
  reloadBtnEl.addEventListener('click', e => {
    e.preventDefault()
    if (window.POI_GATE?.hasRoute) updateCandidateLayer(0)
  })
}

//#endregion

// ====== END: POI init + listeners ======
