import { PROTOCOL_CORE } from './core';

export const SKILL_MD = `---
name: task-protocol
description: Keeps the user's task manager (Conus) in sync with your work, on your own and without asking. Use when you start implementing a main piece of work, find an important bug, discover large separable work, get blocked, finish or abandon work, when the user agrees to or rejects a piece of work, or when a significant idea for later or a "someday" item comes up (propose it with task_propose). Also explains possible_duplicates and conflict responses of Conus tools.
---

# Task protocol (Conus)

${PROTOCOL_CORE}

## Decision table

| Signal | Action |
|---|---|
| Question, explanation, code exploration, small one-off edit | nothing |
| Comparing options, hypotheses, brainstorming before a decision | nothing |
| Agreement on a main piece of work: "ok, let's do it", "давай так", but not started now | task_create |
| You are about to change code for a main unit of work | tasks_context → task_start, or task_create start_now=true |
| Significant idea / someday: "надо бы когда-нибудь", your significant idea the user did not pick up | task_propose with the quote |
| Large separable work found mid-task that may be done later | task_create with parent |
| Your own plan steps, small fixes inside the current task | NOT tasks — mention in the result |
| Important defect outside the current task, not fixing now | task_create type=bug |
| Cannot continue without credentials / a decision / another task | task_block with reason |
| Done and verified (tests, the user's confirmation) | task_complete with result |
| Done but the user must check it | task_complete needs_review=true |
| "We won't do it", "не будем", rollback | task_drop the related tasks and proposals |

## Examples

- "Explain how the parser works" → nothing.
- "Rename this variable" → nothing.
- "Add a --json flag to the CLI" → task_create "Добавить флаг --json в CLI" start_now=true, implement, commit, task_complete with result.
- "Let's do the export next week" → task_create (todo), do not start.
- "Надо бы когда-нибудь кэш переделать" → task_propose "Переделать кэш", source_quote = that sentence.
- While implementing import you notice the date parser is broken elsewhere and you will not fix it now → task_create type=bug.
- While implementing import you fix a typo and a small helper → nothing; mention it in the result of the import task.
- You need an API key you do not have → task_block with reason "нужен API-ключ сервиса X".
- "Forget the export, we won't do it" → task_drop the export task with the reason.
- The user says "это не задача, просто поправь" → nothing.

## Handling responses

- outcome=possible_duplicates: read the candidates. If one is the same work, use it (task_start or task_update with a note). If it is really different, call the same tool again with confirm_new={reason} explaining the difference.
- error conflict_claimed: another active session works on the task. Do not take it over. If you need related work, create a subtask; mention the conflict in the chat line.
- error conflict_version / invalid_transition: the response contains the current state; adapt (e.g. the user already closed it) and continue.
- Any Conus error must never stop your actual work. Continue the user's task.

## Chat line

When at least one Conus call changed something in this reply, end the reply with exactly one line built from the chat_note fields, e.g. \`Tasks: +WB-42 Import CSV → in progress, WB-38 → done\` (the word "Tasks" in the language of the conversation, e.g. "Задачи:"). If nothing changed, say nothing about tasks.
`;
