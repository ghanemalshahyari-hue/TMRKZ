#!/usr/bin/env sh
# Moves one synthetic person to another unit in BOTH fake sources (owner, 20 Nov 2026; TEST_IDENTITIES.md «a transferred
# person»): the demo Oracle HR row (ORG_UNIT_*, MAIN_ORG_UNT_ID and the main unit's name follow the unit, as a real HR
# transfer does) and the synthetic directory's user (MilUnitId, MilMainUnitId, MilCurrentUnitName). TMRKZ is not touched:
# it sees the move on the person's next on-demand refresh / sign-in. Demo only.
#   sh ops/hr-demo/transfer_person.sh <login> <unit id>
set -eu
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")"
LOGIN="${1:?login}"; UNIT="${2:?unit id}"
case "$LOGIN$UNIT" in *[!A-Za-z0-9._-]*) echo "login: letters, digits, dot; unit: digits" >&2; exit 2;; esac
G=.generated
PW="$(sed -n 's/^ORACLE_HR_SCHEMA_PASSWORD=//p' "$G/oracle_hr.env")"
SCHEMA="$(sed -n 's/^ORACLE_HR_SCHEMA=//p' "$G/oracle_hr.env")"
# the unit's name path from the ID path (UNIT_PATH «\1\2\3»), the main unit from the unit itself (owner's rule)
docker exec -i -e NLS_LANG=.AL32UTF8 tmrkz-hr-demo-oracle sqlplus -s "$SCHEMA/$PW@//localhost:1521/FREEPDB1" <<EOF
WHENEVER SQLERROR EXIT SQL.SQLCODE
SET FEEDBACK OFF SERVEROUTPUT ON
DECLARE
  v_path NVARCHAR2(2000); v_name NVARCHAR2(200); v_main NUMBER; v_main_name NVARCHAR2(200); v_full NVARCHAR2(2000); n NUMBER;
BEGIN
  SELECT UNIT_PATH, NAME, MAIN_UNIT_ID INTO v_path, v_name, v_main FROM HR_UNITS_T WHERE ID = $UNIT;
  IF v_main IS NULL THEN RAISE_APPLICATION_ERROR(-20001, 'unit $UNIT is above every main unit; people cannot sit there'); END IF;
  SELECT NAME INTO v_main_name FROM HR_UNITS_T WHERE ID = v_main;
  SELECT LISTAGG(NAME, ' - ') WITHIN GROUP (ORDER BY UNT_LEVEL) INTO v_full FROM HR_UNITS_T WHERE INSTR(v_path || '\\', '\\' || ID || '\\') > 0;
  UPDATE HR_EMPLOYEES_T SET ORG_UNIT_ID = $UNIT, ORG_UNIT_NAME = v_name, ORG_UNIT_FULL_PATH = v_full,
         MAIN_ORG_UNT_ID = v_main, MAIN_ORG_UNIT_NAME = v_main_name, EMP_UNIT_STATUS_DESC = N'منقول'
   WHERE PERSON_USER_ID = '$LOGIN';
  n := SQL%ROWCOUNT;
  IF n <> 1 THEN RAISE_APPLICATION_ERROR(-20002, 'login $LOGIN: ' || n || ' rows'); END IF;
  COMMIT;
  DBMS_OUTPUT.PUT_LINE('oracle: ' || '$LOGIN' || ' now in unit ' || $UNIT || ' (main unit ' || v_main || ')');
END;
/
EXIT
EOF
# the directory: the same three attributes follow
if docker inspect -f '{{.State.Running}}' tmrkz-synthetic-ad 2>/dev/null | grep -q true; then
  docker exec -i tmrkz-hr-demo-oracle sh -c "NLS_LANG=.AL32UTF8 sqlplus -s '$SCHEMA/$PW@//localhost:1521/FREEPDB1'" <<EOF | tr -d '\r' > "$G/transfer.tmp"
SET HEADING OFF FEEDBACK OFF PAGESIZE 0 LINESIZE 4000
SELECT ORG_UNIT_ID || '|' || NVL(TO_CHAR(MAIN_ORG_UNT_ID), '') || '|' || ORG_UNIT_NAME FROM HR_EMPLOYEES_T WHERE PERSON_USER_ID = '$LOGIN';
EXIT
EOF
  python3 - "$LOGIN" "$G/transfer.tmp" <<'EOF' | docker exec -i tmrkz-synthetic-ad ldbmodify -H /var/lib/samba/private/sam.ldb >/dev/null
import base64, sys
login, path = sys.argv[1], sys.argv[2]
unit, main, name = open(path, encoding='utf-8').read().strip().split('|', 2)
b64 = lambda v: base64.b64encode(v.encode('utf-8')).decode('ascii')
print('dn: CN=%s,OU=People,DC=tmrkz,DC=test\nchangetype: modify\nreplace: MilUnitId\nMilUnitId: %s\n-\nreplace: MilMainUnitId\nMilMainUnitId: %s\n-\nreplace: MilCurrentUnitName\nMilCurrentUnitName:: %s\n-\n' % (login, unit, main, b64(name)))
EOF
  rm -f "$G/transfer.tmp"
  echo "directory: $LOGIN now carries MilUnitId $UNIT and its main unit"
else
  echo "directory: tmrkz-synthetic-ad is not running; its user was not changed (sh ops/hr-demo/synthetic-ad/up.sh, then run again)"
fi
