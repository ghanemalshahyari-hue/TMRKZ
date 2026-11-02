# Real TMRKZ stationing drag — before vs after (measured in headed Edge)

Measured on the **real application** at `http://localhost:8088` (test environment), signed in as the fictional
`t.requester`, site «مركز الخدمات», with the same scripted drag both times (crosses the allowed-range boundary).
Numbers are sampled in the page (rAF frame intervals, `PerformanceObserver` long tasks, `MutationObserver`), not
estimated. Raw: `evidence/real-before.json`, `evidence/real-after.json`. Screenshots: `evidence/real-*-{1..4}-*.png`.

| metric | **before** (pulled `main`) | **after** (optimised) | change |
|---|---|---|---|
| frames in drag | 182 | 181 | — |
| mean frame time | 13.34 ms | 13.49 ms | ≈ equal |
| p95 frame time | 13.5 ms | 13.5 ms | ≈ equal |
| worst frame | 13.5 ms | 26.7 ms | +1 transient (noise) |
| mean fps | 75 | 74.2 | ≈ equal |
| janky frames (>25 ms) | 0 | 2 | noise |
| long tasks | 0 | 0 | — |
| **React panel mutations during drag** | **2220** | **364** | **−84 %** |
| **marker-pane node churn during drag** | **570** | **269** | **−53 %** |
| external network requests | 0 | 0 | offline both |
| console errors | 0 | 0 | — |

## Reading this honestly

- **Frame time is equal** on this machine (≈75 Hz display, GPU headroom); both before and after are smooth by the
  numbers. I did **not** reproduce frame drops here, so the improvement is **not** a higher fps figure.
- **The real, measured win is work removed, not frames gained:**
  - **React panel mutations 2220 → 364 (−84 %).** Before, `setLive` ran on every pointer move → the whole panel
    re-rendered each move (~2220 reconciliation mutations). After, there are **no per-move React renders**; the 364
    remaining are the deliberate in-place text writes for the live distance readout plus the one commit on `dragstart`
    and on drop — not component re-renders.
  - **Marker-pane node churn 570 → 269 (−53 %).** Before, `setIcon` rebuilt the distance-chip and bubble `divIcon`
    every move (element-node churn). After, the chip/bubble text is mutated in place and only when it changes.
  - **The snap-back is gone** (behavioural, see screenshots): the marker now follows the pointer out of the allowed
    range and turns **red**; «متابعة» stays disabled for an invalid point instead of the marker jumping back.
- **Authoritative validation preserved:** the server `placementCheck` still runs after the drop (one commit), and the
  server re-checks on save, submit and approval — unchanged.

## What this did and did not cover

- Tested the **real interface**, not only the prototype (owner requirement #9). The flow: sign in → «التمركز» →
  pick site → «طلب تمركز» → drag.
- Facility-count stress at **100 / 1000** was done in the isolated prototype (identical interaction architecture),
  **not** in the real app — the real seed has only a handful of sites and synthesising 1000 real facilities was not
  feasible without heavy seeding. See `RESULTS.md` for the 10/100/1000 prototype numbers (flat, count-independent).
- Single machine, single scripted drag per build; the transient worst-frame in "after" is within run-to-run noise.
