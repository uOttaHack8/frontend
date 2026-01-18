// MQTT setup
const MQTT_URL = 'ws://localhost:8000';
const TOPICS = {
    reqStart: 'gw/req/start',
    resRoute: 'gw/res/route',
    resIntersections: 'gw/res/intersections',
    dataAmb: 'gw/data/amb',
    ctlSignal: 'gw/ctl/signal',
    dataVolume: 'gw/data/volume',
    cfgSmart: 'gw/cfg/smart',
    cfgTraffic: 'gw/cfg/traffic',
    err: 'gw/err'
};

let mqttClient = null;

try {
    mqttClient = mqtt.connect(MQTT_URL);
    mqttClient.on('connect', () => {
        console.log("Connected to Solace/MQTT");
        mqttClient.subscribe(TOPICS.resRoute);
        mqttClient.subscribe(TOPICS.resIntersections);
        mqttClient.subscribe(TOPICS.dataAmb);
        mqttClient.subscribe(TOPICS.ctlSignal);
        mqttClient.subscribe(TOPICS.dataVolume);
        mqttClient.subscribe(TOPICS.err);
    });

    mqttClient.on('message', (topic, msg) => {
        const data = JSON.parse(msg.toString());
        if (topic === TOPICS.resRoute) handleRouteResponse(data);
        if (topic === TOPICS.resIntersections) handleIntersectionUpdate(data);
        if (topic === TOPICS.dataAmb) handleAmbulanceUpdate(data);
        if (topic === TOPICS.ctlSignal) handleSignalUpdate(data);
        if (topic === TOPICS.dataVolume) handleVolumeUpdate(data);
        if (topic === TOPICS.err) handleError(data);
    });
} catch (e) {
    console.error("MQTT Error. Make sure mqtt.min.js is included.", e);
}

// Configuration
const CONFIG = {
    debug: true,
    
    // speeds in m/s
    // 1 m/s equals 3.6 km/h
    roamSpeed: 13.9,      // approx 50 km/h cruising
    ambSpeedHigh: 33.3,   // approx 120 km/h emergency
    ambSpeedLow: 10,      // approx 36 km/h smart city off
    ambAccel: 15.0,       // acceleration factor
    
    // Traffic
    carSpeed: 14,         
    carClearSpeed: 30,    
    carSpacing: 22,       
    bumperDist: 14,       
    maxCarsPerQueue: 5,   
    
    // Smart system
    greenHoldTime: 25000, 
    lookAheadTime: 10,    // trigger lights 10s away based on current speed
    scanRadius: 20,      
    stopLineDist: 30      
};

// Global state
let smartCityEnabled = true; 
let maxTrafficEnabled = false;
let systemState = 'IDLE';    // system states
let startTime = 0;
let timerInterval = null;
let previousRunTime = null;
let routeHistory = [];
let lastTime = 0;

// camera
let cameraLocked = true;

// replay memory
let lastStart = null;
let lastEnd = null;

// data
let intersections = [];
let routePath = [];

// hero state
let heroState = { 
    dist: 0, 
    speed: 0, 
    lat: 45.4215, 
    lng: -75.6974, 
    currentIndex: 0 
};

// visual handles
let currentRouteLine = null;
let beepMarker = null;
let crashMarker = null;

// Map setup

const SAFE_START = { lat: 45.4215, lng: -75.6974 }; 

const map = L.map('map', { 
    zoomControl: true, 
    renderer: L.canvas() 
}).setView([SAFE_START.lat, SAFE_START.lng], 17); // initial zoom

L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; CartoDB',
    maxZoom: 21,
    subdomains: 'abcd'
}).addTo(map);

// Camera interaction
map.on('dragstart', () => {
    // allow unlocking camera in any state
    if (cameraLocked) {
        cameraLocked = false;
        const btn = document.getElementById('recenter-btn');
        if (btn) btn.style.display = 'block';
    }
});

// Custom panes
map.createPane('routePane'); map.getPane('routePane').style.zIndex = 400;
map.createPane('vehiclePane'); map.getPane('vehiclePane').style.zIndex = 600;
map.createPane('crashPane'); map.getPane('crashPane').style.zIndex = 2000;
map.createPane('heroPane'); map.getPane('heroPane').style.zIndex = 3000;

// Layer groups
const routeLayerGroup = L.layerGroup().addTo(map);
const vehicleLayerGroup = L.layerGroup().addTo(map);
const visualLayerGroup = L.layerGroup().addTo(map); 

// Assets
const heroIcon = L.icon({ 
    iconUrl: 'icons/ambulance.png', 
    iconSize: [60, 60], iconAnchor: [30, 30], className: 'hero-marker'
});

const crashIcon = L.divIcon({ 
    className: 'crash-marker', 
    html: '<div class="crash-inner">💥</div>', iconSize: [80, 80], iconAnchor: [40, 60] 
});

const beepIcon = L.divIcon({
    className: 'beep-marker',
    iconSize: [60, 60], iconAnchor: [30, 30]
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


function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3;
    const a = 0.5 - Math.cos((lat2-lat1)*Math.PI/180)/2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*(1-Math.cos((lon2-lon1)*Math.PI/180))/2;
    return R * 2 * Math.asin(Math.sqrt(a));
}

function destinationPoint(lat, lng, dist, bearing) {
    const R = 6371e3;
    const lat1Rad = lat * Math.PI / 180;
    const lng1Rad = lng * Math.PI / 180;
    const lat2Rad = Math.asin(Math.sin(lat1Rad) * Math.cos(dist / R) + Math.cos(lat1Rad) * Math.sin(dist / R) * Math.cos(bearing));
    const lng2Rad = lng1Rad + Math.atan2(Math.sin(bearing) * Math.sin(dist / R) * Math.cos(lat1Rad), Math.cos(dist / R) - Math.sin(lat1Rad) * Math.sin(lat2Rad));
    return { lat: lat2Rad * 180 / Math.PI, lng: lng2Rad * 180 / Math.PI };
}

function getBearing(start, end) {
    const lat1Rad = start.lat * Math.PI / 180;
    const lat2Rad = end.lat * Math.PI / 180;
    const deltaLng = (end.lng - start.lng) * Math.PI / 180;
    const y = Math.sin(deltaLng) * Math.cos(lat2Rad);
    const x = Math.cos(lat1Rad) * Math.sin(lat2Rad) - Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(deltaLng);
    return Math.atan2(y, x) * 180 / Math.PI; 
}

async function getValidRoadPoint() {
    const bounds = { minLat: 45.4100, maxLat: 45.4300, minLng: -75.7100, maxLng: -75.6800 };
    for(let i=0; i<5; i++) {
        // simplified for demo just pick random points in bounding box
        return { 
            lat: bounds.minLat + Math.random() * (bounds.maxLat - bounds.minLat),
            lng: bounds.minLng + Math.random() * (bounds.maxLng - bounds.minLng)
        };
    }
    return { lat: SAFE_START.lat + 0.005, lng: SAFE_START.lng + 0.005 }; 
}

// Traffic classes

class Vehicle {
    constructor(lat, lng, type, node) {
        this.lat = lat; this.lng = lng; this.type = type; this.node = node;
        this.marker = L.circleMarker([lat, lng], { ...trafficStyle, pane: 'vehiclePane' }).addTo(vehicleLayerGroup);
        this.speed = 0; this.state = 'IDLE'; 
        this.pathQueue = []; this.pulledOver = false; this.resuming = false;
        this.originalPath = []; this.reactionDelay = Math.random() * 800; this.resumeTime = 0;
    }

    setPath(points, speed) {
        if (!points || !points.length) return;
        this.pathQueue = points; this.speed = speed; this.state = 'DRIVING';
    }

    update(dt, ambIndex, vehiclesAhead) {
        if (this.state === 'CLEARED') return;

        // Cleanup if far behind
        const distToAmb = getDistance(this.lat, this.lng, heroState.lat, heroState.lng);
        if (distToAmb > 150 && heroState.currentIndex > this.node.pathIndex) {
            this.destroy();
            return;
        }

        // collision check
        let maxSpeed = CONFIG.carClearSpeed;
        if (vehiclesAhead) {
            vehiclesAhead.forEach(v => {
                if (v === this) return;
                const dist = getDistance(this.lat, this.lng, v.lat, v.lng);
                if (dist < 30) {
                    if (dist < CONFIG.bumperDist) { maxSpeed = 0; }
                    else if (dist < CONFIG.bumperDist * 2) maxSpeed = Math.min(maxSpeed, v.speed);
                }
            });
        }

        // emergency logic
        if (systemState === 'EMERGENCY') {
            
            // cross traffic
            if (this.type.includes('cross')) {
                const distToCenter = getDistance(this.lat, this.lng, this.node.lat, this.node.lng);
                if (smartCityEnabled && this.node.state === 'GREEN_WAVE') {
                    if (distToCenter < CONFIG.stopLineDist && distToCenter > 6) { this.speed = 0; this.updateStyle('STOP'); }
                    else if (distToCenter <= 6) { this.speed = CONFIG.carClearSpeed; this.updateStyle('PANIC'); }
                } else {
                    // const distToAmb = getDistance(this.lat, this.lng, heroState.lat, heroState.lng);
                    if (distToAmb < 30 && distToCenter < 15) { this.speed = 0; this.updateStyle('STOP'); }
                }
            }

            // same road
            if (this.type === 'blocker') {
                const isAhead = (this.node.pathIndex > ambIndex);
                
                // Pull over if ambulance is approaching
                if (isAhead && distToAmb < 250 && !this.pulledOver && !this.resuming) {
                    setTimeout(() => this.initiatePullOver(), this.reactionDelay);
                } 
                // Resume if ambulance has passed (approx 15m buffer)
                else if (!isAhead && this.pulledOver && !this.resuming && distToAmb > 15) {
                    if (this.resumeTime === 0) this.resumeTime = Date.now() + 2000; // 2s delay
                    if (Date.now() > this.resumeTime && (this.node.state === 'GREEN' || smartCityEnabled)) {
                        this.resuming = true;
                        this.resumeDriving();
                    }
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
        const pullPos = destinationPoint(this.lat, this.lng, 4.5, bearing + 90); 
        this.pathQueue = [[pullPos.lat, pullPos.lng]];
        this.speed = 8;
    }

    resumeDriving() {
        this.pulledOver = false; this.resuming = false; this.state = 'DRIVING';
        this.updateStyle('NORMAL');
        let mergePt = this.originalPath.length ? {lat:this.originalPath[0][0], lng:this.originalPath[0][1]} : {lat:this.node.lat, lng:this.node.lng};
        this.pathQueue = [[mergePt.lat, mergePt.lng], ...this.originalPath];
        this.speed = CONFIG.carSpeed;
        this.resumeTime = 0;
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
        this.volume = 0.5; // default volume
        this.lightMarker = null;
        this.mainPoly = null;
        this.crossPoly = null;

        // visuals
        // Calculate bearing for signal orientation
        let bearing = 0;
        if (routePath.length > 1) {
            const p1 = routePath[Math.max(0, this.pathIndex - 1)];
            const p2 = routePath[Math.min(routePath.length - 1, this.pathIndex + 1)];
            if (p1 && p2) bearing = getBearing(p1, p2);
        }
        
        // Offset signal to the right side of the road (8 meters)
        const signalPos = destinationPoint(this.lat, this.lng, 8, bearing + 90);

        // signal
        this.lightMarker = L.marker([signalPos.lat, signalPos.lng], { 
            icon: createSignalIcon('#ff0000', bearing), opacity: 1 
        }).addTo(visualLayerGroup);
        
        // road highlights
        const geomPoints = [];
        let idx = this.pathIndex;
        let backDist = 0;
        let fwdDist = 0;
        
        // Trace back 40m and forward 20m to highlight the full intersection road
        let startIdx = Math.max(0, idx - 5); 
        let endIdx = Math.min(routePath.length - 1, idx + 3);

        for(let i = startIdx; i <= endIdx; i++) {
             geomPoints.push([routePath[i].lat, routePath[i].lng]);
        }
        if(geomPoints.length > 1) {
             this.mainPoly = L.polyline(geomPoints, { color: '#ff0000', weight: 14, opacity: 0.4 }).addTo(visualLayerGroup);
        }
        
        // Cross Poly
        if (this.crossRoadGeom && this.crossRoadGeom.length > 1) {
             this.crossPoly = L.polyline(this.crossRoadGeom, { color: '#ff0000', weight: 14, opacity: 0.4 }).addTo(visualLayerGroup);
        }

        this.updateVisuals('RED');
        
        this.vehicles = [];
        this.spawnBlockersOnPath();
        if (this.crossRoadGeom && this.crossRoadGeom.length > 1) this.spawnCrossQueue();
    }

    updateVisuals(state) {
        const mainColor = (state === 'GREEN') ? '#00ff00' : '#ff0000';
        const crossColor = (state === 'GREEN') ? '#ff0000' : '#00ff00';
        
        if (this.lightMarker) {
            const el = this.lightMarker.getElement();
            if(el) {
                const arrow = el.querySelector('div');
                if(arrow) {
                    arrow.style.color = mainColor;
                    arrow.style.textShadow = `0 0 10px ${mainColor}`;
                }
                el.style.borderColor = mainColor;
                el.style.boxShadow = `0 0 15px ${mainColor}`;
            }
        }
        if (this.mainPoly) this.mainPoly.setStyle({ color: mainColor, opacity: 0.4 });
        if (this.crossPoly) this.crossPoly.setStyle({ color: crossColor, opacity: 0.4 });
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
        if(this.lightMarker) map.removeLayer(this.lightMarker);
        if(this.mainPoly) map.removeLayer(this.mainPoly);
        if(this.crossPoly) map.removeLayer(this.crossPoly);
    }
}

// Main system

async function startRoaming() {
    clearSystem();
    systemState = 'ROAMING';
    updateHUDStatus("UNIT 42: PATROLLING", "LIVE OSM GEOMETRY");
    
    // ui safety checks
    const startBtn = document.getElementById('start-btn');
    if(startBtn) startBtn.style.display = 'block';
    
    const hist = document.getElementById('history-container');
    if(hist) hist.style.display = routeHistory.length > 0 ? 'block' : 'none';
    
    const vignette = document.getElementById('vignette');
    if(vignette) vignette.style.display = 'none';
    
    const recenter = document.getElementById('recenter-btn');
    if(recenter) recenter.style.display = 'none';
    
    const timer = document.getElementById('timer-display');
    
    clearInterval(timerInterval);
    cameraLocked = true;

    const p1 = {lat: heroMarker.getLatLng().lat, lng: heroMarker.getLatLng().lng};
    const p2 = await getValidRoadPoint();
    
    const loader = document.getElementById('traffic-loader');
    if(loader) loader.style.display = 'flex';

    mqttClient.publish(TOPICS.reqStart, JSON.stringify({
        start: p1,
        end: p2,
        mode: 'ROAMING'
    }));
}

async function triggerEmergency(isRetry = false) {
    if (systemState === 'EMERGENCY') return;
    
    const startBtn = document.getElementById('start-btn');
    if(startBtn) startBtn.style.display = 'none';
    
    const hist = document.getElementById('history-container');
    if(hist) hist.style.display = 'none';

    const prevRun = document.getElementById('prev-run');
    if(prevRun) prevRun.style.display = 'block';
    
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
    
    showToast(isRetry ? "RETRYING SCENARIO" : "EMERGENCY CALL");
    updateHUDStatus("RESPONDING CODE 3", isRetry ? "REPLAY MODE" : "EMERGENCY ROUTING");
    
    const loader = document.getElementById('traffic-loader');
    if(loader) loader.style.display = 'flex';

    // publish start request to backend
    mqttClient.publish(TOPICS.reqStart, JSON.stringify({
        start: startPos,
        end: crashSite,
        mode: 'EMERGENCY'
    }));

    // start timer
    if(timerInterval) clearInterval(timerInterval);
    startTime = Date.now();
    timerInterval = setInterval(() => {
        const diff = Date.now() - startTime;
        const mins = Math.floor(diff / 60000);
        const secs = Math.floor((diff % 60000) / 1000);
        const ms = Math.floor((diff % 1000) / 10);
        const tDisp = document.getElementById('timer-display');
        if(tDisp) tDisp.innerText = `${mins.toString().padStart(2,'0')}:${secs.toString().padStart(2,'0')}.${ms.toString().padStart(2,'0')}`;
    }, 50);
}

function clearSystem() {
    intersections.forEach(i => i.destroy());
    intersections = [];
    if(crashMarker) map.removeLayer(crashMarker);
    if(beepMarker) map.removeLayer(beepMarker); beepMarker = null;
    
    // safety checks
    const heroEl = document.querySelector('.hero-marker');
    if (heroEl) {
        heroEl.classList.remove('hero-els');
        heroEl.classList.remove('hero-stopped');
    }
    const hud = document.getElementById('hud');
    if(hud) hud.classList.remove('mission-complete');
    
    // nuclear clear
    routeLayerGroup.clearLayers();
    vehicleLayerGroup.clearLayers();
    visualLayerGroup.clearLayers();
    currentRouteLine = null;
}

// MQTT handlers
function handleRouteResponse(data) {
    // draw route
    const loader = document.getElementById('traffic-loader');
    if(loader) loader.style.display = 'none';

    routePath = data.path;
    routeLayerGroup.clearLayers();
    
    // only draw route line if in emergency mode
    if (systemState === 'EMERGENCY') {
        currentRouteLine = L.polyline(data.path.map(p=>[p.lat, p.lng]), {
            color: 'white', opacity: 0.3, weight: 8, pane: 'routePane'
        }).addTo(routeLayerGroup);
    }

    // clear intersections
    intersections.forEach(i => i.destroy());
    intersections = [];
    
    // initial batch (usually empty now due to chunking)
    if (systemState === 'EMERGENCY' && data.intersections) {
        data.intersections.forEach(i => intersections.push(new Intersection(i)));
    }
}

function handleIntersectionUpdate(data) {
    // only spawn intersections and vehicles if in emergency mode
    if (systemState === 'EMERGENCY') {
        data.intersections.forEach(i => {
            if (!intersections.find(ex => ex.id === i.id)) {
                intersections.push(new Intersection(i));
            }
        });
    }
}

function handleAmbulanceUpdate(data) {
    heroState.lat = data.lat;
    heroState.lng = data.lng;
    heroState.speed = data.speed;
    heroMarker.setLatLng([data.lat, data.lng]);
    
    if (cameraLocked) {
        map.setView([data.lat, data.lng], map.getZoom(), { animate: false });
    }
    
    updateSpeed(Math.round(data.speed * 1.8));

    // Visuals for clearing intersection (Red Pulse)
    const heroEl = document.querySelector('.hero-marker');
    if (heroEl) {
        if (data.status === 'CLEARING') heroEl.classList.add('hero-stopped');
        else heroEl.classList.remove('hero-stopped');
    }

    if (data.status === 'ARRIVED' && systemState === 'ROAMING') {
        setTimeout(() => startRoaming(), 1000);
    } else if (data.status === 'ARRIVED' && systemState === 'EMERGENCY') {
        clearInterval(timerInterval);
        systemState = 'ARRIVED';
        
        // save time
        const finalTime = document.getElementById('timer-display').innerText;
        routeHistory.push({
            id: routeHistory.length + 1,
            start: lastStart,
            end: lastEnd,
            time: finalTime,
            smart: smartCityEnabled
        });
        updateHistoryUI();
        
        const prevRun = document.getElementById('prev-run');
        if(prevRun) { prevRun.innerText = "PREV: " + finalTime; prevRun.style.display = 'block'; }

        showToast("MISSION COMPLETE");
        vehicleLayerGroup.clearLayers(); // clear vehicles immediately
        updateHUDStatus("MISSION COMPLETE", "RETURNING TO PATROL");
        setTimeout(() => {
            startRoaming();
        }, 5000);
    }
}

function handleSignalUpdate(data) {
    const target = intersections.find(i => i.id === data.id);
    if (target) {
        target.state = data.state;
        target.updateVisuals(data.state);
        updateHUDStatus("GREEN WAVE ACTIVE", "INTERSECTION CLEARED");
    }
}

function handleVolumeUpdate(data) {
    const target = intersections.find(i => i.id === data.id);
    if (target) {
        target.volume = data.volume;
    }
    updateTrafficStats();
}

function updateTrafficStats() {
    if (intersections.length === 0) return;
    const total = intersections.reduce((sum, i) => sum + (i.volume || 0), 0);
    const avg = (total / intersections.length * 100).toFixed(0);
    const el = document.getElementById('traffic-stat');
    if (el) el.innerText = `AVG TRAFFIC: ${avg}%`;
}

function handleError(data) {
    const loader = document.getElementById('traffic-loader');
    if(loader) loader.style.display = 'none';

    if (data.status === 504) {
        // Extremely clear 504 error
        const c = document.getElementById('toast-container');
        if(c) {
            const e = document.createElement('div');
            e.innerText = "⚠️ SERVER TIMEOUT (504) - MAP DATA UNAVAILABLE";
            e.style.cssText = "background:rgba(255,0,0,0.9); color:white; padding:15px 20px; border-left:5px solid white; font-family:monospace; margin-top:5px; animation:fadeIn 0.3s; box-shadow:0 0 20px red; font-weight:bold; font-size:16px;";
            c.appendChild(e);
            setTimeout(() => { e.style.opacity='0'; setTimeout(()=>e.remove(),500); }, 8000);
        }
    }
}

// Render loop visuals only
function loop(now) {
    if (!lastTime) lastTime = now;
    const dt = Math.min((now - lastTime) / 1000, 0.1);
    lastTime = now;

    intersections.forEach(i => i.update(dt, heroState.currentIndex));
    requestAnimationFrame(loop);
}

// UI functions
function updateHUDStatus(main, sub) { 
    const t = document.getElementById('hud-top');
    const s = document.getElementById('scan-target');
    if(t && sub) t.innerText = sub;
    if(s && main) s.innerText = main; 
}

let lastDisplayedSpeed = 0;
function updateSpeed(val) {
    // Smoothing to prevent flickering (e.g. 49/51)
    if (Math.abs(val - lastDisplayedSpeed) > 1) {
        lastDisplayedSpeed = val;
        const el = document.getElementById('speed-value');
        if(el) el.innerText = val;
    }
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
    mqttClient.publish(TOPICS.cfgSmart, JSON.stringify({
        enabled: !smartCityEnabled
    }));
    smartCityEnabled = !smartCityEnabled;
    const label = document.getElementById('toggle-text');
    if(label) {
        label.innerText = smartCityEnabled ? "SMART CITY: ON" : "SMART CITY: OFF";
        label.style.color = smartCityEnabled ? "#0f0" : "#f00";
    }
};

window.toggleTraffic = () => {
    mqttClient.publish(TOPICS.cfgTraffic, JSON.stringify({
        enabled: !maxTrafficEnabled
    }));
    maxTrafficEnabled = !maxTrafficEnabled;
    const label = document.getElementById('traffic-text');
    if(label) {
        label.innerText = maxTrafficEnabled ? "MAX TRAFFIC: ON" : "MAX TRAFFIC: OFF";
        label.style.color = maxTrafficEnabled ? "#ff0000" : "#ccc";
    }
};

window.recenterCamera = () => {
    cameraLocked = true;
    const btn = document.getElementById('recenter-btn');
    if(btn) btn.style.display = 'none';
};

function updateHistoryUI() {
    const select = document.getElementById('history-select');
    if(!select) return;
    select.innerHTML = '<option value="-1">-- SELECT PAST ROUTE --</option>';
    routeHistory.forEach((r, i) => {
        const mode = r.smart ? "ON" : "OFF";
        const opt = document.createElement('option');
        opt.value = i;
        opt.innerText = `Run ${r.id}: ${r.time} (Smart: ${mode})`;
        select.appendChild(opt);
    });
}

window.restoreHistoryRoute = (index) => {
    if(index < 0) return;
    const r = routeHistory[index];
    if(!r) return;

    const nextState = !smartCityEnabled;
    if(confirm(`Smart City is currently ${smartCityEnabled ? "ON" : "OFF"}.\nDo you want to turn it ${nextState ? "ON" : "OFF"}?`)) {
        toggleSystem();
        const chk = document.querySelector('.switch input');
        if(chk) chk.checked = smartCityEnabled;
    }

    lastStart = r.start;
    lastEnd = r.end;
    triggerEmergency(true);
    
    // Reset dropdown so it can be clicked again
    const select = document.getElementById('history-select');
    if(select) select.value = "-1";
};

// Injection
document.body.insertAdjacentHTML('beforeend', `
<div id="vignette"></div>
<div id="loading-overlay"><div class="spinner"></div>SYNCING TRAFFIC DATA...</div>
<div id="mini-loader"><div class="mini-spinner"></div>LOADING TRAFFIC...</div>
<div id="traffic-loader"><div class="mini-spinner"></div>FETCHING TRAFFIC DATA...</div>
<div id="controls">
    <div id="timer-display">00:00.00</div>
    <div id="prev-run">PREV: --:--.--</div>
    <div>
        <span id="toggle-text" class="toggle-label" style="color:#0f0">SMART CITY: ON</span>
        <label class="switch">
            <input type="checkbox" checked onchange="toggleSystem()">
            <span class="slider"></span>
        </label>
    </div>
    <div>
        <span id="traffic-text" class="toggle-label" style="color:#ccc">MAX TRAFFIC: OFF</span>
        <label class="switch">
            <input type="checkbox" onchange="toggleTraffic()">
            <span class="slider"></span>
        </label>
    </div>
    <div class="btn-group" style="flex-direction:column; width:100%">
        <button id="start-btn" class="action-btn" onclick="triggerEmergency(false)">START RUN</button>
        <div id="history-container" style="display:none; width:100%; margin-top:10px;">
            <button id="retry-btn" class="action-btn" style="width:100%; margin-bottom:10px;" onclick="triggerEmergency(true)">REDO LAST ROUTE</button>
            <select id="history-select" onchange="restoreHistoryRoute(this.value)" style="width:100%; padding:10px; background:rgba(0,0,0,0.8); color:white; border:1px solid #555; border-radius:5px; font-family:'Consolas', monospace; cursor:pointer;">
                <option value="-1">-- HISTORY --</option>
            </select>
        </div>
    </div>
</div>
<button id="recenter-btn" onclick="recenterCamera()">RE-CENTER</button>
<div id="hud">
    <div class="hud-row"><span class="hud-label">SYSTEM:</span><span class="hud-val hud-active" id="hud-top">LIVE OSM GEOMETRY</span></div>
    <div class="hud-row"><span class="hud-label">DENSITY:</span><span class="hud-val" id="traffic-stat">AVG TRAFFIC: 0%</span></div>
    <hr style="border:0; border-top:1px solid #333; margin:8px 0;">
    <div style="font-size:16px; font-weight:bold; color:#ffff00" id="scan-target">INITIALIZING...</div>
</div>
<div id="speed-gauge"><div id="speed-value">0</div><div id="speed-unit">KM/H</div></div>
<div id="toast-container"></div>
`);

startRoaming();
requestAnimationFrame(loop);