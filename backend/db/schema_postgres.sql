CREATE TABLE IF NOT EXISTS employees (
  employee_id TEXT PRIMARY KEY,
  first_name TEXT,
  last_name TEXT,
  photo_url TEXT,
  photo_public_id TEXT,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS face_templates (
  employee_id TEXT PRIMARY KEY REFERENCES employees(employee_id) ON DELETE CASCADE,
  descriptor TEXT NOT NULL, -- JSON string
  image_url TEXT,
  image_public_id TEXT,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id SERIAL PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(employee_id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  counter BIGINT NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]', -- JSON string
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS webauthn_challenges (
  employee_id TEXT NOT NULL REFERENCES employees(employee_id) ON DELETE CASCADE,
  challenge TEXT NOT NULL,
  type TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (employee_id, type)
);

CREATE TABLE IF NOT EXISTS shift_entries (
  id SERIAL PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(employee_id) ON DELETE CASCADE,
  method TEXT NOT NULL CHECK (method IN ('face', 'fingerprint')),
  clock_in TIMESTAMPTZ NOT NULL,
  clock_out TIMESTAMPTZ,
  clock_in_photo_url TEXT,
  clock_in_photo_public_id TEXT,
  clock_out_photo_url TEXT,
  clock_out_photo_public_id TEXT,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_shift_entries_open
  ON shift_entries(employee_id)
  WHERE clock_out IS NULL;

CREATE INDEX IF NOT EXISTS idx_shift_entries_employee
  ON shift_entries(employee_id, clock_in DESC);

CREATE TABLE IF NOT EXISTS admins (
  id SERIAL PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
