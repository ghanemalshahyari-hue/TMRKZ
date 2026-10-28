"""Build the self-contained administrative prototype and its Claude handoff."""
from pathlib import Path
import json, re, shutil, zipfile
import build_concepts as shared

ROOT=Path(__file__).parent
DIST=ROOT/'dist'
HANDOFF=ROOT/'handoff'

def build():
    if not (DIST/'concepts.html').exists():
        shutil.copy2(DIST/'index.html',DIST/'concepts.html')
    template=(ROOT/'unified/shell.html').read_text()
    template=template.replace('href="index.html">التصاميم السابقة','href="concepts.html">التصاميم السابقة')
    js=(ROOT/'unified/app.js').read_text()
    # A downloaded package has the guide beside the prototype, not a copy of itself.
    js+="\nif(location.protocol==='file:')document.querySelectorAll('a[href=\"mover-claude-handoff.zip\"]').forEach(a=>{a.href='handoff/START_HERE.md';a.textContent='دليل حزمة البناء ↓'});\n"
    replacements={
        '__FONT__':shared.FONT,
        '__LEAFLET_CSS__':shared.LEAFLET_CSS,
        '__APP_CSS__':(ROOT/'unified/style.css').read_text(),
        '__MAP_ICON__':shared.icon('map'),
        '__LEAFLET_LICENSE__':shared.LICENSE.replace('*/','* /'),
        '__LEAFLET_JS__':shared.LEAFLET,
        '__ICONS_JSON__':json.dumps(shared.ICONS,ensure_ascii=False),
        '__MAP_GZIP__':shared.BASEMAP_B64,
        '__APP_JS__':js,
    }
    for key,value in replacements.items():template=template.replace(key,value)
    for name in ['index.html','prototype.html','06-unified.html']:
        (DIST/name).write_text(template)
    out=DIST/'handoff';out.mkdir(exist_ok=True)
    for p in HANDOFF.glob('*.md'):shutil.copy2(p,out/p.name)
    requirements=[]
    for line in (HANDOFF/'REQUIREMENTS.md').read_text().splitlines():
        if re.match(r'\| R-\d+',line):
            cells=[c.strip() for c in line.strip('|').split('|')]
            requirements.append(dict(id=cells[0],requirement=cells[1],acceptance=cells[2]))
    manifest={
        'product':'MOVER Administrative Facilities',
        'version':'0.2',
        'date':'2026-10-28',
        'locale':'ar-AE','direction':'rtl','timezone':'Asia/Dubai',
        'scope':'administrative facilities, reservations and approval workflows',
        'excluded':['military deployment planning','tactical positioning recommendations'],
        'target_records':{'organizations':7000,'people':200000,'concurrent_users':None},
        'deployment_target':'isolated on-premises containers',
        'prototype':{'storage':'browser-local only','authentication':False,'pki_signature':False,'external_runtime_requests':False},
        'request_types':['نقل إداري','إشغال مؤقت','تمديد','تعديل','إلغاء','إخلاء'],
        'requirements':requirements,
        'open_decisions':['D-01','D-02','D-03','D-04','D-05','D-06','D-07','D-08','D-09'],
    }
    (HANDOFF/'requirements.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2))
    shutil.copy2(HANDOFF/'requirements.json',out/'requirements.json')
    zpath=DIST/'mover-claude-handoff.zip'
    with zipfile.ZipFile(zpath,'w',zipfile.ZIP_DEFLATED) as z:
        for name in ['prototype.html','index.html','concepts.html','questions.html','01-atlas.html','02-request.html','03-review.html','04-structure.html','05-calendar.html','mover-five-concepts.zip']:
            z.write(DIST/name,name)
        for p in sorted(HANDOFF.iterdir()):
            if p.is_file():z.write(p,p.name);z.write(p,'handoff/'+p.name)
        for p in sorted((ROOT/'unified').iterdir()):
            if p.is_file():z.write(p,'prototype-source/'+p.name)
        z.write(ROOT/'basemap.geojson','map-data/basemap.geojson')
        z.write(ROOT/'basemap.svg','map-data/basemap.svg')
        z.write(ROOT/'assets/leaflet-license.txt','licenses/LEAFLET-LICENSE.txt')
        z.write(ROOT/'FONT-LICENSE.txt','licenses/FONT-LICENSE.txt')
        z.writestr('licenses/MAP-DATA-LICENSE.txt','Map data: OpenFreeMap / OpenMapTiles / OpenStreetMap contributors.\nhttps://www.openstreetmap.org/copyright\nhttps://opendatacommons.org/licenses/odbl/1-0/\nIllustrative regional extract, not a navigation map. Details and source tile date in map-data/basemap.geojson.\nAll named facilities, boundaries, people and requests in the prototype are fictional.\n')
    print(json.dumps({'prototype':str(DIST/'prototype.html'),'package':str(zpath),'package_bytes':zpath.stat().st_size,'requirements':len(requirements),'documents':len(list(HANDOFF.glob('*.md')))},ensure_ascii=False))

if __name__=='__main__':build()
