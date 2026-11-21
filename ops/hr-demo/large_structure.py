# -*- coding: utf-8 -*-
"""The large demo organisation (owner, 20 Nov 2026; ADR-094): «a fake Oracle HR (about 30,000 units in an irregular tree,
main units at varying depths, about 200,000 people)». Built by build_oracle_hr.py --profile large; the default profile
keeps reference_structure.py untouched.

Shape (deterministic, one seed):
  * one root at level 1; under it branches of different shapes — every branch draws its own depth (some stop at level 4,
    others reach 13–15), its own branching factor per level, its own leaf rate and its own size cap, so no branch is a
    copy of another;
  * main units by the owner's rule: MAIN_UNIT_ID = ID on a main unit, every unit below points up to it, units above every
    main unit have none. They sit at levels 4–9: from a branch's own earliest main level the chance rises with depth, a
    unit at level 9 or a leaf without a main unit above it is always one; levels 2–3 are never main;
  * UNIT_PATH is the ID path («\\1\\2\\3»), the parent its second-to-last segment; the flag column carries no meaning;
  * a short synthetic Arabic name per unit: a functional label («قيادة», «إدارة», «قسم», «شعبة», «فرع»…) and a field, mixed
    at random, not tied to depth; siblings never share a name;
  * STATUS 1 nearly everywhere, 0 on about one leaf in seventy.

IDs start at 1,000,000 (the default profile's are 100,000–300,xxx; extend_levels.py uses 990,001+); CODE is L00001….
Nothing here is a real organisation.
"""
import random

SEED = 20261120
FIRST_ID = 1_000_000
ROOT = 'القيادة العامة (تجريبي)'

LABELS = ['قيادة', 'إدارة', 'قسم', 'شعبة', 'فرع', 'مركز', 'مكتب', 'وحدة', 'مجموعة', 'كتيبة', 'سرية', 'جناح', 'فريق',
          'مديرية', 'لواء', 'فصيل', 'محطة', 'ورشة', 'مستودع', 'معهد']
FIELDS = ['العمليات', 'الإمداد', 'التدريب', 'الاتصالات', 'الهندسة', 'الصيانة', 'الشؤون الإدارية', 'المالية', 'التخطيط',
          'الأمن', 'النقل', 'الخدمات الطبية', 'التقنية', 'الجودة', 'الأفراد', 'المستودعات', 'الإطفاء', 'الإنقاذ', 'الدعم',
          'الرقابة', 'المشاريع', 'الأرشيف', 'التموين', 'الآليات', 'الطيران', 'الإشارة', 'الحراسة', 'المساحة', 'الأرصاد',
          'التوثيق', 'الاستقبال', 'التفتيش', 'السلامة', 'المختبرات', 'البحث', 'التطوير', 'الذخيرة', 'الوقود', 'المياه',
          'الكهرباء', 'الطاقة', 'البيئة', 'الإسكان', 'المراسم', 'الترجمة', 'النشر', 'المحاكاة', 'الملاحة', 'الرادار']
AR_DIGITS = str.maketrans('0123456789', '٠١٢٣٤٥٦٧٨٩')


def build_units(target=30_000, seed=SEED):
    """Return the units as dicts with the HR_ENV_UNITS_AI columns the builder loads (ID, CODE, NAME, NAME_E, SHORT_NAME,
    MAIN_UNIT_ID, UNT_LEVEL, UNIT_PATH, STATUS, MAIN_UNIT_FLAG, HAS_SON, DIRECTOR_POS_ID, UNT_ID) plus PARENT_ID and the
    name path FULL_PATH (not columns), in creation order (parents before children)."""
    rnd = random.Random(seed)
    units = []
    children_of = {}
    branching = set()                                   # the units that get children (decided when they are created)

    def add(name, parent, level, will_branch):
        uid = FIRST_ID + len(units)
        u = {'ID': uid, 'CODE': 'L%05d' % (uid - FIRST_ID), 'NAME': name, 'NAME_E': 'Unit %d' % uid,
             'SHORT_NAME': name[:40], 'MAIN_UNIT_ID': None, 'UNT_LEVEL': level,
             'UNIT_PATH': (parent['UNIT_PATH'] if parent else '') + '\\' + str(uid), 'STATUS': 1,
             'MAIN_UNIT_FLAG': 0 if uid % 97 == 0 else 1, 'HAS_SON': 0, 'DIRECTOR_POS_ID': None, 'UNT_ID': 'OU-%d' % uid,
             'PARENT_ID': parent['ID'] if parent else None,
             'FULL_PATH': (parent['FULL_PATH'] + ' - ' if parent else '') + name}
        if parent:
            parent['HAS_SON'] = 1
            children_of.setdefault(parent['ID'], []).append(u)
            above = parent['MAIN_UNIT_ID']
            if above is not None:                       # below a main unit: point up to it
                u['MAIN_UNIT_ID'] = above
            elif level >= 4 and (level >= 9 or not will_branch or rnd.random() < main_chance(level)):
                u['MAIN_UNIT_ID'] = uid                 # a main unit points to itself
        units.append(u)
        if will_branch:
            branching.add(uid)
        return u

    def unit_name(parent):
        taken = {c['NAME'] for c in children_of.get(parent['ID'], [])}
        for _ in range(40):
            name = f'{rnd.choice(LABELS)} {rnd.choice(FIELDS)}'
            if rnd.random() < 0.25:
                name += ' ' + str(rnd.randint(1, 12)).translate(AR_DIGITS)
            if name not in taken:
                return name
        return f'{rnd.choice(LABELS)} {rnd.choice(FIELDS)} {len(taken) + 1}'.translate(AR_DIGITS)

    root = add(ROOT, None, 1, True)
    branch = 0
    while len(units) < target:
        branch += 1
        depth = rnd.choice([4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 11, 12, 13, 13, 14, 15, 15, 15])
        style = {
            'depth': depth,
            # deep branches are narrow, shallow ones wide; the fan shrinks with depth at the branch's own rate
            'fan': rnd.uniform(1.5, 2.6) if depth >= 12 else rnd.uniform(2.2, 4.2) if depth >= 8 else rnd.uniform(3.0, 6.5),
            'decay': rnd.uniform(0.72, 0.97),
            'leaf': rnd.uniform(0.04, 0.30),
            'cap': min(rnd.randint(300, 6000), target - len(units)),
            'main_from': rnd.randint(4, min(9, depth)),
        }
        main_chance = (lambda s: lambda level: 0.8 if level == s['main_from'] else 1.0
                       if level >= s['main_from'] else 0.0)(style)
        count = 1
        level_nodes = [add(unit_name(root), root, 2, True)]
        for level in range(2, depth):
            next_nodes = []
            for node in level_nodes:
                for _ in range(fan_out(rnd, style, level)):
                    if count >= style['cap']:
                        break
                    child_level = level + 1
                    # a unit down to the branch's earliest main level never stops; below it a unit may, at the branch's own leaf rate
                    will_branch = child_level < depth and (child_level <= style['main_from'] or rnd.random() >= leaf_rate(style, child_level))
                    next_nodes.append(add(unit_name(node), node, child_level, will_branch))
                    count += 1
            level_nodes = [n for n in next_nodes if n['ID'] in branching]
            if not level_nodes:
                break
        # the cap or the leaf rate may leave a unit at level 4–8 without a main unit above and no children:
        # it is then a main unit itself, so every unit people can sit in has one (owner's rule holds)
    for u in units:
        if u['UNT_LEVEL'] >= 4 and u['MAIN_UNIT_ID'] is None and u['ID'] not in children_of:
            u['MAIN_UNIT_ID'] = u['ID']
        if u['UNT_LEVEL'] >= 4 and u['ID'] not in children_of and rnd.random() < 1 / 70:
            u['STATUS'] = 0
    return units


def fan_out(rnd, style, level):
    """How many children a unit that branches at this level gets in this branch: narrow above the branch's main units,
    the branch's own fan from there on, shrinking with depth at its own rate."""
    if level == 2:
        return rnd.randint(2, 6)
    if level < style['main_from']:
        return rnd.randint(1, 3 if style['main_from'] <= 6 else 2)
    mean = style['fan'] * style['decay'] ** (level - style['main_from'])
    return max(1, min(12, int(round(rnd.gauss(mean, mean * 0.5)))))


def leaf_rate(style, level):
    return min(0.75, style['leaf'] * (1 + 0.18 * max(0, level - 4)))


if __name__ == '__main__':
    import collections
    us = build_units()
    by_level = collections.Counter(u['UNT_LEVEL'] for u in us)
    mains = collections.Counter(u['UNT_LEVEL'] for u in us if u['MAIN_UNIT_ID'] == u['ID'])
    print(len(us), 'units;', sum(1 for u in us if u['STATUS'] == 0), 'inactive')
    print('per level :', dict(sorted(by_level.items())))
    print('main units:', dict(sorted(mains.items())))
    print('level>=4 without main:', sum(1 for u in us if u['UNT_LEVEL'] >= 4 and u['MAIN_UNIT_ID'] is None))
