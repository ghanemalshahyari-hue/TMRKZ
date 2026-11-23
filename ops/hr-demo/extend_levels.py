#!/usr/bin/env python3
"""Deeper demo levels (owner, 16 Nov 2026) for TMRKZ's demo Oracle HR (ADR-057).

Adds, below the existing levels after level 5, 4–5 new units (each under a random existing unit of levels 5–9; one that lands on
level 6 is a main unit — MAIN_UNIT_ID = ID — as every level-6 unit of the demo is), and grows each into a branch of 3–6 units per level down to level 12
or 13 (chosen at random per branch). Each level of each new branch gets 3 synthetic people, except 1–2 levels per branch left with
none on purpose. Oracle only: nobody is added to TMRKZ — a person becomes a user there only by «إضافة مستخدم» or an approved
access request (ADR-061); the next HR sync brings the units and the HR records.

Everything added carries CODE 'DX…', unit IDs from 990001 and person IDs from 990001, so --remove takes exactly it away.
Run it the way up.sh runs the builder (the demo's Oracle is reachable on the TMRKZ network only):
  docker run --rm --network tmrkz_internal -v "<ops/hr-demo>:/w" -w /w python:3.12-slim \
    sh -c "pip install -q oracledb==4.0.2 && python extend_levels.py [--seed N] [--remove]"
"""
import argparse
import datetime as dt
import random
import sys

import oracledb

from build_oracle_hr import (FAMILY, FAMILY_LATIN, FIRST, FIRST_F, JOBS, LATIN, OFFICER_GRADES, OTHER_GRADES, POSITIONS, TODAY,
                             _TR, connect, load_env)
from main_unit_rule import SEP, id_path_parent, meaningless_flag

UNIT_BASE = 990000
PERSON_BASE = 990000
MIL_BASE = 4_990_000          # the demo's own numbers are 3,000,000–3,999,999
POS_BASE = 99_000_000


def remove(cur):
    cur.execute("DELETE FROM HR_EMPLOYEES_T WHERE PRS_ID > :b", b=PERSON_BASE)
    people = cur.rowcount
    cur.execute("SELECT MAX(UNT_LEVEL) FROM HR_UNITS_T WHERE CODE LIKE 'DX%'")
    top = cur.fetchone()[0] or 0
    units = 0
    for level in range(top, 0, -1):          # deeper first: a unit's MAIN_UNIT_ID may name a DX main unit (FK_UNIT_PARENT)
        cur.execute("DELETE FROM HR_UNITS_T WHERE CODE LIKE 'DX%' AND UNT_LEVEL = :l", l=level)
        units += cur.rowcount
    return units, people


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--seed', type=int, default=None, help='repeat a run exactly (printed at the end)')
    ap.add_argument('--remove', action='store_true', help='take away everything this script added')
    ap.add_argument('--each-main', action='store_true',
                    help='4–5 new units inside the branch of EVERY main unit (added to what an earlier run made)')
    a = ap.parse_args()
    env = load_env()
    conn = connect(env, env['ORACLE_HR_SCHEMA'], env['ORACLE_HR_SCHEMA_PASSWORD'])
    cur = conn.cursor()
    if a.remove:
        units, people = remove(cur)
        conn.commit()
        print(f'[extend] removed {units} units and {people} people')
        return
    cur.execute("SELECT COUNT(*), MAX(ID) FROM HR_UNITS_T WHERE CODE LIKE 'DX%'")
    had, last_unit = cur.fetchone()
    if had and not a.each_main:
        sys.exit('[extend] the deeper levels are already there; run with --remove first, or add more with --each-main')
    cur.execute("SELECT MAX(PRS_ID) FROM HR_EMPLOYEES_T WHERE PRS_ID > :b", b=PERSON_BASE)
    last_person = cur.fetchone()[0] or PERSON_BASE

    seed = a.seed if a.seed is not None else random.SystemRandom().randint(1, 10**9)
    rnd = random.Random(seed)
    cur.execute("SELECT ID, NAME, MAIN_UNIT_ID, UNT_LEVEL, UNIT_PATH, MAIN_UNIT_FLAG, CODE FROM HR_UNITS_T WHERE STATUS = 1")
    existing = {r[0]: {'ID': r[0], 'NAME': r[1], 'MAIN_UNIT_ID': r[2], 'UNT_LEVEL': r[3], 'UNIT_PATH': r[4], 'MAIN_UNIT_FLAG': r[5],
                       'DX': (r[6] or '').startswith('DX')} for r in cur.fetchall()}
    if not all((u['UNIT_PATH'] or '').startswith(SEP) for u in existing.values()):
        sys.exit('[extend] the demo still has the earlier shape; run main_unit_rule.py first (owner, 16 Nov 2026)')
    by_id = dict(existing)
    # the parent from the ID path; a main unit is MAIN_UNIT_ID = ID, never the flag (owner, 16 Nov 2026)
    parent_of = {i: id_path_parent(u['UNIT_PATH']) for i, u in existing.items()}
    mains = {i for i, u in existing.items() if u['MAIN_UNIT_ID'] == i}
    name_path = {}

    def full_path(u):
        if u['ID'] not in name_path:
            up = by_id.get(parent_of.get(u['ID']))
            name_path[u['ID']] = (full_path(up) + ' - ' if up else '') + u['NAME']
        return name_path[u['ID']]
    anchors = [u for u in existing.values() if 5 <= u['UNT_LEVEL'] <= 9]

    units, people, report = [], [], []
    next_unit = [max(UNIT_BASE, last_unit or 0)]

    def add_unit(name, parent):
        next_unit[0] += 1
        uid = next_unit[0]
        level = parent['UNT_LEVEL'] + 1
        # level 6 is a main unit (MAIN_UNIT_ID = ID); below it, the unit points up to its main unit
        main_id = uid if level == 6 else (parent['ID'] if parent['ID'] in mains else parent['MAIN_UNIT_ID'])
        u = {'ID': uid, 'CODE': 'DX%04d' % (uid - UNIT_BASE), 'NAME': name, 'NAME_E': 'Extra unit %d' % uid, 'SHORT_NAME': name[:40],
             'MAIN_UNIT_ID': main_id, 'UNT_LEVEL': level, 'UNIT_PATH': parent['UNIT_PATH'] + SEP + str(uid), 'STATUS': 1,
             'MAIN_UNIT_FLAG': meaningless_flag(uid), 'HAS_SON': 0, 'DIRECTOR_POS_ID': None, 'UNT_ID': 'OU-%d' % uid}
        if parent['ID'] > UNIT_BASE:
            parent['HAS_SON'] = 1       # existing units are left as they are
        units.append(u)
        by_id[uid] = u
        parent_of[uid] = parent['ID']
        if main_id == uid:
            mains.add(uid)
        return u

    def main_of(u):
        return by_id.get(u['MAIN_UNIT_ID']) or u

    def add_person(unit):
        n = last_person - PERSON_BASE + len(people) + 1
        female = rnd.random() < 0.08
        first = rnd.choice(FIRST_F if female else FIRST)
        family = rnd.choice(FAMILY)
        officer = rnd.random() < 0.25
        years = rnd.randint(1, 30)
        table = OFFICER_GRADES if officer else OTHER_GRADES
        grade = table[0][0]
        for g, need in table:
            if years >= need:
                grade = g
        enlist = TODAY - dt.timedelta(days=int(years * 365.25) + rnd.randint(0, 300))
        birth = enlist - dt.timedelta(days=int((rnd.randint(18, 24) + (4 if officer else 0)) * 365.25) + rnd.randint(0, 365))
        latin = f'{LATIN.get(first) or first.translate(_TR)}.{FAMILY_LATIN[family]}'.lower().replace(' ', '')
        latin = ''.join(ch for ch in latin if ch.isascii() and (ch.isalnum() or ch == '.'))
        main = main_of(unit)
        job_index = rnd.randrange(len(JOBS))
        people.append({
            'PRS_ID': PERSON_BASE + n, 'MIL_NUMBER': str(MIL_BASE + n), 'NEW_MIL_NO': None, 'PERSON_USER_ID': f'{latin}.dx{n}',
            'FIRST_NAME': first, 'FULL_NAME': f'{first} {rnd.choice(FIRST)} {rnd.choice(FIRST)} {family}',
            'FULL_NAME_E': f'{latin} dx{n}'.replace('.', ' ').title(),
            'GRD_ID': table.index(next(x for x in table if x[0] == grade)) + (100 if officer else 200),
            'GRADE_NAME': grade, 'FULL_GRADE_NAME': grade, 'MAIN_GRADE_TYPE': 1,
            'POSITION_ID': POS_BASE + n, 'EMP_POSITION_DESC': rnd.choice(POSITIONS), 'JOB_ID': 7001 + job_index, 'JOB_NAME': JOBS[job_index],
            'ORG_UNIT_ID': unit['ID'], 'ORG_UNIT_NAME': unit['NAME'], 'ORG_UNIT_FULL_PATH': full_path(unit),
            'MAIN_ORG_UNT_ID': main['ID'], 'MAIN_ORG_UNIT_NAME': main['NAME'],
            'ANNEXATION_UNIT_ID': None, 'ANNEXATION_UNIT_NAME': None, 'ANNEXATION_DATE': None,
            'MAIN_ANNEXATION_UNIT_ID': None, 'MAIN_ANNEXATION_UNIT_NAME': None,
            'EMP_STATUS': 1, 'EMP_STATUS_DESC': 'في الخدمة', 'EMP_WORK_STATUS_DESC': 'على رأس العمل', 'EMP_UNIT_STATUS_DESC': 'ضمن الوحدة',
            'GENDER': 2 if female else 1, 'GENDER_DESC': 'أنثى' if female else 'ذكر',
            'BIRTH_DATE': birth, 'ENLISTMENT_DATE': enlist, 'END_SERVICE_DATE': None,
            'MOBILE': '05%08d' % (90_000_000 + n), 'MOBILE2': None, 'HOME_PHONE_1': None,
            'DELEGATION_START_DATE': None, 'DELEGATION_EXPECTED_END_DATE': None, 'EXTERNAL_ORG_NAME': None,
            'NATIONALITY_DESC': 'الإمارات', 'EMPLOYEE_CLASS_DESC': 'عسكري',
        })

    def subtree_of(main_id):
        kids = {}
        for u in existing.values():
            kids.setdefault(parent_of[u['ID']], []).append(u)
        out, todo = [], [main_id]
        while todo:
            uid = todo.pop()
            out.append(existing[uid])
            todo.extend(c['ID'] for c in kids.get(uid, []))
        return out

    if a.each_main:
        # every main unit's own branch: 4–5 new units under its existing (not earlier-added) units of levels 6–9
        plan = []
        for main in sorted((u for u in existing.values() if u['ID'] in mains and not u['DX']), key=lambda u: u['NAME']):
            inside = [u for u in subtree_of(main['ID']) if 6 <= u['UNT_LEVEL'] <= 9 and not u['DX']]
            plan += [(f'{main["NAME"]} · وحدة {k}', rnd.choice(inside)) for k in range(1, rnd.randint(4, 5) + 1)]
    else:
        plan = [(f'وحدة إضافية {k}', parent) for k, parent in enumerate(rnd.sample(anchors, rnd.randint(4, 5)), start=1)]
    for k, (name, parent) in enumerate(plan, start=1):
        bottom = rnd.choice([12, 13])
        top = add_unit(name, parent)
        levels = {top['UNT_LEVEL']: [top]}
        for level in range(top['UNT_LEVEL'] + 1, bottom + 1):
            levels[level] = [add_unit(f'{name} · م{level}-{i}', rnd.choice(levels[level - 1])) for i in range(1, rnd.randint(3, 6) + 1)]
        empty = set(rnd.sample(sorted(levels), rnd.randint(1, 2)))
        staffed = {}
        for level, here in levels.items():
            staffed[level] = 0 if level in empty else 3
            for _ in range(staffed[level]):
                add_person(rnd.choice(here))
        report.append((name, parent, bottom, {lv: len(us) for lv, us in levels.items()}, staffed))

    cols_u = list(units[0].keys())
    cur.executemany(f"INSERT INTO HR_UNITS_T ({', '.join(cols_u)}) VALUES ({', '.join(':' + c for c in cols_u)})",
                    sorted(units, key=lambda u: u['UNT_LEVEL']))
    cols_p = list(people[0].keys())
    cur.executemany(f"INSERT INTO HR_EMPLOYEES_T ({', '.join(cols_p)}) VALUES ({', '.join(':' + c for c in cols_p)})", people)
    conn.commit()

    print(f'[extend] seed {seed}: {len(units)} units and {len(people)} people added to the demo Oracle HR (TMRKZ untouched)')
    for name, parent, bottom, per_level, staffed in report:
        print(f'  {name}: under «{parent["NAME"]}» (L{parent["UNT_LEVEL"]}), down to L{bottom}')
        print('    units per level : ' + ', '.join(f'L{lv}={n}' for lv, n in per_level.items()))
        print('    people per level: ' + ', '.join(f'L{lv}={n}' for lv, n in staffed.items()))


if __name__ == '__main__':
    main()
