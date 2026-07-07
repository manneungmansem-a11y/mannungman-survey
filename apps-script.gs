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
// 공통 5 + 일반 15 + 임직원 25 + 파트너 22 + 관리 2 + 동의 2 + 파트너추가 7 = 78컬럼
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

var COMMON_COLS   = ['submittedAt', 'participantType', 'responseId', 'respondentName', 'respondentPhone'];
var GENERAL_COLS  = buildGeneralCols();
var EMPLOYEE_COLS = buildEmployeeCols();
var PARTNER_COLS  = buildPartnerCols();
var ADMIN_COLS    = ['처리상태', '관리자메모'];
// 개인정보 동의 관련 컬럼 — 기존 시트에 없을 경우 fixSheets() 실행 필요
var CONSENT_COLS  = ['개인정보동의', '개인정보동의일시'];

// 파트너 추가 질문 컬럼 — 기존 컬럼 순서를 유지하기 위해 반드시 전체 헤더 "맨 뒤"에 추가
var PARTNER_EXTRA_COLS = [
  '정산 방식에서 가장 중요하게 생각하는 부분',
  '정산 방식 기타 의견',
  '수수료 구조에서 부담되는 방식',
  '수수료 구조 기타 의견',
  '입점 시 가장 필요한 지원',
  '입점 지원 기타 의견',
  '입점사 입장에서 절대 불편하면 안 되는 부분'
];
// 시트 헤더명(한글) ← 설문 페이지 제출 필드명(영문) 매핑
var PARTNER_EXTRA_FIELD_MAP = {
  '정산 방식에서 가장 중요하게 생각하는 부분': 'partner_settlement_priority',
  '정산 방식 기타 의견':                       'partner_settlement_priority_etc',
  '수수료 구조에서 부담되는 방식':             'partner_fee_burden_type',
  '수수료 구조 기타 의견':                     'partner_fee_burden_type_etc',
  '입점 시 가장 필요한 지원':                  'partner_required_support',
  '입점 지원 기타 의견':                       'partner_required_support_etc',
  '입점사 입장에서 절대 불편하면 안 되는 부분': 'partner_must_not_be_inconvenient'
};

var RESPONSE_HEADERS = COMMON_COLS.concat(GENERAL_COLS).concat(EMPLOYEE_COLS).concat(PARTNER_COLS).concat(ADMIN_COLS).concat(CONSENT_COLS).concat(PARTNER_EXTRA_COLS);
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
    if (action === 'resetdata') {
      return handleResetData(data);
    }

    // ── 추첨 기능 (기존 설문 저장 로직과 완전히 분리된 네임스페이스) ──
    if (action === 'rafflerun')          return raffleRun(data);
    if (action === 'rafflereset')        return raffleReset(data);
    if (action === 'raffletogglereveal') return raffleToggleReveal(data);
    if (action === 'rafflecheck')        return raffleCheck(data);

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
    ensureResponseHeaders(respSheet); // 새로 추가된 컬럼 헤더가 없으면 맨 뒤에 자동 추가 (기존 컬럼은 건드리지 않음)
    var row = RESPONSE_HEADERS.map(function(key) {
      if (key === 'submittedAt')    return submittedAt;
      if (key === 'responseId')     return responseId;
      if (key === 'participantType') return participantType;
      if (key === '처리상태')        return DEFAULT_STATUS;
      if (key === '관리자메모')      return '';
      // 파트너 추가 질문 — 한글 헤더에 영문 필드명으로 제출된 값을 매핑
      if (PARTNER_EXTRA_FIELD_MAP[key] !== undefined) {
        var fieldKey = PARTNER_EXTRA_FIELD_MAP[key];
        return data[fieldKey] !== undefined ? String(data[fieldKey]) : '';
      }
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

// ── 응답 데이터 초기화 (백업 후 삭제) ──
function handleResetData(data) {
  if (!isValidPassword(data.password || '')) {
    return makeResponse({ success: false, error: 'UNAUTHORIZED' });
  }
  var ss  = SpreadsheetApp.openById(SHEET_ID);
  var now = new Date();
  var timestamp = Utilities.formatDate(now, 'Asia/Seoul', 'yyyyMMdd_HHmmss');
  var backupName = 'Backup_' + timestamp;

  var oldSheet = ss.getSheetByName(SHEET_RESPONSES);
  if (oldSheet) {
    oldSheet.copyTo(ss).setName(backupName);
    var dataCount = Math.max(0, oldSheet.getLastRow() - 1);
    ss.deleteSheet(oldSheet);
    getOrCreateSheet(ss, SHEET_RESPONSES, RESPONSE_HEADERS);
    writeLog('INFO', '데이터 초기화 완료', '백업: ' + backupName + ' / 삭제 행 수: ' + dataCount);
    return makeResponse({ success: true, backupName: backupName, deletedCount: dataCount });
  }

  getOrCreateSheet(ss, SHEET_RESPONSES, RESPONSE_HEADERS);
  writeLog('INFO', '데이터 초기화 완료 (기존 시트 없음)', backupName);
  return makeResponse({ success: true, backupName: backupName, deletedCount: 0 });
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

    // 코드 검증 / 추첨 공개상태 조회는 비밀번호 불필요 (공개 API)
    if (action === 'validateCode') {
      return handleValidateCode(e.parameter);
    }
    if (action === 'rafflestatus') {
      return raffleStatus();
    }

    if (!isValidPassword(password)) {
      writeLog('WARN', '비밀번호 오류', action);
      return makeResponse({ success: false, error: 'UNAUTHORIZED' });
    }

    switch (action) {
      case 'list':            return handleList();
      case 'detail':          return handleDetail(e.parameter.responseId);
      case 'getSecretCodes':  return handleGetSecretCodes();
      case 'rafflewinners':    return raffleWinners();
      case 'raffleduplicates': return raffleDuplicates();
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

// ════════════════════════════════════════════════════════════════════
// ══                  추첨(Raffle) 기능 — 완전 분리 모듈                ══
// ════════════════════════════════════════════════════════════════════
// 기존 설문 저장/조회 로직(responses, settings, logs 시트)에는 전혀
// 손대지 않고, 별도 시트(raffle_config / raffle_results / raffle_logs)와
// raffle 접두어가 붙은 함수만 사용합니다. 아래 함수들을 삭제하거나
// doGet/doPost의 raffle* 라우팅을 제거해도 설문 제출·통계 기능은
// 100% 그대로 동작합니다.
//
// 당첨 판정 기준: 응답자 "휴대폰 번호"(하이픈/공백 제거 후 숫자만 비교).
// 동일 번호로 여러 번 제출한 경우 "가장 최근 제출 1건"만 추첨 대상 풀에
// 포함시켜 중복 참여를 방지합니다 (관리자는 raffleduplicates로 중복 제출
// 현황을 별도 확인 가능).
// ════════════════════════════════════════════════════════════════════

var RAFFLE_SHEET_CONFIG  = 'raffle_config';
var RAFFLE_SHEET_RESULTS = 'raffle_results';
var RAFFLE_SHEET_LOGS    = 'raffle_logs';

var RAFFLE_CONFIG_HEADERS  = ['key', 'value'];
// phone: 정규화된(숫자만) 휴대폰 번호 — 당첨 판정 키
// responseId: 관리자 참고용(당첨자가 최종적으로 인정된 응답 건)
var RAFFLE_RESULTS_HEADERS = ['phone', 'tier', 'prize', 'drawnAt', 'confirmed', 'confirmedAt', 'responseId'];
var RAFFLE_LOGS_HEADERS    = ['loggedAt', 'action', 'detail'];

// 경품 구성 — 필요 시 이 배열만 수정하면 됩니다.
var RAFFLE_PRIZE_TIERS = [
  { tier: '1등',   count: 1,  prize: '100,000원 상품권' },
  { tier: '2등',   count: 3,  prize: '30,000원 상품권' },
  { tier: '3등',   count: 6,  prize: '10,000원 상품권' },
  { tier: '참가상', count: 20, prize: '2,000원 커피쿠폰' }
];

// ── raffle_config / raffle_results / raffle_logs 시트 보장 (없으면 생성, 있으면 그대로 사용) ──
function raffleEnsureSheets(ss) {
  getOrCreateSheet(ss, RAFFLE_SHEET_CONFIG, RAFFLE_CONFIG_HEADERS);
  getOrCreateSheet(ss, RAFFLE_SHEET_RESULTS, RAFFLE_RESULTS_HEADERS);
  getOrCreateSheet(ss, RAFFLE_SHEET_LOGS, RAFFLE_LOGS_HEADERS);
}

// 수동 실행용 — Apps Script 편집기에서 최초 1회 실행해도 되고, 각 raffle 함수가
// 호출될 때마다 자동으로 raffleEnsureSheets가 실행되므로 생략해도 무방합니다.
function raffleSetupSheets() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  raffleEnsureSheets(ss);
  Logger.log('raffleSetupSheets 완료 — raffle_config / raffle_results / raffle_logs 시트 준비됨');
}

function raffleGetConfigMap(ss) {
  var rows = sheetToObjects(ss, RAFFLE_SHEET_CONFIG);
  var map = {};
  rows.forEach(function(r) { map[r.key] = r.value; });
  return map;
}

function raffleSetConfigValue(ss, sheet, key, value) {
  var rows = sheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (rows[i][0] === key) {
      sheet.getRange(i + 1, 2).setValue(value);
      return;
    }
  }
  sheet.appendRow([key, value]);
}

function raffleWriteLog(ss, action, detail) {
  try {
    var sheet = getOrCreateSheet(ss, RAFFLE_SHEET_LOGS, RAFFLE_LOGS_HEADERS);
    var now = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss');
    sheet.appendRow([now, action, detail]);
  } catch (_) {
    Logger.log('[RAFFLE LOG FAIL] ' + action + ': ' + detail);
  }
}

// 휴대폰 번호 정규화 — 하이픈/공백/괄호 등 숫자가 아닌 문자를 모두 제거
function raffleNormalizePhone(raw) {
  return String(raw || '').replace(/\D/g, '');
}

// 관리자 화면 로그용 — 번호 중간 자리를 마스킹 (구글시트 raffle_results/responses에는 영향 없음)
function raffleMaskPhone(phone) {
  if (!phone) return '';
  if (phone.length < 7) return phone.replace(/./g, '*');
  return phone.slice(0, 3) + '****' + phone.slice(-4);
}

// responses 시트를 원본 그대로 "읽기만" 하여 번호별 추첨 대상 풀과 중복 제출 현황을 계산합니다.
// responses 시트에는 어떤 쓰기 작업도 하지 않습니다 (기존 데이터 보존).
// 연락처가 비어 있는 기존 데이터(레거시)는 자동으로 대상에서 제외됩니다.
function raffleGetEligibleEntries(ss) {
  var sheet = ss.getSheetByName(SHEET_RESPONSES);
  if (!sheet) return { entries: [], duplicatesMap: {} };
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return { entries: [], duplicatesMap: {} };

  var headers   = values[0];
  var phoneCol  = headers.indexOf('respondentPhone');
  var idCol     = headers.indexOf('responseId');
  var atCol     = headers.indexOf('submittedAt');
  if (phoneCol < 0) return { entries: [], duplicatesMap: {} };

  var byPhone = {};
  for (var i = 1; i < values.length; i++) {
    var norm = raffleNormalizePhone(values[i][phoneCol]);
    if (!norm) continue; // 연락처 없는 응답은 추첨 대상에서 제외 (레거시 데이터 예외처리)
    var rid = idCol >= 0 ? String(values[i][idCol] || '').trim() : '';
    var atRaw = atCol >= 0 ? values[i][atCol] : '';
    // 시트가 값을 Date 객체로 돌려줄 수도, 문자열로 돌려줄 수도 있으므로
    // 최신 제출 판정용 타임스탬프(ms)와 표시용 문자열을 분리해 보관
    var atStr, atMs;
    if (atRaw instanceof Date) {
      atMs  = atRaw.getTime();
      atStr = Utilities.formatDate(atRaw, 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss');
    } else {
      atStr = String(atRaw);
      atMs  = Date.parse(atStr.replace(' ', 'T')) || 0;
    }
    if (!byPhone[norm]) byPhone[norm] = [];
    byPhone[norm].push({ responseId: rid, submittedAt: atStr, sortKey: atMs, rowIndex: i });
  }

  var entries = [];       // 추첨 대상 풀 — 번호당 "가장 최근 제출" 1건만 포함
  var duplicatesMap = {}; // 번호당 2건 이상 제출된 경우 (관리자 조회용)
  Object.keys(byPhone).forEach(function(norm) {
    var list = byPhone[norm].slice().sort(function(a, b) {
      // 타임스탬프 우선, 파싱 실패(0)로 동률이면 시트 행 순서(뒤에 추가된 행이 최신)로 판정
      return (a.sortKey - b.sortKey) || (a.rowIndex - b.rowIndex);
    });
    var latest = list[list.length - 1];
    entries.push({ phone: norm, responseId: latest.responseId, submittedAt: latest.submittedAt });
    if (list.length > 1) duplicatesMap[norm] = list;
  });

  return { entries: entries, duplicatesMap: duplicatesMap };
}

// ── 랜덤 추첨 실행 (관리자, 1회만 가능) ──
function raffleRun(data) {
  if (!isValidPassword(data.password || '')) return makeResponse({ success: false, error: 'UNAUTHORIZED' });

  var ss = SpreadsheetApp.openById(SHEET_ID);
  raffleEnsureSheets(ss);
  var configSheet = ss.getSheetByName(RAFFLE_SHEET_CONFIG);
  var configMap   = raffleGetConfigMap(ss);

  if (configMap.executed === 'TRUE') {
    return makeResponse({ success: false, error: 'ALREADY_EXECUTED' });
  }

  var eligible = raffleGetEligibleEntries(ss);
  var pool = eligible.entries.slice();
  // Fisher–Yates shuffle
  for (var i = pool.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
  }

  var resultsSheet = getOrCreateSheet(ss, RAFFLE_SHEET_RESULTS, RAFFLE_RESULTS_HEADERS);
  var now = new Date();
  var drawnAt = Utilities.formatDate(now, 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss');

  var cursor = 0;
  var summary = [];
  RAFFLE_PRIZE_TIERS.forEach(function(tierDef) {
    var count = 0;
    for (; count < tierDef.count && cursor < pool.length; count++, cursor++) {
      var entry = pool[cursor];
      resultsSheet.appendRow([entry.phone, tierDef.tier, tierDef.prize, drawnAt, 'FALSE', '', entry.responseId]);
    }
    summary.push({ tier: tierDef.tier, drawn: count, planned: tierDef.count });
  });

  raffleSetConfigValue(ss, configSheet, 'executed', 'TRUE');
  raffleSetConfigValue(ss, configSheet, 'executedAt', drawnAt);
  raffleSetConfigValue(ss, configSheet, 'revealEnabled', 'FALSE');
  raffleSetConfigValue(ss, configSheet, 'eligibleCount', String(pool.length));

  raffleWriteLog(ss, 'RUN', '추첨 실행 완료 — 참여번호(중복제거) ' + pool.length + '명 / 당첨 배정 ' + cursor + '명');
  return makeResponse({ success: true, executedAt: drawnAt, eligibleCount: pool.length, summary: summary });
}

// ── 추첨 초기화 (관리자 전용, 백업 후 재추첨 가능 상태로 복구) ──
function raffleReset(data) {
  if (!isValidPassword(data.password || '')) return makeResponse({ success: false, error: 'UNAUTHORIZED' });
  if (String(data.confirm || '') !== 'RESET') return makeResponse({ success: false, error: 'CONFIRM_REQUIRED' });

  var ss = SpreadsheetApp.openById(SHEET_ID);
  raffleEnsureSheets(ss);

  var now = new Date();
  var timestamp = Utilities.formatDate(now, 'Asia/Seoul', 'yyyyMMdd_HHmmss');
  var backupName = 'raffle_results_backup_' + timestamp;

  var resultsSheet = ss.getSheetByName(RAFFLE_SHEET_RESULTS);
  var backedUpCount = 0;
  if (resultsSheet) {
    backedUpCount = Math.max(0, resultsSheet.getLastRow() - 1);
    if (backedUpCount > 0) {
      resultsSheet.copyTo(ss).setName(backupName);
    }
    ss.deleteSheet(resultsSheet);
  }
  getOrCreateSheet(ss, RAFFLE_SHEET_RESULTS, RAFFLE_RESULTS_HEADERS);

  var configSheet = getOrCreateSheet(ss, RAFFLE_SHEET_CONFIG, RAFFLE_CONFIG_HEADERS);
  raffleSetConfigValue(ss, configSheet, 'executed', 'FALSE');
  raffleSetConfigValue(ss, configSheet, 'executedAt', '');
  raffleSetConfigValue(ss, configSheet, 'revealEnabled', 'FALSE');

  raffleWriteLog(ss, 'RESET', '추첨 초기화 완료 — 백업: ' + (backedUpCount > 0 ? backupName : '(기존 데이터 없음)') + ' / ' + backedUpCount + '건');
  return makeResponse({ success: true, backupName: backedUpCount > 0 ? backupName : null, backedUpCount: backedUpCount });
}

// ── 당첨확인 공개 여부 전환 (관리자 전용) ──
function raffleToggleReveal(data) {
  if (!isValidPassword(data.password || '')) return makeResponse({ success: false, error: 'UNAUTHORIZED' });

  var ss = SpreadsheetApp.openById(SHEET_ID);
  raffleEnsureSheets(ss);
  var configMap = raffleGetConfigMap(ss);
  if (configMap.executed !== 'TRUE') {
    return makeResponse({ success: false, error: 'NOT_EXECUTED' });
  }

  var enabled = (data.enabled === true || String(data.enabled) === 'true');
  var configSheet = ss.getSheetByName(RAFFLE_SHEET_CONFIG);
  raffleSetConfigValue(ss, configSheet, 'revealEnabled', enabled ? 'TRUE' : 'FALSE');
  raffleWriteLog(ss, 'TOGGLE_REVEAL', '당첨 공개 상태 변경 → ' + (enabled ? '공개' : '비공개'));
  return makeResponse({ success: true, revealEnabled: enabled });
}

// ── 추첨 진행 상태 조회 (공개 API — 비밀번호 불필요, 개인정보 미포함) ──
function raffleStatus() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  raffleEnsureSheets(ss);
  var configMap = raffleGetConfigMap(ss);
  var eligible  = raffleGetEligibleEntries(ss);
  return makeResponse({
    success: true,
    executed: configMap.executed === 'TRUE',
    revealEnabled: configMap.revealEnabled === 'TRUE',
    executedAt: configMap.executedAt || '',
    eligibleCount: eligible.entries.length,
    duplicateCount: Object.keys(eligible.duplicatesMap).length,
    tiers: RAFFLE_PRIZE_TIERS
  });
}

// ── 휴대폰 번호로 본인 당첨 여부 확인 (공개 API — 비밀번호 불필요) ──
// 이름/연락처 전체/전체 당첨자 명단은 절대 반환하지 않고, 입력한 번호 1건의 결과만 반환합니다.
function raffleCheck(data) {
  var phone = raffleNormalizePhone(data.phone);
  if (!phone) return makeResponse({ success: false, error: 'NO_PHONE' });

  var ss = SpreadsheetApp.openById(SHEET_ID);
  raffleEnsureSheets(ss);
  var configMap = raffleGetConfigMap(ss);

  if (configMap.executed !== 'TRUE' || configMap.revealEnabled !== 'TRUE') {
    return makeResponse({ success: true, revealEnabled: false });
  }

  var eligible = raffleGetEligibleEntries(ss);
  var isParticipant = eligible.entries.some(function(e) { return e.phone === phone; });
  if (!isParticipant) {
    raffleWriteLog(ss, 'CHECK_NOT_FOUND', '참여내역 없음 조회 (' + raffleMaskPhone(phone) + ')');
    return makeResponse({ success: true, revealEnabled: true, found: false });
  }

  var resultsSheet = ss.getSheetByName(RAFFLE_SHEET_RESULTS);
  var rows = resultsSheet ? sheetToObjects(ss, RAFFLE_SHEET_RESULTS) : [];
  var idx = -1, row = null;
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].phone === phone) { row = rows[i]; idx = i; break; }
  }

  if (!row) {
    raffleWriteLog(ss, 'CHECK_LOSE', '낙첨 확인 (' + raffleMaskPhone(phone) + ')');
    return makeResponse({ success: true, revealEnabled: true, found: true, won: false });
  }

  if (row.confirmed !== 'TRUE') {
    var sheetRowNum = idx + 2; // 헤더(1행) + 1-index 보정
    var nowStr = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss');
    resultsSheet.getRange(sheetRowNum, 5).setValue('TRUE');   // confirmed
    resultsSheet.getRange(sheetRowNum, 6).setValue(nowStr);   // confirmedAt
    row.confirmed = 'TRUE';
    row.confirmedAt = nowStr;
    raffleWriteLog(ss, 'CONFIRM', row.tier + ' 당첨 확인 (' + raffleMaskPhone(phone) + ')');
  }

  return makeResponse({
    success: true, revealEnabled: true, found: true, won: true,
    tier: row.tier, prize: row.prize, confirmedAt: row.confirmedAt
  });
}

// ── 당첨자 목록 조회 (관리자 전용) ──
function raffleWinners() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  raffleEnsureSheets(ss);
  var rows = sheetToObjects(ss, RAFFLE_SHEET_RESULTS);
  return makeResponse({ success: true, data: rows });
}

// ── 동일 번호 중복 제출 현황 조회 (관리자 전용) ──
function raffleDuplicates() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var eligible = raffleGetEligibleEntries(ss);
  var list = Object.keys(eligible.duplicatesMap).map(function(phone) {
    return { phone: phone, count: eligible.duplicatesMap[phone].length, entries: eligible.duplicatesMap[phone] };
  });
  return makeResponse({ success: true, data: list });
}

// ════════════════════════════════════════════════════════════════════
// ══                    /추첨(Raffle) 기능 끝                          ══
// ════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════
// 테스트 함수 — Apps Script 편집기에서 실행
// ════════════════════════════════════════════════════════════════════
function testDoPost_general() {
  var testData = {
    participantType: '일반사용자',
    respondentName: '테스트 일반',
    respondentPhone: '010-1111-2222',
    개인정보동의: '동의',
    개인정보동의일시: '2026-07-01 12:00:00',
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
    respondentName: '테스트 임직원',
    respondentPhone: '010-3333-4444',
    개인정보동의: '동의',
    개인정보동의일시: '2026-07-01 12:00:00'
  };
  for (var i = 1; i <= 25; i++) testData['임직원_Q' + i] = '테스트 응답 ' + i;
  var result = doPost({ postData: { contents: JSON.stringify(testData) }, parameter: testData });
  Logger.log('testDoPost_employee 결과: ' + result.getContent());
}

function testDoPost_partner() {
  var testData = {
    participantType: '파트너',
    respondentName: '테스트 파트너',
    respondentPhone: '010-5555-6666',
    개인정보동의: '동의',
    개인정보동의일시: '2026-07-01 12:00:00'
  };
  for (var i = 1; i <= 22; i++) testData['파트너_Q' + i] = '테스트 응답 ' + i;
  testData['파트너_Q21'] = '3%';
  testData['파트너_Q22'] = '테스트 수수료 의견';
  // 파트너 추가 질문 (영문 필드명으로 제출됨)
  testData['partner_settlement_priority']       = '기타';
  testData['partner_settlement_priority_etc']   = '정산 기타 의견 테스트';
  testData['partner_fee_burden_type']           = '건당 고정 수수료, 결제 금액 비율 수수료';
  testData['partner_fee_burden_type_etc']       = '';
  testData['partner_required_support']          = '고객 의뢰 / 견적 요청 노출, 기타';
  testData['partner_required_support_etc']      = '입점 지원 기타 의견 테스트';
  testData['partner_must_not_be_inconvenient']  = '정산 지연이 절대 없어야 합니다.';
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

// responses 시트에 RESPONSE_HEADERS 중 누락된 헤더를 맨 뒤에 추가 (기존 컬럼 순서/데이터 유지)
function ensureResponseHeaders(sheet) {
  var lastCol = sheet.getLastColumn();
  var headerRow = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String) : [];
  RESPONSE_HEADERS.forEach(function(h) {
    if (headerRow.indexOf(h) === -1) {
      var newCol = sheet.getLastColumn() + 1;
      var cell = sheet.getRange(1, newCol);
      cell.setValue(h);
      cell.setFontWeight('bold').setBackground('#1a56db').setFontColor('#ffffff');
      headerRow.push(h);
    }
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
