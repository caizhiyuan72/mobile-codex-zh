"""In-place compatibility update: patch V3 UI to bundle missing reasoning policy.
Rebuild an aligned APK and sign with the *existing* Codex CN signing key/certificate.
No user data or API key is read, embedded, or transmitted by this script.
"""
from pathlib import Path
import hashlib, os, struct, zipfile, zlib
from cryptography.hazmat.primitives import serialization
from rename_codex_cn import read_zip_layout,cd_records,copy_region,content_digest,verify_v2
from fix_codex_cn_alignment import source_cert,signing_block

ROOT=Path('/mnt/data')
INPUT=ROOT/'Codex-CN-V3-Fixed-arm64.apk'
OUTPUT=ROOT/'Codex-CN-V3-API-Fix-arm64.apk'
TMP=ROOT/'Codex-CN-V3-API-Fix-unsigned.tmp'
KEY=ROOT/'codex-cn-signing-key-private.pem'

assert INPUT.exists() and KEY.exists()
with zipfile.ZipFile(INPUT) as z:
    original_app=z.read('assets/web/app.js').decode('utf-8')
    policy=z.read('assets/web/reasoning-policy.js').decode('utf-8')
    assert 'window.MobileCodexReasoning' in original_app
    assert 'window.MobileCodexReasoning = api' in policy
    assert '/* V3.1 bundled reasoning compatibility */' not in original_app
    # Bundle this small script inside app.js, which is already loaded; no second asset request is needed.
    fixed_app=('/* V3.1 bundled reasoning compatibility */\n'+policy+'\n'+original_app).encode('utf-8')
    # Do not touch native providers API, packages, or storage, to maintain user data.
    changes={'assets/web/app.js':fixed_app}
    src_info={entry.filename:entry for entry in z.infolist()}


def compress_raw(data):
    obj=zlib.compressobj(level=6,method=zlib.DEFLATED,wbits=-15)
    return obj.compress(data)+obj.flush()

sb_start,cd,eocd=read_zip_layout(INPUT)
central=cd_records(cd)
ordered=sorted(src_info.values(),key=lambda i:i.header_offset)
locations={}
modified={}
with INPUT.open('rb') as src,TMP.open('wb') as dst:
    for idx,entry in enumerate(ordered):
        name=entry.filename
        locations[name]=dst.tell()
        src.seek(entry.header_offset)
        h=bytearray(src.read(30))
        assert h[:4]==b'PK\x03\x04',name
        nlen,xlen=struct.unpack_from('<HH',h,26)
        name_raw=src.read(nlen)
        extra=src.read(xlen)
        assert name_raw.decode('utf-8')==name
        data_off=entry.header_offset+30+nlen+xlen
        if entry.compress_type==zipfile.ZIP_STORED:
            align_padding=(-(dst.tell()+30+nlen+xlen))%4
            # Well-formed local extra field consisting of (ID,length,padding).
            extra+=struct.pack('<HH',0xCAFD,align_padding)+bytes(align_padding)
            assert len(extra)<65536
        struct.pack_into('<H',h,28,len(extra))
        if name in changes:
            clear=changes[name]
            if entry.compress_type==zipfile.ZIP_DEFLATED:
                payload=compress_raw(clear)
            elif entry.compress_type==zipfile.ZIP_STORED:
                payload=clear
            else: raise ValueError('Unsupported compression '+name)
            crc=zlib.crc32(clear)&0xffffffff
            flags=struct.unpack_from('<H',h,6)[0] & ~8
            struct.pack_into('<H',h,6,flags)
            struct.pack_into('<III',h,14,crc,len(payload),len(clear))
            modified[name]=(crc,len(payload),len(clear),flags)
            dst.write(h);dst.write(name_raw);dst.write(extra);dst.write(payload)
        else:
            dst.write(h);dst.write(name_raw);dst.write(extra)
            end=ordered[idx+1].header_offset if idx+1<len(ordered) else sb_start
            copy_region(src,dst,data_off,end-data_off)
    cd_start=dst.tell()
    for name,record in central:
        struct.pack_into('<I',record,42,locations[name])
        if name in modified:
            crc,csize,usize,flags=modified[name]
            struct.pack_into('<III',record,16,crc,csize,usize)
            struct.pack_into('<H',record,8,flags)
        dst.write(record)
    cd_size=dst.tell()-cd_start
    final_eocd=bytearray(eocd)
    struct.pack_into('<I',final_eocd,12,cd_size)
    struct.pack_into('<I',final_eocd,16,cd_start)
    dst.write(final_eocd)

# Re-sign with the SAME existing EC key and cert. No APK private key embedded.
private=serialization.load_pem_private_key(KEY.read_bytes(),password=None)
cert=source_cert(INPUT)
digest=content_digest(TMP,cd_start,cd_size)
sig=signing_block(digest,private,cert)
with TMP.open('rb') as src,OUTPUT.open('wb') as dst:
    copy_region(src,dst,0,cd_start)
    dst.write(sig)
    copy_region(src,dst,cd_start,cd_size)
    src.seek(cd_start+cd_size)
    eo=bytearray(src.read())
    struct.pack_into('<I',eo,16,cd_start+len(sig))
    dst.write(eo)
TMP.unlink(missing_ok=True)

assert verify_v2(OUTPUT,digest)
assert source_cert(OUTPUT)==cert
with zipfile.ZipFile(INPUT) as old,zipfile.ZipFile(OUTPUT) as new:
    assert old.namelist()==new.namelist()
    assert new.testzip() is None
    changed=[]
    for item in old.infolist():
        key=item.filename
        if old.getinfo(key).CRC != new.getinfo(key).CRC:
            changed.append(key)
            assert key in changes
    assert changed==['assets/web/app.js'],changed
    fixed=new.read('assets/web/app.js')
    assert fixed.startswith(b'/* V3.1 bundled reasoning compatibility */')
    assert b'window.MobileCodexReasoning = api' in fixed
    assert new.read('AndroidManifest.xml')==old.read('AndroidManifest.xml')
    # Verify every stored APK member starts at aligned offset; Android 11+ requires aligned resources.arsc.
    bad=[]
    with OUTPUT.open('rb') as fh:
        for e in new.infolist():
            if e.compress_type!=zipfile.ZIP_STORED:continue
            fh.seek(e.header_offset)
            local=fh.read(30)
            n,x=struct.unpack_from('<HH',local,26)
            pos=e.header_offset+30+n+x
            if pos % 4: bad.append((e.filename,pos))
    assert not bad,bad
print('SUCCESS')
print('APK',str(OUTPUT),'bytes',OUTPUT.stat().st_size)
print('SHA256',hashlib.sha256(OUTPUT.read_bytes()).hexdigest())
print('Changes',changed)
print('Package manifest unchanged; v2 signature certificate identical; 4-byte alignment passed')
