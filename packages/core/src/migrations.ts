export const MIGRATIONS: { name: string; sql: string }[] = [
  {
    name: '0001_init',
    sql: /* sql */ `
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  name text NOT NULL,
  repo_fingerprints text[] NOT NULL DEFAULT '{}',
  next_task_number int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX projects_fingerprints_idx ON projects USING gin (repo_fingerprints);

CREATE TABLE agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('claude_code','codex','other')),
  token_hash text NOT NULL UNIQUE,
  token_prefix text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  last_seen_at timestamptz,
  last_unbound_mcp_at timestamptz
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref text NOT NULL UNIQUE,
  agent_id uuid NOT NULL REFERENCES agents(id),
  agent_session_id text NOT NULL,
  mcp_session_ids text[] NOT NULL DEFAULT '{}',
  project_id uuid REFERENCES projects(id),
  cwd text,
  branch text,
  model text,
  current_turn int NOT NULL DEFAULT 0,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','ended','stale')),
  started_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  end_reason text,
  UNIQUE (agent_id, agent_session_id)
);
CREATE INDEX sessions_agent_state_idx ON sessions(agent_id, state);

CREATE TABLE tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  number int NOT NULL,
  parent_id uuid REFERENCES tasks(id),
  type text NOT NULL CHECK (type IN ('task','bug')),
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL CHECK (status IN ('proposed','todo','in_progress','blocked','review','done','dropped')),
  result text,
  block_reason text,
  blocked_by_task_id uuid REFERENCES tasks(id),
  source_quote text,
  claimed_by_session_id uuid REFERENCES sessions(id),
  claim_expires_at timestamptz,
  merged_into_task_id uuid REFERENCES tasks(id),
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  deleted_at timestamptz,
  UNIQUE (project_id, number)
);
CREATE INDEX tasks_project_status_idx ON tasks(project_id, status);
CREATE INDEX tasks_claimed_idx ON tasks(claimed_by_session_id);
CREATE INDEX tasks_title_trgm_idx ON tasks USING gin (lower(title) gin_trgm_ops);
CREATE INDEX tasks_text_trgm_idx ON tasks USING gin (lower(title || ' ' || description) gin_trgm_ops);

CREATE TABLE task_events (
  id bigserial PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id),
  seq int NOT NULL,
  type text NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('agent','user','system')),
  actor_id uuid,
  session_id uuid REFERENCES sessions(id),
  model text,
  changes jsonb NOT NULL DEFAULT '{}',
  reason text,
  note text,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, seq)
);
CREATE INDEX task_events_session_idx ON task_events(session_id);

CREATE TABLE links (
  id bigserial PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id),
  kind text NOT NULL CHECK (kind IN ('commit','branch')),
  ref text NOT NULL,
  meta jsonb NOT NULL DEFAULT '{}',
  session_id uuid REFERENCES sessions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, kind, ref)
);

CREATE TABLE idempotency_keys (
  agent_id uuid NOT NULL REFERENCES agents(id),
  key text NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, key)
);

CREATE TABLE session_activity (
  id bigserial PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id),
  turn int NOT NULL,
  kind text NOT NULL CHECK (kind IN ('file_edit','git_commit','test_run','task_op','prompt_excerpt','answer_excerpt')),
  data jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX session_activity_session_idx ON session_activity(session_id, turn);

CREATE TABLE nudges (
  id bigserial PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES sessions(id),
  turn int NOT NULL,
  rule text NOT NULL CHECK (rule IN ('D1','JUDGE')),
  reason text NOT NULL,
  task_refs text[] NOT NULL DEFAULT '{}',
  signature text NOT NULL,
  acted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, signature)
);

CREATE TABLE owner (
  id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  password_hash text NOT NULL
);

CREATE TABLE owner_sessions (
  token_hash text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
`,
  },
  {
    // Priority and due date. priority_source says who set the priority last: the owner's choice is never
    // overwritten by the manager.
    name: '0002_planning',
    sql: /* sql */ `
ALTER TABLE tasks ADD COLUMN priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('urgent','high','normal','low'));
ALTER TABLE tasks ADD COLUMN priority_source text NOT NULL DEFAULT 'default'
  CHECK (priority_source IN ('default','agent','manager','owner'));
ALTER TABLE tasks ADD COLUMN due_on date;
CREATE INDEX tasks_due_idx ON tasks(due_on) WHERE due_on IS NOT NULL AND deleted_at IS NULL;
`,
  },
  {
    // The manager: the owner's settings (schedule, Telegram), correspondence turned into proposals, daily reviews.
    name: '0003_manager',
    sql: /* sql */ `
ALTER TABLE task_events DROP CONSTRAINT task_events_actor_kind_check;
ALTER TABLE task_events ADD CONSTRAINT task_events_actor_kind_check CHECK (actor_kind IN ('agent','user','system','manager'));

CREATE TABLE owner_settings (
  id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  time_zone text NOT NULL DEFAULT 'UTC',
  digest_time text NOT NULL DEFAULT '09:00' CHECK (digest_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  quiet_from text NOT NULL DEFAULT '22:00' CHECK (quiet_from ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  quiet_to text NOT NULL DEFAULT '08:00' CHECK (quiet_to ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  notify_review boolean NOT NULL DEFAULT true,
  notify_blocked boolean NOT NULL DEFAULT true,
  manager_auto boolean NOT NULL DEFAULT true,
  telegram_chat_id bigint,
  telegram_username text,
  telegram_link_hash text,
  telegram_link_expires_at timestamptz,
  telegram_offset bigint NOT NULL DEFAULT 0,
  last_digest_on date,
  last_review_on date,
  -- task_events up to this id have been considered for notifications (starts at the current end: no backlog)
  notified_event_id bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO owner_settings(id, notified_event_id) VALUES (1, COALESCE((SELECT max(id) FROM task_events), 0));

CREATE TABLE intake_batches (
  id bigserial PRIMARY KEY,
  source text NOT NULL CHECK (source IN ('telegram','web')),
  status text NOT NULL CHECK (status IN ('done','failed')),
  input text NOT NULL,
  summary text,
  error text,
  task_ids uuid[] NOT NULL DEFAULT '{}',
  duplicates jsonb NOT NULL DEFAULT '[]',
  telegram_message_id bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE telegram_inbox (
  id bigserial PRIMARY KEY,
  text text NOT NULL,
  author text,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  batch_id bigint REFERENCES intake_batches(id)
);
CREATE INDEX telegram_inbox_pending_idx ON telegram_inbox(received_at) WHERE processed_at IS NULL;

CREATE TABLE manager_reviews (
  id bigserial PRIMARY KEY,
  trigger text NOT NULL CHECK (trigger IN ('daily','owner')),
  model text NOT NULL,
  summary text NOT NULL,
  focus jsonb NOT NULL DEFAULT '[]',
  changes jsonb NOT NULL DEFAULT '[]',
  findings jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now()
);
`,
  },
];
