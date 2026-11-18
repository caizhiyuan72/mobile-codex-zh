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

// A 108dp adaptive layer is clipped by the launcher around the central 72dp.
const size = 432, inset = 96, subject = size - inset * 2;
const image = await resize(new ImageData(new Uint8ClampedArray(original.data), original.width, original.height), {
  width:subject, height:subject, method:'lanczos3', premultiply:true, linearRGB:true
});
const canvas = new PNG({width:size, height:size});
canvas.data.fill(255);
for (let y = 0; y < subject; y++) {
  const offset = ((y + inset) * size + inset) * 4;
  canvas.data.set(image.data.subarray(y * subject * 4, (y + 1) * subject * 4), offset);
}
const output = resolve(root, 'app/src/fresh/res/drawable-nodpi/dafeilong_artwork.png');
await mkdir(dirname(output), {recursive:true});
await writeFile(output, PNG.sync.write(canvas, {colorType:2}));
