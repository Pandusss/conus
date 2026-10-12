import { build } from 'esbuild';
await build({
  entryPoints: { main: 'src/main.ts', admin: 'src/admin.ts' },
  bundle: true, platform: 'node', target: 'node22', format: 'esm', outdir: 'dist', outExtension: { '.js': '.mjs' },
  sourcemap: true,
  external: ['pg', 'pg-native', '@node-rs/argon2'],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
console.log('server built');
