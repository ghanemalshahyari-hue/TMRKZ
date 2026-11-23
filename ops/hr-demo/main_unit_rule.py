#!/usr/bin/env python3
"""The main unit as the HR data tells it (owner, 16 Nov 2026), applied to the demo Oracle HR already built (ADR-057).

The owner's rule for the real HR source:
  * a MAIN unit is the one whose MAIN_UNIT_ID points to its own ID (MAIN_UNIT_ID = ID); a unit below it points up to it;
  * the unit's NAME never decides («قيادة», «مديرية», «إدارة» are functional labels);
  * the flag column MAIN_UNIT_FLAG carries no meaning (one default value on nearly every row);
  * UTP_ID is a unit type, not the parent; the parent comes from the ID path UNIT_PATH («\\1\\2\\3»), as TNQL's own sync reads it.

The demo was built the earlier way (TNQL's builder): MAIN_UNIT_ID held the parent, the flag marked the agreed main units (level 6)
and UNIT_PATH held names. This converts it in place, once, keeping the same tree and the same main units:
  UNIT_PATH      → the ID path from the root («\\100000\\100001\\…\\ID»)
  MAIN_UNIT_ID   → the unit's main unit: itself on a main unit, the nearest main unit above it otherwise, empty above every main unit
  MAIN_UNIT_FLAG → a meaningless default (1), 0 on about one row in a hundred, as in the source
People keep their records (ORG_UNIT_FULL_PATH stays the name path, MAIN_ORG_UNT_ID was already their main unit).
Running it again changes nothing. The rows as they were are saved first to .generated/units-before-main-rule.csv.

Run it the way up.sh runs the builder; the TMRKZ network is isolated, so the driver comes from .generated/wheels:
  docker run --rm --network tmrkz_internal -v "<ops/hr-demo>:/w" -w /w python:3.12-slim \\
    sh -c "pip install -q --no-index --find-links .generated/wheels oracledb==4.0.2 && python main_unit_rule.py [--check]"
"""
import argparse
import csv
import os
import sys

from build_oracle_hr import connect, load_env

HERE = os.path.dirname(os.path.abspath(__file__))
SAVED = os.path.join(HERE, '.generated', 'units-before-main-rule.csv')
SEP = '\\'


def id_path_parent(path):
    parts = [p for p in (path or '').split(SEP) if p.strip()]
    return int(parts[-2]) if len(parts) >= 2 else None


def meaningless_flag(uid):
    return 0 if uid % 97 == 0 else 1


def shape(units):
    """(parent of each unit, the main units) from the rows, whichever shape they are in."""
    converted = all((u['UNIT_PATH'] or '').startswith(SEP) for u in units.values())
    if converted:
        parent = {i: id_path_parent(u['UNIT_PATH']) for i, u in units.items()}
        mains = {i for i, u in units.items() if u['MAIN_UNIT_ID'] == i}
    else:
        parent = {i: u['MAIN_UNIT_ID'] for i, u in units.items()}
        mains = {i for i, u in units.items() if u['MAIN_UNIT_FLAG'] == 1}
    return converted, parent, mains


def target(units, parent, mains):
    out = {}
    for i in units:
        chain, cur, seen = [], i, set()
        while cur is not None and cur not in seen:
            seen.add(cur)
            chain.append(cur)
            cur = parent.get(cur)
        main = next((c for c in chain if c in mains), None)      # self first, then up
        out[i] = {'UNIT_PATH': SEP + SEP.join(str(c) for c in reversed(chain)), 'MAIN_UNIT_ID': main,
                  'MAIN_UNIT_FLAG': meaningless_flag(i)}
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--check', action='store_true', help='report only, change nothing')
    a = ap.parse_args()
    env = load_env()
    conn = connect(env, env['ORACLE_HR_SCHEMA'], env['ORACLE_HR_SCHEMA_PASSWORD'])
    cur = conn.cursor()
    cur.execute('SELECT ID, MAIN_UNIT_ID, UNIT_PATH, MAIN_UNIT_FLAG, UNT_LEVEL FROM HR_UNITS_T')
    units = {r[0]: {'ID': r[0], 'MAIN_UNIT_ID': r[1], 'UNIT_PATH': r[2], 'MAIN_UNIT_FLAG': r[3], 'UNT_LEVEL': r[4]} for r in cur.fetchall()}
    converted, parent, mains = shape(units)
    want = target(units, parent, mains)
    changes = [(i, w) for i, w in want.items()
               if (units[i]['UNIT_PATH'], units[i]['MAIN_UNIT_ID'], units[i]['MAIN_UNIT_FLAG']) != (w['UNIT_PATH'], w['MAIN_UNIT_ID'], w['MAIN_UNIT_FLAG'])]
    levels = sorted({units[m]['UNT_LEVEL'] for m in mains})
    print(f'[main-unit] {len(units)} units, {len(mains)} main units (levels {levels}), shape: {"ID path" if converted else "earlier (parent in MAIN_UNIT_ID)"}')
    print(f'[main-unit] rows to change: {len(changes)}')
    if a.check or not changes:
        return
    if not converted and not os.path.exists(SAVED):
        with open(SAVED, 'w', newline='', encoding='utf-8') as f:
            w = csv.writer(f)
            w.writerow(['ID', 'MAIN_UNIT_ID', 'UNIT_PATH', 'MAIN_UNIT_FLAG'])
            for u in units.values():
                w.writerow([u['ID'], u['MAIN_UNIT_ID'], u['UNIT_PATH'], u['MAIN_UNIT_FLAG']])
        print(f'[main-unit] rows as they were saved to {os.path.relpath(SAVED, HERE)}')
    cur.executemany('UPDATE HR_UNITS_T SET UNIT_PATH = :p, MAIN_UNIT_ID = :m, MAIN_UNIT_FLAG = :f WHERE ID = :i',
                    [{'p': w['UNIT_PATH'], 'm': w['MAIN_UNIT_ID'], 'f': w['MAIN_UNIT_FLAG'], 'i': i} for i, w in changes])
    # the same tree and the same main units, read back the new way
    cur.execute('SELECT ID, MAIN_UNIT_ID, UNIT_PATH, MAIN_UNIT_FLAG, UNT_LEVEL FROM HR_UNITS_T')
    after = {r[0]: {'ID': r[0], 'MAIN_UNIT_ID': r[1], 'UNIT_PATH': r[2], 'MAIN_UNIT_FLAG': r[3], 'UNT_LEVEL': r[4]} for r in cur.fetchall()}
    ok, parent2, mains2 = shape(after)
    if not ok or parent2 != parent or mains2 != mains:
        conn.rollback()
        sys.exit('[main-unit] the tree or the main units would change; nothing written')
    conn.commit()
    print(f'[main-unit] done: parent from UNIT_PATH, main unit = MAIN_UNIT_ID = ID on {len(mains2)} units, flag without meaning')


if __name__ == '__main__':
    main()
