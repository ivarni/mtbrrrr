local retained = { path = true, track = true, bridleway = true, cycleway = true, footway = true }

-- MTB route relations name trails whose ways carry no name (e.g. "Pionéren"). Race courses
-- ("Terrengsykkelrittet 2016", state=temporary cups) overlap real trails and change every few
-- ways, which makes labels too long to fit and stops ways merging, so they are skipped.
function relation_scan_function()
  if Find("type") ~= "route" or Find("route") ~= "mtb" then return end
  if Find("state") == "temporary" or Find("name"):match("%d%d%d%d") then return end
  Accept()
end

-- Every MTB route the way is on, sorted and joined: a trail that is also on an old
-- race course shows both names, the same way every build, instead of a random one.
local function route_names()
  local names, seen = {}, {}
  while true do
    local rel = NextRelation()
    if not rel then break end
    local n = FindInRelation("name")
    if n ~= "" and not seen[n] then seen[n] = true; names[#names + 1] = n end
  end
  table.sort(names)
  return table.concat(names, " / ")
end

function way_function()
  local highway = Find("highway")
  if not retained[highway] then return end

  local name = Find("name")
  local mtbname = Find("mtb:name")
  local grade = Find("mtb:scale")
  local mtbclass = Find("class:bicycle:mtb")
  local routename = route_names()
  Layer("trails", false)
  -- The z6-10 overview only draws grade and mtbclass. Dropping the rest there lets
  -- combine_below merge touching ways into few features, keeping overview tiles small.
  -- Below z14, touching ways with equal attributes merge into one line long enough for a
  -- name label. No per-way attribute, then: tilemaker compares every attribute, even ones
  -- not written at that zoom. The way ID is the feature id (include_ids) instead.
  Attribute("grade", grade)
  Attribute("mtbclass", mtbclass)
  Attribute("name", name, 11)
  Attribute("mtbname", mtbname, 11)
  Attribute("routename", routename, 11)
  Attribute("highway", highway, 11)
  Attribute("tracktype", Find("tracktype"), 11)
  -- Graded and named ways form the z6-10 overview; the rest join at z13.
  MinZoom((name ~= "" or mtbname ~= "" or routename ~= "" or grade ~= "" or mtbclass ~= "") and 6 or 13)
end
