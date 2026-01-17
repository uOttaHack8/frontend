# frontend

What if the route changes?
--> Point to HUD
--> System pulls the ambulance's live navigation data
    --> If the driver turns left unexpectedly, the OSRM API recalculates the path in 50ms 
    --> The Green Wave switches to the new street instantly. We're demoing 1 route today, but the architecture is dynamic