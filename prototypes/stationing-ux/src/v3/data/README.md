# Prototype data — provenance

## `road-names.json`

- **What:** named carriageways (motorway … residential) for the prototype's illustrative area
  (lon 55.19–55.46, lat 25.07–25.33): Arabic name, English name, road class and geometry. There are 13,687 segments,
  94% of them with Arabic names.
- **Source:** the local Protomaps basemap PMTiles used by MOVER (`uae.pmtiles`, Protomaps Basemap 4.14.9, roads layer at
  zoom 14). The file was read only; its SHA-256 is recorded inside the JSON (`sourceSha256`).
- **Licence:** ODbL 1.0, © OpenStreetMap contributors; Protomaps. The attribution is shown on the map.
  - Share-alike applies to derived databases that are used publicly.
- **Authority:** **NON-AUTHORITATIVE** community names.
  - The official names (Abu Dhabi ITC NRN, FGIC NSDI, Onwani) are not used: their licence is not published or is
    restricted. See `docs/STATIONING_MODEL_V3_AR.md` §10.
- **Rebuild:**
  `python -I prototypes/stationing-ux/tools/extract_road_names.py <uae.pmtiles> prototypes/stationing-ux/src/v3/data/road-names.json`
- **For the prototype only.** It is not part of the application or of any map package.
