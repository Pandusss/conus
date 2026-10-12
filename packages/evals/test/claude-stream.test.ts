import { describe, expect, it } from 'vitest';
import { agentEnv, parseStreamJson } from '../src/claude-stream';

const SID = '707d1f5d-d9f4-4aa5-b2fd-f9aebe36a534';
const init = (mcp: { name: string; status: string }[]) => JSON.stringify({
  type: 'system', subtype: 'init', cwd: 'C:\\Users\\u\\AppData\\Local\\Temp\\conus-evals-x\\qa-no-task-1', session_id: SID,
  tools: ['Task', 'Bash', 'Read', 'mcp__plugin_conus_conus__task_create'], mcp_servers: mcp, model: 'claude-opus-5-5',
  permissionMode: 'bypassPermissions', slash_commands: [], apiKeySource: 'none', claude_code_version: '2.1.270',
  output_style: 'default', agents: [], skills: [], plugins: [{ name: 'conus', path: 'D:\\conus\\integrations\\claude-code' }], uuid: 'u1',
});
const hook = JSON.stringify({ type: 'system', subtype: 'hook_response', hook_name: 'SessionStart:startup', session_id: SID, stdout: '{}', uuid: 'u0' });
const assistant = JSON.stringify({
  type: 'assistant', parent_tool_use_id: null, session_id: SID, uuid: 'u2',
  message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'src/greet.js' } }], stop_reason: null, usage: {} },
});
const toolResult = JSON.stringify({
  type: 'user', parent_tool_use_id: null, session_id: SID, uuid: 'u3',
  message: { role: 'user', content: [{ tool_use_id: 'toolu_1', type: 'tool_result', content: 'export function greet(name) {' }] },
});
const result = (p: Record<string, unknown>) => JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, duration_ms: 12000, duration_api_ms: 11000, num_turns: 2,
  result: 'Функция greet возвращает строку «Hello, <name>!»', session_id: SID, total_cost_usd: 0.05, usage: {}, permission_denials: [], uuid: 'u4', ...p,
});

describe('parseStreamJson', () => {
  it('reads the conus MCP status from init and the final result event', () => {
    const out = [hook, init([{ name: 'plugin:conus:conus', status: 'connected' }]), assistant, toolResult, result({})].join('\n') + '\n';
    expect(parseStreamJson(out)).toEqual({
      sessionId: SID,
      mcpServers: [{ name: 'plugin:conus:conus', status: 'connected' }],
      conusStatus: 'connected',
      result: { isError: false, subtype: 'success', text: 'Функция greet возвращает строку «Hello, <name>!»' },
    });
  });
  it('reports the raw status of a conus server that did not connect, ignoring other servers', () => {
    const out = [init([{ name: 'html-tools', status: 'connected' }, { name: 'plugin:conus:conus', status: 'failed' }]), result({})].join('\r\n');
    expect(parseStreamJson(out).conusStatus).toBe('failed');
  });
  it('says absent when init lists no conus server, null when there was no init event', () => {
    expect(parseStreamJson([init([{ name: 'html-tools', status: 'connected' }]), result({})].join('\n')).conusStatus).toBe('absent');
    expect(parseStreamJson(result({})).conusStatus).toBeNull();
    expect(parseStreamJson(result({})).mcpServers).toBeNull();
  });
  it('a killed run (truncated stream) has no result but keeps the session id and MCP status', () => {
    const out = [init([{ name: 'plugin:conus:conus', status: 'connected' }]), assistant, assistant.slice(0, 40)].join('\n');
    expect(parseStreamJson(out)).toMatchObject({ sessionId: SID, conusStatus: 'connected', result: null });
  });
  it('flags error results, including error subtypes without a result text', () => {
    expect(parseStreamJson(result({ subtype: 'error_during_execution', is_error: true, result: undefined })).result)
      .toEqual({ isError: true, subtype: 'error_during_execution', text: '' });
    expect(parseStreamJson(result({ subtype: 'error_max_turns', is_error: false })).result?.isError).toBe(true);
    expect(parseStreamJson(result({ is_error: true, result: 'API Error: 529 overloaded' })).result)
      .toEqual({ isError: true, subtype: 'success', text: 'API Error: 529 overloaded' });
  });
  it('tolerates non-JSON noise and empty output', () => {
    expect(parseStreamJson('Error: something went wrong\n')).toEqual({ sessionId: null, mcpServers: null, conusStatus: null, result: null });
    expect(parseStreamJson('')).toEqual({ sessionId: null, mcpServers: null, conusStatus: null, result: null });
  });
});

describe('agentEnv', () => {
  it('drops host-session variables and MCP connection overrides, keeps user-level settings', () => {
    const env = agentEnv({
      CLAUDECODE: '1', CLAUDE_EFFORT: 'xhigh', CLAUDE_CODE_ENTRYPOINT: 'claude-desktop', CLAUDE_CODE_SESSION_ID: 's',
      CLAUDE_CODE_MESSAGING_SOCKET: 'p', CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: '1', CLAUDE_CODE_SIMPLE: '0',
      CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL: 'true', MCP_CONNECTION_NONBLOCKING: 'true', MCP_SERVER_CONNECTION_BATCH_SIZE: '1',
      CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Git\\bin\\bash.exe', CLAUDE_CODE_MAX_RETRIES: '5', CLAUDE_CODE_API_KEY_HELPER_TTL_MS: '60000',
      ANTHROPIC_API_KEY: 'k', Path: 'C:\\bin', CONUS_URL: 'http://127.0.0.1:1',
    });
    expect(Object.keys(env).sort()).toEqual(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_API_KEY_HELPER_TTL_MS', 'CLAUDE_CODE_GIT_BASH_PATH', 'CLAUDE_CODE_MAX_RETRIES', 'CONUS_URL', 'Path']);
  });
  it('matches names case-insensitively (Windows env)', () => {
    expect(agentEnv({ ClaudeCode: '1', mcp_connection_nonblocking: 'true' })).toEqual({});
  });
});
