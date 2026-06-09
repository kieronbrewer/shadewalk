/**
 * Routing and Shade Scoring Engine
 * Implements Dijkstra's algorithm and loop-generation heuristics.
 */

import { calculateDistance, calculateBearing } from './osm.js';

/**
 * Min-Heap Priority Queue for Dijkstra's Algorithm
 */
class MinHeap {
  constructor() {
    this.heap = [];
  }

  push(item) {
    this.heap.push(item);
    this.up(this.heap.length - 1);
  }

  pop() {
    if (this.heap.length === 0) return null;
    const top = this.heap[0];
    const bottom = this.heap.pop();
    if (this.heap.length > 0) {
      this.heap[0] = bottom;
      this.down(0);
    }
    return top;
  }

  up(i) {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.heap[p].priority <= this.heap[i].priority) break;
      const tmp = this.heap[p];
      this.heap[p] = this.heap[i];
      this.heap[i] = tmp;
      i = p;
    }
  }

  down(i) {
    const len = this.heap.length;
    while ((i << 1) + 1 < len) {
      let left = (i << 1) + 1;
      let right = left + 1;
      let best = i;
      if (this.heap[left].priority < this.heap[best].priority) best = left;
      if (right < len && this.heap[right].priority < this.heap[best].priority) best = right;
      if (best === i) break;
      const tmp = this.heap[i];
      this.heap[i] = this.heap[best];
      this.heap[best] = tmp;
      i = best;
    }
  }

  size() {
    return this.heap.length;
  }
}

/**
 * Calculates the shade score for a path segment (0.0 = fully sunny, 1.0 = fully shaded).
 */
export function calculateSegmentShade(uNode, vNode, bearing, sunPosition) {
  if (sunPosition.elevation <= 0) return 1.0; // Night or twilight

  // 1. Base shade from tree canopy or parks
  let canopyBase = 0.0;
  if (uNode.inPark || vNode.inPark) {
    canopyBase = 0.85; // High shade in parks
  } else if (uNode.nearTree || vNode.nearTree) {
    canopyBase = 0.60; // Moderate shade near mapped trees/tree rows
  }

  // 2. Building and local shadow based on solar geometry
  const elevation = sunPosition.elevation;
  const azimuth = sunPosition.azimuth;

  // Angle between street bearing and solar azimuth (0 to 90 degrees)
  let diff = Math.abs(bearing - azimuth) % 180;
  if (diff > 90) diff = 180 - diff;

  // Perpendicular streets (diff near 90) cast long shadows.
  // Parallel streets (diff near 0) run in line with the sun (no shadows).
  const orientationFactor = Math.sin(diff * Math.PI / 180);

  // Shadows are longer and denser when the sun is lower in the sky
  const shadowLengthFactor = Math.cos(elevation * Math.PI / 180);

  // Simulate street shadows from buildings/fences/residential trees (up to 0.70)
  const streetShadow = orientationFactor * shadowLengthFactor * 0.70;

  // Total shade is the maximum of tree canopy or simulated street structures
  const totalShade = Math.max(canopyBase, streetShadow);

  return Math.max(0.0, Math.min(1.0, totalShade));
}

/**
 * Finds the nearest node in the graph to a given coordinate.
 */
export function findNearestGraphNode(lat, lon, nodes, graph) {
  let nearestNodeId = null;
  let minDistance = Infinity;
  for (const nodeId of graph.keys()) {
    const node = nodes.get(nodeId);
    if (!node) continue;
    const dist = calculateDistance(lat, lon, node.lat, node.lon);
    if (dist < minDistance) {
      minDistance = dist;
      nearestNodeId = nodeId;
    }
  }
  return nearestNodeId;
}

/**
 * Finds all nodes reachable from the start node using BFS.
 */
function getReachableNodes(startId, graph) {
  const visited = new Set([startId]);
  const queue = [startId];
  let head = 0;

  while (head < queue.length) {
    const curr = queue[head++];
    const neighbors = graph.get(curr) || [];
    for (const edge of neighbors) {
      if (!visited.has(edge.target)) {
        visited.add(edge.target);
        queue.push(edge.target);
      }
    }
  }
  return visited;
}

/**
 * Heuristic Dijkstra search between two nodes.
 * @param {string} startId - Starting node ID
 * @param {string} targetId - Target node ID
 * @param {Map} graph - Adjacency list
 * @param {Map} nodes - Node positions
 * @param {object} sunPosition - Current sun azimuth and elevation
 * @param {number} shadeImportance - Multiplier for penalizing sun exposure (0 = shortest path)
 * @param {Set} penalizedEdges - Set of edge keys to penalize (to avoid double-back in loops)
 */
function dijkstra(startId, targetId, graph, nodes, sunPosition, shadeImportance, penalizedEdges = new Set()) {
  const distances = new Map();
  const previous = new Map();
  const pq = new MinHeap();

  distances.set(startId, 0);
  pq.push({ id: startId, priority: 0 });

  while (pq.size() > 0) {
    const curr = pq.pop();
    const currId = curr.id;

    if (currId === targetId) break;

    const currentDist = distances.get(currId);
    if (curr.priority > currentDist) continue;

    const neighbors = graph.get(currId) || [];
    for (const edge of neighbors) {
      const vId = edge.target;
      const uNode = nodes.get(currId);
      const vNode = nodes.get(vId);
      if (!uNode || !vNode) continue;

      // Calculate shade for this segment
      const shade = calculateSegmentShade(uNode, vNode, edge.bearing, sunPosition);

      // Cost function: penalize sun exposure scaled by cloud cover (sun intensity)
      const cloudCover = sunPosition.cloudCover !== undefined ? sunPosition.cloudCover : 0;
      const sunIntensity = Math.max(0, 1 - (cloudCover / 100));
      let costMultiplier = 1 + (1 - shade) * shadeImportance * sunIntensity;

      // Extra penalty if this specific edge was already traversed (to force loops)
      const edgeKey = `${Math.min(currId, vId)}-${Math.max(currId, vId)}`;
      if (penalizedEdges.has(edgeKey)) {
        costMultiplier += 8.0; // severe penalty to redirect path
      }

      const weight = edge.distance * costMultiplier;
      const nextDist = currentDist + weight;

      if (!distances.has(vId) || nextDist < distances.get(vId)) {
        distances.set(vId, nextDist);
        previous.set(vId, currId);
        pq.push({ id: vId, priority: nextDist });
      }
    }
  }

  if (!previous.has(targetId)) return null;

  // Reconstruct path
  const path = [];
  let curr = targetId;
  while (curr !== undefined) {
    path.push(curr);
    curr = previous.get(curr);
  }
  path.reverse();

  // Calculate actual distance and average shade
  let actualDistance = 0;
  let totalShadeSum = 0;
  let segmentCount = 0;
  const segments = [];

  for (let i = 0; i < path.length - 1; i++) {
    const uId = path[i];
    const vId = path[i + 1];
    const neighbors = graph.get(uId) || [];
    const edge = neighbors.find(e => e.target === vId);

    if (edge) {
      actualDistance += edge.distance;
      const uNode = nodes.get(uId);
      const vNode = nodes.get(vId);
      const shade = calculateSegmentShade(uNode, vNode, edge.bearing, sunPosition);
      totalShadeSum += shade * edge.distance;
      segmentCount += edge.distance;

      segments.push({
        from: [uNode.lat, uNode.lon],
        to: [vNode.lat, vNode.lon],
        shade: shade,
        distance: edge.distance,
        bearing: edge.bearing,
        name: edge.tags.name,
        highway: edge.tags.highway
      });
    }
  }

  const avgShade = segmentCount > 0 ? totalShadeSum / segmentCount : 1.0;

  return {
    path,
    segments,
    distance: actualDistance,
    shadeScore: avgShade
  };
}

/**
 * Generates walking loop recommendations.
 * @param {string} startNodeId - Start node
 * @param {number} targetDistanceMeters - Requested distance
 * @param {object} osmData - Map data (nodes, graph, etc.)
 * @param {object} sunPosition - Solar azimuth & elevation
 * @param {string} fitnessLevel - 'beginner', 'intermediate', or 'advanced'
 * @returns {Array<object>} Recommended routes
 */
export function generateRoutes(startNodeId, targetDistanceMeters, osmData, sunPosition, fitnessLevel) {
  const { graph, nodes } = osmData;
  const routes = [];

  if (!graph.has(startNodeId)) return [];

  // Get reachable network
  const reachable = getReachableNodes(startNodeId, graph);
  if (reachable.size < 5) return [];

  // Determine routing options based on fitness level
  let shadeImportance = 3.0; // Beginner prefers maximum shade
  let speedMps = 1.2; // 2.7 mph
  if (fitnessLevel === 'intermediate') {
    shadeImportance = 1.5;
    speedMps = 1.4; // 3.1 mph
  } else if (fitnessLevel === 'advanced') {
    shadeImportance = 0.5;
    speedMps = 1.6; // 3.6 mph
  }

  // We want to generate 3 loops in different directions (e.g. North, East, South, West)
  const directions = [
    { label: 'North Canopy Loop', angle: 0 },
    { label: 'East Shady Street Stroll', angle: 90 },
    { label: 'South Forest Path', angle: 180 },
    { label: 'West Cool Breeze Trail', angle: 270 }
  ];

  const startNode = nodes.get(startNodeId);

  // Find candidate pivots for each direction
  for (const dir of directions) {
    if (routes.length >= 3) break; // We want exactly 3 routes

    // Target pivot distance should be roughly 40% of target loop distance (since we loop back)
    const targetPivotDist = targetDistanceMeters * 0.40;

    let bestPivotId = null;
    let bestPivotScore = -Infinity;

    for (const nodeId of reachable) {
      if (nodeId === startNodeId) continue;
      const node = nodes.get(nodeId);
      if (!node) continue;

      const dist = calculateDistance(startNode.lat, startNode.lon, node.lat, node.lon);
      // Pivot should be within a reasonable distance range
      if (dist < targetPivotDist * 0.6 || dist > targetPivotDist * 1.4) continue;

      const bearing = calculateBearing(startNode.lat, startNode.lon, node.lat, node.lon);
      let angleDiff = Math.abs(bearing - dir.angle) % 360;
      if (angleDiff > 180) angleDiff = 360 - angleDiff;

      // Pivot should be in the general direction (within 45 degrees)
      if (angleDiff > 45) continue;

      // Scoring pivot: prefer nodes inside parks, near trees, or matching distance perfectly
      let score = 1000 - Math.abs(dist - targetPivotDist); // Distance similarity
      if (node.inPark) score += 500;
      if (node.nearTree) score += 200;

      if (score > bestPivotScore) {
        bestPivotScore = score;
        bestPivotId = nodeId;
      }
    }

    if (!bestPivotId) continue;

    // We have a pivot node. Let's trace a loop: Start -> Pivot -> Start.
    // 1. Path Out: Start -> Pivot (weighting shade heavily)
    const pathOut = dijkstra(startNodeId, bestPivotId, graph, nodes, sunPosition, shadeImportance);
    if (!pathOut) continue;

    // 2. Penalize the edges used in pathOut to force the return route to take different streets
    const traversedEdges = new Set();
    for (let i = 0; i < pathOut.path.length - 1; i++) {
      const u = pathOut.path[i];
      const v = pathOut.path[i + 1];
      const edgeKey = `${Math.min(u, v)}-${Math.max(u, v)}`;
      traversedEdges.add(edgeKey);
    }

    // 3. Path Return: Pivot -> Start (penalizing out edges, maintaining shade weight)
    const pathReturn = dijkstra(bestPivotId, startNodeId, graph, nodes, sunPosition, shadeImportance, traversedEdges);
    if (!pathReturn) continue;

    // Combine path Out and path Return
    const fullPath = [...pathOut.path, ...pathReturn.path.slice(1)];
    const fullSegments = [...pathOut.segments, ...pathReturn.segments];
    const totalDistance = pathOut.distance + pathReturn.distance;
    
    // Average shade score weighted by distance
    const totalShadeDist = (pathOut.shadeScore * pathOut.distance) + (pathReturn.shadeScore * pathReturn.distance);
    const avgShade = totalDistance > 0 ? totalShadeDist / totalDistance : 1.0;

    // Estimate walk duration (minutes)
    const durationMin = Math.round((totalDistance / speedMps) / 60);

    routes.push({
      name: dir.label,
      path: fullPath,
      segments: fullSegments,
      distance: totalDistance,
      duration: durationMin,
      shadeScore: avgShade,
      fitnessLevel: fitnessLevel,
      pivotNodeId: bestPivotId,
      calories: Math.round(totalDistance * 0.06) // rough estimate of calories burned
    });
  }

  // Fallback: If we couldn't generate direction-based loops (e.g. sparse graph or tiny town)
  // Let's do a simple random path or out-and-back to ensure we return SOMETHING.
  if (routes.length === 0) {
    // Find the furthest reachable node within target distance
    let bestNodeId = null;
    let maxDist = 0;
    for (const nodeId of reachable) {
      const node = nodes.get(nodeId);
      if (!node) continue;
      const dist = calculateDistance(startNode.lat, startNode.lon, node.lat, node.lon);
      if (dist <= targetDistanceMeters * 0.45 && dist > maxDist) {
        maxDist = dist;
        bestNodeId = nodeId;
      }
    }

    if (bestNodeId) {
      const pathOut = dijkstra(startNodeId, bestNodeId, graph, nodes, sunPosition, shadeImportance);
      const traversedEdges = new Set();
      if (pathOut) {
        for (let i = 0; i < pathOut.path.length - 1; i++) {
          const u = pathOut.path[i];
          const v = pathOut.path[i + 1];
          traversedEdges.add(`${Math.min(u, v)}-${Math.max(u, v)}`);
        }
        const pathReturn = dijkstra(bestNodeId, startNodeId, graph, nodes, sunPosition, shadeImportance, traversedEdges);
        if (pathReturn) {
          const fullPath = [...pathOut.path, ...pathReturn.path.slice(1)];
          const fullSegments = [...pathOut.segments, ...pathReturn.segments];
          const totalDistance = pathOut.distance + pathReturn.distance;
          const avgShade = (pathOut.shadeScore * pathOut.distance + pathReturn.shadeScore * pathReturn.distance) / totalDistance;
          routes.push({
            name: 'Standard Shade Trail',
            path: fullPath,
            segments: fullSegments,
            distance: totalDistance,
            duration: Math.round((totalDistance / speedMps) / 60),
            shadeScore: avgShade,
            fitnessLevel: fitnessLevel,
            calories: Math.round(totalDistance * 0.06)
          });
        }
      }
    }
  }

  // Sort routes by shade score descending
  return routes.sort((a, b) => b.shadeScore - a.shadeScore);
}

/**
 * Generates 3 paths between a start node and a destination node:
 * 1. Shadiest (heavy shade importance)
 * 2. Balanced (moderate shade importance)
 * 3. Quickest (shortest, no shade importance)
 */
export function generatePointToPointRoutes(startNodeId, targetNodeId, osmData, sunPosition, fitnessLevel) {
  const { graph, nodes } = osmData;
  const routes = [];

  if (!graph.has(startNodeId) || !graph.has(targetNodeId)) return [];

  // Walking speed parameters
  let speedMps = 1.3; // avg speed
  if (fitnessLevel === 'beginner') speedMps = 1.1;
  else if (fitnessLevel === 'advanced') speedMps = 1.5;

  // We want to generate three distinct options:
  // 1. Shadiest Route
  const shadiest = dijkstra(startNodeId, targetNodeId, graph, nodes, sunPosition, 4.0); // very high penalty for sun
  if (shadiest) {
    routes.push({
      name: '🌳 Shadiest Canopy Route',
      path: shadiest.path,
      segments: shadiest.segments,
      distance: shadiest.distance,
      duration: Math.round((shadiest.distance / speedMps) / 60),
      shadeScore: shadiest.shadeScore,
      calories: Math.round(shadiest.distance * 0.06)
    });
  }

  // 2. Balanced Route
  const balanced = dijkstra(startNodeId, targetNodeId, graph, nodes, sunPosition, 1.5); // balanced
  if (balanced) {
    routes.push({
      name: '⚖️ Balanced Shady Route',
      path: balanced.path,
      segments: balanced.segments,
      distance: balanced.distance,
      duration: Math.round((balanced.distance / speedMps) / 60),
      shadeScore: balanced.shadeScore,
      calories: Math.round(balanced.distance * 0.06)
    });
  }

  // 3. Quickest/Shortest Route
  const quickest = dijkstra(startNodeId, targetNodeId, graph, nodes, sunPosition, 0.0); // no shade penalty
  if (quickest) {
    routes.push({
      name: '⚡ Quickest Direct Route',
      path: quickest.path,
      segments: quickest.segments,
      distance: quickest.distance,
      duration: Math.round((quickest.distance / speedMps) / 60),
      shadeScore: quickest.shadeScore,
      calories: Math.round(quickest.distance * 0.06)
    });
  }

  // Deduplicate exact same routes by distance
  const uniqueRoutes = [];
  const distancesSeen = new Set();
  
  for (const route of routes) {
    const roundedDist = Math.round(route.distance);
    if (!distancesSeen.has(roundedDist)) {
      distancesSeen.add(roundedDist);
      uniqueRoutes.push(route);
    }
  }

  // If deduplication leaves us with only 1 route but we had more options, keep all of them
  if (uniqueRoutes.length === 1 && routes.length > 1) {
    return routes;
  }

  return uniqueRoutes;
}

