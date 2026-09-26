local retained = { path = true, track = true, bridleway = true, cycleway = true, footway = true }

function way_function()
  local highway = Find("highway")
  if not retained[highway] then return end

  local name = Find("name")
  local mtbname = Find("mtb:name")
  local grade = Find("mtb:scale")
  local mtbclass = Find("class:bicycle:mtb")
  Layer("trails", false)
  -- The z6-10 overview only draws grade and mtbclass. Dropping the rest there lets
  -- combine_below merge touching ways into few features, keeping overview tiles small.
  Attribute("grade", grade)
  Attribute("mtbclass", mtbclass)
  Attribute("osm_id", "osm:way/" .. Id(), 11)
  Attribute("name", name, 11)
  Attribute("mtbname", mtbname, 11)
  Attribute("highway", highway, 11)
  Attribute("tracktype", Find("tracktype"), 11)
  -- Graded and named ways form the z6-10 overview; the rest join at z13.
  MinZoom((name ~= "" or mtbname ~= "" or grade ~= "" or mtbclass ~= "") and 6 or 13)
end
