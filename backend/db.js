const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// Parse and clean connection string
let connectionString = process.env.DATABASE_URL;
if (connectionString && connectionString.includes('channel_binding=require')) {
  connectionString = connectionString.replace('channel_binding=require', '');
}

const pool = new Pool({
  connectionString,
  ssl: {
    rejectUnauthorized: false
  },
  connectionTimeoutMillis: 60000, // 60 seconds (increased from 10s)
  idleTimeoutMillis: 30000,
});

pool.on('error', (err, client) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

async function query(text, params) {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    // console.log('executed query', { text, duration, rows: res.rowCount });
    return res;
  } catch (err) {
    console.error('[db] Query failed', { text, params, error: err.message });
    throw err;
  }
}

async function initDb() {
  try {
    const client = await pool.connect();
    console.log('[db] Connected to PostgreSQL');

    // Always run schema to ensure all tables exist (uses IF NOT EXISTS)
    console.log('[db] Initializing schema...');
    const schemaPath = path.join(__dirname, 'db', 'schema_postgres.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');
    await client.query(schema);
    console.log('[db] Schema initialized');

    client.release();
  } catch (err) {
    console.error('[db] Failed to initialize database', err);
    process.exit(1);
  }
}

async function ensureEmployee(employeeId) {
  await query(
    'INSERT INTO employees (employee_id) VALUES ($1) ON CONFLICT (employee_id) DO NOTHING',
    [employeeId]
  );
}

async function getEmployee(employeeId) {
  const res = await query('SELECT * FROM employees WHERE employee_id = $1', [employeeId]);
  return res.rows[0] || null;
}

async function getOpenShift(employeeId) {
  const res = await query(
    `SELECT * FROM shift_entries
     WHERE employee_id = $1 AND clock_out IS NULL
     ORDER BY clock_in DESC
     LIMIT 1`,
    [employeeId]
  );
  return res.rows[0] || null;
}

async function createShift({ employeeId, method, clockInPhotoUrl, clockInPhotoPublicId }) {
  const now = new Date().toISOString();
  const res = await query(
    `INSERT INTO shift_entries
      (employee_id, method, clock_in, clock_in_photo_url, clock_in_photo_public_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [employeeId, method, now, clockInPhotoUrl, clockInPhotoPublicId]
  );
  return res.rows[0];
}

async function closeShift({ shiftId, clockOutPhotoUrl, clockOutPhotoPublicId }) {
  const now = new Date().toISOString();
  const res = await query(
    `UPDATE shift_entries
     SET clock_out = $1,
         clock_out_photo_url = $2,
         clock_out_photo_public_id = $3,
         updated_at = $4
     WHERE id = $5
     RETURNING *`,
    [now, clockOutPhotoUrl, clockOutPhotoPublicId, now, shiftId]
  );
  return res.rows[0];
}

async function getFaceTemplate(employeeId) {
  const res = await query('SELECT * FROM face_templates WHERE employee_id = $1', [employeeId]);
  let row = res.rows[0];
  if (row && row.descriptor) {
    try { row.descriptor = JSON.parse(row.descriptor); } catch (e) { }
  }
  return row || null;
}

async function upsertFaceTemplate({ employeeId, descriptor, imageUrl, imagePublicId }) {
  const descriptorJson = JSON.stringify(descriptor);
  const now = new Date().toISOString();

  await query(
    `INSERT INTO face_templates (employee_id, descriptor, image_url, image_public_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT(employee_id) DO UPDATE SET
       descriptor = EXCLUDED.descriptor,
       image_url = EXCLUDED.image_url,
       image_public_id = EXCLUDED.image_public_id,
       updated_at = EXCLUDED.updated_at`,
    [employeeId, descriptorJson, imageUrl, imagePublicId, now, now]
  );

  return getFaceTemplate(employeeId);
}

async function saveChallenge({ employeeId, type, challenge }) {
  await query(
    `INSERT INTO webauthn_challenges (employee_id, type, challenge, created_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT(employee_id, type) DO UPDATE SET
       challenge = EXCLUDED.challenge,
       created_at = NOW()`,
    [employeeId, type, challenge]
  );
}

async function getChallenge({ employeeId, type }) {
  const res = await query(
    'SELECT challenge, created_at FROM webauthn_challenges WHERE employee_id = $1 AND type = $2',
    [employeeId, type]
  );
  return res.rows[0] || null;
}

async function getCredentials(employeeId) {
  const res = await query(
    'SELECT * FROM webauthn_credentials WHERE employee_id = $1 ORDER BY created_at DESC',
    [employeeId]
  );
  return res.rows.map(r => {
    try { r.transports = JSON.parse(r.transports || '[]'); } catch (e) { }
    // Ensure counter is a number/string handled correctly (Postgres BIGINT comes as string)
    r.counter = Number(r.counter);
    return r;
  });
}

async function getCredentialById(credentialId) {
  const res = await query(
    'SELECT * FROM webauthn_credentials WHERE credential_id = $1',
    [credentialId]
  );
  const row = res.rows[0];
  if (row) {
    try { row.transports = JSON.parse(row.transports || '[]'); } catch (e) { }
    row.counter = Number(row.counter);
  }
  return row || null;
}

async function saveCredential({ employeeId, credentialId, publicKey, counter, transports }) {
  const transportsJson = JSON.stringify(transports);
  await query(
    `INSERT INTO webauthn_credentials
      (employee_id, credential_id, public_key, counter, transports, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
     ON CONFLICT(credential_id) DO UPDATE SET
       public_key = EXCLUDED.public_key,
       counter = EXCLUDED.counter,
       transports = EXCLUDED.transports,
       updated_at = NOW()`,
    [employeeId, credentialId, publicKey, counter, transportsJson]
  );
  return getCredentialById(credentialId);
}

async function updateCredentialCounter(credentialId, counter) {
  await query(
    `UPDATE webauthn_credentials SET counter = $1, updated_at = NOW() WHERE credential_id = $2`,
    [counter, credentialId]
  );
}

async function createAdmin({ username, passwordHash }) {
  const res = await query(
    'INSERT INTO admins (username, password_hash) VALUES ($1, $2) RETURNING id, username, created_at',
    [username, passwordHash]
  );
  return res.rows[0];
}

async function getAdmin(username) {
  const res = await query('SELECT * FROM admins WHERE username = $1', [username]);
  return res.rows[0] || null;
}

async function getAllEmployees() {
  const res = await query('SELECT * FROM employees ORDER BY created_at DESC');
  return res.rows;
}

async function createEmployee({ employeeId, firstName, lastName, photoUrl, photoPublicId }) {
  await query(
    `INSERT INTO employees (employee_id, first_name, last_name, photo_url, photo_public_id, created_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT(employee_id) DO UPDATE SET
       first_name = EXCLUDED.first_name,
       last_name = EXCLUDED.last_name,
       photo_url = COALESCE(EXCLUDED.photo_url, employees.photo_url),
       photo_public_id = COALESCE(EXCLUDED.photo_public_id, employees.photo_public_id)`,
    [employeeId, firstName, lastName, photoUrl, photoPublicId]
  );
  // Fetch fresh to return
  return getEmployee(employeeId);
}

async function deleteEmployee(employeeId) {
  await query('DELETE FROM employees WHERE employee_id = $1', [employeeId]);
}

async function getDailyAttendance(dateString) {
  // Postgres Date cast
  const filterDate = dateString || new Date().toISOString().split('T')[0];
  const res = await query(
    `SELECT s.*, e.first_name, e.last_name, e.photo_url as employee_photo
     FROM shift_entries s
     JOIN employees e ON s.employee_id = e.employee_id
     WHERE s.clock_in::date = $1::date
     ORDER BY s.clock_in DESC`,
    [filterDate]
  );
  return res.rows;
}

async function getStats(timeFrame) {
  let dateModifier = '30 days';
  if (timeFrame === 'week') dateModifier = '7 days';
  if (timeFrame === 'day') dateModifier = '1 day';
  if (timeFrame === 'month') dateModifier = '1 month';
  if (timeFrame === 'all') dateModifier = '100 years'; // Approximate 'all time'

  const res = await query(
    `SELECT 
       e.employee_id, 
       e.first_name, 
       e.last_name, 
       COUNT(s.id) as shifts_count, 
       COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(s.clock_out, NOW()) - s.clock_in)) / 3600.0), 0) as total_hours
     FROM employees e
     LEFT JOIN shift_entries s ON e.employee_id = s.employee_id 
     AND s.clock_in >= (NOW() - $1::interval)
     GROUP BY e.employee_id, e.first_name, e.last_name
     ORDER BY total_hours DESC`,
    [dateModifier]
  );
  return res.rows;
}

module.exports = {
  initDb,
  ensureEmployee,
  getEmployee,
  getOpenShift,
  createShift,
  closeShift,
  getFaceTemplate,
  upsertFaceTemplate,
  saveChallenge,
  getChallenge,
  getCredentials,
  getCredentialById,
  saveCredential,
  updateCredentialCounter,
  createAdmin,
  getAdmin,
  getAllEmployees,
  createEmployee,
  deleteEmployee,
  getDailyAttendance,
  getStats,
};
