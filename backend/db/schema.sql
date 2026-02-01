CREATE TABLE IF NOT EXISTS employees (
  employee_id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS face_templates (
  employee_id TEXT PRIMARY KEY REFERENCES employees(employee_id) ON DELETE CASCADE,
  descriptor REAL[] NOT NULL,
  image_url TEXT,
  image_public_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id SERIAL PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(employee_id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS webauthn_challenges (
  employee_id TEXT NOT NULL REFERENCES employees(employee_id) ON DELETE CASCADE,
  challenge TEXT NOT NULL,
  type TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
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
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Migrations for existing tables
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'employees' AND column_name = 'first_name') THEN
        ALTER TABLE employees ADD COLUMN first_name TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'employees' AND column_name = 'last_name') THEN
        ALTER TABLE employees ADD COLUMN last_name TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'employees' AND column_name = 'photo_url') THEN
        ALTER TABLE employees ADD COLUMN photo_url TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'employees' AND column_name = 'photo_public_id') THEN
        ALTER TABLE employees ADD COLUMN photo_public_id TEXT;
    END IF;
END $$;