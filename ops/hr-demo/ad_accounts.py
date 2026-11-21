#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""The demo Oracle HR's people as accounts of the synthetic enterprise directory (owner, 20 Nov 2026; ADR-094: «a fake
directory holding the same people (username, name, rank, number, unit, main unit)»), the Samba AD «tmrkz-synthetic-ad»
of ops/hr-demo/synthetic-ad (profile synthetic-enterprise — development and acceptance only).

Two steps, both from ops/hr-demo/synthetic-ad/load.sh:
  generate [--limit N | --all]   reads the SAME generated people from the demo Oracle (the builder's env file and
                                 connection; runs in the builder's python container on the isolated network) and writes
                                 .generated/ad-people.ldif — the first N people in PRS_ID order (default 20000), or all
  load                           puts the LDIF into the container and adds it to sam.ldb with ldbadd in batches of 5,000
                                 (the bulk way: samba-tool would take seconds per user); people already there are
                                 skipped; prints rate and totals

One user per person, in OU=People,DC=tmrkz,DC=test, CN = the login:
  sAMAccountName     PERSON_USER_ID          userPrincipalName    PERSON_USER_ID@tmrkz.test
  displayName        FULL_NAME               givenName / sn       FIRST_NAME / the family name
  employeeNumber     NEW_MIL_NO              MilNumber            NEW_MIL_NO
  MilLegacyNumber    MIL_NUMBER              MilRankName          GRADE_NAME (rank)
  MilOccupation      EMP_POSITION_DESC       MilCurrentUnitName   ORG_UNIT_NAME
  MilUnitId          ORG_UNIT_ID             MilMainUnitId        MAIN_ORG_UNT_ID
  userAccountControl 512 (normal) — 514 (disabled) for a person not in service
  unicodePwd         ONE test password for all, generated once into .generated/ad-people-password (never committed)
objectGUID, set by the directory, is the stable UUID TMRKZ reads (preset «Active Directory» in «إعدادات التكامل»).

The password goes in as its NT hash (MD4 of UTF-16LE) with Samba's bypass_password_hash control (OID
1.3.6.1.4.1.7165.4.3.12, the way Samba's own join/replication writes accounts) and an explicit pwdLastSet. Measured on
20 Nov 2026: the clear-text way (Samba deriving Kerberos keys per user) gives ~60 users/s, 55 minutes for 200,000; the
hash way ~770 users/s, under 5 minutes. A simple bind over LDAPS checks the NT hash, so sign-in works and a wrong password
is refused (error 49); only Kerberos keys are absent, which TMRKZ never uses. Demo only.
"""
import argparse
import base64
import os
import secrets
import subprocess
import sys
import time

import struct

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
GENERATED = os.path.join(HERE, '.generated')
LDIF = os.path.join(GENERATED, 'ad-people.ldif')
PASSWORD_FILE = os.path.join(GENERATED, 'ad-people-password')
CONTAINER = 'tmrkz-synthetic-ad'
SAM = '/var/lib/samba/private/sam.ldb'
BASE = 'DC=tmrkz,DC=test'
PEOPLE = 'OU=People,' + BASE
REALM = 'tmrkz.test'
BATCH = 5000
BYPASS_HASH = '--controls=local_oid:1.3.6.1.4.1.7165.4.3.12:0'     # DSDB_CONTROL_BYPASS_PASSWORD_HASH_OID

QUERY = """SELECT PERSON_USER_ID, FULL_NAME, FIRST_NAME, NEW_MIL_NO, MIL_NUMBER, GRADE_NAME, EMP_POSITION_DESC,
                  ORG_UNIT_ID, ORG_UNIT_NAME, MAIN_ORG_UNT_ID, EMP_STATUS_DESC
           FROM HR_PRS_EMPLOYEES_ALL
           WHERE PERSON_USER_ID IS NOT NULL AND NEW_MIL_NO IS NOT NULL
           ORDER BY PRS_ID"""


def password():
    """One test password for every synthetic account, generated once (as the acceptance scripts do)."""
    os.makedirs(GENERATED, exist_ok=True)
    if not os.path.isfile(PASSWORD_FILE):
        fd = os.open(PASSWORD_FILE, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            f.write('Ad9-' + secrets.token_urlsafe(14))
    return open(PASSWORD_FILE, encoding='utf-8').read().strip()


def md4(data):
    """MD4 (RFC 1320) in plain Python: OpenSSL 3 no longer offers it, and the NT hash is MD4 of the UTF-16LE password."""
    def f(x, y, z): return (x & y) | (~x & z)
    def g(x, y, z): return (x & y) | (x & z) | (y & z)
    def h(x, y, z): return x ^ y ^ z
    def rol(x, n): return ((x << n) | (x >> (32 - n))) & 0xffffffff
    msg = bytearray(data)
    bits = len(data) * 8
    msg.append(0x80)
    while len(msg) % 64 != 56:
        msg.append(0)
    msg += struct.pack('<Q', bits)
    a0, b0, c0, d0 = 0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476
    for off in range(0, len(msg), 64):
        x = list(struct.unpack('<16I', msg[off:off + 64]))
        a, b, c, d = a0, b0, c0, d0
        for i in range(16):
            a, b, c, d = d, rol((a + f(b, c, d) + x[i]) & 0xffffffff, [3, 7, 11, 19][i % 4]), b, c
        for i in range(16):
            a, b, c, d = d, rol((a + g(b, c, d) + x[(i % 4) * 4 + i // 4] + 0x5a827999) & 0xffffffff, [3, 5, 9, 13][i % 4]), b, c
        for i in range(16):
            k = [0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15][i]
            a, b, c, d = d, rol((a + h(b, c, d) + x[k] + 0x6ed9eba1) & 0xffffffff, [3, 9, 11, 15][i % 4]), b, c
        a0, b0, c0, d0 = (a0 + a) & 0xffffffff, (b0 + b) & 0xffffffff, (c0 + c) & 0xffffffff, (d0 + d) & 0xffffffff
    return struct.pack('<4I', a0, b0, c0, d0)


assert md4(b'').hex() == '31d6cfe0d16ae931b73c59d7e0c089c0'


def nt_hash_b64(pw):
    return base64.b64encode(md4(pw.encode('utf-16-le'))).decode('ascii')


def nt_now():
    """Windows FILETIME of now, for pwdLastSet (0 would mean «must change the password at next sign-in»)."""
    return (int(time.time()) + 11644473600) * 10_000_000


def attr(name, value):
    """One LDIF attribute line: base64 («::») when the value is not safe ASCII (RFC 2849)."""
    v = str(value)
    safe = v.isascii() and v != '' and v[0] not in ' :<' and '\n' not in v and '\r' not in v
    return '%s: %s' % (name, v) if safe else '%s:: %s' % (name, base64.b64encode(v.encode('utf-8')).decode('ascii'))


def entry(row, nt_hash, pwd_last_set):
    uid, full, first, new_mil, mil, rank, position, unit_id, unit_name, main_id, status = row
    uid = uid.strip()
    lines = ['dn: CN=%s,%s' % (uid, PEOPLE), 'objectClass: top', 'objectClass: person', 'objectClass: organizationalPerson',
             'objectClass: user', attr('cn', uid), attr('sAMAccountName', uid), attr('userPrincipalName', uid + '@' + REALM),
             attr('displayName', full), attr('givenName', first), attr('sn', full.split()[-1]),
             attr('employeeNumber', new_mil), attr('MilNumber', new_mil), attr('MilLegacyNumber', mil),
             attr('MilRankName', rank), attr('MilOccupation', position), attr('MilCurrentUnitName', unit_name),
             attr('MilUnitId', int(unit_id))]
    if main_id is not None:
        lines.append(attr('MilMainUnitId', int(main_id)))
    lines.append('userAccountControl: %d' % (512 if status == 'في الخدمة' else 514))
    lines.append('pwdLastSet: %d' % pwd_last_set)
    lines.append('unicodePwd:: ' + nt_hash)
    return '\n'.join(lines) + '\n\n'


def generate(a):
    import oracledb  # noqa: F401  (the builder's driver, present in its container)
    from build_oracle_hr import connect, load_env
    env = load_env()
    nt_hash, pwd_last_set = nt_hash_b64(password()), nt_now()
    conn = connect(env, env['ORACLE_MOVER_USER'], env['ORACLE_MOVER_PASSWORD'])
    cur = conn.cursor()
    cur.arraysize = 5000
    if a.all:
        cur.execute(QUERY)
    else:
        cur.execute('SELECT * FROM (%s) WHERE ROWNUM <= :n' % QUERY, n=a.limit)
    n = disabled = 0
    with open(LDIF, 'w', encoding='utf-8') as out:
        out.write('# synthetic accounts of the demo Oracle HR (ops/hr-demo/ad_accounts.py) — one test password; demo only\n\n')
        for row in cur:
            out.write(entry(row, nt_hash, pwd_last_set))
            n += 1
            disabled += row[10] != 'في الخدمة'
    conn.close()
    print('[ad] %d users written to %s (%d disabled: not in service); the password is in %s'
          % (n, os.path.relpath(LDIF, HERE), disabled, os.path.relpath(PASSWORD_FILE, HERE)))


def sh(args, **kw):
    return subprocess.run(args, check=True, capture_output=True, text=True, **kw).stdout


def existing_logins(logins):
    """Which of these logins already exist in the directory — one search per login by its indexed sAMAccountName. Listing
    OU=People scales badly at hundreds of thousands of users, even over LDAP: lookups by the key remain fast and flat."""
    if not logins:
        return set()
    out, keep = set(), []
    for i in range(0, len(logins), 1000):
        chunk = logins[i:i + 1000]
        exp = '(|' + ''.join('(sAMAccountName=%s)' % u for u in chunk) + ')'
        res = sh(['docker', 'exec', CONTAINER, 'ldbsearch', '-H', SAM, exp, 'sAMAccountName'])
        for line in res.splitlines():
            if line.startswith('sAMAccountName: '):
                out.add(line[len('sAMAccountName: '):].strip())
    return out


def load(a):
    if not os.path.isfile(LDIF):
        sys.exit('[ad] no %s — run generate first' % LDIF)
    entries = [e for e in open(LDIF, encoding='utf-8').read().split('\n\n') if e.strip() and not e.startswith('#')]
    logins = [e.split('\n', 1)[0][len('dn: CN='):].split(',', 1)[0] for e in entries]
    had = existing_logins(logins)
    todo = [e for e, u in zip(entries, logins) if u not in had]
    print('[ad] %d users in the LDIF, %d already in the directory, %d to add' % (len(entries), len(entries) - len(todo), len(todo)))
    t0 = time.time()
    done = 0
    remote = '/tmp/ad-people'
    sh(['docker', 'exec', CONTAINER, 'mkdir', '-p', remote])
    for i in range(0, len(todo), BATCH):
        batch = '\n\n'.join(todo[i:i + BATCH]) + '\n'
        part = os.path.join(GENERATED, 'ad-people.part.ldif')
        with open(part, 'w', encoding='utf-8') as f:
            f.write(batch)
        sh(['docker', 'cp', part, '%s:%s/part.ldif' % (CONTAINER, remote)])
        t1 = time.time()
        try:
            sh(['docker', 'exec', CONTAINER, 'ldbadd', '-H', SAM, BYPASS_HASH, remote + '/part.ldif'])
        except subprocess.CalledProcessError as exc:
            sys.exit('[ad] ldbadd failed in batch %d: %s' % (i // BATCH + 1, (exc.stderr or exc.stdout).strip()[-400:]))
        done += len(todo[i:i + BATCH])
        print('  batch %d: %d users in %.1fs (%.0f/s); %d of %d'
              % (i // BATCH + 1, len(todo[i:i + BATCH]), time.time() - t1, len(todo[i:i + BATCH]) / max(time.time() - t1, 0.001), done, len(todo)))
        os.remove(part)
    sh(['docker', 'exec', CONTAINER, 'rm', '-rf', remote])
    elapsed = time.time() - t0
    print('[ad] added %d users in %.0fs (%.0f/s)' % (done, elapsed, done / max(elapsed, 0.001)))


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)
    g = sub.add_parser('generate', help='write the LDIF from the demo Oracle')
    x = g.add_mutually_exclusive_group()
    x.add_argument('--limit', type=int, default=20000, help='the first N people in PRS_ID order (default 20000)')
    x.add_argument('--all', action='store_true', help='every person')
    sub.add_parser('load', help='add the LDIF to the directory (ldbadd in batches; existing users skipped)')
    a = ap.parse_args()
    generate(a) if a.cmd == 'generate' else load(a)


if __name__ == '__main__':
    main()
