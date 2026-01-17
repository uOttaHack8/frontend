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
fetch('https://overpass-api.de/api/interpreter?data=' + encodeURIComponent(`
[out:json][timeout:60];
area["name"="Ottawa"]->.searchArea;
way
  ["highway"~"^(trunk|primary|secondary|tertiary|unclassified|residential)$"]
  (area.searchArea)->.roads;
node
  (roads)
  (if:count(ways) > 1);
out;
`))
  .then(res => res.json())
  .then(osmData => {
    const nodes = osmData.elements.slice(0, 50); // first 50 intersections

    const lightIcons = {
      RED: L.icon({ iconUrl: 'icons/redLight.png', iconSize: [10, 10] }),
      GREEN: L.icon({ iconUrl: 'icons/greenLight.png', iconSize: [10, 10] })
    };

    nodes.forEach(node => {
      const lat = node.lat;
      const lng = node.lon;
      const offset = 0.00015;

      const lights = {
        N: L.marker([lat + offset, lng - offset / 1.5], { icon: lightIcons.RED }).addTo(map),
        S: L.marker([lat - offset, lng + offset / 1.5], { icon: lightIcons.RED }).addTo(map),
        E: L.marker([lat + offset / 3, lng + offset], { icon: lightIcons.GREEN }).addTo(map),
        W: L.marker([lat - offset / 3, lng - offset], { icon: lightIcons.GREEN }).addTo(map),
      };

      node.lights = lights;
    });
  })
  .catch(err => console.error('Failed to load OSM intersections:', err));
