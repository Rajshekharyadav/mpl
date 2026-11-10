const menuToggle = document.querySelector('.menu-toggle');
const nav = document.querySelector('.nav');

menuToggle.addEventListener('click', () => {
  const open = nav.classList.toggle('open');
  menuToggle.setAttribute('aria-expanded', String(open));
});

nav.querySelectorAll('a').forEach((link) => link.addEventListener('click', () => {
  nav.classList.remove('open');
  menuToggle.setAttribute('aria-expanded', 'false');
}));

const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbydbyHxwwkMBSdY3DtoYXlkmniyxzMBkZBOFp0mhGyUJ438AHw2903B3bIOIOapoLGOBA/exec';
const MAX_IMAGE_SIZE = 2 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const form = document.querySelector('#registration-form');
const roleInputs = [...form.querySelectorAll('input[name="role"]')];
const submitButton = form.querySelector('button[type="submit"]');
const statusMessage = document.querySelector('#form-status');
const successMessage = document.querySelector('#form-success');
const whatsappJoinButton = document.querySelector('[data-whatsapp-join]');
const paymentMethodButtons = [...document.querySelectorAll('[data-payment-method]')];
const paymentOptions = [...document.querySelectorAll('[data-payment-option]')];
const DEBUG_MODE = new URLSearchParams(window.location.search).get('debug') === '1';
const FRONTEND_VERSION = 'MPL-iframe-bridge-2026-11-07-v1';
const debugPanel = DEBUG_MODE ? document.createElement('pre') : null;

if (debugPanel) {
  debugPanel.className = 'form-debug-panel';
  debugPanel.setAttribute('aria-live', 'polite');
  statusMessage.after(debugPanel);
}

function debugLog(stage, details = {}) {
  if (!DEBUG_MODE) return;
  const entry = {
    time: new Date().toISOString(),
    stage,
    frontendVersion: FRONTEND_VERSION,
    pageProtocol: window.location.protocol,
    ...details,
  };
  // This intentionally excludes all form values, Aadhaar and image data.
  console.info('[MPL registration debug]', entry);
  if (debugPanel) debugPanel.textContent += `${JSON.stringify(entry, null, 2)}\n\n`;
}

debugLog('page_ready', {
  transport: 'urlencoded form + hidden iframe postMessage',
  endpoint: APPS_SCRIPT_URL,
});

paymentMethodButtons.forEach((button) => button.addEventListener('click', () => {
  const selectedMethod = button.dataset.paymentMethod;
  paymentMethodButtons.forEach((option) => {
    option.setAttribute('aria-pressed', String(option === button));
  });
  paymentOptions.forEach((option) => {
    option.hidden = option.dataset.paymentOption !== selectedMethod;
  });
}));

function updateRoleValidity() {
  roleInputs[0].setCustomValidity(roleInputs.some((role) => role.checked) ? '' : 'Choose at least one player role.');
}

roleInputs.forEach((input) => input.addEventListener('change', updateRoleValidity));
updateRoleValidity();

function showStatus(message, kind) {
  statusMessage.textContent = message;
  statusMessage.className = `form-status ${kind}`;
  statusMessage.hidden = false;
}

function selectedValues(name) {
  return [...form.querySelectorAll(`input[name="${name}"]:checked`)].map((input) => input.value);
}

function getOptionalImage(inputName) {
  const input = form.elements[inputName];
  const file = input.files && input.files[0];
  if (!file) return Promise.resolve(null);

  const extension = file.name.toLowerCase().match(/\.([^.]+)$/)?.[1];
  const extensionMime = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[extension];
  const mimeType = file.type === 'image/jpg' ? 'image/jpeg' : file.type || extensionMime;
  if (!ALLOWED_IMAGE_TYPES.has(mimeType) || (file.type && file.type !== 'image/jpg' && file.type !== mimeType)) {
    input.setCustomValidity('Choose a JPG, JPEG, PNG or WEBP image.');
    input.reportValidity();
    input.setCustomValidity('');
    return Promise.reject(new Error('Choose a JPG, JPEG, PNG or WEBP image.'));
  }
  if (file.size > MAX_IMAGE_SIZE) {
    input.setCustomValidity('Each image must be 2 MB or smaller.');
    input.reportValidity();
    input.setCustomValidity('');
    return Promise.reject(new Error('Each image must be 2 MB or smaller.'));
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      if (comma < 0) {
        reject(new Error('The selected image could not be read. Please choose it again.'));
        return;
      }
      resolve({ mimeType, data: result.slice(comma + 1) });
    };
    reader.onerror = () => reject(new Error('The selected image could not be read. Please choose it again.'));
    reader.readAsDataURL(file);
  });
}

function getRegistrationId(result) {
  return result && (result.registrationId || result.registrationID || result.registration_id || result.regId || result.id);
}

function submitToAppsScript(payload) {
  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe');
    const frameName = `mpl-response-${Date.now()}`;
    frame.name = frameName;
    frame.title = 'Registration response';
    frame.hidden = true;

    const transportForm = document.createElement('form');
    transportForm.method = 'POST';
    transportForm.action = APPS_SCRIPT_URL;
    transportForm.enctype = 'application/x-www-form-urlencoded';
    transportForm.target = frameName;

    const payloadInput = document.createElement('input');
    payloadInput.type = 'hidden';
    payloadInput.name = 'payload';
    payloadInput.value = JSON.stringify(payload);
    transportForm.append(payloadInput);

    let settled = false;
    const cleanup = () => {
      window.removeEventListener('message', onMessage);
      clearTimeout(timeout);
      transportForm.remove();
      frame.remove();
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onMessage = (event) => {
      if (event.data?.type !== 'mpl-registration-response' ||
          event.data?.payload?.clientRequestId !== payload.clientRequestId) return;
      const result = event.data.payload;
      debugLog('backend_response', {
        success: result?.success === true,
        backendVersion: result?.backendVersion || 'missing',
        requestId: result?.requestId || 'missing',
        backendStage: result?.stage || 'complete',
        diagnosticCode: result?.diagnosticCode || 'none',
      });
      if (result?.success === true && getRegistrationId(result)) finish(resolve, result);
      else {
        const error = new Error(result?.message || 'The registration was not confirmed by the server.');
        error.backendStage = result?.stage || 'unknown';
        error.backendVersion = result?.backendVersion || 'missing';
        finish(reject, error);
      }
    };
    const timeout = setTimeout(() => {
      debugLog('response_timeout', { timeoutMs: 60000, hint: 'Check /exec?diag=1 for backendVersion and deployment access.' });
      const error = new Error('No response came back from the Apps Script deployment. Check that the active deployment is running the iframe response code, then retry only after confirming the Sheet has no saved row.');
      error.name = 'BackendTimeoutError';
      finish(reject, error);
    }, 60000);

    window.addEventListener('message', onMessage);
    document.body.append(frame, transportForm);
    showStatus('Uploading registration and images to MPL…', 'info');
    debugLog('request_submitted', { payloadField: 'payload', responseTimeoutMs: 60000 });
    HTMLFormElement.prototype.submit.call(transportForm);
  });
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  successMessage.classList.remove('show');
  whatsappJoinButton.hidden = true;
  statusMessage.hidden = true;
  if (!form.reportValidity()) return;

  submitButton.disabled = true;
  submitButton.textContent = 'Preparing registration…';
  showStatus('Checking images and preparing your registration…', 'info');
  const submitDialog = document.querySelector('#submit-dialog');
  const dialogTitle = submitDialog.querySelector('[data-dialog-title]');
  const dialogMessage = submitDialog.querySelector('[data-dialog-message]');
  const dialogClose = submitDialog.querySelector('[data-dialog-close]');
  const waitSpinner = submitDialog.querySelector('[data-wait-spinner]');
  dialogTitle.textContent = 'Preparing your registration';
  dialogMessage.textContent = 'Please wait while we prepare your details and images for upload.';
  dialogClose.hidden = true;
  waitSpinner.hidden = false;
  submitDialog.showModal();

  try {
    const [playerPhoto, paymentScreenshot] = await Promise.all([
      getOptionalImage('photo'),
      getOptionalImage('paymentConfirmation'),
    ]);
    debugLog('images_prepared', {
      playerPhotoIncluded: Boolean(playerPhoto),
      paymentScreenshotIncluded: Boolean(paymentScreenshot),
    });

    const payload = {
      clientRequestId: crypto.randomUUID(),
      playerName: form.elements.playerName.value.trim(),
      guardianName: form.elements.fatherName.value.trim(),
      dob: form.elements.dob.value,
      address: form.elements.address.value.trim(),
      district: form.elements.district.value.trim(),
      pinCode: form.elements.pincode.value.trim(),
      contactNumber: form.elements.phone.value.trim(),
      playerPhoto,
      playerRole: selectedValues('role'),
      dressSize: form.querySelector('input[name="size"]:checked')?.value || '',
      aadhaar: form.elements.aadhaar.value.trim(),
      batterHand: form.querySelector('input[name="batterHand"]:checked')?.value || '',
      bowlerHand: form.querySelector('input[name="bowlerHand"]:checked')?.value || '',
      paceBowling: selectedValues('pace'),
      spinBowling: selectedValues('spin'),
      paymentScreenshot,
      declarationAccepted: form.elements.agree.checked,
      guardianSignature: form.elements.guardianSignature.value.trim(),
      playerSignature: form.elements.playerSignature.value.trim(),
    };

    submitButton.textContent = 'Submitting registration…';
    dialogTitle.textContent = 'Submitting your form';
    dialogMessage.textContent = 'Please wait while we save your player registration and images.';
    const result = await submitToAppsScript(payload);

    const registrationId = getRegistrationId(result);
    form.reset();
    updateRoleValidity();
    statusMessage.hidden = true;
    successMessage.querySelector('span').textContent = registrationId
      ? `Your registration was saved. Registration ID: ${registrationId}.`
      : 'Your registration was saved, but the server did not return a Registration ID. Please contact the MPL organizers for it.';
    successMessage.classList.add('show');
    dialogTitle.textContent = 'Registration submitted';
    waitSpinner.hidden = true;
    whatsappJoinButton.hidden = false;
    dialogMessage.textContent = registrationId
      ? `Your form has been submitted successfully. Registration ID: ${registrationId}. You can close this message now.`
      : 'Your form has been submitted successfully. You can close this message now.';
    dialogClose.hidden = false;
    successMessage.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (error) {
    // Never log or echo the submitted payload; it includes Aadhaar details.
    debugLog('submission_failed', {
      errorName: error.name || 'Error',
      backendVersion: error.backendVersion || 'not_received',
      backendStage: error.backendStage || 'client_or_transport',
    });
    showStatus(error instanceof TypeError
      ? 'The server response could not be confirmed. Contact the MPL organizers before trying again, so a received registration is not duplicated.'
      : error.message, 'error');
    document.querySelector('#submit-dialog').close();
  } finally {
    submitButton.disabled = false;
    submitButton.innerHTML = 'Submit player registration <span>↗</span>';
  }
});

document.querySelector('[data-dialog-close]').addEventListener('click', () => {
  document.querySelector('#submit-dialog').close();
});
