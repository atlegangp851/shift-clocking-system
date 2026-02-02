const path = require('path');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const {
  initDb,
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
} = require('./db');

const { uploadImage } = require('./cloudinary');
const {
  buildRegistrationOptions,
  buildAuthenticationOptions,
  verifyRegistration,
  verifyAuthentication,
  toBase64URL,
} = require('./webauthn');

const app = express();
const rootDir = path.join(__dirname, '..');
const PORT = process.env.PORT || 3000;

const LOG_PREFIX = '[backend]';
function logInfo(message, meta) {
  if (meta !== undefined) {
    console.log(`${LOG_PREFIX} ${message}`, meta);
  } else {
    console.log(`${LOG_PREFIX} ${message}`);
  }
}
function logWarn(message, meta) {
  if (meta !== undefined) {
    console.warn(`${LOG_PREFIX} ${message}`, meta);
  } else {
    console.warn(`${LOG_PREFIX} ${message}`);
  }
}
function logError(message, meta) {
  if (meta !== undefined) {
    console.error(`${LOG_PREFIX} ${message}`, meta);
  } else {
    console.error(`${LOG_PREFIX} ${message}`);
  }
}

app.use(cors({
  origin: [
    'https://shift-clocking-system.netlify.app',
    'https://shift-clocking-system.onrender.com',
    'http://localhost:5500',
    'http://127.0.0.1:5500',
    'http://127.0.0.1:3000'
  ],
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use((req, res, next) => {
  const start = Date.now();
  logInfo(`REQ ${req.method} ${req.originalUrl}`, {
    ip: req.ip,
    contentType: req.headers['content-type'],
  });
  res.on('finish', () => {
    const durationMs = Date.now() - start;
    const level = res.statusCode >= 500 ? logError : res.statusCode >= 400 ? logWarn : logInfo;
    level(`RES ${req.method} ${req.originalUrl} ${res.statusCode} ${durationMs}ms`);
  });
  next();
});
app.get('/styles.css', (req, res) => {
  res.sendFile(path.join(rootDir, 'styles.css'));
});

app.get('/app.js', (req, res) => {
  res.sendFile(path.join(rootDir, 'app.js'));
});

app.get('/admin.js', (req, res) => {
  res.sendFile(path.join(rootDir, 'admin.js'));
});

app.get('/admin.html', (req, res) => {
  res.sendFile(path.join(rootDir, 'admin.html'));
});

app.use('/models', express.static(path.join(__dirname, 'models')));

function sendError(res, status, code, message) {
  const level = status >= 500 ? logError : status >= 400 ? logWarn : logInfo;
  level(`API_ERROR ${code} ${status}: ${message}`);
  res.status(status).json({ code, message });
}

function getEmployeeId(input) {
  if (!input) return null;
  const value = String(input).trim();
  return value.length ? value : null;
}

function parseDescriptor(input) {
  if (!Array.isArray(input) || input.length === 0) {
    const error = new Error('Face descriptor is required.');
    error.code = 'DESCRIPTOR_REQUIRED';
    throw error;
  }
  const normalized = input.map((value) => Number(value));
  if (normalized.some((value) => !Number.isFinite(value))) {
    const error = new Error('Face descriptor is invalid.');
    error.code = 'DESCRIPTOR_INVALID';
    throw error;
  }
  return normalized;
}

function euclideanDistance(descriptorA, descriptorB) {
  if (!descriptorA || !descriptorB || descriptorA.length !== descriptorB.length) {
    const error = new Error('Face descriptor mismatch.');
    error.code = 'DESCRIPTOR_MISMATCH';
    throw error;
  }

  let sum = 0;
  for (let i = 0; i < descriptorA.length; i += 1) {
    const diff = descriptorA[i] - descriptorB[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

async function verifyFace(employeeId, descriptor) {
  const template = await getFaceTemplate(employeeId);
  if (!template) {
    const error = new Error('Face template not enrolled for this employee.');
    error.code = 'FACE_NOT_ENROLLED';
    throw error;
  }
  const storedDescriptor = Array.isArray(template.descriptor)
    ? template.descriptor.map((value) => Number(value))
    : template.descriptor;
  const distance = euclideanDistance(descriptor, storedDescriptor);
  const threshold = Number(process.env.FACE_MATCH_THRESHOLD || 0.6);
  if (distance > threshold) {
    const error = new Error('Face verification failed.');
    error.code = 'FACE_MISMATCH';
    throw error;
  }
  return { distance, threshold };
}

async function verifyFingerprint(employeeId, webauthnResponse) {
  const challenge = await getChallenge({ employeeId, type: 'authentication' });
  if (!challenge) {
    const error = new Error('Authentication challenge not found.');
    error.code = 'AUTH_CHALLENGE_MISSING';
    throw error;
  }

  const credentialId = webauthnResponse.id;
  const credential = await getCredentialById(credentialId);
  if (!credential) {
    const error = new Error('Fingerprint credential not found.');
    error.code = 'CREDENTIAL_NOT_FOUND';
    throw error;
  }

  const verification = await verifyAuthentication({
    response: webauthnResponse,
    expectedChallenge: challenge.challenge,
    credential,
  });

  if (!verification.verified) {
    const error = new Error('Fingerprint verification failed.');
    error.code = 'FINGERPRINT_MISMATCH';
    throw error;
  }

  const newCounter =
    typeof verification.authenticationInfo.newCounter === 'number'
      ? verification.authenticationInfo.newCounter
      : credential.counter;
  await updateCredentialCounter(credentialId, newCounter);
}

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/status', async (req, res) => {
  const employeeId = getEmployeeId(req.query.employeeId);
  if (!employeeId) {
    return sendError(res, 400, 'EMPLOYEE_ID_REQUIRED', 'Employee ID is required.');
  }

  try {
    const employee = await getEmployee(employeeId);
    if (!employee) {
      return sendError(res, 404, 'EMPLOYEE_NOT_FOUND', 'Employee ID not found. Only admins can register new employees.');
    }
    logInfo('Employee ensured for status check', { employeeId });
    const openShift = await getOpenShift(employeeId);

    const response = {
      status: openShift ? 'clocked_in' : 'not_clocked_in',
      firstName: employee.first_name,
      lastName: employee.last_name,
    };

    if (openShift) {
      logInfo('Open shift found', { employeeId, shiftId: openShift.id, method: openShift.method });
      response.clockInAt = openShift.clock_in;
      response.method = openShift.method;
    } else {
      logInfo('No open shift for employee', { employeeId });
    }

    return res.json(response);
  } catch (error) {
    logError('Status check failed', { employeeId, error: error.message });
    return sendError(res, 500, 'STATUS_ERROR', 'Unable to fetch status.');
  }
});

app.post('/api/face/enroll', async (req, res) => {
  const employeeId = getEmployeeId(req.body.employeeId);
  const image = req.body.image;
  const descriptor = req.body.descriptor;

  if (!employeeId || !image || !descriptor) {
    return sendError(
      res,
      400,
      'INVALID_REQUEST',
      'Employee ID, face image, and descriptor are required.'
    );
  }

  try {
    const employee = await getEmployee(employeeId);
    if (!employee) {
      return sendError(res, 404, 'EMPLOYEE_NOT_FOUND', 'Employee ID not found. Only admins can register new employees.');
    }
    logInfo('Employee ensured for face enrollment', { employeeId });
    const parsedDescriptor = parseDescriptor(descriptor);
    const upload = await uploadImage(image, `face-${employeeId}`);
    await upsertFaceTemplate({
      employeeId,
      descriptor: parsedDescriptor,
      imageUrl: upload.url,
      imagePublicId: upload.publicId,
    });

    logInfo('Face template enrolled', { employeeId, imagePublicId: upload.publicId });
    return res.json({ message: 'Face template enrolled.' });
  } catch (error) {
    logError('Face enrollment failed', { employeeId, code: error.code, error: error.message });
    return sendError(res, 400, error.code || 'FACE_ENROLL_ERROR', error.message);
  }
});

app.post('/api/face/verify', async (req, res) => {
  const employeeId = getEmployeeId(req.body.employeeId);
  const descriptor = req.body.descriptor;

  if (!employeeId || !descriptor) {
    return sendError(
      res,
      400,
      'INVALID_REQUEST',
      'Employee ID and face descriptor are required.'
    );
  }

  try {
    const parsedDescriptor = parseDescriptor(descriptor);
    const result = await verifyFace(employeeId, parsedDescriptor);
    logInfo('Face verified', { employeeId, distance: result.distance });
    return res.json({ verified: true, ...result });
  } catch (error) {
    logWarn('Face verification failed', { employeeId, code: error.code, error: error.message });
    return sendError(res, 400, error.code || 'FACE_VERIFY_ERROR', error.message);
  }
});

app.post('/api/webauthn/register/options', async (req, res) => {
  const employeeId = getEmployeeId(req.body.employeeId);
  if (!employeeId) {
    return sendError(res, 400, 'EMPLOYEE_ID_REQUIRED', 'Employee ID is required.');
  }

  try {
    const employee = await getEmployee(employeeId);
    if (!employee) {
      return sendError(res, 404, 'EMPLOYEE_NOT_FOUND', 'Employee ID not found. Only admins can register new employees.');
    }
    logInfo('Employee ensured for webauthn register options', { employeeId });
    const credentials = await getCredentials(employeeId);
    const options = await buildRegistrationOptions({ employeeId, existingCredentials: credentials });
    await saveChallenge({ employeeId, type: 'registration', challenge: options.challenge });
    logInfo('Webauthn registration options created', { employeeId });
    return res.json({ options });
  } catch (error) {
    logError('Webauthn registration options failed', { employeeId, error: error.message, stack: error.stack });
    return sendError(res, 500, 'WEBAUTHN_OPTIONS_ERROR', `Unable to create registration options: ${error.message}`);
  }
});

app.post('/api/webauthn/register/verify', async (req, res) => {
  const employeeId = getEmployeeId(req.body.employeeId);
  const attestation = req.body.attestation;

  if (!employeeId || !attestation) {
    return sendError(res, 400, 'INVALID_REQUEST', 'Employee ID and attestation are required.');
  }

  try {
    const challenge = await getChallenge({ employeeId, type: 'registration' });
    if (!challenge) {
      logWarn('Registration challenge missing', { employeeId });
      return sendError(res, 400, 'CHALLENGE_MISSING', 'Registration challenge not found.');
    }

    const verification = await verifyRegistration({
      response: attestation,
      expectedChallenge: challenge.challenge,
    });

    if (!verification.verified) {
      logWarn('Webauthn registration verification failed', { employeeId });
      return sendError(res, 401, 'WEBAUTHN_FAILED', 'Fingerprint enrollment failed.');
    }

    const { credentialID, credentialPublicKey, counter } = verification.registrationInfo;
    const transports = attestation.response?.transports || [];

    await saveCredential({
      employeeId,
      credentialId: toBase64URL(credentialID),
      publicKey: toBase64URL(credentialPublicKey),
      counter,
      transports,
    });

    logInfo('Webauthn credential saved', { employeeId, credentialId: toBase64URL(credentialID) });
    return res.json({ verified: true });
  } catch (error) {
    logError('Webauthn registration verify error', { employeeId, error: error.message });
    return sendError(res, 400, 'WEBAUTHN_VERIFY_ERROR', error.message);
  }
});

app.post('/api/webauthn/authenticate/options', async (req, res) => {
  const employeeId = getEmployeeId(req.body.employeeId);
  if (!employeeId) {
    return sendError(res, 400, 'EMPLOYEE_ID_REQUIRED', 'Employee ID is required.');
  }

  try {
    const credentials = await getCredentials(employeeId);
    if (!credentials.length) {
      logInfo('Webauthn authentication needs enrollment', { employeeId });
      return res.json({ needsEnrollment: true });
    }

    const options = await buildAuthenticationOptions({ credentials });
    await saveChallenge({ employeeId, type: 'authentication', challenge: options.challenge });
    logInfo('Webauthn authentication options created', { employeeId });
    return res.json({ options });
  } catch (error) {
    logError('Webauthn authentication options failed', { employeeId, error: error.message });
    return sendError(res, 500, 'WEBAUTHN_OPTIONS_ERROR', 'Unable to create authentication options.');
  }
});

app.post('/api/clock-in', async (req, res) => {
  const employeeId = getEmployeeId(req.body.employeeId);
  const method = req.body.method;
  const image = req.body.image;
  const descriptor = req.body.descriptor;
  const webauthnResponse = req.body.webauthn;

  if (!employeeId || !method) {
    return sendError(res, 400, 'INVALID_REQUEST', 'Employee ID and method are required.');
  }

  try {
    const employee = await getEmployee(employeeId);
    if (!employee) {
      return sendError(res, 404, 'EMPLOYEE_NOT_FOUND', 'Employee ID not found. Only admins can register new employees.');
    }
    logInfo('Employee ensured for clock-in', { employeeId, method });
    const openShift = await getOpenShift(employeeId);
    if (openShift) {
      logWarn('Clock-in blocked: already clocked in', { employeeId, shiftId: openShift.id });
      return sendError(res, 409, 'ALREADY_CLOCKED_IN', 'Employee is already clocked in.');
    }

    if (method === 'face') {
      if (!image || !descriptor) {
        return sendError(
          res,
          400,
          'FACE_DATA_REQUIRED',
          'Face image and descriptor are required.'
        );
      }
      const parsedDescriptor = parseDescriptor(descriptor);
      await verifyFace(employeeId, parsedDescriptor);
      logInfo('Face verified for clock-in', { employeeId });
    } else if (method === 'fingerprint') {
      if (!webauthnResponse) {
        return sendError(res, 400, 'FINGERPRINT_REQUIRED', 'Fingerprint verification is required.');
      }
      await verifyFingerprint(employeeId, webauthnResponse);
      logInfo('Fingerprint verified for clock-in', { employeeId });
    } else {
      return sendError(res, 400, 'INVALID_METHOD', 'Unsupported verification method.');
    }

    let photo = null;
    if (method === 'face') {
      photo = await uploadImage(image, `clockin-${employeeId}`);
    }

    const shift = await createShift({
      employeeId,
      method,
      clockInPhotoUrl: photo?.url || null,
      clockInPhotoPublicId: photo?.publicId || null,
    });

    if (!shift) {
      logError('Clock-in failed: shift insert returned null', { employeeId, method });
      return sendError(res, 500, 'SHIFT_CREATE_FAILED', 'Unable to create shift.');
    }

    logInfo('Clock-in recorded', { employeeId, shiftId: shift.id, method });
    return res.json({
      message: 'Clock-in successful.',
      timestamp: shift.clock_in,
      clockInAt: shift.clock_in,
    });
  } catch (error) {
    logError('Clock-in failed', { employeeId, method, code: error.code, error: error.message });
    return sendError(res, 400, error.code || 'CLOCK_IN_ERROR', error.message);
  }
});

app.post('/api/clock-out', async (req, res) => {
  const employeeId = getEmployeeId(req.body.employeeId);
  const method = req.body.method;
  const image = req.body.image;
  const descriptor = req.body.descriptor;
  const webauthnResponse = req.body.webauthn;

  if (!employeeId || !method) {
    return sendError(res, 400, 'INVALID_REQUEST', 'Employee ID and method are required.');
  }

  try {
    const employee = await getEmployee(employeeId);
    if (!employee) {
      return sendError(res, 404, 'EMPLOYEE_NOT_FOUND', 'Employee ID not found. Only admins can register new employees.');
    }
    logInfo('Employee ensured for clock-out', { employeeId, method });
    const openShift = await getOpenShift(employeeId);
    if (!openShift) {
      logWarn('Clock-out blocked: no open shift', { employeeId });
      return sendError(res, 409, 'NOT_CLOCKED_IN', 'No active shift found for this employee.');
    }

    if (openShift.method !== method) {
      logWarn('Clock-out blocked: method mismatch', { employeeId, method, openMethod: openShift.method });
      return sendError(
        res,
        409,
        'METHOD_MISMATCH',
        'Verification method must match the clock-in method.'
      );
    }

    if (method === 'face') {
      if (!image || !descriptor) {
        return sendError(
          res,
          400,
          'FACE_DATA_REQUIRED',
          'Face image and descriptor are required.'
        );
      }
      const parsedDescriptor = parseDescriptor(descriptor);
      await verifyFace(employeeId, parsedDescriptor);
      logInfo('Face verified for clock-out', { employeeId });
    } else if (method === 'fingerprint') {
      if (!webauthnResponse) {
        return sendError(res, 400, 'FINGERPRINT_REQUIRED', 'Fingerprint verification is required.');
      }
      await verifyFingerprint(employeeId, webauthnResponse);
      logInfo('Fingerprint verified for clock-out', { employeeId });
    } else {
      return sendError(res, 400, 'INVALID_METHOD', 'Unsupported verification method.');
    }

    let photo = null;
    if (method === 'face') {
      photo = await uploadImage(image, `clockout-${employeeId}`);
    }

    const shift = await closeShift({
      shiftId: openShift.id,
      clockOutPhotoUrl: photo?.url || null,
      clockOutPhotoPublicId: photo?.publicId || null,
    });

    const clockIn = new Date(openShift.clock_in);
    const clockOut = new Date(shift.clock_out);
    const hoursWorked = ((clockOut - clockIn) / 3600000).toFixed(2);

    logInfo('Clock-out recorded', { employeeId, shiftId: shift.id, method, hoursWorked });
    return res.json({
      message: 'Clock-out successful.',
      timestamp: shift.clock_out,
      hoursWorked,
    });
    return res.json({
      message: 'Clock-out successful.',
      timestamp: shift.clock_out,
      hoursWorked,
    });
  } catch (error) {
    logError('Clock-out failed', { employeeId, method, code: error.code, error: error.message });
    return sendError(res, 400, error.code || 'CLOCK_OUT_ERROR', error.message);
  }
});

// Admin Routes

app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return sendError(res, 400, 'INVALID_REQUEST', 'Username and password are required.');
  }

  try {
    const admin = await getAdmin(username);
    if (!admin) {
      logWarn('Admin login failed: user not found', { username });
      return sendError(res, 401, 'AUTH_FAILED', 'Invalid credentials.');
    }

    const match = await bcrypt.compare(password, admin.password_hash);
    if (!match) {
      logWarn('Admin login failed: password mismatch', { username });
      return sendError(res, 401, 'AUTH_FAILED', 'Invalid credentials.');
    }

    // In a real app, sign a token here. For now, sending success.
    // The instructions say "activities... will have to make an api call that is authenticated but we will add the authentition later"
    // So we just return success for now.
    logInfo('Admin login successful', { username: admin.username });
    return res.json({ message: 'Login successful', username: admin.username });
  } catch (error) {
    logError('Admin login error', { username, error: error.message });
    return sendError(res, 500, 'LOGIN_ERROR', 'Internal server error.');
  }
});

app.post('/api/admin/register', async (req, res) => {
  // This should be protected, but for initial setup allowing it.
  // Or checking if any admins exist? For now, open.
  const { username, password } = req.body;
  if (!username || !password) {
    return sendError(res, 400, 'INVALID_REQUEST', 'Username and password are required.');
  }

  try {
    const hash = await bcrypt.hash(password, 10);
    await createAdmin({ username, passwordHash: hash });
    logInfo('Admin created', { username });
    return res.json({ message: 'Admin created.' });
  } catch (error) {
    logError('Admin register error full object', error);
    logError('Admin register error', { username, error: error.message, stack: error.stack, code: error.code });
    if (error.code === '23505') { // Unique violation
      return sendError(res, 409, 'USERNAME_TAKEN', 'Username already exists.');
    }
    return sendError(res, 500, 'REGISTER_ERROR', `Unable to create admin. ${error.message || 'Unknown error'}`);
  }
});

app.get('/api/admin/employees', async (req, res) => {
  try {
    const employees = await getAllEmployees();
    logInfo('Employees fetched', { count: employees.length });
    res.json(employees);
  } catch (error) {
    logError('Fetch employees failed', { error: error.message });
    sendError(res, 500, 'FETCH_ERROR', 'Unable to fetch employees.');
  }
});

app.post('/api/admin/employees', async (req, res) => {
  const { employeeId, firstName, lastName, photoUrl, photoPublicId } = req.body;
  if (!employeeId || !firstName || !lastName) {
    return sendError(res, 400, 'INVALID_REQUEST', 'Missing required fields.');
  }

  try {
    const safePhotoUrl = photoUrl ?? null;
    const safePhotoPublicId = photoPublicId ?? null;
    logInfo('Create employee request', {
      employeeId,
      firstName,
      lastName,
      photoUrlLength: typeof safePhotoUrl === 'string' ? safePhotoUrl.length : 0,
      photoPublicId: safePhotoPublicId,
    });
    const employee = await createEmployee({
      employeeId,
      firstName,
      lastName,
      photoUrl: safePhotoUrl,
      photoPublicId: safePhotoPublicId,
    });
    logInfo('Employee created/updated', { employeeId, firstName, lastName });
    res.json(employee);
  } catch (error) {
    logError('Create employee failed', { employeeId, error, errorType: typeof error });
    sendError(res, 500, 'CREATE_ERROR', 'Unable to create employee.');
  }
});

app.delete('/api/admin/employees/:id', async (req, res) => {
  try {
    await deleteEmployee(req.params.id);
    logInfo('Employee deleted', { employeeId: req.params.id });
    res.json({ message: 'Employee deleted.' });
  } catch (error) {
    logError('Delete employee failed', { employeeId: req.params.id, error: error.message });
    sendError(res, 500, 'DELETE_ERROR', 'Unable to delete employee.');
  }
});

app.get('/api/admin/attendance', async (req, res) => {
  const { date } = req.query;
  try {
    const attendance = await getDailyAttendance(date);
    logInfo('Attendance fetched', { date: date || 'today', count: attendance.length });
    res.json(attendance);
  } catch (error) {
    logError('Fetch attendance failed', { date: date || 'today', error: error.message });
    sendError(res, 500, 'FETCH_ERROR', 'Unable to fetch attendance.');
  }
});

app.get('/api/admin/stats', async (req, res) => {
  const { timeFrame } = req.query; // 'day', 'week', 'month', 'all'
  try {
    const stats = await getStats(timeFrame || 'week');
    logInfo('Stats fetched', { timeFrame: timeFrame || 'week', count: stats.length });
    res.json(stats);
  } catch (error) {
    logError('Fetch stats failed', { timeFrame: timeFrame || 'week', error: error.message });
    sendError(res, 500, 'FETCH_ERROR', 'Unable to fetch stats.');
  }
});

app.get('/*path', (req, res) => {
  res.sendFile(path.join(rootDir, 'index.html'));
});

async function start() {
  try {
    await initDb();
    const server = app.listen(PORT);
    server.on('listening', () => {
      logInfo(`Server running on port ${PORT}`);
    });
    server.on('error', (err) => {
      if (err && err.code === 'EADDRINUSE') {
        logError(`Failed to start: port ${PORT} is already in use.`);
      } else {
        logError('Failed to start server', err);
      }
      process.exit(1);
    });
  } catch (error) {
    logError('Failed to start server', error);
    process.exit(1);
  }
}

process.on('uncaughtException', (err) => {
  logError('UNCAUGHT EXCEPTION', err);
});

process.on('unhandledRejection', (reason, promise) => {
  logError('UNHANDLED REJECTION', reason);
});

start();

app.use((err, req, res, next) => {
  logError('Unhandled Express error', { url: req.originalUrl, error: err.message });
  res.status(500).json({ code: 'SERVER_ERROR', message: 'Internal server error.' });
});
