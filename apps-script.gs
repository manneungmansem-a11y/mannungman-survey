// ════════════════════════════════════════════════════════════
// 만능맨 베타테스트 피드백 설문 — Google Apps Script 백엔드 v2
// ════════════════════════════════════════════════════════════
//
// 설정 방법:
//   1. SHEET_ID를 구글시트 URL에서 복사해 붙여넣는다.
//   2. 이 코드를 Apps Script에 붙여넣고 저장한다.
//   3. 배포 → 새 배포 → 웹 앱 → "나로 실행", "모든 사용자" 선택 후 배포한다.
//   4. 발급된 URL을 survey.html / admin.html의 SCRIPT_URL에 붙여넣는다.
//   5. Apps Script 편집기에서 setupSheets() 를 한 번 실행한다.
//   6. 기존 데이터가 있다면 migrateToNewStructure() 를 실행해 백업 후 초기화한다.
//
// ════════════════════════════════════════════════════════════

// ── 변경 필요 상수 ──────────────────────────────────────────
var SHEET_ID       = '11QGLJdAHbc5qU4Xo8UAKfh867AM0y_R6I3bY5JHDwB4'; // ★ 필수 변경
var ADMIN_PASSWORD = '9923';                                            // ★ 필요시 변경
// ────────────────────────────────────────────────────────────

var SHEET_RESPONSES = 'responses';
var SHEET_SETTINGS  = 'settings';
var SHEET_LOGS      = 'logs';

// 기본 비밀코드 초기값 (settings 시트에 없을 때 폴백)
var DEFAULT_CODE_EMPLOYEE = 'samyang';
var DEFAULT_CODE_PARTNER  = '10000';

// ── responses 시트 컬럼 (통합형) ──────────────────────────
// 공통 5 + 일반 15 + 임직원 25 + 파트너 20 + 관리 2 = 67컬럼
function buildGeneralCols() {
  var cols = [];
  for (var i = 1; i <= 15; i++) cols.push('일반_Q' + i);
  return cols;
}
function buildEmployeeCols() {
  var cols = [];
  for (var i = 1; i <= 25; i++) cols.push('임직원_Q' + i);
  return cols;
}
function buildPartnerCols() {
  var cols = [];
  for (var i = 1; i <= 22; i++) cols.push('파트너_Q' + i); // Q21 수수료, Q22 수수료 의견 추가
  return cols;
}

var COMMON_COLS   = ['submittedAt', 'participantType', 'responseId', 'name', 'phone'];
var GENERAL_COLS  = buildGeneralCols();
var EMPLOYEE_COLS = buildEmployeeCols();
var PARTNER_COLS  = buildPartnerCols();
var ADMIN_COLS    = ['처리상태', '관리자메모'];
// 개인정보 동의 관련 컬럼 — 기존 시트에 없을 경우 fixSheets() 실행 필요
var CONSENT_COLS  = ['개인정보동의', '개인정보동의일시'];

var RESPONSE_HEADERS = COMMON_COLS.concat(GENERAL_COLS).concat(EMPLOYEE_COLS).concat(PARTNER_COLS).concat(ADMIN_COLS).concat(CONSENT_COLS);
var LOG_HEADERS      = ['loggedAt', 'type', 'message', 'detail'];
var SETTINGS_HEADERS = ['key', 'value'];

// 처리상태 기본값
var DEFAULT_STATUS = '접수';

// ════════════════════════════════════════════════════════════
// doPost — 설문 응답 저장 / 관리자 액션
// ════════════════════════════════════════════════════════════
function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.tryLock(15000);

  try {
    var data = parseBody(e);

    var action = (data.action || '').toLowerCase();

    // ── 관리자 액션 ──
    if (action === 'setsecretcode') {
      return handleSetSecretCode(data);
    }
    if (action === 'updateresponse') {
      return handleUpdateResponse(data);
    }

    // ── 설문 응답 저장 ──
    var participantType = String(data.participantType || '').trim();
    var validTypes = ['일반사용자', '임직원', '파트너'];
    if (!validTypes.includes(participantType)) {
      writeLog('WARN', '유효하지 않은 참여자유형', participantType);
      return makeResponse({ success: false, error: 'INVALID_TYPE' });
    }

    var ss           = SpreadsheetApp.openById(SHEET_ID);
    var now          = new Date();
    var submittedAt  = Utilities.formatDate(now, 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss');
    var responseId   = 'R' + now.getTime().toString().slice(-8) +
                       Math.random().toString(36).slice(2, 5).toUpperCase();

    var respSheet = getOrCreateSheet(ss, SHEET_RESPONSES, RESPONSE_HEADERS);
    var row = RESPONSE_HEADERS.map(function(key) {
      if (key === 'submittedAt')    return submittedAt;
      if (key === 'responseId')     return responseId;
      if (key === 'participantType') return participantType;
      if (key === '처리상태')        return DEFAULT_STATUS;
      if (key === '관리자메모')      return '';
      return data[key] !== undefined ? String(data[key]) : '';
    });
    respSheet.appendRow(row);

    writeLog('INFO', '응답 저장 완료', responseId + ' / ' + participantType);
    return makeResponse({ success: true, responseId: responseId });

  } catch (err) {
    var errDetail = err.stack || err.message || JSON.stringify(err);
    writeLog('ERROR', 'doPost 실패', errDetail);
    return makeResponse({ success: false, error: err.message });
  } finally {
    lock.releaseLock();
  }
}

// ── 비밀코드 변경 ──
function handleSetSecretCode(data) {
  if (!isValidPassword(data.password || '')) {
    return makeResponse({ success: false, error: 'UNAUTHORIZED' });
  }
  var type = (data.codeType || '').toLowerCase();
  var code = (data.code || '').trim();
  if (!code) return makeResponse({ success: false, error: 'EMPTY_CODE' });
  if (type !== 'employee' && type !== 'partner') {
    return makeResponse({ success: false, error: 'INVALID_TYPE' });
  }

  var ss       = SpreadsheetApp.openById(SHEET_ID);
  var sheet    = getOrCreateSheet(ss, SHEET_SETTINGS, SETTINGS_HEADERS);
  var key      = type === 'employee' ? 'secretCode_employee' : 'secretCode_partner';
  var rows     = sheet.getDataRange().getValues();
  var found    = false;

  for (var i = 1; i < rows.length; i++) {
    if (rows[i][0] === key) {
      sheet.getRange(i + 1, 2).setValue(code);
      found = true;
      break;
    }
  }
  if (!found) sheet.appendRow([key, code]);

  writeLog('INFO', '비밀코드 변경', key + ' → ' + code);
  return makeResponse({ success: true });
}

// ── 처리상태/메모 변경 ──
function handleUpdateResponse(data) {
  if (!isValidPassword(data.password || '')) {
    return makeResponse({ success: false, error: 'UNAUTHORIZED' });
  }
  var responseId = data.responseId || '';
  if (!responseId) return makeResponse({ success: false, error: 'NO_ID' });

  var ss    = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_RESPONSES);
  if (!sheet) return makeResponse({ success: false, error: 'NO_SHEET' });

  var values = sheet.getDataRange().getValues();
  var headers = values[0];
  var idCol   = headers.indexOf('responseId');
  var statCol = headers.indexOf('처리상태');
  var memoCol = headers.indexOf('관리자메모');

  for (var i = 1; i < values.length; i++) {
    if (String(values[i][idCol]) === responseId) {
      if (data.status !== undefined && statCol >= 0) {
        sheet.getRange(i + 1, statCol + 1).setValue(data.status);
      }
      if (data.memo !== undefined && memoCol >= 0) {
        sheet.getRange(i + 1, memoCol + 1).setValue(data.memo);
      }
      return makeResponse({ success: true });
    }
  }
  return makeResponse({ success: false, error: 'NOT_FOUND' });
}

// ════════════════════════════════════════════════════════════
// doGet — 관리자 데이터 조회 / 코드 검증
// ════════════════════════════════════════════════════════════
function doGet(e) {
  try {
    var action   = e.parameter.action   || '';
    var password = e.parameter.password || '';

    // 코드 검증은 비밀번호 불필요
    if (action === 'validateCode') {
      return handleValidateCode(e.parameter);
    }

    if (!isValidPassword(password)) {
      writeLog('WARN', '비밀번호 오류', action);
      return makeResponse({ success: false, error: 'UNAUTHORIZED' });
    }

    switch (action) {
      case 'list':            return handleList();
      case 'detail':          return handleDetail(e.parameter.responseId);
      case 'getSecretCodes':  return handleGetSecretCodes();
      default:
        return makeResponse({ success: false, error: 'UNKNOWN_ACTION' });
    }
  } catch (err) {
    writeLog('ERROR', 'doGet 실패', err.message);
    return makeResponse({ success: false, error: err.message });
  }
}

// ── 코드 검증 (공개) ──
function handleValidateCode(params) {
  var type = (params.type || '').toLowerCase();
  var code = (params.code || '').trim();
  if (!type || !code) return makeResponse({ success: true, valid: false });

  var correctCode = '';
  if (type === 'employee') correctCode = getSecretCode('secretCode_employee', DEFAULT_CODE_EMPLOYEE);
  else if (type === 'partner') correctCode = getSecretCode('secretCode_partner', DEFAULT_CODE_PARTNER);
  else return makeResponse({ success: true, valid: false });

  return makeResponse({ success: true, valid: (code === correctCode) });
}

// ── 목록 조회 ──
function handleList() {
  var ss   = SpreadsheetApp.openById(SHEET_ID);
  var data = sheetToObjects(ss, SHEET_RESPONSES);
  return makeResponse({ success: true, data: data });
}

// ── 상세 조회 ──
function handleDetail(responseId) {
  if (!responseId) return makeResponse({ success: false, error: 'NO_ID' });
  var ss   = SpreadsheetApp.openById(SHEET_ID);
  var rows = sheetToObjects(ss, SHEET_RESPONSES);
  var row  = rows.find(function(r) { return r.responseId === responseId; });
  if (!row) return makeResponse({ success: false, error: 'NOT_FOUND' });
  return makeResponse({ success: true, data: row });
}

// ── 비밀코드 조회 (관리자) ──
function handleGetSecretCodes() {
  return makeResponse({
    success: true,
    data: {
      employee: getSecretCode('secretCode_employee', DEFAULT_CODE_EMPLOYEE),
      partner:  getSecretCode('secretCode_partner',  DEFAULT_CODE_PARTNER)
    }
  });
}

// ════════════════════════════════════════════════════════════
// 초기 시트 세팅 — 최초 1회 실행: setupSheets()
// ════════════════════════════════════════════════════════════
function setupSheets() {
  var ss = SpreadsheetApp.openById(SHEET_ID);

  getOrCreateSheet(ss, SHEET_RESPONSES, RESPONSE_HEADERS);

  var settingsSheet = getOrCreateSheet(ss, SHEET_SETTINGS, SETTINGS_HEADERS);
  var rows = sheetToObjects(ss, SHEET_SETTINGS);
  var keys = rows.map(function(r) { return r.key; });

  if (!keys.includes('adminPassword'))       settingsSheet.appendRow(['adminPassword',       ADMIN_PASSWORD]);
  if (!keys.includes('secretCode_employee')) settingsSheet.appendRow(['secretCode_employee', DEFAULT_CODE_EMPLOYEE]);
  if (!keys.includes('secretCode_partner'))  settingsSheet.appendRow(['secretCode_partner',  DEFAULT_CODE_PARTNER]);

  getOrCreateSheet(ss, SHEET_LOGS, LOG_HEADERS);

  Logger.log('setupSheets 완료 — 컬럼 수: ' + RESPONSE_HEADERS.length);
  Logger.log('responses 헤더: ' + RESPONSE_HEADERS.join(', '));
}

// ════════════════════════════════════════════════════════════
// 기존 데이터 백업 후 새 구조로 초기화
// Apps Script 편집기에서 직접 실행: migrateToNewStructure()
// ════════════════════════════════════════════════════════════
function migrateToNewStructure() {
  var ss  = SpreadsheetApp.openById(SHEET_ID);
  var now = new Date();
  var timestamp = Utilities.formatDate(now, 'Asia/Seoul', 'yyyy-MM-dd_HHmm');
  var backupName = 'backup_' + timestamp;

  // 기존 responses 시트 백업
  var oldSheet = ss.getSheetByName(SHEET_RESPONSES);
  if (oldSheet) {
    oldSheet.copyTo(ss).setName(backupName);
    ss.deleteSheet(oldSheet);
    Logger.log('백업 완료: ' + backupName);
  }

  // 새 responses 시트 생성
  getOrCreateSheet(ss, SHEET_RESPONSES, RESPONSE_HEADERS);

  // settings 초기화
  setupSheets();

  Logger.log('migrateToNewStructure 완료');
  Logger.log('백업 시트: ' + backupName);
  Logger.log('새 responses 헤더 수: ' + RESPONSE_HEADERS.length);
}

// ════════════════════════════════════════════════════════════
// fixSheets — 누락된 헤더 컬럼 자동 추가 (스키마 변경 시 1회 실행)
// 기존 데이터는 유지하면서 responses 시트에 새 컬럼 헤더를 추가합니다.
// ════════════════════════════════════════════════════════════
function fixSheets() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_RESPONSES);
  if (!sheet) {
    setupSheets();
    Logger.log('responses 시트가 없어 새로 생성했습니다.');
    return;
  }

  var lastCol = sheet.getLastColumn();
  var headerRow = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String) : [];

  var added = [];
  RESPONSE_HEADERS.forEach(function(h) {
    if (headerRow.indexOf(h) === -1) {
      var newCol = sheet.getLastColumn() + 1;
      sheet.getRange(1, newCol).setValue(h);
      var cell = sheet.getRange(1, newCol);
      cell.setFontWeight('bold').setBackground('#1a56db').setFontColor('#ffffff');
      added.push(h);
      headerRow.push(h);
    }
  });

  if (added.length === 0) {
    Logger.log('fixSheets: 추가할 컬럼 없음 (현재 ' + lastCol + '컬럼)');
  } else {
    Logger.log('fixSheets: 추가된 컬럼 (' + added.length + '개) — ' + added.join(', '));
  }
}

// ════════════════════════════════════════════════════════════
// 테스트 함수 — Apps Script 편집기에서 실행
// ════════════════════════════════════════════════════════════
function testDoPost_general() {
  var testData = {
    participantType: '일반사용자',
    name: '테스트 일반',
    phone: '010-1111-2222',
    개인정보동의: '동의',
    개인정보동의일시: '2026-06-30 12:00:00',
    일반_Q1: '테스트 일반',
    일반_Q2: '010-1111-2222',
    일반_Q3: '집수리/설비 전문가를 연결해주는 서비스',
    일반_Q4: '4',
    일반_Q5: '누수,수도/배관',
    일반_Q6: '전혀 없었음',
    일반_Q7: '4',
    일반_Q8: '전혀 부담 없음',
    일반_Q9: '없음',
    일반_Q10: '4',
    일반_Q11: '바로 이해됨',
    일반_Q12: '필요할 때 이용할 것 같음',
    일반_Q13: '특별히 없음',
    일반_Q14: '전체적으로 잘 만들어진 것 같습니다.',
    일반_Q15: '4'
  };
  var result = doPost({ postData: { contents: JSON.stringify(testData) }, parameter: testData });
  Logger.log('testDoPost_general 결과: ' + result.getContent());
}

function testDoPost_employee() {
  var testData = {
    participantType: '임직원',
    name: '테스트 임직원',
    phone: '010-3333-4444',
    개인정보동의: '동의',
    개인정보동의일시: '2026-06-30 12:00:00'
  };
  for (var i = 1; i <= 25; i++) testData['임직원_Q' + i] = '테스트 응답 ' + i;
  var result = doPost({ postData: { contents: JSON.stringify(testData) }, parameter: testData });
  Logger.log('testDoPost_employee 결과: ' + result.getContent());
}

function testDoPost_partner() {
  var testData = {
    participantType: '파트너',
    name: '테스트 파트너',
    phone: '010-5555-6666',
    개인정보동의: '동의',
    개인정보동의일시: '2026-06-30 12:00:00'
  };
  for (var i = 1; i <= 22; i++) testData['파트너_Q' + i] = '테스트 응답 ' + i;
  testData['파트너_Q21'] = '3%';
  testData['파트너_Q22'] = '테스트 수수료 의견';
  var result = doPost({ postData: { contents: JSON.stringify(testData) }, parameter: testData });
  Logger.log('testDoPost_partner 결과: ' + result.getContent());
}

// ════════════════════════════════════════════════════════════
// 헬퍼 함수
// ════════════════════════════════════════════════════════════

function parseBody(e) {
  var rawBody = (e.postData && e.postData.contents) ? e.postData.contents : '';
  try {
    return JSON.parse(rawBody);
  } catch (_) {
    var data = {};
    if (rawBody) {
      rawBody.split('&').forEach(function(pair) {
        if (!pair) return;
        var eq = pair.indexOf('=');
        if (eq < 0) return;
        var k = decodeURIComponent(pair.slice(0, eq).replace(/\+/g, ' '));
        var v = decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' '));
        if (k) data[k] = v;
      });
    }
    if (!Object.keys(data).length) data = e.parameter || {};
    return data;
  }
}

function sheetToObjects(ss, sheetName) {
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) return [];
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  var headers = values[0];
  return values.slice(1).map(function(row) {
    var obj = {};
    headers.forEach(function(h, i) {
      var val = row[i];
      if (val instanceof Date) {
        val = Utilities.formatDate(val, 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss');
      }
      obj[h] = (val !== undefined && val !== null) ? String(val) : '';
    });
    return obj;
  });
}

function getOrCreateSheet(ss, name, headers) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
    var range = sheet.getRange(1, 1, 1, headers.length);
    range.setFontWeight('bold');
    range.setBackground('#1a56db');
    range.setFontColor('#ffffff');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function isValidPassword(pw) {
  try {
    var ss       = SpreadsheetApp.openById(SHEET_ID);
    var settings = sheetToObjects(ss, SHEET_SETTINGS);
    var row      = settings.find(function(s) { return s.key === 'adminPassword'; });
    var stored   = row ? row.value : ADMIN_PASSWORD;
    return pw === stored;
  } catch (_) {
    return pw === ADMIN_PASSWORD;
  }
}

function getSecretCode(key, defaultVal) {
  try {
    var ss       = SpreadsheetApp.openById(SHEET_ID);
    var settings = sheetToObjects(ss, SHEET_SETTINGS);
    var row      = settings.find(function(s) { return s.key === key; });
    return (row && row.value) ? row.value : defaultVal;
  } catch (_) {
    return defaultVal;
  }
}

function makeResponse(obj) {
  var output = ContentService.createTextOutput(JSON.stringify(obj));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}

function writeLog(type, message, detail) {
  try {
    var ss    = SpreadsheetApp.openById(SHEET_ID);
    var sheet = getOrCreateSheet(ss, SHEET_LOGS, LOG_HEADERS);
    var now   = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss');
    sheet.appendRow([now, type, message, detail]);
  } catch (_) {
    Logger.log('[LOG FAIL] ' + type + ': ' + message);
  }
}
