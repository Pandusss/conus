export type ToolName =
  | 'tasks_context' | 'task_create' | 'task_propose' | 'task_start'
  | 'task_update' | 'task_block' | 'task_complete' | 'task_drop';

export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  tasks_context: 'Call to check which tasks exist before creating or starting one (search by query), or to see the tasks of this session. Returns open tasks of the project with status and who holds them.',
  task_create: 'Call when a MAIN unit of work appears: before implementing it (start_now=true), when it is agreed but not started, for large separable work found mid-task (parent), or for an important bug you will not fix now (type=bug). Not for small edits or plan steps. May return possible_duplicates instead of creating.',
  task_propose: 'Call when a significant idea or "someday" item comes up that the user has not committed to. Requires the source quote. Lands in the user\'s Proposals inbox.',
  task_start: 'Call before you start implementing an existing task (also a proposal the user just agreed to). Claims it for this session. Fails with conflict_claimed if another active session holds it.',
  task_update: 'Call to add a progress note, to change title/description (expected_version required), to promote a proposal after the user agreed (promote=true), or to reopen a closed task (reopen.reason).',
  task_block: 'Call when work on a task cannot continue without something external (credentials, a decision, another task). Reason is required.',
  task_complete: 'Call after a task is done and verified. result: what was done, where, how it was verified, what is left. needs_review=true if the user must check it.',
  task_drop: 'Call when the user abandons a task or proposal ("we will not do X"). Reason is required.',
};
