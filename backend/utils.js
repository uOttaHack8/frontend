module.exports = {
    getDistance: (lat1, lon1, lat2, lon2) => {
        const R = 6371e3;
        const a = 0.5 - Math.cos((lat2-lat1)*Math.PI/180)/2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*(1-Math.cos((lon2-lon1)*Math.PI/180))/2;
        return R * 2 * Math.asin(Math.sqrt(a));
    },
    getBearing: (start, end) => {
        const lat1Rad = start.lat * Math.PI / 180;
        const lat2Rad = end.lat * Math.PI / 180;
        const deltaLng = (end.lng - start.lng) * Math.PI / 180;
        const y = Math.sin(deltaLng) * Math.cos(lat2Rad);
        const x = Math.cos(lat1Rad) * Math.sin(lat2Rad) - Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(deltaLng);
        return Math.atan2(y, x) * 180 / Math.PI; 
    }
};