/***************************************
 * CRICKET TOURNAMENT REGISTRATION
 * Google Sheets + Google Drive Backend
 ***************************************/

const CONFIG = {
  SPREADSHEET_ID: '1rYzRH4Mdph5G3RSnI2ZYlP6_gbyGONjCdC2W0PWH0Tk',
  MAIN_FOLDER_ID: '1qTOu_GyUlFQNE3B8-fCqRGPZkaGqlB3b',
  MAIN_FOLDER_NAME: 'Cricket Tournament Registrations',
  SHEET_NAME: 'Sheet1',
  PLAYER_PHOTO_FOLDER: 'Player Photos',
  PAYMENT_FOLDER: 'Payment Screenshots',
  MAX_FILE_SIZE: 2 * 1024 * 1024,
};
const BACKEND_VERSION = 'MPL-iframe-bridge-2026-11-07-v1';

// Keep this order aligned with the headers supplied for the Registrations sheet.
const HEADERS = [
  'Registration ID',
  'Submission Date',
  'Player Name',
  'Father/Guardian Name',
  'Date of Birth',
  'Address',
  'District',
  'PIN Code',
  'Contact Number',
  'Player Photo URL',
  'Player Role',
  'Dress Size',
  'Batter Hand',
  'Bowler Hand',
  'Pace Bowling',
  'Spin Bowling',
  'Aadhaar',
  'Payment Screenshot URL',
  'Declaration Accepted',
  'Guardian Signature',
  'Player Signature',
  'Payment Status',
];

function jsonResponse(success, message, data) {
  return ContentService
    .createTextOutput(JSON.stringify(Object.assign({ success, message }, data || {})))
    .setMimeType(ContentService.MimeType.JSON);
}

// A simple GET health check. POST replies use HTMLService so the hidden iframe
// transport on the static site can receive a confirmed response without CORS.
function doGet(e) {
  if (!e || !e.parameter || e.parameter.diag !== '1') {
    return jsonResponse(true, 'Cricket Registration Backend is running!', {
      backendVersion: BACKEND_VERSION,
    });
  }

  try {
    const spreadsheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const sheet = spreadsheet.getSheetByName(CONFIG.SHEET_NAME);
    DriveApp.getFolderById(CONFIG.MAIN_FOLDER_ID).getName();
    if (!sheet) {
      return jsonResponse(false, 'The configured Sheet tab was not found.', {
        backendVersion: BACKEND_VERSION,
        sheetName: CONFIG.SHEET_NAME,
        sheetFound: false,
        driveFolderFound: true,
      });
    }
    return jsonResponse(true, 'Diagnostics passed.', {
      backendVersion: BACKEND_VERSION,
      sheetName: CONFIG.SHEET_NAME,
      sheetFound: Boolean(sheet),
      driveFolderFound: true,
      postTransport: 'urlencoded payload field + iframe postMessage',
    });
  } catch (error) {
    return jsonResponse(false, 'Diagnostics failed. Check the Sheet tab and Drive folder access.', {
      backendVersion: BACKEND_VERSION,
      sheetName: CONFIG.SHEET_NAME,
      diagnosticCode: 'CONFIG_ACCESS_FAILED',
    });
  }
}

function postMessageResponse(result) {
  const safeJson = JSON.stringify(result).replace(/</g, '\\u003c');
  const html = '<!doctype html><html><head><meta charset="utf-8"></head><body>' +
    // HtmlService pages run in a sandboxed child frame. Send directly to the
    // top-level form page; it validates the per-request clientRequestId.
    '<script>window.top.postMessage({type:"mpl-registration-response",payload:' + safeJson + '},"*");</script>' +
    '</body></html>';
  return HtmlService.createHtmlOutput(html)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function publicError(message) {
  const error = new Error(message);
  error.publicMessage = message;
  return error;
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  const requestId = Utilities.getUuid();
  let stage = 'read_payload';
  try {
    // The website posts a form field named "payload" to avoid CORS. Keep the
    // raw JSON fallback for command-line or other server-side clients.
    const rawJson = e && e.parameter && e.parameter.payload
      ? e.parameter.payload
      : e && e.postData && e.postData.contents;
    if (!rawJson) throw publicError('No form data received.');

    let data;
    stage = 'parse_payload';
    try {
      data = JSON.parse(rawJson);
    } catch (parseError) {
      throw publicError('The submitted form data could not be read. Please try again.');
    }

    stage = 'validate_payload';
    validateForm(data);
    lock.waitLock(30000);

    stage = 'open_sheet';
    const spreadsheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    const sheet = spreadsheet.getSheetByName(CONFIG.SHEET_NAME);
    if (!sheet) throw publicError('Registrations sheet not found. Check the sheet tab name.');
    ensureHeaders(sheet);

    stage = 'open_drive_folders';
    const mainFolder = getMainFolder();
    const playerFolder = getOrCreateFolder(mainFolder, CONFIG.PLAYER_PHOTO_FOLDER);
    const paymentFolder = getOrCreateFolder(mainFolder, CONFIG.PAYMENT_FOLDER);

    const registrationId = 'CRT-' + Utilities.formatDate(
      new Date(), Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss'
    ) + '-' + Math.floor(1000 + Math.random() * 9000);

    stage = 'upload_images';
    let playerPhotoUrl = '';
    if (data.playerPhoto) {
      playerPhotoUrl = uploadImage(data.playerPhoto, playerFolder, registrationId + '-Player').getUrl();
    }

    let paymentScreenshotUrl = '';
    if (data.paymentScreenshot) {
      paymentScreenshotUrl = uploadImage(data.paymentScreenshot, paymentFolder, registrationId + '-Payment').getUrl();
    }

    const row = [
      registrationId,
      new Date(),
      safeText(data.playerName),
      safeText(data.guardianName),
      safeText(data.dob),
      safeText(data.address),
      safeText(data.district),
      safeText(data.pinCode),
      safeText(data.contactNumber),
      playerPhotoUrl,
      safeText(data.playerRole),
      safeText(data.dressSize),
      safeText(data.batterHand),
      safeText(data.bowlerHand),
      safeText(data.paceBowling),
      safeText(data.spinBowling),
      safeText(data.aadhaar),
      paymentScreenshotUrl,
      'Yes',
      safeText(data.guardianSignature),
      safeText(data.playerSignature),
      'Pending',
    ];

    stage = 'write_sheet_row';
    sheet.appendRow(row);
    SpreadsheetApp.flush();

    return postMessageResponse({
      success: true,
      message: 'Registration submitted successfully!',
      registrationId,
      backendVersion: BACKEND_VERSION,
      requestId,
      clientRequestId: safeText(data.clientRequestId),
    });
  } catch (error) {
    // Do not log submitted data or Aadhaar. Only known safe validation messages
    // are returned to the browser; unexpected platform errors stay generic.
    console.error(JSON.stringify({
      event: 'registration_failed',
      requestId,
      stage,
      errorName: error && error.name ? error.name : 'Error',
    }));
    const message = error && error.publicMessage
      ? error.publicMessage
      : 'The registration could not be saved. Please contact the MPL organizers.';
    return postMessageResponse({
      success: false,
      message,
      backendVersion: BACKEND_VERSION,
      requestId,
      clientRequestId: safeText(data && data.clientRequestId),
      stage,
      diagnosticCode: error && error.publicMessage ? 'VALIDATION_OR_REQUEST_ERROR' : 'BACKEND_FAILURE',
    });
  } finally {
    if (lock.hasLock()) lock.releaseLock();
  }
}

function validateForm(data) {
  const requiredFields = [
    'playerName', 'guardianName', 'dob', 'address', 'district', 'pinCode',
    'contactNumber', 'playerRole', 'dressSize', 'guardianSignature', 'playerSignature',
  ];
  requiredFields.forEach(function (field) {
    const value = data[field];
    if (value === undefined || value === null || String(value).trim() === '') {
      throw publicError('Please complete all required registration fields.');
    }
  });

  if (!Array.isArray(data.playerRole) || data.playerRole.length === 0) {
    throw publicError('Choose at least one player role.');
  }
  if (data.declarationAccepted !== true) {
    throw publicError('Please accept the declaration.');
  }
  if (!data.paymentScreenshot || typeof data.paymentScreenshot !== 'object') {
    throw publicError('Upload your payment confirmation screenshot before submitting.');
  }
  // Player photo and payment screenshot are both optional.
  if (!/^\d{6}$/.test(String(data.pinCode))) {
    throw publicError('Enter a valid 6-digit PIN code.');
  }
  if (!/^\d{10}$/.test(String(data.contactNumber))) {
    throw publicError('Enter a valid 10-digit contact number.');
  }
  [data.playerPhoto, data.paymentScreenshot].forEach(function (image) {
    if (image !== null && image !== undefined && typeof image !== 'object') {
      throw publicError('An uploaded image could not be read. Please select it again.');
    }
  });
}

function ensureHeaders(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    return;
  }
  const current = sheet.getRange(1, 1, 1, HEADERS.length).getDisplayValues()[0];
  if (HEADERS.some(function (header, index) { return current[index] !== header; })) {
    throw publicError('The Registrations sheet columns do not match the expected headings.');
  }
}

function getMainFolder() {
  if (CONFIG.MAIN_FOLDER_ID) return DriveApp.getFolderById(CONFIG.MAIN_FOLDER_ID);
  const properties = PropertiesService.getScriptProperties();
  const storedId = properties.getProperty('MPL_MAIN_FOLDER_ID');
  if (storedId) return DriveApp.getFolderById(storedId);
  const folder = DriveApp.createFolder(CONFIG.MAIN_FOLDER_NAME);
  properties.setProperty('MPL_MAIN_FOLDER_ID', folder.getId());
  return folder;
}

function getOrCreateFolder(parent, folderName) {
  const folders = parent.getFoldersByName(folderName);
  return folders.hasNext() ? folders.next() : parent.createFolder(folderName);
}

function uploadImage(fileData, folder, fileName) {
  if (!fileData || typeof fileData.data !== 'string' || !fileData.data) {
    throw publicError('An uploaded image could not be read. Please select it again.');
  }

  let mimeType = String(fileData.mimeType || '').toLowerCase();
  if (mimeType === 'image/jpg') mimeType = 'image/jpeg';
  const extensions = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
  if (!extensions[mimeType]) throw publicError('Use a JPG, PNG or WEBP image.');

  const base64 = fileData.data.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '').replace(/\s/g, '');
  const estimatedSize = Math.ceil(base64.length * 3 / 4);
  if (!base64 || estimatedSize > CONFIG.MAX_FILE_SIZE) {
    throw publicError('Each image must be 2 MB or smaller.');
  }

  const decoded = Utilities.base64Decode(base64);
  if (!decoded.length || decoded.length > CONFIG.MAX_FILE_SIZE) {
    throw publicError('Each image must be 2 MB or smaller.');
  }

  const blob = Utilities.newBlob(decoded, mimeType, fileName + extensions[mimeType]);
  return folder.createFile(blob);
}

function safeText(value) {
  if (Array.isArray(value)) return value.map(safeText).join(', ');
  if (value === undefined || value === null) return '';
  let text = String(value).trim();
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return text;
}
