const API_BASE = 'https://shift-clocking-system.onrender.com';

const LOG_PREFIX = '[admin-frontend]';
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

let requestCounter = 0;
const ADMIN_SESSION_KEY = 'shiftclock_admin_session';

function sanitizePayload(payload) {
    if (!payload || typeof payload !== 'object') return payload;
    const clone = Array.isArray(payload) ? payload.slice() : { ...payload };
    if (clone.password) clone.password = '[redacted]';
    if (clone.photoUrl) clone.photoUrl = '[image data]';
    if (clone.image) clone.image = '[image data]';
    if (clone.descriptor) clone.descriptor = '[descriptor]';
    return clone;
}

function safeParseBody(body) {
    if (!body) return null;
    if (typeof body !== 'string') return body;
    try {
        return JSON.parse(body);
    } catch {
        return { raw: String(body).slice(0, 200) };
    }
}

window.addEventListener('error', (event) => {
    logError('Window error', { message: event.message, filename: event.filename, line: event.lineno });
});

window.addEventListener('unhandledrejection', (event) => {
    logError('Unhandled promise rejection', { reason: event.reason });
});

async function ensureAdminFaceModelsLoaded() {
    if (adminFaceModelsLoaded) return;
    if (adminFaceModelsLoading) {
        await adminFaceModelsLoading;
        return;
    }
    if (!window.faceapi) {
        throw new Error('Face recognition library failed to load.');
    }
    adminFaceHint.textContent = 'Loading lightweight face recognition models...';
    logInfo('Loading admin face models');
    adminFaceModelsLoading = Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(FACE_MODEL_URL),
        faceapi.nets.faceLandmark68TinyNet.loadFromUri(FACE_MODEL_URL),
        faceapi.nets.faceRecognitionNet.loadFromUri(FACE_MODEL_URL),
    ])
        .then(() => {
            adminFaceModelsLoaded = true;
            adminFaceHint.textContent = 'Models loaded. Capture or upload a clear photo.';
            logInfo('Admin face models loaded');
        })
        .catch((error) => {
            adminFaceModelsLoaded = false;
            adminFaceModelsLoading = null;
            logError('Admin face models failed to load', { error: error.message });
            throw error;
        });

    await adminFaceModelsLoading;
    adminFaceModelsLoading = null;
}

async function getAdminFaceDescriptor(imageDataUrl) {
    await ensureAdminFaceModelsLoaded();
    const img = await faceapi.fetchImage(imageDataUrl);
    const detectorOptions = new faceapi.TinyFaceDetectorOptions({
        inputSize: 224,
        scoreThreshold: 0.5,
    });
    const result = await faceapi
        .detectSingleFace(img, detectorOptions)
        .withFaceLandmarks(true)
        .withFaceDescriptor();
    if (!result) {
        throw new Error('No face detected in the photo. Please try again.');
    }
    return Array.from(result.descriptor);
}

function setAdminFaceImage(dataUrl, sourceLabel) {
    newEmployeeFaceImage = dataUrl;
    adminFaceHint.textContent = sourceLabel
        ? `Photo ready from ${sourceLabel}.`
        : 'Photo captured. Ready for enrollment.';
    adminFaceHint.style.color = 'var(--primary)';
}

function saveAdminSession(username) {
    try {
        const payload = { username, savedAt: new Date().toISOString() };
        localStorage.setItem(ADMIN_SESSION_KEY, JSON.stringify(payload));
    } catch (error) {
        logWarn('Failed to save admin session', { error: error.message });
    }
}

function loadAdminSession() {
    try {
        const raw = localStorage.getItem(ADMIN_SESSION_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || !parsed.username) return null;
        return parsed;
    } catch (error) {
        logWarn('Failed to load admin session', { error: error.message });
        return null;
    }
}

function clearAdminSession() {
    try {
        localStorage.removeItem(ADMIN_SESSION_KEY);
    } catch (error) {
        logWarn('Failed to clear admin session', { error: error.message });
    }
}

const adminState = {
    token: null,
    username: null,
    activeTab: 'employees',
};

// Admin Dom Elements
const adminLoginCard = document.getElementById('adminLoginCard');
const adminDashboard = document.getElementById('adminDashboard');
const adminUsernameInput = document.getElementById('adminUsername');
const adminPasswordInput = document.getElementById('adminPassword');
const adminLoginBtn = document.getElementById('adminLoginBtn');
const adminLoginError = document.getElementById('adminLoginError');
const adminLoginErrorText = document.getElementById('adminLoginErrorText');
const adminLogoutBtn = document.getElementById('adminLogoutBtn');

const adminTabs = document.querySelectorAll('.admin-tab');
const tabContents = document.querySelectorAll('.tab-content');

// Employee Mgmt Elements
const employeeListBody = document.getElementById('employeeList');
const showAddEmployeeBtn = document.getElementById('showAddEmployeeBtn');
const addEmployeeForm = document.getElementById('addEmployeeForm');
const cancelAddEmployeeBtn = document.getElementById('cancelAddEmployeeBtn');
const saveEmployeeBtn = document.getElementById('saveEmployeeBtn');

const newEmployeeId = document.getElementById('newEmployeeId');
const newFirstName = document.getElementById('newFirstName');
const newLastName = document.getElementById('newLastName');

const adminCamera = document.getElementById('adminCamera');
const adminSnapshot = document.getElementById('adminSnapshot');
const startAdminCameraBtn = document.getElementById('startAdminCameraBtn');
const captureAdminFaceBtn = document.getElementById('captureAdminFaceBtn');
const uploadAdminPhotoBtn = document.getElementById('uploadAdminPhotoBtn');
const adminUploadPhoto = document.getElementById('adminUploadPhoto');
const adminFaceHint = document.getElementById('adminFaceHint');

let adminCameraStream = null;
let newEmployeeFaceImage = null;
let adminFaceModelsLoaded = false;
let adminFaceModelsLoading = null;
const FACE_MODEL_URL = `${API_BASE}/models`;
function isSecureCameraContext() {
    const host = window.location.hostname;
    const isLocal =
        host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
    return window.isSecureContext || isLocal;
}

function getMediaStream(constraints) {
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        return navigator.mediaDevices.getUserMedia(constraints);
    }
    const legacy =
        navigator.getUserMedia ||
        navigator.webkitGetUserMedia ||
        navigator.mozGetUserMedia;
    if (!legacy) {
        return Promise.reject(new Error('getUserMedia is not supported in this browser.'));
    }
    return new Promise((resolve, reject) => legacy.call(navigator, constraints, resolve, reject));
}

// Attendance Elements
const attendanceList = document.getElementById('attendanceList');
const attendanceDate = document.getElementById('attendanceDate');

// Stats Elements
const statsList = document.getElementById('statsList');
const statsTimeFrame = document.getElementById('statsTimeFrame');

// Admins Mgmt Elements
const newAdminUsername = document.getElementById('newAdminUsername');
const newAdminPassword = document.getElementById('newAdminPassword');
const createAdminBtn = document.getElementById('createAdminBtn');
const adminSuccessPanel = document.getElementById('adminSuccessPanel');
const adminSuccessText = document.getElementById('adminSuccessText');


// Utility Functions (duplicated from app.js for independence)
function setPanelActive(panel, active) {
    panel.classList.toggle('active', Boolean(active));
}

async function fetchJson(url, options = {}) {
    const method = options.method || 'GET';
    const requestId = ++requestCounter;
    const parsedBody = safeParseBody(options.body);
    logInfo(`REQ ${requestId} ${method} ${url}`, {
        body: sanitizePayload(parsedBody),
    });

    const response = await fetch(`${API_BASE}${url}`, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
    });

    const data = await response.json().catch(() => ({}));
    logInfo(`RES ${requestId} ${method} ${url} ${response.status}`, {
        ok: response.ok,
        code: data.code,
    });
    if (!response.ok) {
        const message = data.message || 'Request failed.';
        const error = new Error(message);
        error.code = data.code;
        logWarn(`REQ_FAIL ${requestId} ${method} ${url}`, {
            message,
            code: data.code,
            status: response.status,
        });
        throw error;
    }
    return data;
}

// Admin Auth

async function handleAdminLogin() {
    const username = adminUsernameInput.value.trim();
    const password = adminPasswordInput.value.trim();

    if (!username || !password) {
        adminLoginErrorText.textContent = 'Please enter username and password.';
        setPanelActive(adminLoginError, true);
        return;
    }

    try {
        logInfo('Admin login attempt', { username });
        const data = await fetchJson('/api/admin/login', {
            method: 'POST',
            body: JSON.stringify({ username, password }),
        });

        adminState.token = 'logged-in'; // In real app, store JWT
        adminState.username = data.username;

        adminLoginCard.hidden = true;
        adminDashboard.hidden = false;
        loadAdminTab(adminState.activeTab);
        saveAdminSession(data.username);

        // Clear inputs
        adminUsernameInput.value = '';
        adminPasswordInput.value = '';
        setPanelActive(adminLoginError, false);
        logInfo('Admin login success', { username: data.username });
    } catch (error) {
        logError('Admin login failed', { username, error: error.message });
        adminLoginErrorText.textContent = error.message;
        setPanelActive(adminLoginError, true);
    }
}

function handleAdminLogout() {
    adminState.token = null;
    adminState.username = null;
    adminLoginCard.hidden = false;
    adminDashboard.hidden = true;
    clearAdminSession();
    logInfo('Admin logout');
    if (adminCameraStream) {
        adminCameraStream.getTracks().forEach(t => t.stop());
        adminCameraStream = null;
    }
}

// Admin Navigation

function switchAdminTab(tabName) {
    adminState.activeTab = tabName;

    adminTabs.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tabName);
    });

    tabContents.forEach(content => {
        content.hidden = content.id !== `tab-${tabName}`;
    });

    loadAdminTab(tabName);
}

function loadAdminTab(tabName) {
    if (tabName === 'employees') fetchEmployees();
    if (tabName === 'attendance') {
        if (!attendanceDate.valueAsDate) attendanceDate.valueAsDate = new Date();
        fetchAttendance();
    }
    if (tabName === 'stats') fetchStats();
}

// Employee Management

async function fetchEmployees() {
    try {
        const employees = await fetchJson('/api/admin/employees');
        renderEmployees(employees);
        logInfo('Employees loaded', { count: employees.length });
    } catch (error) {
        logError('Failed to fetch employees', { error: error.message });
    }
}

function renderEmployees(employees) {
    employeeListBody.innerHTML = '';
    if (employees.length === 0) {
        employeeListBody.innerHTML = '<tr><td colspan="4" style="text-align:center; color:var(--text-muted)">No employees found.</td></tr>';
        return;
    }

    employees.forEach(emp => {
        const row = document.createElement('tr');
        row.innerHTML = `
      <td>
        ${emp.photo_url
                ? `<img src="${emp.photo_url}" class="employee-row-photo" alt="Photo" />`
                : '<div class="employee-row-photo" style="display:grid;place-items:center"><span class="material-symbols-rounded" style="font-size:20px;color:gray">person</span></div>'}
      </td>
      <td>
         <div style="font-weight:600">${emp.first_name || ''} ${emp.last_name || ''}</div>
      </td>
      <td>${emp.employee_id}</td>
      <td>
        <button class="action-btn-icon delete-employee-btn" data-id="${emp.employee_id}" title="Delete">
          <span class="material-symbols-rounded">delete</span>
        </button>
      </td>
    `;
        employeeListBody.appendChild(row);
    });

    document.querySelectorAll('.delete-employee-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            if (confirm('Are you sure you want to delete this employee?')) {
                deleteEmployee(btn.dataset.id);
            }
        });
    });
}

async function deleteEmployee(id) {
    try {
        await fetchJson(`/api/admin/employees/${encodeURIComponent(id)}`, { method: 'DELETE' });
        fetchEmployees();
        logInfo('Employee deleted', { employeeId: id });
    } catch (err) {
        logError('Delete employee failed', { employeeId: id, error: err.message });
        alert(err.message);
    }
}

// Add Emloyee

async function startAdminCamera() {
    if (adminCameraStream) return;
    try {
        if (!isSecureCameraContext()) {
            throw new Error('Camera access requires HTTPS or localhost.');
        }
        await ensureAdminFaceModelsLoaded();
        logInfo('Starting admin camera');
        adminCameraStream = await getMediaStream({ video: true, audio: false });
        adminCamera.srcObject = adminCameraStream;
    } catch (err) {
        logError('Admin camera start failed', { error: err.message });
        alert('Camera access needed');
    }
}

function captureAdminFace() {
    if (!adminCameraStream) return;
    const ctx = adminSnapshot.getContext('2d');
    adminSnapshot.width = adminCamera.videoWidth;
    adminSnapshot.height = adminCamera.videoHeight;
    ctx.drawImage(adminCamera, 0, 0);
    const dataUrl = adminSnapshot.toDataURL('image/jpeg', 0.9);
    setAdminFaceImage(dataUrl, 'camera');
    logInfo('Admin captured employee photo');
}

function handleAdminPhotoUpload(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
        const dataUrl = reader.result;
        const img = new Image();
        img.onload = () => {
            const ctx = adminSnapshot.getContext('2d');
            adminSnapshot.width = img.width;
            adminSnapshot.height = img.height;
            ctx.drawImage(img, 0, 0);
            setAdminFaceImage(dataUrl, 'upload');
            logInfo('Admin uploaded employee photo', { size: file.size, type: file.type });
        };
        img.onerror = () => {
            logError('Failed to load uploaded photo');
            alert('Unable to read the uploaded photo.');
        };
        img.src = dataUrl;
    };
    reader.onerror = () => {
        logError('Photo upload failed');
        alert('Unable to read the uploaded file.');
    };
    reader.readAsDataURL(file);
}

// Method Toggling
// Method Toggling
document.addEventListener('DOMContentLoaded', () => {
    const faceEnrollSection = document.getElementById('faceEnrollSection');
    const fingerprintEnrollSection = document.getElementById('fingerprintEnrollSection');
    const authMethodRadios = document.querySelectorAll('input[name="authMethod"]');

    if (authMethodRadios.length > 0) {
        authMethodRadios.forEach(radio => {
            radio.addEventListener('change', (e) => {
                const method = e.target.value;
                if (faceEnrollSection) faceEnrollSection.hidden = method !== 'face';
                if (fingerprintEnrollSection) fingerprintEnrollSection.hidden = method !== 'fingerprint';

                if (method === 'face') {
                    ensureAdminFaceModelsLoaded().catch(console.error);
                } else {
                    if (adminCameraStream) {
                        adminCameraStream.getTracks().forEach(t => t.stop());
                        adminCameraStream = null;
                    }
                }
            });
        });

        // Initialize UI state based on checked radio
        const checkedRadio = document.querySelector('input[name="authMethod"]:checked');
        if (checkedRadio) {
            checkedRadio.dispatchEvent(new Event('change'));
        } else {
            authMethodRadios[0].checked = true;
            authMethodRadios[0].dispatchEvent(new Event('change'));
        }
    }
});

async function registerFingerprint(employeeId) {
    const statusEl = document.getElementById('fingerprintStatus');
    const hintEl = document.getElementById('fingerprintHint');
    const fpIcon = document.getElementById('fpIconContainer');
    const fpLoader = document.getElementById('fpLoader');
    const fpSuccess = document.getElementById('fpSuccess');

    // Reset UI
    fpIcon.hidden = true;
    fpLoader.hidden = false;
    fpSuccess.hidden = true;

    statusEl.textContent = 'Preparing fingerprint scan...';
    if (hintEl) hintEl.textContent = 'Communicating with database...';

    try {
        // 1. Get Options
        const { options } = await fetchJson('/api/webauthn/register/options', {
            method: 'POST',
            body: JSON.stringify({ employeeId })
        });

        statusEl.textContent = 'Scan your finger now...';
        if (hintEl) hintEl.textContent = 'Follow the browser prompt to scan.';

        // 2. Start Registration (Browser Prompt)
        const attestation = await SimpleWebAuthnBrowser.startRegistration(options);

        statusEl.textContent = 'Verifying scan...';
        if (hintEl) hintEl.textContent = 'Checking biometric data...';

        // 3. Verify
        await fetchJson('/api/webauthn/register/verify', {
            method: 'POST',
            body: JSON.stringify({ employeeId, attestation })
        });

        // Success State
        fpLoader.hidden = true;
        fpSuccess.hidden = false;
        statusEl.textContent = 'Fingerprint enrolled!';
        if (hintEl) hintEl.textContent = 'Employee created successfully.';
        statusEl.style.color = '#10b981';

        return true;
    } catch (error) {
        logError('Fingerprint registration failed', { error: error.message });

        // Error State (Revert to icon or show error)
        fpLoader.hidden = true;
        fpIcon.hidden = false;
        statusEl.textContent = 'Scan failed';
        statusEl.style.color = '#ef4444';
        if (hintEl) hintEl.textContent = error.message;
        throw error;
    }
}

async function handleSaveEmployee() {
    const id = newEmployeeId.value.trim();
    const first = newFirstName.value.trim();
    const last = newLastName.value.trim();
    const method = document.querySelector('input[name="authMethod"]:checked').value;

    if (!id || !first || !last) {
        alert('Please fill all fields');
        return;
    }

    if (method === 'face' && !newEmployeeFaceImage) {
        alert('Please capture or upload a photo for Face ID.');
        return;
    }

    try {
        logInfo('Creating employee record', { employeeId: id, firstName: first, lastName: last });

        // 1. Create Base Employee Record
        await fetchJson('/api/admin/employees', {
            method: 'POST',
            body: JSON.stringify({
                employeeId: id,
                firstName: first,
                lastName: last,
                photoUrl: newEmployeeFaceImage || null
            })
        });

        // 2. Enroll Auth Method
        if (method === 'face') {
            logInfo('Enrolling Face ID');
            const descriptor = await getAdminFaceDescriptor(newEmployeeFaceImage);
            await fetchJson('/api/face/enroll', {
                method: 'POST',
                body: JSON.stringify({
                    employeeId: id,
                    image: newEmployeeFaceImage,
                    descriptor,
                }),
            });
        } else if (method === 'fingerprint') {
            logInfo('Starting Fingerprint Enrollment');
            await registerFingerprint(id);
        }

        // Reset
        setTimeout(() => {
            newEmployeeId.value = '';
            newFirstName.value = '';
            newLastName.value = '';
            newEmployeeFaceImage = null;
            adminUploadPhoto.value = '';
            addEmployeeForm.hidden = true;
            document.getElementById('fingerprintStatus').textContent = '';

            // Reset to default Face view
            const authMethodRadios = document.querySelectorAll('input[name="authMethod"]');
            if (authMethodRadios.length > 0) {
                authMethodRadios[0].checked = true;
                authMethodRadios[0].dispatchEvent(new Event('change'));
            }

            if (adminCameraStream) {
                adminCameraStream.getTracks().forEach(t => t.stop());
                adminCameraStream = null;
            }
            fetchEmployees();
            adminFaceHint.textContent = 'Capture a clear photo for profile & verification.';
            adminFaceHint.style.color = '';
            alert(`Employee ${first} created and enrolled via ${method === 'face' ? 'Face ID' : 'Fingerprint'}.`);
        }, 1000); // Small delay to let user see success message if fingerprint

    } catch (err) {
        logError('Create employee failed', { employeeId: id, error: err.message });
        alert(err.message);
    }
}

// Attendance

async function fetchAttendance() {
    const date = attendanceDate.value;
    try {
        const data = await fetchJson(`/api/admin/attendance?date=${date}`);
        renderAttendance(data);
        logInfo('Attendance loaded', { date, count: data.length });
    } catch (err) {
        logError('Fetch attendance failed', { date, error: err.message });
    }
}

function renderAttendance(data) {
    attendanceList.innerHTML = '';
    if (!data.length) {
        attendanceList.innerHTML = '<tr><td colspan="5" style="text-align:center">No attendance records.</td></tr>';
        return;
    }
    data.forEach(row => {
        const cinStr = (row.clock_in && !row.clock_in.endsWith('Z') && !row.clock_in.includes('+')) ? row.clock_in + 'Z' : row.clock_in;
        const cinDate = new Date(cinStr);
        const cin = cinDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        let cout = '--';
        let hours = 'Active';

        if (row.clock_out) {
            const coutStr = (row.clock_out && !row.clock_out.endsWith('Z') && !row.clock_out.includes('+')) ? row.clock_out + 'Z' : row.clock_out;
            const coutDate = new Date(coutStr);
            cout = coutDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

            const cinTime = cinDate.getTime();
            const coutTime = coutDate.getTime();
            hours = ((coutTime - cinTime) / 3600000).toFixed(2) + ' hrs';
        }

        const tr = document.createElement('tr');
        tr.innerHTML = `
           <td>${row.first_name || ''} ${row.last_name || ''} <span style="font-size:0.8em;color:gray">(${row.employee_id})</span></td>
           <td>${cin}</td>
           <td>${cout}</td>
           <td>${row.method}</td>
           <td>${hours}</td>
        `;
        attendanceList.appendChild(tr);
    });
}

// Stats

async function fetchStats() {
    const frame = statsTimeFrame.value;
    try {
        const data = await fetchJson(`/api/admin/stats?timeFrame=${frame}`);
        renderStats(data);
        logInfo('Stats loaded', { timeFrame: frame, count: data.length });
    } catch (err) {
        logError('Fetch stats failed', { timeFrame: frame, error: err.message });
    }
}

function renderStats(data) {
    statsList.innerHTML = '';
    if (!data.length) {
        statsList.innerHTML = '<tr><td colspan="3" style="text-align:center">No stats data.</td></tr>';
        return;
    }
    data.forEach(row => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
           <td>${row.first_name || ''} ${row.last_name || ''}</td>
           <td>${row.shifts_count}</td>
           <td>${parseFloat(row.total_hours).toFixed(2)} hrs</td>
        `;
        statsList.appendChild(tr);
    });
}

// Create Admin

async function handleCreateAdmin() {
    const u = newAdminUsername.value.trim();
    const p = newAdminPassword.value.trim();
    if (!u || !p) return;

    try {
        logInfo('Creating admin', { username: u });
        await fetchJson('/api/admin/register', {
            method: 'POST',
            body: JSON.stringify({ username: u, password: p })
        });
        adminSuccessText.textContent = 'Admin created successfully.';
        setPanelActive(adminSuccessPanel, true);
        newAdminUsername.value = '';
        newAdminPassword.value = '';
        setTimeout(() => setPanelActive(adminSuccessPanel, false), 3000);
        logInfo('Admin created', { username: u });
    } catch (err) {
        logError('Create admin failed', { username: u, error: err.message });
        alert(err.message);
    }
}

// Event Listeners for Admin

adminLoginBtn.addEventListener('click', handleAdminLogin);
adminLogoutBtn.addEventListener('click', handleAdminLogout);

adminTabs.forEach(btn => {
    btn.addEventListener('click', () => switchAdminTab(btn.dataset.tab));
});

showAddEmployeeBtn.addEventListener('click', () => {
    addEmployeeForm.hidden = false;
    ensureAdminFaceModelsLoaded().catch((error) => {
        alert(error.message || 'Face models failed to load.');
    });
});

cancelAddEmployeeBtn.addEventListener('click', () => {
    addEmployeeForm.hidden = true;
    newEmployeeFaceImage = null;
    adminUploadPhoto.value = '';
    adminFaceHint.textContent = 'Capture a clear photo for profile & verification.';
    adminFaceHint.style.color = '';
    if (adminCameraStream) {
        adminCameraStream.getTracks().forEach(t => t.stop());
        adminCameraStream = null;
    }
});

startAdminCameraBtn.addEventListener('click', startAdminCamera);
captureAdminFaceBtn.addEventListener('click', captureAdminFace);
uploadAdminPhotoBtn.addEventListener('click', () => adminUploadPhoto.click());
adminUploadPhoto.addEventListener('change', handleAdminPhotoUpload);
saveEmployeeBtn.addEventListener('click', handleSaveEmployee);

attendanceDate.addEventListener('change', fetchAttendance);
statsTimeFrame.addEventListener('change', fetchStats);
createAdminBtn.addEventListener('click', handleCreateAdmin);

// Restore session if available
const savedSession = loadAdminSession();
if (savedSession && savedSession.username) {
    adminState.token = 'restored';
    adminState.username = savedSession.username;
    adminLoginCard.hidden = true;
    adminDashboard.hidden = false;
    loadAdminTab(adminState.activeTab);
    logInfo('Admin session restored', { username: savedSession.username });
}

// Server Wakeup Logic
async function waitForServer() {
    const loader = document.getElementById('server-loader');
    if (!loader) return;

    const maxRetries = 60; // 1 minute roughly
    let retries = 0;

    const checkHealth = async () => {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 2000);

            const res = await fetch(`${API_BASE}/api/health`, {
                method: 'GET',
                signal: controller.signal
            });
            clearTimeout(timeoutId);

            if (res.ok) {
                logInfo('Server is ready');
                loader.classList.add('hidden');
                setTimeout(() => loader.remove(), 600); // Remove from DOM after fade out
                return true;
            }
        } catch (e) {
            // ignore
        }
        return false;
    };

    // Immediate check
    if (await checkHealth()) return;

    // Poll
    const interval = setInterval(async () => {
        retries++;
        const ready = await checkHealth();
        if (ready || retries > maxRetries) {
            clearInterval(interval);
            if (!ready) {
                logError('Server wakeup timeout');
                // Optional: show error message in loader
                loader.innerHTML = `
            <div style="text-align:center; color: var(--accent)">
              <h2>Server Timeout</h2>
              <p>Please refresh the page to try again.</p>
            </div>
          `;
            }
        }
    }, 1000);
}

document.addEventListener('DOMContentLoaded', waitForServer);
