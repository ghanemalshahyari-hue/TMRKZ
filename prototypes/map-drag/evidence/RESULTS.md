# Measured drag performance (Edge, headed=true)

Each row = one scripted drag crossing the allowed-range boundary and an occupied zone. Numbers are measured in the page (rAF frame intervals, PerformanceObserver long tasks), not estimated.

| scene | frames | mean ms | p95 ms | worst ms | mean fps | janky>25ms | long tasks | state-updates during drag | server calls during drag | crossed out/occ |
|---|---|---|---|---|---|---|---|---|---|---|
| 10 موقع | 165 | 13.34 | 13.4 | 13.5 | 75 | 0 | 0 | 1 | 1 | ✓/✓ |
| 100 موقع | 170 | 13.34 | 13.5 | 13.7 | 75 | 0 | 0 | 1 | 1 | ✓/✓ |
| 1000 موقع | 162 | 13.34 | 13.4 | 13.6 | 75 | 0 | 0 | 1 | 1 | ✓/✓ |
| 100 موقع | 175 | 13.34 | 13.5 | 13.6 | 75 | 0 | 0 | 84 | 1 | —/✓ |
| 10 موقع | 170 | 13.34 | 13.5 | 14.3 | 75 | 0 | 0 | 1 | 1 | ✓/✓ |
| 100 موقع | 166 | 13.34 | 13.4 | 14.3 | 75 | 0 | 0 | 1 | 1 | ✓/✓ |
| 1000 موقع | 160 | 13.34 | 13.5 | 13.5 | 75 | 0 | 0 | 1 | 1 | ✓/✓ |

✓ no external network requests — fully offline.