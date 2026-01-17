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
