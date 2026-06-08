/**
 * OSM and Overpass API Integration
 * Handles geocoding (Nominatim) and fetching street/canopy data (Overpass).
 * Builds a local routing graph from geographical data.
 */

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.openstreetmap.fr/api/interpreter',
  'https://overpass.osm.ch/api/interpreter'
];
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';

// Custom User-Agent to comply with Nominatim/Overpass usage policies
const HTTP_HEADERS = {
  'Accept': 'application/json'
};

/**
 * Geocode a search query to coordinates (US only)
 * @param {string} query - The address, city, or zip code
 * @returns {Promise<Array<{name: string, lat: number, lon: number}>>}
 */
export async function geocode(query) {
  const url = `${NOMINATIM_URL}?q=${encodeURIComponent(query)}&format=json&limit=5&countrycodes=us`;
  try {
    const response = await fetch(url, { headers: HTTP_HEADERS });
    if (!response.ok) throw new Error('Geocoding failed');
    const data = await response.json();
    return data.map(item => ({
      name: item.display_name,
      lat: parseFloat(item.lat),
      lon: parseFloat(item.lon)
    }));
  } catch (error) {
    console.error('Error in geocode:', error);
    return [];
  }
}

/**
 * Calculates distance between two coordinates in meters using the Haversine formula.
 */
export function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // Earth radius in meters
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Calculates bearing between two coordinates in degrees (0-360, clockwise from North).
 */
export function calculateBearing(lat1, lon1, lat2, lon2) {
  const lat1Rad = lat1 * Math.PI / 180;
  const lat2Rad = lat2 * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;

  const y = Math.sin(dLon) * Math.cos(lat2Rad);
  const x = Math.cos(lat1Rad) * Math.sin(lat2Rad) -
            Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLon);
  
  let brng = Math.atan2(y, x) * 180 / Math.PI;
  return (brng + 360) % 360;
}

/**
 * Fetches streets, paths, parks, and tree data from Overpass API.
 * @param {number} lat - Latitude
 * @param {number} lon - Longitude
 * @param {number} radius - Search radius in meters
 * @returns {Promise<{nodes: Map, ways: Array, graph: Map}>}
 */
/**
 * Fetches streets, paths, parks, and tree data from Overpass API.
 * Supports either (lat, lon, radius) or a bounding box object { minLat, minLon, maxLat, maxLon }.
 * @returns {Promise<{nodes: Map, ways: Array, graph: Map}>}
 */
export async function fetchOSMData(locationParam, lon, radius) {
  let query = '';
  let centerLat = 0;
  let centerLon = 0;

  if (typeof locationParam === 'object' && locationParam.minLat !== undefined) {
    const { minLat, minLon, maxLat, maxLon } = locationParam;
    const bbox = `${minLat},${minLon},${maxLat},${maxLon}`;
    centerLat = (minLat + maxLat) / 2;
    centerLon = (minLon + maxLon) / 2;
    query = `
      [out:json][timeout:30];
      (
        way["highway"~"footway|path|pedestrian|residential|service|living_street|tertiary|secondary|track"](${bbox});
        way["leisure"="park"](${bbox});
        way["landuse"="forest"](${bbox});
        way["natural"="wood"](${bbox});
        way["natural"="tree_row"](${bbox});
        node["natural"="tree"](${bbox});
      );
      out body;
      >;
      out skel qt;
    `;
  } else {
    const lat = locationParam;
    centerLat = lat;
    centerLon = lon;
    query = `
      [out:json][timeout:30];
      (
        way["highway"~"footway|path|pedestrian|residential|service|living_street|tertiary|secondary|track"](around:${radius}, ${lat}, ${lon});
        way["leisure"="park"](around:${radius}, ${lat}, ${lon});
        way["landuse"="forest"](around:${radius}, ${lat}, ${lon});
        way["natural"="wood"](around:${radius}, ${lat}, ${lon});
        way["natural"="tree_row"](around:${radius}, ${lat}, ${lon});
        node["natural"="tree"](around:${radius}, ${lat}, ${lon});
      );
      out body;
      >;
      out skel qt;
    `;
  }

  let lastError = null;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      console.log(`Querying Overpass server: ${endpoint}`);
      
      // Implement a 12-second timeout per fetch request to fail fast on overloaded servers
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 12000);

      const response = await fetch(endpoint, {
        method: 'POST',
        body: `data=${encodeURIComponent(query)}`,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json'
        },
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`Server returned status ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      return processOSMData(data, centerLat, centerLon);
    } catch (error) {
      console.warn(`Overpass server ${endpoint} failed or timed out:`, error);
      lastError = error;
    }
  }

  throw new Error(`All Overpass API mirrors failed or timed out. Last error: ${lastError ? lastError.message : 'Unknown'}`);
}

/**
 * Processes Overpass JSON into a structured routing graph and list of features.
 */
function processOSMData(osmData, centerLat, centerLon) {
  const nodes = new Map();
  const ways = [];
  const parks = [];
  const trees = [];

  // 1. Separate elements by type
  for (const element of osmData.elements) {
    if (element.type === 'node') {
      nodes.set(element.id, {
        id: element.id,
        lat: element.lat,
        lon: element.lon,
        tags: element.tags || {}
      });
      if (element.tags && element.tags.natural === 'tree') {
        trees.push({
          id: element.id,
          lat: element.lat,
          lon: element.lon
        });
      }
    } else if (element.type === 'way') {
      ways.push(element);
      const tags = element.tags || {};
      if (tags.leisure === 'park' || tags.landuse === 'forest' || tags.natural === 'wood') {
        parks.push(element);
      }
    }
  }

  // 2. Build adjacency list graph from highway ways
  const graph = new Map();

  // Helper to add node to graph
  const initNodeInGraph = (nodeId) => {
    if (!graph.has(nodeId)) {
      graph.set(nodeId, []);
    }
  };

  const highwayWays = ways.filter(way => way.tags && way.tags.highway);

  for (const way of highwayWays) {
    const wayNodes = way.nodes;
    if (!wayNodes || wayNodes.length < 2) continue;

    for (let i = 0; i < wayNodes.length - 1; i++) {
      const uId = wayNodes[i];
      const vId = wayNodes[i + 1];

      const uNode = nodes.get(uId);
      const vNode = nodes.get(vId);

      if (!uNode || !vNode) continue;

      const dist = calculateDistance(uNode.lat, uNode.lon, vNode.lat, vNode.lon);
      const bearing = calculateBearing(uNode.lat, uNode.lon, vNode.lat, vNode.lon);
      const reverseBearing = (bearing + 180) % 360;

      initNodeInGraph(uId);
      initNodeInGraph(vId);

      const segmentTags = {
        name: way.tags.name || 'Unnamed path',
        highway: way.tags.highway,
        surface: way.tags.surface,
        footway: way.tags.footway,
        sidewalk: way.tags.sidewalk,
        tunnel: way.tags.tunnel,
        bridge: way.tags.bridge,
        oneway: way.tags.oneway
      };

      // Add bidirectional edges
      graph.get(uId).push({
        target: vId,
        distance: dist,
        bearing: bearing,
        tags: segmentTags
      });

      graph.get(vId).push({
        target: uId,
        distance: dist,
        bearing: reverseBearing,
        tags: segmentTags
      });
    }
  }

  // 3. Mark nodes that are within parks or near trees
  // This helps assign direct canopy shade scores to segments
  for (const [nodeId, node] of nodes.entries()) {
    // Check if node is in graph (only care about walkable nodes)
    if (!graph.has(nodeId)) continue;

    let inPark = false;
    let nearTree = false;

    // Check if close to any tree
    for (const tree of trees) {
      if (calculateDistance(node.lat, node.lon, tree.lat, tree.lon) < 25) { // 25 meters
        nearTree = true;
        break;
      }
    }

    // Check if node belongs to a park way
    for (const park of parks) {
      if (park.nodes && park.nodes.includes(nodeId)) {
        inPark = true;
        break;
      }
      // Or check distance to any park boundary node
      if (!inPark && park.nodes) {
        for (const parkNodeId of park.nodes) {
          const parkNode = nodes.get(parkNodeId);
          if (parkNode && calculateDistance(node.lat, node.lon, parkNode.lat, parkNode.lon) < 40) {
            inPark = true;
            break;
          }
        }
      }
    }

    node.inPark = inPark;
    node.nearTree = nearTree;
  }

  return {
    nodes,
    ways: highwayWays,
    parks,
    trees,
    graph
  };
}
