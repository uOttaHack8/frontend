# frontend

What if the route changes?
--> Point to HUD
--> System pulls the ambulance's live navigation data
    --> If the driver turns left unexpectedly, the OSRM API recalculates the path in 50ms 
    --> The Green Wave switches to the new street instantly. We're demoing 1 route today, but the architecture is dynamic
    --> The AI will recalculate based on traffic volume as well

Remember:
- During red lights, emergency vehicles must stop to clear the intersection for safety
- With smart lights / green lights, emergency vehicles can go straight though the green light, significantly
  reducing response times & saving lives