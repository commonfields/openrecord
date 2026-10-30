-- Investigations are operator-authored working notes attached to an existing
-- growth goal. They are not findings, approvals, or evidence by themselves.
CREATE TABLE IF NOT EXISTS growth_investigations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  goal_id UUID NOT NULL,
  request_id UUID NOT NULL,
  question TEXT NOT NULL CHECK (length(trim(question)) BETWEEN 1 AND 2000),
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, business_id), UNIQUE (business_id, request_id),
  FOREIGN KEY (goal_id, business_id) REFERENCES growth_goals(id, business_id)
);
CREATE TABLE IF NOT EXISTS growth_investigation_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  investigation_id UUID NOT NULL,
  business_id UUID NOT NULL,
  request_id UUID NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('HYPOTHESIS', 'OBSERVATION', 'REVISION', 'CONCLUSION', 'QUESTION')),
  note TEXT NOT NULL CHECK (length(trim(note)) BETWEEN 1 AND 4000),
  created_by_user_id UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (investigation_id, request_id),
  FOREIGN KEY (investigation_id, business_id) REFERENCES growth_investigations(id, business_id)
);
CREATE INDEX IF NOT EXISTS growth_investigations_by_business ON growth_investigations(business_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS growth_investigation_notes_by_investigation ON growth_investigation_notes(investigation_id, created_at, id);
