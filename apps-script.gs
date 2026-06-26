// ════════════════════════════════════════════════════════════
// 만능맨 베타테스트 피드백 설문 — Google Apps Script 백엔드
// ════════════════════════════════════════════════════════════
//
// 설정 방법:
//   1. Google Sheets를 새로 만들고 URL에서 스프레드시트 ID를 복사한다.
//      예) https://docs.google.com/spreadsheets/d/[여기가 SHEET_ID]/edit
//   2. SHEET_ID 값을 아래에 붙여넣는다.
//   3. 관리자 비밀번호를 ADMIN_PASSWORD에 설정한다.
//   4. 이 코드를 Apps Script에 붙여넣고 저장한다.
//   5. 배포 → 새 배포 → 웹 앱 → "나로 실행", "모든 사용자" 선택 후 배포한다.
//   6. 발급된 URL을 survey.html과 admin.html의 SCRIPT_URL에 붙여넣는다.
//
// ════════════════════════════════════════════════════════════

// ── 변경 필요 상수 ──────────────────────────────────────────
const SHEET_ID       = '11QGLJdAHbc5qU4Xo8UAKfh867AM0y_R6I3bY5JHDwB4';  // ★ 필수 변경
const ADMIN_PASSWORD = '9923';                         // ★ 필요시 변경
// ────────────────────────────────────────────────────────────

const SHEET_RESPONSES      = 'responses';
const SHEET_CONTACTS       = 'contacts';
const SHEET_SETTINGS       = 'settings';
const SHEET_LOGS           = 'logs';
const SHEET_RESPONSES_VIEW = 'responses_view';

// responses 시트 컬럼 순서 (15문항 기준) — 절대 변경 금지
const RESPONSE_HEADERS = [
  'submittedAt', 'responseId',
  'participantType', 'testRole',
  'gender', 'ageGroup',
  'testDevice', 'phoneType', 'pcType',
  'serviceUnderstanding', 'nextActionEase',
  'estimateButtonFindability', 'categoryPreQuestionEase', 'estimatePainPoints',
  'expertTrust', 'chatPrivacyEase', 'contractPaymentUnderstanding',
  'urgentFeedback'
];

const CONTACT_HEADERS = ['submittedAt', 'responseId', 'name', 'phone', 'privacyConsent'];

const LOG_HEADERS = ['loggedAt', 'type', 'message', 'detail'];

// ── responses_view A열 라벨 (survey.html 실제 질문 문구 기준) ──
const VIEW_LABELS = {
  responseId:                   '응답번호',
  submittedAt:                  '제출일시',
  participantType:              'Q1. 테스트 참여자 유형을 선택해주세요.',
  testRole:                     'Q2. 이번 테스트는 어떤 입장에서 확인하셨나요?',
  gender:                       'Q3. 성별을 선택해주세요.',
  ageGroup:                     'Q4. 연령대를 선택해주세요.',
  testDevice:                   'Q5. 테스트한 기기를 선택해주세요.',
  phoneType:                    '↳ 어떤 휴대폰을 사용하셨나요?',
  pcType:                       '↳ 어떤 PC 환경을 사용하셨나요?',
  serviceUnderstanding:         'Q6. 첫 화면을 보고 만능맨이 어떤 서비스인지 이해되었나요?',
  nextActionEase:               'Q7. 만능맨에서 무엇을 해야 하는지, 다음 행동을 찾기 쉬웠나요?',
  estimateButtonFindability:    'Q8. 견적요청을 시작하는 버튼이나 위치를 쉽게 찾을 수 있었나요?',
  categoryPreQuestionEase:      'Q9. 내가 겪는 문제에 맞는 카테고리와 사전질문을 선택하기 쉬웠나요?',
  estimatePainPoints:           'Q10. 견적요청 과정에서 가장 불편했던 부분은 무엇인가요?',
  expertTrust:                  'Q11. 전문가 프로필을 보고 신뢰감이 들었나요?',
  chatPrivacyEase:              'Q12. 채팅/상담 기능은 사용하기 편하고 개인정보가 안전하게 느껴졌나요?',
  contractPaymentUnderstanding: 'Q13. 여러 전문가 중 선택하거나 계약/결제/에스크로로 이어지는 흐름이 이해되었나요?',
  urgentFeedback:               'Q14. 사용 중 오류, 불편했던 점, 또는 정식 오픈 전 가장 먼저 고쳐야 할 점을 적어주세요.',
  name:                         '이름',
  phone:                        '연락처',
  privacyConsent:               '개인정보 수집·이용 동의 여부'
};

// responses_view 세로형 블록에 표시할 필드 순서 (header에서 responseId를 보여주므로 data 행에서 제외)
const VIEW_ORDER = [
  'submittedAt',
  'participantType', 'testRole',
  'gender', 'ageGroup',
  'testDevice', 'phoneType', 'pcType',
  'serviceUnderstanding', 'nextActionEase',
  'estimateButtonFindability', 'categoryPreQuestionEase', 'estimatePainPoints',
  'expertTrust', 'chatPrivacyEase', 'contractPaymentUnderstanding',
  'urgentFeedback',
  'name', 'phone', 'privacyConsent'
];

// ════════════════════════════════════════════════════════════
// doPost — 설문 응답 저장
// ════════════════════════════════════════════════════════════
function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.tryLock(15000);

  try {
    let data;
    const rawBody = (e.postData && e.postData.contents) ? e.postData.contents : '';
    try {
      data = JSON.parse(rawBody);
    } catch (_) {
      // URL-encoded form data 직접 파싱 (application/x-www-form-urlencoded)
      data = {};
      if (rawBody) {
        rawBody.split('&').forEach(pair => {
          if (!pair) return;
          const eq = pair.indexOf('=');
          if (eq < 0) return;
          const k = decodeURIComponent(pair.slice(0, eq).replace(/\+/g, ' '));
          const v = decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' '));
          if (k) data[k] = v;
        });
      }
      if (!Object.keys(data).length) data = e.parameter || {};
    }

    const consentValue = String(data.privacyConsent || '').toLowerCase().trim();
    if (!['true', 'on', '1', 'yes'].includes(consentValue)) {
      writeLog('WARN', '동의 없는 제출 시도', JSON.stringify(data));
      return makeResponse({ success: false, error: 'CONSENT_REQUIRED' });
    }

    const ss = SpreadsheetApp.openById(SHEET_ID);
    const now = new Date();
    const submittedAt = Utilities.formatDate(now, 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss');
    const responseId = 'R' + now.getTime().toString().slice(-8) +
                       Math.random().toString(36).slice(2, 5).toUpperCase();

    // responses 시트에 저장 (원본 — 구조 변경 금지)
    const respSheet = getOrCreateSheet(ss, SHEET_RESPONSES, RESPONSE_HEADERS);
    const respRow = RESPONSE_HEADERS.map(key => {
      if (key === 'submittedAt') return submittedAt;
      if (key === 'responseId')  return responseId;
      return data[key] !== undefined ? String(data[key]) : '';
    });
    respSheet.appendRow(respRow);

    // contacts 시트에 저장
    const contactSheet = getOrCreateSheet(ss, SHEET_CONTACTS, CONTACT_HEADERS);
    contactSheet.appendRow([
      submittedAt, responseId,
      data.name  || '',
      data.phone || '',
      'true'
    ]);

    writeLog('INFO', '응답 저장 완료', responseId);

    // responses_view 보기용 저장 (실패해도 원본 응답에 영향 없음)
    appendReadableResponse(ss, submittedAt, responseId, data);

    return makeResponse({ success: true, responseId });

  } catch (err) {
    const errDetail = err.stack || err.message || JSON.stringify(err);
    writeLog('ERROR', 'doPost 실패', errDetail);
    return makeResponse({ success: false, error: err.message });
  } finally {
    lock.releaseLock();
  }
}

// ════════════════════════════════════════════════════════════
// doGet — 관리자 데이터 조회
// ════════════════════════════════════════════════════════════
function doGet(e) {
  try {
    const action   = e.parameter.action   || '';
    const password = e.parameter.password || '';

    if (!isValidPassword(password)) {
      writeLog('WARN', '비밀번호 오류', action);
      return makeResponse({ success: false, error: 'UNAUTHORIZED' });
    }

    switch (action) {
      case 'list':     return handleList(e.parameter);
      case 'detail':   return handleDetail(e.parameter.responseId);
      case 'summary':  return handleSummary();
      case 'opinions': return handleOpinions();
      case 'csv':      return handleCsv();
      default:
        return makeResponse({ success: false, error: 'UNKNOWN_ACTION' });
    }
  } catch (err) {
    writeLog('ERROR', 'doGet 실패', err.message);
    return makeResponse({ success: false, error: err.message });
  }
}

// ────────────────────────────────
// action=list
// ────────────────────────────────
function handleList(params) {
  const ss   = SpreadsheetApp.openById(SHEET_ID);
  const data = sheetToObjects(ss, SHEET_RESPONSES);
  const safe = data.map(r => omitPrivate(r));
  return makeResponse({ success: true, data: safe });
}

// ────────────────────────────────
// action=detail
// ────────────────────────────────
function handleDetail(responseId) {
  if (!responseId) return makeResponse({ success: false, error: 'NO_ID' });
  const ss   = SpreadsheetApp.openById(SHEET_ID);
  const rows = sheetToObjects(ss, SHEET_RESPONSES);
  const row  = rows.find(r => r.responseId === responseId);
  if (!row) return makeResponse({ success: false, error: 'NOT_FOUND' });

  const contacts = sheetToObjects(ss, SHEET_CONTACTS);
  const contact  = contacts.find(c => c.responseId === responseId) || {};
  return makeResponse({ success: true, data: { ...row, ...contact } });
}

// ────────────────────────────────
// action=summary
// ────────────────────────────────
function handleSummary() {
  const ss   = SpreadsheetApp.openById(SHEET_ID);
  const data = sheetToObjects(ss, SHEET_RESPONSES);
  const n    = data.length;
  const today = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd');

  const summary = {
    totalCount:   n,
    todayCount:   data.filter(r => r.submittedAt && r.submittedAt.startsWith(today)).length,
    feedbackCount: data.filter(r => r.urgentFeedback && r.urgentFeedback.trim()).length,
  };
  return makeResponse({ success: true, data: summary });
}

// ────────────────────────────────
// action=opinions (Q14 urgentFeedback 중심)
// ────────────────────────────────
function handleOpinions() {
  const ss   = SpreadsheetApp.openById(SHEET_ID);
  const data = sheetToObjects(ss, SHEET_RESPONSES);
  const result = {
    urgentFeedback: data
      .filter(r => r.urgentFeedback && r.urgentFeedback.trim())
      .map(r => ({ responseId: r.responseId, submittedAt: r.submittedAt, participantType: r.participantType, ageGroup: r.ageGroup, value: r.urgentFeedback }))
  };
  return makeResponse({ success: true, data: result });
}

// ────────────────────────────────
// action=csv
// ────────────────────────────────
function handleCsv() {
  const ss   = SpreadsheetApp.openById(SHEET_ID);
  const data = sheetToObjects(ss, SHEET_RESPONSES).map(r => omitPrivate(r));
  return makeResponse({ success: true, data });
}

// ════════════════════════════════════════════════════════════
// responses_view 보기용 시트 — 세로형 블록 저장
// ════════════════════════════════════════════════════════════

function getOrCreateViewSheet(ss) {
  let sheet = ss.getSheetByName(SHEET_RESPONSES_VIEW);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_RESPONSES_VIEW);
    sheet.setColumnWidth(1, 220);
    sheet.setColumnWidth(2, 700);
  }
  return sheet;
}

// responses_view에 응답 1건을 세로형 블록으로 추가한다.
// 실패해도 원본 responses 저장에 영향 없도록 내부에서 try/catch 처리.
function appendReadableResponse(ss, submittedAt, responseId, data) {
  try {
    const sheet = getOrCreateViewSheet(ss);

    // 기존 블록 수 카운트 → 응답 번호 산출
    const lastRow = sheet.getLastRow();
    let responseNum = 1;
    if (lastRow > 0) {
      const colA = sheet.getRange(1, 1, lastRow, 1).getValues();
      responseNum = colA.filter(function(r) {
        return String(r[0]).match(/^응답\s+\d+/);
      }).length + 1;
    }

    const startRow = lastRow + 1;

    // 블록 행 구성
    const rows = [];

    // 첫 행: 응답 N / responseId
    rows.push(['응답 ' + responseNum, responseId]);

    // 나머지 필드 (VIEW_ORDER 순서)
    VIEW_ORDER.forEach(function(key) {
      const label = VIEW_LABELS[key] || key;
      const raw   = data[key];
      const val   = (raw !== undefined && raw !== null && String(raw).trim() !== '')
                    ? String(raw) : '-';
      rows.push([label, val]);
    });

    // 구분용 빈 줄 2행
    rows.push(['', '']);
    rows.push(['', '']);

    // 일괄 기록
    const range = sheet.getRange(startRow, 1, rows.length, 2);
    range.setValues(rows);

    // ── 첫 행 스타일 (응답 번호 헤더) ──
    const headerRange = sheet.getRange(startRow, 1, 1, 2);
    headerRange.setBackground('#1a56db');
    headerRange.setFontColor('#ffffff');
    headerRange.setFontWeight('bold');
    headerRange.setFontSize(12);

    // ── A열 (라벨) 굵게 ──
    const dataRowCount = rows.length - 3; // 첫 행(헤더) + 빈 줄 2행 제외
    if (dataRowCount > 0) {
      sheet.getRange(startRow + 1, 1, dataRowCount, 1).setFontWeight('bold');
    }

    // ── B열 (응답값) 줄바꿈 ──
    sheet.getRange(startRow, 2, rows.length, 1).setWrap(true);

    writeLog('INFO', '보기용 응답 저장 완료', responseId);
  } catch (err) {
    writeLog('ERROR', '보기용 응답 저장 실패', (err.stack || err.message || String(err)));
  }
}

// ════════════════════════════════════════════════════════════
// 기존 데이터 재정리 — Apps Script 편집기에서 직접 실행
// rebuildReadableResponses()
// ════════════════════════════════════════════════════════════
function rebuildReadableResponses() {
  const ss = SpreadsheetApp.openById(SHEET_ID);

  // responses_view 초기화 (기존 원본 responses 시트는 건드리지 않음)
  let viewSheet = ss.getSheetByName(SHEET_RESPONSES_VIEW);
  if (viewSheet) {
    viewSheet.clearContents();
    viewSheet.clearFormats();
    viewSheet.setColumnWidth(1, 220);
    viewSheet.setColumnWidth(2, 700);
  } else {
    viewSheet = getOrCreateViewSheet(ss);
  }

  const responses = sheetToObjects(ss, SHEET_RESPONSES);
  const contacts  = sheetToObjects(ss, SHEET_CONTACTS);

  if (responses.length === 0) {
    Logger.log('rebuildReadableResponses: responses 시트에 데이터가 없습니다.');
    return;
  }

  responses.forEach(function(resp) {
    const contact = contacts.find(function(c) { return c.responseId === resp.responseId; }) || {};
    const merged  = Object.assign({}, resp, {
      name:           contact.name           || '',
      phone:          contact.phone          || '',
      privacyConsent: contact.privacyConsent || 'true'
    });
    appendReadableResponse(ss, merged.submittedAt, merged.responseId, merged);
  });

  Logger.log('rebuildReadableResponses 완료: ' + responses.length + '건 재정리');
}

// ════════════════════════════════════════════════════════════
// 백엔드 단독 테스트 (Apps Script 편집기에서 직접 실행)
// testDoPost() 실행 후 responses / contacts / responses_view 시트에 테스트 행 확인
// ════════════════════════════════════════════════════════════
function testDoPost() {
  const testData = {
    participantType: '임직원',
    testRole: '사용자와 파트너스 양쪽 모두 확인',
    gender: '남성',
    ageGroup: '30대',
    testDevice: 'PC',
    phoneType: '',
    pcType: '윈도우 PC',
    serviceUnderstanding: '매우 잘 이해됐다',
    nextActionEase: '매우 쉬웠다',
    estimateButtonFindability: '매우 쉽게 찾았다',
    categoryPreQuestionEase: '매우 쉬웠다',
    estimatePainPoints: '특별히 불편한 점 없음',
    expertTrust: '매우 신뢰가 갔다',
    chatPrivacyEase: '편하고 안전하게 느껴졌다',
    contractPaymentUnderstanding: '쉽게 이해됐다',
    urgentFeedback: '[testDoPost 테스트 데이터 — 확인 후 삭제하세요]',
    name: '테스트',
    phone: '010-0000-0000',
    privacyConsent: 'true'
  };

  const mockEvent = {
    postData: { contents: JSON.stringify(testData) },
    parameter: testData
  };

  const result = doPost(mockEvent);
  Logger.log('testDoPost 결과: ' + result.getContent());
}

// ════════════════════════════════════════════════════════════
// 시트 헤더 자동 복구 — 헤더 행이 없는 시트를 자동으로 수정합니다.
// Apps Script 편집기에서 직접 실행: fixSheets()
// ════════════════════════════════════════════════════════════
function fixSheets() {
  const ss = SpreadsheetApp.openById(SHEET_ID);

  const targets = [
    { name: SHEET_RESPONSES, headers: RESPONSE_HEADERS },
    { name: SHEET_CONTACTS,  headers: CONTACT_HEADERS },
    { name: SHEET_LOGS,      headers: LOG_HEADERS }
  ];

  targets.forEach(function(target) {
    const sheet = ss.getSheetByName(target.name);
    if (!sheet) {
      Logger.log('[fixSheets] ' + target.name + ': 시트 없음 → 새로 생성');
      getOrCreateSheet(ss, target.name, target.headers);
      return;
    }

    const lastRow = sheet.getLastRow();
    if (lastRow === 0) {
      Logger.log('[fixSheets] ' + target.name + ': 비어있음 → 헤더 추가');
      sheet.appendRow(target.headers);
      applyHeaderStyle(sheet, target.headers.length);
      return;
    }

    const firstCellValue = String(sheet.getRange(1, 1).getValue());
    if (firstCellValue === target.headers[0]) {
      Logger.log('[fixSheets] ' + target.name + ': 헤더 정상 (건너뜀)');
      return;
    }

    Logger.log('[fixSheets] ' + target.name + ': 헤더 없음 → 1행에 삽입');
    sheet.insertRowBefore(1);
    sheet.getRange(1, 1, 1, target.headers.length).setValues([target.headers]);
    applyHeaderStyle(sheet, target.headers.length);
  });

  Logger.log('[fixSheets] 완료 — 관리자 페이지에서 데이터를 확인하세요.');
}

function applyHeaderStyle(sheet, colCount) {
  const range = sheet.getRange(1, 1, 1, colCount);
  range.setFontWeight('bold');
  range.setBackground('#1a56db');
  range.setFontColor('#ffffff');
  sheet.setFrozenRows(1);
}

// ════════════════════════════════════════════════════════════
// 초기 시트 세팅 (최초 1회 실행 권장)
// Apps Script 편집기에서 직접 실행: setupSheets()
// ════════════════════════════════════════════════════════════
function setupSheets() {
  const ss = SpreadsheetApp.openById(SHEET_ID);

  getOrCreateSheet(ss, SHEET_RESPONSES, RESPONSE_HEADERS);
  getOrCreateSheet(ss, SHEET_CONTACTS,  CONTACT_HEADERS);

  const settingsSheet = getOrCreateSheet(ss, SHEET_SETTINGS, ['key', 'value']);
  if (settingsSheet.getLastRow() < 2) {
    settingsSheet.appendRow(['surveyActive',   'TRUE']);
    settingsSheet.appendRow(['adminPassword',  ADMIN_PASSWORD]);
  }

  getOrCreateSheet(ss, SHEET_LOGS, LOG_HEADERS);

  // responses_view 생성 (기존 데이터 있으면 보존)
  getOrCreateViewSheet(ss);

  Logger.log('시트 초기 세팅 완료');
}

// ════════════════════════════════════════════════════════════
// 헬퍼 함수
// ════════════════════════════════════════════════════════════

function sheetToObjects(ss, sheetName) {
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return [];
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0];
  return values.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i] !== undefined ? String(row[i]) : ''; });
    return obj;
  });
}

function getOrCreateSheet(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
    const headerRange = sheet.getRange(1, 1, 1, headers.length);
    headerRange.setFontWeight('bold');
    headerRange.setBackground('#1a56db');
    headerRange.setFontColor('#ffffff');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function omitPrivate(r) {
  const obj = Object.assign({}, r);
  delete obj.name;
  delete obj.phone;
  return obj;
}

function isValidPassword(pw) {
  try {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const settings = sheetToObjects(ss, SHEET_SETTINGS);
    const row = settings.find(s => s.key === 'adminPassword');
    const stored = row ? row.value : ADMIN_PASSWORD;
    return pw === stored;
  } catch (_) {
    return pw === ADMIN_PASSWORD;
  }
}

function makeResponse(obj) {
  const output = ContentService.createTextOutput(JSON.stringify(obj));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}

function writeLog(type, message, detail) {
  try {
    const ss    = SpreadsheetApp.openById(SHEET_ID);
    const sheet = getOrCreateSheet(ss, SHEET_LOGS, LOG_HEADERS);
    const now   = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss');
    sheet.appendRow([now, type, message, detail]);
  } catch (_) {
    Logger.log('[LOG FAIL] ' + type + ': ' + message);
  }
}
