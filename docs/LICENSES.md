# MOVER — Component and licence register

Full resolved lists: [`sbom/backend-runtime-dependencies.txt`](sbom/backend-runtime-dependencies.txt) (134 runtime
artifacts from `mvn dependency:list`) and [`sbom/frontend-production-packages.txt`](sbom/frontend-production-packages.txt).
Verify licences of the exact installed versions before production approval.

## Runtime components

| Component | Version | Licence | Use |
|---|---|---|---|
| PostgreSQL (image `postgis/postgis:17-3.5-alpine`) | 17.11 | PostgreSQL Licence | Database; `btree_gist` contrib extension |
| PostGIS (same image) | 3.5.7 | GPL-2.0-or-later (a separate database extension; TMRKZ calls it through SQL) | Site boundaries, spatial index, validity, transformation |
| GEOS / PROJ (same image) | 3.14.1 / 9.8.1 | LGPL-2.1 / MIT | Geometry operations; coordinate transformations (network disabled) |
| Eclipse Temurin JRE (image) | 25.0.1_8 | GPL-2.0 with Classpath Exception | Java runtime |
| nginx (image `nginx:1.28.3-alpine`) | 1.28.3 | BSD-2-Clause | Web entry point and reverse proxy |
| Alpine Linux (base layers) | 3.2x | Various (mostly MIT/GPL) | Container base |
| Spring Boot / Spring Framework | 4.0.9 / 7.0.x | Apache-2.0 | Application framework |
| Flowable engine | 8.0.0 | Apache-2.0 | BPMN execution |
| MyBatis (via Flowable) | 3.5.19 | Apache-2.0 | Flowable persistence |
| Flyway (community) | 11.14.1 | Apache-2.0 | Schema migrations |
| PostgreSQL JDBC driver | 42.7.14 | BSD-2-Clause | Database access |
| Oracle JDBC thin driver `com.oracle.database.jdbc:ojdbc10` | 19.27.0.0 | Oracle Free Use Terms and Conditions (FUTC) | Read-only HR views |
| Nimbus JOSE + JWT `com.nimbusds:nimbus-jose-jwt` | 10.3 | Apache-2.0 | Verifying OpenID Connect ID tokens |
| Keycloak (image `quay.io/keycloak/keycloak`) | 26.7.5 | Apache-2.0 | Identity provider (OIDC, LDAP federation) |
| OpenFGA (image `openfga/openfga`) | 1.8.16 | Apache-2.0 | Authorisation decisions (co-decider, ADR-018) |
| Digital Signature Service (`eu.europa.ec.joinup.sd-dss`: dss-jades, dss-validation, dss-token, …) | 6.5.1 | LGPL-2.1 | Certificate signature and seal of approval documents, validation (ADR-020) |
| Bouncy Castle (`bcprov`, `bcpkix`, `bcutil` jdk18on) | 1.86 | MIT | Cryptography used by DSS |
| jose4j | 0.9.7 | Apache-2.0 | JSON Web Signature used by DSS JAdES |
| OpenLDAP (image `osixia/openldap`, test environment only) | 1.5.0 | OpenLDAP Public License; image MIT | Fictional directory for acceptance tests |
| Jackson 2 / Jackson 3 | 2.21.7 / 3.1.7 | Apache-2.0 | JSON |
| Apache Tomcat (embedded) | 11.0.27 | Apache-2.0 | HTTP server |
| Micrometer + Prometheus registry | 1.16.8 | Apache-2.0 | Local metrics |
| Spring Security Crypto | 7.0.8 | Apache-2.0 | BCrypt password hashing |
| React / React DOM | 19.3.1 | MIT | User interface |
| Leaflet | 1.9.4 | BSD-2-Clause (`assets/leaflet-license.txt`) | Map rendering |
| Leaflet-Geoman Free `@geoman-io/leaflet-geoman-free` | 2.20.2 | MIT | Drawing and vertex editing of site boundaries (free features only; loaded on demand) |
| Geoman dependencies: lodash, @turf/* (7.4.0), polyclip-ts, splaytree-ts, robust-predicates, tinyqueue, quickselect, tslib | see SBOM | MIT; splaytree-ts BSD-3-Clause; robust-predicates Unlicense; tinyqueue/quickselect ISC; tslib 0BSD | Geometry helpers used by Geoman |
| Noto Sans Arabic | — | SIL OFL 1.1 (`FONT-LICENSE.txt`) | Arabic typeface, served locally |
| MapLibre GL JS `maplibre-gl` | 6.15.0 | BSD-3-Clause | Offline vector map for Stationing V3 (decision 5, 4 Nov 2026); module `frontend/src/components/map/maplibre`, not yet used by any page. Built-in Arabic shaping and bidi (no right-to-left plugin); label glyphs drawn from the local Noto Sans Arabic file via the style's `font-faces` (no glyph server) |
| MapLibre dependencies: @maplibre/maplibre-gl-style-spec 26.5.1, @maplibre/geojson-vt 6.3.0, @maplibre/vt-pbf 4.3.3, @maplibre/mlt 1.3.0, @mapbox/tiny-sdf 2.3.0, @mapbox/vector-tile 3.0.0, @mapbox/point-geometry 1.1.0, @mapbox/unitbezier 1.0.0, @mapbox/jsonlint-lines-primitives 2.0.3, bidi-js 1.1.0, earcut 3.2.4, gl-matrix 3.4.4, kdbush 4.1.0, pbf 5.1.2, potpack 2.1.0, murmurhash-js 1.0.0, quickselect, tinyqueue, fflate 0.8.3, json-stringify-pretty-compact 4.0.0, minimist 1.2.8, protocol-buffers-schema 3.6.1, resolve-protobuf-schema 2.1.0, require-from-string 2.0.2 | see `frontend/package-lock.json` | ISC (style-spec, geojson-vt, point-geometry, earcut, kdbush, potpack, quickselect, tinyqueue); BSD-2-Clause (tiny-sdf, unitbezier); BSD-3-Clause (vector-tile, pbf); MIT (vt-pbf, bidi-js, gl-matrix, murmurhash-js, fflate, jsonlint-lines-primitives, json-stringify-pretty-compact, minimist, protocol-buffers-schema, resolve-protobuf-schema, require-from-string); MIT OR Apache-2.0 (mlt) | Libraries bundled by MapLibre; bidi-js implements the Unicode bidirectional algorithm MapLibre uses |
| PMTiles `pmtiles` | 4.5.0 | BSD-3-Clause | Reads local PMTiles archives with HTTP range requests (`pmtiles://`) |
| UAE vector basemap (`map-data/basemap/uae.pmtiles`, git-ignored; copy of MOVER's, SHA-256 `17de2d52…3028f`) | Protomaps Basemap 4.14.9 (OSM replication 2026-06-25) | ODbL 1.0 — © OpenStreetMap contributors; Protomaps | Street background and road names of the offline MapLibre map; shown with «أسماء الطرق من OpenStreetMap وليست أسماء رسمية». Not yet packaged in a release |
| Copernicus DEM GLO-30 terrain (source tiles and derived slope/hillshade in `map-data/terrain/glo30/`, git-ignored; package record `map-packages/terrain-glo30-2026.11/`) | instance COP-DEM-GLO-30-F, 28 tiles N22–N26 × E051–E056 (retrieved 2026-10-04); processing `tmrkz-terrain-1.0.0`; slope product sha256 `9a91d9af…2682` | Licence for the use of the Copernicus WorldDEM-30 (free; checked against the official PDF on 2026-11-04, sha256 `9cd37d37…51bd`) | Slope analysis (Stationing terrain rule input) and hillshade (display only). A DSM, not a bare-earth DTM; no FGIC data. Derived products and the map attribution carry Article 6(b): "produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved"; unmodified tiles carry 6(a); every distribution notice adds 6(c): "The organisations in charge of the Copernicus programme by law or by delegation do not incur any liability for any use of the Copernicus WorldDEM-30" (`LICENSE-NOTICE.txt`) |
| Regional basemap (`map-packages/regional-basemap-2026.10`) | 2026.10 | ODbL 1.0 — © OpenStreetMap contributors, OpenMapTiles, OpenFreeMap | Illustrative background; attribution shown on the map |

## Build-time only (not shipped in runtime images)

| Component | Version | Licence |
|---|---|---|
| Apache Maven (image) | 3.9.16 | Apache-2.0 |
| Node.js (image) | 24.18.1 | MIT |
| Vite / @vitejs/plugin-react | 7.3.7 / 5.2.0 | MIT |
| TypeScript | 5.9.3 | Apache-2.0 |
| Vitest | 3.2.7 | MIT |
| JUnit 5, AssertJ (tests) | via Spring Boot BOM | EPL-2.0 / Apache-2.0 |
| playwright-core (browser acceptance tests, `tests/acceptance`) | 1.64.1 | Apache-2.0 — drives the locally installed Microsoft Edge; no browser download |

## Data and content

All organisations, people, facilities, boundaries and requests in the demo dataset are fictional. The basemap is an
illustrative extract (water, land cover, major roads) and is not a navigation map or an authoritative boundary source.
