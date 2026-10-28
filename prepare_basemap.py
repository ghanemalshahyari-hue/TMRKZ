"""Small offline demonstration extract from OpenFreeMap / OpenMapTiles / OSM.

MVT decoding follows https://github.com/mapbox/vector-tile-spec/tree/master/2.1.
One bounded extract, fewer than 20 tiles; no imagery, private data or live feeds.
"""
import json, math, urllib.request, struct, gzip
from pathlib import Path

ROOT=Path(__file__).parent
HEADERS={'User-Agent':'MOVER-Concept-Lab/1.0 (administrative UI prototype; bounded offline map extract)'}

def get(url):
    return urllib.request.urlopen(urllib.request.Request(url,headers=HEADERS),timeout=30).read()

def varint(b,p):
    n=0;s=0
    while True:
        c=b[p];p+=1;n|=(c&127)<<s
        if c<128:return n,p
        s+=7

def fields(b):
    p=0
    while p<len(b):
        k,p=varint(b,p);num,typ=k>>3,k&7
        if typ==0:v,p=varint(b,p)
        elif typ==1:v=b[p:p+8];p+=8
        elif typ==2:
            n,p=varint(b,p);v=b[p:p+n];p+=n
        elif typ==5:v=b[p:p+4];p+=4
        else:raise ValueError('unsupported wire type')
        yield num,typ,v

def packed(b):
    a=[];p=0
    while p<len(b):v,p=varint(b,p);a.append(v)
    return a

def value(b):
    for n,t,v in fields(b):
        if n==1:return v.decode()
        if n==2:return struct.unpack('<f',v)[0]
        if n==3:return struct.unpack('<d',v)[0]
        if n in (4,5):return v
        if n==6:return (v>>1)^-(v&1)
        if n==7:return bool(v)

def xy(lng,lat,z):
    n=2**z
    return (int((lng+180)/360*n),int((1-math.asinh(math.tan(math.radians(lat)))/math.pi)/2*n))

def geometry(raw,typ,tx,ty,z,extent):
    data=packed(raw);p=0;x=y=0;paths=[];path=[]
    def point(x,y):
        nx=(tx+x/extent)/2**z;ny=(ty+y/extent)/2**z
        return [round(nx*360-180,5),round(math.degrees(math.atan(math.sinh(math.pi*(1-2*ny)))),5)]
    while p<len(data):
        cmd=data[p];p+=1;cid,count=cmd&7,cmd>>3
        if cid in (1,2):
            for _ in range(count):
                dx,dy=data[p:p+2];p+=2;x+=(dx>>1)^-(dx&1);y+=(dy>>1)^-(dy&1)
                if cid==1 and path:paths.append(path);path=[]
                path.append(point(x,y))
        elif cid==7:
            if path and path[-1]!=path[0]:path.append(path[0])
        else:raise ValueError('unsupported geometry command')
    if path:paths.append(path)
    if typ==1:return {'type':'Point','coordinates':paths[0][0]} if paths else None
    if typ==2:
        paths=[p for p in paths if len(p)>1]
        return {'type':'MultiLineString','coordinates':paths} if paths else None
    if typ==3:
        # Keep the ring order supplied by the tile; Leaflet's even-odd fill handles holes.
        paths=[p for p in paths if len(p)>3]
        return {'type':'Polygon','coordinates':paths} if paths else None

def extract(b,tx,ty,z):
    if b[:2]==b'\x1f\x8b':b=gzip.decompress(b)
    out=[]
    for n,t,layer in fields(b):
        if n!=3:continue
        name='';extent=4096;keys=[];vals=[];features=[]
        for num,typ,v in fields(layer):
            if num==1:name=v.decode()
            elif num==2:features.append(v)
            elif num==3:keys.append(v.decode())
            elif num==4:vals.append(value(v))
            elif num==5:extent=v
        if name not in ('water','waterway','landcover','landuse','park','transportation','building','place'):continue
        for f in features:
            attrs={};ft=0;raw=b'';tags=[]
            for num,typ,v in fields(f):
                if num==2:tags=packed(v)
                elif num==3:ft=v
                elif num==4:raw=v
            for i in range(0,len(tags),2):attrs[keys[tags[i]]]=vals[tags[i+1]]
            if name=='transportation' and attrs.get('class') in ('path','track','service','rail','transit','minor_construction'):continue
            if name=='place' and attrs.get('class') not in ('city','town','suburb','neighbourhood'):continue
            g=geometry(raw,ft,tx,ty,z,extent)
            if not g:continue
            props={'layer':name,'class':attrs.get('class','')}
            if name=='place':props['name']=attrs.get('name:en',attrs.get('name',''))
            out.append({'type':'Feature','properties':props,'geometry':g})
    return out

if __name__=='__main__':
    metadata=json.loads(get('https://tiles.openfreemap.org/planet'))
    template=metadata['tiles'][0];z=12
    west,north=xy(55.20,25.27,z);east,south=xy(55.41,25.14,z)
    features=[];total=0;tiles=[]
    for x in range(west,east+1):
        for y in range(north,south+1):
            url=template.format(z=z,x=x,y=y)
            b=get(url);total+=len(b);part=extract(b,x,y,z);features.extend(part);tiles.append([z,x,y])
            print(json.dumps({'tile':[z,x,y],'bytes':len(b),'features':len(part)}),flush=True)
    assert len(tiles)<20 and total<50*1024*1024
    result={'type':'FeatureCollection','metadata':{'source':'OpenFreeMap / OpenMapTiles / OpenStreetMap','url':'https://openfreemap.org/','source_tiles':template,'tiles':tiles,'extracted':'2026-10-28','license':'https://www.openstreetmap.org/copyright','purpose':'Illustrative basemap for fictional administrative facilities'},'features':features}
    (ROOT/'basemap.geojson').write_text(json.dumps(result,ensure_ascii=False,separators=(',',':')))
    print(json.dumps({'total_features':len(features),'source_bytes':total,'geojson_bytes':(ROOT/'basemap.geojson').stat().st_size}),flush=True)
