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
