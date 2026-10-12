import { setLang } from '@conus/core';
import { loadConfig } from './config';
import { startServer } from './server';

const cfg = loadConfig();
setLang(cfg.lang);
const srv = await startServer(cfg);
console.log(`[conus] listening on ${srv.url} (public ${cfg.publicUrl}); judge ${cfg.judge.enabled ? 'on' : 'off'}; language ${cfg.lang}; ui ${cfg.uiDir ?? 'off'}`);
if (srv.setupCode) console.log(`[conus] first run: open ${cfg.publicUrl}, enter the setup code ${srv.setupCode} and choose the owner password`);
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await srv.close().catch(() => {});
    process.exit(0);
  });
}
