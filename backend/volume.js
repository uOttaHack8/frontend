const mqtt = require('mqtt');
const config = require('./config');

const client = mqtt.connect(config.mqttUrl, config.mqttOptions);
let activeIntersections = [];
let maxTraffic = false;

client.on('connect', () => {
    console.log('Traffic Volume Agent Connected');
    client.subscribe(config.topics.resRoute);
    client.subscribe(config.topics.resIntersections);
    client.subscribe(config.topics.cfgTraffic);
});

client.on('message', (topic, message) => {
    if (topic === config.topics.resRoute) {
        const data = JSON.parse(message.toString());
        activeIntersections = data.intersections.map(i => i.id);
        console.log(`Monitoring ${activeIntersections.length} intersections`);
    } else if (topic === config.topics.resIntersections) {
        const data = JSON.parse(message.toString());
        const newIds = data.intersections.map(i => i.id);
        activeIntersections.push(...newIds);
        console.log(`Added ${newIds.length} intersections to monitor`);
    } else if (topic === config.topics.cfgTraffic) {
        const data = JSON.parse(message.toString());
        maxTraffic = data.enabled;
        console.log(`Max Traffic Mode: ${maxTraffic ? 'ON' : 'OFF'}`);
    }
});

// simulate traffic volume updates
setInterval(() => {
    if (activeIntersections.length === 0) return;

    activeIntersections.forEach(id => {
        // random volume between 0.0 empty and 1.0 gridlock, or forced high if maxTraffic
        const vol = maxTraffic ? 0.8 + (Math.random() * 0.2) : Math.random(); 
        client.publish(config.topics.dataVolume, JSON.stringify({
            id: id,
            volume: vol
        }));
    });
}, 2000);