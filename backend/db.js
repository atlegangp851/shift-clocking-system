const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const dbPath = path.join(__dirname, 'database.sqlite');
let db = null;
let SQL = null;

async function initDb() {
  SQL = await initSqlJs();

  if (fs.existsSync(dbPath)) {
    const filebuffer = fs.readFileSync(dbPath);
    db = new SQL.Database(filebuffer);
  } else {
    db = new SQL.Database();
    // Initialize Schema
    const schemaPath = path.join(__dirname, 'db', 'schema_sqlite.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');
    db.run(schema);
    saveDb();
  }
}

function saveDb() {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(dbPath, buffer);
}

function normalizeParams(params = []) {
  return params.map((value) => (value === undefined ? null : value));
}

// Helper to confirm DB is ready
function checkDb() {
  if (!db) throw new Error('Database not initialized');
}

// Helper to map sql.js results to objects
function mapResults(res) {
  if (!res || res.length === 0) return [];
  const columns = res[0].columns;
  const values = res[0].values;
  return values.map(row => {
    const obj = {};
    columns.forEach((col, i) => {
      obj[col] = row[i];
    });
    return obj;
  });
}

// Emulate db.run
function run(sql, params = []) {
  checkDb();
  db.run(sql, normalizeParams(params));

  // Capture lastID and changes before doing anything else
  let id = null;
  let changes = 0;
  try {
    const res = db.exec('SELECT last_insert_rowid(), changes()');
    if (res && res[0] && res[0].values && res[0].values[0]) {
      id = res[0].values[0][0];
      changes = res[0].values[0][1];
    }
  } catch (error) {
    id = null;
    changes = 1; // Assume change on error to be safe and save
  }

  if (changes > 0) {
    saveDb();
  }

  return { lastID: id, changes };
}

// Emulate db.get
function get(sql, params = []) {
  checkDb();
  // db.exec returns an array of result sets. WE want prepared statement for safety usually, 
  // but db.run/exec in sql.js handles binding?
  // db.run is for no-result, db.exec is for results but string concat?
  // Best to use statement for getting values safely
  const stmt = db.prepare(sql);
  stmt.bind(normalizeParams(params));
  const hasRow = stmt.step();
  let result = null;
  if (hasRow) {
    result = stmt.getAsObject();
  }
  stmt.free();
  return result;
}

// Emulate db.all
function all(sql, params = []) {
  checkDb();
  const stmt = db.prepare(sql);
  stmt.bind(normalizeParams(params));
  const results = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

async function ensureEmployee(employeeId) {
  run(
    'INSERT OR IGNORE INTO employees (employee_id) VALUES (?)',
    [employeeId]
  );
}

async function getEmployee(employeeId) {
  return get('SELECT * FROM employees WHERE employee_id = ?', [employeeId]);
}

async function getOpenShift(employeeId) {
  return get(
    `SELECT * FROM shift_entries
     WHERE employee_id = ? AND clock_out IS NULL
     ORDER BY clock_in DESC
     LIMIT 1`,
    [employeeId]
  );
}

async function createShift({ employeeId, method, clockInPhotoUrl, clockInPhotoPublicId }) {
  const now = new Date().toISOString();
  const result = run(
    `INSERT INTO shift_entries
      (employee_id, method, clock_in, clock_in_photo_url, clock_in_photo_public_id)
     VALUES (?, ?, ?, ?, ?)`,
    [employeeId, method, now, clockInPhotoUrl, clockInPhotoPublicId]
  );
  if (result.lastID) {
    const row = get('SELECT * FROM shift_entries WHERE id = ?', [result.lastID]);
    if (row) return row;
  }
  return getOpenShift(employeeId);
}

async function closeShift({ shiftId, clockOutPhotoUrl, clockOutPhotoPublicId }) {
  const now = new Date().toISOString();
  run(
    `UPDATE shift_entries
     SET clock_out = ?,
         clock_out_photo_url = ?,
         clock_out_photo_public_id = ?,
         updated_at = ?
     WHERE id = ?`,
    [now, clockOutPhotoUrl, clockOutPhotoPublicId, now, shiftId]
  );
  return get('SELECT * FROM shift_entries WHERE id = ?', [shiftId]);
}

async function getFaceTemplate(employeeId) {
  const row = get('SELECT * FROM face_templates WHERE employee_id = ?', [employeeId]);
  if (row && row.descriptor) {
    try { row.descriptor = JSON.parse(row.descriptor); } catch (e) { }
  }
  return row || null;
}

async function upsertFaceTemplate({ employeeId, descriptor, imageUrl, imagePublicId }) {
  const descriptorJson = JSON.stringify(descriptor);

  const now = new Date().toISOString();
  run(
    `INSERT INTO face_templates (employee_id, descriptor, image_url, image_public_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(employee_id) DO UPDATE SET
       descriptor = excluded.descriptor,
       image_url = excluded.image_url,
       image_public_id = excluded.image_public_id,
       updated_at = ?`,
    [employeeId, descriptorJson, imageUrl, imagePublicId, now, now, now]
  );
  return getFaceTemplate(employeeId);
}

async function saveChallenge({ employeeId, type, challenge }) {
  run(
    `INSERT INTO webauthn_challenges (employee_id, type, challenge, created_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(employee_id, type) DO UPDATE SET
       challenge = excluded.challenge,
       created_at = datetime('now')`,
    [employeeId, type, challenge]
  );
}

async function getChallenge({ employeeId, type }) {
  return get(
    'SELECT challenge, created_at FROM webauthn_challenges WHERE employee_id = ? AND type = ?',
    [employeeId, type]
  );
}

async function getCredentials(employeeId) {
  const rows = all(
    'SELECT * FROM webauthn_credentials WHERE employee_id = ? ORDER BY created_at DESC',
    [employeeId]
  );
  return rows.map(r => {
    try { r.transports = JSON.parse(r.transports || '[]'); } catch (e) { }
    return r;
  });
}

async function getCredentialById(credentialId) {
  const row = get(
    'SELECT * FROM webauthn_credentials WHERE credential_id = ?',
    [credentialId]
  );
  if (row) {
    try { row.transports = JSON.parse(row.transports || '[]'); } catch (e) { }
  }
  return row || null;
}

async function saveCredential({ employeeId, credentialId, publicKey, counter, transports }) {
  const transportsJson = JSON.stringify(transports);
  run(
    `INSERT INTO webauthn_credentials
      (employee_id, credential_id, public_key, counter, transports, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(credential_id) DO UPDATE SET
       public_key = excluded.public_key,
       counter = excluded.counter,
       transports = excluded.transports,
       updated_at = datetime('now')`,
    [employeeId, credentialId, publicKey, counter, transportsJson]
  );
  return getCredentialById(credentialId);
}

async function updateCredentialCounter(credentialId, counter) {
  run(
    `UPDATE webauthn_credentials SET counter = ?, updated_at = datetime('now') WHERE credential_id = ?`,
    [counter, credentialId]
  );
}

// Admin Functions

async function createAdmin({ username, passwordHash }) {
  run(
    'INSERT INTO admins (username, password_hash) VALUES (?, ?)',
    [username, passwordHash]
  );
  return get('SELECT id, username, created_at FROM admins WHERE username = ?', [username]);
}

async function getAdmin(username) {
  return get('SELECT * FROM admins WHERE username = ?', [username]);
}

async function getAllEmployees() {
  return all('SELECT * FROM employees ORDER BY created_at DESC');
}

async function createEmployee({ employeeId, firstName, lastName, photoUrl, photoPublicId }) {
  run(
    `INSERT INTO employees (employee_id, first_name, last_name, photo_url, photo_public_id, created_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(employee_id) DO UPDATE SET
       first_name = excluded.first_name,
       last_name = excluded.last_name,
       photo_url = coalesce(excluded.photo_url, employees.photo_url),
       photo_public_id = coalesce(excluded.photo_public_id, employees.photo_public_id)`,
    [employeeId, firstName, lastName, photoUrl, photoPublicId]
  );
  return get('SELECT * FROM employees WHERE employee_id = ?', [employeeId]);
}

async function deleteEmployee(employeeId) {
  run('DELETE FROM employees WHERE employee_id = ?', [employeeId]);
}

async function getDailyAttendance(dateString) {
  const filterDate = dateString || new Date().toISOString().split('T')[0];

  return all(
    `SELECT s.*, e.first_name, e.last_name, e.photo_url as employee_photo
     FROM shift_entries s
     JOIN employees e ON s.employee_id = e.employee_id
     WHERE strftime('%Y-%m-%d', s.clock_in) = ?
     ORDER BY s.clock_in DESC`,
    [filterDate]
  );
}

async function getStats(timeFrame) {
  let dateModifier = '-30 days';
  if (timeFrame === 'week') dateModifier = '-7 days';
  if (timeFrame === 'day') dateModifier = '-1 day';
  if (timeFrame === 'month') dateModifier = '-1 month';
  if (timeFrame === 'all') dateModifier = '-100 years';

  return all(
    `SELECT 
       e.employee_id, 
       e.first_name, 
       e.last_name, 
       COUNT(s.id) as shifts_count, 
       COALESCE(SUM((unixepoch(COALESCE(s.clock_out, datetime('now'))) - unixepoch(s.clock_in)) / 3600.0), 0) as total_hours
     FROM employees e
     LEFT JOIN shift_entries s ON e.employee_id = s.employee_id 
     AND s.clock_in >= datetime('now', ?)
     GROUP BY e.employee_id, e.first_name, e.last_name
     ORDER BY total_hours DESC`,
    [dateModifier]
  );
}

module.exports = {
  // export db if needed, but methods are wrapped
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
