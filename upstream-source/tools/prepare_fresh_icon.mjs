import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PNG} from 'pngjs';
import resize, {initResize} from '@jsquash/resize';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const original = PNG.sync.read(await readFile(resolve(root, 'icon-pack/dafeilong/white-original.png')));
if (original.width !== original.height) throw new Error('Expected square launcher artwork');
globalThis.ImageData ??= class ImageData {
  constructor(data, width, height) { Object.assign(this, {data, width, height}); }
};
await initResize(await readFile(resolve(root, 'node_modules/@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm')));

// The launcher masks the middle 72dp of its 108dp adaptive layer. Fill that
// entire viewport with the portrait and extend its edge pixels into the overscan.
const size = 432, viewport = 288, overscan = (size - viewport) / 2;
const image = await resize(new ImageData(new Uint8ClampedArray(original.data), original.width, original.height), {
  width:viewport, height:viewport, method:'lanczos3', premultiply:true, linearRGB:true
});
const canvas = new PNG({width:size, height:size});
const edge = (n) => Math.min(viewport - 1, Math.max(0, n - overscan));
for (let y = 0; y < size; y++) {
  for (let x = 0; x < size; x++) {
    const src = (edge(y) * viewport + edge(x)) * 4;
    canvas.data.set(image.data.subarray(src, src + 4), (y * size + x) * 4);
  }
}
const output = resolve(root, 'app/src/fresh/res/drawable-nodpi/dafeilong_artwork.png');
await mkdir(dirname(output), {recursive:true});
await writeFile(output, PNG.sync.write(canvas, {colorType:2}));

// No launcher overscan for the in-app avatar: the entire square is visible.
const avatar = PNG.sync.read(await readFile(resolve(root, 'icon-pack/dafeilong/in-app-original.png')));
const portrait = await resize(new ImageData(new Uint8ClampedArray(avatar.data), avatar.width, avatar.height), {
  width:192, height:192, method:'lanczos3', premultiply:true, linearRGB:true
});
await writeFile(resolve(dirname(output), 'mobile_codex_logo.png'), PNG.sync.write(portrait, {colorType:2}));
