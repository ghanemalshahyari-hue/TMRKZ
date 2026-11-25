"""Builds the self-contained delivery guide (ADR-105): docs/guide/TMRKZ_FINAL_DELIVERY_GUIDE.html.

  python tests/acceptance/delivery-guide.py <config.json>

The config names the evidence folders of the acceptance runs (fictional data, throw-away installation tmrkz-vmsim), the test
summaries and the commit. Screenshots are embedded (base64), so the one HTML file works offline on any machine. Standard
library only.
"""
import base64
import html
import json
import os
import re
import sys

cfg = json.load(open(sys.argv[1], encoding='utf-8'))
E = html.escape


def ar(text):
    return f'<span lang="ar" dir="rtl">{E(text)}</span>'


def img(path, caption, wide=False):
    if not path or not os.path.exists(path):
        return f'<p class="missing">(screenshot not produced: {E(os.path.basename(path or "?"))})</p>'
    data = base64.b64encode(open(path, 'rb').read()).decode('ascii')
    return (f'<figure class="{"wide" if wide else ""}"><img alt="{E(caption)}" src="data:image/png;base64,{data}">'
            f'<figcaption>{caption}</figcaption></figure>')


def results(path):
    if not path or not os.path.exists(path):
        return []
    return json.load(open(path, encoding='utf-8')).get('results', [])


def result_table(rows, title):
    if not rows:
        return f'<p class="missing">No results file for {E(title)}.</p>'
    passed = sum(1 for r in rows if r['pass'])
    out = [f'<p class="summary"><b>{passed}/{len(rows)}</b> checks passed — {E(title)}</p>',
           '<table class="results"><thead><tr><th>Check</th><th>What was verified</th><th>Result</th></tr></thead><tbody>']
    for r in rows:
        out.append(f'<tr><td class="mono">{E(r["id"])}</td><td>{E(r["label"])}'
                   + (f'<div class="detail">{E(r.get("extra", ""))}</div>' if r.get('extra') else '')
                   + f'</td><td>{pill("PASS" if r["pass"] else "FAIL")}</td></tr>')
    out.append('</tbody></table>')
    return '\n'.join(out)


def pill(state):
    cls = {'PASS': 'ok', 'Done': 'ok', 'Verified (simulated VM)': 'ok', 'FAIL': 'bad', 'OPEN': 'warn', 'Pending VM': 'warn',
           'Open': 'warn', 'Dev only': 'info'}.get(state, 'info')
    return f'<span class="pill {cls}">{E(state)}</span>'


def code(text):
    return f'<pre><code>{E(text.strip())}</code></pre>'


def read(path):
    return open(path, encoding='utf-8').read() if path and os.path.exists(path) else ''


V = cfg['vmsim']
EV = os.path.join(V, 'evidence')
ER = os.path.join(V, 'evidence-release')
EU = os.path.join(V, 'evidence-ui')
uc = results(os.path.join(EV, 'results.json'))
rel = results(os.path.join(ER, 'results.json'))
ui = results(os.path.join(EU, 'results.json'))
ui_timings = {}
if os.path.exists(os.path.join(EU, 'results.json')):
    ui_timings = json.load(open(os.path.join(EU, 'results.json'), encoding='utf-8')).get('timings', {}).get('summary', {})
boot = read(cfg.get('bootstrapLog'))
boot_rows = [{'id': m.group(2).split(' ')[0], 'label': m.group(2), 'pass': m.group(1) == 'PASS', 'extra': ''}
             for m in re.finditer(r'^(PASS|FAIL)\s+(.*)$', boot, re.M)]
sums = read(cfg.get('bootstrapSums'))
install = read(cfg.get('bootstrapInstall'))
classification = read(cfg.get('classification'))


def all_pass(rows, prefix):
    sel = [r for r in rows if r['id'].startswith(prefix)]
    return bool(sel) and all(r['pass'] for r in sel), sel


def state_of(rows_lists, prefixes):
    sel = [r for rows in rows_lists for r in rows for p in prefixes if r['id'].startswith(p)]
    if not sel:
        return 'OPEN'
    return 'PASS' if all(r['pass'] for r in sel) else 'FAIL'


matrix = [
    ('1. Repository integrity', 'All 2 142 tracked documentation files present; 0 tracked files deleted since e30c1c1; the 95 recovered audit-evidence files kept (local, never pushed); no private key, credential or production data tracked.', 'PASS' if cfg.get('repoIntegrity') else 'FAIL', 'git ls-files; git diff --name-status e30c1c1 HEAD'),
    ('2. Certificate management', 'Inventory of the folders in use; import (PEM/DER/P7B/PFX, from files or from certs/); chain, expiry, host name, key matching; per-service trust (https, directory, Keycloak); preview, explicit application, health check, automatic and requested restore; keys never exposed.', state_of([rel], ['CRT-']), 'CertificateInspectorTest, CertificateCenterIT, CRT-E1…E5'),
    ('3. ENV import', 'Compatible file recognised and mapped; conflicts and missing values shown; never-imported values named only; tested before applied; .env never written.', state_of([rel], ['ENV-']), 'IntegrationImportIT, ENV-E1…E3'),
    ('4. Administrator lookup', 'Before a first sign-in: service account, or the administrator\'s own directory password for that search; limitation explained otherwise; confirmation, least privilege, audit, duplicate and last-admin protection.', state_of([rel], ['ADM-']), 'AdministratorDirectoryLookupIT, AdministratorOwnLookupIT, ADM-E1…E3'),
    ('5. 18 failing tests', '18 obsolete expectations (ADR-095 / posture summary) updated without weakening checks; 0 application defects among them. Open: 1 separate defect (FYI designations) and 20 further pre-existing backend failures the full suite found, identical on 8800b58 (PRE-EXISTING-OTHERS.md).', 'PASS' if cfg.get('regression18Pass') else 'FAIL', 'docs/evidence/regression-18/CLASSIFICATION.md'),
    ('6. Update Center security', 'Signed release, tampering, unauthorised users, interrupted upload, conflicting change, failed build, disk space, service failure with automatic rollback, application restart, no Docker access or command execution, signing key on the development machine only.', state_of([uc, rel], ['UC-']), 'update-center.mjs UC-00…UC-11, release-acceptance.mjs UC-12…UC-19'),
    ('7. UI and map', 'Seven window sizes and scalings, navigation, loading states, error messages; map pointer alignment at browser zoom 100–200 % and display scaling 125–150 %. Development-machine measurements only.', state_of([ui], ['UI-', 'MAP-']), 'ui-regression.mjs'),
    ('8. Delivery', 'Same folder and runtime for development, test and deployment; no new dependency, image, PowerShell or permanent folder; minimal bootstrap package with checksums, instructions and recovery.', state_of([[*boot_rows]], ['BS-']), 'bootstrap-test.sh BS-01…BS-05'),
]

css = """
:root{--ink:#1d2433;--muted:#5d6678;--line:#e3e6ec;--bg:#f7f8fa;--card:#fff;--accent:#1f6f5c;--ok:#1d7a46;--okbg:#e5f4ea;
--bad:#b42318;--badbg:#fde8e6;--warn:#9a6700;--warnbg:#fff4d6;--info:#2a5db0;--infobg:#e7efff}
*{box-sizing:border-box}body{margin:0;font:15px/1.6 "Segoe UI",Tahoma,"Noto Sans Arabic",Arial,sans-serif;color:var(--ink);background:var(--bg)}
header.top{background:#0f2f28;color:#fff;padding:28px 40px}header.top h1{margin:0 0 6px;font-size:26px}header.top p{margin:2px 0;color:#cfe3dc}
.layout{display:grid;grid-template-columns:260px 1fr;gap:0;max-width:1400px;margin:0 auto}
nav.toc{position:sticky;top:0;align-self:start;height:100vh;overflow:auto;padding:20px 18px;border-right:1px solid var(--line);background:#fff}
nav.toc a{display:block;color:var(--ink);text-decoration:none;padding:4px 6px;border-radius:6px;font-size:14px}nav.toc a:hover{background:var(--bg)}
main{padding:24px 40px 80px;min-width:0}section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:22px 26px;margin:0 0 22px}
h2{margin:0 0 12px;font-size:21px;color:#0f2f28}h3{margin:18px 0 8px;font-size:17px}
pre{background:#0f172a;color:#e2e8f0;padding:14px 16px;border-radius:8px;overflow:auto;font:13px/1.5 Consolas,"Cascadia Mono",monospace;direction:ltr;text-align:left}
code{font-family:Consolas,"Cascadia Mono",monospace;font-size:13px}p code,li code,td code{background:#eef1f5;padding:1px 5px;border-radius:4px}
table{border-collapse:collapse;width:100%;margin:8px 0 14px;font-size:14px}th,td{border-bottom:1px solid var(--line);padding:7px 9px;text-align:left;vertical-align:top}
th{background:#f1f3f6;font-weight:600}.mono{font-family:Consolas,monospace;white-space:nowrap}.detail{color:var(--muted);font-size:12px;word-break:break-word}
.pill{display:inline-block;padding:1px 10px;border-radius:999px;font-size:12px;font-weight:600;white-space:nowrap}
.pill.ok{background:var(--okbg);color:var(--ok)}.pill.bad{background:var(--badbg);color:var(--bad)}.pill.warn{background:var(--warnbg);color:var(--warn)}.pill.info{background:var(--infobg);color:var(--info)}
.note{border-left:4px solid var(--warn);background:var(--warnbg);padding:10px 14px;border-radius:6px;margin:10px 0}
.good{border-left:4px solid var(--ok);background:var(--okbg);padding:10px 14px;border-radius:6px;margin:10px 0}
.steps{counter-reset:s;list-style:none;padding:0}.steps>li{counter-increment:s;position:relative;padding:4px 0 10px 40px}
.steps>li:before{content:counter(s);position:absolute;left:0;top:4px;width:26px;height:26px;border-radius:50%;background:var(--accent);color:#fff;text-align:center;font-weight:700;line-height:26px}
figure{margin:12px 0 18px;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:#fff}figure img{display:block;max-width:100%;height:auto;margin:0 auto}
figcaption{padding:8px 12px;font-size:13px;color:var(--muted);border-top:1px solid var(--line);background:#fafbfc}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.summary{font-size:15px}.missing{color:var(--bad)}[dir=rtl]{unicode-bidi:isolate}
@media (max-width:900px){.layout{grid-template-columns:1fr}nav.toc{position:static;height:auto;border-right:0}.grid2,.grid3{grid-template-columns:1fr}main{padding:16px}}
@media print{nav.toc{display:none}.layout{grid-template-columns:1fr}section{break-inside:avoid-page}}
"""

S = []
toc = []


def section(sid, title, body):
    toc.append((sid, title))
    S.append(f'<section id="{sid}"><h2>{E(title)}</h2>{body}</section>')


commit = E(cfg.get('commit', ''))
section('status', 'Status at a glance', f"""
<p>This guide covers the owner's brief <b>“TMRKZ — Final Completion and Release Acceptance”</b> (25 Nov 2026), built on ADR-103 and
ADR-104 (commit <code>8800b58</code>) and delivered as <b>ADR-105</b> in commit <code>{commit}</code> on <code>main</code>.</p>
<div class="note"><b>Not yet production-accepted.</b> Everything below was tested on the development PC and on a throw-away
installation laid out exactly like the VM's <code>/data/TMRKZ</code> (Compose project <code>tmrkz-vmsim</code>, fictional data). The real
VM has not been touched. Production acceptance needs the VM checks in <a href="#verify">Step 3</a> to pass.</div>
<table><thead><tr><th>Brief item</th><th>What was done</th><th>Development / simulated VM</th><th>Real VM</th><th>Evidence</th></tr></thead><tbody>
{''.join(f'<tr><td><b>{E(a)}</b></td><td>{E(b)}</td><td>{pill(c)}</td><td>{pill("n/a") if a[0] in "15" else pill("Pending VM")}</td><td class="detail">{E(d)}</td></tr>' for a, b, c, d in matrix)}
</tbody></table>
<h3>Automated test totals</h3>
<table><tbody>
<tr><td>Backend (real PostgreSQL + PostGIS, OpenFGA in the loop)</td><td>{E(cfg.get('backendSummary', ''))}</td></tr>
<tr><td>Frontend unit tests and production build</td><td>{E(cfg.get('frontendSummary', ''))}</td></tr>
<tr><td>Update Center end to end (browser)</td><td>{sum(r['pass'] for r in uc)}/{len(uc)}</td></tr>
<tr><td>Release acceptance end to end (browser)</td><td>{sum(r['pass'] for r in rel)}/{len(rel)}</td></tr>
<tr><td>UI regression and map alignment (browser)</td><td>{sum(r['pass'] for r in ui)}/{len(ui)}</td></tr>
<tr><td>Bootstrap package</td><td>{sum(r['pass'] for r in boot_rows)}/{len(boot_rows)}</td></tr>
</tbody></table>
""")

section('transfer', 'What to transfer, what never to touch, what is unnecessary', """
<table><thead><tr><th></th><th>Paths</th></tr></thead><tbody>
<tr><td>{}</td><td>Once, by PAM: the folder <code>release\\bootstrap\\</code> made on the development PC (about 3&nbsp;MB). Afterwards nothing by PAM:
routine updates are chosen in the browser from the same TMRKZ folder.</td></tr>
<tr><td>{}</td><td><code>.env</code>, <code>certs/</code>, <code>data/</code>, <code>backups/</code>, <code>map-data/</code>, <code>map-runtime/</code>,
<code>ops/local/.generated/</code> (except the public key, installed once), <code>docker-compose.dc-hosts.yml</code> and any other
<code>docker-compose.*.yml</code>, <code>tmrkz-images.tar</code>. Enforced three times: the release rules, the maintenance worker's
hard-coded list, and the bootstrap script.</td></tr>
<tr><td>{}</td><td><code>tests/</code>, <code>backend/src/test/</code>, <code>prototypes/</code>, <code>docs/audit/</code>, <code>docs/evidence/</code>, <code>.github/</code>,
<code>.vscode/</code>, <code>.zcode/</code>, <code>AGENTS.md</code>, <code>CLAUDE.md</code>, <code>release/</code> (except the bootstrap folder once),
and <b>never</b> <code>ops\\local\\.generated\\release-signing.key</code> — the signing key stays on the development PC.</td></tr>
</tbody></table>
<p>No new library, no new Docker image, no PowerShell, no second application folder: the VM runs the same folder, the same images,
the same <code>start.sh</code> and the same mounts; only <code>.env</code>, addresses, credentials, certificates and data differ.</p>
""".format(pill('Transfer'), pill('Never touch'), pill('Unnecessary')))

section('devpc', 'Step 1 — on the development PC (Windows CMD)', f"""
<ol class="steps">
<li>Open <b>Command Prompt</b> (not PowerShell) in the TMRKZ folder and make the signing key once (it is never copied anywhere):
{code(r'cd %USERPROFILE%\Desktop\TMRKZ' + chr(10) + r'"C:\Program Files\Git\bin\sh.exe" ops/update/make-release.sh --init-key')}</li>
<li>Build the minimal bootstrap for a VM running the 24 Nov update (commit <code>e30c1c1</code>):
{code(r'"C:\Program Files\Git\bin\sh.exe" ops/update/make-release.sh --bootstrap e30c1c1')}
It prints <code>bootstrap package: release/bootstrap (… files, … KB tar, … removals listed)</code>.</li>
<li>Copy <b>only</b> the folder <code>release\\bootstrap\\</code> to the VM through PAM (e.g. as <code>/data/tmrkz-bootstrap/</code>).</li>
</ol>
<h3>The package as built for this delivery</h3>
{code(install) if install else '<p class="missing">INSTALL.txt not found</p>'}
<h3>Its checksums (SHA256SUMS)</h3>
{code(sums) if sums else '<p class="missing">SHA256SUMS not found</p>'}
""")

section('vm', 'Step 2 — on the VM (Ubuntu, through PAM, once)', f"""
<ol class="steps">
<li>Read-only preview — verifies the checksums and the release signature, lists the files to replace and add, and prints the
Compose differences line by line. It changes nothing:
{code('cd /data/tmrkz-bootstrap' + chr(10) + 'sh bootstrap.sh check /data/TMRKZ')}</li>
<li>If the Compose diff shows only the Update Center additions (service <code>maintenance</code>, volume <code>update-staging</code>, the
<code>update-staging:/update</code> line of <code>backend</code>, the certificate watcher of <code>proxy</code>), apply with them; otherwise
apply without <code>--with-config</code> and add those parts by hand:
{code('sh bootstrap.sh apply /data/TMRKZ --with-config')}
Every file it writes is first copied to <code>backups/bootstrap/&lt;time&gt;/</code>. It installs only the <b>public</b> key
<code>ops/local/.generated/release-trust.pub</code> and refuses if another key is already trusted.</li>
<li>Make sure the VM's own Compose file is used (once, in <code>.env</code>), then restart with the images already loaded:
{code('COMPOSE_PATH_SEPARATOR=:' + chr(10) + 'COMPOSE_FILE=docker-compose.yml:docker-compose.override.yml:docker-compose.dc-hosts.yml')}
{code('cd /data/TMRKZ && sh start.sh')}
<code>start.sh</code> needs no <code>tmrkz-images.tar</code> when the images are loaded and stops (instead of silently leaving it out)
if a <code>docker-compose.*.yml</code> is not named in <code>COMPOSE_FILE</code>.</li>
<li>Undo, if anything is wrong:
{code('sh /data/tmrkz-bootstrap/bootstrap.sh restore /data/TMRKZ/backups/bootstrap/<time printed by apply>' + chr(10) + 'cd /data/TMRKZ && sh start.sh')}</li>
</ol>
<h3>Rehearsal on a copy of an e30c1c1 installation</h3>
{result_table(boot_rows, 'bootstrap-test.sh (check is read-only; protected files byte-identical; restore exact; altered and forged packages refused)')}
""")

section('verify', 'Step 3 — read-only VM verification (send the output back)', f"""
{code('cd /data/TMRKZ' + chr(10) + 'sh ops/diagnose.sh --logins u123456,aeda123456 > /tmp/tmrkz-diagnose.txt')}
<p><code>ops/diagnose.sh</code> only reads (the database session is read-only) and masks names, addresses and secrets. It answers:
the Compose files in use, services and images, folders, the installed release and baseline, whether a source edit was compiled,
mounts, certificates and their expiry, the database, the authorisation mirror (rows edited by hand), identities, HR sync, units and
recent errors.</p>
<h3>Then in the browser, as a global administrator — the VM acceptance checklist</h3>
<table><thead><tr><th>#</th><th>Check on the VM</th><th>Expected</th></tr></thead><tbody>
<tr><td>V1</td><td>{ar('إدارة النظام ← مركز التحديث')}</td><td>{ar('عامل الصيانة يعمل')}; trust key installed</td></tr>
<tr><td>V2</td><td>Choose the TMRKZ folder after <code>make-release.sh</code>; upload; approve a documentation-only change</td><td>DONE; then rollback restores it</td></tr>
<tr><td>V3</td><td>{ar('الشهادات')}</td><td>The folders the VM uses (TMRKZ_TLS_DIR, TMRKZ_TRUSTSTORE_DIR, certs/) listed with expiry; keys shown only as “matches”</td></tr>
<tr><td>V4</td><td>{ar('استيراد ملف إعدادات')} with the other application's .env</td><td>Directory values recognised; test passes against the real directory before applying</td></tr>
<tr><td>V5</td><td>{ar('مديرو النظام ← ＋ مدير جديد ← حساب الدليل المؤسسي')}</td><td>The message states which lookup the VM allows; an account found is shown before any grant</td></tr>
<tr><td>V6</td><td><code>diagnose.sh</code> §10</td><td>“open-ended rows EDITED BY HAND” and “mirror holders with no grant” both 0</td></tr>
</tbody></table>
""")

shots_uc = [
    (os.path.join(EV, 'uc-01-compared.png'), 'Choosing the Desktop TMRKZ folder: the signed release is verified and compared — added, modified, deleted; the Compose change shown but not selected.'),
    (os.path.join(EV, 'uc-03-applied.png'), 'After approval: built offline with the existing libraries, backed up, applied, the new backend and web verified.'),
    (os.path.join(EV, 'uc-06-rolled-back.png'), 'Rollback on request restores every file exactly.'),
    (os.path.join(EV, 'uc-07-tampered.png'), 'A file changed after signing cannot be selected or uploaded.'),
    (os.path.join(ER, 'uc-14-conflict.png'), 'A file edited on the VM since the last update is flagged «معدّل على هذا الجهاز» and never preselected.'),
    (os.path.join(ER, 'uc-15-disk.png'), 'Too little free disk space: refused, nothing applied.'),
    (os.path.join(ER, 'uc-16-rolled-back.png'), 'A build that compiles but never starts is rolled back by itself; the previous build serves again.'),
    (os.path.join(ER, 'uc-12-no-access.png'), 'A signed-in person without global administration does not see «إدارة النظام»; every update call answers 403.'),
]
section('updates', 'Step 4 — routine updates from the browser (no PAM)', f"""
<ol class="steps">
<li>On the development PC, after the changes: <code>"C:\\Program Files\\Git\\bin\\sh.exe" ops/update/make-release.sh</code></li>
<li>On the VM's page: {ar('إدارة النظام ← مركز التحديث ← اختيار مجلد TMRKZ')} and choose the same TMRKZ folder (from the Desktop or a USB).</li>
<li>Review the list; files flagged {ar('إعداد الحاويات')}, {ar('معدّل على هذا الجهاز')} or {ar('حذف واسع')} are never preselected.</li>
<li>{ar('رفع الملفات المختلفة')} — only the differing files travel; each is checked against the signed SHA-256.</li>
<li>Write the reason and {ar('اعتماد وتطبيق')} (a recent sign-in is required). Follow the progress; only the affected services rebuild.</li>
<li>If needed: {ar('الرجوع إلى الإصدار السابق')}.</li>
</ol>
{''.join(img(p, E(c)) for p, c in shots_uc)}
<h3>Update Center results</h3>
{result_table(uc, 'update-center.mjs')}
""")

section('certs', 'Certificates («الشهادات»)', f"""
<p>Each service has its own trust: the enterprise directory and the enterprise Keycloak keep their CA lists in
{ar('إعدادات التكامل')} (applied at once after a live connection test); the https server certificate is written by the maintenance
worker into <code>TMRKZ_TLS_DIR</code> after a backup, and the https entry point reloads it by itself. A private key is accepted only
for https, never shown, never logged, and deleted from the staging area when the request ends.</p>
<ol class="steps">
<li>{ar('إدارة النظام ← الشهادات')}: the folders the running configuration uses, each certificate's expiry, and for a key only which certificate it matches.</li>
<li>{ar('استيراد أو تجديد شهادة')}: choose the service, then the files (PEM, CER, P7B or PFX with its password) or {ar('استخدام')} on a certificate already on the machine.</li>
<li>{ar('فحص ومعاينة')}: every check is listed — key match, validity, server use, host name, chain, key strength, live connection — with what will change.</li>
<li>Write the reason and {ar('تطبيق')}. For https the worker installs, waits until the https entry point serves the new certificate, and restores the previous one if it does not.</li>
<li>{ar('استعادة الشهادات السابقة')} puts back the previous certificate (and key) at any time.</li>
</ol>
{img(os.path.join(ER, 'crt-e1-inventory.png'), 'Inventory: the https folder the VM-like installation uses (certs/), its certificate and the key match — never the key.', True)}
<div class="grid2">{img(os.path.join(ER, 'crt-e4-refused.png'), 'A certificate that does not hold this server\'s key is refused before anything is written.')}
{img(os.path.join(ER, 'crt-e2-checked.png'), 'A new .pfx: key, validity, server use, host name, chain and key strength all pass.')}</div>
{img(os.path.join(ER, 'stepup-notice.png'), 'Applying with a sign-in older than five minutes: the identity is confirmed in place first (directory password, or the identity provider again); nothing changes before.')}
<div class="grid2">{img(os.path.join(ER, 'crt-e2-applied.png'), 'Applied by the worker; the https entry point serves the new certificate (verified by fingerprint).')}
{img(os.path.join(ER, 'crt-e3-restored.png'), 'Restored: the previous certificate is served again.')}</div>
{img(os.path.join(ER, 'crt-e5-directory.png'), 'The directory\'s own trust: a CA added from the machine\'s certificate folder, tested live first, applied at once.')}
<p><b>Emergency recovery without the browser:</b> copy <code>server.crt</code>, <code>server.key</code> and <code>ca-chain.pem</code> from
<code>backups/certificates/&lt;request&gt;/</code> back into the <code>TMRKZ_TLS_DIR</code> folder; the https entry point reloads them within seconds.</p>
""")

section('env', 'Configuration import («استيراد ملف إعدادات»)', f"""
<ol class="steps">
<li>{ar('إدارة النظام ← استيراد ملف إعدادات ← اختيار ملف الإعدادات')}: choose the other application's <code>.env</code>. It is read once and never stored.</li>
<li>Each recognised setting is shown with its section, the value in force and the imported value: {ar('جديد')}, {ar('مطابق')} or {ar('تعارض')}. Secrets appear only as ••••.</li>
<li>Database credentials, secret/signing/encryption keys, OpenFGA and local identity-provider settings are listed by name as never imported.</li>
<li>Choose the values, {ar('اختبار القيم المختارة')} (a live connection to the directory / Keycloak / model server), then the reason and {ar('تطبيق على إعدادات التكامل')}. <code>.env</code> is never written.</li>
</ol>
<div class="grid2">{img(os.path.join(ER, 'env-e1-preview.png'), 'Preview: a conflict kept unselected, the CA file found in this machine\'s folders, never-imported values named only.')}
{img(os.path.join(ER, 'env-e2-tested.png'), 'The chosen values pass a live protected connection before they can be applied.')}</div>
""")

section('admins', 'System administrators («مديرو النظام»)', f"""
<table><thead><tr><th>How the VM's directory is configured</th><th>What the screen offers</th></tr></thead><tbody>
<tr><td>A read-only service account in {ar('إعدادات التكامل')}</td><td>Any directory account is found before its first sign-in.</td></tr>
<tr><td>No service account (ADR-100 — the VM's case)</td><td>An administrator signed in with the directory types <b>their own</b> directory password for that one search (never stored, throttled).</td></tr>
<tr><td>The administrator signed in with a platform account, or no directory</td><td>The screen explains why the lookup is not possible; alternatives: the employee number from Oracle HR, or one sign-in by the person.</td></tr>
</tbody></table>
<p>The identity found is shown; nothing is granted until it is confirmed with a reason. The person is created exactly as their
first sign-in would create them, so that sign-in lands on the same record. Duplicates are refused; the last effective
administrator cannot be removed.</p>
{img(os.path.join(ER, 'adm-e2-candidate.png'), 'An account that never signed in, found in the directory and shown for confirmation.')}
""")

section('owner-requests', 'Owner requests of 25 Nov 2026 — settings page, full map view, «المزيد»', f"""
<h3>«إعدادات النظام» — organised in groups</h3>
<p>A side menu lists the seven groups (policies and environment, identity and sign-in, system administrators, HR source, data migration,
certificates, maintenance and updates) with a search box and live status badges. Status cards at the top open their group. Choosing a
group shows it alone; «الكل» shows every group, as before. The choice is remembered in this browser.</p>
<div class="grid2">{img(os.path.join(EU, 'ui-settings-all.png'), '«الكل»: status cards, the group menu and every group in order.')}
{img(os.path.join(EU, 'ui-settings-security.png'), 'One group at a time from the menu (here «الشهادات»).')}</div>
<h3>Every map page opens on the whole country</h3>
<p>The site setup, sites, deployment-area and re-stationing requests, posture and home maps now open on the whole country, like
{ar('الموقف العملياتي')}, instead of a zoomed-in place. The button {ar('الخريطة كاملة')} beside the map's own controls returns to the
whole country after looking at one place, before moving to another. Choosing a site, unit or request still brings it into view.</p>
{img(os.path.join(EU, 'map-full-view.png'), '«تحديد مواقع التمركز المبدئية» opening on the whole country, with «الخريطة كاملة» at the bottom.', True)}
""")

section('recovery', 'Recovery cheat sheet', """
<table><thead><tr><th>Situation</th><th>Undo</th></tr></thead><tbody>
<tr><td>A browser update misbehaves</td><td><span lang="ar" dir="rtl">الرجوع إلى الإصدار السابق</span> in the Update Center (automatic when verification fails).</td></tr>
<tr><td>Browser unavailable after an update</td><td>Copy <code>backups/updates/&lt;id&gt;/before/*</code> back, delete the files listed in <code>added.txt</code>; the services rebuild by themselves.</td></tr>
<tr><td>A certificate change</td><td><span lang="ar" dir="rtl">استعادة الشهادات السابقة</span>; or copy from <code>backups/certificates/&lt;id&gt;/</code>.</td></tr>
<tr><td>An imported setting</td><td>Edit or clear the section in <span lang="ar" dir="rtl">إعدادات التكامل</span> (the previous values are in the audit detail).</td></tr>
<tr><td>The bootstrap itself</td><td><code>sh bootstrap.sh restore /data/TMRKZ/backups/bootstrap/&lt;time&gt;</code> then <code>sh start.sh</code>.</td></tr>
</tbody></table>
""")

shot_ui = [p for p in [os.path.join(EU, f) for f in ('ui-1920x1080-settings.png', 'ui-1280x800@125%-home.png', 'ui-tablet-768x1024@2x-settings.png',
                                                     'ui-phone-390x844@3x-stationing.png', 'ui-04-errors.png', 'map-align-browser200.png')]]
section('ui', 'UI regression and map pointer alignment', f"""
<div class="note">Timings and layouts here were measured on the development PC (Docker Desktop, headless Edge). They say nothing
about the VM's speed; VM acceptance needs the checklist in Step 3.</div>
{result_table(ui, 'ui-regression.mjs')}
<h3>Page load on the development PC (median / max, ms)</h3>
<table><thead><tr><th>Page</th><th>Median</th><th>Max</th></tr></thead><tbody>
{''.join(f'<tr><td class="mono">{E(k)}</td><td>{v["medianMs"]}</td><td>{v["maxMs"]}</td></tr>' for k, v in ui_timings.items())}
</tbody></table>
{img(os.path.join(EU, 'ui-more-menu.png'), 'Owner report of 25 Nov 2026 — «المزيد» did not open anything visible (the bar clipped its menu). Fixed: the menu now opens on screen at every width; the test checks each item is the element actually on top.', True)}
<div class="grid3">{''.join(img(p, E(os.path.basename(p))) for p in shot_ui)}</div>
""")

section('release-tests', 'Release acceptance results (security, certificates, import, administrators)', result_table(rel, 'release-acceptance.mjs'))

cls_rows = '\n'.join(l for l in classification.splitlines() if l.startswith('|'))
section('regression', 'The 18 failing tests — classification', f"""
<p>All 18 were tests still expecting behaviour from before deliberate design changes (ADR-095: final approval activates in the same
transaction; ADR-094 Gate 2 §C: the posture summary). They were updated to the designed behaviour; no test was deleted or skipped and
no authorisation or scope check was loosened. The three classes now pass 40/40.</p>
<div class="note"><b>Application defect found while reviewing (not fixed — needs the owner's choice):</b> the FYI units the final
approval informs are read from <code>fyi_designation</code>, but the screen «الجهات الرئيسية للعلم» writes <code>fyi_main_command</code>; no
screen sets <code>fyi_designation</code>.</div>
{code(cls_rows) if cls_rows else ''}
""")

section('integrity', 'Repository integrity', f"""
<ul>
<li>{E(cfg.get('repoIntegrityText', ''))}</li>
<li>Never committed: <code>.zcode/</code>, <code>docs/audit/enterprise-launch/</code>, <code>tests/acceptance/audit/</code>,
<code>ops/keycloak/ENTERPRISE_REGISTRATION.env.example</code>, <code>release/</code>, <code>ops/local/.generated/</code> (signing key and generated secrets), <code>.env</code>.</li>
<li>Commit on <code>main</code>: <code>{commit}</code>.</li>
</ul>
""")

section('open', 'Still open', """
<ul>
<li><b>Real-VM acceptance</b> of everything in this guide (bootstrap, first browser update, certificate inventory against the VM's
own <code>certs/</code> and <code>.env</code>, ENV import against the real directory, administrator lookup with the real AD).</li>
<li><b>FYI designations</b> (above) — the owner's choice of table.</li>
<li><b>20 pre-existing backend test failures</b> outside the 18 (AccessScopeParityIT, WorkflowGraphIT, RestationingLifecycleIT,
RestationingHrSyncIT, MatrixColumnsIT, OperationalPostureScaleIT, SupportIT), identical on 8800b58, unchanged and listed with a
preliminary reading in <code>docs/evidence/regression-18/PRE-EXISTING-OTHERS.md</code>.</li>
<li>A Compose-file change still needs one <code>docker compose up -d</code> by the operator (the worker has no Docker socket by design).</li>
<li>Files over 24&nbsp;MB and new npm libraries are not delivered through the browser (new images would be needed).</li>
<li>Keycloak's own truststore (its directory federation, which needs a service account) is read at its start only; TMRKZ's own
directory sign-in and Keycloak calls use the per-service trust above.</li>
</ul>
""")

out = cfg['out']
os.makedirs(os.path.dirname(out), exist_ok=True)
with open(out, 'w', encoding='utf-8') as f:
    f.write(f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TMRKZ — final completion, bootstrap and acceptance guide</title><style>{css}</style></head><body>
<header class="top"><h1>TMRKZ — final completion, bootstrap and acceptance guide</h1>
<p>25 November 2026 · ADR-103 · ADR-104 · ADR-105 · commit {commit} on main · fictional data only in every screenshot</p></header>
<div class="layout"><nav class="toc"><b>Contents</b>{''.join(f'<a href="#{i}">{E(t)}</a>' for i, t in toc)}</nav>
<main>{''.join(S)}</main></div></body></html>""")
print('written', out, os.path.getsize(out) // 1024, 'KB')
