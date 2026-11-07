# Sourced before running a suite against the loaded run on :8088. Prints no secret.
ACC_J=ops/acceptance-main/.generated/current-run.json
export ACC_NS="$(sed -n 's/.*"ns": "\(.*\)".*/\1/p' "$ACC_J")" ACC_PREFIX="$(sed -n 's/.*"prefix": "\(.*\)".*/\1/p' "$ACC_J")"
export MOVER_URL=http://localhost:8088 UI_URL=http://localhost:8088 AUTH_URL=http://localhost:8088 DB_CONTAINER=tmrkz-mover-db-1
export BROWSER_PATH="$HOME/Desktop/Google Chrome.app/Contents/MacOS/Google Chrome"
export ACC_ASK_ROLE=CHAIN_APPROVER ACC_USER=p05.req ACC_MGR=p05.req ACC_SUFFIX=' — اختبار قبول — وهمي' PB_NEW=p17.new PB_UNIT=N-A120
export POLY_UNIT='قسم الحركة أ — اختبار قبول — وهمي' MP_UNIT='شعبة أ4 — اختبار قبول — وهمي' PT_UNIT='شعبة أ5 — اختبار قبول — وهمي'
ACC_OUT="$PWD/ops/acceptance-main/.generated/evidence/$(git rev-parse --short HEAD)"
export ACC_OUT ACC_EVIDENCE="$ACC_OUT/stationing-next/"
mkdir -p "$ACC_EVIDENCE"
