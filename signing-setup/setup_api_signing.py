#!/usr/bin/env python3
"""One-time setup inside old V5: retain its original API signing identity."""
import argparse, base64, hashlib, json, os, re, secrets, shutil, subprocess, sys
import tempfile, urllib.error, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
V5 = Path('/data/data/dev.mobilecodex.app.zhcnv3/files')
KEY_DIR = V5 / '.codex/signing/codex-cn-api-next'
REPO = 'caizhiyuan72/mobile-codex-zh'
API = 'https://api.github.com/repos/' + REPO
SECRET = 'CODEX_CN_API_SIGNING_JSON'
CERT = 'c3537a4bbf12e671868127ef3267c4806ffabed83d62208d94085ae4fe12b207'

class SetupError(RuntimeError): pass

def checked(args, *, data=None, cwd=None):
    result = subprocess.run(args, input=data, cwd=cwd, capture_output=True)
    if result.returncode:
        raise SetupError('A local verification/encryption operation failed; no secret was printed.')
    return result.stdout

def request(endpoint, token, method='GET', payload=None):
    headers={'User-Agent':'Codex-CN-API-signing-setup','Accept':'application/vnd.github+json',
        'Authorization':'Bearer '+token,'X-GitHub-Api-Version':'2022-11-28'}
    raw=json.dumps(payload).encode() if payload is not None else None
    if raw is not None: headers['Content-Type']='application/json'
    try:
        with urllib.request.urlopen(urllib.request.Request(API+endpoint,data=raw,headers=headers,method=method),timeout=40) as response:
            body=response.read()
            return json.loads(body) if body else {}
    except urllib.error.HTTPError as error:
        raise SetupError('GitHub setup request failed (HTTP %d); the old signing key and backup remain unchanged.' % error.code) from None

def github_token():
    # Existing Android Git helper supplies this in memory, never as a CLI argument.
    result=checked(['git','credential','fill'],data=b'protocol=https\nhost=github.com\n\n')
    values=dict(line.split('=',1) for line in result.decode().splitlines() if '=' in line)
    if not values.get('password'): raise SetupError('GitHub is not connected inside old V5; connect its GitHub account first.')
    return values['password']

def expected_runtime():
    hashes=json.loads((ROOT/'bootstrap-files.json').read_text())
    for name, expected in hashes.items():
        path=ROOT/name
        if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest()!=expected:
            raise SetupError('Setup helper checksum differs: '+name)
    checked(['node',str(ROOT/'crypto-helper.cjs'),'selftest'])

def private_write(path, data):
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    try:
        with os.fdopen(fd,'wb') as stream: stream.write(data)
    except BaseException:
        path.unlink(missing_ok=True)
        raise

def install_secret(bundle):
    cert=(KEY_DIR/'release-cert.der').read_bytes()
    key=(KEY_DIR/'release-key.pk8').read_bytes()
    if hashlib.sha256(cert).hexdigest()!=CERT or not 0<len(key)<=65536 or len(cert)>65536:
        raise SetupError('The existing API key/certificate is missing or differs. No replacement key will be generated.')
    payload=json.dumps({'schemaVersion':1,'privateKeyPkcs8Base64':base64.b64encode(key).decode(),
        'certificateDerBase64':base64.b64encode(cert).decode()},separators=(',',':')).encode()
    encoded=base64.b64encode(payload)
    checked(['node',str(ROOT/'crypto-helper.cjs'),'validate-key'],data=encoded)
    recovery=KEY_DIR/'api-signing-recovery-password.txt'
    if recovery.is_symlink():raise SetupError('Recovery password file must not be a symlink.')
    if recovery.exists():
        recovery.chmod(0o600)
        password=recovery.read_text().strip()
        if not re.fullmatch(r'[A-Za-z0-9_-]{40,100}',password):raise SetupError('Existing recovery password has unexpected format.')
    else:
        password=secrets.token_urlsafe(48)
        private_write(recovery,(password+'\n').encode())
    backup_path=bundle/'Codex-CN-API-signing-key.encrypted.json'
    if backup_path.is_symlink():raise SetupError('Encrypted backup must not be a symlink.')
    if backup_path.exists():
        previous=checked(['node',str(ROOT/'crypto-helper.cjs'),'restore'],data=(password+'\n'+backup_path.read_text().strip()).encode())
        if previous!=payload:raise SetupError('Existing encrypted backup contains a different identity.')
    else:
        encrypted=checked(['node',str(ROOT/'crypto-helper.cjs'),'backup'],data=password.encode()+b'\n'+encoded)
        restored=checked(['node',str(ROOT/'crypto-helper.cjs'),'restore'],data=password.encode()+b'\n'+encrypted.strip())
        if restored!=payload:raise SetupError('Encrypted backup recovery verification failed.')
        created=False
        try:
            with backup_path.open('xb') as stream:
                created=True
                stream.write(encrypted)
        except BaseException:
            if created:backup_path.unlink(missing_ok=True)
            raise
    backup_hash=hashlib.sha256(backup_path.read_bytes()).hexdigest()
    token=github_token()
    public=request('/actions/secrets/public-key',token)
    sealed=checked(['node',str(ROOT/'crypto-helper.cjs'),'seal'],data=public['key'].encode()+b'\n'+encoded).decode()
    request('/actions/secrets/'+SECRET,token,'PUT',{'encrypted_value':sealed,'key_id':public['key_id']})
    metadata=request('/actions/secrets/'+SECRET,token)
    if metadata.get('name')!=SECRET:raise SetupError('GitHub did not confirm the configured secret.')
    receipt={'repository':REPO,'secretName':SECRET,'secretUpdatedAt':metadata.get('updated_at'),
        'signingCertificateSha256':CERT,'encryptedBackup':backup_path.name,'encryptedBackupSha256':backup_hash,
        'recoveryPasswordLocation':str(recovery),'privateKeyUploadedToGitHistory':False}
    (bundle/'automatic-signing-setup-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
    print('GitHub Actions signing secret configured and its presence verified.')
    print('Encrypted backup:',backup_path)
    print('Recovery password remains ONLY in the old V5 private file:',recovery)
    print('Copy that password into your password manager before removing old V5.')

def main():
    global ROOT
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle',type=Path,default=Path('/storage/emulated/0/Download/Codex-CN-API-cn.9-signing'))
    parser.add_argument('--self-test',action='store_true')
    args=parser.parse_args()
    expected_runtime()
    if args.self_test:
        print('Encryption helper checksums, sealed boxes, AES-GCM recovery and wrong-password rejection passed; no private keys accessed.')
        return
    if not (KEY_DIR/'release-key.pk8').is_file():
        raise SetupError('Run this once inside old V5, which owns the existing API signing key.')
    bundle=args.bundle.resolve();bundle.mkdir(parents=True,exist_ok=True)
    # Copy execution helpers to app-private storage; Android shared storage forbids executable code in some configurations.
    private=KEY_DIR/'automatic-signing-setup';private.mkdir(mode=0o700,parents=True,exist_ok=True)
    for name in ['crypto-helper.cjs','bootstrap-files.json','node_modules']:
        source=ROOT/name;target=private/name
        if source.is_dir():shutil.copytree(source,target,dirs_exist_ok=True)
        else:shutil.copyfile(source,target)
    ROOT=private
    expected_runtime()
    install_secret(bundle)

if __name__=='__main__':
    try:main()
    except (OSError,ValueError,KeyError,SetupError) as error:
        print('Setup stopped: '+str(error),file=sys.stderr)
        raise SystemExit(1)
