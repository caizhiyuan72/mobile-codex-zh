'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const sodium = require('libsodium-wrappers');
const AAD = Buffer.from('Codex-CN-API-signing-backup-v1');
function backup(message, password) {
  const salt = crypto.randomBytes(16), nonce = crypto.randomBytes(12);
  const key = crypto.scryptSync(password, salt, 32, {N:65536,r:8,p:1,maxmem:128*1024*1024});
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(message),cipher.final()]);
  key.fill(0);
  return {format:'Codex-CN-API-signing-backup-v1',kdf:'scrypt',N:65536,r:8,p:1,
    salt:salt.toString('base64'),nonce:nonce.toString('base64'),
    ciphertext:ciphertext.toString('base64'),tag:cipher.getAuthTag().toString('base64')};
}
function restore(data, password) {
  if(data.format!=='Codex-CN-API-signing-backup-v1'||data.kdf!=='scrypt'||data.N!==65536||data.r!==8||data.p!==1) throw Error('Unknown backup format');
  const key=crypto.scryptSync(password,Buffer.from(data.salt,'base64'),32,{N:data.N,r:data.r,p:data.p,maxmem:128*1024*1024});
  const decipher=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(data.nonce,'base64'));
  decipher.setAAD(AAD);decipher.setAuthTag(Buffer.from(data.tag,'base64'));
  try{return Buffer.concat([decipher.update(Buffer.from(data.ciphertext,'base64')),decipher.final()]);}
  finally{key.fill(0);}
}
(async()=>{
  await sodium.ready;
  const mode=process.argv[2],raw=fs.readFileSync(0,'utf8');
  if(mode==='validate-key') {
    const data=JSON.parse(Buffer.from(raw.trim(),'base64').toString('utf8'));
    const key=crypto.createPrivateKey({key:Buffer.from(data.privateKeyPkcs8Base64,'base64'),format:'der',type:'pkcs8'});
    const cert=new crypto.X509Certificate(Buffer.from(data.certificateDerBase64,'base64'));
    if(crypto.createHash('sha256').update(cert.raw).digest('hex')!=='c3537a4bbf12e671868127ef3267c4806ffabed83d62208d94085ae4fe12b207') throw Error('Certificate mismatch');
    const publicKey=crypto.createPublicKey(key).export({format:'der',type:'spki'});
    if(!publicKey.equals(cert.publicKey.export({format:'der',type:'spki'})))throw Error('Key mismatch');
    process.stdout.write('existing private key and certificate match\n');
  } else if(mode==='seal') {
    const fields=raw.split('\n'),message=sodium.from_base64(fields[1],sodium.base64_variants.ORIGINAL);
    process.stdout.write(sodium.to_base64(sodium.crypto_box_seal(message,sodium.from_base64(fields[0],sodium.base64_variants.ORIGINAL)),sodium.base64_variants.ORIGINAL));
    sodium.memzero(message);
  } else if(mode==='backup') {
    const fields=raw.split('\n'),message=Buffer.from(fields[1],'base64');
    process.stdout.write(JSON.stringify(backup(message,fields[0]))+'\n');message.fill(0);
  } else if(mode==='restore') {
    const fields=raw.split('\n');process.stdout.write(restore(JSON.parse(fields[1]),fields[0]));
  } else if(mode==='selftest') {
    const pair=sodium.crypto_box_keypair(),message=Buffer.from('cn-api-setup-self-test');
    const sealed=sodium.crypto_box_seal(message,pair.publicKey);
    if(sodium.to_string(sodium.crypto_box_seal_open(sealed,pair.publicKey,pair.privateKey))!==message.toString()) throw Error('Sealed box self-test failed');
    const encrypted=backup(message,'test-recovery-secret');
    if(!restore(encrypted,'test-recovery-secret').equals(message))throw Error('Backup self-test failed');
    let rejected=false;try{restore(encrypted,'wrong-password');}catch{rejected=true;}
    if(!rejected)throw Error('Wrong password accepted');
    process.stdout.write('sealed box and AES-GCM recovery tests passed\n');
  } else throw Error('Unsupported crypto operation');
})().catch(()=>{process.stderr.write('Encryption operation failed\n');process.exitCode=1;});
