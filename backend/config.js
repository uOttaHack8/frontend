module.exports = {
    // Solace MQTT connection
    // ensure this matches your Solace broker details
    mqttUrl: 'mqtt://localhost:1883', 
    mqttOptions: {
        username: 'default', 
        password: 'default'
    },
    
    // topic hierarchy
    topics: {
        reqStart: 'gw/req/start',       // UI to signal agent start request
        resRoute: 'gw/res/route',       // signal agent to UI route geometry
        resIntersections: 'gw/res/intersections', // signal agent to UI incremental intersections
        ctlAmbInit: 'gw/ctl/amb/init',  // signal agent to ambulance agent path data
        ctlAmbSpeed: 'gw/ctl/amb/speed', // signal agent to ambulance agent speed control
        dataAmb: 'gw/data/amb',         // ambulance agent to UI signal live telemetry
        ctlSignal: 'gw/ctl/signal',     // signal agent to UI light color change
        dataVolume: 'gw/data/volume',   // volume agent to UI signal traffic data
        cfgSmart: 'gw/cfg/smart',       // UI to agents toggle smart city
        cfgTraffic: 'gw/cfg/traffic',   // UI to volume agent toggle max traffic
        err: 'gw/err'                   // Backend errors to UI
    },

    // simulation config
    // point these to your local OSRM or public APIs
    osrmUrl: 'http://127.0.0.1:5000',
    overpassUrl: 'https://overpass-api.de/api/interpreter'
};