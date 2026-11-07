# «الانحدار» inside the shapes being placed: evidence (6 Nov 2026, ADR-039)

Script: `tests/acceptance/slope-inside.mjs` (real page, headless Chrome on an Apple GPU, real sign-in, fictional unsaved
request, outside traffic refused). Results: `results.json`, 17/17.

| File | What it shows |
|---|---|
| `A-3d-on-mountain.png` | The site placed on the mountain, map zoomed out |
| `A2-3d-on-mountain-close.png` | Close up: red and orange inside the boundary, draped over the ridge |
| `B-3d-during-drag.png` | Mid-drag, pointer still down |
| `C-3d-on-plain.png` | Dropped on the plain: green |
| `D-2d-on-plain.png` | The same colours in 2D |
| `E-3d-while-drawing.png` | A new boundary being drawn: colours before it closes |
| `F-3d-deployment-area.png` | A deployment area being placed, coloured, beside the site |

## How far the colours can be trusted (measured)

`measure_colours.py` compares the native 30 m slope analysis (what the server's rules use) with the colour shown, which
is computed from the ~35 m display tiles. Read-only; run from the repository root in a container with
`ops/terrain/requirements.txt`.

**Coverage.** 28 of 30 grid cells are present; the 2 absent (N25E053, N26E052) are the recorded open-sea cells. 6,300
tiles loaded, extent 51–57 E, 22–27 N. Real slopes are present at Jebel Jais (mean 69 %), Jebel Hafeet (61 %),
Fujairah mountains (34 %), Hatta (10 %), Liwa dunes (11 %) and the Abu Dhabi coast (2 %).

**Per cell** (share of the native class, by colour shown):

| Area | Native red shown green | Native red shown orange | Native orange shown green | Cells where the display reads lower |
|---|---|---|---|---|
| Hajar, Hatta to Al Dhaid | 0.2 % | 11.3 % | 15.3 % | 67 % |
| Ras Al Khaimah mountains | 0.0 % | 4.8 % | 6.9 % | 55 % |
| Jebel Hafeet | 0.1 % | 7.2 % | 16.1 % | 66 % |

**Whole sites** (1,450 random squares of about 600 × 600 m on Hajar ground, verdict by the class with the most ground):
of 415 sites shown green, 30 (7 %) were not green natively (27 orange, 3 red), 45 % held some native red ground, 17 %
held over 10 % native red ground, and the steepest native cell inside a green site was 95 %.

**Limits.**
- The display under-reads slightly: its finer pockets are smoothed. The coloured zones and the sentence are display
  values; only the terrain panel's class is the server's.
- The sentence follows the colour with the most ground, so a mostly gentle site can read green over a steep pocket.
  (The whole-site figures above used the class with the most ground, the rule before the limits became editable.)
- Neither product can see what is narrower than about 30–60 m: a track, a small cliff or a cut wadi. GLO-30 is also a
  surface model (DSM). Green is not proof that ground is passable.
- These figures come from the local rebuild described in `docs/STATUS.md`, whose checksums differ from the committed
  records.
