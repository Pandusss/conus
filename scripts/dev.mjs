// `npm run dev`: Postgres in Docker, the server from source (restarts on changes) and the web app with hot reload.
// The app is on http://localhost:5173 (it proxies /api to the server on :8080); agents connect to http://localhost:8080.
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const win = process.platform === 'win32';
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://conus:conus@127.0.0.1:54329/conus';

if (!process.env.DATABASE_URL) {
  const db = spawnSync('docker', ['compose', '-f', join(root, 'deploy/compose.dev.yml'), 'up', '-d', '--wait'], { stdio: 'inherit', shell: win });
  if (db.status !== 0) {
    console.error('dev: could not start Postgres with docker compose; start Docker, or set DATABASE_URL to your own database');
    process.exit(1);
  }
}

const children = [
  spawn('npx', ['tsx', 'watch', 'packages/server/src/main.ts'], {
    cwd: root, stdio: 'inherit', shell: win,
    env: { ...process.env, DATABASE_URL, PUBLIC_URL: 'http://localhost:8080', CONUS_SETUP_CODE: process.env.CONUS_SETUP_CODE || 'DEVS-ETUP' },
  }),
  spawn('npm', ['run', 'dev', '-w', '@conus/ui'], { cwd: root, stdio: 'inherit', shell: win }),
];
console.log('dev: web app http://localhost:5173 (first visit: setup code DEVS-ETUP), server http://localhost:8080');
console.log(`dev: tests can use this database: TEST_DATABASE_URL=${DATABASE_URL} npm test`);

const stop = () => { for (const c of children) c.kill('SIGTERM'); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const c of children) c.on('exit', (code) => { stop(); process.exitCode = code ?? 0; });
