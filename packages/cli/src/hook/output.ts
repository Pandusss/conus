import type { AgentFlavor, HookEvent } from './normalize';

export function formatOutput(agent: AgentFlavor, event: HookEvent, r: { context?: string | null; statusLine?: string | null; nudge?: string | null }): string {
  if (event === 'session-start' && r.context) {
    return agent === 'claude' ? r.context : JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: r.context } });
  }
  if (event === 'prompt' && r.statusLine) {
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: r.statusLine } });
  }
  if (event === 'stop' && r.nudge) return JSON.stringify({ decision: 'block', reason: r.nudge });
  return '';
}
