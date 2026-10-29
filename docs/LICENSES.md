# MOVER — Component and licence register

Full resolved lists: [`sbom/backend-runtime-dependencies.txt`](sbom/backend-runtime-dependencies.txt) (134 runtime
artifacts from `mvn dependency:list`) and [`sbom/frontend-production-packages.txt`](sbom/frontend-production-packages.txt).
Verify licences of the exact installed versions before production approval.

## Runtime components

| Component | Version | Licence | Use |
|---|---|---|---|
| PostgreSQL (image `postgres:17.11-alpine`) | 17.11 | PostgreSQL Licence | Database; `btree_gist` contrib extension |
| Eclipse Temurin JRE (image) | 25.0.1_8 | GPL-2.0 with Classpath Exception | Java runtime |
| nginx (image `nginx:1.28.3-alpine`) | 1.28.3 | BSD-2-Clause | Web entry point and reverse proxy |
| Alpine Linux (base layers) | 3.2x | Various (mostly MIT/GPL) | Container base |
| Spring Boot / Spring Framework | 4.0.9 / 7.0.x | Apache-2.0 | Application framework |
| Flowable engine | 8.0.0 | Apache-2.0 | BPMN execution |
| MyBatis (via Flowable) | 3.5.19 | Apache-2.0 | Flowable persistence |
| Flyway (community) | 11.14.1 | Apache-2.0 | Schema migrations |
| PostgreSQL JDBC driver | 42.7.14 | BSD-2-Clause | Database access |
| Jackson 2 / Jackson 3 | 2.21.7 / 3.1.7 | Apache-2.0 | JSON |
| Apache Tomcat (embedded) | 11.0.27 | Apache-2.0 | HTTP server |
| Micrometer + Prometheus registry | 1.16.8 | Apache-2.0 | Local metrics |
| Spring Security Crypto | 7.0.8 | Apache-2.0 | BCrypt password hashing |
| React / React DOM | 19.3.1 | MIT | User interface |
| Leaflet | 1.9.4 | BSD-2-Clause (`assets/leaflet-license.txt`) | Map rendering |
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

## Data and content

All organisations, people, facilities, boundaries and requests in the demo dataset are fictional. The basemap is an
illustrative extract (water, land cover, major roads) and is not a navigation map or an authoritative boundary source.
