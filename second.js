// --- GLOBAL VARIABLES ---
const LIGHT_DISTANCE = 0.00014; // distance for lights
const bbox = [
  45.41305,  // south
  -75.70649, // west
  45.42025,  // north
  -75.68919  // east
].join(',');

// These globals will hold the data
let trafficSignals = [];
let roadsData = [];
let intersectionsWithRoads = [];
let lightGroups = {}; // key = intersectionId, value = intersectionLightGroups
const lightControllers = {};
const roadGraph = {}; 
// intersectionId → [{ roadId, nextIntersectionId, geometry }]

let ambulanceMarker = null;

function initAmbulanceMarker(initialPosition) {
  const heroIcon = L.icon({ 
    iconUrl: 'icons/ambulance.png', 
    iconSize: [55, 55], 
    iconAnchor: [27, 27], 
    className: 'hero-marker hero-els'
  });

  ambulanceMarker = L.marker(initialPosition, { icon: heroIcon }).addTo(map);
}



// --- Fetch functions ---
async function fetchTrafficSignals() {
  const query = `
    [out:json][timeout:1000];
    nwr["highway"="traffic_signals"](${bbox});
    out geom;
  `;
  const res = await fetch("https://overpass-api.de/api/interpreter", { method: "POST", body: query });
  if (!res.ok) throw new Error("Failed to fetch traffic signals");
  const data = await res.json();
  trafficSignals = data.elements; // store globally
  return trafficSignals;
}

async function fetchRoads() {
  const query = `
    [out:json][timeout:1000];
    (
      way["highway"="primary"](${bbox});
      way["highway"="secondary"](${bbox});
      way["highway"="residential"](${bbox});
    );
    out geom;
  `;
  const res = await fetch("https://overpass-api.de/api/interpreter", { method: "POST", body: query });
  if (!res.ok) throw new Error("Failed to fetch roads");
  const data = await res.json();
  roadsData = data.elements; // store globally
  return roadsData;
}

async function matchRoadToIntersection() {
  try {
    // Ensure both signals and roads are fetched
    if (!trafficSignals.length) await fetchTrafficSignals();
    if (!roadsData.length) await fetchRoads();

    intersectionsWithRoads = trafficSignals.map(signal => {
      const { id: idIntersection, lat, lon } = signal;
      if (lat === undefined || lon === undefined) return null;

      // Find all roads that include this intersection point
      const connectedRoads = roadsData
        .filter(road => road.geometry && road.geometry.some(coord => {
          // Overpass nodes sometimes use lat/lon or [1,0] ordering
          const pointLat = coord.lat ?? coord[1];
          const pointLon = coord.lon ?? coord[0];
          return Math.abs(pointLat - lat) < 0.00001 && Math.abs(pointLon - lon) < 0.00001;
        }))
        .map(road => road.id);

      return {
        idIntersection,
        roads: connectedRoads
      };
    }).filter(x => x !== null);

    console.log("Matched intersections to roads:", intersectionsWithRoads);
    return intersectionsWithRoads;

  } catch (err) {
    console.error("Failed to match roads to intersections:", err);
    return [];
  }
}



function buildRoadGraph() {
  intersectionsWithRoads.forEach(intersection => {
    roadGraph[intersection.idIntersection] = [];

    intersection.roads.forEach(roadId => {
      const road = roadsData.find(r => r.id === roadId);
      if (!road || !road.geometry) return;

      intersectionsWithRoads.forEach(other => {
        if (other.idIntersection === intersection.idIntersection) return;
        if (!other.roads.includes(roadId)) return;

        roadGraph[intersection.idIntersection].push({
          roadId,
          nextIntersectionId: other.idIntersection,
          geometry: road.geometry
        });
      });
    });
  });

  console.log("🛣️ Road graph built", roadGraph);
}


// Place orange points for each intersection
function placeIntersections() {
  if (!intersectionsWithRoads || intersectionsWithRoads.length === 0) {
    console.warn("No intersections available. Make sure matchRoadToIntersection() has been called.");
    return;
  }

  intersectionsWithRoads.forEach(intersection => {
    // Find the lat/lon from the trafficSignals array
    const signalNode = trafficSignals.find(s => s.id === intersection.idIntersection);
    if (!signalNode || signalNode.lat === undefined || signalNode.lon === undefined) return;

    // L.circleMarker([signalNode.lat, signalNode.lon], {
    //   radius: 5,
    //   color: 'orange',
    //   fillColor: 'orange',
    //   fillOpacity: 0.8
    // }).addTo(map);
  });
}

function addLights() {
  if (!intersectionsWithRoads || intersectionsWithRoads.length === 0) {
    console.warn("No intersections with roads available.");
    return;
  }


  intersectionsWithRoads.forEach(intersection => {
    const signalNode = trafficSignals.find(s => s.id === intersection.idIntersection);
    if (!signalNode || signalNode.lat === undefined || signalNode.lon === undefined) return;

    const { lat, lon } = signalNode;

    // Orange intersection marker
    // const intersectionMarker = L.circleMarker([lat, lon], {
    //   color: 'orange',
    //   fillColor: 'orange',
    //   fillOpacity: 0.8,
    //   radius: 5
    // }).addTo(map);

    // // Click handler: log way IDs
    // intersectionMarker.on('click', () => {
    //   console.log('Intersection clicked:', {
    //     lat,
    //     lon,
    //     idIntersection: intersection.idIntersection,
    //   });
    // });

    const lines = [];

    intersection.roads.forEach(roadId => {
      const road = roadsData.find(r => r.id === roadId);
      if (!road || !road.geometry) return;

      // Find closest point in road geometry to the intersection
      let closestIndex = 0;
      let minDist = Infinity;
      road.geometry.forEach((coord, idx) => {
        const pointLat = coord.lat ?? coord[1];
        const pointLon = coord.lon ?? coord[0];
        const dist = Math.hypot(pointLat - lat, pointLon - lon);
        if (dist < minDist) {
          minDist = dist;
          closestIndex = idx;
        }
      });

      // Determine a small vector along the road
      let targetCoord;
      if (closestIndex < road.geometry.length - 1) targetCoord = road.geometry[closestIndex + 1];
      else if (closestIndex > 0) targetCoord = road.geometry[closestIndex - 1];
      else targetCoord = road.geometry[closestIndex];

      const targetLat = targetCoord.lat ?? targetCoord[1];
      const targetLon = targetCoord.lon ?? targetCoord[0];

      const vectorLat = targetLat - lat;
      const vectorLon = targetLon - lon;

      // If exactly 2 roads connected, make the line go both directions
      if (intersection.roads.length === 2) {
        const endPoint1 = [
          lat + vectorLat * LIGHT_DISTANCE * 10000,
          lon + vectorLon * LIGHT_DISTANCE * 10000
        ];
        const endPoint2 = [
          lat - vectorLat * LIGHT_DISTANCE * 10000,
          lon - vectorLon * LIGHT_DISTANCE * 10000
        ];

        lines.push({
          start: endPoint2,
          mid: [lat, lon],
          end: endPoint1,
          vector: [vectorLat, vectorLon]
        });
      } else {
        const endPoint = [
          lat + vectorLat * LIGHT_DISTANCE * 10000,
          lon + vectorLon * LIGHT_DISTANCE * 10000
        ];
        lines.push({ start: [lat, lon], end: endPoint, vector: [vectorLat, vectorLon] });
      }
    });

    // Group vectors by angle (~180° apart)
    const groups = [[], []];
    lines.forEach((line, i) => {
      if (i === 0) groups[0].push(line);
      else {
        const angle = angleBetweenVectors(line.vector, lines[0].vector);
        if (Math.abs(angle - Math.PI) < 0.2) groups[0].push(line);
        else groups[1].push(line);
      }
    });

    // Draw lines and add flickering markers
    const intersectionLightGroups = [[], []];

    groups.forEach((group, gIndex) => {
      group.forEach(line => {
        if (line.mid) {
          // L.polyline([line.start, line.mid, line.end], { color: 'blue', weight: 3, opacity: 0.8 }).addTo(map);
          const marker1 = L.circleMarker(line.start, { radius: 4, color: 'red', fillColor: 'red', fillOpacity: 0.8 }).addTo(map);
          const marker2 = L.circleMarker(line.end, { radius: 4, color: 'red', fillColor: 'red', fillOpacity: 0.8 }).addTo(map);
          intersectionLightGroups[gIndex].push(marker1, marker2);
        } else {
          // L.polyline([line.start, line.end], { color: 'blue', weight: 3, opacity: 0.8 }).addTo(map);
          const marker = L.circleMarker(line.end, { radius: 4, color: 'red', fillColor: 'red', fillOpacity: 0.8 }).addTo(map);
          intersectionLightGroups[gIndex].push(marker);
        }
      });
    });

    // Toggle opposite groups with Green → Yellow → Red, green time random 3–6s
    function toggleLightsWithYellow(intersectionId, intersectionLightGroups, yellowTime = 2000) {
      let activeGroup = 0;
      let state = 'green';
      let timeoutId = null;
      let paused = false;

      function applyState() {
        intersectionLightGroups.forEach((group, gIndex) => {
          group.forEach(marker => {
            if (gIndex === activeGroup) {
              marker.setStyle({
                fillColor: state === 'green' ? 'green' : 'yellow',
                color: state === 'green' ? 'green' : 'yellow'
              });
            } else {
              marker.setStyle({ fillColor: 'red', color: 'red' });
            }
          });
        });
      }

      function step() {
        if (paused) return;

        applyState();

        if (state === 'green') {
          const greenTime = 5000 + Math.random() * 5000;
          timeoutId = setTimeout(() => {
            state = 'yellow';
            step();
          }, greenTime);
        } else {
          timeoutId = setTimeout(() => {
            state = 'green';
            activeGroup = 1 - activeGroup;
            step();
          }, yellowTime);
        }
      }

      // controller API
      lightControllers[intersectionId] = {
        pause() {
          paused = true;
          if (timeoutId) clearTimeout(timeoutId);
        },
        resume() {
          paused = false;
          step();
        },
        forceState(groupIndex, color) {
          intersectionLightGroups.forEach((group, gIndex) => {
            group.forEach(marker => {
              const c =
                gIndex === groupIndex ? color : 'red';
              marker.setStyle({ fillColor: c, color: c });
            });
          });
        }
      };

      step();
    }


    toggleLightsWithYellow(intersection.idIntersection, intersectionLightGroups);
    lightGroups[intersection.idIntersection] = intersectionLightGroups;
  });

  // Helper: angle between vectors in radians
  function angleBetweenVectors(v1, v2) {
    const dot = v1[0] * v2[0] + v1[1] * v2[1];
    const mag1 = Math.sqrt(v1[0] ** 2 + v1[1] ** 2);
    const mag2 = Math.sqrt(v2[0] ** 2 + v2[1] ** 2);
    const cosTheta = dot / (mag1 * mag2);
    return Math.acos(Math.min(Math.max(cosTheta, -1), 1));
  }
}

function ambulanceLightHardcoded(intersectionId, targetPosition) {
  const controller = lightControllers[intersectionId];
  const intersectionLightGroups = lightGroups[intersectionId];

  if (!controller || !intersectionLightGroups) {
    console.warn("No controller for intersection", intersectionId);
    return;
  }

  // Normalize position input
  const targetLat = Array.isArray(targetPosition)
    ? targetPosition[0]
    : targetPosition.lat;
  const targetLng = Array.isArray(targetPosition)
    ? targetPosition[1]
    : targetPosition.lng;

  const YELLOW_TIME = 2000;
  const OVERRIDE_GREEN_TIME = 20000;

  console.log("🚑 Ambulance override");

  // 1️⃣ Find closest group to target position
  let closestGroup = null;
  let minDist = Infinity;

  intersectionLightGroups.forEach((group, gIndex) => {
    group.forEach(marker => {
      const { lat, lng } = marker.getLatLng();
      const dist = Math.hypot(lat - targetLat, lng - targetLng);

      if (dist < minDist) {
        minDist = dist;
        closestGroup = gIndex;
      }
    });
  });

  if (closestGroup === null) {
    console.warn("No lights found for intersection", intersectionId);
    return;
  }

  console.log("➡️ Closest group:", closestGroup);

  // 2️⃣ Pause normal cycle
  controller.pause();

  // 3️⃣ Detect current green group
  let currentGreen = null;
  intersectionLightGroups.forEach((group, gIndex) => {
    if (group.some(m => m.options.fillColor === 'green')) {
      currentGreen = gIndex;
    }
  });

  // 🟢 CASE 1: Desired group already green → extend
  if (currentGreen === closestGroup) {
    console.log("✅ Desired direction already green, extending");

    controller.forceState(closestGroup, 'green');

    setTimeout(() => {
      // pass previous green so we skip yellow if it’s the same
      gracefulResume(controller, intersectionLightGroups, currentGreen);
    }, OVERRIDE_GREEN_TIME);

    return;
  }

  // 🔁 CASE 2: Switch direction (yellow first)
  if (currentGreen !== null) {
    controller.forceState(currentGreen, 'yellow');
  }

  setTimeout(() => {
    controller.forceState(closestGroup, 'green');

    setTimeout(() => {
      // pass previous green so it knows which side was active before override
      gracefulResume(controller, intersectionLightGroups, currentGreen);
    }, OVERRIDE_GREEN_TIME);

  }, YELLOW_TIME);

}

function gracefulResume(controller, intersectionLightGroups, previousGreen = null) {
  console.log("🟡 Graceful resume");

  // Detect current green after override
  let currentGreen = 0;
  intersectionLightGroups.forEach((group, gIndex) => {
    if (group.some(m => m.options.fillColor === 'green')) {
      currentGreen = gIndex;
    }
  });

  // If previousGreen is same as currentGreen, skip yellow
  if (previousGreen !== null && previousGreen === currentGreen) {
    console.log("✅ Current green matches previous, resuming directly");
    controller.resume(currentGreen);
    return;
  }

  // Otherwise, do yellow transition
  controller.forceState(currentGreen, 'yellow');

  setTimeout(() => {
    controller.resume(currentGreen);
  }, 2000);
}

function addPulsingRing(latlng, options = {}) {
  const color = options.color || 'red';
  const maxRadius = options.radius || 50;
  const minRadius = options.minRadius || maxRadius * 0.2; // never shrink completely
  const duration = options.duration || 8000; // full cycle: min -> max -> min in ms

  const circle = L.circle(latlng, {
    color: color,
    fillColor: color,
    fillOpacity: 0.3,
    radius: minRadius,
    weight: 2
  }).addTo(map);

  const startTime = performance.now();

  function animate(now) {
    const elapsed = (now - startTime) % duration; // loop every duration
    // use sine wave to get smooth pulse: sin(0)=0, sin(pi/2)=1, sin(pi)=0
    const t = (elapsed / duration) * 2 * Math.PI; // 0 → 2π
    const radius = minRadius + (maxRadius - minRadius) * (Math.sin(t) * 0.5 + 0.5); // scale 0→1
    const opacity = 0.3 * (1 - (radius - minRadius) / (maxRadius - minRadius)) + 0.1;

    circle.setRadius(radius);
    circle.setStyle({ fillOpacity: opacity });

    requestAnimationFrame(animate);
  }

  requestAnimationFrame(animate);

  return circle;
}

// Function to move ambulance towards target position
function moveAmbulance(targetPosition, speed = 50) {
  if (!ambulanceMarker) {
    console.warn("Ambulance marker not initialized");
    return;
  }

  const targetLatLng = L.latLng(targetPosition[0], targetPosition[1]);
  let lastTime = null;

  function animate(time) {
    if (!lastTime) lastTime = time;
    const dt = (time - lastTime) / 1000; // seconds
    lastTime = time;

    const currentLatLng = ambulanceMarker.getLatLng();
    const distance = currentLatLng.distanceTo(targetLatLng); // meters

    if (distance < 0.5) {
      ambulanceMarker.setLatLng(targetLatLng); // snap to target
      return; // stop animation
    }

    // Calculate movement vector
    const moveDistance = speed * dt; // meters
    const ratio = moveDistance / distance;

    // Interpolate new position
    const newLat = currentLatLng.lat + (targetLatLng.lat - currentLatLng.lat) * ratio;
    const newLng = currentLatLng.lng + (targetLatLng.lng - currentLatLng.lng) * ratio;

    ambulanceMarker.setLatLng([newLat, newLng]);

    requestAnimationFrame(animate);
  }

  requestAnimationFrame(animate);
}

// Draw a path on the map from an array of coordinates
// path: array of [lat, lng] pairs, e.g. [[45.419, -75.694], [45.420, -75.693], ...]
// options: optional styling for the polyline
function tracePath(path, options = {}) {
  if (!path || path.length < 2) return null; // need at least 2 points

  // Default polyline style
  const defaultOptions = {
    color: 'grey',
    weight: 4,
    opacity: 0.7,
    dashArray: null, // you can add "5,10" for dashed line
  };

  const polyline = L.polyline(path, { ...defaultOptions, ...options }).addTo(map);

  // Optionally, zoom the map to fit the path
  map.fitBounds(polyline.getBounds(), { padding: [50, 50] });

  return polyline; // return the polyline in case you want to remove or update it later
}

class Car {
  constructor(startIntersectionId, speed = 12) {
    this.speed = speed;
    this.currentIntersection = startIntersectionId;
    this.previousIntersection = null;
    this.path = [];
    this.pathIndex = 0;
    this.stopped = false;

    const node = trafficSignals.find(s => s.id === startIntersectionId);
    this.marker = L.circleMarker([node.lat, node.lon], {
      radius: 4,
      color: '#888',
      fillColor: '#888',
      fillOpacity: 1
    }).addTo(map);

    this.chooseNextRoad();
  }

  chooseNextRoad() {
    const options = roadGraph[this.currentIntersection]
      .filter(o => o.nextIntersectionId !== this.previousIntersection);

    if (options.length === 0) return;

    const choice = options[Math.floor(Math.random() * options.length)];
    this.previousIntersection = this.currentIntersection;
    this.currentIntersection = choice.nextIntersectionId;

    this.path = choice.geometry.map(p => [
      p.lat ?? p[1],
      p.lon ?? p[0]
    ]);

    this.pathIndex = 0;
  }

  update(dt) {
    if (this.stopped) return;
    if (this.pathIndex >= this.path.length - 1) {
      this.chooseNextRoad();
      return;
    }

    const current = this.marker.getLatLng();
    const target = L.latLng(this.path[this.pathIndex + 1]);
    const dist = current.distanceTo(target);
    const move = this.speed * dt;

    if (dist < move) {
      this.marker.setLatLng(target);
      this.pathIndex++;
    } else {
      const ratio = move / dist;
      this.marker.setLatLng([
        current.lat + (target.lat - current.lat) * ratio,
        current.lng + (target.lng - current.lng) * ratio
      ]);
    }
  }
}

function checkTrafficLights(car) {
  intersectionsWithRoads.forEach(intersection => {
    const lights = lightGroups[intersection.idIntersection];
    if (!lights) return;

    lights.forEach(group => {
      group.forEach(light => {
        const d = car.marker.getLatLng().distanceTo(light.getLatLng());
        if (d < 10) {
          if (light.options.fillColor === 'red' || light.options.fillColor === 'yellow') car.stopped = true;
          else car.stopped = false;
        }
      });
    });
  });
}


const cars = [];
let lastTime = null;

function animateCars(time) {
  if (!lastTime) lastTime = time;
  const dt = (time - lastTime) / 1000 * 3;
  lastTime = time;

  cars.forEach(car => {
    checkTrafficLights(car);
    car.update(dt);
  });

  requestAnimationFrame(animateCars);
}

function spawnCar() {
  const start = intersectionsWithRoads[
    Math.floor(Math.random() * intersectionsWithRoads.length)
  ];
  cars.push(new Car(start.idIntersection, 8 + Math.random() * 6));
}

// spawn one every 3s






// Example usage for your hardcoded intersection
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    ambulanceLightHardcoded(901046399, [45.420396, -75.69531]);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.code === "Digit1") {
    ambulanceLightHardcoded(901051199, [45.41945, -75.6944]);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.code === "Digit2") {
    moveAmbulance([45.42015, -75.69498], 60);
  }
});




// Example usage:
// Retry helper: tries asyncFunction up to 'retries' times
async function retryAsync(asyncFunction, retries = 3, delay = 500) {
  let attempt = 0;
  while (attempt < retries) {
    try {
      return await asyncFunction();
    } catch (err) {
      attempt++;
      console.warn(`Attempt ${attempt} failed:`, err);
      if (attempt < retries) {
        await new Promise(res => setTimeout(res, delay)); // wait before retry
      } else {
        throw err; // all retries failed
      }
    }
  }
}

// Main load function with retries
(async () => {
  try {
    initAmbulanceMarker([45.42015, -75.69503]);
    const signals = await retryAsync(fetchTrafficSignals, 3, 1000); // retry up to 3 times, 1s delay
    const roads = await retryAsync(fetchRoads, 3, 1000);             // retry up to 3 times, 1s delay
    

    // Assign global variables so matchRoadToIntersection can use them
    window.trafficSignals = signals;
    window.roadsData = roads;

    await matchRoadToIntersection(); // create intersectionsWithRoads
    buildRoadGraph();
    placeIntersections();            // place orange points on map
    addLights();
    addPulsingRing([45.41380, -75.69804], { color: 'orange', radius: 40, duration: 3000 });
    tracePath([[45.42015, -75.69503], [45.41707, -75.69234], [45.41546, -75.69637], [45.41474, -75.69585], [45.41380, -75.69804]]);
    
    setInterval(spawnCar, 3000);
    requestAnimationFrame(animateCars);
  } catch (err) {
    console.error("Failed to load traffic signals or roads after retries:", err);
  }
})();
