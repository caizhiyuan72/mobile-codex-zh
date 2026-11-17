#!/usr/bin/env node
// Original artwork stays pinned in icon-pack; only display assets are resized.
import {readFile, writeFile, readdir, unlink} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {resolve, dirname} from 'node:path';
import {PNG} from 'pngjs';
import resize, {initResize} from '@jsquash/resize';
import encode, {init as initEncoder} from '@jsquash/webp/encode.js';
import decode, {init as initDecoder} from '@jsquash/webp/decode.js';
import {simd} from 'wasm-feature-detect';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'icon-pack/gptchan'), output = resolve(root, 'app/src/main/assets/web/chat-icons');
const generate = process.argv.includes('--generate');
if (process.argv.slice(2).some(argument => argument !== '--generate')) throw new Error('Usage: optimize_chat_icons.mjs [--generate]');
const sha = data => createHash('sha256').update(data).digest('hex');
const readJson = async path => JSON.parse(await readFile(resolve(root, path), 'utf8'));
// Browser codecs only require this data container; no canvas or native modules.
globalThis.ImageData ??= class ImageData {
  constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
};
const encoder = await simd() ? 'webp_enc_simd.wasm' : 'webp_enc.wasm';
await Promise.all([
  initResize(await readFile(resolve(root, 'node_modules/@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm'))),
  initEncoder(await WebAssembly.compile(await readFile(resolve(root, 'node_modules/@jsquash/webp/codec/enc', encoder)))),
  initDecoder(await WebAssembly.compile(await readFile(resolve(root, 'node_modules/@jsquash/webp/codec/dec/webp_dec.wasm')))),
]);
const originals = await readJson('tests/chat-icons.sha256.json');
if (Object.keys(originals).length !== 32) throw new Error('Expected exactly 32 pinned original icons');
const transform = {maxDimension:384, method:'lanczos3', premultiply:true, linearRGB:true, quality:88, alphaQuality:100};
const entries = {};
let originalBytes = 0, derivedBytes = 0, previousBytes = 0;
for (const [name, pinned] of Object.entries(originals)) {
  if (!/^[0-9]{2}-[a-z]+(?:-[a-z]+)*\.png$/.test(name)) throw new Error('Invalid icon name');
  const input = await readFile(resolve(source, name));
  if (sha(input) !== pinned) throw new Error('Original artwork changed: ' + name);
  originalBytes += input.length;
  const original = PNG.sync.read(input), scale = Math.min(1, transform.maxDimension / Math.max(original.width, original.height));
  const width = Math.round(original.width * scale), height = Math.round(original.height * scale);
  const image = await resize(new ImageData(new Uint8ClampedArray(original.data), original.width, original.height),
    {width, height, method:transform.method, premultiply:transform.premultiply, linearRGB:transform.linearRGB});
  const asset = name.replace(/\.png$/, '.webp'), path = resolve(output, asset);
  if (generate) {
    try { previousBytes += (await readFile(path)).length; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await writeFile(path, new Uint8Array(await encode(image,
      {quality:transform.quality, alpha_quality:transform.alphaQuality, lossless:0, method:6, exact:1})));
  }
  const bytes = await readFile(path), derived = await decode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  if (derived.width !== width || derived.height !== height) throw new Error('Thumbnail dimensions differ: ' + name);
  const alpha = new Uint8Array(width * height);
  for (let pixel = 0; pixel < alpha.length; pixel++) {
    alpha[pixel] = derived.data[pixel * 4 + 3];
    if (alpha[pixel] !== image.data[pixel * 4 + 3]) throw new Error('Thumbnail alpha differs: ' + name);
  }
  entries[name] = {asset, sourceSha256:pinned, sha256:sha(bytes), sourceWidth:original.width, sourceHeight:original.height,
    width, height, rgbaSha256:sha(derived.data), alphaSha256:sha(alpha)};
  derivedBytes += bytes.length;
  if (generate && (await readdir(output)).includes(name)) {
    if (sha(await readFile(resolve(output, name))) !== pinned) throw new Error('Refusing to remove changed bundled original: ' + name);
    await unlink(resolve(output, name));
  }
}
const manifest = {format:'webp-thumbnail', transform, icons:entries};
const hashes = Object.fromEntries(Object.entries(entries).map(([name, entry]) => [name, entry.sha256]));
if (generate) {
  await writeFile(resolve(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(resolve(root, 'tests/chat-icons-derived.sha256.json'), JSON.stringify(hashes, null, 2) + '\n');
} else {
  const actual = await readJson('app/src/main/assets/web/chat-icons/manifest.json');
  if (JSON.stringify(actual) !== JSON.stringify(manifest)
    || JSON.stringify(await readJson('tests/chat-icons-derived.sha256.json')) !== JSON.stringify(hashes))
    throw new Error('Bundled manifest or hash fixture mismatch');
}
console.log(JSON.stringify({icons:Object.keys(entries).length, originalBytes, derivedBytes,
  ...(generate ? {previousBytes, savedBytes:previousBytes-derivedBytes} : {}), dimensions:384, alphaPreserved:true}));
