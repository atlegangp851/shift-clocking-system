const API_BASE = 'http://localhost:3000';

const LOG_PREFIX = '[frontend]';
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

function sanitizePayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const clone = Array.isArray(payload) ? payload.slice() : { ...payload };
  if (clone.password) clone.password = '[redacted]';
  if (clone.image) clone.image = '[image data]';
  if (clone.descriptor) clone.descriptor = '[descriptor]';
  if (clone.webauthn) clone.webauthn = '[webauthn assertion]';
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

const state = {
  employeeId: '',
  status: null,
  method: null,
  methodLocked: null,
  clockInAt: null,
  timerInterval: null,
  faceImage: null,
  faceDescriptor: null,
  faceVerified: false,
};

const navButtons = document.querySelectorAll('.nav-btn');
const views = {
  clock: document.getElementById('clock-view'),
  admin: document.getElementById('admin-view'),
};

const employeeIdInput = document.getElementById('employeeId');
const checkStatusButton = document.getElementById('checkStatus');
const statusChip = document.getElementById('statusChip');
const statusPanel = document.getElementById('statusPanel');
const statusText = document.getElementById('statusText');
const methodLock = document.getElementById('methodLock');
const methodPanel = document.getElementById('methodPanel');
const methodCards = document.querySelectorAll('.method-card');
const facePanel = document.getElementById('facePanel');
const fingerprintPanel = document.getElementById('fingerprintPanel');
const actionPanel = document.getElementById('actionPanel');
const actionButton = document.getElementById('actionButton');
const actionHint = document.getElementById('actionHint');
const resultPanel = document.getElementById('resultPanel');
const resultTitle = document.getElementById('resultTitle');
const resultText = document.getElementById('resultText');
const resultTime = document.getElementById('resultTime');
const resultDate = document.getElementById('resultDate');
const resultHours = document.getElementById('resultHours');
const closeResultButton = document.getElementById('closeResult');
const errorPanel = document.getElementById('errorPanel');
const errorText = document.getElementById('errorText');

const sessionStatus = document.getElementById('sessionStatus');
const sessionClockIn = document.getElementById('sessionClockIn');
const timerValue = document.getElementById('timerValue');
const timerSub = document.getElementById('timerSub');

const camera = document.getElementById('camera');
const snapshot = document.getElementById('snapshot');
const startCameraButton = document.getElementById('startCamera');
const captureFaceButton = document.getElementById('captureFace');
const enrollFaceButton = document.getElementById('enrollFace');
const faceHint = document.getElementById('faceHint');
const cameraLoader = document.getElementById('cameraLoader');
const cameraLoaderText = document.getElementById('cameraLoaderText');

const fingerprintText = document.getElementById('fingerprintText');
const enrollFingerprintButton = document.getElementById('enrollFingerprint');
const scanFingerprintButton = document.getElementById('scanFingerprint');

let cameraStream = null;
let faceModelsLoaded = false;
let faceModelsLoading = null;
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

function setView(view) {
  Object.keys(views).forEach((key) => {
    views[key].hidden = key !== view;
  });
  navButtons.forEach((button) => {
    button.classList.toggle('active', button.dataset.view === view);
  });
}

navButtons.forEach((button) => {
  button.addEventListener('click', () => setView(button.dataset.view));
});

function setPanelActive(panel, active) {
  panel.classList.toggle('active', Boolean(active));
}

function setCameraLoader(active, message) {
  if (!cameraLoader) return;
  cameraLoader.hidden = !active;

  if (active) {
    // Check if we need to restore the spinner structure (e.g. if it was replaced by success message)
    if (!cameraLoader.querySelector('.spinner')) {
      cameraLoader.innerHTML = '<div class="spinner"></div><div class="camera-overlay-text" id="cameraLoaderText"></div>';
    }

    const textEl = cameraLoader.querySelector('.camera-overlay-text');
    if (textEl && message) {
      textEl.textContent = message;
    }
  }
}

function stopCameraStream() {
  if (cameraStream) {
    cameraStream.getTracks().forEach((track) => track.stop());
    cameraStream = null;
  }
}

function showLivePreview() {
  camera.style.display = 'block';
  snapshot.style.display = 'none';
}

function showSnapshotPreview() {
  camera.style.display = 'none';
  snapshot.style.display = 'block';
}

function showError(message) {
  logWarn('UI error shown', { message });
  errorText.textContent = message;
  setPanelActive(errorPanel, true);
}

function clearError() {
  setPanelActive(errorPanel, false);
  errorText.textContent = '';
}

function showResult({ title, message, time, date, hours }) {
  resultTitle.textContent = title;
  resultText.textContent = message;
  resultTime.textContent = time || '--';
  resultDate.textContent = date || '--';
  resultHours.textContent = hours || '--';
  setPanelActive(resultPanel, true);
}

function hideResult() {
  setPanelActive(resultPanel, false);
}

function updateStatusChip(text) {
  statusChip.textContent = text;
}

function setFaceVerificationStatus(verified, message, tone = 'neutral') {
  state.faceVerified = Boolean(verified);
  if (message) {
    faceHint.textContent = message;
  }
  if (tone === 'success') {
    faceHint.style.color = 'var(--primary)';
  } else if (tone === 'error') {
    faceHint.style.color = 'var(--accent)';
  } else {
    faceHint.style.color = '';
  }
}

function formatDateTime(isoString) {
  if (!isoString) return { time: '--', date: '--' };
  // Legacy fix: SQLite datetime('now') returns UTC without Z. Treat as UTC.
  if (typeof isoString === 'string' && !isoString.endsWith('Z') && !isoString.includes('+')) {
    isoString += 'Z';
  }
  const date = new Date(isoString);
  return {
    time: date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    date: date.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' }),
  };
}

function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours.toString().padStart(2, '0')}:${minutes
    .toString()
    .padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

function startTimer(clockInAt) {
  stopTimer();
  let timeStr = clockInAt;
  if (typeof timeStr === 'string' && !timeStr.endsWith('Z') && !timeStr.includes('+')) {
    timeStr += 'Z';
  }
  const start = new Date(timeStr).getTime();
  state.timerInterval = setInterval(() => {
    const now = Date.now();
    const elapsed = now - start;
    timerValue.textContent = formatDuration(elapsed);
  }, 1000);
  timerSub.textContent = 'Shift in progress';
}

function stopTimer() {
  if (state.timerInterval) {
    clearInterval(state.timerInterval);
    state.timerInterval = null;
  }
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

async function checkStatus() {
  clearError();
  hideResult();

  const employeeId = employeeIdInput.value.trim();
  if (!employeeId) {
    showError('Enter an employee ID to continue.');
    return;
  }

  state.employeeId = employeeId;
  state.faceVerified = false;
  updateStatusChip('Checking');
  logInfo('Checking status', { employeeId });

  try {
    const data = await fetchJson(`/api/status?employeeId=${encodeURIComponent(employeeId)}`);
    state.status = data.status;
    state.firstName = data.firstName;
    state.lastName = data.lastName;
    state.clockInAt = data.clockInAt;
    state.methodLocked = data.method || null;
    state.method = data.method || null;
    updateUI();
  } catch (error) {
    logError('Status check failed', { employeeId, error: error.message });
    if (error.code === 'EMPLOYEE_NOT_FOUND') {
      state.employeeId = '';
      updateUI();
      showError(error.message);
    } else {
      showError(error.message);
    }
  }
}

const sessionCard = document.getElementById('sessionCard');

const employeeName = document.getElementById('employeeName');

function updateUI() {
  setPanelActive(statusPanel, Boolean(state.employeeId));
  if (state.employeeId && state.firstName && employeeName) {
    employeeName.textContent = `${state.firstName} ${state.lastName}`;
    employeeName.hidden = false;
  } else if (employeeName) {
    employeeName.textContent = '';
    employeeName.hidden = true;
  }
  setPanelActive(methodPanel, Boolean(state.employeeId));
  setPanelActive(actionPanel, Boolean(state.employeeId));

  if (sessionCard) {
    sessionCard.style.display = (state.employeeId && state.status === 'clocked_in') ? 'block' : 'none';
  }

  if (!state.employeeId) {
    updateStatusChip('Awaiting ID');
    statusText.textContent = 'Waiting for employee ID.';
    methodLock.textContent = '';
    setPanelActive(facePanel, false);
    setPanelActive(fingerprintPanel, false);
    setActionButton('Clock In');
    stopTimer();
    return;
  }

  if (state.status === 'clocked_in') {
    updateStatusChip('Clocked In');
    statusText.textContent = 'Active shift detected. Clock out to complete the session.';
    methodLock.textContent = `Method locked to ${state.methodLocked}`;
    setActionButton('Clock Out');
    actionHint.textContent = 'Use the same verification method used at clock-in.';
    sessionStatus.textContent = 'Clocked In';
    if (state.clockInAt) {
      const { time, date } = formatDateTime(state.clockInAt);
      sessionClockIn.textContent = `${time} on ${date}`;
      startTimer(state.clockInAt);
    }
  } else {
    updateStatusChip('Ready');
    statusText.textContent = 'No active shift. Choose a verification method to clock in.';
    methodLock.textContent = '';
    setActionButton('Clock In');
    actionHint.textContent = 'Choose a verification method for your clock-in.';
    sessionStatus.textContent = 'Idle';
    sessionClockIn.textContent = '--';
    timerValue.textContent = '00:00:00';
    timerSub.textContent = 'Awaiting clock in';
    stopTimer();
  }

  methodCards.forEach((card) => {
    const method = card.dataset.method;
    card.classList.toggle('active', state.method === method);
    if (state.methodLocked) {
      card.disabled = method !== state.methodLocked;
    } else {
      card.disabled = false;
    }
  });

  setPanelActive(facePanel, state.method === 'face');
  setPanelActive(fingerprintPanel, state.method === 'fingerprint');
  const needsFaceVerification = state.method === 'face';
  if (needsFaceVerification) {
    actionHint.textContent = state.faceVerified
      ? 'Face verified. You can clock in/out.'
      : 'Capture your face to verify before clocking in/out.';
  }
  actionButton.disabled = !state.method || (needsFaceVerification && !state.faceVerified);
}

function setActionButton(label) {
  actionButton.innerHTML = `<span class="material-symbols-rounded">${label === 'Clock Out' ? 'logout' : 'login'
    }</span>${label}`;
}

async function startCamera() {
  clearError();
  setCameraLoader(false);
  if (cameraStream) return;
  try {
    if (!isSecureCameraContext()) {
      throw new Error('Camera access requires HTTPS or localhost.');
    }
    state.faceVerified = false;
    logInfo('Starting camera');
    showLivePreview();
    cameraStream = await getMediaStream({
      video: { facingMode: 'user' },
      audio: false,
    });
    camera.srcObject = cameraStream;
    faceHint.textContent = 'Camera is active. Capture a clear image.';
  } catch (error) {
    logError('Camera start failed', { error: error.message });
    showError('Camera access is required for face verification.');
  }
}

function captureFace() {
  if (!cameraStream) {
    showError('Start the camera before capturing a face scan.');
    return null;
  }
  const context = snapshot.getContext('2d');
  snapshot.width = camera.videoWidth || 640;
  snapshot.height = camera.videoHeight || 480;
  context.drawImage(camera, 0, 0, snapshot.width, snapshot.height);
  const dataUrl = snapshot.toDataURL('image/jpeg', 0.92);
  state.faceImage = dataUrl;
  state.faceDescriptor = null;
  setFaceVerificationStatus(false, 'Capture stored. Verifying is required before clocking in/out.', 'neutral');
  logInfo('Face captured');
  return dataUrl;
}

async function handleCaptureAndVerify() {
  clearError();
  if (!state.employeeId) {
    showError('Enter an employee ID before capturing.');
    return;
  }
  if (!cameraStream) {
    showError('Start the camera before capturing a face scan.');
    return;
  }

  const image = captureFace();
  if (!image) return;

  showSnapshotPreview();
  stopCameraStream();
  captureFaceButton.disabled = true;
  startCameraButton.disabled = true;

  // Show loader immediately
  setCameraLoader(true, 'Verifying...');

  // Force a repaint to ensure loader is visible before heavy processing
  await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 100)));

  let verified = false;
  try {
    verified = await verifyFaceForEmployee();
  } catch (error) {
    verified = false;
  } finally {
    // Do not hide loader immediately if verified, we want to show success
    if (!verified) {
      setCameraLoader(false);
      captureFaceButton.disabled = false;
      startCameraButton.disabled = false;
    }
  }

  updateUI();

  if (verified) {
    // Show success state in the camera overlay
    if (cameraLoader) {
      cameraLoader.hidden = false;
      cameraLoader.innerHTML = `
        <span class="material-symbols-rounded" style="font-size: 48px; color: #10b981; margin-bottom: 8px;">check_circle</span>
        <div class="camera-overlay-text">Verified</div>
      `;
    }

    // Keep 'Verified' message visible. 
    // The user can now click 'Clock In'. 
    // We don't re-enable capture buttons immediately to prevent confusion, 
    // or we can enabling them if they want to retry.
    // But since they are verified, re-capture is not needed unless they fail.
    captureFaceButton.disabled = false; // Allow re-capture if really needed? 
    startCameraButton.disabled = false;

    // We DON'T call showResult here anymore, as it block the flow.
    // The visual "Verified" overlay + enabled Clock In button is the feedback.
  } else {
    showError('Face not recognized. Please try again.');
  }
}

async function ensureFaceModelsLoaded() {
  if (faceModelsLoaded) return;
  if (faceModelsLoading) {
    await faceModelsLoading;
    return;
  }
  if (!window.faceapi) {
    throw new Error('Face recognition library failed to load.');
  }
  faceHint.textContent = 'Loading lightweight face recognition models.';
  logInfo('Loading face models');
  faceModelsLoading = Promise.all([
    faceapi.nets.tinyFaceDetector.loadFromUri(FACE_MODEL_URL),
    faceapi.nets.faceLandmark68TinyNet.loadFromUri(FACE_MODEL_URL),
    faceapi.nets.faceRecognitionNet.loadFromUri(FACE_MODEL_URL),
  ])
    .then(() => {
      faceModelsLoaded = true;
      faceHint.textContent = 'Face models loaded. Capture a clear image.';
      logInfo('Face models loaded');
    })
    .catch((error) => {
      faceModelsLoaded = false;
      faceModelsLoading = null;
      logError('Face models failed to load', { error: error.message });
      throw error;
    });

  await faceModelsLoading;
  faceModelsLoading = null;
}

async function getFaceDescriptor() {
  await ensureFaceModelsLoaded();
  const image = state.faceImage || captureFace();
  if (!image) return null;
  logInfo('Generating face descriptor');
  const img = await faceapi.fetchImage(image);
  const detectorOptions = new faceapi.TinyFaceDetectorOptions({
    inputSize: 224,
    scoreThreshold: 0.5,
  });
  const result = await faceapi
    .detectSingleFace(img, detectorOptions)
    .withFaceLandmarks(true)
    .withFaceDescriptor();
  if (!result) {
    throw new Error('No face detected. Please try again.');
  }
  const descriptor = Array.from(result.descriptor);
  state.faceDescriptor = descriptor;
  logInfo('Face descriptor generated');
  return descriptor;
}

async function verifyFaceForEmployee() {
  if (!state.employeeId) {
    showError('Enter an employee ID before verifying.');
    return false;
  }
  try {
    const descriptor = state.faceDescriptor || (await getFaceDescriptor());
    if (!descriptor) return false;
    const result = await fetchJson('/api/face/verify', {
      method: 'POST',
      body: JSON.stringify({ employeeId: state.employeeId, descriptor }),
    });
    setFaceVerificationStatus(true, 'Face verified. You can proceed to clock in/out.', 'success');
    logInfo('Face verification success', { employeeId: state.employeeId, distance: result.distance });
    return true;
  } catch (error) {
    setFaceVerificationStatus(false, 'Face not recognized. Please try again.', 'error');
    showError(error.message || 'Face verification failed.');
    logError('Face verification failed', { employeeId: state.employeeId, error: error.message });
    return false;
  }
}

async function handleFingerprintEnrollment() {
  clearError();
  if (!state.employeeId) {
    showError('Enter an employee ID before enrolling.');
    return;
  }
  if (!window.PublicKeyCredential) {
    showError('Fingerprint authentication is not supported in this browser.');
    return;
  }
  if (!window.SimpleWebAuthnBrowser) {
    showError('Fingerprint library failed to load.');
    return;
  }
  try {
    logInfo('Starting fingerprint enrollment', { employeeId: state.employeeId });
    const { options } = await fetchJson('/api/webauthn/register/options', {
      method: 'POST',
      body: JSON.stringify({ employeeId: state.employeeId }),
    });
    const attestation = await SimpleWebAuthnBrowser.startRegistration(options);
    await fetchJson('/api/webauthn/register/verify', {
      method: 'POST',
      body: JSON.stringify({ employeeId: state.employeeId, attestation }),
    });
    fingerprintText.textContent = 'Fingerprint enrolled. You can now scan to authenticate.';
    logInfo('Fingerprint enrollment complete', { employeeId: state.employeeId });
  } catch (error) {
    logError('Fingerprint enrollment failed', { employeeId: state.employeeId, error: error.message });
    showError(error.message || 'Fingerprint enrollment failed.');
  }
}

async function getFingerprintAssertion() {
  if (!window.PublicKeyCredential) {
    throw new Error('Fingerprint authentication is not supported in this browser.');
  }
  if (!window.SimpleWebAuthnBrowser) {
    throw new Error('Fingerprint library failed to load.');
  }
  const response = await fetchJson('/api/webauthn/authenticate/options', {
    method: 'POST',
    body: JSON.stringify({ employeeId: state.employeeId }),
  });

  if (response.needsEnrollment) {
    throw new Error('Fingerprint not enrolled for this employee.');
  }

  logInfo('Starting fingerprint authentication', { employeeId: state.employeeId });
  return SimpleWebAuthnBrowser.startAuthentication(response.options);
}

async function handleFingerprintScan() {
  clearError();
  if (!state.employeeId) {
    showError('Enter an employee ID before scanning.');
    return null;
  }
  try {
    const assertion = await getFingerprintAssertion();
    fingerprintText.textContent = 'Fingerprint verified. Proceed with clock action.';
    logInfo('Fingerprint verified', { employeeId: state.employeeId });
    return assertion;
  } catch (error) {
    logError('Fingerprint verification failed', { employeeId: state.employeeId, error: error.message });
    showError(error.message || 'Fingerprint verification failed.');
    return null;
  }
}

async function submitClockAction() {
  clearError();
  if (!state.employeeId) {
    showError('Enter an employee ID to continue.');
    return;
  }
  if (!state.method) {
    showError('Select a verification method.');
    return;
  }

  const action = state.status === 'clocked_in' ? 'clock-out' : 'clock-in';
  const methodUsed = state.method;
  logInfo('Submitting clock action', { employeeId: state.employeeId, action, method: methodUsed });

  try {
    let payload = {
      employeeId: state.employeeId,
      method: state.method,
    };

    if (state.method === 'face') {
      if (!state.faceVerified) {
        showError('Please capture and verify your face before clocking in/out.');
        return;
      }
      const image = state.faceImage || captureFace();
      if (!image) return;
      const descriptor = state.faceDescriptor || (await getFaceDescriptor());
      if (!descriptor) return;
      payload = { ...payload, image, descriptor };
    }

    if (state.method === 'fingerprint') {
      const assertion = await getFingerprintAssertion();
      payload = { ...payload, webauthn: assertion };
    }

    const result = await fetchJson(`/api/${action}`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    const { time, date } = formatDateTime(result.timestamp);
    showResult({
      title: action === 'clock-in' ? 'Clocked In' : 'Clocked Out',
      message: result.message,
      time,
      date,
      hours: result.hoursWorked || '00:00',
    });

    if (action === 'clock-in') {
      state.status = 'clocked_in';
      state.clockInAt = result.clockInAt;
      state.methodLocked = state.method;
      startTimer(state.clockInAt);
      logInfo('Clock-in success', { employeeId: state.employeeId, method: methodUsed });
    } else {
      state.status = 'not_clocked_in';
      state.clockInAt = null;
      state.methodLocked = null;
      state.method = null;
      stopTimer();
      logInfo('Clock-out success', { employeeId: state.employeeId, method: methodUsed });
    }

    state.faceImage = null;
    state.faceDescriptor = null;
    state.faceVerified = false;
    updateUI();
  } catch (error) {
    logError('Clock action failed', { employeeId: state.employeeId, action, error: error.message });
    showError(error.message);
  }
}

function handleMethodSelection(method) {
  if (state.methodLocked && method !== state.methodLocked) return;
  state.method = method;
  state.faceImage = null;
  state.faceDescriptor = null;
  state.faceVerified = false;
  showLivePreview();
  if (method !== 'face' && cameraStream) {
    stopCameraStream();
  }
  if (method === 'face') {
    ensureFaceModelsLoaded().catch((error) => showError(error.message));
  }
  updateUI();
}

async function handleFaceEnroll() {
  clearError();
  if (!state.employeeId) {
    showError('Enter an employee ID before enrolling a face template.');
    return;
  }
  const image = state.faceImage || captureFace();
  if (!image) return;

  try {
    const descriptor = state.faceDescriptor || (await getFaceDescriptor());
    if (!descriptor) return;
    logInfo('Submitting face enrollment', { employeeId: state.employeeId });
    await fetchJson('/api/face/enroll', {
      method: 'POST',
      body: JSON.stringify({ employeeId: state.employeeId, image, descriptor }),
    });
    faceHint.textContent = 'Face enrolled successfully. You can now clock in with face recognition.';
    logInfo('Face enrollment success', { employeeId: state.employeeId });
  } catch (error) {
    logError('Face enrollment failed', { employeeId: state.employeeId, error: error.message });
    showError(error.message || 'Face enrollment failed.');
  }
}

checkStatusButton.addEventListener('click', checkStatus);
employeeIdInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    checkStatus();
  }
});
methodCards.forEach((card) => {
  card.addEventListener('click', () => handleMethodSelection(card.dataset.method));
});
startCameraButton.addEventListener('click', startCamera);
captureFaceButton.addEventListener('click', handleCaptureAndVerify);
enrollFaceButton.addEventListener('click', handleFaceEnroll);
actionButton.addEventListener('click', submitClockAction);
closeResultButton.addEventListener('click', () => {
  hideResult();
  stopCameraStream();
  setCameraLoader(false);
  showLivePreview();
  if (!state.status || state.status === 'not_clocked_in') {
    employeeIdInput.value = '';
    state.employeeId = '';
    state.method = null;
    state.faceImage = null;
    state.faceDescriptor = null;
    state.faceVerified = false;
    updateUI();
  }
});
scanFingerprintButton.addEventListener('click', handleFingerprintScan);
enrollFingerprintButton.addEventListener('click', handleFingerprintEnrollment);

updateUI();


// End of file. Admin logic moved to admin.js
// Data below this line has been removed.
