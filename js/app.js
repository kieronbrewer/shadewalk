/**
 * ShadeWalk Main Application Controller
 * Handles UI events, state management, Leaflet map rendering, and coordination.
 * Supports both Loop Walk generation and Point-to-Point (A-to-B) routing.
 */

import { getSolarPosition } from './solar.js';
import { geocode, fetchOSMData, calculateDistance } from './osm.js';
import { findNearestGraphNode, generateRoutes, generatePointToPointRoutes, calculateSegmentShade } from './routing.js';

// Application State
const state = {
  mode: 'loop', // 'loop' or 'atob'
  currentLocation: {
    lat: 30.2672,  // Default: Austin, TX
    lon: -97.7431,
    name: 'Austin, Texas, United States'
  },
  destinationLocation: null, // { lat, lon, name }
  distanceMiles: 1.5,
  walkDate: new Date(),
  walkMinutes: 600, // 10:00 AM (minutes from midnight)
  fitnessLevel: 'beginner',
  osmData: null,    // Parsed map data { nodes, ways, parks, trees, graph }
  routes: [],       // Generated loops or point-to-point paths
  activeRouteIdx: null,
  map: null,
  layers: {
    polylines: [],   // Route segment lines
    startMarker: null,
    destinationMarker: null,
    parksLayer: null,
    treesLayer: null
  }
};

// UI Elements
const el = {
  // Tabs
  tabLoop: document.getElementById('tab-loop'),
  tabAtoB: document.getElementById('tab-atob'),
  
  // Starting Input
  searchLabel: document.getElementById('search-label'),
  searchInput: document.getElementById('search-input'),
  autocompleteList: document.getElementById('autocomplete-list'),

  // Destination Input (A-to-B Mode)
  destinationGroup: document.getElementById('destination-group'),
  destinationInput: document.getElementById('destination-input'),
  destinationAutocompleteList: document.getElementById('destination-autocomplete-list'),

  // Distance Input (Loop Mode)
  distanceGroup: document.getElementById('distance-group'),
  distanceSlider: document.getElementById('distance-slider'),
  distanceValue: document.getElementById('distance-value'),

  // Shared inputs
  dateInput: document.getElementById('date-input'),
  timeSlider: document.getElementById('time-slider'),
  timeValue: document.getElementById('time-value'),
  fitnessBtns: document.querySelectorAll('.fitness-btn'),
  findButton: document.getElementById('find-button'),
  
  // Containers
  welcomeState: document.getElementById('welcome-state'),
  resultsSection: document.getElementById('results-section'),
  routesList: document.getElementById('routes-list'),
  loadingOverlay: document.getElementById('loading-overlay'),
  loadingText: document.getElementById('loading-text'),
  solarPreviewText: document.getElementById('solar-preview-text'),
  solarWidget: document.getElementById('solar-widget'),
  solarWidgetValue: document.getElementById('solar-widget-value')
};

// Initialize Application
document.addEventListener('DOMContentLoaded', () => {
  setupDefaults();
  initMap();
  setupEventListeners();
  detectUserLocation();
});

/**
 * Setup default dates, times, and control states.
 */
function setupDefaults() {
  // Set default date input to today
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  el.dateInput.value = `${year}-${month}-${day}`;
  state.walkDate = today;

  // Calculate current minutes from midnight based on browser local time
  const currentHours = today.getHours();
  const currentMins = today.getMinutes();
  let minutes = currentHours * 60 + currentMins;

  // Round up to the next 15-minute increment (e.g. 1:02 PM -> 1:15 PM)
  minutes = Math.ceil(minutes / 15) * 15;

  // Clamp to daytime slider boundaries (360 = 6:00 AM, 1200 = 8:00 PM)
  if (minutes < 360) {
    minutes = 360;
  } else if (minutes > 1200) {
    minutes = 1200;
  }

  el.timeSlider.value = minutes;
  state.walkMinutes = minutes;
  updateTimeDisplay(minutes);

  // Update solar angle preview
  updateSolarAngles();
}

/**
 * Initialize Leaflet map with CartoDB Dark Matter tiles.
 */
function initMap() {
  state.map = L.map('map', {
    zoomControl: true,
    attributionControl: true
  }).setView([state.currentLocation.lat, state.currentLocation.lon], 13);

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 20
  }).addTo(state.map);

  // Set starting location marker
  updateStartMarker();
}

/**
 * Sets up geocoding, mode toggles, input changes, slider interactions, and forms.
 */
function setupEventListeners() {
  // 1. Mode Tab Toggles
  el.tabLoop.addEventListener('click', () => {
    state.mode = 'loop';
    el.tabLoop.classList.add('active');
    el.tabAtoB.classList.remove('active');
    
    // UI layout updates
    el.searchLabel.innerText = 'Starting Location';
    el.searchInput.placeholder = 'City, Zip, or Address...';
    el.destinationGroup.style.display = 'none';
    el.distanceGroup.style.display = 'flex';
    el.destinationInput.required = false;
  });

  el.tabAtoB.addEventListener('click', () => {
    state.mode = 'atob';
    el.tabAtoB.classList.add('active');
    el.tabLoop.classList.remove('active');
    
    // UI layout updates
    el.searchLabel.innerText = 'Starting Point';
    el.searchInput.placeholder = 'Start Address or Landmark...';
    el.destinationGroup.style.display = 'flex';
    el.distanceGroup.style.display = 'none';
    el.destinationInput.required = true;
  });

  // 2. Start Location Nominatim Autocomplete
  let startDebounceTimeout = null;
  el.searchInput.addEventListener('input', () => {
    clearTimeout(startDebounceTimeout);
    const query = el.searchInput.value.trim();
    if (query.length < 3) {
      el.autocompleteList.style.display = 'none';
      return;
    }
    
    startDebounceTimeout = setTimeout(async () => {
      const results = await geocode(query);
      renderSuggestions(results, 'start');
    }, 400);
  });

  // 3. Destination Nominatim Autocomplete
  let destDebounceTimeout = null;
  el.destinationInput.addEventListener('input', () => {
    clearTimeout(destDebounceTimeout);
    const query = el.destinationInput.value.trim();
    if (query.length < 3) {
      el.destinationAutocompleteList.style.display = 'none';
      return;
    }
    
    destDebounceTimeout = setTimeout(async () => {
      const results = await geocode(query);
      renderSuggestions(results, 'dest');
    }, 400);
  });

  // Hide suggestions when clicking outside
  document.addEventListener('click', (e) => {
    if (e.target !== el.searchInput && e.target !== el.autocompleteList) {
      el.autocompleteList.style.display = 'none';
    }
    if (e.target !== el.destinationInput && e.target !== el.destinationAutocompleteList) {
      el.destinationAutocompleteList.style.display = 'none';
    }
  });

  // 4. Distance Slider (Loop Mode)
  el.distanceSlider.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    state.distanceMiles = val;
    el.distanceValue.innerText = `${val.toFixed(2)} mi`;
  });

  // 5. Date Input
  el.dateInput.addEventListener('change', (e) => {
    if (e.target.value) {
      state.walkDate = new Date(e.target.value + 'T00:00:00');
      updateSolarAngles();
      triggerLiveShadeRecalculation();
    }
  });

  // 6. Time Slider
  el.timeSlider.addEventListener('input', (e) => {
    const val = parseInt(e.target.value, 10);
    state.walkMinutes = val;
    updateTimeDisplay(val);
    updateSolarAngles();
    triggerLiveShadeRecalculation();
  });

  // 7. Fitness Level Selection
  el.fitnessBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      el.fitnessBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.fitnessLevel = btn.dataset.level;
    });
  });

  // 8. Form Submission / Fetch
  el.findButton.addEventListener('click', async (e) => {
    e.preventDefault();
    await fetchAndGenerateWalks();
  });
}

/**
 * Format minutes from midnight to readable string (e.g. 10:30 AM).
 */
function updateTimeDisplay(minutes) {
  const hours24 = Math.floor(minutes / 60);
  const mins = minutes % 60;
  const ampm = hours24 >= 12 ? 'PM' : 'AM';
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  const minsStr = String(mins).padStart(2, '0');
  
  const timeStr = `${hours12}:${minsStr} ${ampm}`;
  el.timeValue.innerText = timeStr;
  
  // Set walking time inside state.walkDate
  state.walkDate.setHours(hours24);
  state.walkDate.setMinutes(mins);
  state.walkDate.setSeconds(0);
}

/**
 * Calculates current solar angles and updates UI.
 */
function updateSolarAngles() {
  const sun = getSolarPosition(state.walkDate, state.currentLocation.lat, state.currentLocation.lon);
  
  const az = Math.round(sun.azimuth);
  const elVal = Math.round(sun.elevation);
  
  const desc = elVal <= 0 ? '🌅 Night' : `☀️ Azimuth: ${az}°, Elev: ${elVal}°`;
  el.solarPreviewText.innerHTML = `<span>${desc}</span>`;
  
  el.solarWidgetValue.innerText = `Az: ${az}° | El: ${elVal}°`;
}

/**
 * Render Autocomplete suggestions for start or destination inputs.
 */
function renderSuggestions(results, type) {
  const listEl = type === 'start' ? el.autocompleteList : el.destinationAutocompleteList;
  const inputEl = type === 'start' ? el.searchInput : el.destinationInput;
  
  listEl.innerHTML = '';
  if (results.length === 0) {
    listEl.style.display = 'none';
    return;
  }

  results.forEach(res => {
    const item = document.createElement('div');
    item.className = 'autocomplete-item';
    item.innerText = res.name;
    item.addEventListener('click', () => {
      inputEl.value = res.name;
      
      if (type === 'start') {
        state.currentLocation.lat = res.lat;
        state.currentLocation.lon = res.lon;
        state.currentLocation.name = res.name;
        listEl.style.display = 'none';
        
        // Pan map to new starting location
        state.map.setView([res.lat, res.lon], 15);
        updateStartMarker();
      } else {
        state.destinationLocation = {
          lat: res.lat,
          lon: res.lon,
          name: res.name
        };
        listEl.style.display = 'none';
        
        // Draw destination marker
        updateDestinationMarker();
        fitMarkersInView();
      }
      
      updateSolarAngles();
    });
    listEl.appendChild(item);
  });
  listEl.style.display = 'block';
}

/**
 * Redraw the starting marker on the map.
 */
function updateStartMarker() {
  if (state.layers.startMarker) {
    state.map.removeLayer(state.layers.startMarker);
  }
  
  state.layers.startMarker = L.circleMarker([state.currentLocation.lat, state.currentLocation.lon], {
    radius: 8,
    fillColor: '#10b981',
    color: '#ffffff',
    weight: 2,
    opacity: 1,
    fillOpacity: 0.9
  }).addTo(state.map);
  
  state.layers.startMarker.bindPopup(`<b>Start Point</b><br>${state.currentLocation.name.split(',')[0]}`);
}

/**
 * Redraw the destination marker on the map (A-to-B Mode).
 */
function updateDestinationMarker() {
  if (state.layers.destinationMarker) {
    state.map.removeLayer(state.layers.destinationMarker);
    state.layers.destinationMarker = null;
  }
  
  if (state.destinationLocation) {
    state.layers.destinationMarker = L.circleMarker([state.destinationLocation.lat, state.destinationLocation.lon], {
      radius: 8,
      fillColor: '#ef4444', // Red for destination
      color: '#ffffff',
      weight: 2,
      opacity: 1,
      fillOpacity: 0.9
    }).addTo(state.map);
    
    state.layers.destinationMarker.bindPopup(`<b>Destination Point</b><br>${state.destinationLocation.name.split(',')[0]}`);
  }
}

/**
 * Fits both start and destination markers in the map view.
 */
function fitMarkersInView() {
  if (state.currentLocation && state.destinationLocation) {
    const bounds = L.latLngBounds(
      [state.currentLocation.lat, state.currentLocation.lon],
      [state.destinationLocation.lat, state.destinationLocation.lon]
    );
    state.map.fitBounds(bounds, { padding: [50, 50] });
  }
}

/**
 * Show the loading spinner and message.
 */
function showLoading(text) {
  el.loadingText.innerText = text;
  el.loadingOverlay.classList.add('active');
}

/**
 * Hide the loading spinner.
 */
function hideLoading() {
  el.loadingOverlay.classList.remove('active');
}

/**
 * Coordinates fetching street data, parsing it, and generating walks.
 */
async function fetchAndGenerateWalks() {
  // 1. Resolve starting address if dirty
  const startQuery = el.searchInput.value.trim();
  if (startQuery && startQuery !== state.currentLocation.name) {
    showLoading('Geocoding start location...');
    const results = await geocode(startQuery);
    if (results.length > 0) {
      const best = results[0];
      state.currentLocation.lat = best.lat;
      state.currentLocation.lon = best.lon;
      state.currentLocation.name = best.name;
      el.searchInput.value = best.name;
      updateStartMarker();
    } else {
      hideLoading();
      alert('Could not resolve starting location. Please type a valid US city or address.');
      return;
    }
  }

  // 2. Resolve destination address if dirty (A-to-B Mode)
  if (state.mode === 'atob') {
    const destQuery = el.destinationInput.value.trim();
    if (!destQuery) {
      alert('Please enter a destination address.');
      return;
    }
    if (!state.destinationLocation || destQuery !== state.destinationLocation.name) {
      showLoading('Geocoding destination...');
      const results = await geocode(destQuery);
      if (results.length > 0) {
        const best = results[0];
        state.destinationLocation = {
          lat: best.lat,
          lon: best.lon,
          name: best.name
        };
        el.destinationInput.value = best.name;
        updateDestinationMarker();
      } else {
        hideLoading();
        alert('Could not resolve destination. Please enter a valid address or city.');
        return;
      }
    }

    // Safety Distance check
    const distanceMeters = calculateDistance(
      state.currentLocation.lat, state.currentLocation.lon,
      state.destinationLocation.lat, state.destinationLocation.lon
    );
    if (distanceMeters > 6437) { // 4 miles
      hideLoading();
      alert('The start and destination are more than 4 miles apart. Please select a shorter walk for safety and system performance.');
      return;
    }
  }

  try {
    let sun = getSolarPosition(state.walkDate, state.currentLocation.lat, state.currentLocation.lon);

    if (state.mode === 'loop') {
      // Loop Mode: Radial Query
      const targetDistanceMeters = state.distanceMiles * 1609.34;
      const searchRadius = Math.min(2500, Math.round(targetDistanceMeters * 0.6 + 400));
      
      showLoading(`Downloading local street network (${searchRadius}m)...`);
      state.osmData = await fetchOSMData(state.currentLocation.lat, state.currentLocation.lon, searchRadius);
      
      clearGeometries();
      renderParks();
      
      showLoading('Computing solar geometry and creating shady loops...');
      const startNodeId = findNearestGraphNode(state.currentLocation.lat, state.currentLocation.lon, state.osmData.nodes, state.osmData.graph);
      
      if (!startNodeId) {
        throw new Error("No walkable streets found within query boundaries. Try choosing a larger radius or a different starting point.");
      }

      state.routes = generateRoutes(startNodeId, targetDistanceMeters, state.osmData, sun, state.fitnessLevel);
    } else {
      // A-to-B Mode: Bounding Box Query
      showLoading('Determining path boundaries...');
      
      // Calculate Bounding Box with ~800m (0.008 degrees) padding
      const padLat = 0.008;
      const padLon = 0.008;
      const bbox = {
        minLat: Math.min(state.currentLocation.lat, state.destinationLocation.lat) - padLat,
        minLon: Math.min(state.currentLocation.lon, state.destinationLocation.lon) - padLon,
        maxLat: Math.max(state.currentLocation.lat, state.destinationLocation.lat) + padLat,
        maxLon: Math.max(state.currentLocation.lon, state.destinationLocation.lon) + padLon
      };

      showLoading('Downloading street network between endpoints...');
      state.osmData = await fetchOSMData(bbox);
      
      clearGeometries();
      renderParks();
      
      showLoading('Calculating shade and routing shadiest paths...');
      const startNodeId = findNearestGraphNode(state.currentLocation.lat, state.currentLocation.lon, state.osmData.nodes, state.osmData.graph);
      const destNodeId = findNearestGraphNode(state.destinationLocation.lat, state.destinationLocation.lon, state.osmData.nodes, state.osmData.graph);

      if (!startNodeId || !destNodeId) {
        throw new Error("Could not find walking paths near both endpoints. Ensure addresses are in residential or urban areas with public walkways.");
      }

      state.routes = generatePointToPointRoutes(startNodeId, destNodeId, state.osmData, sun, state.fitnessLevel);
    }

    if (state.routes.length === 0) {
      throw new Error("Could not find any suitable routes. Endpoints may be disconnected by waterways, highways, or private zones.");
    }

    // Update UI panels
    el.welcomeState.style.display = 'none';
    el.resultsSection.style.display = 'block';
    el.solarWidget.style.display = 'flex';
    
    // Select first route by default
    state.activeRouteIdx = 0;
    renderRouteCards();
    drawRoutes();

  } catch (error) {
    console.error(error);
    alert(`Error: ${error.message}`);
  } finally {
    hideLoading();
  }
}

/**
 * Draws park polygons on the map for a premium, custom styled map layer.
 */
function renderParks() {
  if (state.layers.parksLayer) {
    state.map.removeLayer(state.layers.parksLayer);
  }

  const parkPolygons = [];

  for (const park of state.osmData.parks) {
    const coords = [];
    if (!park.nodes) continue;
    for (const nodeId of park.nodes) {
      const node = state.osmData.nodes.get(nodeId);
      if (node) {
        coords.push([node.lat, node.lon]);
      }
    }
    if (coords.length > 2) {
      parkPolygons.push(L.polygon(coords, {
        fillColor: '#10b981',
        fillOpacity: 0.15,
        color: '#10b981',
        weight: 1,
        opacity: 0.3
      }));
    }
  }

  if (parkPolygons.length > 0) {
    state.layers.parksLayer = L.featureGroup(parkPolygons).addTo(state.map);
  }
}

/**
 * Clears old polylines and geometries (except start/end markers which stay).
 */
function clearGeometries() {
  state.layers.polylines.forEach(l => state.map.removeLayer(l));
  state.layers.polylines = [];
  
  if (state.layers.parksLayer) {
    state.map.removeLayer(state.layers.parksLayer);
    state.layers.parksLayer = null;
  }
}

/**
 * Calculates a color code interpolated based on the shade score.
 * 0.0 (sunny) -> Orange-red
 * 0.5 (partial) -> Amber-yellow
 * 1.0 (shade) -> Vibrant Emerald Green
 */
function getShadeColor(shade) {
  // Sunny (0.0): #ea580c (rgb: 234, 88, 12)
  // Shady (1.0): #10b981 (rgb: 16, 185, 129)
  const r = Math.round(234 - (234 - 16) * shade);
  const g = Math.round(88 + (185 - 88) * shade);
  const b = Math.round(12 - (12 - 129) * shade);
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * Render route recommendation cards in the sidebar.
 */
function renderRouteCards() {
  el.routesList.innerHTML = '';

  state.routes.forEach((route, idx) => {
    const distanceMiles = (route.distance / 1609.34).toFixed(2);
    const shadePercent = Math.round(route.shadeScore * 100);
    
    // Choose shade classification pill
    let pillClass = 'low';
    let pillText = 'Sunny';
    if (route.shadeScore >= 0.70) {
      pillClass = 'high';
      pillText = 'Shady';
    } else if (route.shadeScore >= 0.40) {
      pillClass = 'medium';
      pillText = 'Partial Shade';
    }

    const card = document.createElement('div');
    card.className = `route-card ${state.activeRouteIdx === idx ? 'active-route' : ''}`;
    card.innerHTML = `
      <div class="route-header">
        <span class="route-name">${route.name}</span>
        <span class="shade-pill ${pillClass}">${pillText}</span>
      </div>
      <div class="route-stats">
        <span class="route-stat-item">🧭 <b>${distanceMiles} mi</b></span>
        <span class="route-stat-item">⏱️ <b>${route.duration} min</b></span>
        <span class="route-stat-item">🔥 <b>${route.calories} kcal</b></span>
      </div>
      <div class="shade-meter-container">
        <div class="shade-meter-label">
          <span>Shade Coverage</span>
          <span style="font-weight: 700;">${shadePercent}%</span>
        </div>
        <div class="shade-meter-bar-bg">
          <div class="shade-meter-bar-fill" style="width: ${shadePercent}%;"></div>
        </div>
      </div>
    `;

    card.addEventListener('click', () => {
      state.activeRouteIdx = idx;
      
      // Update sidebar visual active states
      document.querySelectorAll('.route-card').forEach((c, cIdx) => {
        if (cIdx === idx) {
          c.classList.add('active-route');
        } else {
          c.classList.remove('active-route');
        }
      });
      
      // Redraw routes with focus on selected
      drawRoutes();
      zoomToActiveRoute();
    });

    el.routesList.appendChild(card);
  });
}

/**
 * Draws all routes on the map. The active route is thicker and highlighted.
 * Route segments are color-coded based on their local shade scores.
 */
function drawRoutes() {
  // Clear existing polylines
  state.layers.polylines.forEach(l => state.map.removeLayer(l));
  state.layers.polylines = [];

  const tempPolylines = [];

  state.routes.forEach((route, routeIdx) => {
    const isActive = state.activeRouteIdx === routeIdx;
    
    // Draw each segment individually to enable custom shade coloring per road
    route.segments.forEach(seg => {
      const color = getShadeColor(seg.shade);
      const polyline = L.polyline([seg.from, seg.to], {
        color: color,
        weight: isActive ? 6 : 3,
        opacity: isActive ? 0.95 : 0.25,
        dashArray: isActive ? null : '4, 4',
        lineCap: 'round',
        lineJoin: 'round'
      });
      
      // Highlight on hover if active, or make interactive
      if (isActive) {
        polyline.bindTooltip(`<b>${seg.name}</b><br>Shade: ${Math.round(seg.shade * 100)}%<br>Type: ${seg.highway || 'path'}`, {
          sticky: true
        });
      }

      polyline.addTo(state.map);
      state.layers.polylines.push(polyline);
      if (isActive) {
        tempPolylines.push(polyline);
      }
    });
  });

  // Zoom to fit the active route if it has nodes
  if (tempPolylines.length > 0 && state.activeRouteIdx !== null) {
    zoomToActiveRoute();
  }
}

/**
 * Zoom map boundary to fit the active route.
 */
function zoomToActiveRoute() {
  if (state.activeRouteIdx === null || state.routes.length === 0) return;
  
  const activeRoute = state.routes[state.activeRouteIdx];
  const boundsCoords = [];
  
  activeRoute.segments.forEach(seg => {
    boundsCoords.push(seg.from);
    boundsCoords.push(seg.to);
  });

  if (boundsCoords.length > 0) {
    state.map.fitBounds(L.latLngBounds(boundsCoords), {
      padding: [40, 40]
    });
  }
}

/**
 * Runs a live update of the shade scores when the date or time changes.
 * Avoids calling Overpass again; instead, it recomputes scores for existing paths.
 */
function triggerLiveShadeRecalculation() {
  if (!state.osmData || state.routes.length === 0) return;

  const sun = getSolarPosition(state.walkDate, state.currentLocation.lat, state.currentLocation.lon);

  state.routes.forEach(route => {
    let totalShadeSum = 0;
    let totalDist = 0;

    route.segments.forEach(seg => {
      // Re-query nodes from the live osmData maps
      const uNode = findNearestNodeInOsmData(seg.from[0], seg.from[1]);
      const vNode = findNearestNodeInOsmData(seg.to[0], seg.to[1]);
      
      if (uNode && vNode) {
        const recomputedShade = calculateSegmentShade(uNode, vNode, seg.bearing, sun);
        seg.shade = recomputedShade;
        totalShadeSum += recomputedShade * seg.distance;
        totalDist += seg.distance;
      }
    });

    route.shadeScore = totalDist > 0 ? totalShadeSum / totalDist : 1.0;
  });

  // Re-render scores and map colors without resetting active route
  renderRouteCards();
  drawRoutes();
}

/**
 * Quick helper to find a node in OSM data by latitude/longitude.
 */
function findNearestNodeInOsmData(lat, lon) {
  if (!state.osmData) return null;
  let best = null;
  let min = 5; // must be within 5 meters
  
  for (const node of state.osmData.nodes.values()) {
    const dist = calculateDistance(lat, lon, node.lat, node.lon);
    if (dist < min) {
      min = dist;
      best = node;
    }
  }
  return best;
}

/**
 * Detects the user's approximate or exact location on load.
 */
function detectUserLocation() {
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      // Success callback
      async (position) => {
        const lat = position.coords.latitude;
        const lon = position.coords.longitude;
        
        state.currentLocation.lat = lat;
        state.currentLocation.lon = lon;
        
        // Pan map and update marker
        state.map.setView([lat, lon], 15);
        updateStartMarker();
        updateSolarAngles();
        
        // Reverse geocode to get a readable address name
        try {
          const res = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`);
          if (res.ok) {
            const data = await res.json();
            state.currentLocation.name = data.display_name;
            el.searchInput.value = data.display_name;
          }
        } catch (err) {
          console.error("Reverse geocoding failed", err);
          el.searchInput.value = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
        }
      },
      // Error callback (e.g. denied permission)
      (error) => {
        console.warn("Geolocation permission denied or failed, falling back to IP lookup.", error);
        fallbackToIPLocation();
      },
      { enableHighAccuracy: true, timeout: 5000, maximumAge: 0 }
    );
  } else {
    fallbackToIPLocation();
  }
}

/**
 * Fallback to IP geolocation if browser GPS is unavailable or denied.
 */
async function fallbackToIPLocation() {
  try {
    const res = await fetch('https://ipapi.co/json/');
    if (res.ok) {
      const data = await res.json();
      if (data.latitude && data.longitude) {
        state.currentLocation.lat = data.latitude;
        state.currentLocation.lon = data.longitude;
        state.currentLocation.name = `${data.city}, ${data.region}, United States`;
        
        el.searchInput.value = state.currentLocation.name;
        state.map.setView([data.latitude, data.longitude], 13);
        updateStartMarker();
        updateSolarAngles();
      }
    }
  } catch (err) {
    console.error("IP geolocation failed, staying at default location.", err);
  }
}
