import { copyFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const dest = resolve(root, 'public', 'ffmpeg');

const files = [
  // The single-thread core is slower than the multithreaded build, but it is
  // much more reliable across deployed browsers and avoids the production-only
  // extraction failures we were seeing before /api/transcribe was ever called.
  ['node_modules/@ffmpeg/core-st/dist/ffmpeg-core.js', 'ffmpeg-core.js'],
  ['node_modules/@ffmpeg/core-st/dist/ffmpeg-core.wasm', 'ffmpeg-core.wasm'],
];

if (!existsSync(dest)) {
  await mkdir(dest, { recursive: true });
}

for (const [src, name] of files) {
  const srcPath = resolve(root, src);
  const destPath = resolve(dest, name);
  await copyFile(srcPath, destPath);
  console.log(`Copied ${name} to public/ffmpeg/`);
}
