import { createInterface } from 'node:readline';
import { configDir, readConfig } from './config';
import { log } from './log';
import { createBridge, runBridge } from './mcp-bridge';

/** `conus mcp` and the Claude Code plugin's bundled bridge: stdio in, the Conus server out. stdout carries only JSON-RPC. */
export async function serveMcp(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const dir = configDir(env);
  const send = (m: unknown) => { process.stdout.write(JSON.stringify(m) + '\n'); };
  const bridge = createBridge(readConfig(env), { send, fetchImpl: fetch, log: (msg) => log(dir, msg) });
  await runBridge(createInterface({ input: process.stdin, crlfDelay: Infinity }), bridge, { send });
}
