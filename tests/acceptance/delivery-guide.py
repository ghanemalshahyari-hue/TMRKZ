"""Builds the self-contained Arabic delivery guide (ADR-105/106): docs/guide/TMRKZ_FINAL_DELIVERY_GUIDE.html.

  python tests/acceptance/delivery-guide.py <config.json>

The config names the evidence folders of the acceptance runs (fictional data, throw-away installation tmrkz-vmsim), the real
outputs of the bootstrap check and the diagnosis on a test copy, the test summaries, the commit and the release. Screenshots and
outputs are embedded, so the one HTML file works offline in any browser with no external resource. Arabic explanations;
commands, paths and file names stay exactly as typed (English). Standard library only.
"""
import base64
import html
import json
import os
import re
import sys

cfg = json.load(open(sys.argv[1], encoding='utf-8'))
E = html.escape


def read(path):
    return open(path, encoding='utf-8', errors='replace').read() if path and os.path.exists(path) else ''


def results(path):
    if not path or not os.path.exists(path):
        return []
    return json.load(open(path, encoding='utf-8')).get('results', [])


def img(path, caption, wide=False, optional=False):
    if not path or not os.path.exists(path):
        if optional:
            return ''
        return f'<p class="missing">(لم تُلتقط هذه الصورة: {E(os.path.basename(path or "?"))})</p>'
    data = base64.b64encode(open(path, 'rb').read()).decode('ascii')
    return (f'<figure class="{"wide" if wide else ""}"><img alt="{E(caption)}" src="data:image/png;base64,{data}">'
            f'<figcaption>{caption}</figcaption></figure>')


def code(text, title=None):
    head = f'<div class="code-title">{E(title)}</div>' if title else ''
    return f'<div class="code">{head}<pre dir="ltr"><code>{E(text.strip())}</code></pre></div>'


def c(text):
    """An inline command, path or name, kept left-to-right inside the Arabic text."""
    return f'<code dir="ltr">{E(text)}</code>'


def pill(state):
    cls = {'نجح': 'ok', 'مكتمل': 'ok', 'متحقق (VM تجريبي)': 'ok', 'فشل': 'bad', 'مفتوح': 'warn', 'بانتظار الـVM': 'warn',
           'تطوير فقط': 'info', 'متحقق بالاختبارات': 'ok', 'لا ينطبق': 'info', 'يُنقل': 'ok', 'لا يُلمس أبداً': 'bad', 'غير لازم': 'info'}.get(state, 'info')
    return f'<span class="pill {cls}">{E(state)}</span>'


def result_table(rows, title):
    if not rows:
        return f'<p class="missing">لا يوجد ملف نتائج لـ {E(title)}.</p>'
    passed = sum(1 for r in rows if r['pass'])
    out = [f'<p class="summary"><b>{passed}/{len(rows)}</b> فحصاً نجح — <span dir="ltr">{E(title)}</span></p>',
           '<table class="results"><thead><tr><th>الفحص</th><th>ما الذي تحقق (بنص الاختبار)</th><th>النتيجة</th></tr></thead><tbody>']
    for r in rows:
        out.append(f'<tr><td class="mono" dir="ltr">{E(r["id"])}</td><td><bdi>{E(r["label"])}</bdi>'
                   + (f'<div class="detail"><bdi>{E(r.get("extra", ""))}</bdi></div>' if r.get('extra') else '')
                   + f'</td><td>{pill("نجح" if r["pass"] else "فشل")}</td></tr>')
    out.append('</tbody></table>')
    return '\n'.join(out)


V = cfg['vmsim']
EV = os.path.join(V, 'evidence')
ER = os.path.join(V, 'evidence-release')
EU = os.path.join(V, 'evidence-ui')
EG = os.path.join(V, 'evidence-guide')
uc = results(os.path.join(EV, 'results.json'))
rel = results(os.path.join(ER, 'results.json'))
ui = results(os.path.join(EU, 'results.json'))
boot = read(cfg.get('bootstrapLog'))
boot_rows = [{'id': m.group(2).split(' ')[0], 'label': m.group(2), 'pass': m.group(1) == 'PASS', 'extra': ''}
             for m in re.finditer(r'^(PASS|FAIL)\s+(.*)$', boot, re.M)]
sums = read(cfg.get('bootstrapSums'))
install = read(cfg.get('bootstrapInstall'))
check_out = read(cfg.get('bootstrapCheck'))
diag_out = read(cfg.get('diagnoseSample'))
commit = E(cfg.get('commit', ''))
release = E(cfg.get('release', ''))
base = E(cfg.get('baseCommit', 'e30c1c1'))
pkg = cfg.get('packageFolder', 'tmrkz-bootstrap')
usb = E(cfg.get('usbFolder', ''))

css = """
:root{--ink:#1d2433;--muted:#5d6678;--line:#e3e6ec;--bg:#f7f8fa;--card:#fff;--accent:#1f6f5c;--ok:#1d7a46;--okbg:#e5f4ea;
--bad:#b42318;--badbg:#fde8e6;--warn:#9a6700;--warnbg:#fff4d6;--info:#2a5db0;--infobg:#e7efff}
*{box-sizing:border-box}body{margin:0;font:16px/1.75 "Segoe UI",Tahoma,"Noto Sans Arabic","Arabic Typesetting",Arial,sans-serif;color:var(--ink);background:var(--bg)}
header.top{background:#0f2f28;color:#fff;padding:26px 40px}header.top h1{margin:0 0 6px;font-size:26px}header.top p{margin:2px 0;color:#cfe3dc}
.layout{display:grid;grid-template-columns:280px 1fr;max-width:1440px;margin:0 auto}
nav.toc{position:sticky;top:0;align-self:start;height:100vh;overflow:auto;padding:18px 16px;border-left:1px solid var(--line);background:#fff}
nav.toc a{display:block;color:var(--ink);text-decoration:none;padding:4px 8px;border-radius:6px;font-size:14px}nav.toc a:hover{background:var(--bg)}
nav.toc .n{display:inline-block;min-width:22px;color:var(--accent);font-weight:700}
main{padding:24px 36px 80px;min-width:0}section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:22px 26px;margin:0 0 22px}
h2{margin:0 0 12px;font-size:22px;color:#0f2f28}h3{margin:20px 0 8px;font-size:18px}h4{margin:14px 0 6px;font-size:16px}
.code{margin:10px 0 14px}.code-title{font-size:12px;color:var(--muted);margin:0 0 3px}
pre{background:#0f172a;color:#e2e8f0;padding:12px 16px;border-radius:8px;overflow:auto;font:13px/1.55 Consolas,"Cascadia Mono",monospace;direction:ltr;text-align:left;margin:0;white-space:pre}
code{font-family:Consolas,"Cascadia Mono",monospace;font-size:13.5px}p code,li code,td code{background:#eef1f5;padding:1px 6px;border-radius:4px;unicode-bidi:isolate}
table{border-collapse:collapse;width:100%;margin:8px 0 14px;font-size:14.5px}th,td{border-bottom:1px solid var(--line);padding:7px 9px;text-align:right;vertical-align:top}
th{background:#f1f3f6;font-weight:600}.mono{font-family:Consolas,monospace;white-space:nowrap;text-align:left}.detail{color:var(--muted);font-size:12.5px;word-break:break-word}
.pill{display:inline-block;padding:1px 10px;border-radius:999px;font-size:12.5px;font-weight:600;white-space:nowrap}
.pill.ok{background:var(--okbg);color:var(--ok)}.pill.bad{background:var(--badbg);color:var(--bad)}.pill.warn{background:var(--warnbg);color:var(--warn)}.pill.info{background:var(--infobg);color:var(--info)}
.note{border-right:4px solid var(--warn);background:var(--warnbg);padding:10px 14px;border-radius:6px;margin:10px 0}
.good{border-right:4px solid var(--ok);background:var(--okbg);padding:10px 14px;border-radius:6px;margin:10px 0}
.stop{border-right:4px solid var(--bad);background:var(--badbg);padding:10px 14px;border-radius:6px;margin:10px 0}
.steps{counter-reset:s;list-style:none;padding:0;margin:8px 0}.steps>li{counter-increment:s;position:relative;padding:4px 44px 12px 0}
.steps>li:before{content:counter(s);position:absolute;right:0;top:4px;width:28px;height:28px;border-radius:50%;background:var(--accent);color:#fff;text-align:center;font-weight:700;line-height:28px}
figure{margin:12px 0 18px;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:#fff}figure img{display:block;max-width:100%;height:auto;margin:0 auto}
figcaption{padding:8px 12px;font-size:13.5px;color:var(--muted);border-top:1px solid var(--line);background:#fafbfc}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}.summary{font-size:15px}.missing{color:var(--bad)}
.route{display:flex;flex-wrap:wrap;gap:10px;align-items:stretch;margin:12px 0}
.route .hop{flex:1 1 170px;border:1px solid var(--line);border-radius:10px;padding:10px 12px;background:#fbfcfd}
.route .hop b{display:block;color:#0f2f28;margin-bottom:4px}.route .arrow{align-self:center;font-size:22px;color:var(--accent)}
.kbd{border:1px solid #c9ced8;border-bottom-width:2px;border-radius:4px;padding:0 6px;font-size:13px;background:#fff}
@media (max-width:900px){.layout{grid-template-columns:1fr}nav.toc{position:static;height:auto;border-left:0}.grid2{grid-template-columns:1fr}main{padding:14px}}
@media print{nav.toc{display:none}.layout{grid-template-columns:1fr}section{break-inside:avoid-page}pre{white-space:pre-wrap}}
"""

S = []
toc = []


def section(sid, title, body):
    toc.append((sid, title))
    S.append(f'<section id="{sid}"><h2>{len(toc)}. {E(title)}</h2>{body}</section>')


# ---- 1. status ---------------------------------------------------------------------------------------------------------
matrix = [
    ('تحقق الإصدار', 'المستودع والإيداع وحالة الشجرة وتوقيع الإصدار والصور الموجودة وتوافق المكتبات؛ مجلد TMRKZ واحد بلا فروع أو نسخ عمل أو مكتبات أو صور جديدة.', 'مكتمل'),
    ('حزمة الـUSB', 'حزمة الإعداد لأول مرة، هذا الدليل، START_HERE.txt، المجاميع، تقرير القبول، تعليمات الاسترداد، وملفات الإصدار الموقعة لأول تحديث من المتصفح — بلا مفاتيح خاصة أو أسرار أو بيانات.', 'مكتمل'),
    ('الدليل المصور', 'هذا الملف: عربي، يعمل دون اتصال، صور حقيقية من التطبيق ببيانات وهمية.', 'مكتمل'),
    ('توافق الـVM', 'الفحص يقارن كل ملف على الـVM بالإصدار وبكل نسخة سبق إيداعها، فيميز ما عُدل يدوياً على الـVM ويتوقف قبل استبداله.', 'متحقق (VM تجريبي)'),
    ('تعارض جهات العلم', 'جدول واحد معتمد (fyi_main_command) تقرؤه الشاشة والتوزيع عند الاعتماد النهائي؛ السجلات السابقة منقولة ومُدققة (V69).', 'متحقق بالاختبارات'),
    ('إخفاقات الخادم العشرون', 'كل اختبار حُلل وصُنف وعولج بدليل؛ لم يُضعف أي فحص صلاحيات أو نطاق؛ كل صنف نجح منفرداً، والمجموعة الكاملة لم تُعد على الشجرة النهائية.', 'متحقق بالاختبارات'),
]
section('status', 'الحالة باختصار', f"""
<p>هذا الدليل يغطي طلب المالك <b>«TMRKZ — Final USB Delivery and Complete Illustrated Handover»</b> (25 نوفمبر 2026)، المبني على
ADR-103 وADR-104 وADR-105، والمسلَّم في <b>ADR-106</b> على الفرع {c('main')}. هذا الدليل نفسه ملف من ملفات الإصدار، لذلك لا يذكر رقم إيداعه ولا معرّف الإصدار:
تجدهما بالضبط في {c('START_HERE.txt')} على الـUSB، وفي {c('release/RELEASE.json')}.</p>
<div class="stop"><b>ليس قبولاً للإنتاج بعد.</b> كل ما هنا اختُبر على جهاز التطوير وعلى تثبيت تجريبي مطابق لتخطيط {c('/data/TMRKZ')} على الـVM
(مشروع {c('tmrkz-vmsim')} ببيانات وهمية). الـVM الحقيقي لم يُلمس ولم يُطبق عليه شيء. القبول يتطلب نجاح فحوص الـVM في القسم 5 والقسم 6.</div>
<table><thead><tr><th>البند</th><th>ما الذي أُنجز</th><th>التطوير / VM تجريبي</th><th>الـVM الحقيقي</th></tr></thead><tbody>
{''.join(f'<tr><td><b>{E(a)}</b></td><td>{E(b)}</td><td>{pill(s)}</td><td>{pill("بانتظار الـVM")}</td></tr>' for a, b, s in matrix)}
</tbody></table>
<h3>نتائج الاختبارات الآلية</h3>
<p class="detail">{E(cfg.get('runsNote', ''))}</p>
<table><tbody>
<tr><td>الخادم (PostgreSQL + PostGIS حقيقية مع OpenFGA)</td><td><bdi>{E(cfg.get('backendSummary', ''))}</bdi></td></tr>
<tr><td>اختبارات الواجهة والبناء</td><td><bdi>{E(cfg.get('frontendSummary', ''))}</bdi></td></tr>
<tr><td>مركز التحديث من المتصفح (طرف إلى طرف)</td><td>{sum(r['pass'] for r in uc)}/{len(uc)}</td></tr>
<tr><td>قبول الإصدار: الأمان والشهادات والاستيراد والمديرون (طرف إلى طرف)</td><td>{sum(r['pass'] for r in rel)}/{len(rel)}</td></tr>
<tr><td>تراجع الواجهة ومحاذاة مؤشر الخريطة</td><td>{sum(r['pass'] for r in ui)}/{len(ui)}</td></tr>
<tr><td>حزمة الإعداد لأول مرة (bootstrap)</td><td>{sum(r['pass'] for r in boot_rows)}/{len(boot_rows)}</td></tr>
</tbody></table>
""")

# ---- 2. the route ------------------------------------------------------------------------------------------------------
section('route', 'المسار كاملاً: من جهاز التطوير إلى الـVM', f"""
<div class="route">
<div class="hop"><b>1. جهاز التطوير (Windows)</b>مجلد {c('Desktop\\TMRKZ')}: يُبنى الإصدار الموقع وحزمة الإعداد. مفتاح التوقيع الخاص يبقى هنا فقط.</div>
<div class="arrow">←</div>
<div class="hop"><b>2. ذاكرة USB</b>المجلد {c(cfg.get('usbFolder', 'TMRKZ_DELIVERY_<date>'))}: الحزمة، الدليل، START_HERE.txt، المجاميع.</div>
<div class="arrow">←</div>
<div class="hop"><b>3. سطح مكتب Windows (جهاز العبور)</b>يُنسخ مجلد الحزمة إلى سطح المكتب ويُتحقق من المجاميع قبل رفعه.</div>
<div class="arrow">←</div>
<div class="hop"><b>4. PAM</b>جلسة الصلاحيات المميزة: نقل مجلد الحزمة إلى الـVM مرة واحدة، وتنفيذ الأوامر بحساب الصيانة.</div>
<div class="arrow">←</div>
<div class="hop"><b>5. الـVM (Ubuntu، دون إنترنت)</b>{c('/data/'+pkg)} ← فحص للقراءة فقط ← تطبيق ← {c('/data/TMRKZ')} ← {c('sh start.sh')}.</div>
</div>
<p>بعد هذه المرة الواحدة لا حاجة إلى PAM للتحديثات: يفتح المسؤول صفحة TMRKZ في المتصفح على جهاز Windows، ويختار مجلد TMRKZ
(من سطح المكتب أو من الـUSB) في {E('«إدارة النظام ← مركز التحديث»')}، فيُرفع فقط ما اختلف من ملفات بعد التحقق من التوقيع (القسم 8).</p>
<div class="note">لا مكتبات جديدة، ولا صور Docker جديدة، ولا PowerShell، ولا مجلد تطبيق ثانٍ: الـVM يشغّل المجلد نفسه والصور نفسها و{c('start.sh')} نفسه.
الفرق فقط في {c('.env')} والعناوين والشهادات والبيانات.</div>
""")

# ---- 3. files ----------------------------------------------------------------------------------------------------------
section('files', 'ما الذي يُنقل، وما لا يُلمس أبداً، وأين يوضع', f"""
<table><thead><tr><th></th><th>المسارات</th></tr></thead><tbody>
<tr><td>{pill('يُنقل')}</td><td>مرة واحدة عبر PAM: مجلد الحزمة {c('1_VM_BOOTSTRAP')} من الـUSB كما هو (نحو 9&nbsp;MB)، ويوضع على الـVM في مجلد مستقل
مثل {c('/data/'+pkg)} — <b>ليس داخل</b> {c('/data/TMRKZ')}. ملفات الإصدار الكاملة {c('2_FIRST_BROWSER_UPDATE')} لا تُرفع عبر PAM: يختارها المتصفح.</td></tr>
<tr><td>{pill('لا يُلمس أبداً')}</td><td>على الـVM: {c('.env')}، {c('certs/')}، {c('data/')} (قاعدة البيانات)، {c('backups/')}، {c('map-data/')}، {c('map-runtime/')}،
{c('ops/local/.generated/')} (المفاتيح المولدة؛ يُضاف إليه المفتاح العام مرة واحدة فقط)، {c('docker-compose.dc-hosts.yml')} وأي {c('docker-compose.*.yml')} آخر،
{c('tmrkz-images.tar')}. هذه القائمة مفروضة ثلاث مرات: قواعد الإصدار، والقائمة الثابتة في عامل الصيانة، وسكربت الإعداد.</td></tr>
<tr><td>{pill('غير لازم')}</td><td>{c('tests/')}، {c('backend/src/test/')}، {c('docs/evidence/')}، {c('docs/audit/')}، {c('.zcode/')}، {c('node_modules')}، ذاكرة Maven، أرشيفات صور Docker،
بيانات الخرائط الكبيرة — و<b>أبداً</b> {c('ops\\local\\.generated\\release-signing.key')}: مفتاح التوقيع لا يغادر جهاز التطوير.</td></tr>
</tbody></table>
<h3>محتوى الـUSB</h3>
<table><thead><tr><th>المجلد / الملف</th><th>الغرض</th></tr></thead><tbody>
<tr><td>{c('START_HERE.txt')}</td><td>الخطوات الدقيقة لأول مرة، في صفحة واحدة.</td></tr>
<tr><td>{c('1_VM_BOOTSTRAP/')}</td><td>حزمة الإعداد لأول مرة: {c('bootstrap.sh')}، الأرشيف، القائمة الموقعة، المفتاح العام، BASE.tsv وKNOWN.tsv للمقارنة، ملفات Compose للمراجعة، SHA256SUMS.</td></tr>
<tr><td>{c('2_FIRST_BROWSER_UPDATE/TMRKZ/')}</td><td>ملفات الإصدار الموقعة بمساراتها النسبية مع {c('release/RELEASE.json')} و{c('release/RELEASE.sig')} و{c('release/MANIFEST.tsv')}: يختار المتصفح هذا المجلد في أول تحديث إن لم تكن نسخة TMRKZ على سطح المكتب.</td></tr>
<tr><td>{c('3_GUIDE/TMRKZ_FINAL_DELIVERY_GUIDE.html')}</td><td>هذا الدليل.</td></tr>
<tr><td>{c('4_ACCEPTANCE_AND_RECOVERY/')}</td><td>تقرير القبول، تعليمات الاسترداد، نتائج الاختبارات وسجلاتها.</td></tr>
<tr><td>{c('SHA256SUMS.txt')}</td><td>مجموع كل ملف على الـUSB؛ تحقق منه قبل النقل.</td></tr>
</tbody></table>
""")

# ---- 4. first time -----------------------------------------------------------------------------------------------------
section('first', 'أول مرة: الإعداد على الـVM (مرة واحدة عبر PAM)', f"""
<h3>أ. على سطح مكتب Windows</h3>
<ol class="steps">
<li>انسخ المجلد {c('1_VM_BOOTSTRAP')} من الـUSB إلى سطح المكتب.</li>
<li>تحقق من الأرشيف (موجه الأوامر CMD، لا PowerShell): يجب أن يطابق الناتج السطر المقابل في {c('SHA256SUMS')}.
{code('cd %USERPROFILE%\\Desktop\\1_VM_BOOTSTRAP' + chr(10) + 'certutil -hashfile TMRKZ-bootstrap-*.tar SHA256' + chr(10) + 'type SHA256SUMS')}</li>
<li>ارفع المجلد كاملاً إلى الـVM عبر وسيلة نقل الملفات في PAM، إلى {c('/data/'+pkg)}.</li>
</ol>
<h3>ب. على الـVM (بحساب الصيانة)</h3>
<ol class="steps">
<li>تحقق من الحزمة بعد النقل — يجب أن تكون كل الأسطر {c('OK')}:
{code(f'cd /data/{pkg}' + chr(10) + 'sha256sum -c SHA256SUMS')}</li>
<li><b>فحص للقراءة فقط</b> — لا يغير شيئاً. يتحقق من المجاميع والتوقيع، ويقارن ما على الـVM بالإصدار (القسم 7)، ويعرض الخطة وفرق ملفات Compose:
{code(f'sh bootstrap.sh check /data/TMRKZ | tee /tmp/tmrkz-bootstrap-check.txt')}</li>
<li>اقرأ التقرير. إن لم يظهر سطر {c('CHANGED ON THIS MACHINE')} فلا ملف عُدل يدوياً على الـVM. إن ظهر، قارن كل ملف قبل أي قرار:
{code(f'tar -xOf TMRKZ-bootstrap-*.tar <path> | diff -u /data/TMRKZ/<path> -')}</li>
<li><b>ملفات Compose والحفاظ على الإعدادات</b> (القسم 6): إن اقتصر الفرق على إضافات مركز التحديث فطبّق مع {c('--with-config')}؛ وإلا طبّق دونه وأضف تلك الأجزاء يدوياً.</li>
<li>التطبيق — يحفظ قبل الكتابة نسخة من كل ملف في {c('backups/bootstrap/<time>/')}:
{code('sh bootstrap.sh apply /data/TMRKZ --with-config')}
إن توقف برسالة {c('stopped: N files changed on this machine would be replaced')} فاختر صراحة أحد الخيارين:
{code('sh bootstrap.sh apply /data/TMRKZ --with-config --keep-local       # تبقى ملفات الـVM المعدلة كما هي' + chr(10) + 'sh bootstrap.sh apply /data/TMRKZ --with-config --overwrite-local  # تُستبدل، ونسخة الـVM تبقى في النسخة الاحتياطية')}
مع {c('--keep-local')} يسجل خط الأساس هذه الملفات «معدّل على هذا الجهاز»، فيعرضها مركز التحديث بهذه الصفة ولا يختارها تلقائياً.</li>
<li>تأكد مرة واحدة أن {c('.env')} يسمّي ملف Compose الخاص بالـVM (وإلا يتوقف {c('start.sh')} بدل أن يتجاهله):
{code('COMPOSE_PATH_SEPARATOR=:' + chr(10) + 'COMPOSE_FILE=docker-compose.yml:docker-compose.override.yml:docker-compose.dc-hosts.yml')}</li>
<li>التشغيل بالصور المحملة أصلاً (لا حاجة إلى {c('tmrkz-images.tar')}):
{code('cd /data/TMRKZ && sh start.sh')}</li>
<li>تحقق من عامل الصيانة:
{code('cd /data/TMRKZ' + chr(10) + 'docker compose ps maintenance' + chr(10) + 'docker compose logs --tail 30 maintenance')}
ثم في المتصفح: {E('«إدارة النظام ← مركز التحديث»')} يجب أن يظهر {E('«عامل الصيانة يعمل»')} ومفتاح التحقق مثبت.</li>
<li>التراجع عن الإعداد كاملاً إن لزم:
{code('sh /data/' + pkg + '/bootstrap.sh restore /data/TMRKZ/backups/bootstrap/<time printed by apply>' + chr(10) + 'cd /data/TMRKZ && sh start.sh')}</li>
</ol>
{img(os.path.join(EV, 'uc-00-worker.png'), 'مركز التحديث بعد الإعداد: عامل الصيانة يعمل، ومفتاح التحقق مثبت، وزر اختيار مجلد TMRKZ.', True, True)}
<h3>الحزمة كما بُنيت لهذا التسليم</h3>
<p>{c('INSTALL.txt')} و{c('SHA256SUMS')} داخل {c('1_VM_BOOTSTRAP')} على الـUSB هما المرجع لهذا الإصدار (وليسا منسوخين هنا، لأن الدليل جزء من الحزمة نفسها).</p>
""")

# ---- 5. read-only checks ---------------------------------------------------------------------------------------------
section('readonly', 'فحوص القراءة فقط على الـVM (أرسل الناتج)', f"""
{code('cd /data/TMRKZ' + chr(10) + 'sh ops/diagnose.sh --logins u123456,aeda123456 > /tmp/tmrkz-diagnose.txt')}
<p>{c('ops/diagnose.sh')} يقرأ فقط (جلسة قاعدة البيانات للقراءة فقط) ويخفي الأسماء والعناوين والأسرار. يجيب عن: ملفات Compose المستخدمة، الخدمات
والصور، المجلدات، الإصدار المثبت وخط الأساس، هل جُمعت آخر تعديلات المصدر، التركيبات (mounts)، الشهادات وانتهاؤها، قاعدة البيانات، مرآة
الصلاحيات، الهويات، مزامنة الموارد البشرية، الوحدات، والأخطاء الأخيرة.</p>
<h3>ثم في المتصفح بحساب مدير نظام عام — قائمة قبول الـVM</h3>
<table><thead><tr><th>#</th><th>الفحص</th><th>المتوقع</th></tr></thead><tbody>
<tr><td>V1</td><td>{E('«إدارة النظام ← مركز التحديث»')}</td><td>{E('«عامل الصيانة يعمل»')}؛ مفتاح التحقق مثبت</td></tr>
<tr><td>V2</td><td>اختيار مجلد TMRKZ، رفع، اعتماد تغيير وثائق فقط</td><td>«مكتمل»؛ ثم «الرجوع» يعيده كما كان</td></tr>
<tr><td>V3</td><td>{E('«الشهادات»')}</td><td>المجلدات التي يستخدمها الـVM مع تواريخ الانتهاء؛ المفتاح يظهر فقط «مطابق»</td></tr>
<tr><td>V4</td><td>{E('«استيراد ملف إعدادات»')} بملف التطبيق المتوافق</td><td>قيم الدليل معروفة؛ الاختبار ينجح على الدليل الحقيقي قبل التطبيق</td></tr>
<tr><td>V5</td><td>{E('«مديرو النظام ← ＋ مدير جديد»')}</td><td>الرسالة تبين نوع البحث المتاح؛ الحساب يظهر قبل أي منح</td></tr>
<tr><td>V6</td><td>{c('diagnose.sh')} القسم 10</td><td>صفر صفوف «معدلة يدوياً» وصفر حاملين بلا منح</td></tr>
</tbody></table>
{code(diag_out[:6000], 'مثال من ناتج diagnose.sh على تثبيت تجريبي (بيانات وهمية)') if diag_out else ''}
""")

# ---- 6. compose -------------------------------------------------------------------------------------------------------
section('compose', 'مقارنة ملفات Compose والحفاظ على إعدادات الـVM', f"""
<p>الحزمة لا تكتب ملفات Compose إلا مع {c('--with-config')}، وبعد أن يعرض الفحص الفرق سطراً بسطر. الفرق المتوقع لمركز التحديث فقط:</p>
<ul>
<li>الخدمة {c('maintenance')} (عامل الصيانة) والمجلد {c('update-staging')}، وسطر {c('update-staging:/update')} في خدمة {c('backend')}.</li>
<li>مراقب الشهادات في خدمة {c('proxy')} ({c('ops/tls/tls-watch.sh')}): يعيد تحميل nginx عند تغير الشهادة بعد {c('nginx -t')}.</li>
<li>المتغيرات {c('TMRKZ_UPDATE_MIN_FREE_MB')} و{c('TMRKZ_UPDATE_DEPLOY_MINUTES')} و{c('TMRKZ_UPDATE_PROXY_HOST/PORT')}.</li>
</ul>
<div class="note">إن صنّف الفحص {c('docker-compose.yml')} أو {c('docker-compose.override.yml')} «CHANGED ON THIS MACHINE» فهذا تعديل محلي على الـVM:
لا تستخدم {c('--overwrite-local')} عليه قبل دمج التعديل يدوياً. مع {c('--keep-local')} يبقى الملف كما هو، فأضف إليه خدمة {c('maintenance')} يدوياً.</div>
<p>{c('docker-compose.dc-hosts.yml')} وكل {c('docker-compose.*.yml')} آخر لا تُكتب أبداً. القيم الخاصة بالـVM تبقى في {c('.env')} الذي لا يُكتب أبداً.</p>
""")

# ---- 7. compatibility --------------------------------------------------------------------------------------------------
section('compat', 'التحقق من توافق الـVM قبل التطبيق', f"""
<p>الـVM ({c('/data/TMRKZ')}) عُدل محلياً، ولا يُفترض أن ملفاته تطابق {c(cfg.get('baseCommit', 'e30c1c1'))} لمجرد أن الحزمة بُنيت عليه. لذلك تحمل الحزمة
معرّف كل ملف كما كان في ذلك الإيداع ({c('BASE.tsv')}) ومعرّف كل نسخة أُودعت منه في أي وقت ({c('KNOWN.tsv')})، ويحسب الـVM معرّف ملفاته دون git.
فيضع الفحص كل ملف مختلف في واحدة من ثلاث:</p>
<table><thead><tr><th>التصنيف</th><th>المعنى</th><th>ما يفعله التطبيق</th></tr></thead><tbody>
<tr><td>{c('as at that commit')}</td><td>الملف كما في {c(cfg.get('baseCommit', 'e30c1c1'))} (ولو نُسخ من Windows بنهايات أسطر CRLF)</td><td>يُستبدل كما هو مخطط</td></tr>
<tr><td>{c('an earlier committed version')}</td><td>نسخة أقدم أُودعت (يُذكر الإيداع وتاريخه): لم تُعدل على الـVM، لكنه لم يحدَّث</td><td>يُستبدل إن كان في الحزمة؛ وإلا يحدّثه أول تحديث من المتصفح كتحديث عادي</td></tr>
<tr><td>{c('CHANGED ON THIS MACHINE')}</td><td>لا توجد نسخة مودعة بهذه البايتات: تعديل يدوي على الـVM</td><td>يتوقف التطبيق ويسميه؛ لا يُستبدل إلا بـ{c('--overwrite-local')}، أو يبقى بـ{c('--keep-local')} ويظهر في المتصفح «معدّل على هذا الجهاز»</td></tr>
</tbody></table>
{code(check_out[:7000], 'ناتج حقيقي لـ bootstrap.sh check على نسخة تجريبية فيها تعديل يدوي، وملف من إيداع أقدم، وملف منسوخ من Windows') if check_out else ''}
<p>البيانات والخرائط والشهادات و{c('.env')} والمفاتيح المولدة و{c('docker-compose.dc-hosts.yml')} لا تدخل في المقارنة ولا تُكتب أبداً.</p>
""")

# ---- 8. browser updates --------------------------------------------------------------------------------------------------
shots_uc = [
    (os.path.join(EV, 'uc-01-compared.png'), 'بعد اختيار مجلد TMRKZ: التوقيع صحيح، والملفات مقارنة: مضاف، معدل، محذوف؛ تغيير Compose ظاهر لكنه غير مختار.'),
    (os.path.join(ER, 'uc-14-conflict.png'), 'ملف عُدل على هذا الجهاز منذ آخر تحديث: «معدّل على هذا الجهاز» ولا يُختار تلقائياً.'),
    (os.path.join(EV, 'uc-02-ready.png'), 'الاعتماد والتطبيق: السبب مطلوب، ودخول حديث مطلوب.'),
    (os.path.join(EV, 'uc-03-applied.png'), 'بعد الاعتماد: نسخة احتياطية، تطبيق، بناء دون اتصال بالمكتبات الموجودة، والتحقق من الخادم والواجهة الجديدين.'),
    (os.path.join(EV, 'uc-06-rolled-back.png'), 'الرجوع عند الطلب يعيد كل ملف كما كان.'),
    (os.path.join(ER, 'uc-16-rolled-back.png'), 'بناء يُجمع لكنه لا يعمل: يُرجع تلقائياً، ويعود البناء السابق للخدمة.'),
    (os.path.join(EV, 'uc-07-tampered.png'), 'ملف تغير بعد التوقيع: لا يمكن اختياره ولا رفعه.'),
    (os.path.join(ER, 'uc-15-disk.png'), 'مساحة القرص غير كافية: يُرفض ولا يُطبق شيء.'),
    (os.path.join(ER, 'uc-12-no-access.png'), 'مستخدم دون إدارة عامة لا يرى «إدارة النظام»؛ وكل طلب تحديث يُجاب بـ403.'),
]
section('browser', 'التحديثات من المتصفح (دون PAM)', f"""
<ol class="steps">
<li>على جهاز التطوير بعد التعديلات (CMD): {code('cd %USERPROFILE%\\Desktop\\TMRKZ' + chr(10) + '"C:\\Program Files\\Git\\bin\\sh.exe" ops/update/make-release.sh')}</li>
<li><b>اختيار المصدر:</b> في صفحة الـVM {E('«إدارة النظام ← مركز التحديث ← اختيار مجلد TMRKZ»')} اختر مجلد TMRKZ نفسه (من سطح المكتب أو {c('2_FIRST_BROWSER_UPDATE\\TMRKZ')} على الـUSB). يقرأ المتصفح {c('release/')} ويتحقق من التوقيع بالمفتاح العام المثبت.</li>
<li><b>مقارنة الملفات:</b> القائمة تبين المضاف والمعدل والمحذوف. الملفات الموسومة {E('«إعداد الحاويات»')} أو {E('«معدّل على هذا الجهاز»')} أو {E('«حذف واسع»')} لا تُختار تلقائياً.</li>
<li><b>حل التعارض:</b> ملف «معدّل على هذا الجهاز» يعني أن نسخة الـVM تختلف عما ثبته آخر تحديث. قارن، ثم إما أن تتركه غير مختار (يبقى تعديل الـVM) أو تختاره صراحة (يُستبدل، ويبقى الأصل في النسخة الاحتياطية).</li>
<li><b>الرفع:</b> {E('«رفع الملفات المختلفة»')} — تنتقل الملفات المختلفة فقط، ويُفحص كل منها مقابل SHA-256 الموقع. الرفع المنقطع لا يترك شيئاً.</li>
<li><b>الاعتماد والتطبيق:</b> اكتب السبب ثم {E('«اعتماد وتطبيق»')}. يلزم دخول حديث (خلال 5 دقائق)؛ وإلا يطلب الصفحة تأكيد الهوية في مكانها.</li>
<li><b>إعادة تشغيل الخدمات:</b> لا يُعاد تشغيل شيء يدوياً. ملفات {c('backend/')} يعيد الخادم بناءها بنفسه؛ ملفات {c('frontend/')} يبنيها {c('web-build')}؛ الشهادات يعيد {c('proxy')} تحميلها.
تغيير ملفات Compose وحده يحتاج {c('docker compose up -d')} من المشغل، لأن عامل الصيانة بلا مقبس Docker عمداً.</li>
<li><b>التقدم والتحقق:</b> الصفحة تعرض المراحل: نسخ احتياطي، تطبيق، بناء، تشغيل، تحقق. إن فشل التحقق خلال {c('TMRKZ_UPDATE_DEPLOY_MINUTES')} يُرجع كل شيء تلقائياً.</li>
<li><b>الرجوع:</b> {E('«الرجوع إلى الإصدار السابق»')} في أي وقت.</li>
</ol>
{''.join(img(p, E(t), False, True) for p, t in shots_uc)}
""")

# ---- 9. certificates ----------------------------------------------------------------------------------------------------
section('certs', 'إدارة الشهادات («الشهادات»)', f"""
<p>لكل خدمة ثقتها: الدليل المؤسسي وKeycloak المؤسسي يحفظان قوائم الجهات المصدّرة في {E('«إعدادات التكامل»')} وتُطبق فوراً بعد اختبار اتصال حي؛
وشهادة https يكتبها عامل الصيانة في {c('TMRKZ_TLS_DIR')} بعد نسخة احتياطية، ثم يعيد مدخل https تحميلها بنفسه. المفتاح الخاص يُقبل لـhttps فقط،
لا يُعرض ولا يُسجل، ويُحذف من منطقة التجهيز عند انتهاء الطلب.</p>
<ol class="steps">
<li>{E('«إدارة النظام ← الشهادات»')}: المجلدات التي يستخدمها التشغيل الحالي، وانتهاء كل شهادة، وللمفتاح فقط أي شهادة يطابق.</li>
<li>{E('«استيراد أو تجديد شهادة»')}: اختر الخدمة، ثم الملفات (PEM أو CER أو P7B أو PFX مع كلمة مروره) أو {E('«استخدام»')} على شهادة موجودة على الجهاز.</li>
<li>{E('«فحص ومعاينة»')}: كل فحص مدرج — مطابقة المفتاح، الصلاحية، استخدام الخادم، اسم المضيف، السلسلة، قوة المفتاح، الاتصال الحي — مع ما سيتغير.</li>
<li>اكتب السبب ثم {E('«تطبيق»')}. لـhttps ينتظر العامل حتى يقدّم مدخل https الشهادة الجديدة (ببصمتها)، ويعيد السابقة إن لم يحدث.</li>
<li>{E('«استعادة الشهادات السابقة»')} في أي وقت.</li>
</ol>
{img(os.path.join(ER, 'crt-e1-inventory.png'), 'الجرد: مجلد https الذي يستخدمه التثبيت، شهادته ومطابقة المفتاح — دون المفتاح نفسه.', True)}
<div class="grid2">{img(os.path.join(ER, 'crt-e4-refused.png'), 'شهادة لا تحمل مفتاح هذا الخادم تُرفض قبل كتابة أي شيء.')}
{img(os.path.join(ER, 'crt-e2-checked.png'), 'ملف ‎.pfx‎ جديد: المفتاح والصلاحية والاستخدام والاسم والسلسلة وقوة المفتاح كلها ناجحة.')}</div>
<div class="grid2">{img(os.path.join(ER, 'crt-e2-applied.png'), 'طبّقها العامل؛ مدخل https يقدّم الشهادة الجديدة (تحقق بالبصمة).')}
{img(os.path.join(ER, 'crt-e3-restored.png'), 'الاستعادة: الشهادة السابقة تُقدَّم من جديد.')}</div>
{img(os.path.join(ER, 'crt-e5-directory.png'), 'ثقة الدليل الخاصة: جهة مصدّرة من مجلد شهادات الجهاز، مختبرة حياً أولاً، ومطبقة فوراً.')}
{img(os.path.join(ER, 'stepup-notice.png'), 'التطبيق بدخول أقدم من خمس دقائق: تأكيد الهوية في مكانه أولاً؛ لا يتغير شيء قبله.')}
<p><b>استرداد طارئ دون المتصفح:</b> انسخ {c('server.crt')} و{c('server.key')} و{c('ca-chain.pem')} من {c('backups/certificates/<request>/')} إلى مجلد {c('TMRKZ_TLS_DIR')}؛ يعيد مدخل https تحميلها خلال ثوانٍ.</p>
""")

# ---- 10. env import -----------------------------------------------------------------------------------------------------
section('env', 'استيراد الإعدادات من التطبيق المتوافق', f"""
<ol class="steps">
<li>{E('«إدارة النظام ← استيراد ملف إعدادات ← اختيار ملف الإعدادات»')}: اختر ملف {c('.env')} للتطبيق المتوافق (مثل MOVER). يُقرأ مرة ولا يُحفظ.</li>
<li>كل إعداد معروف يظهر مع قسمه والقيمة النافذة والقيمة المستوردة: {E('«جديد»')} أو {E('«مطابق»')} أو {E('«تعارض»')}. الأسرار تظهر •••• فقط.</li>
<li>بيانات قاعدة البيانات، ومفاتيح التوقيع والتشفير، وإعدادات OpenFGA ومزود الهوية المحلي تُذكر بالاسم فقط على أنها «لا تُستورد أبداً».</li>
<li>اختر القيم ثم {E('«اختبار القيم المختارة»')} (اتصال حي بالدليل / Keycloak / خادم النماذج)، ثم السبب و{E('«تطبيق على إعدادات التكامل»')}. ملف {c('.env')} لا يُكتب أبداً.</li>
</ol>
<div class="grid2">{img(os.path.join(ER, 'env-e1-preview.png'), 'المعاينة: تعارض غير مختار، ملف الجهة المصدّرة موجود في مجلدات هذا الجهاز، وما لا يُستورد مذكور بالاسم.')}
{img(os.path.join(ER, 'env-e2-tested.png'), 'القيم المختارة تنجح في اتصال حي محمي قبل أن يمكن تطبيقها.')}</div>
""")

# ---- 11. administrators -------------------------------------------------------------------------------------------------
section('admins', 'إضافة مدير نظام آخر', f"""
<table><thead><tr><th>إعداد الدليل على الـVM</th><th>ما تعرضه الشاشة</th></tr></thead><tbody>
<tr><td>حساب خدمة للقراءة فقط في {E('«إعدادات التكامل»')}</td><td>يُعثر على أي حساب في الدليل قبل دخوله الأول.</td></tr>
<tr><td>دون حساب خدمة (ADR-100 — حالة الـVM)</td><td>المدير الداخل بالدليل يكتب كلمة مرور الدليل <b>الخاصة به</b> لهذا البحث وحده (لا تُحفظ، ومحدودة المحاولات).</td></tr>
<tr><td>المدير داخل بحساب المنصة، أو لا دليل</td><td>تشرح الشاشة لماذا لا يمكن البحث؛ البدائل: الرقم الوظيفي من Oracle HR، أو دخول الشخص مرة واحدة.</td></tr>
</tbody></table>
<ol class="steps">
<li>{E('«إدارة النظام ← مديرو النظام ← ＋ مدير جديد ← حساب الدليل المؤسسي»')}.</li>
<li>ابحث باسم الدخول؛ تظهر الهوية التي عُثر عليها كاملة للتأكيد.</li>
<li>اكتب السبب وأكّد. يُنشأ الشخص تماماً كما سيُنشئه دخوله الأول، فيصل دخوله لاحقاً إلى السجل نفسه. التكرار مرفوض، وآخر مدير فعال لا يُزال.</li>
</ol>
{img(os.path.join(ER, 'adm-e2-candidate.png'), 'حساب لم يدخل من قبل، وُجد في الدليل وعُرض للتأكيد.')}
""")

# ---- 12. diagnosis ------------------------------------------------------------------------------------------------------
section('diagnose', 'تشخيص المكتبات والخرائط والخدمات والتركيبات', f"""
<table><thead><tr><th>العَرَض</th><th>الفحص (للقراءة فقط)</th><th>المعالجة</th></tr></thead><tbody>
<tr><td>خدمة لا تعمل أو تعيد التشغيل</td><td>{c('docker compose ps')} ثم {c('docker compose logs --tail 80 <service>')}</td><td>أصلح السبب المذكور في السجل؛ ثم {c('sh start.sh')}. لا تحذف المجلدات.</td></tr>
<tr><td>صورة مفقودة (مكتبة/اعتمادية)</td><td>{c('docker image ls | grep -E "tmrkz|postgis|openfga|keycloak|nginx"')}، والقسم 2 من {c('diagnose.sh')}</td><td>حمّل الصور المعتمدة من {c('tmrkz-images.tar')} بـ{c('docker load -i tmrkz-images.tar')}؛ التحديث لا يجلب مكتبات.</td></tr>
<tr><td>«تغيرت مكتبات الواجهة» في مركز التحديث</td><td>{c('frontend/package-lock.json')} في القائمة موسوم {c('NEW_DEPENDENCY')}</td><td>لا يُطبق من المتصفح: يحتاج صورة جديدة معتمدة.</td></tr>
<tr><td>الخريطة فارغة أو بلا خلفية</td><td>القسم «الخرائط» في {c('diagnose.sh')}: {c('TMRKZ_MAP_ROOT')}، {c('map-runtime/')}، الحزم المثبتة</td><td>تأكد أن {c('TMRKZ_MAP_ROOT')} في {c('.env')} يشير إلى مجلد موجود ومركّب للقراءة؛ لا تنقل بيانات الخرائط عبر التحديث.</td></tr>
<tr><td>صفحة فارغة في المتصفح</td><td>F12 ← Console، و{c('docker compose logs --tail 80 web web-build')}</td><td>انتظر انتهاء {c('web-build')}؛ إن فشل البناء فارجع بالتحديث الأخير (القسم 13).</td></tr>
<tr><td>تركيب (mount) مفقود</td><td>{c('docker inspect <container> --format "{{json .Mounts}}"')}، والقسم «المجلدات» في {c('diagnose.sh')}</td><td>تحقق من {c('COMPOSE_FILE')} في {c('.env')} ومن وجود المجلدات ({c('data/')}، {c('certs/')}، {c('map-runtime/')}).</td></tr>
<tr><td>عامل الصيانة متوقف</td><td>{c('docker compose ps maintenance')} و{c('docker compose logs maintenance')}</td><td>{c('docker compose up -d maintenance')}؛ تحقق من وجود {c('ops/local/.generated/release-trust.pub')}.</td></tr>
<tr><td>تسجيل الدخول بالدليل يفشل</td><td>{E('«إعدادات التكامل ← الدليل ← اختبار»')} والقسم «الهويات» في {c('diagnose.sh')}</td><td>صحح عنوان الدليل والجهة المصدّرة من {E('«الشهادات»')}؛ لا يلزم حساب خدمة.</td></tr>
</tbody></table>
""")

# ---- 13. recovery -------------------------------------------------------------------------------------------------------
section('recovery', 'الاسترداد عندما لا يفتح المتصفح', f"""
<table><thead><tr><th>الحالة</th><th>الاسترداد (على الـVM عبر PAM)</th></tr></thead><tbody>
<tr><td>الإعداد لأول مرة</td><td>{c('sh /data/'+pkg+'/bootstrap.sh restore /data/TMRKZ/backups/bootstrap/<time>')} ثم {c('sh start.sh')}</td></tr>
<tr><td>تحديث من المتصفح أفسد الواجهة</td><td>انسخ {c('backups/updates/<id>/before/*')} إلى أماكنها، واحذف الملفات المذكورة في {c('backups/updates/<id>/added.txt')}، وأعد {c('backups/updates/<id>/baseline-before.tsv')} إلى {c('backups/updates/installed-MANIFEST.tsv')}؛ تُعاد الخدمات بنفسها، أو {c('sh start.sh')}.</td></tr>
<tr><td>شهادة https</td><td>انسخ من {c('backups/certificates/<id>/')} إلى {c('TMRKZ_TLS_DIR')}؛ يعيد proxy تحميلها.</td></tr>
<tr><td>إعداد تكامل مستورد</td><td>عدّل القسم أو امسحه في {E('«إعدادات التكامل»')} (القيم السابقة في تفاصيل التدقيق).</td></tr>
<tr><td>كل الخدمات متوقفة</td><td>{c('cd /data/TMRKZ && sh start.sh')}؛ ثم {c('docker compose ps')}.</td></tr>
</tbody></table>
{code('cd /data/TMRKZ' + chr(10) + 'ls -1 backups/updates | tail -n 5          # آخر التحديثات' + chr(10) + 'cat backups/updates/<id>/added.txt' + chr(10) + '(cd backups/updates/<id>/before && find . -type f) | head', 'أوامر مساعدة للقراءة')}
""")

# ---- 14. this release -----------------------------------------------------------------------------------------------------
section('changes', 'ما الجديد في هذا الإصدار (ADR-106)', f"""
<ul>
<li><b>مناطق الانتشار لا تتجاوز الحد (طلب المالك):</b> منطقة الانتشار الرئيسية والفرعية لا توضع ولا تُسحب ولا تُرسم أبعد من أقصى مسافة: الحد
الأقصى الأساسي مع ما تضيفه طبيعة الأرض. السهم يتوقف عند الحد، وبعد الوضع تُقيَّم الأرض تحت المنطقة فتعاد إلى أقصى مسافة تسمح بها تلك الأرض.</li>
<li><b>حدود موقع أكبر من الحد الأقصى في سياسة التمركز</b> تُرفض في «تحديد مواقع التمركز المبدئية» (كان موقع بمساحة 271 كم² قد سُجل مقابل حد 0.5 كم²).</li>
<li><b>الصفحات لا تختار ولا تنتقل وحدها:</b> طلب جديد يبدأ من الخطوة الأولى دون اختيار؛ والموقف العملياتي لا يقرّب الخريطة عند الفتح.</li>
<li><b>جهات العلم:</b> شاشة «الجهات الرئيسية للعلم» هي المصدر الوحيد لما يُبلَّغ عند الاعتماد النهائي، مع «وما دونها» وسبب مدقق لكل تغيير.</li>
<li><b>فحص توافق الـVM</b> في حزمة الإعداد (القسم 7).</li>
<li><b>إخفاقات الخادم العشرون:</b> حُللت كلها وعولجت بدليل (التقرير في {c('4_ACCEPTANCE_AND_RECOVERY')}).</li>
</ul>
{img(os.path.join(EG, 'guide-reach.png'), 'منطقة انتشار نُقر لوضعها بعيداً: وُضعت عند أقصى مسافة تسمح بها الأرض تحتها، مع السبب.', True, True)}
""")

# ---- 15. results -----------------------------------------------------------------------------------------------------------
section('results', 'نتائج الاختبارات', f"""
<div class="note">{E(cfg.get('runsNote', ''))}</div>
<h3>حزمة الإعداد على نسخة تجريبية من الـVM</h3>
{result_table(boot_rows, 'tests/acceptance/bootstrap-test.sh')}
<h3>مركز التحديث</h3>
{result_table(uc, 'tests/acceptance/update-center.mjs')}
<h3>قبول الإصدار</h3>
{result_table(rel, 'tests/acceptance/release-acceptance.mjs')}
<h3>الواجهة والخريطة</h3>
<div class="note">التوقيتات والتخطيط هنا قيست على جهاز التطوير (Docker Desktop، Edge دون نافذة)، ولا تدل على سرعة الـVM.</div>
{result_table(ui, 'tests/acceptance/ui-regression.mjs')}
""")

# ---- 16. open ---------------------------------------------------------------------------------------------------------------
section('open', 'ما يزال مفتوحاً', ''.join(f'<p>• {E(x)}</p>' for x in cfg.get('open', [])) or '<p>—</p>')

# ---- 17. commands -----------------------------------------------------------------------------------------------------------
section('commands', 'ملحق: الأوامر كاملة', f"""
{code('cd %USERPROFILE%\\Desktop\\TMRKZ' + chr(10) + '"C:\\Program Files\\Git\\bin\\sh.exe" ops/update/make-release.sh --bootstrap ' + cfg.get('baseCommit', 'e30c1c1') + chr(10) + '"C:\\Program Files\\Git\\bin\\sh.exe" ops/update/make-release.sh', 'جهاز التطوير (CMD) — بناء الحزمة ثم الإصدار للتحديثات اللاحقة')}
{code('cd %USERPROFILE%\\Desktop\\1_VM_BOOTSTRAP' + chr(10) + 'certutil -hashfile TMRKZ-bootstrap-*.tar SHA256', 'سطح مكتب Windows (CMD) — التحقق قبل النقل')}
{code(f'cd /data/{pkg}' + chr(10) + 'sha256sum -c SHA256SUMS' + chr(10) + 'sh bootstrap.sh check /data/TMRKZ | tee /tmp/tmrkz-bootstrap-check.txt' + chr(10) + 'sh bootstrap.sh apply /data/TMRKZ --with-config            # أو مع --keep-local / --overwrite-local' + chr(10) + 'cd /data/TMRKZ && sh start.sh' + chr(10) + 'docker compose ps maintenance' + chr(10) + 'sh ops/diagnose.sh --logins u123456,aeda123456 > /tmp/tmrkz-diagnose.txt', 'الـVM — أول مرة')}
{code(f'sh /data/{pkg}/bootstrap.sh restore /data/TMRKZ/backups/bootstrap/<time>' + chr(10) + 'cd /data/TMRKZ && sh start.sh', 'الـVM — التراجع عن الإعداد')}
""")

out = cfg['out']
os.makedirs(os.path.dirname(out), exist_ok=True)
with open(out, 'w', encoding='utf-8', newline='\n') as f:
    f.write(f"""<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TMRKZ — دليل التسليم والإعداد والقبول</title><style>{css}</style></head><body>
<header class="top"><h1>TMRKZ — دليل التسليم الكامل: من جهاز التطوير إلى الـVM</h1>
<p>25 نوفمبر 2026 · ADR-103 · ADR-104 · ADR-105 · ADR-106 · الإيداع ومعرّف الإصدار: في START_HERE.txt</p>
<p>كل الصور من التطبيق نفسه ببيانات وهمية على تثبيت تجريبي؛ لا بيانات حقيقية ولا مواقع حقيقية.</p></header>
<div class="layout"><nav class="toc"><b>المحتويات</b>{''.join(f'<a href="#{i}"><span class="n">{n + 1}.</span> {E(t)}</a>' for n, (i, t) in enumerate(toc))}</nav>
<main>{''.join(S)}</main></div></body></html>""")
print('written', out, os.path.getsize(out) // 1024, 'KB')
