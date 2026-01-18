const mqtt = require('mqtt');
const config = require('./config');

const client = mqtt.connect(config.mqttUrl, config.mqttOptions);

let state = {
    active: false,
    path: [],
    dist: 0,
    speed: 0,
    currentIndex: 0,
    lat: 0, lng: 0,
    maxSpeed: 60
};

const ACCEL = 15.0;
const MAX_SPEED = 60; // m/s

client.on('connect', () => {
    console.log('Ambulance Agent Connected');
    client.subscribe(config.topics.ctlAmbInit);
    client.subscribe(config.topics.ctlAmbSpeed);
});

client.on('message', (topic, message) => {
    if (topic === config.topics.ctlAmbInit) {
        const data = JSON.parse(message.toString());
        startRun(data.path, data.speedLimit);
    } else if (topic === config.topics.ctlAmbSpeed) {
        const data = JSON.parse(message.toString());
        state.maxSpeed = data.speed;
    }
});

function startRun(routePath, speedLimit) {
    console.log('Starting Run...');
    state.path = routePath;
    state.dist = 0;
    state.speed = 0;
    state.currentIndex = 0;
    state.active = true;
    state.maxSpeed = speedLimit || MAX_SPEED;
    state.lat = routePath[0].lat;
    state.lng = routePath[0].lng;
}

// physics loop 20hz
setInterval(() => {
    if (!state.active || state.path.length < 2) return;

    const dt = 0.05; 
    
    // simple physics accelerate to max
    if (state.speed < state.maxSpeed) state.speed += ACCEL * dt;
    else if (state.speed > state.maxSpeed) state.speed -= ACCEL * dt;
    
    state.dist += state.speed * dt;
    const totalLen = state.path[state.path.length-1].totalDist;

    if (state.dist >= totalLen) {
        state.dist = totalLen;
        state.speed = 0;
        state.active = false;
        console.log('Arrived at destination');
    }

    // interpolate position
    for(let i=0; i<state.path.length-1; i++) {
        if(state.dist >= state.path[i].totalDist && state.dist <= state.path[i+1].totalDist) {
            const r = (state.dist - state.path[i].totalDist) / (state.path[i+1].totalDist - state.path[i].totalDist);
            state.lat = state.path[i].lat + (state.path[i+1].lat - state.path[i].lat)*r;
            state.lng = state.path[i].lng + (state.path[i+1].lng - state.path[i].lng)*r;
            state.currentIndex = i;
            break;
        }
    }

    let status = state.active ? 'MOVING' : 'ARRIVED';
    // If active but stopped/stopping due to command, we are clearing an intersection
    if (state.active && state.maxSpeed === 0 && state.speed < 1) status = 'CLEARING';

    // publish telemetry
    client.publish(config.topics.dataAmb, JSON.stringify({
        lat: state.lat,
        lng: state.lng,
        speed: state.speed,
        index: state.currentIndex,
        status: status
    }));

}, 50);