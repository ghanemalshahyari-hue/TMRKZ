# Sourced after env.sh, to run a journey suite on a further batch: . ops/acceptance-main/env-batch.sh b2
ACC_B="$1"
ACC_V="$(node -e "const m=JSON.parse(require('fs').readFileSync('ops/acceptance-main/.generated/run-'+JSON.parse(require('fs').readFileSync('ops/acceptance-main/.generated/current-run.json')).id+'.json'));const b=m.batches['$ACC_B'];process.stdout.write([b.ns,b.prefix,b.up,b.dy].join('|'))")"
export ACC_NS="${ACC_V%%|*}"; ACC_V="${ACC_V#*|}"; export ACC_PREFIX="${ACC_V%%|*}"; ACC_V="${ACC_V#*|}"; export ACC_USER_PREFIX="${ACC_V%%|*}"; export ACC_DY="${ACC_V#*|}"
export ACC_SUFFIX=" — اختبار قبول $(printf %s "$ACC_B" | tr a-z A-Z) — وهمي"
export POLY_UNIT="قسم الحركة أ$ACC_SUFFIX" MP_UNIT="شعبة أ4$ACC_SUFFIX" PT_UNIT="شعبة أ5$ACC_SUFFIX"
