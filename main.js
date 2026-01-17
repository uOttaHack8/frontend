// main.js

// --- CONFIGURATION ---
const PHYSICS = {
    ambSpeed: 23,         // m/s
    ambAccel: 7.0,        // m/s^2
    carSpeed: 14,         // m/s
    carClearSpeed: 28,    // m/s
    yellowDuration: 2500,
    lookAhead: 10,        // UPDATED: 10s Trigger (Just-in-time)
    scanRadius: 40,       
    yieldDistance: 150,   
    panicDistance: 45,    
    stopLineDist: 15,     
    carSpacing: 9         
};

// --- MAP SETUP ---
const map = L.map('map', { 
    zoomControl: false, 
    renderer: L.canvas() 
}).setView([45.4190, -75.6953], 17);

L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; CartoDB',
    maxZoom: 21,
    subdomains: 'abcd'
}).addTo(map);

// --- ASSETS ---
const heroIcon = L.icon({ 
    iconUrl: 'icons/ambulance.png', 
    iconSize: [55, 55], 
    iconAnchor: [27, 27], 
    className: 'hero-marker hero-els'
});

const destIcon = L.divIcon({ className: 'dest-marker', iconSize: [20, 20] });

const lightIcons = {
    RED: L.icon({ iconUrl: 'icons/redLight.png', iconSize: [22, 22], iconAnchor: [11, 11] }),
    YELLOW: L.icon({ iconUrl: 'icons/yellowLight.png', iconSize: [22, 22], iconAnchor: [11, 11] }), 
    GREEN: L.icon({ iconUrl: 'icons/greenLight.png', iconSize: [28, 28], iconAnchor: [14, 14] })
};

const trafficStyle = { radius: 4, fillColor: "#ccc", color: "#000", weight: 1, opacity: 1, fillOpacity: 1 };

// --- UTILS ---
async function fetchWithRetry(url, retries = 2, delay = 1000) {
    for (let i = 0; i < retries; i++) {
        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } catch (err) {
            if (i === retries - 1) throw err;
            await new Promise(r => setTimeout(r, delay));
        }
    }
}

// --- CLASSES ---

class Vehicle {
    constructor(lat, lng, type, node) {
        this.lat = lat;
        this.lng = lng;
        this.type = type; 
        this.node = node;
        let color = type === 'cross_queue' ? "#555" : "#ccc"; 
        this.marker = L.circleMarker([lat, lng], { ...trafficStyle, fillColor: color }).addTo(map);
        this.speed = 0;
        this.state = 'IDLE'; 
        this.pathQueue = [];
        this.pulledOver = false;
        this.resumeTimer = null;
        this.originalPath = []; 
    }

    setPath(points, speed, mode = 'NORMAL') {
        if (!points || points.length === 0) return;
        this.pathQueue = points; 
        this.speed = speed;
        this.state = 'DRIVING';
        this.updateStyle(mode);
    }

    update(dt, ambIndex, ambSpeed) {
        if (this.state === 'CLEARED' || this.state === 'PARKED') return;

        // --- AI LOGIC ---
        
        // 1. Cross Traffic Logic
        if (this.type.includes('cross')) {
            const distToCenter = getDistance(this.lat, this.lng, this.node.lat, this.node.lng);
            if (this.node.state === 'GREEN' || this.node.state === 'YELLOW') {
                if (distToCenter < PHYSICS.stopLineDist && distToCenter > 6) {
                    this.speed = 0;
                    this.updateStyle('STOP');
                } else if (distToCenter <= 6) {
                    this.speed = PHYSICS.carClearSpeed; 
                    this.updateStyle('PANIC');
                }
            } else if (this.node.state === 'RED' && this.speed === 0 && this.type === 'cross_active') {
                this.speed = PHYSICS.carSpeed;
                this.updateStyle('NORMAL');
            }
        }

        // 2. Blocker Logic
        if (this.type === 'blocker') {
            const isAhead = (this.node.pathIndex > ambIndex);
            const dToAmb = getDistance(this.lat, this.lng, heroState.lat, heroState.lng);

            if (isAhead) {
                if (dToAmb < PHYSICS.panicDistance) {
                    if (!this.pulledOver) {
                        this.speed = PHYSICS.carClearSpeed; 
                        this.updateStyle('PANIC');
                        this.initiatePullOver(); 
                    }
                } else if (dToAmb < PHYSICS.yieldDistance) {
                    this.initiatePullOver();
                }
            } else {
                if (this.pulledOver && !this.resumeTimer) {
                    this.resumeTimer = setTimeout(() => {
                         this.resumeDriving();
                    }, 2000);
                }
            }
        }

        // --- MOVEMENT ---
        if (this.speed <= 0 || this.pathQueue.length === 0) return;

        const target = this.pathQueue[0];
        const d = getDistance(this.lat, this.lng, target[0], target[1]);
        
        if (d < 3) {
            this.pathQueue.shift();
            if (this.pathQueue.length === 0) {
                if (this.pulledOver) {
                    this.speed = 0; 
                } else {
                    this.state = 'CLEARED';
                    map.removeLayer(this.marker);
                }
                return;
            }
        }

        const moveDist = this.speed * dt;
        const bearing = getBearing({lat:this.lat, lng:this.lng}, {lat:target[0], lng:target[1]});
        const newPos = destinationPoint(this.lat, this.lng, moveDist, bearing);
        
        this.lat = newPos.lat;
        this.lng = newPos.lng;
        this.marker.setLatLng([this.lat, this.lng]);
    }

    initiatePullOver() {
        if (this.pulledOver) return;
        this.pulledOver = true;
        if (this.pathQueue.length > 0) this.originalPath = [...this.pathQueue];
        else this.originalPath = [[this.node.lat, this.node.lng]]; 

        const bearing = getBearing({lat:this.lat, lng:this.lng}, {lat:this.node.lat, lng:this.node.lng});
        const pullPos = destinationPoint(this.lat, this.lng, 5, bearing + 90); 
        this.pathQueue = [[pullPos.lat, pullPos.lng]];
        this.speed = 5; 
        this.updateStyle('YIELD');
    }

    resumeDriving() {
        this.pulledOver = false;
        this.resumeTimer = null;
        if (this.originalPath.length > 0) {
             this.pathQueue = this.originalPath;
             this.speed = PHYSICS.carSpeed;
             this.updateStyle('NORMAL');
        }
    }

    updateStyle(mode) {
        if (mode === 'PANIC') this.marker.setStyle({ className: 'car-pulse', fillColor: '#ff0000', radius: 5 });
        else if (mode === 'YIELD') this.marker.setStyle({ className: 'car-yield', fillColor: '#ffff00', radius: 4 });
        else if (mode === 'STOP') this.marker.setStyle({ className: '', fillColor: '#444' });
        else if (mode === 'NORMAL') this.marker.setStyle({ className: '', fillColor: '#ccc' });
    }
}

class Intersection {
    constructor(data) {
        this.id = data.id;
        this.name = data.name || `SIGNAL #${data.id}`;
        this.lat = data.lat;
        this.lng = data.lng;
        this.pathIndex = data.pathIndex;
        this.crossRoadGeom = data.crossRoadGeom || []; 
        this.state = 'RED'; 
        this.marker = L.marker([this.lat, this.lng], { icon: lightIcons.RED }).addTo(map);
        
        this.vehicles = [];
        this.crossQueueCount = 0; 

        this.spawnBlockersOnPath();
        
        if (this.crossRoadGeom.length > 1) {
            this.spawnCrossQueue(); 
            this.spawnActiveCrossTraffic(3); 
        } else {
            this.spawnFallbackTraffic();
        }

        this.spawner = setInterval(() => {
            if (this.state === 'RED' && this.crossRoadGeom.length > 1) this.spawnActiveCrossTraffic(1);
        }, 1500);
    }

    spawnBlockersOnPath() {
        if (this.pathIndex < 10) return;
        
        let currentIdx = this.pathIndex;
        currentIdx = this.moveBackwards(routePath, currentIdx, 10); // Skip stop line

        for(let i=0; i<8; i++) {
            if (currentIdx <= 0) break;

            const p1 = routePath[currentIdx];
            const p2 = routePath[Math.min(routePath.length-1, currentIdx + 3)] || p1; 
            const bearing = getBearing({lat:p1.lat, lng:p1.lng}, {lat:p2.lat, lng:p2.lng});
            const pos = destinationPoint(p1.lat, p1.lng, 3, bearing + 90); 

            const v = new Vehicle(pos.lat, pos.lng, 'blocker', this);
            v.setPath([[this.lat, this.lng]], 8); 
            this.vehicles.push(v);
            
            currentIdx = this.moveBackwards(routePath, currentIdx, PHYSICS.carSpacing);
        }
    }
    
    // NEW: TRUE GEOMETRY WALKER FOR CROSS STREETS
    spawnCrossQueue() {
        if (this.crossRoadGeom.length < 2) return;
        
        // 1. Find Center Index
        let centerIdx = 0;
        let minD = Infinity;
        this.crossRoadGeom.forEach((pt, i) => {
            const d = getDistance(this.lat, this.lng, pt[0], pt[1]);
            if (d < minD) { minD = d; centerIdx = i; }
        });

        // 2. We walk BACKWARDS from the center along the cross road geometry
        // We need to convert the crossRoadGeom to a format our 'moveBackwards' helper understands
        // crossRoadGeom is [[lat,lng], [lat,lng]]
        // We need [{lat,lng}, {lat,lng}]
        const geomPath = this.crossRoadGeom.map(pt => ({ lat: pt[0], lng: pt[1] }));
        
        let currentIdx = centerIdx;
        
        // Start 15m back from center (Stop Line)
        currentIdx = this.moveBackwards(geomPath, currentIdx, PHYSICS.stopLineDist);

        for (let i = 0; i < 5; i++) {
            if (currentIdx <= 0) break;

            const pt = geomPath[currentIdx];
            const v = new Vehicle(pt.lat, pt.lng, 'cross_queue', this);
            this.vehicles.push(v);
            this.crossQueueCount++;

            // Walk back for next car
            currentIdx = this.moveBackwards(geomPath, currentIdx, PHYSICS.carSpacing);
        }
    }

    // Generic geometry walker
    moveBackwards(pathArray, startIndex, meters) {
        let dist = 0;
        let idx = startIndex;
        while (dist < meters && idx > 0) {
            const p1 = pathArray[idx];
            const p2 = pathArray[idx-1];
            dist += getDistance(p1.lat, p1.lng, p2.lat, p2.lng);
            idx--;
        }
        return idx;
    }

    spawnActiveCrossTraffic(count) {
        if (this.crossRoadGeom.length < 2) return;
        for (let i = 0; i < count; i++) {
            const idx = Math.floor(Math.random() * (this.crossRoadGeom.length - 2));
            const pt = this.crossRoadGeom[idx];
            if (!pt) continue;
            const v = new Vehicle(pt[0], pt[1], 'cross_active', this);
            const path = this.crossRoadGeom.slice(idx);
            v.setPath(path, PHYSICS.carSpeed);
            this.vehicles.push(v);
        }
    }

    spawnFallbackTraffic() {
        for(let i=0; i<4; i++) {
            const lat = this.lat;
            const lng = this.lng + (i % 2 === 0 ? 0.0005 : -0.0005);
            const v = new Vehicle(lat, lng, 'cross_queue', this);
            this.vehicles.push(v);
        }
    }

    triggerSequence() {
        if (this.state !== 'RED') return;
        this.state = 'YELLOW';
        this.marker.setIcon(lightIcons.YELLOW);
        clearInterval(this.spawner); 
        
        setTimeout(() => {
            this.state = 'GREEN';
            this.marker.setIcon(lightIcons.GREEN);
            this.flushBlockers();
        }, PHYSICS.yellowDuration);
    }

    flushBlockers() {
        this.vehicles.forEach(v => {
            if (v.type === 'blocker' && !v.pulledOver) {
                 v.speed = PHYSICS.carClearSpeed;
                 v.updateStyle('PANIC');
            }
        });
    }

    updatePhysics(dt, ambIndex, ambSpeed) {
        this.vehicles.forEach(v => v.update(dt, ambIndex, ambSpeed));
    }
}


// --- GLOBAL SYSTEM ---
let intersections = [];
let routePath = [];
let heroState = { dist: 0, speed: 0, lat: 0, lng: 0, currentIndex: 0 };
const heroMarker = L.marker([0,0], { icon: heroIcon });

const startCoords = "-75.6974,45.4215"; 
const endCoords   = "-75.6925,45.4125"; 

async function initSystem() {
    updateHUDStatus("CONNECTING TO SATELLITE...");
    
    const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${startCoords};${endCoords}?overview=full&geometries=geojson`;
    const data = await fetchWithRetry(osrmUrl);
    if (!data) return updateHUDStatus("ROUTING SERVER OFFLINE");

    const rawCoords = data.routes[0].geometry.coordinates;
    let totalDist = 0;
    routePath = rawCoords.map((c, i) => {
        const lat = c[1]; const lng = c[0];
        let seg = 0;
        if(i > 0) seg = getDistance(rawCoords[i-1][1], rawCoords[i-1][0], lat, lng);
        totalDist += seg;
        return { lat, lng, totalDist };
    });
    
    L.polyline(routePath.map(p=>[p.lat, p.lng]), {color:'white', opacity:0.15, weight:8}).addTo(map);
    
    const endPt = routePath[routePath.length-1];
    L.marker([endPt.lat, endPt.lng], {icon: destIcon}).addTo(map);

    updateHUDStatus("SCANNING INFRASTRUCTURE...");
    
    let success = await fetchDeepIntersectionData(rawCoords);
    if (!success) {
        updateHUDStatus("SWITCHING TO LOW-BANDWIDTH MODE...");
        await fetchSimpleIntersectionData(rawCoords);
    }

    requestAnimationFrame(loop);
}

// STRATEGY 1: Heavy Query
async function fetchDeepIntersectionData(routeCoords) {
    let minLat=90, maxLat=-90, minLng=180, maxLng=-180;
    routeCoords.forEach(c => {
        if(c[1] < minLat) minLat = c[1]; if(c[1] > maxLat) maxLat = c[1];
        if(c[0] < minLng) minLng = c[0]; if(c[0] > maxLng) maxLng = c[0];
    });

    const bbox = `${minLat-0.002},${minLng-0.002},${maxLat+0.002},${maxLng+0.002}`;
    const query = `
        [out:json][timeout:25];
        (node["highway"="traffic_signals"](${bbox});)->.signals;
        .signals out;
        way(bn.signals);
        out geom;
    `;
    const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`;
    
    try {
        const osmData = await fetchWithRetry(url, 2);
        if (!osmData || osmData.elements.length === 0) return false;

        const waysByNode = {};
        osmData.elements.forEach(el => {
            if (el.type === 'way') {
                el.nodes.forEach(nid => {
                    if (!waysByNode[nid]) waysByNode[nid] = [];
                    waysByNode[nid].push(el);
                });
            }
        });

        processNodes(osmData.elements, waysByNode);
        return intersections.length > 0;
    } catch (err) {
        return false;
    }
}

// STRATEGY 2: Light Query
async function fetchSimpleIntersectionData(routeCoords) {
    let minLat=90, maxLat=-90, minLng=180, maxLng=-180;
    routeCoords.forEach(c => {
        if(c[1] < minLat) minLat = c[1]; if(c[1] > maxLat) maxLat = c[1];
        if(c[0] < minLng) minLng = c[0]; if(c[0] > maxLng) maxLng = c[0];
    });

    const bbox = `${minLat-0.002},${minLng-0.002},${maxLat+0.002},${maxLng+0.002}`;
    const query = `[out:json][timeout:25];node["highway"="traffic_signals"](${bbox});out;`;
    const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`;

    try {
        const osmData = await fetchWithRetry(url, 2);
        if (!osmData) return false;
        processNodes(osmData.elements, {}); 
        updateHUDStatus(`LOW-RES MODE: ${intersections.length} SIGNALS`);
        return true;
    } catch (err) {
        updateHUDStatus("SIGNAL CONNECTION LOST");
        return false;
    }
}

function processNodes(elements, waysByNode) {
    elements.forEach(el => {
        if (el.type === 'node') {
            let bestIdx = -1; let minD = Infinity;
            routePath.forEach((p, i) => {
                const d = getDistance(el.lat, el.lon, p.lat, p.lng);
                if(d < minD) { minD = d; bestIdx = i; }
            });

            if (minD < PHYSICS.scanRadius) {
                let crossName = null;
                let crossGeom = [];
                const connectedWays = waysByNode[el.id] || [];
                const crossWay = connectedWays.find(w => !w.tags?.name?.includes("O'Connor"));

                if (crossWay) {
                    crossName = crossWay.tags?.name?.toUpperCase();
                    crossGeom = crossWay.geometry.map(g => [g.lat, g.lon]);
                }

                intersections.push(new Intersection({
                    id: el.id,
                    name: crossName,
                    lat: routePath[bestIdx].lat, 
                    lng: routePath[bestIdx].lng,
                    pathIndex: bestIdx,
                    crossRoadGeom: crossGeom
                }));
            }
        }
    });
    intersections.sort((a,b) => a.pathIndex - b.pathIndex);
}


// --- LOOP ---
let lastTime = performance.now();
function loop(now) {
    const dt = (now - lastTime) / 1000;
    lastTime = now;
    if(dt > 0.1) { requestAnimationFrame(loop); return; }

    const totalLen = routePath[routePath.length-1].totalDist;
    const distRem = totalLen - heroState.dist;

    if (distRem < 15) {
        heroState.speed = 0;
        updateHUDStatus("MISSION COMPLETE");
        document.getElementById('hud').classList.add('mission-complete');
    } else {
        if(heroState.speed < PHYSICS.ambSpeed) heroState.speed += PHYSICS.ambAccel * dt;
        heroState.dist += heroState.speed * dt;
    }

    const pos = getPosFromDist(heroState.dist);
    if(pos) {
        heroState.lat = pos.lat;
        heroState.lng = pos.lng;
        heroState.currentIndex = pos.index;

        heroMarker.setLatLng([pos.lat, pos.lng]).addTo(map);
        map.panTo([pos.lat, pos.lng], {animate: false});
        if (distRem > 15) runAIScan();
    }

    intersections.forEach(i => i.updatePhysics(dt, heroState.currentIndex, heroState.speed));
    updateSpeed(Math.round(heroState.speed * 3.6));
    requestAnimationFrame(loop);
}

function runAIScan() {
    let target = null;
    for (let i = 0; i < intersections.length; i++) {
        const node = intersections[i];
        if (node.pathIndex > heroState.currentIndex) {
            if (node.state === 'RED') {
                target = node;
                break;
            }
        }
    }

    if(target) {
        const distToLight = routePath[target.pathIndex].totalDist - routePath[heroState.currentIndex].totalDist;
        const eta = distToLight / Math.max(1, heroState.speed);
        updateHUDStatus(`TARGET: ${target.name} (ETA: ${eta.toFixed(0)}s)`);
        if(eta < PHYSICS.lookAhead || distToLight < 200) target.triggerSequence();
    } else {
        updateHUDStatus("ALL SYSTEMS GREEN");
    }
}

// --- MATH ---
function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3;
    const a = 0.5 - Math.cos((lat2-lat1)*Math.PI/180)/2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*(1-Math.cos((lon2-lon1)*Math.PI/180))/2;
    return R * 2 * Math.asin(Math.sqrt(a));
}
function getPosFromDist(d) {
    for(let i=0; i<routePath.length-1; i++) {
        if(d >= routePath[i].totalDist && d <= routePath[i+1].totalDist) {
            const len = routePath[i+1].totalDist - routePath[i].totalDist;
            const r = (d - routePath[i].totalDist) / len;
            return {
                lat: routePath[i].lat + (routePath[i+1].lat - routePath[i].lat)*r,
                lng: routePath[i].lng + (routePath[i+1].lng - routePath[i].lng)*r,
                index: i 
            };
        }
    }
    return null;
}
function destinationPoint(lat, lng, dist, bearing) {
    const R = 6371e3;
    const φ1 = lat*Math.PI/180, λ1 = lng*Math.PI/180;
    const φ2 = Math.asin(Math.sin(φ1)*Math.cos(dist/R) + Math.cos(φ1)*Math.sin(dist/R)*Math.cos(bearing));
    const λ2 = λ1 + Math.atan2(Math.sin(bearing)*Math.sin(dist/R)*Math.cos(φ1), Math.cos(dist/R)-Math.sin(φ1)*Math.sin(φ2));
    return { lat: φ2*180/Math.PI, lng: λ2*180/Math.PI };
}
function getBearing(start, end) {
    const φ1 = start.lat*Math.PI/180, φ2 = end.lat*Math.PI/180;
    const Δλ = (end.lng-start.lng)*Math.PI/180;
    const y = Math.sin(Δλ)*Math.cos(φ2);
    const x = Math.cos(φ1)*Math.sin(φ2) - Math.sin(φ1)*Math.cos(φ2)*Math.cos(Δλ);
    return Math.atan2(y, x)*180/Math.PI; 
}

// --- UI INIT ---
document.body.insertAdjacentHTML('beforeend', `
<div id="hud">
    <div class="hud-row"><span class="hud-label">DATA STREAM:</span><span class="hud-val hud-active">LIVE OSM GEOMETRY</span></div>
    <hr style="border:0; border-top:1px solid #333; margin:8px 0;">
    <div style="font-size:16px; font-weight:bold; color:#ffff00" id="scan-target">INITIALIZING...</div>
</div>
<div id="speed-gauge"><div id="speed-value">0</div><div id="speed-unit">KM/H</div></div>
`);
function updateHUDStatus(text) { document.getElementById('scan-target').innerText = text; }
function updateSpeed(val) { document.getElementById('speed-value').innerText = val; }

initSystem();