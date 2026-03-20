import { copyFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const dest = resolve(root, 'public', 'ffmpeg');

const files = [
  ['node_modules/@ffmpeg/core/dist/umd/ffmpeg-core.js', 'ffmpeg-core.js'],
  ['node_modules/@ffmpeg/core/dist/umd/ffmpeg-core.wasm', 'ffmpeg-core.wasm'],
];

if (!existsSync(dest)) {
  await mkdir(dest, { recursive: true });
}

for (const [src, name] of files) {
  const srcPath = resolve(root, src);
  const destPath = resolve(dest, name);
  if (!existsSync(destPath)) {
    await copyFile(srcPath, destPath);
    console.log(`Copied ${name} to public/ffmpeg/`);
  }
}
