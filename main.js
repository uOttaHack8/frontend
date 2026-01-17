const map = L.map('map').setView([45.4215, -75.6972], 15);

// OpenStreetMap tiles
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© OpenStreetMap contributors'
}).addTo(map);

// Ambulance marker & path
const ambulanceIcon = L.icon({ iconUrl: 'icons/ambulance.png', iconSize: [20, 20] });
let ambulanceMarker = L.marker([45.4210, -75.6980], { icon: ambulanceIcon }).addTo(map);

const path = [
  [45.4210, -75.6980],
  [45.4213, -75.6977],
  [45.4215, -75.6972],
  [45.4218, -75.6965]
];

let i = 0;
setInterval(() => {
  ambulanceMarker.setLatLng(path[i]);
  i = (i + 1) % path.length;
}, 1000);


// ------------------------------
// Fetch the red light camera data
// ------------------------------
// roadsData = your GeoJSON.features
const LIGHT_DISTANCE = 0.00014; // ~15–20m visually, adjust if needed

let roadsData = null;

// Load your pre-selected intersections from a JSON file
let selectedIntersections = [];

Promise.all([
  fetch('roadData/export.geojson').then(res => res.json()), // roads data
  fetch('roadData/trafficLightIntersections.json').then(res => res.json()) // selected intersections
])
.then(([roads, intersections]) => {
  roadsData = roads;
  selectedIntersections = intersections;
  console.log("Road data loaded:", roadsData.features.length);
  console.log("Selected intersections loaded:", selectedIntersections.length);

  // For each selected intersection
  // Helper function to calculate angle between two vectors in radians
  function angleBetweenVectors(v1, v2) {
    const dot = v1[0]*v2[0] + v1[1]*v2[1];
    const mag1 = Math.sqrt(v1[0]**2 + v1[1]**2);
    const mag2 = Math.sqrt(v2[0]**2 + v2[1]**2);
    const cosTheta = dot / (mag1 * mag2);
    return Math.acos(Math.min(Math.max(cosTheta, -1), 1)); // clamp to [-1,1] to avoid NaN
  }
  const lightGroups = []; // store all dot markers by group for toggling

  selectedIntersections.forEach(({ lat, lng, ways }) => {

    // Draw red circle for intersection
    const intersectionMarker = L.circleMarker([lat, lng], {
      color: 'orange',
      fillColor: 'orange',
      fillOpacity: 0.8,
      radius: 5
    }).addTo(map);

    // Click handler: log way IDs
    intersectionMarker.on('click', () => {
      console.log('Intersection clicked:', {
        lat,
        lng,
        ways
      });
    });

    const lines = [];

    ways.forEach(wayId => {
      const feature = roadsData.features.find(f => f.id === wayId);
      if (!feature) return;

      const coords = feature.geometry.coordinates;
      const index = coords.findIndex(c => 
        c[1].toFixed(6) == lat.toFixed(6) && c[0].toFixed(6) == lng.toFixed(6)
      );
      if (index === -1) return;

      let start = [lat, lng];
      let target;

      if (ways.length === 2) {
        if (index < coords.length - 1) target = [coords[index + 1][1], coords[index + 1][0]];
        else if (index > 0) target = [coords[index - 1][1], coords[index - 1][0]];
        else return;

        const dLat = target[0] - lat;
        const dLng = target[1] - lng;

        // fixed-distance endpoints
        const end = pointAtDistance(lat, lng, dLat, dLng, LIGHT_DISTANCE);
        const opposite = pointAtDistance(lat, lng, -dLat, -dLng, LIGHT_DISTANCE);

        lines.push({
          start: opposite,
          mid: [lat, lng],
          end: end,
          vector: [dLat, dLng]
        });

      } else {
        if (index < coords.length - 1) target = [coords[index + 1][1], coords[index + 1][0]];
        else if (index > 0) target = [coords[index - 1][1], coords[index - 1][0]];
        else return;

        const dLat = target[0] - lat;
        const dLng = target[1] - lng;

        const end = pointAtDistance(lat, lng, dLat, dLng, LIGHT_DISTANCE);

        lines.push({
          start: [lat, lng],
          end: end,
          vector: [dLat, dLng]
        });
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

    // Draw lines and create green/orange markers
    const intersectionLightGroups = [[], []];

    groups.forEach((group, gIndex) => {
      const color = gIndex === 0 ? 'green' : 'red';
      group.forEach(line => {
        if (line.mid) {
          L.polyline([line.start, line.mid, line.end], { color: 'blue', weight: 3, opacity: 0.8 }).addTo(map);
          const marker1 = L.circleMarker(line.start, { color, fillColor: color, fillOpacity: 0.8, radius: 4 }).addTo(map);
          const marker2 = L.circleMarker(line.end, { color, fillColor: color, fillOpacity: 0.8, radius: 4 }).addTo(map);
          intersectionLightGroups[gIndex].push(marker1, marker2);
        } else {
          L.polyline([line.start, line.end], { color: 'blue', weight: 3, opacity: 0.8 }).addTo(map);
          const marker = L.circleMarker(line.end, { color, fillColor: color, fillOpacity: 0.8, radius: 4 }).addTo(map);
          intersectionLightGroups[gIndex].push(marker);
        }
      });
    });

    // Each intersection has its own interval
    lightGroups.push(intersectionLightGroups);

    function toggleLights() {
      intersectionLightGroups.forEach((group, gIndex) => {
        const isOn = gIndex === 0; // first group is "on"
        group.forEach(marker => {
          marker.setStyle({ fillColor: isOn ? 'green' : 'red', color: isOn ? 'green' : 'red' });
        });
      });
      // swap groups
      intersectionLightGroups.reverse();
      // random next interval between 3-6 seconds
      const nextInterval = 3000 + Math.random() * 3000;
      setTimeout(toggleLights, nextInterval);
    }

    // start toggling for this intersection
    toggleLights();

  });

  // helper function for angle
  function angleBetweenVectors(v1, v2) {
    const dot = v1[0]*v2[0] + v1[1]*v2[1];
    const mag1 = Math.sqrt(v1[0]**2 + v1[1]**2);
    const mag2 = Math.sqrt(v2[0]**2 + v2[1]**2);
    const cosTheta = dot / (mag1 * mag2);
    return Math.acos(cosTheta); // radians
  }
  
  function pointAtDistance(lat, lng, dLat, dLng, distance) {
    const length = Math.sqrt(dLat * dLat + dLng * dLng);
    if (length === 0) return [lat, lng];

    const unitLat = dLat / length;
    const unitLng = dLng / length;

    return [
      lat + unitLat * distance,
      lng + unitLng * distance
    ];
  }





})
.catch(err => console.error("Failed to load road or intersection data:", err));






// const nodeMap = {};       // key = "lat,lng", value = count
// const coordMap = {};      // key = "lat,lng", value = [lat, lng]
// const intersectionMap = {}; // key = "lat,lng", value = array of way IDs

// let roadsData = null;

// // Store clicked intersections
// const clickedIntersections = [];

// fetch('roadData/export.geojson')
//   .then(res => res.json())
//   .then(data => {
//     roadsData = data;

//     // Build node map
//     roadsData.features.forEach(feature => {
//       const wayId = feature.id;
//       feature.geometry.coordinates.forEach(coord => {
//         const key = `${coord[1].toFixed(6)},${coord[0].toFixed(6)}`;
//         nodeMap[key] = (nodeMap[key] || 0) + 1;
//         coordMap[key] = [coord[1], coord[0]];

//         if (!intersectionMap[key]) intersectionMap[key] = [];
//         if (!intersectionMap[key].includes(wayId)) intersectionMap[key].push(wayId);
//       });
//     });

//     // Find all intersections
//     const intersections = [];
//     for (const key in nodeMap) {
//       if (nodeMap[key] > 1) {
//         intersections.push({
//           coord: coordMap[key],
//           ways: intersectionMap[key]
//         });
//       }
//     }

//     console.log("Intersections found:", intersections.length);

//     // Add clickable markers for all intersections
//     intersections.forEach(({ coord, ways }) => {
//       const [lat, lng] = coord;

//       const marker = L.circleMarker([lat, lng], {
//         color: 'red',
//         fillColor: 'red',
//         fillOpacity: 0.2,
//         radius: 10
//       }).addTo(map);

//       // Click handler
//       marker.on('click', () => {
//         const intersectionData = { lat, lng, ways };
//         console.log('Clicked intersection:', intersectionData);

//         // Add to array (avoid duplicates)
//         const exists = clickedIntersections.some(i => i.lat === lat && i.lng === lng);
//         if (!exists) clickedIntersections.push(intersectionData);

//         // Optional: highlight clicked marker
//         marker.setStyle({ color: 'orange', fillColor: 'orange' });
//       });
//     });

//     // Spacebar listener to save JSON
//     document.addEventListener('keydown', (e) => {
//       if (e.code === 'Space') {
//         if (clickedIntersections.length === 0) return;
//         const blob = new Blob([JSON.stringify(clickedIntersections, null, 2)], { type: 'application/json' });
//         const url = URL.createObjectURL(blob);
//         const a = document.createElement('a');
//         a.href = url;
//         a.download = 'clicked_intersections.json';
//         a.click();
//         URL.revokeObjectURL(url);
//         console.log('Saved clicked intersections:', clickedIntersections.length);
//       }
//     });

//   })
//   .catch(err => console.error("Failed to load road data:", err));

