# mtbrrrr

A mountain-bike trail map for Norway, built from OpenStreetMap. It shows riders how hard each trail is and how well suited it is for riding.

## Language

**Grade**:
A trail's technical difficulty, S0–S6, from OSM `mtb:scale`. Shown to riders as "Gradering".
_Avoid_: Difficulty, level, scale

**Ungraded**:
A trail with no Grade tagged. Shown to riders as "Ugradert".
_Avoid_: Untagged, unknown

**MTB rating**:
How well a way suits mountain biking, from −3 to +3, from OSM `class:bicycle:mtb`. It is independent of Grade. Shown to riders as "Sykkelvennlighet".
_Avoid_: MTB class, mtbclass, quality

**Way type**:
What kind of way a trail is (path, track, bridleway, cycleway), from OSM `highway`, with `tracktype` grading tracks from firm (G1) to loose (G5).
_Avoid_: Surface, trail kind

**Legend**:
The panel that explains how the map draws Grade, MTB rating and Way type.
_Avoid_: Key, tegnforklaring (in code)
