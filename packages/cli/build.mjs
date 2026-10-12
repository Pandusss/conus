import { build } from 'esbuild';
import { rmSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
await build({
  entryPoints: ['src/main.ts'], bundle: true, platform: 'node', target: 'node22', format: 'esm',
  outfile: 'dist/conus.mjs', banner: { js: '#!/usr/bin/env node' }, sourcemap: false,
});
console.log('conus built');
