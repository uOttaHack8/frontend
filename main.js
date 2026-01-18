// main.js

// ==========================================
// 1. CONFIGURATION
// ==========================================
const CONFIG = {
    debug: true,
    
    // --- SPEEDS (m/s) ---
    // 1 m/s = 3.6 km/h
    roamSpeed: 14,        // ~50 km/h (Cruising)
    ambSpeedHigh: 33,     // ~120 km/h (Smart City ON)
    ambSpeedLow: 10,      // ~36 km/h (Smart City OFF - Traffic delays)
    ambAccel: 15.0,       // Acceleration factor
    
    // --- TRAFFIC ---
    carSpeed: 14,         
    carClearSpeed: 30,    
    carSpacing: 22,       
    bumperDist: 14,       
    maxCarsPerQueue: 5,   
    
    // --- SMART SYSTEM ---
    greenHoldTime: 10000, 
    lookAheadTime: 15,    // Trigger lights 15s away based on current speed
    scanRadius: 100,      
    lookAheadTime: 10,    // Trigger lights 10s away based on current speed
    scanRadius: 20,      
    stopLineDist: 30      
};

// ==========================================
// 2. GLOBAL STATE
// ==========================================
let smartCityEnabled = true; 
let systemState = 'IDLE';    // IDLE, ROAMING, EMERGENCY, ARRIVED
let isRouting = false;
let startTime = 0;
let timerInterval = null;
let lastTime = 0;

// Camera
let cameraLocked = true;

// Replay Memory
let lastStart = null;
let lastEnd = null;

// Data
let intersections = [];
let routePath = [];

// Hero State
let heroState = { 
    dist: 0, 
    speed: 0, 
    lat: 45.4215, 
    lng: -75.6974, 
    currentIndex: 0 
};

// Visual Handles
let currentRouteLine = null;
let crashMarker = null;

// ==========================================
// 3. MAP SETUP
// ==========================================

const SAFE_START = { lat: 45.4215, lng: -75.6974 }; 

const map = L.map('map', { 
    zoomControl: true, 
    renderer: L.canvas() 
}).setView([SAFE_START.lat, SAFE_START.lng], 17); // Initial Zoom

L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; CartoDB',
    maxZoom: 21,
    subdomains: 'abcd'
}).addTo(map);

// --- Camera Interaction ---
map.on('dragstart', () => {
    // Fix: Allow unlocking camera in any state
    if (cameraLocked) {
        cameraLocked = false;
        const btn = document.getElementById('recenter-btn');
        if (btn) btn.style.display = 'block';
    }
});

// --- Custom Panes ---
map.createPane('routePane'); map.getPane('routePane').style.zIndex = 400;
map.createPane('vehiclePane'); map.getPane('vehiclePane').style.zIndex = 600;
map.createPane('crashPane'); map.getPane('crashPane').style.zIndex = 2000;
map.createPane('heroPane'); map.getPane('heroPane').style.zIndex = 3000;

// --- Layer Groups ---
const routeLayerGroup = L.layerGroup().addTo(map);
const vehicleLayerGroup = L.layerGroup().addTo(map);
const visualLayerGroup = L.layerGroup().addTo(map); 

// --- Assets ---
const heroIcon = L.icon({ 
    iconUrl: 'icons/ambulance.png', 
    iconSize: [60, 60], iconAnchor: [30, 30], className: 'hero-marker'
});

const crashIcon = L.divIcon({ 
    className: 'crash-marker', 
    html: '<div class="crash-inner">💥</div>', iconSize: [80, 80], iconAnchor: [40, 60] 
});

const createSignalIcon = (color, rotation) => {
    return L.divIcon({
        className: 'signal-marker',
        html: `<div style="transform: rotate(${rotation - 90}deg); color: ${color}; text-shadow: 0 0 10px ${color};">➤</div>`,
        iconSize: [32, 32], iconAnchor: [16, 16]
    });
};

const trafficStyle = { radius: 5, fillColor: "#ccc", color: "#000", weight: 1, opacity: 1, fillOpacity: 1 };

const heroMarker = L.marker([SAFE_START.lat, SAFE_START.lng], { icon: heroIcon, pane: 'heroPane' }).addTo(map);


// ==========================================
// 4. UTILS
// ==========================================

async function fetchJSON(url) {
    try {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 30000); 
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } catch (e) {
        console.warn("API Fail:", e.message);
        return null;
    }
}

function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3;
    const a = 0.5 - Math.cos((lat2-lat1)*Math.PI/180)/2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*(1-Math.cos((lon2-lon1)*Math.PI/180))/2;
    return R * 2 * Math.asin(Math.sqrt(a));
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

function getPosFromDist(d) {
    if (!routePath || routePath.length < 2) return null;
    for(let i=0; i<routePath.length-1; i++) {
        if(d >= routePath[i].totalDist && d <= routePath[i+1].totalDist) {
            const r = (d - routePath[i].totalDist) / (routePath[i+1].totalDist - routePath[i].totalDist);
            return {
                lat: routePath[i].lat + (routePath[i+1].lat - routePath[i].lat)*r,
                lng: routePath[i].lng + (routePath[i+1].lng - routePath[i].lng)*r,
                index: i 
            };
        }
    }
    return null;
}

function isValidCoord(lat, lng) {
    return (lat && lng && lat !== 0 && lng !== 0 && !isNaN(lat) && !isNaN(lng));
}

async function getValidRoadPoint() {
    const bounds = { minLat: 45.4100, maxLat: 45.4300, minLng: -75.7100, maxLng: -75.6800 };
    for(let i=0; i<5; i++) {
        const lat = bounds.minLat + Math.random() * (bounds.maxLat - bounds.minLat);
        const lng = bounds.minLng + Math.random() * (bounds.maxLng - bounds.minLng);
        const url = `http://127.0.0.1:5000/nearest/v1/driving/${lng},${lat}?number=1`;
        const data = await fetchJSON(url);
        if (data && data.waypoints && data.waypoints.length > 0) {
            const snapped = data.waypoints[0].location; 
            if(isValidCoord(snapped[1], snapped[0])) {
                const dist = getDistance(lat, lng, snapped[1], snapped[0]);
                if (dist < 50) return { lat: snapped[1], lng: snapped[0] }; 
            }
        }
    }
    return { lat: SAFE_START.lat + 0.005, lng: SAFE_START.lng + 0.005 }; 
}

// ==========================================
// 5. TRAFFIC CLASSES
// ==========================================

class Vehicle {
    constructor(lat, lng, type, node) {
        this.lat = lat; this.lng = lng; this.type = type; this.node = node;
        this.marker = L.circleMarker([lat, lng], { ...trafficStyle, pane: 'vehiclePane' }).addTo(vehicleLayerGroup);
        this.speed = 0; this.state = 'IDLE'; 
        this.pathQueue = []; this.pulledOver = false; this.resuming = false;
        this.originalPath = []; this.reactionDelay = Math.random() * 800; 
    }

    setPath(points, speed) {
        if (!points || !points.length) return;
        this.pathQueue = points; this.speed = speed; this.state = 'DRIVING';
    }

    update(dt, ambIndex, vehiclesAhead) {
        if (this.state === 'CLEARED') return;

        // Collision Check
        let maxSpeed = CONFIG.carClearSpeed;
        if (vehiclesAhead) {
            vehiclesAhead.forEach(v => {
                if (v === this) return;
                const dist = getDistance(this.lat, this.lng, v.lat, v.lng);
                if (dist < 30) {
                    if (dist < CONFIG.bumperDist) maxSpeed = 0;
                    else if (dist < CONFIG.bumperDist * 2) maxSpeed = Math.min(maxSpeed, v.speed);
                }
            });
        }

        // Emergency Logic
        if (systemState === 'EMERGENCY') {
            
            // Cross Traffic
            if (this.type.includes('cross')) {
                const distToCenter = getDistance(this.lat, this.lng, this.node.lat, this.node.lng);
                if (smartCityEnabled && this.node.state === 'GREEN_WAVE') {
                    if (distToCenter < CONFIG.stopLineDist && distToCenter > 6) { this.speed = 0; this.updateStyle('STOP'); }
                    else if (distToCenter <= 6) { this.speed = CONFIG.carClearSpeed; this.updateStyle('PANIC'); }
                } else {
                    const distToAmb = getDistance(this.lat, this.lng, heroState.lat, heroState.lng);
                    if (distToAmb < 30 && distToCenter < 15) { this.speed = 0; this.updateStyle('STOP'); }
                }
            }

            // Same Road
            if (this.type === 'blocker') {
                const dAmb = getDistance(this.lat, this.lng, heroState.lat, heroState.lng);
                const isAhead = (this.node.pathIndex > ambIndex);
                if (isAhead && dAmb < 250 && !this.pulledOver && !this.resuming) {
                    setTimeout(() => this.initiatePullOver(), this.reactionDelay);
                } else if (!isAhead && this.pulledOver && !this.resuming && dAmb > 20) {
                    this.resuming = true;
                    setTimeout(() => this.resumeDriving(), 300);
                }
            }
        }

        let effectiveSpeed = Math.min(this.speed, maxSpeed);
        if (effectiveSpeed <= 0 || !this.pathQueue.length) return;

        const target = this.pathQueue[0];
        const dist = getDistance(this.lat, this.lng, target[0], target[1]);
        
        if (dist < 3) {
            this.pathQueue.shift();
            if (!this.pathQueue.length) {
                if (this.pulledOver) { this.state = 'PARKED'; this.speed = 0; }
                else { this.state = 'CLEARED'; this.destroy(); }
                return;
            }
        }

        const moveDist = effectiveSpeed * dt;
        const bearing = getBearing({lat:this.lat, lng:this.lng}, {lat:target[0], lng:target[1]});
        const newPos = destinationPoint(this.lat, this.lng, moveDist, bearing);
        this.lat = newPos.lat; this.lng = newPos.lng;
        this.marker.setLatLng([this.lat, this.lng]);
    }

    initiatePullOver() {
        if(this.pulledOver || this.resuming) return;
        this.pulledOver = true;
        this.updateStyle('YIELD');
        this.originalPath = this.pathQueue.length ? [...this.pathQueue] : [[this.node.lat, this.node.lng]];
        const bearing = getBearing({lat:this.lat, lng:this.lng}, {lat:this.node.lat, lng:this.node.lng});
        const pullPos = destinationPoint(this.lat, this.lng, 3.5, bearing + 90); 
        this.pathQueue = [[pullPos.lat, pullPos.lng]];
        this.speed = 8;
    }

    resumeDriving() {
        this.pulledOver = false; this.resuming = false; this.state = 'DRIVING';
        this.updateStyle('NORMAL');
        let mergePt = this.originalPath.length ? {lat:this.originalPath[0][0], lng:this.originalPath[0][1]} : {lat:this.node.lat, lng:this.node.lng};
        this.pathQueue = [[mergePt.lat, mergePt.lng], ...this.originalPath];
        this.speed = CONFIG.carSpeed;
    }

    updateStyle(mode) {
        if (mode === 'PANIC') this.marker.setStyle({ fillColor: '#ff0000', color: '#500', weight: 1 });
        else if (mode === 'YIELD') this.marker.setStyle({ fillColor: '#ffff00', color: '#000', weight: 2 });
        else this.marker.setStyle({ fillColor: this.type.includes('queue') ? "#555" : "#ccc", color: "#000", weight: 1 });
    }

    destroy() { vehicleLayerGroup.removeLayer(this.marker); }
}

class Intersection {
    constructor(data) {
        Object.assign(this, data);
        this.state = 'RED'; 
        this.vehicles = [];
        this.lightMarker = null;

        // Visuals
        if (this.crossRoadGeom.length > 1) {
            this.crossPoly = L.polyline(this.crossRoadGeom, { color: '#ff0000', weight: 14, opacity: 0 }).addTo(visualLayerGroup);
        }

        const geomPoints = [];
        let idx = Math.max(0, this.pathIndex - 5);
        while(idx <= Math.min(routePath.length - 1, this.pathIndex + 5)) {
            geomPoints.push([routePath[idx].lat, routePath[idx].lng]); idx++;
        }
        
        if(geomPoints.length > 1) {
            // Main Road
            this.mainPoly = L.polyline(geomPoints, { color: '#ff0000', weight: 14, opacity: 0.3 }).addTo(visualLayerGroup);
            
            const start = geomPoints[0];
            const bearing = getBearing({lat:start[0], lng:start[1]}, {lat:this.lat, lng:this.lng});
            const signalPos = destinationPoint(this.lat, this.lng, 20, bearing + 180); 
            
            // Signal
            this.lightMarker = L.marker([signalPos.lat, signalPos.lng], { 
                icon: createSignalIcon('#ff0000', bearing), opacity: 1 
            }).addTo(visualLayerGroup);
        }
        
        this.vehicles = [];
        this.spawnBlockersOnPath();
        if (this.crossRoadGeom.length > 1) this.spawnCrossQueue();
        
        this.updateVisuals('RED');
        
        this.spawner = setInterval(() => {
            if (this.state === 'RED' && this.crossRoadGeom.length > 1) this.spawnActiveCrossTraffic(1);
        }, 1500);
    }

    updateVisuals(state) {
        const color = (state === 'GREEN') ? '#00ff00' : '#ff0000';
        
        if (this.lightMarker) {
            const el = this.lightMarker.getElement();
            if(el) {
                el.innerHTML = el.innerHTML.replace(/color:.*?;/, `color: ${color};`);
                el.style.borderColor = color;
                el.style.boxShadow = `0 0 15px ${color}`;
                el.style.color = color;
            }
        }

        if (state === 'GREEN') {
            if(this.mainPoly) this.mainPoly.setStyle({opacity: 0.4, color: '#00ff00'});
            if(this.crossPoly) this.crossPoly.setStyle({opacity: 0.3, color: '#ff0000'});
        } else {
            if(this.mainPoly) this.mainPoly.setStyle({opacity: 0.4, color: '#ff0000'});
            if(this.crossPoly) this.crossPoly.setStyle({opacity: 0});
        }
    }

    isLocationClear(lat, lng) {
        for (let v of this.vehicles) {
            if (getDistance(lat, lng, v.lat, v.lng) < CONFIG.carSpacing) return false;
        }
        return true;
    }

    spawnBlockersOnPath() {
        let currentIdx = this.moveBackwards(routePath, this.pathIndex, 40);
        for(let i=0; i<CONFIG.maxCarsPerQueue; i++) {
            if (currentIdx <= 0) break;
            const p1 = routePath[currentIdx];
            if(!this.isLocationClear(p1.lat, p1.lng)) {
                currentIdx = this.moveBackwards(routePath, currentIdx, 5); continue;
            }
            const v = new Vehicle(p1.lat, p1.lng, 'blocker', this);
            const remaining = routePath.slice(currentIdx).map(p=>[p.lat, p.lng]);
            v.setPath(remaining, 8);
            this.vehicles.push(v);
            currentIdx = this.moveBackwards(routePath, currentIdx, CONFIG.carSpacing);
        }
    }

    moveBackwards(pathArray, startIndex, meters) {
        let dist = 0;
        let idx = startIndex;
        if (!pathArray || idx >= pathArray.length) return 0;
        while (dist < meters && idx > 0) {
            const p1 = pathArray[idx];
            const p2 = pathArray[idx-1];
            dist += getDistance(p1.lat, p1.lng, p2.lat, p2.lng);
            idx--;
        }
        return idx;
    }

    spawnCrossQueue() {
        const centerIdx = Math.floor(this.crossRoadGeom.length / 2);
        const geomPath = this.crossRoadGeom.map(pt => ({ lat: pt[0], lng: pt[1] }));
        let currentIdx = this.moveBackwards(geomPath, centerIdx, CONFIG.stopLineDist);
        for(let i=0; i<4; i++) {
            if(currentIdx<=0) break;
            if(!this.isLocationClear(geomPath[currentIdx].lat, geomPath[currentIdx].lng)) {
                currentIdx = this.moveBackwards(geomPath, currentIdx, 5); continue;
            }
            const v = new Vehicle(geomPath[currentIdx].lat, geomPath[currentIdx].lng, 'cross_queue', this);
            this.vehicles.push(v);
            currentIdx = this.moveBackwards(geomPath, currentIdx, CONFIG.carSpacing);
        }
    }

    spawnActiveCrossTraffic(count) {
        if (this.vehicles.length > 10) return; 
        for (let i = 0; i < count; i++) {
            const idx = Math.floor(Math.random() * (this.crossRoadGeom.length - 2));
            const pt = this.crossRoadGeom[idx];
            if (!pt) continue;
            let clear = true;
            for(let v of this.vehicles) if(getDistance(pt[0], pt[1], v.lat, v.lng) < 15) { clear=false; break; }
            if(!clear) continue;

            const v = new Vehicle(pt[0], pt[1], 'cross_active', this);
            const path = this.crossRoadGeom.slice(idx);
            v.setPath(path, CONFIG.carSpeed);
            this.vehicles.push(v);
        }
    }

    triggerGreenWave() {
        if (!smartCityEnabled || this.state === 'GREEN') return;
        this.state = 'GREEN'; this.updateVisuals('GREEN');
        clearInterval(this.spawner);
        this.flushBlockers();
        setTimeout(() => {
            if (systemState === 'EMERGENCY') { this.state = 'RED'; this.updateVisuals('RED'); }
        }, CONFIG.greenHoldTime);
    }

    flushBlockers() {
        this.vehicles.forEach(v => {
            if (v.type === 'blocker' && !v.pulledOver) { v.speed = CONFIG.carClearSpeed; v.updateStyle('PANIC'); }
        });
    }

    update(dt, ambIndex) { this.vehicles.forEach(v => v.update(dt, ambIndex, this.vehicles)); }

    destroy() {
        clearInterval(this.spawner);
        // Fix: Explicitly remove visual layers to prevent crash
        if(this.crossPoly) map.removeLayer(this.crossPoly);
        if(this.mainPoly) map.removeLayer(this.mainPoly);
        if(this.lightMarker) map.removeLayer(this.lightMarker);
        this.vehicles.forEach(v => v.destroy());
    }
}


// ==========================================
// 6. MAIN SYSTEM
// ==========================================

async function startRoaming() {
    clearSystem();
    systemState = 'ROAMING';
    updateHUDStatus("UNIT 42: PATROLLING", "LIVE OSM GEOMETRY");
    
    // UI Safety Checks
    const startBtn = document.getElementById('start-btn');
    if(startBtn) startBtn.style.display = 'block';
    
    const retryBtn = document.getElementById('retry-btn');
    if(retryBtn) retryBtn.style.display = 'none';
    
    const vignette = document.getElementById('vignette');
    if(vignette) vignette.style.display = 'none';
    
    const recenter = document.getElementById('recenter-btn');
    if(recenter) recenter.style.display = 'none';
    
    const timer = document.getElementById('timer-display');
    if(timer) timer.innerText = "00:00.00";
    
    clearInterval(timerInterval);
    cameraLocked = true;

    const p1 = {lat: heroMarker.getLatLng().lat, lng: heroMarker.getLatLng().lng};
    const p2 = await getValidRoadPoint();
    
    await calculateRoute(p1, p2, false).catch(e => {
        console.log("Roam Abort, Retrying...");
        setTimeout(startRoaming, 1000);
    });
}

async function triggerEmergency(isRetry = false) {
    if (systemState === 'EMERGENCY' || isRouting) return;
    
    const startBtn = document.getElementById('start-btn');
    if(startBtn) startBtn.style.display = 'none';
    
    const retryBtn = document.getElementById('retry-btn');
    if(retryBtn) retryBtn.style.display = 'none';
    
    const vignette = document.getElementById('vignette');
    if (!smartCityEnabled && vignette) vignette.style.display = 'block';
    
    startTime = Date.now();
    timerInterval = setInterval(() => {
        const diff = Date.now() - startTime;
        const mins = Math.floor(diff / 60000);
        const secs = Math.floor((diff % 60000) / 1000);
        const ms = Math.floor((diff % 1000) / 10);
        const tDisp = document.getElementById('timer-display');
        if(tDisp) tDisp.innerText = `${mins.toString().padStart(2,'0')}:${secs.toString().padStart(2,'0')}.${ms.toString().padStart(2,'0')}`;
    }, 50);

    let startPos, crashSite;

    if (isRetry && lastStart && lastEnd) {
        startPos = lastStart;
        crashSite = lastEnd;
        heroMarker.setLatLng([startPos.lat, startPos.lng]);
    } else {
        startPos = { lat: heroMarker.getLatLng().lat, lng: heroMarker.getLatLng().lng };
        crashSite = await getValidRoadPoint();
        if(!crashSite || !crashSite.lat) crashSite = { lat: startPos.lat + 0.005, lng: startPos.lng + 0.005 };
        
        lastStart = startPos;
        lastEnd = crashSite;
    }

    systemState = 'EMERGENCY';
    cameraLocked = true;
    const recenter = document.getElementById('recenter-btn');
    if(recenter) recenter.style.display = 'none';
    
    if(crashMarker) map.removeLayer(crashMarker);
    crashMarker = L.marker([crashSite.lat, crashSite.lng], {
        icon: crashIcon,
        pane: 'crashPane' 
    }).addTo(map);
    
    const heroEl = document.querySelector('.hero-marker');
    if(heroEl) heroEl.classList.add('hero-els');
    
    showToast(isRetry ? "🔄 RETRYING SCENARIO" : "🚨 EMERGENCY CALL");
    updateHUDStatus("RESPONDING CODE 3", isRetry ? "REPLAY MODE" : "EMERGENCY ROUTING");
    
    await calculateRoute(startPos, crashSite, true).catch(e => {
        console.log("Emergency Route Failed, Retrying...");
        showToast("ROUTE FAILED - RETRYING...");
        updateHUDStatus("CONNECTION ERROR", "RETRYING...");
        setTimeout(() => triggerEmergency(isRetry), 1000);
    });
}

function clearSystem() {
    intersections.forEach(i => i.destroy());
    intersections = [];
    if(crashMarker) map.removeLayer(crashMarker);
    
    // SAFETY CHECKS
    const heroEl = document.querySelector('.hero-marker');
    if (heroEl) {
        heroEl.classList.remove('hero-els');
        heroEl.classList.remove('hero-stopped');
    }
    const hud = document.getElementById('hud');
    if(hud) hud.classList.remove('mission-complete');
    
    // NUCLEAR CLEAR
    routeLayerGroup.clearLayers();
    vehicleLayerGroup.clearLayers();
    visualLayerGroup.clearLayers();
    currentRouteLine = null;
}

// --- ROUTING ---
async function calculateRoute(start, end, scanForLights) {
    if(isRouting) return;
    isRouting = true;
    
    if(scanForLights) showToast("CALCULATING ROUTE...");
    
    const osrmUrl = `http://127.0.0.1:5000/route/v1/driving/${start.lng},${start.lat};${end.lng},${end.lat}?overview=full&geometries=geojson`;
    const data = await fetchJSON(osrmUrl);
    
    if (!data) {
        showToast("CONNECTION FAILED - RETRYING");
        isRouting = false;
        setTimeout(() => calculateRoute(start, end, scanForLights), 2000); 
        return;
    }

    const rawCoords = data.routes[0].geometry.coordinates;
    const cleanCoords = rawCoords.filter(c => isValidCoord(c[1], c[0]));

    let totalDist = 0;

    routePath = cleanCoords.map((c, i) => {
        const lat = c[1]; const lng = c[0];
        let seg = 0;
        if(i > 0) seg = getDistance(cleanCoords[i-1][1], cleanCoords[i-1][0], lat, lng);
        totalDist += seg;
        return { lat, lng, totalDist };
    });
    
    heroState.dist = 0;
    heroState.speed = 0; 
    heroState.currentIndex = 0;
    
    routeLayerGroup.clearLayers();
    currentRouteLine = L.polyline(routePath.map(p=>[p.lat, p.lng]), {
        color: 'white', opacity: scanForLights ? 0.3 : 0, weight: 8, pane: 'routePane'
    }).addTo(routeLayerGroup);

    if (scanForLights) {
        // Fix: Clear previous intersections to ensure full route scan
        intersections.forEach(i => i.destroy());
        intersections = [];
        showToast("SYNCING TRAFFIC NET...");
        await fetchDeepIntersectionData(cleanCoords);
    }
    isRouting = false;
}

async function fetchDeepIntersectionData(routeCoords) {
    let minLat=90, maxLat=-90, minLng=180, maxLng=-180;
    routeCoords.forEach(c => {
        minLat=Math.min(minLat, c[1]); maxLat=Math.max(maxLat, c[1]);
        minLng=Math.min(minLng, c[0]); maxLng=Math.max(maxLng, c[0]);
    });

    const query = `[out:json][timeout:150];(node["highway"="traffic_signals"](${minLat-0.002},${minLng-0.002},${maxLat+0.002},${maxLng+0.002});)->.signals;.signals out;way(bn.signals);out geom;`;
    const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`;
    
    const osmData = await fetchJSON(url);
    if (!osmData) return;

    const waysByNode = {};
    osmData.elements.forEach(el => {
        if (el.type === 'way') {
            el.nodes.forEach(nid => {
                if (!waysByNode[nid]) waysByNode[nid] = [];
                waysByNode[nid].push(el);
            });
        }
    });

    osmData.elements.forEach(el => {
        if (el.type === 'node') {
            if (intersections.find(i => i.id === el.id)) return;

            // Deduplication
            let duplicate = false;
            intersections.forEach(ex => {
                if (getDistance(ex.lat, ex.lng, el.lat, el.lon) < 60) duplicate = true; 
            });
            if (duplicate) return;

            let bestIdx = -1, minD = Infinity;
            routePath.forEach((p, i) => {
                const d = getDistance(el.lat, el.lon, p.lat, p.lng);
                if(d < minD) { minD = d; bestIdx = i; }
            });

            if (minD < CONFIG.scanRadius) {
                if (bestIdx < heroState.currentIndex) return;

                let crossName = null;
                let crossGeom = [];
                const ways = waysByNode[el.id] || [];
                const crossWay = ways.find(w => !w.tags?.name?.includes("O'Connor") && !w.tags?.name?.includes("Elgin"));

                if (crossWay) {
                    crossName = crossWay.tags?.name?.toUpperCase();
                    crossGeom = crossWay.geometry.map(g => [g.lat, g.lon]);
                }

                intersections.push(new Intersection({
                    id: el.id, name: crossName,
                    lat: routePath[bestIdx].lat, lng: routePath[bestIdx].lng,
                    pathIndex: bestIdx, crossRoadGeom: crossGeom
                }));
            }
        }
    });
    intersections.sort((a,b) => a.pathIndex - b.pathIndex);
}


// --- MAIN LOOP ---
function loop(now) {
    if (!lastTime) lastTime = now;
    const dt = Math.min((now - lastTime) / 1000, 0.1); 
    lastTime = now;

    if (!routePath || routePath.length < 2) {
        requestAnimationFrame(loop);
        return; 
    }

    if (cameraLocked) {
        let targetCam = [heroState.lat, heroState.lng];
        if (heroState.speed > 5) {
            // Look ahead by distance (20m) instead of fixed index to prevent camera circling/jitter
            let leadIdx = heroState.currentIndex;
            const targetDist = routePath[heroState.currentIndex].totalDist + 20;
            while(leadIdx < routePath.length - 1 && routePath[leadIdx].totalDist < targetDist) {
                leadIdx++;
            }
            
            const bearing = getBearing({lat:heroState.lat, lng:heroState.lng}, routePath[leadIdx]);
            const leadPos = destinationPoint(heroState.lat, heroState.lng, 80, bearing);
            targetCam = [leadPos.lat, leadPos.lng];
        }
        map.setView(targetCam, map.getZoom(), { animate: false });
        map.setView([heroState.lat, heroState.lng], map.getZoom(), { animate: false });
    }

    const totalLen = routePath[routePath.length-1].totalDist;
    const distRem = totalLen - heroState.dist;

    if (distRem < 15) {
        if (systemState === 'EMERGENCY') {
            systemState = 'ARRIVED';
            showToast("UNIT ON SCENE");
            updateHUDStatus("MISSION COMPLETE", "STANDING BY");
            
            const heroEl = document.querySelector('.hero-marker');
            if (heroEl) {
                heroEl.classList.remove('hero-els');
                heroEl.classList.remove('hero-stopped');
            }
            
            const hud = document.getElementById('hud');
            if(hud) hud.classList.add('mission-complete');
            
            clearInterval(timerInterval); 
            const retryBtn = document.getElementById('retry-btn');
            if(retryBtn) retryBtn.style.display = 'block';
            
            setTimeout(startRoaming, 8000); 
        } else {
            startRoaming(); 
        }
    } else {
        let targetSpeed = CONFIG.roamSpeed;
        
        if (systemState === 'EMERGENCY') {
            if (smartCityEnabled) {
                targetSpeed = CONFIG.ambSpeedHigh;
            } else {
                targetSpeed = CONFIG.ambSpeedHigh; 
                let nearestInt = null; let minDist = Infinity;
                intersections.forEach(i => {
                    if (i.pathIndex > heroState.currentIndex) {
                        const d = routePath[i.pathIndex].totalDist - heroState.dist;
                        if (d > 0 && d < minDist) { minDist = d; nearestInt = i; }
                    }
                });

                // STOP AT RED LIGHTS (System OFF)
                if (nearestInt && minDist < CONFIG.stopLineDist + 5) {
                    targetSpeed = 0; 
                    if (heroState.speed < 2) targetSpeed = 0; 
                }
            }
        }

        // Add "Stuck" Effect
        const heroEl = document.querySelector('.hero-marker');
        if (heroEl) {
            if (systemState === 'EMERGENCY' && heroState.speed < 1 && targetSpeed === 0) {
                heroEl.classList.add('hero-stopped');
            } else {
                heroEl.classList.remove('hero-stopped');
            }
        }

        // Fix: Speed oscillation
        if (Math.abs(heroState.speed - targetSpeed) < 0.5) {
            heroState.speed = targetSpeed;
        } else if (heroState.speed < targetSpeed) heroState.speed += CONFIG.ambAccel * dt;
        else heroState.speed -= CONFIG.ambAccel * 2 * dt; 
        
        heroState.dist += heroState.speed * dt;
    }

    if (heroState.dist >= totalLen) heroState.dist = totalLen - 0.1;

    const pos = getPosFromDist(heroState.dist);
    if(pos) {
        heroState.lat = pos.lat; heroState.lng = pos.lng; heroState.currentIndex = pos.index;
        heroMarker.setLatLng([pos.lat, pos.lng]);
        if (systemState === 'EMERGENCY') runAIScan();
    }

    intersections.forEach(i => i.update(dt, heroState.currentIndex));
    updateSpeed(Math.round(heroState.speed * 3.6));
    requestAnimationFrame(loop);
}

function runAIScan() {
    let target = null;
    let minTime = Infinity;

    if (!intersections || intersections.length === 0 || !routePath[heroState.currentIndex]) return;

    intersections.forEach(i => {
        if (i.pathIndex > heroState.currentIndex && routePath[i.pathIndex]) {
            const dist = routePath[i.pathIndex].totalDist - routePath[heroState.currentIndex].totalDist;
            const currentSpeed = Math.max(1, heroState.speed);
            const eta = dist / currentSpeed; 
            
            if (eta < CONFIG.lookAheadTime && i.state !== 'GREEN_WAVE') {
            if (eta < CONFIG.lookAheadTime && i.state !== 'GREEN') {
                i.triggerGreenWave();
                if (eta < minTime) { minTime = eta; target = i; }
            }
        }
    });

    if (target) {
        updateHUDStatus("APPROACHING: " + (target.name || "INTERSECTION"), `ETA: ${minTime.toFixed(1)}s`);
        target.triggerGreenWave();
    } else {
        updateHUDStatus("GREEN WAVE ACTIVE", "ROUTE CLEAR");
    }
}

// UI Functions
function updateHUDStatus(main, sub) { 
    const t = document.getElementById('hud-top');
    const s = document.getElementById('scan-target');
    if(t) t.innerText = sub;
    if(s) s.innerText = main; 
}
function updateSpeed(val) { 
    const el = document.getElementById('speed-value');
    if(el) el.innerText = val; 
}

function showToast(msg) {
    if(!CONFIG.debug && msg !== "ON SCENE") return;
    const c = document.getElementById('toast-container');
    if(!c) return;
    const e = document.createElement('div');
    e.innerText = msg;
    e.style.cssText = "background:rgba(0,0,0,0.8); color:#0f0; padding:10px 15px; border-left:4px solid #0f0; font-family:monospace; margin-top:5px; animation:fadeIn 0.3s; box-shadow:0 2px 10px rgba(0,0,0,0.5);";
    c.appendChild(e);
    setTimeout(() => { e.style.opacity='0'; setTimeout(()=>e.remove(),500); }, 3000);
}

window.toggleSystem = () => {
    smartCityEnabled = !smartCityEnabled;
    const label = document.getElementById('toggle-text');
    if(label) {
        label.innerText = smartCityEnabled ? "SMART CITY: ON" : "SMART CITY: OFF";
        label.style.color = smartCityEnabled ? "#0f0" : "#f00";
    }
    if(!smartCityEnabled && systemState === 'EMERGENCY') {
        const v = document.getElementById('vignette');
        if(v) v.style.display = 'block';
        intersections.forEach(i => { i.state='RED'; i.updateVisuals('RED'); });
    } else {
        const v = document.getElementById('vignette');
        if(v) v.style.display = 'none';
    }
};

window.recenterCamera = () => {
    cameraLocked = true;
    const btn = document.getElementById('recenter-btn');
    if(btn) btn.style.display = 'none';
};

window.triggerGreenWave = (id) => {
    const target = intersections.find(i => i.id === id);
    if(target) target.triggerGreenWave();
};

// Injection
document.body.insertAdjacentHTML('beforeend', `
<div id="vignette"></div>
<div id="controls">
    <div id="timer-display">00:00.00</div>
    <div>
        <span id="toggle-text" class="toggle-label" style="color:#0f0">SMART CITY: ON</span>
        <label class="switch">
            <input type="checkbox" checked onchange="toggleSystem()">
            <span class="slider"></span>
        </label>
    </div>
    <div class="btn-group">
        <button id="start-btn" class="action-btn" onclick="triggerEmergency(false)">START RUN</button>
        <button id="retry-btn" class="action-btn" onclick="triggerEmergency(true)">RETRY ROUTE</button>
    </div>
</div>
<button id="recenter-btn" onclick="recenterCamera()">📍 RE-CENTER</button>
<div id="hud">
    <div class="hud-row"><span class="hud-label">SYSTEM:</span><span class="hud-val hud-active" id="hud-top">LIVE OSM GEOMETRY</span></div>
    <hr style="border:0; border-top:1px solid #333; margin:8px 0;">
    <div style="font-size:16px; font-weight:bold; color:#ffff00" id="scan-target">INITIALIZING...</div>
</div>
<div id="speed-gauge"><div id="speed-value">0</div><div id="speed-unit">KM/H</div></div>
<div id="toast-container"></div>
`);

startRoaming();
requestAnimationFrame(loop);