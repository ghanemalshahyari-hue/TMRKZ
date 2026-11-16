# -*- coding: utf-8 -*-
"""The agreed reference organisation (owner, 2026-10-08, updated 2026-10-15) —
the ONE place the Oracle HR unit tree comes from. Levels are Oracle levels (1 =
the root; MOVER stores level − 1). Names are the approved labels exactly as
agreed.

Shape: one root → ten branches, each a straight chain L2 → L3 → L4 → L5 → the
agreed L6 main unit, then the agreed children (L7 / L8 / L9 / L10) under that unit.
Nothing is invented beyond this list.

Owner ruling 2026-10-15:
  - exactly 10 L6 main units (المستشفى removed)
  - renamed: الإدارة الرئيسية للصحة → إدارة الصحة الرئيسية
  - renamed: البرية → القوات البرية
  - renamed: الجوية → القوات الجوية
  - added: إدارة الإطفاء 1, الاعتماد النهائي, الدفاع
  - L6 must contain ZERO personnel (all at L7-10)
"""

ROOT = 'Level 1 (تجريبي)'

# (branch number, L6 main unit name, children)
# children: a nested list of (name, [grandchildren…]) — depth gives L7, L8, L9, L10.
BRANCHES = [
    (1, 'إدارة الصحة الرئيسية', [
        ('إدارة الصحة', [
            ('مركز صحة واحد', [
                ('قسم صحة 1-أ', []),
                ('قسم صحة 1-ب', []),
            ]),
            ('مركز صحة اثنين', [
                ('قسم صحة 2-أ', []),
                ('قسم صحة 2-ب', []),
            ]),
            ('قيادة إدارة الصحة', [
                ('عمليات إدارة الصحة', [
                    ('مستلم طلبات توفير إدارة الصحة', []),
                ]),
            ]),
        ]),
    ]),
    (2, 'الإسناد', [
        ('قيادة الإسناد', [('قسم العمليات', [])]),
        ('آلية إنقاذ', []),
        ('إسعاف مع ممرض', []),
        ('مجموعة', [('كتيبة', [])]),
    ]),
    (3, 'القوات البرية', [
        ('قيادة البرية', [('عمليات البرية', [])]),
        ('لواء 1', []),
        ('لواء 2', [('جماعة 1', [])]),
    ]),
    (4, 'القوات الجوية', [
        ('AOC', []), ('قيادة الجوية', []), ('سيارة الشرطة', []),
        ('جناح إطفاء', [('العمليات', []), ('التدريب', [])]),
        ('جناح 8', [('قسم جناح طلب', [])]),
    ]),
    (5, 'الشرطة', [
        ('قيادة', [('عمليات', [])]),
        ('كتيبة واحد', []),
        ('كتيبة اثنين', []),
    ]),
    (6, 'المشترك', [
        ('قيادة الإسناد', [('عمليات', []), ('إسناد آليات', [('توفر الآليات', [])])]),
    ]),
    (7, 'مديرية', [
        ('رئاسة', []), ('شعبة واحد', []),
        ('شعبة اثنين', [('بري', []), ('بحر', [])]),
    ]),
    (8, 'إدارة الإطفاء 1', [
        ('قيادة الإطفاء', [('عمليات الإطفاء', [])]),
        ('فريق الإنقاذ', []),
    ]),
    (9, 'الاعتماد النهائي', [
        ('مكتب الاعتماد', []),
    ]),
    (10, 'الدفاع', [
        ('قيادة الدفاع', [('عمليات الدفاع', [])]),
    ]),
]

FIRST_ID = 100000          # Oracle unit ids: stable base
# New units added after the initial structure get IDs from a reserved range so
# existing sequential IDs never shift.  200000-200131 already used in the live
# Oracle build; the health expansion uses 300001+.
_NEXT_NEW_ID = 300000

# Pinned IDs: every unit that existed BEFORE the 2026-10-18 health expansion.
# Adding children to a branch must never change these.  New units receive IDs
# from _NEXT_NEW_ID upward — assigned once and recorded here.
_PINNED = {
    # key = (branch_number, level, name) → oracle id
    # root
    (0, 1, ROOT): 100000,
    # branch 1 (health)
    (1, 2, 'Level 2-1'): 100001,
    (1, 3, 'Level 3-1-1'): 100002,
    (1, 4, 'Level 4-1-1-1'): 100003,
    (1, 5, 'Level 5-1-1-1-1'): 100004,
    (1, 6, 'إدارة الصحة الرئيسية'): 100005,
    (1, 7, 'إدارة الصحة'): 100006,
    (1, 8, 'مركز صحة واحد'): 100007,
    (1, 8, 'مركز صحة اثنين'): 100008,
    # ↓ health expansion — 300001+ range (200000-200131 used in live Oracle)
    (1, 8, 'قيادة إدارة الصحة'): 300001,
    (1, 9, 'عمليات إدارة الصحة'): 300002,
    (1, 10, 'مستلم طلبات توفير إدارة الصحة'): 300003,
    (1, 9, 'قسم صحة 1-أ'): 300004,
    (1, 9, 'قسم صحة 1-ب'): 300005,
    (1, 9, 'قسم صحة 2-أ'): 300006,
    (1, 9, 'قسم صحة 2-ب'): 300007,
    # branch 2
    (2, 2, 'Level 2-2'): 100009,
    (2, 3, 'Level 3-2-1'): 100010,
    (2, 4, 'Level 4-2-1-1'): 100011,
    (2, 5, 'Level 5-2-1-1-1'): 100012,
    (2, 6, 'الإسناد'): 100013,
    (2, 7, 'قيادة الإسناد'): 100014,
    (2, 8, 'قسم العمليات'): 100015,
    (2, 7, 'آلية إنقاذ'): 100016,
    (2, 7, 'إسعاف مع ممرض'): 100017,
    (2, 7, 'مجموعة'): 100018,
    (2, 8, 'كتيبة'): 100019,
    # branch 3
    (3, 2, 'Level 2-3'): 100020,
    (3, 3, 'Level 3-3-1'): 100021,
    (3, 4, 'Level 4-3-1-1'): 100022,
    (3, 5, 'Level 5-3-1-1-1'): 100023,
    (3, 6, 'القوات البرية'): 100024,
    (3, 7, 'قيادة البرية'): 100025,
    (3, 8, 'عمليات البرية'): 100026,
    (3, 7, 'لواء 1'): 100027,
    (3, 7, 'لواء 2'): 100028,
    (3, 8, 'جماعة 1'): 100029,
    # branch 4
    (4, 2, 'Level 2-4'): 100030,
    (4, 3, 'Level 3-4-1'): 100031,
    (4, 4, 'Level 4-4-1-1'): 100032,
    (4, 5, 'Level 5-4-1-1-1'): 100033,
    (4, 6, 'القوات الجوية'): 100034,
    (4, 7, 'AOC'): 100035,
    (4, 7, 'قيادة الجوية'): 100036,
    (4, 7, 'سيارة الشرطة'): 100037,
    (4, 7, 'جناح إطفاء'): 100038,
    (4, 8, 'العمليات'): 100039,
    (4, 8, 'التدريب'): 100040,
    (4, 7, 'جناح 8'): 300008,
    (4, 8, 'قسم جناح طلب'): 300009,
    # branch 5
    (5, 2, 'Level 2-5'): 100041,
    (5, 3, 'Level 3-5-1'): 100042,
    (5, 4, 'Level 4-5-1-1'): 100043,
    (5, 5, 'Level 5-5-1-1-1'): 100044,
    (5, 6, 'الشرطة'): 100045,
    (5, 7, 'قيادة'): 100046,
    (5, 8, 'عمليات'): 100047,
    (5, 7, 'كتيبة واحد'): 100048,
    (5, 7, 'كتيبة اثنين'): 100049,
    # branch 6
    (6, 2, 'Level 2-6'): 100050,
    (6, 3, 'Level 3-6-1'): 100051,
    (6, 4, 'Level 4-6-1-1'): 100052,
    (6, 5, 'Level 5-6-1-1-1'): 100053,
    (6, 6, 'المشترك'): 100054,
    (6, 7, 'قيادة الإسناد'): 100055,
    (6, 8, 'عمليات'): 100056,
    (6, 8, 'إسناد آليات'): 100057,
    (6, 9, 'توفر الآليات'): 100058,
    # branch 7
    (7, 2, 'Level 2-7'): 100059,
    (7, 3, 'Level 3-7-1'): 100060,
    (7, 4, 'Level 4-7-1-1'): 100061,
    (7, 5, 'Level 5-7-1-1-1'): 100062,
    (7, 6, 'مديرية'): 100063,
    (7, 7, 'رئاسة'): 100064,
    (7, 7, 'شعبة واحد'): 100065,
    (7, 7, 'شعبة اثنين'): 100066,
    (7, 8, 'بري'): 100067,
    (7, 8, 'بحر'): 100068,
    # branch 8
    (8, 2, 'Level 2-8'): 100069,
    (8, 3, 'Level 3-8-1'): 100070,
    (8, 4, 'Level 4-8-1-1'): 100071,
    (8, 5, 'Level 5-8-1-1-1'): 100072,
    (8, 6, 'إدارة الإطفاء 1'): 100073,
    (8, 7, 'قيادة الإطفاء'): 100074,
    (8, 8, 'عمليات الإطفاء'): 100075,
    (8, 7, 'فريق الإنقاذ'): 100076,
    # branch 9
    (9, 2, 'Level 2-9'): 100077,
    (9, 3, 'Level 3-9-1'): 100078,
    (9, 4, 'Level 4-9-1-1'): 100079,
    (9, 5, 'Level 5-9-1-1-1'): 100080,
    (9, 6, 'الاعتماد النهائي'): 100081,
    (9, 7, 'مكتب الاعتماد'): 100082,
    # branch 10
    (10, 2, 'Level 2-10'): 100083,
    (10, 3, 'Level 3-10-1'): 100084,
    (10, 4, 'Level 4-10-1-1'): 100085,
    (10, 5, 'Level 5-10-1-1-1'): 100086,
    (10, 6, 'الدفاع'): 100087,
    (10, 7, 'قيادة الدفاع'): 100088,
    (10, 8, 'عمليات الدفاع'): 100089,
}


def build_units():
    """Return the units as dicts with the HR_ENV_UNITS_AI columns the builder
    loads (ID, CODE, NAME, NAME_E, SHORT_NAME, MAIN_UNIT_ID, UNT_LEVEL, UNIT_PATH,
    STATUS, MAIN_UNIT_FLAG, HAS_SON, DIRECTOR_POS_ID, UNT_ID)."""
    units = []
    next_new = [_NEXT_NEW_ID + 100]     # auto-increment for units not in _PINNED

    def _id_for(branch, level, name):
        key = (branch, level, name)
        if key in _PINNED:
            return _PINNED[key]
        val = next_new[0]
        next_new[0] += 1
        return val

    def add(name, parent, level, branch=0):
        uid = _id_for(branch, level, name)
        # as the real source (owner, 16 Nov 2026): UNIT_PATH is the ID path, the parent its second-to-last segment;
        # MAIN_UNIT_ID is the unit's main unit (set below), never the parent; the flag carries no meaning
        u = {'ID': uid, 'CODE': 'U%05d' % (uid - FIRST_ID), 'NAME': name, 'NAME_E': 'Unit %d' % uid,
             'SHORT_NAME': name[:40], 'MAIN_UNIT_ID': None, 'UNT_LEVEL': level,
             'UNIT_PATH': (parent['UNIT_PATH'] if parent else '') + '\\' + str(uid), 'STATUS': 1,
             'MAIN_UNIT_FLAG': 0 if uid % 97 == 0 else 1, 'HAS_SON': 0, 'DIRECTOR_POS_ID': None, 'UNT_ID': 'OU-%d' % uid,
             # not columns: the parent, and the name path people carry in ORG_UNIT_FULL_PATH
             'PARENT_ID': parent['ID'] if parent else None,
             'FULL_PATH': (parent['FULL_PATH'] + ' - ' if parent else '') + name}
        if parent:
            parent['HAS_SON'] = 1
        units.append(u)
        return u

    def add_children(parent, children, level, branch):
        for name, grandchildren in children:
            node = add(name, parent, level, branch)
            add_children(node, grandchildren, level + 1, branch)

    root = add(ROOT, None, 1, 0)
    for n, main_name, children in BRANCHES:
        l2 = add(f'Level 2-{n}', root, 2, n)
        l3 = add(f'Level 3-{n}-1', l2, 3, n)
        l4 = add(f'Level 4-{n}-1-1', l3, 4, n)
        l5 = add(f'Level 5-{n}-1-1-1', l4, 5, n)
        l6 = add(main_name, l5, 6, n)
        l6['MAIN_UNIT_ID'] = l6['ID']   # the agreed main unit is L6, not L1/L2 (UAT BUG-33): MAIN_UNIT_ID = ID
        add_children(l6, children, 7, n)
    by_id = {u['ID']: u for u in units}
    for u in units:                     # parents come first: below a main unit, point up to it; above every one, none
        if u['MAIN_UNIT_ID'] is None and u['PARENT_ID'] is not None:
            u['MAIN_UNIT_ID'] = by_id[u['PARENT_ID']]['MAIN_UNIT_ID']
    return units


if __name__ == '__main__':
    us = build_units()
    print(len(us), 'units')
    for u in us:
        print(' ' * (u['UNT_LEVEL'] - 1) * 2 + f"L{u['UNT_LEVEL']} {u['NAME']}  (id {u['ID']}, parent {u['PARENT_ID']}, main unit {u['MAIN_UNIT_ID']})")
