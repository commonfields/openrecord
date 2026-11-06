-- Adapt the preserved local inference checkpoints without reusing old numbering.
CREATE TABLE IF NOT EXISTS agent_run_findings (
  run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  invocation_id uuid NOT NULL,
  tool text NOT NULL CHECK (length(tool) <= 100),
  summary text NOT NULL CHECK (length(summary) <= 500),
  excerpt text NOT NULL CHECK (length(excerpt) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id,invocation_id)
);
