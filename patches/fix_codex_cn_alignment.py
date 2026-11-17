"""Re-align uncompressed ZIP members in the Codex CN APK and sign with its original identity.
Does not include or regenerate the private signing key in output.
"""
from pathlib import Path
import os, struct, zipfile, hashlib
from cryptography import x509
from cryptography.hazmat.primitives import serialization, hashes
from cryptography.hazmat.primitives.asymmetric import ec
from rename_codex_cn import read_zip_layout,cd_records,copy_region,content_digest,verify_v2,lp

INPUT=Path('/mnt/data/Codex-CN-V3-arm64.apk')
UNSIGNED=Path('/mnt/data/Codex-CN-V3-aligned-unsigned.tmp')
OUTPUT=Path('/mnt/data/Codex-CN-V3-Fixed-arm64.apk')
KEY=Path('/mnt/data/codex-cn-signing-key-private.pem')


def source_cert(path):
    start, cd, eo=read_zip_layout(path)
    with path.open('rb') as f:
        f.seek(start+8); size=struct.unpack('<Q',f.read(8))[0]
        pair_id=struct.unpack('<I',f.read(4))[0]
        assert pair_id == 0x7109871a
        block=f.read(size-4)
    count=struct.unpack_from('<I',block)[0]
    signers=block[4:4+count]
    signer_sz=struct.unpack_from('<I',signers)[0]
    signer=signers[4:4+signer_sz]
    signed_sz=struct.unpack_from('<I',signer)[0]
    signed=signer[4:4+signed_sz]
    digest_collection_length=struct.unpack_from('<I',signed)[0]
    p=4+digest_collection_length
    cert_collection_sz=struct.unpack_from('<I',signed,p)[0]
    p+=4
    cert_collection=signed[p:p+cert_collection_sz]
    cert_sz=struct.unpack_from('<I',cert_collection)[0]
    cert_data=cert_collection[4:4+cert_sz]
    assert len(cert_data) == cert_sz
    return cert_data


def aligned_unsigned():
    sb_start, cd, eocd = read_zip_layout(INPUT)
    original_records = cd_records(cd)
    with zipfile.ZipFile(INPUT) as src:
        infos={x.filename:x for x in src.infolist()}
    sorted_items=sorted(infos.values(),key=lambda i:i.header_offset)
    offmap={}
    aligned=[]
    with INPUT.open('rb') as src, UNSIGNED.open('wb') as dst:
        for i, item in enumerate(sorted_items):
            fname=item.filename
            offmap[fname]=dst.tell()
            src.seek(item.header_offset)
            local_header=bytearray(src.read(30))
            assert local_header[:4] == b'PK\x03\x04'
            nl,el=struct.unpack_from('<HH',local_header,26)
            name=src.read(nl)
            extra=src.read(el)
            assert name.decode('utf-8')==fname
            src_file_data_start=item.header_offset+30+nl+el
            if item.compress_type == zipfile.ZIP_STORED:
                target_offset=dst.tell()+30+nl+el
                desired=(-target_offset)%4
                # ZIP extra fields must have at least 4 bytes (header+size). 4 + desired preserves alignment.
                padding=bytes((0xfd,0xca))+struct.pack('<H',desired)+bytes(desired)
                extra+=padding
                el+=len(padding)
                struct.pack_into('<H',local_header,28,el)
                aligned.append((fname, desired))
            dst.write(local_header)
            dst.write(name)
            dst.write(extra)
            end=(sorted_items[i+1].header_offset if i+1<len(sorted_items) else sb_start)
            copy_region(src,dst,src_file_data_start,end-src_file_data_start)
        cd_start=dst.tell()
        for name,rec in original_records:
            struct.pack_into('<I',rec,42,offmap[name])
            dst.write(rec)
        cd_size=dst.tell()-cd_start
        e=bytearray(eocd)
        struct.pack_into('<I',e,12,cd_size)
        struct.pack_into('<I',e,16,cd_start)
        dst.write(e)
    print('Aligned',len(aligned),'uncompressed entries, original offsets were mod4 at',[(n,v) for n,v in aligned if n in ['classes.dex','classes2.dex','classes3.dex','classes4.dex','classes5.dex','classes6.dex','resources.arsc']])
    return cd_start,cd_size


def signing_block(digest,private,cert_der):
    pub=private.public_key().public_bytes(serialization.Encoding.DER,serialization.PublicFormat.SubjectPublicKeyInfo)
    cert=x509.load_der_x509_certificate(cert_der)
    assert cert.public_key().public_bytes(serialization.Encoding.DER,serialization.PublicFormat.SubjectPublicKeyInfo)==pub
    algo=0x0201
    digests=lp(struct.pack('<I',algo)+lp(digest))
    signed_data=lp(digests)+lp(lp(cert_der))+lp(b'')
    signature=private.sign(signed_data,ec.ECDSA(hashes.SHA256()))
    signer=lp(signed_data)+lp(lp(struct.pack('<I',algo)+lp(signature)))+lp(pub)
    v2_data=lp(lp(signer))
    pair=struct.pack('<Q',4+len(v2_data))+struct.pack('<I',0x7109871a)+v2_data
    sz=len(pair)+8+16
    return struct.pack('<Q',sz)+pair+struct.pack('<Q',sz)+b'APK Sig Block 42'


def sign(cd_start,cd_size):
    digest=content_digest(UNSIGNED,cd_start,cd_size)
    private=serialization.load_pem_private_key(KEY.read_bytes(),password=None)
    cert_der=source_cert(INPUT)
    block=signing_block(digest,private,cert_der)
    with UNSIGNED.open('rb') as src,OUTPUT.open('wb') as dst:
        copy_region(src,dst,0,cd_start)
        dst.write(block)
        copy_region(src,dst,cd_start,cd_size)
        src.seek(cd_start+cd_size)
        e=bytearray(src.read())
        struct.pack_into('<I',e,16,cd_start+len(block))
        dst.write(e)
    assert verify_v2(OUTPUT,digest)
    assert source_cert(OUTPUT)==cert_der


def check():
    with zipfile.ZipFile(INPUT) as a,zipfile.ZipFile(OUTPUT) as b:
        assert a.namelist()==b.namelist()
        for item in a.infolist():
            orig=a.getinfo(item.filename)
            new=b.getinfo(item.filename)
            assert orig.CRC==new.CRC and orig.file_size==new.file_size, item.filename
        assert b.testzip() is None
        with OUTPUT.open('rb') as f:
            bad=[]
            for item in b.infolist():
                if item.compress_type != zipfile.ZIP_STORED:continue
                f.seek(item.header_offset)
                h=f.read(30)
                nl,el=struct.unpack_from('<HH',h,26)
                data_offset=item.header_offset+30+nl+el
                if data_offset%4:bad.append((item.filename,data_offset%4))
            assert not bad,bad
    print('Verified all ZIP entries (CRC/size), data offset alignment, v2 signature, unchanged signer cert')

if __name__=='__main__':
    cd_start,cd_size=aligned_unsigned()
    try:
        sign(cd_start,cd_size)
        check()
    finally:
        UNSIGNED.unlink(missing_ok=True)
    print('FINAL',OUTPUT,'bytes',OUTPUT.stat().st_size,'SHA256',hashlib.sha256(OUTPUT.read_bytes()).hexdigest())
