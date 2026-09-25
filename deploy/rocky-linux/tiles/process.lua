local retained = { path = true, track = true, bridleway = true, cycleway = true, footway = true }

function way_function()
  local highway = Find("highway")
  if not retained[highway] then return end

  local name = Find("name")
  local grade = Find("mtb:scale")
  local mtbclass = Find("class:bicycle:mtb")
  Layer("trails", false)
  Attribute("osm_id", "osm:way/" .. Id())
  Attribute("name", name)
  Attribute("grade", grade)
  Attribute("mtbclass", mtbclass)
  Attribute("highway", highway)
  Attribute("tracktype", Find("tracktype"))
  MinZoom((name ~= "" or grade ~= "" or mtbclass ~= "") and 11 or 13)
end
