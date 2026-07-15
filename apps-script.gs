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
// 공통 5 + 일반 15 + 임직원 25 + 파트너(구) 22 + 관리 2 + 동의 2 + 파트너추가 7
// + 설문버전 1 + 파트너V2(구) 33 + 파트너V3(구) 55 + 파트너간략(신규) 26 = 193컬럼
// 파트너(구)/파트너추가/파트너V2/파트너V3 컬럼은 화면에서는 폐기되었지만 과거 응답 보존을 위해 그대로 유지된다.
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

// ════════════════════════════════════════════════════════════
// 파트너 설문 v2 — 기존 파트너_Q*/파트너 추가질문은 화면에서 폐기되었지만
// 컬럼/데이터는 그대로 보존한다. 신규 24문항은 전부 partner_v2_ 접두 colKey를
// 쓰며, 시트 헤더는 "맨 뒤"에 추가되어 기존 컬럼 순서에 영향을 주지 않는다.
// ════════════════════════════════════════════════════════════
var SURVEY_VERSION_COL = ['surveyVersion'];

var PARTNER_V2_COLS = [
  '파트너V2_업체명', '파트너V2_활동지역', '파트너V2_주요작업분야', '파트너V2_주요작업분야_기타',
  '파트너V2_서비스이해도', '파트너V2_견적흐름', '파트너V2_요청정보충분성',
  '파트너V2_필요요청정보', '파트너V2_필요요청정보_기타',
  '파트너V2_유용할것같은기능', '파트너V2_유용할것같은기능_기타',
  '파트너V2_주요우려사항', '파트너V2_주요우려사항_기타',
  '파트너V2_타플랫폼경험',
  '파트너V2_경쟁력강점', '파트너V2_경쟁력강점_기타',
  '파트너V2_경쟁력우선순위', '파트너V2_경쟁력우선순위_기타',
  '파트너V2_이용료방식', '파트너V2_이용료방식_기타',
  '파트너V2_이용료_30만원미만', '파트너V2_이용료_30만원~100만원', '파트너V2_이용료_100만원이상',
  '파트너V2_이용료시나리오의향',
  '파트너V2_이용료보호정책', '파트너V2_이용료보호정책_기타',
  '파트너V2_안전결제',
  '파트너V2_플랫폼보호역할', '파트너V2_플랫폼보호역할_기타',
  '파트너V2_보증제도의향',
  '파트너V2_참여의향',
  '파트너V2_가장중요한개선점',
  '파트너V2_추가제안'
];
// 시트 헤더명(한글) ← 설문 페이지 제출 필드명(영문 partner_v2_* colKey) 매핑
var PARTNER_V2_FIELD_MAP = {
  '파트너V2_업체명':               'partner_v2_company_name',
  '파트너V2_활동지역':             'partner_v2_service_area',
  '파트너V2_주요작업분야':         'partner_v2_service_category',
  '파트너V2_주요작업분야_기타':    'partner_v2_service_category_etc',
  '파트너V2_서비스이해도':         'partner_v2_service_understanding',
  '파트너V2_견적흐름':             'partner_v2_quote_flow',
  '파트너V2_요청정보충분성':       'partner_v2_request_information',
  '파트너V2_필요요청정보':         'partner_v2_required_request_info',
  '파트너V2_필요요청정보_기타':    'partner_v2_required_request_info_etc',
  '파트너V2_유용할것같은기능':      'partner_v2_expected_useful_features',
  '파트너V2_유용할것같은기능_기타': 'partner_v2_expected_useful_features_etc',
  '파트너V2_주요우려사항':         'partner_v2_main_concerns',
  '파트너V2_주요우려사항_기타':    'partner_v2_main_concerns_etc',
  '파트너V2_타플랫폼경험':         'partner_v2_competitor_experience',
  '파트너V2_경쟁력강점':           'partner_v2_competitive_strength',
  '파트너V2_경쟁력강점_기타':      'partner_v2_competitive_strength_etc',
  '파트너V2_경쟁력우선순위':       'partner_v2_competitive_priority',
  '파트너V2_경쟁력우선순위_기타':  'partner_v2_competitive_priority_etc',
  '파트너V2_이용료방식':           'partner_v2_fee_method',
  '파트너V2_이용료방식_기타':      'partner_v2_fee_method_etc',
  '파트너V2_이용료_30만원미만':          'partner_v2_fee_under_300k',
  '파트너V2_이용료_30만원~100만원':      'partner_v2_fee_300k_1m',
  '파트너V2_이용료_100만원이상':         'partner_v2_fee_over_1m',
  '파트너V2_이용료시나리오의향':   'partner_v2_fee_scenario_intent',
  '파트너V2_이용료보호정책':       'partner_v2_fee_protection',
  '파트너V2_이용료보호정책_기타':  'partner_v2_fee_protection_etc',
  '파트너V2_안전결제':             'partner_v2_safe_payment',
  '파트너V2_플랫폼보호역할':       'partner_v2_platform_protection_role',
  '파트너V2_플랫폼보호역할_기타':  'partner_v2_platform_protection_role_etc',
  '파트너V2_보증제도의향':         'partner_v2_guarantee_intent',
  '파트너V2_참여의향':             'partner_v2_participation_intent',
  '파트너V2_가장중요한개선점':     'partner_v2_most_important_improvement',
  '파트너V2_추가제안':             'partner_v2_additional_suggestion'
};

// ════════════════════════════════════════════════════════════
// 파트너 설문 v3 — 파트너v2 화면 설문도 폐기되었지만 컬럼/데이터는 그대로 보존한다.
// 신규 Q1~Q24(+조건부 추가질문 13개)는 전부 partner_v3_ 접두 colKey를 쓰며,
// 시트 헤더는 "맨 뒤"에 추가되어 기존 컬럼 순서에 영향을 주지 않는다.
// ════════════════════════════════════════════════════════════
var PARTNER_V3_COLS = [
  '파트너V3_업체명', '파트너V3_활동지역',
  '파트너V3_주요작업분야', '파트너V3_주요작업분야_기타',
  '파트너V3_서비스이해도',
  '파트너V3_이해어려운부분', '파트너V3_이해어려운부분_기타',
  '파트너V3_견적흐름',
  '파트너V3_견적흐름_불편과정', '파트너V3_견적흐름_불편과정_기타',
  '파트너V3_요청정보충분성',
  '파트너V3_추가필요정보', '파트너V3_추가필요정보_기타',
  '파트너V3_우선확인정보', '파트너V3_우선확인정보_기타',
  '파트너V3_유용할것같은기능', '파트너V3_유용할것같은기능_기타',
  '파트너V3_주요우려사항', '파트너V3_주요우려사항_기타',
  '파트너V3_우려해결방법',
  '파트너V3_타플랫폼경험',
  '파트너V3_이용서비스', '파트너V3_이용서비스_기타',
  '파트너V3_경쟁력강점', '파트너V3_경쟁력강점_기타',
  '파트너V3_경쟁력약점', '파트너V3_경쟁력약점_기타',
  '파트너V3_경쟁력우선순위', '파트너V3_경쟁력우선순위_기타',
  '파트너V3_이용료방식', '파트너V3_이용료방식_기타',
  '파트너V3_이용료_30만원미만평가', '파트너V3_이용료_30만원미만_수용금액',
  '파트너V3_이용료_30만~100만원평가', '파트너V3_이용료_30만~100만원_수용금액',
  '파트너V3_이용료_100만원이상평가', '파트너V3_이용료_100만원이상_수용금액',
  '파트너V3_이용료시나리오의향',
  '파트너V3_이용료시나리오_거절이유', '파트너V3_이용료시나리오_거절이유_기타',
  '파트너V3_이용료보호정책', '파트너V3_이용료보호정책_기타',
  '파트너V3_안전결제평가',
  '파트너V3_결제이용필요조건', '파트너V3_결제이용필요조건_기타',
  '파트너V3_플랫폼보호역할', '파트너V3_플랫폼보호역할_기타',
  '파트너V3_보증제도의향',
  '파트너V3_보증명확화필요사항', '파트너V3_보증명확화필요사항_기타',
  '파트너V3_참여의향',
  '파트너V3_참여필요조건', '파트너V3_참여필요조건_기타',
  '파트너V3_가장중요한개선점',
  '파트너V3_추가제안'
];
// 시트 헤더명(한글) ← 설문 페이지 제출 필드명(영문 partner_v3_* colKey) 매핑
var PARTNER_V3_FIELD_MAP = {
  '파트너V3_업체명':               'partner_v3_company_name',
  '파트너V3_활동지역':             'partner_v3_service_area',
  '파트너V3_주요작업분야':         'partner_v3_service_category',
  '파트너V3_주요작업분야_기타':    'partner_v3_service_category_etc',
  '파트너V3_서비스이해도':         'partner_v3_service_understanding',
  '파트너V3_이해어려운부분':       'partner_v3_service_confusion_detail',
  '파트너V3_이해어려운부분_기타':  'partner_v3_service_confusion_detail_etc',
  '파트너V3_견적흐름':             'partner_v3_quote_flow',
  '파트너V3_견적흐름_불편과정':    'partner_v3_quote_flow_inconvenience',
  '파트너V3_견적흐름_불편과정_기타': 'partner_v3_quote_flow_inconvenience_etc',
  '파트너V3_요청정보충분성':       'partner_v3_request_information',
  '파트너V3_추가필요정보':         'partner_v3_additional_request_information',
  '파트너V3_추가필요정보_기타':    'partner_v3_additional_request_information_etc',
  '파트너V3_우선확인정보':         'partner_v3_priority_request_information',
  '파트너V3_우선확인정보_기타':    'partner_v3_priority_request_information_etc',
  '파트너V3_유용할것같은기능':      'partner_v3_expected_useful_features',
  '파트너V3_유용할것같은기능_기타': 'partner_v3_expected_useful_features_etc',
  '파트너V3_주요우려사항':         'partner_v3_main_concerns',
  '파트너V3_주요우려사항_기타':    'partner_v3_main_concerns_etc',
  '파트너V3_우려해결방법':         'partner_v3_concern_solution',
  '파트너V3_타플랫폼경험':         'partner_v3_competitor_experience',
  '파트너V3_이용서비스':           'partner_v3_competitor_services',
  '파트너V3_이용서비스_기타':      'partner_v3_competitor_services_etc',
  '파트너V3_경쟁력강점':           'partner_v3_competitive_strength',
  '파트너V3_경쟁력강점_기타':      'partner_v3_competitive_strength_etc',
  '파트너V3_경쟁력약점':           'partner_v3_competitive_weakness',
  '파트너V3_경쟁력약점_기타':      'partner_v3_competitive_weakness_etc',
  '파트너V3_경쟁력우선순위':       'partner_v3_competitive_priority',
  '파트너V3_경쟁력우선순위_기타':  'partner_v3_competitive_priority_etc',
  '파트너V3_이용료방식':           'partner_v3_fee_method',
  '파트너V3_이용료방식_기타':      'partner_v3_fee_method_etc',
  '파트너V3_이용료_30만원미만평가':          'partner_v3_fee_under_300k_evaluation',
  '파트너V3_이용료_30만원미만_수용금액':     'partner_v3_fee_under_300k_acceptable',
  '파트너V3_이용료_30만~100만원평가':        'partner_v3_fee_300k_1m_evaluation',
  '파트너V3_이용료_30만~100만원_수용금액':   'partner_v3_fee_300k_1m_acceptable',
  '파트너V3_이용료_100만원이상평가':         'partner_v3_fee_over_1m_evaluation',
  '파트너V3_이용료_100만원이상_수용금액':    'partner_v3_fee_over_1m_acceptable',
  '파트너V3_이용료시나리오의향':   'partner_v3_fee_scenario_intent',
  '파트너V3_이용료시나리오_거절이유':      'partner_v3_fee_scenario_rejection_reason',
  '파트너V3_이용료시나리오_거절이유_기타': 'partner_v3_fee_scenario_rejection_reason_etc',
  '파트너V3_이용료보호정책':       'partner_v3_fee_protection',
  '파트너V3_이용료보호정책_기타':  'partner_v3_fee_protection_etc',
  '파트너V3_안전결제평가':         'partner_v3_safe_payment_evaluation',
  '파트너V3_결제이용필요조건':     'partner_v3_required_payment_conditions',
  '파트너V3_결제이용필요조건_기타': 'partner_v3_required_payment_conditions_etc',
  '파트너V3_플랫폼보호역할':       'partner_v3_platform_protection_role',
  '파트너V3_플랫폼보호역할_기타':  'partner_v3_platform_protection_role_etc',
  '파트너V3_보증제도의향':         'partner_v3_guarantee_intent',
  '파트너V3_보증명확화필요사항':   'partner_v3_guarantee_required_clarity',
  '파트너V3_보증명확화필요사항_기타': 'partner_v3_guarantee_required_clarity_etc',
  '파트너V3_참여의향':             'partner_v3_participation_intent',
  '파트너V3_참여필요조건':         'partner_v3_participation_requirement',
  '파트너V3_참여필요조건_기타':    'partner_v3_participation_requirement_etc',
  '파트너V3_가장중요한개선점':     'partner_v3_most_important_improvement',
  '파트너V3_추가제안':             'partner_v3_additional_suggestion'
};

// ════════════════════════════════════════════════════════════
// 파트너 간략 설문 (partner_simplified_v1) — 파트너v3 화면 설문도 폐기되었지만
// 컬럼/데이터는 그대로 보존한다. 신규 17문항은 전부 partner_simple_ 접두 colKey를 쓰며,
// 시트 헤더는 "맨 뒤"에 추가되어 기존 컬럼 순서에 영향을 주지 않는다.
// ════════════════════════════════════════════════════════════
var PARTNER_SIMPLE_COLS = [
  '파트너간략_업체명', '파트너간략_활동지역',
  '파트너간략_주요작업분야', '파트너간략_주요작업분야_기타',
  '파트너간략_서비스이해도',
  '파트너간략_견적흐름',
  '파트너간략_필요요청정보', '파트너간략_필요요청정보_기타',
  '파트너간략_주요우려사항', '파트너간략_주요우려사항_기타',
  '파트너간략_경쟁력우선순위', '파트너간략_경쟁력우선순위_기타',
  '파트너간략_직접견적이용료의견', '파트너간략_직접견적이용료의견_기타',
  '파트너간략_직접견적이용료방식', '파트너간략_직접견적이용료방식_기타',
  '파트너간략_이용료적정수준', '파트너간략_이용료적정수준_기타',
  '파트너간략_입찰과금방식의견', '파트너간략_입찰과금방식의견_기타',
  '파트너간략_이용료보호정책', '파트너간략_이용료보호정책_기타',
  '파트너간략_안전결제',
  '파트너간략_참여의향',
  '파트너간략_가장중요한개선점',
  '파트너간략_추가제안'
];
// 시트 헤더명(한글) ← 설문 페이지 제출 필드명(영문 partner_simple_* colKey) 매핑
var PARTNER_SIMPLE_FIELD_MAP = {
  '파트너간략_업체명':                 'partner_simple_company_name',
  '파트너간략_활동지역':               'partner_simple_service_area',
  '파트너간략_주요작업분야':           'partner_simple_service_category',
  '파트너간략_주요작업분야_기타':      'partner_simple_service_category_etc',
  '파트너간략_서비스이해도':           'partner_simple_service_understanding',
  '파트너간략_견적흐름':               'partner_simple_quote_flow',
  '파트너간략_필요요청정보':           'partner_simple_required_request_info',
  '파트너간략_필요요청정보_기타':      'partner_simple_required_request_info_etc',
  '파트너간략_주요우려사항':           'partner_simple_main_concerns',
  '파트너간략_주요우려사항_기타':      'partner_simple_main_concerns_etc',
  '파트너간략_경쟁력우선순위':         'partner_simple_competitive_priority',
  '파트너간략_경쟁력우선순위_기타':    'partner_simple_competitive_priority_etc',
  '파트너간략_직접견적이용료의견':      'partner_simple_direct_fee_acceptance',
  '파트너간략_직접견적이용료의견_기타': 'partner_simple_direct_fee_acceptance_etc',
  '파트너간략_직접견적이용료방식':      'partner_simple_direct_fee_method',
  '파트너간략_직접견적이용료방식_기타': 'partner_simple_direct_fee_method_etc',
  '파트너간략_이용료적정수준':         'partner_simple_fee_level',
  '파트너간략_이용료적정수준_기타':    'partner_simple_fee_level_etc',
  '파트너간략_입찰과금방식의견':       'partner_simple_bid_fee_opinion',
  '파트너간략_입찰과금방식의견_기타':  'partner_simple_bid_fee_opinion_etc',
  '파트너간략_이용료보호정책':         'partner_simple_fee_protection',
  '파트너간략_이용료보호정책_기타':    'partner_simple_fee_protection_etc',
  '파트너간략_안전결제':               'partner_simple_safe_payment',
  '파트너간략_참여의향':               'partner_simple_participation_intent',
  '파트너간략_가장중요한개선점':       'partner_simple_most_important_improvement',
  '파트너간략_추가제안':               'partner_simple_additional_suggestion'
};

var RESPONSE_HEADERS = COMMON_COLS.concat(GENERAL_COLS).concat(EMPLOYEE_COLS).concat(PARTNER_COLS).concat(ADMIN_COLS).concat(CONSENT_COLS).concat(PARTNER_EXTRA_COLS).concat(SURVEY_VERSION_COL).concat(PARTNER_V2_COLS).concat(PARTNER_V3_COLS).concat(PARTNER_SIMPLE_COLS);
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
    if (action === 'rafflepreview')      return rafflePreview(data);
    if (action === 'raffledeleterounds') return raffleDeleteRounds(data);

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
      // 파트너 v2 신규 질문 — 한글 헤더(파트너V2_*)에 영문 필드명(partner_v2_*)으로 제출된 값을 매핑
      if (PARTNER_V2_FIELD_MAP[key] !== undefined) {
        var v2FieldKey = PARTNER_V2_FIELD_MAP[key];
        return data[v2FieldKey] !== undefined ? String(data[v2FieldKey]) : '';
      }
      // 파트너 v3 신규 질문 — 한글 헤더(파트너V3_*)에 영문 필드명(partner_v3_*)으로 제출된 값을 매핑
      // 조건부 질문이 화면에 표시되지 않은 경우 프론트에서 빈 문자열로 전송되며 그대로 빈값 저장됨
      if (PARTNER_V3_FIELD_MAP[key] !== undefined) {
        var v3FieldKey = PARTNER_V3_FIELD_MAP[key];
        return data[v3FieldKey] !== undefined ? String(data[v3FieldKey]) : '';
      }
      // 파트너 간략 설문(partner_simplified_v1) — 한글 헤더(파트너간략_*)에 영문 필드명(partner_simple_*)으로 제출된 값을 매핑
      // 미선택/미표시 값은 프론트에서 빈 문자열로 전송되며 그대로 빈값 저장됨. 체크박스는 쉼표 구분 문자열 그대로 저장.
      if (PARTNER_SIMPLE_FIELD_MAP[key] !== undefined) {
        var simpleFieldKey = PARTNER_SIMPLE_FIELD_MAP[key];
        return data[simpleFieldKey] !== undefined ? String(data[simpleFieldKey]) : '';
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
      case 'rafflepreview':    return rafflePreview(e.parameter);
      case 'rafflerounds':     return raffleRoundsList(e.parameter);
      case 'rafflewinners':    return raffleWinners(e.parameter);
      case 'raffleduplicates': return raffleDuplicates(e.parameter);
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
// 파트너 설문 v2 배포 전 안전 백업 — Apps Script 편집기에서 1회 수동 실행
// responses 시트를 복사만 하고(원본은 그대로 유지) backup_responses_before_partner_v2_<시각>
// 이름의 새 시트를 만든다. 삭제/수정 없이 순수 복사본만 추가한다.
// ════════════════════════════════════════════════════════════
function backupResponsesBeforePartnerV2() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_RESPONSES);
  if (!sheet) {
    Logger.log('responses 시트가 없어 백업할 대상이 없습니다.');
    return;
  }
  var now = new Date();
  var timestamp = Utilities.formatDate(now, 'Asia/Seoul', 'yyyyMMdd_HHmmss');
  var backupName = 'backup_responses_before_partner_v2_' + timestamp;
  sheet.copyTo(ss).setName(backupName);
  Logger.log('백업 완료: ' + backupName + ' (원본 responses 시트는 변경되지 않음)');
}

// ════════════════════════════════════════════════════════════
// 파트너 간략 설문(partner_simplified_v1) 배포 전 안전 백업 — Apps Script 편집기에서 1회 수동 실행
// responses 시트를 복사만 하고(원본은 그대로 유지) backup_responses_before_partner_simplified_<시각>
// 이름의 새 시트를 만든다. 삭제/수정 없이 순수 복사본만 추가한다.
// ════════════════════════════════════════════════════════════
function backupResponsesBeforePartnerSimplified() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName(SHEET_RESPONSES);
  if (!sheet) {
    Logger.log('responses 시트가 없어 백업할 대상이 없습니다.');
    return;
  }
  var now = new Date();
  var timestamp = Utilities.formatDate(now, 'Asia/Seoul', 'yyyyMMdd_HHmmss');
  var backupName = 'backup_responses_before_partner_simplified_' + timestamp;
  sheet.copyTo(ss).setName(backupName);
  Logger.log('백업 완료: ' + backupName + ' (원본 responses 시트는 변경되지 않음)');
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
// 손대지 않고, 별도 시트(raffle_config / raffle_rounds / raffle_results /
// raffle_logs)와 raffle 접두어가 붙은 함수만 사용합니다. 아래 함수들을
// 삭제하거나 doGet/doPost의 raffle* 라우팅을 제거해도 설문 제출·통계
// 기능은 100% 그대로 동작합니다.
//
// ── 회차(round) 개념 ──
// 관리자가 조건(날짜/참여유형)을 선택해 "추첨 실행"을 누를 때마다
// raffle_rounds에 새 회차(raffleId)가 하나 생성되고, 그 회차의 조건에
// 해당하는 대상자 전원(당첨자 + 낙첨자)이 raffle_results에 raffleId와
// 함께 저장됩니다. raffle_config.currentRoundId가 "현재 공개 대상 회차"를
// 가리키며, 그 회차만 사용자 당첨확인(rafflecheck) 조회 대상이 됩니다.
//
// 당첨 판정 기준: 응답자 "휴대폰 번호"(하이픈/공백 제거 후 숫자만 비교).
// 동일 번호로 여러 번 제출한 경우 "필터 조건 내에서 가장 최근 제출 1건"만
// 추첨 대상 풀에 포함시켜 중복 참여를 방지합니다.
// ════════════════════════════════════════════════════════════════════

var RAFFLE_SHEET_CONFIG  = 'raffle_config';
var RAFFLE_SHEET_ROUNDS  = 'raffle_rounds';
var RAFFLE_SHEET_RESULTS = 'raffle_results';
var RAFFLE_SHEET_LOGS    = 'raffle_logs';

var RAFFLE_CONFIG_HEADERS = ['key', 'value'];

// raffleId: 회차 식별자 (예: RAFFLE_20260707_184230)
// targetCount: 최종 추첨에 사용된 인원(=관리자가 체크해 확정한 대상자 수)
var RAFFLE_ROUNDS_HEADERS = [
  'raffleId', 'raffleName', 'targetDateType', 'targetStartDate', 'targetEndDate',
  'targetUserType', 'targetCount', 'duplicateCount', 'status', 'drawnAt',
  'revealEnabled', 'createdAt',
  'totalMatchedCount', 'dedupedCandidateCount', 'prizeTotalCount',
  'tier1Count', 'tier2Count', 'tier3Count', 'participationCount',
  'unassignedCount', 'leftoverPrizeCount'
];

// phone: 정규화된(숫자만) 휴대폰 번호. tier: 당첨 등수 또는 'NONE'(낙첨/미당첨).
// 해당 회차의 "추첨 대상자 전원"이 한 행씩 저장됩니다 (당첨자만이 아님).
var RAFFLE_RESULTS_HEADERS = [
  'raffleId', 'phone', 'tier', 'prize', 'drawnAt',
  'confirmed', 'firstConfirmedAt', 'lastConfirmedAt', 'confirmedCount', 'responseId',
  'name', 'userType', 'submittedAt'
];
var RAFFLE_LOGS_HEADERS = ['loggedAt', 'raffleId', 'action', 'detail'];

// 등수별 경품 문구 — 인원 수는 더 이상 고정값이 아니라 관리자가 추첨 실행 시 직접 입력한다
// (raffleRun의 prizeTotalCount/tier1Count/tier2Count/tier3Count 참고). 이 배열은 등수명↔경품
// 문구 매핑 용도로만 남아 있다.
var RAFFLE_PRIZE_LABELS = [
  { tier: '1등',   prize: '100,000원 상품권' },
  { tier: '2등',   prize: '30,000원 상품권' },
  { tier: '3등',   prize: '10,000원 상품권' },
  { tier: '참가상', prize: '2,000원 커피쿠폰' }
];

// ── raffle_config / raffle_rounds / raffle_results / raffle_logs 시트 보장 ──
function raffleEnsureSheets(ss) {
  getOrCreateSheet(ss, RAFFLE_SHEET_CONFIG, RAFFLE_CONFIG_HEADERS);
  var roundsSheet = getOrCreateSheet(ss, RAFFLE_SHEET_ROUNDS, RAFFLE_ROUNDS_HEADERS);
  ensureSheetHeaders(roundsSheet, RAFFLE_ROUNDS_HEADERS); // 기존 회차 데이터 유지한 채 신규 컬럼만 추가
  var resultsSheet = getOrCreateSheet(ss, RAFFLE_SHEET_RESULTS, RAFFLE_RESULTS_HEADERS);
  ensureSheetHeaders(resultsSheet, RAFFLE_RESULTS_HEADERS); // 기존 결과 데이터 유지한 채 신규 컬럼만 추가
  // phone 컬럼(B열)을 텍스트 서식으로 고정 — 숫자 변환으로 앞자리 0이 사라지는 것 방지
  resultsSheet.getRange('B:B').setNumberFormat('@');
  getOrCreateSheet(ss, RAFFLE_SHEET_LOGS, RAFFLE_LOGS_HEADERS);
}

// 수동 실행용 — Apps Script 편집기에서 최초 1회 실행해도 되고, 각 raffle 함수가
// 호출될 때마다 자동으로 raffleEnsureSheets가 실행되므로 생략해도 무방합니다.
function raffleSetupSheets() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  raffleEnsureSheets(ss);
  Logger.log('raffleSetupSheets 완료 — raffle_config / raffle_rounds / raffle_results / raffle_logs 시트 준비됨');
}

// ── (수동 1회 실행용) raffle_* 시트 완전 초기화 — 컬럼 순서 꼬임 복구 ──────────
// 과거 여러 차례의 추첨 기능 개편으로 raffle_rounds/raffle_results 헤더 배열
// (RAFFLE_ROUNDS_HEADERS/RAFFLE_RESULTS_HEADERS)의 순서/컬럼 구성이 여러 번 바뀌었다.
// ensureSheetHeaders는 "누락된 헤더 이름"만 시트 맨 뒤에 추가할 뿐 기존 컬럼 순서를
// 절대 바꾸지 않기 때문에, 예전 코드로 이미 만들어진 raffle_rounds/raffle_results
// 시트는 실제 물리적 컬럼 순서가 현재 헤더 배열 순서와 어긋나 있을 수 있다.
// 이 상태에서는 raffleId로 재조회해도 당첨자 목록이 항상 0건으로 보이는 등
// 회차 삭제 후 재실행을 반복해도 해결되지 않는 문제가 발생한다.
// (현재 코드의 raffleRun 저장 로직은 이미 헤더 "이름" 기준으로 값을 배치하도록
// 수정되어 이 문제가 재발하지 않지만, 과거에 이미 꼬여버린 시트 자체를 고치려면
// 아래처럼 raffle_config/raffle_rounds/raffle_results/raffle_logs 4개 시트를
// 통째로 삭제하고 현재 코드 기준 헤더로 새로 만드는 것이 가장 확실하다.
// 이 4개 시트는 추첨 기능 전용 자동 생성 시트이며, 설문 원본 응답(responses)/
// 설정(settings)/설문 로그(logs) 시트는 이 함수가 절대 건드리지 않는다.
// Apps Script 편집기에서 함수 선택 → raffleHardResetSheets → 실행으로 1회만 돌리면 된다.
function raffleHardResetSheets() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  [RAFFLE_SHEET_CONFIG, RAFFLE_SHEET_ROUNDS, RAFFLE_SHEET_RESULTS, RAFFLE_SHEET_LOGS].forEach(function(name) {
    var sheet = ss.getSheetByName(name);
    if (sheet) ss.deleteSheet(sheet);
  });
  raffleEnsureSheets(ss);
  Logger.log('raffleHardResetSheets 완료 — raffle_config/raffle_rounds/raffle_results/raffle_logs를 현재 코드 기준 헤더로 재생성했습니다. (기존 추첨 회차/결과 이력은 전부 삭제됨. responses/settings/logs는 전혀 변경되지 않음)');
}

// ── 과거 버그로 남은 잘못된 공개 상태 정리 (수동 1회 실행용) ──
// 예전 코드는 "현재 회차 초기화" 시 그 회차의 raffle_rounds.revealEnabled 값을
// 지우지 않아, 이미 초기화된 옛 회차가 이력 표에서 계속 "공개중"으로 잘못
// 표시되는 문제가 있었다. 이 함수는 raffle_config.currentRoundId와 실제로
// 일치하는 회차 한 건만 revealEnabled=TRUE로 남기고 나머지는 전부 FALSE로
// 맞춘다. raffle_results/raffle_rounds의 어떤 데이터도 삭제하지 않는다.
// Apps Script 편집기에서 필요할 때 한 번 실행하면 된다.
function raffleFixStaleRevealFlags() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  raffleEnsureSheets(ss);
  var configMap = raffleGetConfigMap(ss);
  var publicRaffleId = configMap.currentRoundId || '';

  var roundsSheet = ss.getSheetByName(RAFFLE_SHEET_ROUNDS);
  if (!roundsSheet) { Logger.log('raffle_rounds 시트 없음'); return; }
  var values = roundsSheet.getDataRange().getValues();
  var headers = values[0];
  var idCol = headers.indexOf('raffleId');
  var revCol = headers.indexOf('revealEnabled');
  var fixedCount = 0;
  for (var i = 1; i < values.length; i++) {
    var isPublic = !!publicRaffleId && String(values[i][idCol]) === publicRaffleId;
    var shouldBe = isPublic ? 'TRUE' : 'FALSE';
    if (String(values[i][revCol]).trim().toUpperCase() !== shouldBe) {
      roundsSheet.getRange(i + 1, revCol + 1).setValue(shouldBe);
      fixedCount++;
    }
  }
  Logger.log('raffleFixStaleRevealFlags 완료 — 공개 대상 회차: ' + (publicRaffleId || '(없음)') + ' / 수정된 행: ' + fixedCount + '건');
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

function raffleWriteLog(ss, raffleId, action, detail) {
  try {
    var sheet = getOrCreateSheet(ss, RAFFLE_SHEET_LOGS, RAFFLE_LOGS_HEADERS);
    var now = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss');
    sheet.appendRow([now, raffleId || '', action, detail]);
  } catch (_) {
    Logger.log('[RAFFLE LOG FAIL] ' + action + ': ' + detail);
  }
}

// 구글시트가 'TRUE'/'FALSE' 문자열을 불리언으로 자동 변환해 소문자 'true'로
// 읽히는 문제가 있으므로, 반드시 이 함수로만 참/거짓을 판정한다.
function raffleIsTrue(v) {
  return String(v).trim().toUpperCase() === 'TRUE';
}

// 휴대폰 번호 정규화 — 하이픈/공백/괄호 등 숫자가 아닌 문자를 모두 제거하고,
// 시트가 숫자로 저장하며 잘려나간 맨 앞 0을 복원한다 (01012345678 → 1012345678 방지).
// 반드시 문자열로만 다루며 Number()/parseInt() 등 숫자 변환은 절대 사용하지 않는다.
function raffleNormalizePhone(raw) {
  var d = String(raw || '').replace(/\D/g, '');
  if (d && d.charAt(0) !== '0') d = '0' + d;
  return d;
}

// 관리자 화면 로그용 — 번호 중간 자리를 마스킹 (구글시트 raffle_results/responses에는 영향 없음)
function raffleMaskPhone(phone) {
  if (!phone) return '';
  if (phone.length < 7) return phone.replace(/./g, '*');
  return phone.slice(0, 3) + '****' + phone.slice(-4);
}

// responses 시트를 원본 그대로 "읽기만" 하여, 주어진 필터(날짜기준/참여유형) 조건에
// 해당하는 응답들 중 번호별 "필터 내 최신 제출 1건"으로 구성된 추첨 대상 풀과
// 중복 제출 현황을 계산합니다. responses 시트에는 어떤 쓰기 작업도 하지 않습니다.
// filters: { dateType: 'all'|'today'|'yesterday'|'specific'|'range', startDate, endDate, userType: 'all'|'일반사용자'|'임직원'|'파트너' }
function raffleGetEligibleEntries(ss, filters) {
  filters = filters || {};
  var dateType  = filters.dateType  || 'all';
  var startDate = filters.startDate || '';
  var endDate   = filters.endDate   || '';
  var userType  = filters.userType  || 'all';

  var empty = { entries: [], duplicatesMap: {}, totalMatched: 0 };
  var sheet = ss.getSheetByName(SHEET_RESPONSES);
  if (!sheet) return empty;
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2) return empty;

  var headers  = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var phoneCol = headers.indexOf('respondentPhone');
  var idCol    = headers.indexOf('responseId');
  var atCol    = headers.indexOf('submittedAt');
  var typeCol  = headers.indexOf('participantType');
  var nameCol  = headers.indexOf('respondentName');
  if (phoneCol < 0) return empty;

  var values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  // 휴대폰 번호는 표시값(getDisplayValues) 기준으로 읽어 숫자 변환에 의한 손실을 최소화한다.
  var phoneDisplay = sheet.getRange(2, phoneCol + 1, lastRow - 1, 1).getDisplayValues();

  var now = new Date();
  var todayStr = Utilities.formatDate(now, 'Asia/Seoul', 'yyyy-MM-dd');
  var yesterdayStr = Utilities.formatDate(new Date(now.getTime() - 24 * 60 * 60 * 1000), 'Asia/Seoul', 'yyyy-MM-dd');

  var byPhone = {};
  var totalMatched = 0;

  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    var rawPhone = (phoneDisplay[i] && phoneDisplay[i][0]) ? phoneDisplay[i][0] : row[phoneCol];
    var norm = raffleNormalizePhone(rawPhone);
    if (!norm) continue; // 연락처 없는 레거시 응답은 추첨 대상에서 제외

    var atRaw = atCol >= 0 ? row[atCol] : '';
    var atStr, atMs, dateOnly;
    if (atRaw instanceof Date) {
      atMs = atRaw.getTime();
      atStr = Utilities.formatDate(atRaw, 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss');
      dateOnly = Utilities.formatDate(atRaw, 'Asia/Seoul', 'yyyy-MM-dd');
    } else {
      atStr = String(atRaw);
      atMs = Date.parse(atStr.replace(' ', 'T')) || 0;
      dateOnly = atStr.slice(0, 10);
    }

    // ── 날짜 기준 필터 ──
    if (dateType === 'today' && dateOnly !== todayStr) continue;
    if (dateType === 'yesterday' && dateOnly !== yesterdayStr) continue;
    if (dateType === 'specific' && dateOnly !== startDate) continue;
    if (dateType === 'range') {
      if (startDate && dateOnly < startDate) continue;
      if (endDate && dateOnly > endDate) continue;
    }

    // ── 참여 유형 필터 ──
    var pType = typeCol >= 0 ? String(row[typeCol] || '') : '';
    if (userType !== 'all' && pType !== userType) continue;

    totalMatched++;
    var rid  = idCol >= 0 ? String(row[idCol] || '').trim() : '';
    var name = nameCol >= 0 ? String(row[nameCol] || '').trim() : '';
    if (!byPhone[norm]) byPhone[norm] = [];
    byPhone[norm].push({ responseId: rid, submittedAt: atStr, sortKey: atMs, rowIndex: i, name: name, participantType: pType });
  }

  var entries = [];       // 추첨 대상 풀 — 번호당 "필터 내 가장 최근 제출" 1건만 포함
  var duplicatesMap = {}; // 번호당 2건 이상 제출된 경우 (관리자 조회용)
  Object.keys(byPhone).forEach(function(norm) {
    var list = byPhone[norm].slice().sort(function(a, b) {
      return (a.sortKey - b.sortKey) || (a.rowIndex - b.rowIndex);
    });
    var latest = list[list.length - 1];
    entries.push({
      phone: norm, responseId: latest.responseId, submittedAt: latest.submittedAt,
      name: latest.name, participantType: latest.participantType
    });
    if (list.length > 1) duplicatesMap[norm] = list;
  });

  return { entries: entries, duplicatesMap: duplicatesMap, totalMatched: totalMatched };
}

// responses 시트에 해당 번호로 제출된 이력이 "필터와 무관하게 전체 기간" 존재하는지 확인.
// 당첨확인 1단계(설문 참여 이력 자체 확인)에 사용 — 회차/추첨 조건과 별개.
function rafflePhoneHasHistory(ss, phone) {
  var sheet = ss.getSheetByName(SHEET_RESPONSES);
  if (!sheet) return false;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var phoneCol = headers.indexOf('respondentPhone');
  if (phoneCol < 0) return false;
  var displayVals = sheet.getRange(2, phoneCol + 1, lastRow - 1, 1).getDisplayValues();
  for (var i = 0; i < displayVals.length; i++) {
    if (raffleNormalizePhone(displayVals[i][0]) === phone) return true;
  }
  return false;
}

// selectedResponseIds(원본 설문 responseId 목록)를 받아 원본 응답 시트에서 해당 행을 다시 조회해
// 추첨 대상 정보를 구성한다. 화면 표시용 마스킹 번호는 여기서 전혀 사용하지 않으며, 오직
// responseId만으로 원본 데이터를 다시 찾아온다. { responseId → {responseId, phone, name, participantType, submittedAt} }
function raffleGetResponsesByIds(ss, responseIds) {
  var wanted = {};
  responseIds.forEach(function(id) {
    var key = String(id || '').trim();
    if (key) wanted[key] = true;
  });
  var result = {};
  var sheet = ss.getSheetByName(SHEET_RESPONSES);
  if (!sheet || Object.keys(wanted).length === 0) return result;
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2) return result;

  var headers  = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var idCol    = headers.indexOf('responseId');
  var phoneCol = headers.indexOf('respondentPhone');
  var atCol    = headers.indexOf('submittedAt');
  var typeCol  = headers.indexOf('participantType');
  var nameCol  = headers.indexOf('respondentName');
  if (idCol < 0 || phoneCol < 0) return result;

  var values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  // 휴대폰 번호는 표시값 기준으로 읽어 숫자 변환에 의한 손실을 막는다 (raffleGetEligibleEntries와 동일 원칙).
  var phoneDisplay = sheet.getRange(2, phoneCol + 1, lastRow - 1, 1).getDisplayValues();

  for (var i = 0; i < values.length; i++) {
    var rid = String(values[i][idCol] || '').trim();
    if (!rid || !wanted[rid]) continue;

    var rawPhone = (phoneDisplay[i] && phoneDisplay[i][0]) ? phoneDisplay[i][0] : values[i][phoneCol];
    var norm = raffleNormalizePhone(rawPhone);

    var atRaw = atCol >= 0 ? values[i][atCol] : '';
    var atStr = (atRaw instanceof Date)
      ? Utilities.formatDate(atRaw, 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss')
      : String(atRaw);

    result[rid] = {
      responseId: rid,
      phone: norm,
      name: nameCol >= 0 ? String(values[i][nameCol] || '').trim() : '',
      participantType: typeCol >= 0 ? String(values[i][typeCol] || '') : '',
      submittedAt: atStr
    };
  }
  return result;
}

function raffleFindRound(ss, raffleId) {
  if (!raffleId) return null;
  var rows = sheetToObjects(ss, RAFFLE_SHEET_ROUNDS);
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].raffleId === raffleId) return rows[i];
  }
  return null;
}

function raffleFiltersFromParams(params) {
  params = params || {};
  return {
    dateType:  params.dateType  || 'all',
    startDate: params.startDate || '',
    endDate:   params.endDate   || '',
    userType:  params.userType  || 'all'
  };
}

// ── 추첨 대상자 미리보기 (관리자 전용 — 실행 전 조건별 대상 수 확인) ──
function rafflePreview(params) {
  params = params || {};
  if (!isValidPassword(params.password || '')) return makeResponse({ success: false, error: 'UNAUTHORIZED' });

  var ss = SpreadsheetApp.openById(SHEET_ID);
  var filters = raffleFiltersFromParams(params);
  var eligible = raffleGetEligibleEntries(ss, filters);
  var duplicatesMap = eligible.duplicatesMap;

  // 관리자가 직접 체크해 최종 추첨 대상을 고를 수 있도록 후보자 상세 목록을 반환한다.
  // (조건/유형만으로 자동 확정하지 않음 — 실제 확정은 rafflerun 호출 시 selectedResponseIds로만 이뤄진다)
  var entries = eligible.entries.map(function(e) {
    return {
      phone: e.phone, name: e.name || '', participantType: e.participantType || '',
      submittedAt: e.submittedAt, responseId: e.responseId,
      isDuplicate: !!duplicatesMap[e.phone]
    };
  });

  return makeResponse({
    success: true,
    totalMatched: eligible.totalMatched,
    dedupedCandidateCount: entries.length,
    duplicateCount: Object.keys(duplicatesMap).length,
    entries: entries
  });
}

// ── 랜덤 추첨 실행 (관리자 전용) — 조건에 맞는 대상자만으로 새 회차를 생성합니다. ──
function raffleRun(data) {
  if (!isValidPassword(data.password || '')) return makeResponse({ success: false, error: 'UNAUTHORIZED' });

  var ss = SpreadsheetApp.openById(SHEET_ID);
  raffleEnsureSheets(ss);

  // ── 회차는 항상 새로 생성 가능(다른 회차의 실행/공개 상태와 무관) ──
  // 여러 회차가 동시에 "실행됨" 상태로 공존할 수 있으며, 그중 "당첨확인 공개"로
  // 지정된 회차 하나만 raffle_config.currentRoundId(공개 대상 회차)가 된다.
  // 새로 실행한 회차는 기본적으로 비공개 상태이며, 기존에 공개 중이던 회차의
  // 공개 상태는 그대로 유지된다(관리자가 명시적으로 공개 전환해야 바뀜).

  // ── 경품 수량 입력값 검증 ──
  var prizeTotalCount = parseInt(data.prizeTotalCount, 10);
  var tier1Count = parseInt(data.tier1Count, 10);
  var tier2Count = parseInt(data.tier2Count, 10);
  var tier3Count = parseInt(data.tier3Count, 10);
  if (!(prizeTotalCount >= 1)) {
    return makeResponse({ success: false, error: 'PRIZE_TOTAL_INVALID', message: '총 경품 수량은 1 이상이어야 합니다.' });
  }
  if (!(tier1Count >= 0) || !(tier2Count >= 0) || !(tier3Count >= 0)) {
    return makeResponse({ success: false, error: 'TIER_COUNT_INVALID', message: '1등/2등/3등 인원은 0 이상이어야 합니다.' });
  }
  var topCount = tier1Count + tier2Count + tier3Count;
  if (topCount > prizeTotalCount) {
    return makeResponse({
      success: false, error: 'TIER_EXCEEDS_TOTAL',
      message: '1등, 2등, 3등 인원 합계가 총 경품 수량보다 많습니다. 경품 수량을 다시 확인해주세요.'
    });
  }
  var participationCount = prizeTotalCount - topCount;

  var filters = raffleFiltersFromParams(data);
  var raffleName = String(data.raffleName || '').trim();
  if (!raffleName) {
    raffleName = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd') + ' 설문 경품 추첨';
  }

  // ── 대상자 확정: 화면 표시용 마스킹 번호가 아니라, 관리자가 체크한 "원본 설문 responseId
  // 목록"(selectedResponseIds)을 기준으로 원본 응답 시트에서 해당 행을 다시 조회해 대상자를
  // 구성한다. filters/eligible은 회차 메타데이터(전체 매칭 수 등) 산출용 참고 정보일 뿐이며,
  // 실제 추첨 대상 확정 권한은 오직 selectedResponseIds에만 있다.
  var eligible = raffleGetEligibleEntries(ss, filters); // 회차 메타데이터(totalMatched 등) 산출용
  var selectedResponseIds = Array.isArray(data.selectedResponseIds)
    ? data.selectedResponseIds.map(String).filter(Boolean) : [];

  Logger.log('[raffleRun] selectedResponseIds 수신 ' + selectedResponseIds.length + '건: ' + JSON.stringify(selectedResponseIds));

  if (selectedResponseIds.length === 0) {
    return makeResponse({
      success: false, error: 'NO_TARGET',
      message: '추첨 대상자가 없습니다. 대상자 목록에서 추첨할 사람을 선택해주세요.'
    });
  }

  var responsesById = raffleGetResponsesByIds(ss, selectedResponseIds);

  // 같은 휴대폰 번호가 이번 선택 범위 안에 여러 번 있으면(정상적으로는 미리보기 단계에서 이미
  // 번호당 1건으로 걸러진 상태라 거의 발생하지 않지만, 방어적으로) 가장 최근 제출 1건만 남긴다.
  // 이 중복 제거는 "이번 회차 선택 범위 내"에서만 적용되며, 다른 회차의 이력과는 전혀 무관하다.
  var byPhone = {};
  var notFoundIds = [];
  selectedResponseIds.forEach(function(rid) {
    var t = responsesById[rid];
    if (!t) { notFoundIds.push(rid); return; }
    if (!t.phone) return; // 연락처 없는 레거시 응답은 추첨 대상에서 제외
    var existing = byPhone[t.phone];
    var tMs = Date.parse((t.submittedAt || '').replace(' ', 'T')) || 0;
    var eMs = existing ? (Date.parse((existing.submittedAt || '').replace(' ', 'T')) || 0) : -1;
    if (!existing || tMs > eMs) byPhone[t.phone] = t;
  });
  var pool = Object.keys(byPhone).map(function(p) { return byPhone[p]; });

  Logger.log('[raffleRun] 원본 시트 재조회 완료 — 확정 대상 ' + pool.length + '명 / 조회 실패 ' + notFoundIds.length + '건' +
    (notFoundIds.length ? (' (' + JSON.stringify(notFoundIds) + ')') : ''));

  if (pool.length === 0) {
    return makeResponse({
      success: false, error: 'NO_TARGET',
      message: '선택한 대상자를 원본 설문 응답에서 찾을 수 없습니다. 대상자 미리보기를 다시 실행해주세요.'
    });
  }

  // Fisher–Yates shuffle
  for (var i = pool.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
  }

  var now = new Date();
  var raffleId = 'RAFFLE_' + Utilities.formatDate(now, 'Asia/Seoul', 'yyyyMMdd_HHmmss') +
    '_' + Utilities.getUuid().slice(0, 6); // 초 단위 타임스탬프만으로는 연속 실행 시 충돌 가능하므로 짧은 난수를 덧붙임
  var drawnAt = Utilities.formatDate(now, 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss');
  Logger.log('[raffleRun] raffleId 생성: ' + raffleId);

  var tierDefs = [
    { tier: '1등',   count: tier1Count,         prize: RAFFLE_PRIZE_LABELS[0].prize },
    { tier: '2등',   count: tier2Count,         prize: RAFFLE_PRIZE_LABELS[1].prize },
    { tier: '3등',   count: tier3Count,         prize: RAFFLE_PRIZE_LABELS[2].prize },
    { tier: '참가상', count: participationCount, prize: RAFFLE_PRIZE_LABELS[3].prize }
  ];

  var tierByPhone = {};
  var cursor = 0;
  var summary = [];
  tierDefs.forEach(function(tierDef) {
    var count = 0;
    for (; count < tierDef.count && cursor < pool.length; count++, cursor++) {
      tierByPhone[pool[cursor].phone] = { tier: tierDef.tier, prize: tierDef.prize };
    }
    summary.push({ tier: tierDef.tier, drawn: count, planned: tierDef.count });
  });
  var assignedCount = cursor;
  var unassignedCount = pool.length - assignedCount;       // 미당첨
  var leftoverPrizeCount = prizeTotalCount - assignedCount; // 남는 경품

  // 대상자 전원(당첨자 + 낙첨자)을 raffle_results에 기록 — 낙첨자는 tier='NONE'
  // 반드시 헤더 "이름" 기준으로 값을 배치한다 (raffleEnsureSheets에서 이미 모든 헤더가
  // 존재하도록 보장했지만, 과거 스키마 개편으로 물리적 컬럼 순서가 RAFFLE_RESULTS_HEADERS
  // 배열 순서와 다를 수 있어 위치 기준 저장은 위험하다 — appendRowObjectsByHeaderName 참고).
  var resultsSheet = getOrCreateSheet(ss, RAFFLE_SHEET_RESULTS, RAFFLE_RESULTS_HEADERS);
  var resultRowObjects = pool.map(function(entry) {
    var win = tierByPhone[entry.phone];
    return {
      raffleId: raffleId, phone: entry.phone, tier: win ? win.tier : 'NONE', prize: win ? win.prize : '',
      drawnAt: drawnAt, confirmed: 'FALSE', firstConfirmedAt: '', lastConfirmedAt: '', confirmedCount: '0',
      responseId: entry.responseId, name: entry.name || '', userType: entry.participantType || '',
      submittedAt: entry.submittedAt || ''
    };
  });
  appendRowObjectsByHeaderName(resultsSheet, resultRowObjects);
  resultsSheet.getRange('B:B').setNumberFormat('@');
  Logger.log('[raffleRun] raffle_results 저장 완료 — raffleId=' + raffleId + ' / 저장 건수=' + resultRowObjects.length);

  var duplicateCount = Object.keys(eligible.duplicatesMap).length;
  var roundsSheet = getOrCreateSheet(ss, RAFFLE_SHEET_ROUNDS, RAFFLE_ROUNDS_HEADERS);
  ensureSheetHeaders(roundsSheet, RAFFLE_ROUNDS_HEADERS);
  appendRowObjectByHeaderName(roundsSheet, {
    raffleId: raffleId, raffleName: raffleName, targetDateType: filters.dateType,
    targetStartDate: filters.startDate, targetEndDate: filters.endDate, targetUserType: filters.userType,
    targetCount: pool.length, duplicateCount: duplicateCount, status: 'executed', drawnAt: drawnAt,
    revealEnabled: 'FALSE', createdAt: drawnAt,
    totalMatchedCount: eligible.totalMatched, dedupedCandidateCount: eligible.entries.length,
    prizeTotalCount: prizeTotalCount, tier1Count: tier1Count, tier2Count: tier2Count, tier3Count: tier3Count,
    participationCount: participationCount, unassignedCount: unassignedCount, leftoverPrizeCount: leftoverPrizeCount
  });
  Logger.log('[raffleRun] raffle_rounds 저장 완료 — raffleId=' + raffleId + ' / raffleName=' + raffleName);

  // 새 회차는 기본 비공개 상태로 생성되며, raffle_config.currentRoundId(공개 대상 회차)는
  // 관리자가 명시적으로 "공개하기"를 눌러야만 이 회차로 바뀐다 (raffleToggleReveal 참고).

  raffleWriteLog(ss, raffleId, 'RUN',
    raffleName + ' 실행 완료 — 확정 대상 ' + pool.length + '명 / 중복제출 ' + duplicateCount + '건 / 당첨 배정 ' + assignedCount + '명 / 미당첨 ' + unassignedCount + '명');

  return makeResponse({
    success: true, raffleId: raffleId, raffleName: raffleName,
    targetCount: pool.length, duplicateCount: duplicateCount,
    drawnAt: drawnAt, summary: summary,
    prizeTotalCount: prizeTotalCount, unassignedCount: unassignedCount, leftoverPrizeCount: leftoverPrizeCount
  });
}

// ── 현재 공개 회차 초기화 (관리자 전용) ──
// "초기화"는 raffle_config.currentRoundId(현재 공개 대상 회차) 연결을 해제하는
// 기능일 뿐이며, raffle_results/raffle_rounds의 실제 결과 데이터는 절대 삭제하지
// 않는다. 초기화된 회차도 과거 회차 이력에서 "보기"로 계속 조회 가능하고,
// 필요하면 다시 "공개하기"로 재공개할 수 있다.
function raffleReset(data) {
  if (!isValidPassword(data.password || '')) return makeResponse({ success: false, error: 'UNAUTHORIZED' });
  if (String(data.confirm || '') !== 'RESET') return makeResponse({ success: false, error: 'CONFIRM_REQUIRED' });

  var ss = SpreadsheetApp.openById(SHEET_ID);
  raffleEnsureSheets(ss);
  var configMap = raffleGetConfigMap(ss);
  var raffleId = configMap.currentRoundId || '';
  if (!raffleId) return makeResponse({ success: false, error: 'NO_ROUND' });

  var roundsSheet = ss.getSheetByName(RAFFLE_SHEET_ROUNDS);
  if (roundsSheet) {
    var rvalues = roundsSheet.getDataRange().getValues();
    var rheaders = rvalues[0];
    var ridCol = rheaders.indexOf('raffleId');
    var statusCol = rheaders.indexOf('status');
    var revCol = rheaders.indexOf('revealEnabled');
    for (var j = 1; j < rvalues.length; j++) {
      if (String(rvalues[j][ridCol]) === raffleId) {
        roundsSheet.getRange(j + 1, statusCol + 1).setValue('reset');
        roundsSheet.getRange(j + 1, revCol + 1).setValue('FALSE');
        break;
      }
    }
  }

  var configSheet = ss.getSheetByName(RAFFLE_SHEET_CONFIG);
  raffleSetConfigValue(ss, configSheet, 'currentRoundId', '');
  raffleSetConfigValue(ss, configSheet, 'revealEnabled', 'FALSE');

  raffleWriteLog(ss, raffleId, 'RESET', '공개 대상 회차 연결 해제(초기화) 완료 — 결과 데이터는 삭제되지 않음');
  return makeResponse({ success: true, raffleId: raffleId });
}

// ── 당첨확인 공개 여부 전환 (관리자 전용, 지정한 회차 대상) ──
// 특정 회차를 공개(enabled=true)로 전환하면 raffle_config.currentRoundId가 그 회차로
// 바뀌고, 다른 모든 회차는 자동으로 비공개(revealEnabled=FALSE) 처리된다.
// (동시에 공개중인 회차가 두 개 이상 존재할 수 없다.)
function raffleToggleReveal(data) {
  if (!isValidPassword(data.password || '')) return makeResponse({ success: false, error: 'UNAUTHORIZED' });

  var ss = SpreadsheetApp.openById(SHEET_ID);
  raffleEnsureSheets(ss);
  var configMap = raffleGetConfigMap(ss);
  var targetRaffleId = String(data.raffleId || configMap.currentRoundId || '');
  if (!targetRaffleId) return makeResponse({ success: false, error: 'NO_ROUND' });

  var round = raffleFindRound(ss, targetRaffleId);
  if (!round) return makeResponse({ success: false, error: 'ROUND_NOT_FOUND' });

  var enabled = (data.enabled === true || String(data.enabled) === 'true');
  var configSheet = ss.getSheetByName(RAFFLE_SHEET_CONFIG);
  var roundsSheet = ss.getSheetByName(RAFFLE_SHEET_ROUNDS);

  if (enabled) {
    // 지정한 회차만 공개로 설정하고, 나머지 회차는 전부 비공개로 되돌린다.
    raffleSetConfigValue(ss, configSheet, 'currentRoundId', targetRaffleId);
    raffleSetConfigValue(ss, configSheet, 'revealEnabled', 'TRUE');
    if (roundsSheet) {
      var values = roundsSheet.getDataRange().getValues();
      var headers = values[0];
      var idCol = headers.indexOf('raffleId');
      var revCol = headers.indexOf('revealEnabled');
      for (var i = 1; i < values.length; i++) {
        var isTarget = String(values[i][idCol]) === targetRaffleId;
        roundsSheet.getRange(i + 1, revCol + 1).setValue(isTarget ? 'TRUE' : 'FALSE');
      }
    }
  } else {
    // 지정한 회차를 비공개로 전환. 그 회차가 현재 공개 대상이었다면 공개 연결도 해제한다.
    if (configMap.currentRoundId === targetRaffleId) {
      raffleSetConfigValue(ss, configSheet, 'currentRoundId', '');
      raffleSetConfigValue(ss, configSheet, 'revealEnabled', 'FALSE');
    }
    if (roundsSheet) {
      var values2 = roundsSheet.getDataRange().getValues();
      var headers2 = values2[0];
      var idCol2 = headers2.indexOf('raffleId');
      var revCol2 = headers2.indexOf('revealEnabled');
      for (var k = 1; k < values2.length; k++) {
        if (String(values2[k][idCol2]) === targetRaffleId) {
          roundsSheet.getRange(k + 1, revCol2 + 1).setValue('FALSE');
          break;
        }
      }
    }
  }

  raffleWriteLog(ss, targetRaffleId, 'TOGGLE_REVEAL', (enabled ? '공개 전환' : '비공개 전환'));
  return makeResponse({ success: true, revealEnabled: enabled, raffleId: targetRaffleId });
}

// ── 추첨 진행 상태 조회 (공개 API — 비밀번호 불필요, 개인정보 미포함) ──
function raffleStatus() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  raffleEnsureSheets(ss);
  var configMap = raffleGetConfigMap(ss);
  var raffleId = configMap.currentRoundId || '';
  var revealEnabled = raffleIsTrue(configMap.revealEnabled);
  var round = raffleId ? raffleFindRound(ss, raffleId) : null;

  // 경품 인원 구성은 더 이상 전역 고정값이 아니라 회차별 값 — 현재 회차가 있으면 그 회차에
  // 저장된 실제 인원수로 구성하고, 없으면 빈 배열을 반환한다.
  var tiers = [];
  if (round) {
    tiers = [
      { tier: '1등',   count: parseInt(round.tier1Count, 10) || 0,        prize: RAFFLE_PRIZE_LABELS[0].prize },
      { tier: '2등',   count: parseInt(round.tier2Count, 10) || 0,        prize: RAFFLE_PRIZE_LABELS[1].prize },
      { tier: '3등',   count: parseInt(round.tier3Count, 10) || 0,        prize: RAFFLE_PRIZE_LABELS[2].prize },
      { tier: '참가상', count: parseInt(round.participationCount, 10) || 0, prize: RAFFLE_PRIZE_LABELS[3].prize }
    ];
  }

  return makeResponse({
    success: true,
    hasActiveRound: !!round,
    executed: !!round,
    revealEnabled: revealEnabled,
    raffleName: round ? round.raffleName : '',
    tiers: tiers
  });
}

// ── 휴대폰 번호로 본인 당첨 여부 확인 (공개 API — 비밀번호 불필요) ──
// 이름/연락처 전체/전체 당첨자 명단은 절대 반환하지 않고, 입력한 번호 1건의 결과만 반환합니다.
// status: 'NO_HISTORY'(설문 참여 이력 없음) | 'NOT_REVEALED'(아직 공개 전)
//       | 'NOT_TARGET'(참여 이력은 있으나 이번 회차 대상 아님) | 'RESULT'(대상자 — 당첨/낙첨 결과 포함)
function raffleCheck(data) {
  var phone = raffleNormalizePhone(data.phone);
  if (!phone || phone.length < 10) return makeResponse({ success: false, error: 'INVALID_PHONE' });

  var ss = SpreadsheetApp.openById(SHEET_ID);
  raffleEnsureSheets(ss);

  if (!rafflePhoneHasHistory(ss, phone)) {
    raffleWriteLog(ss, '', 'CHECK_NO_HISTORY', raffleMaskPhone(phone));
    return makeResponse({ success: true, status: 'NO_HISTORY' });
  }

  var configMap = raffleGetConfigMap(ss);
  var raffleId = configMap.currentRoundId || '';
  var revealEnabled = raffleIsTrue(configMap.revealEnabled);
  var round = raffleId ? raffleFindRound(ss, raffleId) : null;

  // round가 없는 경우(공개 대상 회차 자체가 없음 — 초기화 또는 회차 삭제로 인한 상태)와
  // round는 있으나 아직 공개 전인 경우를 구분해, 설문페이지에서 서로 다른 안내 문구를 보여준다.
  if (!round) {
    raffleWriteLog(ss, raffleId, 'CHECK_NO_ACTIVE_ROUND', raffleMaskPhone(phone));
    return makeResponse({ success: true, status: 'NO_ACTIVE_ROUND' });
  }
  if (!revealEnabled) {
    raffleWriteLog(ss, raffleId, 'CHECK_NOT_REVEALED', raffleMaskPhone(phone));
    return makeResponse({ success: true, status: 'NOT_REVEALED' });
  }

  var resultsSheet = ss.getSheetByName(RAFFLE_SHEET_RESULTS);
  var rows = resultsSheet ? sheetToObjects(ss, RAFFLE_SHEET_RESULTS) : [];
  var idx = -1, row = null;
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].raffleId === raffleId && raffleNormalizePhone(rows[i].phone) === phone) {
      row = rows[i]; idx = i; break;
    }
  }

  Logger.log('[raffleCheck] raffleId=' + raffleId + ' phone=' + raffleMaskPhone(phone) + ' 매칭행=' + (row ? 'FOUND' : 'NONE'));

  if (!row) {
    raffleWriteLog(ss, raffleId, 'CHECK_NOT_TARGET', raffleMaskPhone(phone));
    return makeResponse({ success: true, status: 'NOT_TARGET' });
  }

  var won = row.tier !== 'NONE';
  var headers = resultsSheet.getRange(1, 1, 1, resultsSheet.getLastColumn()).getValues()[0];
  var confirmedCol      = headers.indexOf('confirmed') + 1;
  var firstConfirmedCol = headers.indexOf('firstConfirmedAt') + 1;
  var lastConfirmedCol  = headers.indexOf('lastConfirmedAt') + 1;
  var confirmedCountCol = headers.indexOf('confirmedCount') + 1;
  var sheetRowNum = idx + 2;
  var nowStr = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss');

  if (!raffleIsTrue(row.confirmed)) {
    resultsSheet.getRange(sheetRowNum, confirmedCol).setValue('TRUE');
    resultsSheet.getRange(sheetRowNum, firstConfirmedCol).setValue(nowStr);
    resultsSheet.getRange(sheetRowNum, lastConfirmedCol).setValue(nowStr);
    resultsSheet.getRange(sheetRowNum, confirmedCountCol).setValue('1');
    row.firstConfirmedAt = nowStr;
    row.confirmedCount = '1';
  } else {
    var newCount = (parseInt(row.confirmedCount, 10) || 0) + 1;
    resultsSheet.getRange(sheetRowNum, lastConfirmedCol).setValue(nowStr);
    resultsSheet.getRange(sheetRowNum, confirmedCountCol).setValue(String(newCount));
    row.confirmedCount = String(newCount);
  }

  raffleWriteLog(ss, raffleId, won ? 'CHECK_WIN' : 'CHECK_LOSE', raffleMaskPhone(phone) + (won ? (' ' + row.tier) : ''));

  // 이름 표시 우선순위: 1) raffle_results에 저장된 name  2) 없으면 responseId로 원본 설문 응답 시트에서 재조회
  // 3) 그래도 없으면 빈 문자열(프론트에서 기존 공통 문구로 대체). 현재 조회한 본인 결과의 responseId만
  // 사용하므로 다른 사람 이름이 섞여 나올 가능성은 없다.
  var name = String(row.name || '').trim();
  if (!name && row.responseId) {
    var respMap = raffleGetResponsesByIds(ss, [row.responseId]);
    var resp = respMap[String(row.responseId).trim()];
    if (resp && resp.name) name = String(resp.name).trim();
  }

  return makeResponse({
    success: true, status: 'RESULT', won: won,
    name: name,
    tier: won ? row.tier : '', prize: won ? row.prize : '',
    confirmedAt: row.firstConfirmedAt || nowStr
  });
}

// ── 회차 목록 조회 (관리자 전용) ──
function raffleRoundsList(params) {
  params = params || {};
  if (!isValidPassword(params.password || '')) return makeResponse({ success: false, error: 'UNAUTHORIZED' });

  var ss = SpreadsheetApp.openById(SHEET_ID);
  raffleEnsureSheets(ss);
  var rows = sheetToObjects(ss, RAFFLE_SHEET_ROUNDS).map(function(r) {
    r.revealEnabled = raffleIsTrue(r.revealEnabled) ? 'TRUE' : 'FALSE';
    return r;
  });
  rows.reverse(); // 최신 회차 먼저
  var configMap = raffleGetConfigMap(ss);
  return makeResponse({ success: true, data: rows, currentRoundId: configMap.currentRoundId || '' });
}

// ── 당첨자(+대상자) 목록 조회 (관리자 전용, 회차 지정 없으면 현재 회차) ──
function raffleWinners(params) {
  params = params || {};
  if (!isValidPassword(params.password || '')) return makeResponse({ success: false, error: 'UNAUTHORIZED' });

  var ss = SpreadsheetApp.openById(SHEET_ID);
  raffleEnsureSheets(ss);
  var configMap = raffleGetConfigMap(ss);
  var raffleId = params.raffleId || configMap.currentRoundId || '';

  var rows = sheetToObjects(ss, RAFFLE_SHEET_RESULTS)
    .filter(function(r) { return r.raffleId === raffleId; })
    .map(function(r) {
      r.phone = raffleNormalizePhone(r.phone);
      r.confirmed = raffleIsTrue(r.confirmed) ? 'TRUE' : 'FALSE';
      return r;
    });
  Logger.log('[raffleWinners] raffleId=' + raffleId + ' 조회 건수=' + rows.length);
  return makeResponse({ success: true, raffleId: raffleId, data: rows });
}

// ── 동일 번호 중복 제출 현황 조회 (관리자 전용, 회차 지정 없으면 현재 회차 조건 기준) ──
function raffleDuplicates(params) {
  params = params || {};
  if (!isValidPassword(params.password || '')) return makeResponse({ success: false, error: 'UNAUTHORIZED' });

  var ss = SpreadsheetApp.openById(SHEET_ID);
  raffleEnsureSheets(ss);
  var configMap = raffleGetConfigMap(ss);
  var raffleId = params.raffleId || configMap.currentRoundId || '';
  var round = raffleFindRound(ss, raffleId);
  var filters = round
    ? { dateType: round.targetDateType, startDate: round.targetStartDate, endDate: round.targetEndDate, userType: round.targetUserType }
    : { dateType: 'all', userType: 'all' };

  var eligible = raffleGetEligibleEntries(ss, filters);
  var list = Object.keys(eligible.duplicatesMap).map(function(phone) {
    return { phone: phone, count: eligible.duplicatesMap[phone].length, entries: eligible.duplicatesMap[phone] };
  });
  return makeResponse({ success: true, raffleId: raffleId, data: list });
}

// ── 회차 삭제 (관리자 전용) ──────────────────────────────────────────
// raffle_id 기준으로만 삭제한다 (회차명 기준 삭제 금지 — 동명 회차 존재 시 오삭제 위험).
// 삭제 대상은 raffle_rounds/raffle_results/raffle_config(공개 연결)뿐이며,
// responses/settings/logs 등 원본 설문 데이터에는 어떤 쓰기도 하지 않는다.
function raffleDeleteRounds(data) {
  if (!isValidPassword(data.password || '')) return makeResponse({ success: false, error: 'UNAUTHORIZED' });

  var raffleIds = Array.isArray(data.raffleIds) ? data.raffleIds.map(String).filter(Boolean) : [];
  if (raffleIds.length === 0) {
    return makeResponse({ success: false, error: 'NO_TARGET', message: '삭제할 추첨 회차를 선택해주세요.' });
  }

  var ss = SpreadsheetApp.openById(SHEET_ID);
  raffleEnsureSheets(ss);

  var results = raffleIds.map(function(raffleId) { return deleteRaffleRoundById(ss, raffleId); });
  var succeeded = results.filter(function(r) { return r.success; });
  var failed = results.filter(function(r) { return !r.success; });

  if (succeeded.length === 0) {
    return makeResponse({
      success: false, error: 'DELETE_FAILED',
      message: failed[0] ? failed[0].message : '추첨 회차 삭제 중 오류가 발생했습니다.',
      results: results
    });
  }

  return makeResponse({
    success: true,
    deletedCount: succeeded.length,
    failedCount: failed.length,
    anyPublicDeleted: succeeded.some(function(r) { return r.wasPublic; }),
    results: results
  });
}

// 단일 회차 삭제 — raffle_rounds 행, raffle_results 결과, (필요 시) 공개 연결까지 정리하고 로그를 남긴다.
function deleteRaffleRoundById(ss, raffleId) {
  raffleId = String(raffleId || '');
  if (!raffleId) return { success: false, raffleId: raffleId, message: 'raffle_id가 없습니다.' };

  try {
    var round = raffleFindRound(ss, raffleId);
    if (!round) {
      return { success: false, raffleId: raffleId, message: '해당 추첨 회차를 찾을 수 없습니다 (raffle_rounds).' };
    }

    var configMap = raffleGetConfigMap(ss);
    var wasPublic = configMap.currentRoundId === raffleId;

    var deletedResultsCount = removeRaffleResultsByRaffleId(ss, raffleId);

    var roundRemoved = removeRaffleRoundRow(ss, raffleId);
    if (!roundRemoved) {
      return { success: false, raffleId: raffleId, message: 'raffle_rounds 삭제 중 오류가 발생했습니다. raffle_rounds 삭제 여부를 확인해주세요.' };
    }

    if (wasPublic) clearPublicRaffleIfDeleted(ss, raffleId);

    writeRaffleDeleteLog(ss, raffleId, round.raffleName || '', deletedResultsCount, wasPublic);

    return {
      success: true, raffleId: raffleId, raffleName: round.raffleName || '',
      deletedResultsCount: deletedResultsCount, wasPublic: wasPublic
    };
  } catch (err) {
    var errDetail = err && err.message ? err.message : String(err);
    raffleWriteLog(ss, raffleId, 'DELETE_ERROR', errDetail);
    return { success: false, raffleId: raffleId, message: '추첨 회차 삭제 중 오류가 발생했습니다: ' + errDetail };
  }
}

// raffle_rounds에서 해당 raffleId 행 1건만 삭제. responses/settings/logs 시트는 전혀 건드리지 않는다.
function removeRaffleRoundRow(ss, raffleId) {
  var sheet = ss.getSheetByName(RAFFLE_SHEET_ROUNDS);
  if (!sheet) return false;
  var values = sheet.getDataRange().getValues();
  var headers = values[0];
  var idCol = headers.indexOf('raffleId');
  if (idCol < 0) return false;
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][idCol]) === raffleId) {
      sheet.deleteRow(i + 1);
      return true;
    }
  }
  return false;
}

// raffle_results에서 해당 raffleId의 결과 행만 전부 삭제(다른 회차의 결과는 절대 건드리지 않음).
// 아래에서 위로 순회하며 삭제해 행 삭제로 인한 인덱스 밀림 문제를 피한다.
function removeRaffleResultsByRaffleId(ss, raffleId) {
  var sheet = ss.getSheetByName(RAFFLE_SHEET_RESULTS);
  if (!sheet) return 0;
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return 0;
  var headers = values[0];
  var idCol = headers.indexOf('raffleId');
  if (idCol < 0) return 0;
  var deleted = 0;
  for (var i = values.length - 1; i >= 1; i--) {
    if (String(values[i][idCol]) === raffleId) {
      sheet.deleteRow(i + 1);
      deleted++;
    }
  }
  return deleted;
}

// 삭제하는 회차가 현재 공개 대상 회차였다면 raffle_config의 공개 연결을 해제한다.
function clearPublicRaffleIfDeleted(ss, raffleId) {
  var configMap = raffleGetConfigMap(ss);
  if (configMap.currentRoundId !== raffleId) return;
  var configSheet = ss.getSheetByName(RAFFLE_SHEET_CONFIG);
  raffleSetConfigValue(ss, configSheet, 'currentRoundId', '');
  raffleSetConfigValue(ss, configSheet, 'revealEnabled', 'FALSE');
}

function writeRaffleDeleteLog(ss, raffleId, raffleName, deletedResultsCount, wasPublic) {
  var detail = (raffleName || '(이름없음)') + ' / 결과 ' + deletedResultsCount + '건 삭제 / 공개중 회차 여부 ' + (wasPublic ? 'true' : 'false');
  raffleWriteLog(ss, raffleId, 'DELETE_RAFFLE_ROUND', detail);
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

// 파트너 설문 v2(신규 24문항) 저장 테스트 — 기존 testDoPost_partner()와 별개로 유지
function testDoPost_partner_v2() {
  var testData = {
    participantType: '파트너',
    respondentName: '테스트 파트너V2',
    respondentPhone: '010-7777-8888',
    개인정보동의: '동의',
    개인정보동의일시: '2026-07-14 12:00:00',
    surveyVersion: 'partner_v2',

    partner_v2_company_name: '테스트설비',
    partner_v2_service_area: '서울 강서구',
    partner_v2_service_category: '수도·배관,누수,기타',
    partner_v2_service_category_etc: '하수구 뚫음',

    partner_v2_service_understanding: '바로 이해되었다',
    partner_v2_quote_flow: '매우 편리했다',
    partner_v2_request_information: '견적을 작성하기에 충분했다',
    partner_v2_required_request_info: '현장 사진,작업 주소 또는 지역,기타',
    partner_v2_required_request_info_etc: '건물 층수',
    partner_v2_expected_useful_features: '빠른 견적서 작성,새로운 요청 실시간 알림',
    partner_v2_expected_useful_features_etc: '',
    partner_v2_main_concerns: '특별히 걱정되는 부분 없음',
    partner_v2_main_concerns_etc: '',

    partner_v2_competitor_experience: '현재 이용하고 있다',
    partner_v2_competitive_strength: '고객 요청내용을 확인하기 편하다,본사에서 운영해 신뢰가 간다',
    partner_v2_competitive_strength_etc: '',
    partner_v2_competitive_priority: '빠르고 안정적인 정산,파트너 검증과 고객 신뢰 확보',
    partner_v2_competitive_priority_etc: '',

    partner_v2_fee_method: '작업금액과 작업 분야를 함께 고려하는 방식',
    partner_v2_fee_method_etc: '',
    partner_v2_fee_under_300k: '적당하다',
    partner_v2_fee_300k_1m: '적당하다',
    partner_v2_fee_over_1m: '조금 비싸다',
    partner_v2_fee_scenario_intent: '적극적으로 견적을 보내겠다',
    partner_v2_fee_protection: '허위 요청이면 이용료 반환,고객 연락처가 잘못되면 이용료 반환',
    partner_v2_fee_protection_etc: '',

    partner_v2_safe_payment: '미수금 걱정이 줄어들어 매우 좋다',
    partner_v2_platform_protection_role: '고객 본인인증,작업 완료 후 빠른 정산',
    partner_v2_platform_protection_role_etc: '',
    partner_v2_guarantee_intent: '크게 도움이 된다',

    partner_v2_participation_intent: '정식 오픈하면 바로 이용해보고 싶다',
    partner_v2_most_important_improvement: '견적 작성 화면에서 사진 첨부가 조금 느립니다.',
    partner_v2_additional_suggestion: '자주 쓰는 견적 템플릿 저장 기능이 있으면 좋겠습니다.'
  };
  var result = doPost({ postData: { contents: JSON.stringify(testData) }, parameter: testData });
  Logger.log('testDoPost_partner_v2 결과: ' + result.getContent());
}

// 파트너 설문 v3(Q1~Q24 + 조건부 추가질문) 저장 테스트 — 조건부 질문이 다수 노출된 케이스
function testDoPost_partner_v3() {
  var testData = {
    participantType: '파트너',
    respondentName: '테스트 파트너V3',
    respondentPhone: '010-9999-1234',
    개인정보동의: '동의',
    개인정보동의일시: '2026-07-14 12:00:00',
    surveyVersion: 'partner_v3',

    partner_v3_company_name: '테스트설비V3',
    partner_v3_service_area: '서울 강서구',
    partner_v3_service_category: '수도·배관,누수,기타',
    partner_v3_service_category_etc: '하수구 뚫음',

    partner_v3_service_understanding: '전체적인 구조가 잘 이해되지 않았다',
    partner_v3_service_confusion_detail: '수수료 발생 방식,결제 및 정산 방식',
    partner_v3_service_confusion_detail_etc: '',

    partner_v3_quote_flow: '많이 불편했다',
    partner_v3_quote_flow_inconvenience: '고객 요청 찾기,견적금액 입력',
    partner_v3_quote_flow_inconvenience_etc: '',

    partner_v3_request_information: '고객에게 추가로 물어봐야 할 정보가 많다',
    partner_v3_additional_request_information: '현장 전체 사진,정확한 작업 주소,고객 예상 예산',
    partner_v3_additional_request_information_etc: '',

    partner_v3_priority_request_information: '현장 사진·동영상,자세한 증상',
    partner_v3_priority_request_information_etc: '',

    partner_v3_expected_useful_features: '실시간 요청 알림,빠른 견적 작성',
    partner_v3_expected_useful_features_etc: '',

    partner_v3_main_concerns: '허위·장난 요청,정산 지연',
    partner_v3_main_concerns_etc: '',
    partner_v3_concern_solution: '본인인증과 빠른 정산이 필요합니다.',

    partner_v3_competitor_experience: '현재 이용 중',
    partner_v3_competitor_services: '숨고,당근',
    partner_v3_competitor_services_etc: '',

    partner_v3_competitive_strength: '차이를 느끼지 못함',
    partner_v3_competitive_strength_etc: '',
    partner_v3_competitive_weakness: '고객 요청 수,비용 장점',
    partner_v3_competitive_weakness_etc: '',

    partner_v3_competitive_priority: '허위·중복 차단,빠른 정산',
    partner_v3_competitive_priority_etc: '',

    partner_v3_fee_method: '금액과 분야 함께 고려',
    partner_v3_fee_method_etc: '',

    partner_v3_fee_under_300k_evaluation: '많이 비싸다',
    partner_v3_fee_under_300k_acceptable: '100원',
    partner_v3_fee_300k_1m_evaluation: '조금 비싸다',
    partner_v3_fee_300k_1m_acceptable: '500원',
    partner_v3_fee_over_1m_evaluation: '적당하다',
    partner_v3_fee_over_1m_acceptable: '',

    partner_v3_fee_scenario_intent: '보내지 않음',
    partner_v3_fee_scenario_rejection_reason: '수익 부족',
    partner_v3_fee_scenario_rejection_reason_etc: '',

    partner_v3_fee_protection: '허위 요청 환급,연락처 오류 환급',
    partner_v3_fee_protection_etc: '',

    partner_v3_safe_payment_evaluation: '분쟁으로 정산 보류 우려',
    partner_v3_required_payment_conditions: '분쟁 없는 금액 먼저 정산,정산 예정일 표시',
    partner_v3_required_payment_conditions_etc: '',

    partner_v3_platform_protection_role: '고객 본인인증,빠른 정산',
    partner_v3_platform_protection_role_etc: '',

    partner_v3_guarantee_intent: '파트너 책임만 커질까 우려',
    partner_v3_guarantee_required_clarity: '고객·파트너 과실 구분,환불 조건',
    partner_v3_guarantee_required_clarity_etc: '',

    partner_v3_participation_intent: '기능 개선 후 이용',
    partner_v3_participation_requirement: '고객 요청 품질,안전결제',
    partner_v3_participation_requirement_etc: '',

    partner_v3_most_important_improvement: '견적 제출 이용료 정책을 명확히 안내해주세요.',
    partner_v3_additional_suggestion: '자주 쓰는 견적 템플릿 저장 기능이 있으면 좋겠습니다.'
  };
  var result = doPost({ postData: { contents: JSON.stringify(testData) }, parameter: testData });
  Logger.log('testDoPost_partner_v3 결과: ' + result.getContent());
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

// ensureResponseHeaders와 동일한 패턴의 범용 버전 — 기존 시트에 누락된 헤더만 맨 뒤에 추가하고
// 기존 컬럼 순서/데이터는 전혀 건드리지 않는다. (raffle_rounds 등 신규 필드 추가 시 사용)
function ensureSheetHeaders(sheet, headers) {
  var lastCol = sheet.getLastColumn();
  var headerRow = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String) : [];
  headers.forEach(function(h) {
    if (headerRow.indexOf(h) === -1) {
      var newCol = sheet.getLastColumn() + 1;
      var cell = sheet.getRange(1, newCol);
      cell.setValue(h);
      cell.setFontWeight('bold').setBackground('#1a56db').setFontColor('#ffffff');
      headerRow.push(h);
    }
  });
}

// ── 헤더 "이름" 기준 행 추가 (raffle_rounds/raffle_results 전용) ──────────────
// ensureSheetHeaders는 기존 시트의 물리적 컬럼 순서를 절대 바꾸지 않고 누락된 헤더만
// 맨 뒤에 추가하기 때문에, 과거 스키마 개편으로 헤더 배열(RAFFLE_*_HEADERS)의 순서가
// 실제 시트의 물리적 컬럼 순서와 달라졌을 수 있다. 이 상태에서 값을 "위치" 기준으로
// appendRow/setValues 하면 값이 엉뚱한 컬럼(예: raffleId 값이 phone 컬럼에 저장)에
// 들어가 raffleId로 재조회했을 때 결과가 0건으로 보이는 문제가 생긴다.
// 따라서 반드시 실제 헤더 "이름"을 기준으로 값을 배치해 어떤 물리적 순서에서도
// 항상 올바른 컬럼에 저장되도록 한다. rowObjects의 각 값은 헤더명을 key로 갖는 객체.
function appendRowObjectsByHeaderName(sheet, rowObjects) {
  if (!rowObjects || !rowObjects.length) return;
  var lastCol = sheet.getLastColumn();
  var actualHeaders = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  var startRow = sheet.getLastRow() + 1;
  var values = rowObjects.map(function(obj) {
    return actualHeaders.map(function(h) {
      var v = obj[h];
      return (v !== undefined && v !== null) ? v : '';
    });
  });
  sheet.getRange(startRow, 1, values.length, lastCol).setValues(values);
}
function appendRowObjectByHeaderName(sheet, rowObject) {
  appendRowObjectsByHeaderName(sheet, [rowObject]);
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
