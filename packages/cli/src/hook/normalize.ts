export type AgentFlavor = 'claude' | 'codex';
export type HookEvent = 'session-start' | 'prompt' | 'tool' | 'stop' | 'session-end';
export interface HookInput {
  sessionId: string; cwd: string; transcriptPath: string | null; source: 'startup' | 'resume' | 'clear' | 'compact';
  prompt: string | null; toolName: string | null; toolInput: unknown; toolResponse: unknown; stopHookActive: boolean;
  lastAssistantMessage: string | null; model: string | null; reason: string | null;
  /** Claude Code: the id of the prompt this hook event belongs to (`prompt_id`). */
  promptId: string | null;
  /** Claude Code PostToolUse: how long the tool call took (`duration_ms`). */
  toolDurationMs: number | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length ? v : null);
const SOURCES = ['startup', 'resume', 'clear', 'compact'] as const;

export function normalizeHookInput(_agent: AgentFlavor, raw: unknown): HookInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, any>;
  const sessionId = str(r.session_id);
  const cwd = str(r.cwd);
  if (!sessionId || !cwd) return null;
  const model = str(r.model) ?? str(r.model?.id) ?? str(r.model?.display_name);
  return {
    sessionId, cwd,
    transcriptPath: str(r.transcript_path),
    source: (SOURCES as readonly string[]).includes(r.source) ? r.source : 'startup',
    prompt: str(r.prompt),
    toolName: str(r.tool_name),
    toolInput: r.tool_input ?? null,
    toolResponse: r.tool_response ?? r.tool_output ?? r.output ?? null,
    stopHookActive: r.stop_hook_active === true,
    lastAssistantMessage: str(r.last_assistant_message),
    model,
    reason: str(r.reason),
    promptId: str(r.prompt_id),
    toolDurationMs: typeof r.duration_ms === 'number' && Number.isFinite(r.duration_ms) && r.duration_ms >= 0 ? r.duration_ms : null,
  };
}
