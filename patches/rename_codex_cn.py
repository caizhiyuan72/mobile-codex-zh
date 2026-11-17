"""Rename Mobile Codex V3 application label and resubmit a v2-signed, standalone APK.
Only edits AndroidManifest binary string pool and a few on-screen labels in index.html.
Keeps compressed APK data for all untouched entries, without recompressing native binaries.
"""
import os, struct, zipfile, zlib, shutil, hashlib, datetime, tempfile, math
from pathlib import Path
from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import serialization, hashes
from cryptography.hazmat.primitives.asymmetric import ec

INPUT=Path('/mnt/data/Mobile-Codex-V3-Reasoning-Enhanced-arm64.apk')
OUTPUT=Path('/mnt/data/Codex-CN-V3-arm64.apk')
TMP=Path('/mnt/data/codex-cn-unsigned.tmp')


def u32(b,off):return struct.unpack_from('<I',b,off)[0]

def patch_manifest(b):
    b=bytearray(b)
    if b[:4]!=b'\x03\x00\x08\x00': raise ValueError('Not Android binary XML')
    start=8
    typ,hs,size=struct.unpack_from('<HHI',b,start)
    count,style_count,flags,strings_start,styles_start=struct.unpack_from('<IIIII',b,start+8)
    if typ!=1 or flags & 256: raise ValueError('Unexpected manifest string pool')
    old='Mobile Codex 中文增强版'
    new='Codex CN'
    assert len(new)<len(old)
    hit=[]
    for idx in range(count):
        soff=u32(b,start+hs+4*idx)
        p=start+strings_start+soff
        n=struct.unpack_from('<H',b,p)[0]
        if n & 0x8000: raise ValueError('Unexpected long string')
        s=b[p+2:p+2+2*n].decode('utf-16le')
        if s==old:
            struct.pack_into('<H',b,p,len(new))
            b[p+2:p+2+len(new)*2]=new.encode('utf-16le')
            struct.pack_into('<H',b,p+2+len(new)*2,0)
            hit.append(idx)
    if hit != [40]:raise ValueError(f'App label index unexpected: {hit}')
    return bytes(b)


def patch_html(b):
    html=b.decode('utf-8')
    assert '<title>Mobile Codex V3</title>' in html
    html=html.replace('Mobile Codex', 'Codex CN')
    return html.encode('utf-8')


def compress_raw(b):
    obj=zlib.compressobj(level=6,method=zlib.DEFLATED,wbits=-15)
    return obj.compress(b)+obj.flush()


def read_zip_layout(path):
    with open(path,'rb') as f:
        f.seek(0,os.SEEK_END); size=f.tell()
        f.seek(max(0,size-100000)); tail=f.read()
        last=tail.rfind(b'PK\x05\x06')
        if last < 0: raise ValueError('Missing EOCD')
        eocd=size-len(tail)+last
        f.seek(eocd);e=f.read(size-eocd)
        if len(e)!=22: raise ValueError('ZIP comment unexpectedly nonempty')
        cd_off=u32(e,16); cd_size=u32(e,12)
        f.seek(cd_off-24); foot=f.read(24)
        if foot[-16:]!=b'APK Sig Block 42':
            raise ValueError('Input APK does not have expected v2 signing block')
        sb_len=struct.unpack_from('<Q',foot)[0]+8
        sb_start=cd_off-sb_len
        f.seek(sb_start); sb_initial=struct.unpack('<Q',f.read(8))[0]
        assert sb_initial+8==sb_len
        f.seek(cd_off);cd=f.read(cd_size)
        return sb_start,cd, e


def cd_records(blob):
    p=0;out=[]
    while p<len(blob):
        if blob[p:p+4]!=b'PK\x01\x02':raise ValueError(f'Bad central dir at {p}')
        name_len,ext_len,comment_len=struct.unpack_from('<HHH',blob,p+28)
        n=46+name_len+ext_len+comment_len
        rec=bytearray(blob[p:p+n]); filename=rec[46:46+name_len].decode('utf-8')
        out.append((filename,rec))
        p+=n
    return out


def copy_region(src,dst,offset,n):
    src.seek(offset)
    while n:
        b=src.read(min(n,2*1024*1024))
        if not b: raise EOFError
        dst.write(b);n-=len(b)


def build_unsigned():
    signing_start,cd,eocd=read_zip_layout(INPUT)
    central=cd_records(cd)
    with zipfile.ZipFile(INPUT) as z:
        infos={x.filename:x for x in z.infolist()}
        mods={'AndroidManifest.xml':patch_manifest(z.read('AndroidManifest.xml')),
              'assets/web/index.html':patch_html(z.read('assets/web/index.html'))}
    assert len(infos)==len(central)
    newheaders={}; metas={}
    sorted_items=sorted(infos.values(), key=lambda x:x.header_offset)
    with open(INPUT,'rb') as src, open(TMP,'wb') as dst:
        for idx,item in enumerate(sorted_items):
            newheaders[item.filename]=dst.tell()
            if item.filename not in mods:
                stop=sorted_items[idx+1].header_offset if idx+1<len(sorted_items) else signing_start
                copy_region(src,dst,item.header_offset,stop-item.header_offset)
                continue
            data=mods[item.filename]
            src.seek(item.header_offset);h=src.read(30)
            if h[:4]!=b'PK\x03\x04':raise ValueError('bad local header')
            vals=list(struct.unpack('<IHHHHHIIIHH',h));nameLen=vals[-2];extraLen=vals[-1]
            name=src.read(nameLen);extra=src.read(extraLen)
            if name.decode('utf-8')!=item.filename:raise ValueError('Local filename mismatch')
            method=vals[3]
            if method==8: payload=compress_raw(data)
            elif method==0:payload=data
            else: raise ValueError('unsupported method')
            crc=zlib.crc32(data)&0xffffffff
            vals[2] &= ~8  # no data descriptor
            vals[6]=crc;vals[7]=len(payload);vals[8]=len(data)
            dst.write(struct.pack('<IHHHHHIIIHH',*vals));dst.write(name);dst.write(extra);dst.write(payload)
            metas[item.filename]=(crc,len(payload),len(data),vals[2])
        new_cd_start=dst.tell()
        for name,record in central:
            struct.pack_into('<I',record,42,newheaders[name])
            if name in metas:
                crc,csize,usize,flags=metas[name]
                struct.pack_into('<I',record,16,crc)
                struct.pack_into('<I',record,20,csize)
                struct.pack_into('<I',record,24,usize)
                struct.pack_into('<H',record,8,flags)
            dst.write(record)
        new_cd_size=dst.tell()-new_cd_start
        e=bytearray(eocd)
        struct.pack_into('<I',e,12,new_cd_size)
        struct.pack_into('<I',e,16,new_cd_start)
        dst.write(e)
    with zipfile.ZipFile(TMP) as zipcheck:
        assert len(zipcheck.infolist())==len(infos)
        assert zipcheck.read('AndroidManifest.xml')==mods['AndroidManifest.xml']
        assert zipcheck.read('assets/web/index.html')==mods['assets/web/index.html']
    return new_cd_start, new_cd_size


def lp(x):return struct.pack('<I',len(x))+x

def content_digest(path, cd_start, cd_size):
    total=os.path.getsize(path)
    sections=[(0,cd_start),(cd_start,cd_size),(cd_start+cd_size,total-cd_start-cd_size)]
    chunk_hashes=[]
    with open(path,'rb') as f:
        for pos,n in sections:
            f.seek(pos)
            while n:
                chunk=f.read(min(n,1024*1024))
                chunk_hashes.append(hashlib.sha256(b'\xa5'+struct.pack('<I',len(chunk))+chunk).digest())
                n-=len(chunk)
    return hashlib.sha256(b'\x5a'+struct.pack('<I',len(chunk_hashes))+b''.join(chunk_hashes)).digest()


def signer_block(digest):
    # Self-signed private signing identity for this one-off renamed APK, distinct from V3.
    private_key=ec.generate_private_key(ec.SECP256R1())
    name=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'Codex CN local build')])
    now=datetime.datetime.now(datetime.timezone.utc)
    cert=(x509.CertificateBuilder().subject_name(name).issuer_name(name)
      .public_key(private_key.public_key()).serial_number(x509.random_serial_number())
      .not_valid_before(now-datetime.timedelta(days=1))
      .not_valid_after(now+datetime.timedelta(days=3650))
      .sign(private_key,hashes.SHA256()))
    key_der=private_key.public_key().public_bytes(serialization.Encoding.DER,serialization.PublicFormat.SubjectPublicKeyInfo)
    cert_der=cert.public_bytes(serialization.Encoding.DER)
    algo=0x0201 # ECDSA SHA-256
    digests=lp(struct.pack('<I',algo)+lp(digest))
    signed_data=lp(digests)+lp(lp(cert_der))+lp(b'')
    signature=private_key.sign(signed_data,ec.ECDSA(hashes.SHA256()))
    signature_records=lp(struct.pack('<I',algo)+lp(signature))
    signer=lp(signed_data)+lp(signature_records)+lp(key_der)
    v2_data=lp(lp(signer))
    pair=struct.pack('<Q',4+len(v2_data))+struct.pack('<I',0x7109871a)+v2_data
    size=len(pair)+8+16
    signing=struct.pack('<Q',size)+pair+struct.pack('<Q',size)+b'APK Sig Block 42'
    # This file is intentionally local, not bundled in the APK nor uploaded to public GitHub.
    private_key_path=Path('/mnt/data/codex-cn-signing-key-private.pem')
    private_key_path.write_bytes(private_key.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()))
    os.chmod(private_key_path,0o600)
    return signing


def sign(unsigned_cd_start, unsigned_cd_size):
    digest=content_digest(TMP,unsigned_cd_start,unsigned_cd_size)
    block=signer_block(digest)
    with open(TMP,'rb') as src,open(OUTPUT,'wb') as dst:
        copy_region(src,dst,0,unsigned_cd_start)
        dst.write(block)
        copy_region(src,dst,unsigned_cd_start,unsigned_cd_size)
        src.seek(unsigned_cd_start+unsigned_cd_size);e=bytearray(src.read())
        struct.pack_into('<I',e,16,unsigned_cd_start+len(block))
        dst.write(e)
    return digest,len(block)


def verify_v2(path,digest):
    sb_start,cd,eocd=read_zip_layout(path)
    cdoff=u32(eocd,16)
    with open(path,'rb') as f:
        f.seek(sb_start+8)
        length=struct.unpack('<Q',f.read(8))[0]
        alg=struct.unpack('<I',f.read(4))[0]
        assert alg==0x7109871a
        v2=f.read(length-4)
    # parse APK v2 signing block independently of the builder; verify digest from signing sections
    pos=0
    n=u32(v2,pos);pos+=4
    signers=v2[pos:pos+n]
    assert pos+n==len(v2)
    signer_len=u32(signers,0)
    signer=signers[4:4+signer_len]
    assert 4+signer_len==len(signers)
    p=0
    length=u32(signer,p);p+=4;signed_data=signer[p:p+length];p+=length
    slen=u32(signer,p);p+=4;sigs=signer[p:p+slen];p+=slen
    keylen=u32(signer,p);p+=4; pub=signer[p:p+keylen];p+=keylen
    assert p==len(signer)
    dalen=u32(signed_data,0);d=signed_data[4:4+dalen]
    rec_len=u32(d,0);rec=d[4:4+rec_len]
    assert u32(rec,0)==0x0201
    digest_len=u32(rec,4)
    embedded_digest=rec[8:8+digest_len]
    assert embedded_digest==digest
    p=0;rlen=u32(sigs,p);p+=4;rs=sigs[p:p+rlen]
    assert u32(rs,0)==0x0201
    signature=rs[8:8+u32(rs,4)]
    public=serialization.load_der_public_key(pub)
    public.verify(signature,signed_data,ec.ECDSA(hashes.SHA256()))
    # Compute digest from actual signed APK, with EOCD's CD offset changed to SB start
    with open(path,'rb') as f:
        f.seek(cdoff+len(cd));original_eocd=bytearray(f.read())
        struct.pack_into('<I',original_eocd,16,sb_start)
        # Most of the content can be processed directly without holding it in memory.
        sections=[(0,sb_start),(cdoff,len(cd))]
        chunk_hashes=[]
        for a,n in sections:
            f.seek(a)
            while n:
                b=f.read(min(n,1024*1024));n-=len(b)
                chunk_hashes.append(hashlib.sha256(b'\xa5'+struct.pack('<I',len(b))+b).digest())
        chunk_hashes.append(hashlib.sha256(b'\xa5'+struct.pack('<I',len(original_eocd))+original_eocd).digest())
        actual=hashlib.sha256(b'\x5a'+struct.pack('<I',len(chunk_hashes))+b''.join(chunk_hashes)).digest()
        assert actual==digest,(actual.hex(),digest.hex())
    return True

if __name__=='__main__':
    cd_start,cd_size=build_unsigned()
    digest,sblen=sign(cd_start,cd_size)
    verify_v2(OUTPUT,digest)
    with zipfile.ZipFile(OUTPUT) as z:
        assert z.testzip() is None
        assert b'Codex CN' in z.read('assets/web/index.html')
    print('DONE',OUTPUT,'bytes',os.path.getsize(OUTPUT),'blocklen',sblen,'digest',digest.hex()[:16])
    print('NOTE: Renamed APK requires reinstall if installed signature differs. Keep private signing key safe and never publish it.')
    TMP.unlink(missing_ok=True)
