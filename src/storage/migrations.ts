import type Database from "better-sqlite3";

const migrations: readonly string[] = [
  `
    CREATE TABLE webhook_deliveries (
      delivery_id TEXT PRIMARY KEY,
      run_id TEXT REFERENCES review_runs(run_id),
      body_digest TEXT,
      eligibility TEXT NOT NULL,
      redacted_reason TEXT,
      received_at_ms INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE review_runs (
      run_id TEXT PRIMARY KEY,
      installation_id INTEGER NOT NULL,
      repository_id INTEGER NOT NULL,
      pull_number INTEGER NOT NULL,
      head_sha TEXT NOT NULL,
      state TEXT NOT NULL,
      lease_owner TEXT,
      lease_expires_at_ms INTEGER,
      lease_attempt INTEGER NOT NULL DEFAULT 0,
      created_at_ms INTEGER NOT NULL,
      completed_at_ms INTEGER,
      failure_reason TEXT,
      UNIQUE (installation_id, repository_id, pull_number, head_sha),
      CHECK (state IN ('accepted','snapshotting','planning','preparing_sailbox','reviewing','challenging','reducing','publishing','cleaning_up','completed','failed')),
      CHECK ((lease_owner IS NULL) = (lease_expires_at_ms IS NULL))
    ) STRICT;

    CREATE TABLE snapshots (
      run_id TEXT PRIMARY KEY REFERENCES review_runs(run_id) ON DELETE CASCADE,
      base_sha TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      merge_base_sha TEXT NOT NULL,
      coverage_omissions_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE snapshot_files (
      run_id TEXT NOT NULL REFERENCES snapshots(run_id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      status TEXT NOT NULL,
      changed_lines_json TEXT NOT NULL,
      patch TEXT,
      context_text TEXT,
      omission_reason TEXT,
      PRIMARY KEY (run_id, path)
    ) STRICT;

    CREATE TABLE work_items (
      work_key TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES review_runs(run_id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      owner TEXT,
      lease_expires_at_ms INTEGER,
      attempt INTEGER NOT NULL DEFAULT 0,
      receipt_json TEXT,
      completed_at_ms INTEGER,
      created_at_ms INTEGER NOT NULL,
      CHECK ((owner IS NULL) = (lease_expires_at_ms IS NULL))
    ) STRICT;

    CREATE TABLE reviewer_reports (
      run_id TEXT NOT NULL REFERENCES review_runs(run_id) ON DELETE CASCADE,
      reviewer_id TEXT NOT NULL,
      report_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY (run_id, reviewer_id)
    ) STRICT;

    CREATE TABLE findings (
      finding_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES review_runs(run_id) ON DELETE CASCADE,
      reviewer_id TEXT NOT NULL,
      stable_identity TEXT NOT NULL,
      path TEXT NOT NULL,
      line INTEGER NOT NULL,
      finding_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      UNIQUE (run_id, reviewer_id, stable_identity)
    ) STRICT;

    CREATE TABLE challenge_verdicts (
      finding_id TEXT PRIMARY KEY REFERENCES findings(finding_id) ON DELETE CASCADE,
      outcome TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      CHECK (outcome IN ('confirmed','rejected','inconclusive','failed'))
    ) STRICT;

    CREATE TABLE budget_reservations (
      run_id TEXT NOT NULL REFERENCES review_runs(run_id) ON DELETE CASCADE,
      reservation_key TEXT NOT NULL,
      reserved_micros INTEGER NOT NULL,
      settled_micros INTEGER,
      provider_usage_json TEXT,
      created_at_ms INTEGER NOT NULL,
      settled_at_ms INTEGER,
      PRIMARY KEY (run_id, reservation_key),
      CHECK (reserved_micros >= 0 AND reserved_micros <= 250000),
      CHECK (settled_micros IS NULL OR settled_micros >= 0)
    ) STRICT;

    CREATE TABLE sailboxes (
      run_id TEXT PRIMARY KEY REFERENCES review_runs(run_id) ON DELETE CASCADE,
      sailbox_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      creation_receipt_json TEXT NOT NULL,
      termination_receipt_json TEXT,
      created_at_ms INTEGER NOT NULL,
      terminated_at_ms INTEGER
    ) STRICT;

    CREATE TABLE publications (
      publication_key TEXT PRIMARY KEY,
      run_id TEXT NOT NULL UNIQUE REFERENCES review_runs(run_id) ON DELETE CASCADE,
      github_review_id INTEGER,
      body_digest TEXT NOT NULL,
      submit_result_json TEXT,
      created_at_ms INTEGER NOT NULL,
      submitted_at_ms INTEGER
    ) STRICT;

    CREATE TABLE run_events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES review_runs(run_id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      redacted_payload_json TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    ) STRICT;

    CREATE INDEX review_runs_claimable ON review_runs(state, lease_expires_at_ms, created_at_ms);
    CREATE INDEX work_items_claimable ON work_items(completed_at_ms, lease_expires_at_ms, created_at_ms);
    CREATE INDEX findings_run ON findings(run_id);
    CREATE INDEX run_events_run ON run_events(run_id, event_id);
  `,
  `
    ALTER TABLE review_runs ADD COLUMN owner TEXT;
    ALTER TABLE review_runs ADD COLUMN repository_name TEXT;
    ALTER TABLE review_runs ADD COLUMN base_sha TEXT;
  `,
  `
    ALTER TABLE snapshot_files ADD COLUMN ordinal INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE snapshot_files ADD COLUMN file_kind TEXT NOT NULL DEFAULT 'reviewable';
    CREATE UNIQUE INDEX snapshot_files_ordinal ON snapshot_files(run_id, ordinal);
  `,
];

export const migrate = (database: Database.Database): void => {
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");
  database.pragma("busy_timeout = 5000");
  const currentVersion = database.pragma("user_version", { simple: true });
  if (typeof currentVersion !== "number" || !Number.isInteger(currentVersion))
    throw new Error("Invalid SQLite user_version");
  for (let index = currentVersion; index < migrations.length; index += 1) {
    const sql = migrations[index];
    if (sql === undefined)
      throw new Error(`Missing migration ${String(index + 1)}`);
    database.transaction(() => {
      database.exec(sql);
      database.pragma(`user_version = ${String(index + 1)}`);
    })();
  }
};
