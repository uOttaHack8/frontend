const mqtt = require('mqtt');
const axios = require('axios');
const config = require('./config');
const utils = require('./utils');

const client = mqtt.connect(config.mqttUrl, config.mqttOptions);

let intersections = [];
let routePath = [];
let smartCityEnabled = true;
let volumeData = {}; 
let currentRequestId = 0;
let clearingIntersectionId = null;
let clearingTimer = null;

client.on('connect', () => {
    console.log('Traffic Signal Agent Connected');
    client.subscribe(config.topics.reqStart);
    client.subscribe(config.topics.dataAmb);
    client.subscribe(config.topics.dataVolume);
    client.subscribe(config.topics.cfgSmart);
});

client.on('message', async (topic, message) => {
    const data = JSON.parse(message.toString());

    if (topic === config.topics.reqStart) {
        await handleRouteRequest(data);
    } 
    else if (topic === config.topics.dataAmb) {
        handleAmbulanceUpdate(data);
    }
    else if (topic === config.topics.dataVolume) {
        volumeData[data.id] = data.volume;
    }
    else if (topic === config.topics.cfgSmart) {
        smartCityEnabled = data.enabled;
        console.log(`Smart City: ${smartCityEnabled ? 'ON' : 'OFF'}`);
    }
});

async function handleRouteRequest(req) {
    console.log('Calculating Route...');
    currentRequestId++;
    const requestId = currentRequestId;
    clearingIntersectionId = null;
    if(clearingTimer) clearTimeout(clearingTimer);
    
    // OSRM call
    const osrmUrl = `${config.osrmUrl}/route/v1/driving/${req.start.lng},${req.start.lat};${req.end.lng},${req.end.lat}?overview=full&geometries=geojson`;
    try {
        const res = await axios.get(osrmUrl);
        const coords = res.data.routes[0].geometry.coordinates;
        
        // process path
        let totalDist = 0;
        routePath = coords.map((c, i) => {
            const lat = c[1]; const lng = c[0];
            let seg = 0;
            if(i > 0) seg = utils.getDistance(coords[i-1][1], coords[i-1][0], lat, lng);
            totalDist += seg;
            return { lat, lng, totalDist };
        });

        // Reset intersections
        intersections = [];

        // publish to UI draw map (path only first)
        client.publish(config.topics.resRoute, JSON.stringify({
            path: routePath,
            intersections: [] 
        }));

        // initialize ambulance with speed limit based on mode
        const speedLimit = (req.mode === 'ROAMING') ? 13.9 : 33.3; // 50km/h vs 120km/h
        client.publish(config.topics.ctlAmbInit, JSON.stringify({ path: routePath, speedLimit: speedLimit }));

        // Start scanning in chunks
        scanRouteInChunks(routePath, requestId);

    } catch (e) {
        console.error("Route Error:", e.message);
        const status = e.response ? e.response.status : 500;
        client.publish(config.topics.err, JSON.stringify({ 
            msg: e.message, 
            status: status 
        }));
    }
}

async function scanRouteInChunks(path, requestId) {
    const CHUNK_DIST = 1000; // 1km chunks
    let chunkCoords = [];
    let lastDist = 0;

    for (let i = 0; i < path.length; i++) {
        if (currentRequestId !== requestId) return; // Abort if new route started

        chunkCoords.push([path[i].lng, path[i].lat]);
        
        // If chunk is big enough or end of path
        if (path[i].totalDist - lastDist > CHUNK_DIST || i === path.length - 1) {
            await fetchIntersections(chunkCoords, requestId);
            chunkCoords = []; // Reset for next chunk
            // Overlap slightly to ensure we don't miss nodes on the boundary
            if (i < path.length - 1) chunkCoords.push([path[i].lng, path[i].lat]);
            lastDist = path[i].totalDist;
        }
    }
}

async function fetchIntersections(coords, requestId) {
    if (currentRequestId !== requestId) return;

    let minLat=90, maxLat=-90, minLng=180, maxLng=-180;
    coords.forEach(c => {
        minLat=Math.min(minLat, c[1]); maxLat=Math.max(maxLat, c[1]);
        minLng=Math.min(minLng, c[0]); maxLng=Math.max(maxLng, c[0]);
    });

    const query = `[out:json][timeout:150];(node["highway"="traffic_signals"](${minLat-0.002},${minLng-0.002},${maxLat+0.002},${maxLng+0.002});)->.signals;.signals out;way(bn.signals);out geom;`;
    const url = `${config.overpassUrl}?data=${encodeURIComponent(query)}`;

    try {
        const res = await axios.get(url);
        const elements = res.data.elements;
        const nodes = elements.filter(e => e.type === 'node');
        const ways = elements.filter(e => e.type === 'way');

        // Map ways to nodes for cross-street calculation
        const waysByNode = {};
        ways.forEach(w => {
            w.nodes.forEach(nid => {
                if (!waysByNode[nid]) waysByNode[nid] = [];
                waysByNode[nid].push(w);
            });
        });
        
        const newIntersections = [];
        nodes.forEach(node => {
            let bestIdx = -1, minD = Infinity;
            routePath.forEach((p, i) => {
                const d = utils.getDistance(node.lat, node.lon, p.lat, p.lng);
                if(d < minD) { minD = d; bestIdx = i; }
            });

            if (minD < 12) { // Stricter threshold (12m) to avoid random nearby lights
                // Deduplication: Check if we already have an intersection very close
                const isDuplicate = intersections.some(i => utils.getDistance(i.lat, i.lng, node.lat, node.lon) < 20) || newIntersections.some(i => utils.getDistance(i.lat, i.lng, node.lat, node.lon) < 20);
                if (isDuplicate) return;

                // Calculate Cross Road Geometry
                let crossGeom = [];
                const nodeWays = waysByNode[node.id] || [];
                
                // Calculate route bearing at this point to find perpendicular roads
                const p1 = routePath[Math.max(0, bestIdx-1)];
                const p2 = routePath[Math.min(routePath.length-1, bestIdx+1)];
                let routeBearing = 0;
                if (p1 && p2) routeBearing = utils.getBearing(p1, p2);

                let bestWay = null;
                let maxDiff = -1;

                nodeWays.forEach(w => {
                    if (!w.geometry) return;
                    const nIdx = w.nodes.indexOf(node.id);
                    if (nIdx > -1) {
                        // Get bearing of this way at the node
                        let wp1, wp2;
                        if (nIdx < w.geometry.length - 1) {
                            wp1 = w.geometry[nIdx]; wp2 = w.geometry[nIdx+1];
                        } else if (nIdx > 0) {
                            wp1 = w.geometry[nIdx-1]; wp2 = w.geometry[nIdx];
                        }

                        if (wp1 && wp2) {
                            const wb = utils.getBearing({lat: wp1.lat, lng: wp1.lon}, {lat: wp2.lat, lng: wp2.lon});
                            const diff = Math.abs(routeBearing - wb);
                            const diffNorm = Math.min(diff, 360 - diff);
                            // Score based on how close to 90 degrees it is
                            const score = 90 - Math.abs(90 - diffNorm); 
                            
                            if (score > maxDiff) {
                                maxDiff = score;
                                bestWay = w;
                            }
                        }
                    }
                });

                if (bestWay && maxDiff > 45) { // If it's somewhat perpendicular
                    crossGeom = bestWay.geometry.map(g => [g.lat, g.lon]);
                }

                newIntersections.push({
                    id: node.id,
                    lat: node.lat,
                    lng: node.lon,
                    pathIndex: bestIdx,
                    state: 'RED',
                    crossRoadGeom: crossGeom
                });
            }
        });
        
        if (newIntersections.length > 0) {
            intersections.push(...newIntersections);
            intersections.sort((a,b) => a.pathIndex - b.pathIndex);
            console.log(`Scanned chunk: Found ${newIntersections.length} new lights`);
            
            client.publish(config.topics.resIntersections, JSON.stringify({
                intersections: newIntersections
            }));
        }
    } catch (e) {
        console.error("Overpass Error:", e.message);
    }
}

function handleAmbulanceUpdate(amb) {
    // if (!smartCityEnabled) return; // Logic moved inside loop

    intersections.forEach(i => {
        // Guard against race conditions where routePath is updated but intersections are from prev route
        if (!routePath[i.pathIndex] || !routePath[amb.index]) return;

        if (i.pathIndex > amb.index) {
            const dist = routePath[i.pathIndex].totalDist - routePath[amb.index].totalDist;
            const speed = Math.max(1, amb.speed);
            const eta = dist / speed;

            if (smartCityEnabled) {
                // traffic volume offset high volume adds time to lookahead
                const vol = volumeData[i.id] || 0;
                const lookAhead = 10 + (vol * 5); 

                if (eta < lookAhead && i.state !== 'GREEN') {
                    i.state = 'GREEN';
                    console.log(`Triggering GREEN for ${i.id} (Vol: ${vol.toFixed(1)})`);
                    client.publish(config.topics.ctlSignal, JSON.stringify({
                        id: i.id,
                        state: 'GREEN'
                    }));
                }
            } else {
                // Smart City OFF: Stop at red lights
                // Calculate braking distance: v^2 / 2a
                const brakingDist = (speed * speed) / (2 * 15); // 15 is ACCEL constant
                
                // If we are approaching, not cleared, and not currently clearing another one
                if (dist < brakingDist + 30 && !i.cleared && clearingIntersectionId !== i.id) {
                    // Start Clearing Process
                    console.log(`Ambulance stopping for red light at ${i.id}`);
                    clearingIntersectionId = i.id;
                    
                    // Stop the ambulance
                    client.publish(config.topics.ctlAmbSpeed, JSON.stringify({ speed: 0 }));

                    // Wait 2-7 seconds then resume
                    const waitTime = 2000 + Math.random() * 5000;
                    clearingTimer = setTimeout(() => {
                        console.log(`Ambulance cleared light at ${i.id}, resuming...`);
                        i.cleared = true;
                        clearingIntersectionId = null;
                        
                        // Resume speed (Emergency max)
                        client.publish(config.topics.ctlAmbSpeed, JSON.stringify({ speed: 33.3 }));
                        
                        // Also turn it green locally so we don't stop again if logic loops
                        client.publish(config.topics.ctlSignal, JSON.stringify({
                            id: i.id,
                            state: 'GREEN'
                        }));
                    }, waitTime);
                }
            }
        }
    });
}