import { copyFile, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'vite';
import vue from '@vitejs/plugin-vue';

const root = process.cwd();
const dist = resolve(root, 'dist');

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await build({
  root: resolve(root, 'src/sidepanel'),
  base: './',
  plugins: [vue()],
  build: {
    outDir: resolve(dist, 'sidepanel'),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(root, 'src/sidepanel/index.html')
    }
  }
});

async function buildScript(entry, fileName, format) {
  await build({
    root,
    build: {
      outDir: dist,
      emptyOutDir: false,
      rollupOptions: {
        input: resolve(root, entry),
        output: {
          format,
          entryFileNames: fileName,
          chunkFileNames: 'assets/[name].js',
          codeSplitting: false
        }
      }
    }
  });
}

await buildScript('src/background/index.ts', 'background.js', 'es');
await buildScript('src/content/index.ts', 'content.js', 'iife');
await buildScript('src/injected/page-context.ts', 'injected.js', 'iife');
await copyFile(resolve(root, 'public/manifest.json'), resolve(dist, 'manifest.json'));
