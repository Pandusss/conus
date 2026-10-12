import {
  blockTask, completeTask, countProposals, createTask, dropTask, DomainError, getProjectByKey, listSessionTasks, projectForRemote,
  listTasks, markUnboundMcp, proposeTask, recordFacts, resolveSessionForMcp, startTask, touchSession, updateTask,
  OPEN_STATUSES, STATUSES,
  type Agent, type CreateOutcome, type Ctx, type Db, type MutationResult, type Session, type Status, type Task, type TaskType,
} from '@conus/core';
import { MCP_INSTRUCTIONS, TOOL_DESCRIPTIONS, type ToolName } from '@conus/protocol';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export function taskView(t: Task): {
  ref: string; title: string; status: Status; type: TaskType; parent: string | null; version: number; claimed: boolean;
  result: string | null; block_reason: string | null; source_quote: string | null;
} {
  return {
    ref: t.ref, title: t.title, status: t.status, type: t.type, parent: t.parentRef, version: t.version,
    claimed: !!t.claimedBySessionId, result: t.result, block_reason: t.blockReason, source_quote: t.sourceQuote,
  };
}

const common = {
  session: z.string().max(20).optional()
    .describe('Session ref S-… (e.g. S-8f3a) from the <task-manager> block or the [conus S-…] status line. Always pass it when you have one.'),
  project: z.string().max(500).optional()
    .describe('Project key (e.g. WB) or git remote URL. Fallback: pass it only when you have no session ref.'),
};

/** Error text when neither the session nor the project is known: the S-… ref first, project as the alternative. */
export const NO_SESSION_MESSAGE =
  'Session unknown: pass session (the S-… ref from the <task-manager> block or the [conus S-…] status line). Only without a ref, pass project (project key or git remote URL).';
const idem = { idempotency_key: z.string().max(200).optional().describe('Any unique string; retries with the same key are not applied twice.') };
const confirmNew = z.object({ reason: z.string().min(1).max(500) }).optional()
  .describe('Set only after possible_duplicates, to create anyway; explain why it is different.');

type Common = { session?: string; project?: string; idempotency_key?: string };
type ToolResult = { content: { type: 'text'; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

function textOk(text: string, structured: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text }], structuredContent: structured };
}

function textErr(e: unknown): ToolResult {
  if (e instanceof DomainError) {
    return {
      isError: true,
      content: [{ type: 'text', text: `${e.code}: ${e.message}` }],
      structuredContent: { error: { code: e.code, message: e.message, details: e.details } },
    };
  }
  console.error('[mcp] tool failed', e);
  return { isError: true, content: [{ type: 'text', text: 'internal_error: Conus failed to process the call. Continue your work.' }] };
}

function mutationResult(r: MutationResult | CreateOutcome): ToolResult {
  if ('outcome' in r && r.outcome === 'possible_duplicates') {
    const lines = r.candidates.map((c) => `- ${c.ref} [${c.status}] ${c.title} (similarity ${c.score})`);
    return textOk(
      `Not created: possible duplicates found:\n${lines.join('\n')}\nUse one of them (task_start / task_update) or call again with confirm_new: {reason} if it is really different work.`,
      { outcome: 'possible_duplicates', candidates: r.candidates },
    );
  }
  const m = r as MutationResult & { outcome?: string };
  return textOk(`${m.chatNote}\nchat_note: ${m.chatNote}`, { ...(m.outcome ? { outcome: m.outcome } : {}), task: taskView(m.task), chat_note: m.chatNote });
}

export function buildMcpServer(deps: { db: Db; agent: Agent; mcpSessionId: () => string | undefined }): McpServer {
  const { db, agent } = deps;
  const server = new McpServer({ name: 'conus', version: '0.1.0' }, { instructions: MCP_INSTRUCTIONS });

  async function resolve(args: Common): Promise<{ session: Session | null; projectId: string; ctx: Ctx }> {
    // The project is resolved first: with an explicit project, binding rule 3 only accepts a session of that project.
    let explicitProjectId: string | null = null;
    if (args.project) {
      const p = /^[A-Za-z][A-Za-z0-9]{0,9}$/.test(args.project) ? await getProjectByKey(db, args.project) : await projectForRemote(db, args.project);
      if (!p) throw new DomainError('validation', `Unknown project "${args.project}". Pass a project key (e.g. WB) or the repo's git remote URL.`);
      explicitProjectId = p.id;
    }
    const session = await resolveSessionForMcp(db, {
      agentId: agent.id, sessionRef: args.session ?? null, mcpSessionId: deps.mcpSessionId() ?? null, projectId: explicitProjectId,
    });
    if (!session) await markUnboundMcp(db, agent.id);
    const projectId = explicitProjectId ?? session?.projectId ?? null;
    if (!projectId) throw new DomainError('validation', NO_SESSION_MESSAGE);
    const ctx: Ctx = {
      db,
      actor: { kind: 'agent', agentId: agent.id, sessionId: session?.id ?? null, model: session?.model ?? null },
      idempotencyKey: args.idempotency_key ?? null,
    };
    return { session, projectId, ctx };
  }

  async function afterMutation(session: Session | null, tool: ToolName, r: MutationResult | CreateOutcome) {
    if (!session) return;
    // Runs after the mutation committed: a failure here must not turn a successful call into an error.
    try {
      const ref = 'task' in r ? r.task.ref : undefined;
      await recordFacts(db, session.id, [{ kind: 'task_op', data: ref ? { tool, task: ref } : { tool } }]);
      await touchSession(db, session.id);
    } catch (e) {
      console.error('[mcp] post-mutation bookkeeping failed', e);
    }
  }

  function mutating<A extends Common>(name: ToolName, shape: z.ZodRawShape, run: (a: A, projectId: string, ctx: Ctx) => Promise<MutationResult | CreateOutcome>) {
    server.registerTool(name, { description: TOOL_DESCRIPTIONS[name], inputSchema: { ...shape, ...common, ...idem } }, async (args: any) => {
      try {
        const { session, projectId, ctx } = await resolve(args);
        const r = await run(args as A, projectId, ctx);
        await afterMutation(session, name, r);
        return mutationResult(r) as any;
      } catch (e) {
        return textErr(e) as any;
      }
    });
  }

  server.registerTool('tasks_context', {
    description: TOOL_DESCRIPTIONS.tasks_context,
    inputSchema: {
      query: z.string().max(200).optional(),
      status: z.array(z.enum(STATUSES)).optional(),
      limit: z.number().int().min(1).max(50).optional(),
      ...common,
    },
  }, async (args: any) => {
    try {
      const { session, projectId } = await resolve(args);
      const tasks = await listTasks(db, { projectId, statuses: args.status?.length ? args.status : OPEN_STATUSES, query: args.query ?? null, limit: args.limit ?? 20 });
      const sessionTasks = session ? await listSessionTasks(db, session.id) : [];
      const proposals = await countProposals(db, projectId);
      const lines = tasks.map((t) => `- ${t.ref} [${t.status}${t.claimedBySessionId ? ', claimed' : ''}] ${t.title}`);
      return textOk(
        `${tasks.length ? lines.join('\n') : 'No matching tasks.'}\nProposals awaiting the user: ${proposals}`,
        { session: session?.ref ?? null, tasks: tasks.map(taskView), session_tasks: sessionTasks.map(taskView), proposals },
      ) as any;
    } catch (e) {
      return textErr(e) as any;
    }
  });

  mutating<Common & { title: string; description?: string; type?: TaskType; parent?: string; start_now?: boolean; source_quote?: string; confirm_new?: { reason: string } }>(
    'task_create',
    {
      title: z.string().min(1).max(200),
      description: z.string().max(10_000).optional(),
      type: z.enum(['task', 'bug']).optional(),
      parent: z.string().max(30).optional(),
      start_now: z.boolean().optional(),
      source_quote: z.string().max(1000).optional(),
      confirm_new: confirmNew,
    },
    (a, projectId, ctx) => createTask(ctx, {
      projectId, title: a.title, description: a.description, type: a.type ?? 'task', parent: a.parent,
      startNow: a.start_now, sourceQuote: a.source_quote, confirmNew: a.confirm_new ?? null,
    }),
  );

  mutating<Common & { title: string; description?: string; source_quote: string; confirm_new?: { reason: string } }>(
    'task_propose',
    { title: z.string().min(1).max(200), description: z.string().max(10_000).optional(), source_quote: z.string().min(1).max(1000), confirm_new: confirmNew },
    (a, projectId, ctx) => proposeTask(ctx, { projectId, title: a.title, description: a.description, sourceQuote: a.source_quote, confirmNew: a.confirm_new ?? null }),
  );

  mutating<Common & { task: string }>('task_start', { task: z.string().min(1).max(30) }, (a, projectId, ctx) => startTask(ctx, { projectId, task: a.task }));

  mutating<Common & { task: string; note?: string; title?: string; description?: string; expected_version?: number; promote?: boolean; reopen?: { reason: string } }>(
    'task_update',
    {
      task: z.string().min(1).max(30),
      note: z.string().max(10_000).optional(),
      title: z.string().max(200).optional(),
      description: z.string().max(10_000).optional(),
      expected_version: z.number().int().optional(),
      promote: z.boolean().optional(),
      reopen: z.object({ reason: z.string().min(1).max(1000) }).optional(),
    },
    (a, projectId, ctx) => updateTask(ctx, {
      projectId, task: a.task, note: a.note, title: a.title, description: a.description,
      expectedVersion: a.expected_version, promote: a.promote, reopen: a.reopen ?? null,
    }),
  );

  mutating<Common & { task: string; reason: string; blocked_by?: string }>(
    'task_block',
    {
      task: z.string().min(1).max(30), reason: z.string().min(1).max(1000),
      blocked_by: z.string().max(30).optional()
        .describe('Ref of another Conus task this one waits for (e.g. WB-12). Omit when the blocker is external: a person, credentials, a decision — put that in reason.'),
    },
    (a, projectId, ctx) => blockTask(ctx, { projectId, task: a.task, reason: a.reason, blockedBy: a.blocked_by }),
  );

  mutating<Common & { task: string; result: string; commits?: string[]; needs_review?: boolean }>(
    'task_complete',
    { task: z.string().min(1).max(30), result: z.string().min(1).max(10_000), commits: z.array(z.string().max(40)).max(50).optional(), needs_review: z.boolean().optional() },
    (a, projectId, ctx) => completeTask(ctx, { projectId, task: a.task, result: a.result, commits: a.commits, needsReview: a.needs_review }),
  );

  mutating<Common & { task: string; reason: string }>(
    'task_drop',
    { task: z.string().min(1).max(30), reason: z.string().min(1).max(1000) },
    (a, projectId, ctx) => dropTask(ctx, { projectId, task: a.task, reason: a.reason }),
  );

  return server;
}
