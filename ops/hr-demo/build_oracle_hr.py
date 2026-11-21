#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""TMRKZ's demo HR source, copied from TNQL's oracle_hr/build_oracle_hr.py (same owner; owner decision of 11 Nov 2026:
"use the demo one like mover"). Changes for TMRKZ: the secrets live in ops/hr-demo/.generated/oracle_hr.env, the container is
«tmrkz-hr-demo-oracle» (ops/hr-demo/up.sh), and the read-only account (TMRKZ_HR) may read the units and people views only —
TMRKZ never reads health data, so the medical view exists as in TNQL but is not granted. Everything else is TNQL's builder.

Oracle HR — the external HR source MOVER reads from, built INSIDE a real Oracle
Database (gvenzl/oracle-free container «mover-oracle-hr», service FREEPDB1).

    python oracle_hr/build_oracle_hr.py            # (re)build everything, then verify
    python oracle_hr/build_oracle_hr.py --verify   # verification queries only

What it creates (schema HR_AI, owner of the data):
  * base tables  HR_UNITS_T, HR_EMPLOYEES_T, HR_MED_EXEMPTIONS_T  (PKs, FKs, unique + lookup indexes)
  * the three READ-ONLY views the application contract names:
        HR_ENV_UNITS_AI, HR_PRS_EMPLOYEES_ALL, HR_PRS_MEDICAL_EXEMPTIONS_ALL
  * a separate read-only account MOVER_HR that can SELECT the three views and nothing else —
    that is the account MOVER connects with.

The data is 100 % synthetic, deterministic (fixed seed), internally consistent:
  * 200,000 employees, every PRS_ID / MIL_NUMBER / NEW_MIL_NO / PERSON_USER_ID / POSITION_ID unique;
  * the agreed reference organisation from oracle_hr/reference_structure.py (one root, ten
    straight chains L2→L5, ten L6 main units, the agreed L7–L10 children; nothing invented);
  * L1–L6 contain ZERO personnel; all 200,000 belong to L7–L10 units;
  * statuses with their real meaning: في الخدمة (on duty / annual leave / sick leave / external mission /
    training course / secondment), متقاعد, منتهي الخدمة, مفصول من الخدمة; annexations with their unit;
  * medical exemptions for a slice of the people in service, open-ended or dated.

Secrets come from instance/oracle_hr.env (untracked). Nothing is printed but counts.

Profiles (TMRKZ, owner 20 Nov 2026, ADR-094: «a fake Oracle HR (about 30,000 units in an irregular tree, main units at
varying depths, about 200,000 people)»), chosen with --profile; the same schema, tables, views, account and grants:
  * default — exactly the above: the agreed reference organisation (reference_structure.py) and 200,000 people at L7–L10.
  * large   — large_structure.py: about 30,000 units in an irregular tree (one root; branches of different shapes, some
              stopping at level 4, others reaching 13–15; branching varies per branch and per level); main units at
              levels 4–9 by the owner's rule (MAIN_UNIT_ID = ID on a main unit, every unit below points up to it, none
              above); UNIT_PATH the ID path; short synthetic Arabic names; STATUS mostly 1. 200,000 people in the units at
              level 4 and below that belong to a main unit's tree (none above level 4): every one with a unique
              PERSON_USER_ID (first.family123), MIL_NUMBER and NEW_MIL_NO, an Arabic name, rank, position and job,
              mostly في الخدمة with the other statuses above, MAIN_ORG_UNT_ID = the unit's main unit. Unit IDs 1,000,000+.
    python build_oracle_hr.py --profile large [--verify]
"""
import argparse
import datetime as dt
import os
import random
import sys
import time

import oracledb

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from reference_structure import build_units  # noqa: E402
from large_structure import build_units as build_large_units  # noqa: E402
MOVER = os.path.dirname(HERE)
ENV_FILE = os.path.join(HERE, '.generated', 'oracle_hr.env')

SEED = 20261008
TARGET_PEOPLE = 200_000

# ----------------------------------------------------------------------------- vocabulary (all synthetic)
FIRST = ['أحمد', 'محمد', 'خالد', 'سالم', 'سعيد', 'عبدالله', 'ناصر', 'راشد', 'حمد', 'سلطان', 'علي', 'يوسف',
         'إبراهيم', 'فيصل', 'عمر', 'حسن', 'مبارك', 'زايد', 'منصور', 'ماجد', 'طارق', 'بدر', 'جاسم', 'عيسى',
         'هزاع', 'صقر', 'فهد', 'حميد', 'عادل', 'ثاني', 'غانم', 'سيف', 'عبيد', 'مطر', 'درويش', 'جمعة']
FIRST_F = ['فاطمة', 'مريم', 'عائشة', 'شمسة', 'موزة', 'هند', 'نورة', 'لطيفة', 'سارة', 'علياء', 'ميثاء', 'حصة']
FAMILY = ['المنصوري', 'الشحي', 'الكعبي', 'النعيمي', 'المزروعي', 'الظاهري', 'الشامسي', 'المهيري', 'الفلاسي',
          'الحمادي', 'العامري', 'الزعابي', 'الرميثي', 'البلوشي', 'القبيسي', 'الدرمكي', 'الكتبي', 'النقبي',
          'السويدي', 'المرر', 'الجنيبي', 'الطنيجي', 'الحبسي', 'المطروشي', 'الكندي', 'الغفلي', 'العتيبي']
LATIN = {'أحمد': 'ahmed', 'محمد': 'mohammed', 'خالد': 'khalid', 'سالم': 'salem', 'سعيد': 'saeed', 'عبدالله': 'abdulla',
         'ناصر': 'nasser', 'راشد': 'rashed', 'حمد': 'hamad', 'سلطان': 'sultan', 'علي': 'ali', 'يوسف': 'yousef',
         'إبراهيم': 'ibrahim', 'فيصل': 'faisal', 'عمر': 'omar', 'حسن': 'hassan', 'مبارك': 'mubarak', 'زايد': 'zayed',
         'منصور': 'mansoor', 'ماجد': 'majed', 'طارق': 'tariq', 'بدر': 'badr', 'جاسم': 'jasem', 'عيسى': 'essa',
         'هزاع': 'hazza', 'صقر': 'saqer', 'فهد': 'fahad', 'حميد': 'humaid', 'عادل': 'adel', 'ثاني': 'thani',
         'غانم': 'ghanem', 'سيف': 'saif', 'عبيد': 'obaid', 'مطر': 'matar', 'درويش': 'darwish', 'جمعة': 'juma',
         'فاطمة': 'fatima', 'مريم': 'mariam', 'عائشة': 'aisha', 'شمسة': 'shamsa', 'موزة': 'moza', 'هند': 'hind',
         'نورة': 'noura', 'لطيفة': 'latifa', 'سارة': 'sara', 'علياء': 'alya', 'ميثاء': 'maitha', 'حصة': 'hessa'}
_TR = str.maketrans({'ا': 'a', 'ب': 'b', 'ت': 't', 'ث': 'th', 'ج': 'j', 'ح': 'h', 'خ': 'kh', 'د': 'd', 'ذ': 'dh', 'ر': 'r',
                     'ز': 'z', 'س': 's', 'ش': 'sh', 'ص': 's', 'ض': 'd', 'ط': 't', 'ظ': 'z', 'ع': 'a', 'غ': 'gh', 'ف': 'f',
                     'ق': 'q', 'ك': 'k', 'ل': 'l', 'م': 'm', 'ن': 'n', 'ه': 'h', 'و': 'w', 'ي': 'y', 'ى': 'a', 'ة': 'a',
                     'أ': 'a', 'إ': 'i', 'آ': 'a', 'ء': ''})
FAMILY_LATIN = {f: (f[2:] if f.startswith('ال') else f).translate(_TR) for f in FAMILY}   # ASCII only

# (grade name, is officer, min years of service) — used by seniority
OFFICER_GRADES = [('ملازم', 0), ('ملازم أول', 3), ('نقيب', 6), ('رائد', 10), ('مقدم', 14), ('عقيد', 18), ('عميد', 23), ('لواء', 28)]
OTHER_GRADES = [('جندي', 0), ('جندي أول', 2), ('عريف', 4), ('وكيل عريف', 6), ('رقيب', 8), ('رقيب أول', 11), ('وكيل', 14), ('وكيل أول', 18)]
JOBS = ['ضابط عمليات', 'ضابط أركان', 'ضابط إمداد', 'ضابط اتصالات', 'ضابط هندسة', 'ضابط طبي', 'ممرض', 'مسعف', 'سائق',
        'فني آليات', 'فني إلكترونيات', 'كاتب', 'محاسب', 'مشغل اتصالات', 'حارس', 'شرطي عسكري', 'مدرب', 'طيار', 'فني طيران',
        'مراقب جوي', 'مهندس', 'طبيب', 'صيدلي', 'فني مختبر', 'مسؤول مستودع', 'إداري', 'مترجم', 'مصور', 'طباخ', 'عامل صيانة',
        'منسق', 'باحث', 'محلل', 'مبرمج', 'فني شبكات', 'مشرف', 'مفتش', 'مرشد', 'رامي', 'مساعد إداري']
POSITIONS = ['ضابط عمليات', 'ضابط أركان', 'ضابط إمداد', 'مساعد القائد', 'رئيس شعبة', 'مدير مكتب', 'مسؤول إداري',
             'مشرف', 'عضو', 'فني', 'سائق', 'مراسل', 'كاتب', 'حارس', 'مدرب', 'مساعد']
WORK_STATUS = [('على رأس العمل', 80), ('إجازة سنوية', 8), ('إجازة مرضية', 3), ('مهمة خارجية', 3), ('دورة تدريبية', 3), ('إعارة', 3)]
EXT_ORGS = ['وزارة الداخلية', 'الهيئة الوطنية للطوارئ', 'الأمانة العامة', 'المجلس الأعلى', 'هيئة الطيران المدني']
EXEMPTIONS = ['إعفاء من اللياقة', 'إعفاء من المناوبة', 'إعفاء من الحراسة', 'إعفاء من الطابور الصباحي', 'إعفاء من الأحمال']

TODAY = dt.date(2026, 10, 8)


def load_env():
    if not os.path.isfile(ENV_FILE):
        sys.exit(f'[error] missing {ENV_FILE}')
    env = {}
    for line in open(ENV_FILE, encoding='utf-8'):
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            k, v = line.split('=', 1)
            env[k.strip()] = v.strip()
    return env


def dsn(env):
    return f"{env['ORACLE_HR_HOST']}:{env['ORACLE_HR_PORT']}/{env['ORACLE_HR_SERVICE']}"


# ----------------------------------------------------------------------------- generation
def generate(profile='default'):
    rnd = random.Random(SEED)
    large = profile == 'large'
    # default: the agreed reference organisation, nothing invented; large: the irregular 30,000-unit tree (ADR-094)
    units = build_large_units() if large else build_units()
    by_id = {u['ID']: u for u in units}

    def main_of(unit):
        # MAIN_UNIT_ID is the unit's main unit, itself on a main unit (owner, 16 Nov 2026); none above every main unit
        return by_id.get(unit['MAIN_UNIT_ID']) or unit

    live_units = [u for u in units if u['STATUS'] == 1]
    dead_units = [u for u in units if u['STATUS'] != 1]
    if large:
        # people sit in the units of a main unit's tree (all at level 4 and below); never above a main unit
        deep = [u for u in live_units if u['MAIN_UNIT_ID'] is not None]
    else:
        deep = [u for u in units if u['UNT_LEVEL'] >= 7]    # where the MOVER operations people sit
    shallow = [u for u in units if u['UNT_LEVEL'] < 6]      # small staffs only
    mains = [u for u in units if u['UNT_LEVEL'] == 6]

    # ---- people
    people = []
    used_user = set()
    used_mil = set()
    prs_seq = [500000]
    pos_seq = [9000000]
    jobs = [(7001 + i, j) for i, j in enumerate(JOBS)]

    def username(first, family):
        base = f'{LATIN.get(first) or first.translate(_TR)}.{FAMILY_LATIN[family]}'.lower().replace(' ', '')
        base = ''.join(ch for ch in base if ch.isascii() and (ch.isalnum() or ch == '.'))     # a domain account is ASCII
        cand = base
        n = 1
        while cand in used_user:
            n += 1
            cand = f'{base}{n}'
        used_user.add(cand)
        return cand

    def mil():
        while True:
            m = str(rnd.randint(3_000_000, 3_999_999))
            if m not in used_mil:
                used_mil.add(m)
                return m

    def grade_for(years, officer):
        table = OFFICER_GRADES if officer else OTHER_GRADES
        g = table[0][0]
        for name, need in table:
            if years >= need:
                g = name
        return g

    def add_person(unit, is_commander, status='في الخدمة'):
        prs_seq[0] += 1
        pos_seq[0] += 1
        female = rnd.random() < 0.08
        first = rnd.choice(FIRST_F if female else FIRST)
        family = rnd.choice(FAMILY)
        full = f'{first} {rnd.choice(FIRST)} {rnd.choice(FIRST)} {family}'
        officer = is_commander or (rnd.random() < (0.35 if unit['UNT_LEVEL'] <= 6 else 0.12))
        years = rnd.randint(1, 32)
        if is_commander:
            years = max(years, {1: 28, 2: 25, 3: 22, 4: 18, 5: 14, 6: 10, 7: 6, 8: 4, 9: 3, 10: 2}.get(unit['UNT_LEVEL'], 2))
        grade = grade_for(years, officer)
        full_grade = grade + (' ركن' if officer and years >= 14 and rnd.random() < 0.5 else '')
        enlist = TODAY - dt.timedelta(days=int(years * 365.25) + rnd.randint(0, 300))
        birth = enlist - dt.timedelta(days=int((rnd.randint(18, 24) + (4 if officer else 0)) * 365.25) + rnd.randint(0, 365))
        job_id, job = rnd.choice(jobs)
        position = 'قائد الوحدة' if is_commander else rnd.choice(POSITIONS)
        in_service = status == 'في الخدمة'
        work = rnd.choices([w for w, _ in WORK_STATUS], [p for _, p in WORK_STATUS])[0] if in_service else status
        unit_status = 'ضمن الوحدة'
        annex = None
        if in_service and not is_commander:
            r = rnd.random()
            if r < 0.06:
                unit_status = 'ملحق'
                annex = rnd.choice(deep)
            elif r < 0.10:
                unit_status = 'منقول'
        elif not in_service:
            unit_status = 'خارج الوحدة'
        has_account = in_service and rnd.random() < 0.96 or (not in_service and rnd.random() < 0.5)
        if large:
            has_account = True                              # the large profile: every person has an account and both numbers
        user_id = username(first, family) if has_account else None
        m = mil()
        new_mil = ('N%08d' % (10_000_000 + prs_seq[0])) if large or rnd.random() < 0.3 else None   # unique by construction
        main = main_of(unit)
        end_service = None if in_service else TODAY - dt.timedelta(days=rnd.randint(30, 4000))
        deleg_start = deleg_end = ext_org = None
        if work == 'إعارة':
            deleg_start = TODAY - dt.timedelta(days=rnd.randint(10, 700))
            deleg_end = deleg_start + dt.timedelta(days=rnd.randint(180, 1095))
            ext_org = rnd.choice(EXT_ORGS)
        p = {
            'PRS_ID': prs_seq[0], 'MIL_NUMBER': m, 'NEW_MIL_NO': new_mil, 'PERSON_USER_ID': user_id,
            'FIRST_NAME': first, 'FULL_NAME': full, 'FULL_NAME_E': (user_id or f'person{prs_seq[0]}').replace('.', ' ').title(),
            'GRD_ID': (OFFICER_GRADES if officer else OTHER_GRADES).index(next(x for x in (OFFICER_GRADES if officer else OTHER_GRADES) if x[0] == grade)) + (100 if officer else 200),
            'GRADE_NAME': grade, 'FULL_GRADE_NAME': full_grade, 'MAIN_GRADE_TYPE': 1,
            'POSITION_ID': pos_seq[0], 'EMP_POSITION_DESC': position, 'JOB_ID': job_id, 'JOB_NAME': job,
            'ORG_UNIT_ID': unit['ID'], 'ORG_UNIT_NAME': unit['NAME'], 'ORG_UNIT_FULL_PATH': unit['FULL_PATH'],
            'MAIN_ORG_UNT_ID': main['ID'], 'MAIN_ORG_UNIT_NAME': main['NAME'],
            'ANNEXATION_UNIT_ID': annex['ID'] if annex else None, 'ANNEXATION_UNIT_NAME': annex['NAME'] if annex else None,
            'ANNEXATION_DATE': (TODAY - dt.timedelta(days=rnd.randint(5, 400))) if annex else None,
            'MAIN_ANNEXATION_UNIT_ID': main_of(annex)['ID'] if annex else None,
            'MAIN_ANNEXATION_UNIT_NAME': main_of(annex)['NAME'] if annex else None,
            'EMP_STATUS': {'في الخدمة': 1, 'متقاعد': 2, 'منتهي الخدمة': 3, 'مفصول من الخدمة': 4}[status],
            'EMP_STATUS_DESC': status, 'EMP_WORK_STATUS_DESC': work, 'EMP_UNIT_STATUS_DESC': unit_status,
            'GENDER': 2 if female else 1, 'GENDER_DESC': 'أنثى' if female else 'ذكر',
            'BIRTH_DATE': birth, 'ENLISTMENT_DATE': enlist, 'END_SERVICE_DATE': end_service,
            'MOBILE': '05%08d' % (10_000_000 + prs_seq[0]), 'MOBILE2': None, 'HOME_PHONE_1': None,
            'DELEGATION_START_DATE': deleg_start, 'DELEGATION_EXPECTED_END_DATE': deleg_end, 'EXTERNAL_ORG_NAME': ext_org,
            'NATIONALITY_DESC': 'الإمارات', 'EMPLOYEE_CLASS_DESC': 'عسكري',
        }
        people.append(p)
        if is_commander:
            unit['DIRECTOR_POS_ID'] = p['POSITION_ID']
        return p

    if large:
        # a commander in every unit of a main unit's tree; the mass spread unevenly over the same units (a few people in
        # most, hundreds in some); the not-in-service people partly in the inactive units
        for u in deep:
            add_person(u, True)
        weights = [rnd.lognormvariate(0, 1.1) for _ in deep]
        for u in rnd.choices(deep, weights, k=int(TARGET_PEOPLE * 0.88) - len(people)):
            add_person(u, False)
    else:
        # Owner ruling: L1–L6 = 0 personnel.  ALL fake personnel at L7–L10.
        # A commander for every L7+ unit; the mass fills L7+ units; not-in-service
        # people also go to L7+ only.
        for u in live_units:
            if u['UNT_LEVEL'] >= 7:
                add_person(u, True)
        remaining = int(TARGET_PEOPLE * 0.88) - len(people)
        for _ in range(remaining):
            add_person(rnd.choice(deep), False)
    not_in_service = TARGET_PEOPLE - len(people)
    for i in range(not_in_service):
        pool = dead_units if (dead_units and i % 5 == 0) else deep
        st = rnd.choices(['متقاعد', 'منتهي الخدمة', 'مفصول من الخدمة'], [8, 3, 1])[0]
        add_person(rnd.choice(pool), False, status=st)
    assert len(people) == TARGET_PEOPLE, len(people)

    # ---- medical exemptions for 2 % of the people in service
    exemptions = []
    for p in people:
        if p['EMP_STATUS_DESC'] == 'في الخدمة' and rnd.random() < 0.02:
            for _ in range(rnd.choice([1, 1, 2])):
                start = TODAY - dt.timedelta(days=rnd.randint(1, 180))
                days = rnd.choice([30, 60, 90, 180, 365, None])
                exemptions.append({
                    'ID': 800000 + len(exemptions) + 1, 'PRS_ID': p['PRS_ID'], 'DIR_ID': 100000 + len(exemptions),
                    'EXEMPTION_TYPE': rnd.randint(1, 5), 'EXEMPTION_TYPE_DESC': rnd.choice(EXEMPTIONS),
                    'DATE_FROM': start, 'DATE_TO': (start + dt.timedelta(days=days)) if days else None,
                    'DIAGNOSIS': 'تشخيص اصطناعي', 'NO_OF_DAYS': days, 'EXEMPTION_SOURCE': rnd.choice([1, 2]),
                    'EXEMPTION_SOURCE_DESC': None,
                })
    for e in exemptions:
        e['EXEMPTION_SOURCE_DESC'] = 'اللجنة الطبية' if e['EXEMPTION_SOURCE'] == 1 else 'نظام الموارد البشرية'
    return units, people, exemptions


# ----------------------------------------------------------------------------- oracle DDL
UNIT_COLS = ['ID', 'CODE', 'NAME', 'NAME_E', 'SHORT_NAME', 'MAIN_UNIT_ID', 'UNT_LEVEL', 'UNIT_PATH', 'STATUS',
             'MAIN_UNIT_FLAG', 'HAS_SON', 'DIRECTOR_POS_ID', 'UNT_ID']
EMP_COLS = ['PRS_ID', 'MIL_NUMBER', 'NEW_MIL_NO', 'PERSON_USER_ID', 'FIRST_NAME', 'FULL_NAME', 'FULL_NAME_E', 'GRD_ID',
            'GRADE_NAME', 'FULL_GRADE_NAME', 'MAIN_GRADE_TYPE', 'POSITION_ID', 'EMP_POSITION_DESC', 'JOB_ID', 'JOB_NAME',
            'ORG_UNIT_ID', 'ORG_UNIT_NAME', 'ORG_UNIT_FULL_PATH', 'MAIN_ORG_UNT_ID', 'MAIN_ORG_UNIT_NAME',
            'ANNEXATION_UNIT_ID', 'ANNEXATION_UNIT_NAME', 'ANNEXATION_DATE', 'MAIN_ANNEXATION_UNIT_ID',
            'MAIN_ANNEXATION_UNIT_NAME', 'EMP_STATUS', 'EMP_STATUS_DESC', 'EMP_WORK_STATUS_DESC', 'EMP_UNIT_STATUS_DESC',
            'GENDER', 'GENDER_DESC', 'BIRTH_DATE', 'ENLISTMENT_DATE', 'END_SERVICE_DATE', 'MOBILE', 'MOBILE2',
            'HOME_PHONE_1', 'DELEGATION_START_DATE', 'DELEGATION_EXPECTED_END_DATE', 'EXTERNAL_ORG_NAME',
            'NATIONALITY_DESC', 'EMPLOYEE_CLASS_DESC']
EXE_COLS = ['ID', 'PRS_ID', 'DIR_ID', 'EXEMPTION_TYPE', 'EXEMPTION_TYPE_DESC', 'DATE_FROM', 'DATE_TO', 'DIAGNOSIS',
            'NO_OF_DAYS', 'EXEMPTION_SOURCE', 'EXEMPTION_SOURCE_DESC']

# TMRKZ: the reader account reads these two only (no health data)
READER_VIEWS = ['HR_ENV_UNITS_AI', 'HR_PRS_EMPLOYEES_ALL']

DDL_TABLES = [
    """CREATE TABLE HR_UNITS_T (
        ID NUMBER(10) PRIMARY KEY, CODE VARCHAR2(10) NOT NULL, NAME NVARCHAR2(200) NOT NULL, NAME_E VARCHAR2(200),
        SHORT_NAME NVARCHAR2(100) NOT NULL, MAIN_UNIT_ID NUMBER(10), UNT_LEVEL NUMBER(3) NOT NULL,
        UNIT_PATH NVARCHAR2(2000), STATUS NUMBER(1) NOT NULL, MAIN_UNIT_FLAG NUMBER(1), HAS_SON NUMBER(1),
        DIRECTOR_POS_ID NUMBER(10), UNT_ID VARCHAR2(40),
        CONSTRAINT FK_UNIT_PARENT FOREIGN KEY (MAIN_UNIT_ID) REFERENCES HR_UNITS_T (ID))""",
    "CREATE INDEX IX_UNITS_PARENT ON HR_UNITS_T (MAIN_UNIT_ID)",
    "CREATE INDEX IX_UNITS_LEVEL ON HR_UNITS_T (UNT_LEVEL, STATUS)",
    """CREATE TABLE HR_EMPLOYEES_T (
        PRS_ID NUMBER(10) PRIMARY KEY, MIL_NUMBER VARCHAR2(20) NOT NULL, NEW_MIL_NO VARCHAR2(250),
        PERSON_USER_ID VARCHAR2(100), FIRST_NAME NVARCHAR2(60) NOT NULL, FULL_NAME NVARCHAR2(300) NOT NULL,
        FULL_NAME_E VARCHAR2(300), GRD_ID NUMBER(5), GRADE_NAME NVARCHAR2(60), FULL_GRADE_NAME NVARCHAR2(80),
        MAIN_GRADE_TYPE NUMBER(1), POSITION_ID NUMBER(10), EMP_POSITION_DESC NVARCHAR2(120), JOB_ID NUMBER(10) NOT NULL,
        JOB_NAME NVARCHAR2(120), ORG_UNIT_ID NUMBER(10) NOT NULL, ORG_UNIT_NAME NVARCHAR2(200),
        ORG_UNIT_FULL_PATH NVARCHAR2(2000), MAIN_ORG_UNT_ID NUMBER(10), MAIN_ORG_UNIT_NAME NVARCHAR2(200),
        ANNEXATION_UNIT_ID NUMBER(10), ANNEXATION_UNIT_NAME NVARCHAR2(200), ANNEXATION_DATE DATE,
        MAIN_ANNEXATION_UNIT_ID NUMBER(10), MAIN_ANNEXATION_UNIT_NAME NVARCHAR2(200), EMP_STATUS NUMBER(3) NOT NULL,
        EMP_STATUS_DESC NVARCHAR2(60) NOT NULL, EMP_WORK_STATUS_DESC NVARCHAR2(60), EMP_UNIT_STATUS_DESC NVARCHAR2(60),
        GENDER NUMBER(1) NOT NULL, GENDER_DESC NVARCHAR2(10), BIRTH_DATE DATE NOT NULL, ENLISTMENT_DATE DATE NOT NULL,
        END_SERVICE_DATE DATE, MOBILE VARCHAR2(20), MOBILE2 VARCHAR2(20), HOME_PHONE_1 VARCHAR2(20),
        DELEGATION_START_DATE DATE, DELEGATION_EXPECTED_END_DATE DATE, EXTERNAL_ORG_NAME NVARCHAR2(200),
        NATIONALITY_DESC NVARCHAR2(60), EMPLOYEE_CLASS_DESC NVARCHAR2(60),
        CONSTRAINT FK_EMP_UNIT FOREIGN KEY (ORG_UNIT_ID) REFERENCES HR_UNITS_T (ID),
        CONSTRAINT FK_EMP_MAIN_UNIT FOREIGN KEY (MAIN_ORG_UNT_ID) REFERENCES HR_UNITS_T (ID),
        CONSTRAINT FK_EMP_ANNEX_UNIT FOREIGN KEY (ANNEXATION_UNIT_ID) REFERENCES HR_UNITS_T (ID))""",
    "CREATE UNIQUE INDEX UX_EMP_MIL ON HR_EMPLOYEES_T (MIL_NUMBER)",
    "CREATE UNIQUE INDEX UX_EMP_NEW_MIL ON HR_EMPLOYEES_T (NEW_MIL_NO)",
    "CREATE UNIQUE INDEX UX_EMP_USER ON HR_EMPLOYEES_T (PERSON_USER_ID)",
    "CREATE UNIQUE INDEX UX_EMP_POSITION ON HR_EMPLOYEES_T (POSITION_ID)",
    "CREATE INDEX IX_EMP_UNIT ON HR_EMPLOYEES_T (ORG_UNIT_ID)",
    "CREATE INDEX IX_EMP_ANNEX ON HR_EMPLOYEES_T (ANNEXATION_UNIT_ID)",
    "CREATE INDEX IX_EMP_STATUS ON HR_EMPLOYEES_T (EMP_STATUS_DESC)",
    "CREATE INDEX IX_EMP_NAME ON HR_EMPLOYEES_T (FULL_NAME)",
    """CREATE TABLE HR_MED_EXEMPTIONS_T (
        ID NUMBER(10) PRIMARY KEY, PRS_ID NUMBER(10) NOT NULL, DIR_ID NUMBER(10), EXEMPTION_TYPE NUMBER(3),
        EXEMPTION_TYPE_DESC NVARCHAR2(120), DATE_FROM DATE, DATE_TO DATE, DIAGNOSIS NVARCHAR2(2000),
        NO_OF_DAYS NUMBER(5), EXEMPTION_SOURCE NUMBER(1), EXEMPTION_SOURCE_DESC NVARCHAR2(60),
        CONSTRAINT FK_EXE_PERSON FOREIGN KEY (PRS_ID) REFERENCES HR_EMPLOYEES_T (PRS_ID))""",
    "CREATE INDEX IX_EXE_PERSON ON HR_MED_EXEMPTIONS_T (PRS_ID)",
]
DDL_VIEWS = [
    f"CREATE OR REPLACE VIEW HR_ENV_UNITS_AI AS SELECT {', '.join(UNIT_COLS)} FROM HR_UNITS_T WITH READ ONLY",
    f"CREATE OR REPLACE VIEW HR_PRS_EMPLOYEES_ALL AS SELECT {', '.join(EMP_COLS)} FROM HR_EMPLOYEES_T WITH READ ONLY",
    f"CREATE OR REPLACE VIEW HR_PRS_MEDICAL_EXEMPTIONS_ALL AS SELECT {', '.join(EXE_COLS)} FROM HR_MED_EXEMPTIONS_T WITH READ ONLY",
]
VIEWS = ['HR_ENV_UNITS_AI', 'HR_PRS_EMPLOYEES_ALL', 'HR_PRS_MEDICAL_EXEMPTIONS_ALL']


def connect(env, user, password):
    return oracledb.connect(user=user, password=password, dsn=dsn(env))


def drop_if_exists(cur, kind, name):
    cur.execute(f"""BEGIN EXECUTE IMMEDIATE 'DROP {kind} {name}'; EXCEPTION WHEN OTHERS THEN
                    IF SQLCODE NOT IN (-942, -1918, -4043) THEN RAISE; END IF; END;""")


def build(env, profile='default'):
    t0 = time.time()
    units, people, exemptions = generate(profile)
    print(f'[gen] profile={profile} units={len(units):,} people={len(people):,} exemptions={len(exemptions):,} in {time.time() - t0:.1f}s')

    # 1. the reader account (needs SYSTEM) — created once, read-only
    sysconn = connect(env, 'SYSTEM', env['ORACLE_SYSTEM_PASSWORD'])
    cur = sysconn.cursor()
    cur.execute("SELECT COUNT(*) FROM all_users WHERE username = :u", u=env['ORACLE_MOVER_USER'])
    if cur.fetchone()[0] == 0:
        cur.execute(f'CREATE USER {env["ORACLE_MOVER_USER"]} IDENTIFIED BY "{env["ORACLE_MOVER_PASSWORD"]}"')
        print(f'[sys] created read-only account {env["ORACLE_MOVER_USER"]}')
    cur.execute(f'GRANT CREATE SESSION TO {env["ORACLE_MOVER_USER"]}')
    sysconn.commit()
    sysconn.close()

    # 2. schema objects + data as HR_AI
    conn = connect(env, env['ORACLE_HR_SCHEMA'], env['ORACLE_HR_SCHEMA_PASSWORD'])
    cur = conn.cursor()
    for v in VIEWS:
        drop_if_exists(cur, 'VIEW', v)
    for t in ('HR_MED_EXEMPTIONS_T', 'HR_EMPLOYEES_T', 'HR_UNITS_T'):
        drop_if_exists(cur, 'TABLE', t)
    for ddl in DDL_TABLES:
        cur.execute(ddl)
    print('[ddl] tables + indexes created')

    def insert(table, cols, rows, batch=5000):
        sql = f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({', '.join(':' + str(i + 1) for i in range(len(cols)))})"
        for i in range(0, len(rows), batch):
            cur.executemany(sql, [[r.get(c) for c in cols] for r in rows[i:i + batch]])
        conn.commit()

    t1 = time.time()
    units_sorted = sorted(units, key=lambda u: u['UNT_LEVEL'])        # parents before children (FK)
    insert('HR_UNITS_T', UNIT_COLS, units_sorted)
    insert('HR_EMPLOYEES_T', EMP_COLS, people)
    insert('HR_MED_EXEMPTIONS_T', EXE_COLS, exemptions)
    print(f'[load] rows inserted in {time.time() - t1:.1f}s')
    for ddl in DDL_VIEWS:
        cur.execute(ddl)
    for v in READER_VIEWS:
        cur.execute(f'GRANT SELECT ON {v} TO {env["ORACLE_MOVER_USER"]}')
    cur.execute("BEGIN DBMS_STATS.GATHER_SCHEMA_STATS(USER); END;")
    conn.commit()
    conn.close()
    ensure_synonyms(env)
    print(f'[views] {", ".join(VIEWS)} created (WITH READ ONLY) and granted to {env["ORACLE_MOVER_USER"]}')
    print(f'[done] build in {time.time() - t0:.1f}s')


def ensure_synonyms(env):
    """The application names the views bare (HR_ENV_UNITS_AI, ...): give the
    reader account private synonyms so its SQL needs no schema prefix."""
    sysconn = connect(env, 'SYSTEM', env['ORACLE_SYSTEM_PASSWORD'])
    cur = sysconn.cursor()
    for v in READER_VIEWS:
        cur.execute(f'CREATE OR REPLACE SYNONYM {env["ORACLE_MOVER_USER"]}.{v} FOR {env["ORACLE_HR_SCHEMA"]}.{v}')
    sysconn.commit()
    sysconn.close()
    print(f'[sys] synonyms for the three views created in {env["ORACLE_MOVER_USER"]}')


def verify(env):
    """Real answers from Oracle, through the READ-ONLY account MOVER uses."""
    conn = connect(env, env['ORACLE_MOVER_USER'], env['ORACLE_MOVER_PASSWORD'])
    cur = conn.cursor()
    q = lambda s: cur.execute(s).fetchall()
    print(f'[verify] connected as {env["ORACLE_MOVER_USER"]} to {dsn(env)}; '
          f'Oracle {conn.version}')
    print('  employees total          :', q('SELECT COUNT(*) FROM HR_PRS_EMPLOYEES_ALL')[0][0])
    print('  by status                :', q('SELECT EMP_STATUS_DESC, COUNT(*) FROM HR_PRS_EMPLOYEES_ALL GROUP BY EMP_STATUS_DESC ORDER BY 2 DESC'))
    print('  work status (in service) :', q("SELECT EMP_WORK_STATUS_DESC, COUNT(*) FROM HR_PRS_EMPLOYEES_ALL WHERE EMP_STATUS_DESC = N'في الخدمة' GROUP BY EMP_WORK_STATUS_DESC ORDER BY 2 DESC"))
    print('  unit status              :', q('SELECT EMP_UNIT_STATUS_DESC, COUNT(*) FROM HR_PRS_EMPLOYEES_ALL GROUP BY EMP_UNIT_STATUS_DESC ORDER BY 2 DESC'))
    print('  duplicate PRS_ID         :', q('SELECT COUNT(*) FROM (SELECT PRS_ID FROM HR_PRS_EMPLOYEES_ALL GROUP BY PRS_ID HAVING COUNT(*) > 1)')[0][0])
    print('  duplicate MIL_NUMBER     :', q('SELECT COUNT(*) FROM (SELECT MIL_NUMBER FROM HR_PRS_EMPLOYEES_ALL GROUP BY MIL_NUMBER HAVING COUNT(*) > 1)')[0][0])
    print('  duplicate PERSON_USER_ID :', q('SELECT COUNT(*) FROM (SELECT PERSON_USER_ID FROM HR_PRS_EMPLOYEES_ALL WHERE PERSON_USER_ID IS NOT NULL GROUP BY PERSON_USER_ID HAVING COUNT(*) > 1)')[0][0],
          '| without account:', q('SELECT COUNT(*) FROM HR_PRS_EMPLOYEES_ALL WHERE PERSON_USER_ID IS NULL')[0][0])
    print('  with annexation          :', q('SELECT COUNT(*) FROM HR_PRS_EMPLOYEES_ALL WHERE ANNEXATION_UNIT_ID IS NOT NULL')[0][0])
    print('  units total              :', q('SELECT COUNT(*) FROM HR_ENV_UNITS_AI')[0][0], '| active:', q('SELECT COUNT(*) FROM HR_ENV_UNITS_AI WHERE STATUS = 1')[0][0])
    print('  units per level          :', q('SELECT UNT_LEVEL, COUNT(*) FROM HR_ENV_UNITS_AI GROUP BY UNT_LEVEL ORDER BY 1'))
    print('  people per unit level    :', q('SELECT u.UNT_LEVEL, COUNT(*) FROM HR_PRS_EMPLOYEES_ALL e JOIN HR_ENV_UNITS_AI u ON u.ID = e.ORG_UNIT_ID GROUP BY u.UNT_LEVEL ORDER BY 1'))
    print('  people whose MAIN_ORG_UNT_ID is not their unit\'s main unit:',
          q('SELECT COUNT(*) FROM HR_PRS_EMPLOYEES_ALL e JOIN HR_ENV_UNITS_AI u ON u.ID = e.ORG_UNIT_ID WHERE NVL(e.MAIN_ORG_UNT_ID, -1) <> NVL(u.MAIN_UNIT_ID, -1)')[0][0])
    # the parent is the second-to-last segment of the ID path; a main unit is MAIN_UNIT_ID = ID (owner, 16 Nov 2026)
    tree = ("WITH t AS (SELECT ID, UNT_LEVEL, MAIN_UNIT_ID, CASE WHEN REGEXP_COUNT(UNIT_PATH, '[0-9]+') > 1 THEN "
            "TO_NUMBER(REGEXP_SUBSTR(UNIT_PATH, '[0-9]+', 1, REGEXP_COUNT(UNIT_PATH, '[0-9]+') - 1)) END AS PARENT_ID FROM HR_ENV_UNITS_AI) ")
    print('  main units (MAIN_UNIT_ID = ID):', q('SELECT UNT_LEVEL, COUNT(*) FROM HR_ENV_UNITS_AI WHERE MAIN_UNIT_ID = ID GROUP BY UNT_LEVEL ORDER BY 1'),
          '| pointing to a unit that is not main:', q('SELECT COUNT(*) FROM HR_ENV_UNITS_AI u WHERE MAIN_UNIT_ID IS NOT NULL AND NOT EXISTS (SELECT 1 FROM HR_ENV_UNITS_AI p WHERE p.ID = u.MAIN_UNIT_ID AND p.MAIN_UNIT_ID = p.ID)')[0][0])
    print('  orphan parents           :', q(tree + 'SELECT COUNT(*) FROM t u WHERE PARENT_ID IS NOT NULL AND NOT EXISTS (SELECT 1 FROM t p WHERE p.ID = u.PARENT_ID)')[0][0],
          '| roots:', q(tree + 'SELECT COUNT(*) FROM t WHERE PARENT_ID IS NULL')[0][0])
    print('  level != parent+1        :', q(tree + 'SELECT COUNT(*) FROM t u JOIN t p ON p.ID = u.PARENT_ID WHERE u.UNT_LEVEL <> p.UNT_LEVEL + 1')[0][0])
    print('  cycles (CONNECT BY)      :', 'none' if q(tree + "SELECT COUNT(*) FROM t START WITH PARENT_ID IS NULL CONNECT BY NOCYCLE PRIOR ID = PARENT_ID")[0][0] == q('SELECT COUNT(*) FROM HR_ENV_UNITS_AI')[0][0] else 'UNREACHABLE NODES — check')
    print('  people in unknown unit   :', q('SELECT COUNT(*) FROM HR_PRS_EMPLOYEES_ALL e WHERE NOT EXISTS (SELECT 1 FROM HR_ENV_UNITS_AI u WHERE u.ID = e.ORG_UNIT_ID)')[0][0])
    print('  directors resolvable     :', q('SELECT COUNT(*) FROM HR_ENV_UNITS_AI u JOIN HR_PRS_EMPLOYEES_ALL e ON e.POSITION_ID = u.DIRECTOR_POS_ID')[0][0], 'of', q('SELECT COUNT(*) FROM HR_ENV_UNITS_AI WHERE DIRECTOR_POS_ID IS NOT NULL')[0][0])
    try:
        cur.execute(f"SELECT COUNT(*) FROM {env['ORACLE_HR_SCHEMA']}.HR_PRS_MEDICAL_EXEMPTIONS_ALL")
        print('  medical view hidden      : FAILED — the reader sees health data')
    except oracledb.DatabaseError:
        print('  medical view hidden      : ok (TMRKZ never reads health data)')
    t = time.time()
    row = q("SELECT MIL_NUMBER, FULL_NAME, PERSON_USER_ID FROM HR_PRS_EMPLOYEES_ALL WHERE MIL_NUMBER = (SELECT MIN(MIL_NUMBER) FROM HR_PRS_EMPLOYEES_ALL)")
    print(f'  lookup by MIL_NUMBER     : {time.time() - t:.3f}s (indexed), sample has account: {bool(row and row[0][2])}')
    try:
        cur.execute("UPDATE HR_PRS_EMPLOYEES_ALL SET FULL_NAME = FULL_NAME WHERE ROWNUM = 1")
        print('  read-only enforcement    : FAILED — the reader could write')
    except oracledb.DatabaseError as exc:
        print('  read-only enforcement    : ok (write refused:', str(exc).split('\n')[0][:60] + ')')
    try:
        cur.execute(f"SELECT COUNT(*) FROM {env['ORACLE_HR_SCHEMA']}.HR_EMPLOYEES_T")
        print('  base tables hidden       : FAILED — the reader sees base tables')
    except oracledb.DatabaseError:
        print('  base tables hidden       : ok (only the three views are visible)')
    conn.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--verify', action='store_true', help='verification queries only (no rebuild)')
    ap.add_argument('--profile', choices=['default', 'large'], default='default',
                    help='default: the agreed reference organisation; large: about 30,000 units in an irregular tree (ADR-094)')
    a = ap.parse_args()
    env = load_env()
    if not a.verify:
        build(env, a.profile)
    verify(env)


if __name__ == '__main__':
    main()
