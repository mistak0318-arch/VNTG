import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dropPhantomToday } from "./candleGuard.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { KiwoomClient } from "./kiwoomClient.js";
import { getMarketSnapshot, peekSnapshot } from "./marketSnapshot.js";
import { evaluateMarket } from "./marketSignal.js";
import { getSectorMood } from "./sectorMood.js";
import { configFingerprint, evaluateSignal } from "./signalLight.js";
import { regimeTrust } from "./regimeWatch.js";
import { stockLens, themeMapNow } from "./stockLens.js";
import { fetchUniverse, SCREEN_UNIVERSES, type Candidate } from "./signalScreen.js";
import {
  hasDedicatedChannel,
  isTelegramConfigured,
  sendTelegram,
  stockNameHtml,
  type TelegramChannel,
} from "./telegram.js";
import {
  CROSS_GROUP,
  ensureInGroup,
  listWatchlist,
  removeFromGroup,
  removeWatchItem,
  SUPER_GROUP,
  updateWatchItem,
} from "./watchlist.js";

/**
 * 슈퍼신호등 — **여러 목록에 동시에 걸린 초록** (2026-08-25).
 *
 * 신호등 찾기의 모집단이 일곱 가지가 되면서 자연스러운 다음 물음이 생겼다:
 * 「거래대금도 몰리고, 등락률도 상위고, 외국인도 연속으로 사는 종목」 — 목록
 * **하나**에 걸린 초록보다 **여럿**에 걸린 초록이 진짜 아닐까. 그 교집합을
 * 매일 장 마감 뒤 자동으로 뽑아 며칠이고 따라가 보는 자리다. 추적기의 상위판이다.
 *
 * ## 규칙
 *
 *   모집단   일곱 목록 전부, 각 300개 기준 (짧은 목록은 주는 만큼 — ka10062 등은
 *            100건 안팎이 상한이다. 그건 그 목록의 사정이지 우리가 부풀릴 일이 아니다)
 *   교집합   **3개 목록 이상**에 등장. 7개 전부는 사실상 공집합이고, 2개는 거래대금·
 *            등락률처럼 서로 붙어 다니는 짝이 많아 흔하다. 셋부터 이야기가 된다
 *   문턱     신호등 **초록**만. 슈퍼라는 말에 노랑이 섞이면 이름이 거짓말이 된다
 *   시각     평일 15:45 — 추적기(15:40)가 같은 종목들의 신호등을 먼저 평가해
 *            15분 캐시를 데워 두므로, 5분 뒤에 돌면 대부분 캐시로 끝난다
 *
 * ## 무엇을 기록하나
 *
 * 편입일·편입가(그날 종가)·걸린 목록들·점수. 그리고 **며칠째 다시 걸리는지**
 * (`seenCount`) — 하루 반짝 교집합과 사흘째 계속 걸리는 종목은 다른 이야기다.
 * 수익률은 화면에서 지금 스냅샷과 견줘 계산한다(편입가 대비) — 추적기처럼
 * 지평별(1/5/20일) 통계까지는 표본이 쌓인 뒤의 일이다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const FILE = join(here, "..", "data", "superSignal.json");

/** 교집합 문턱 — 몇 개 목록에 걸려야 「슈퍼」인가 */
/** 기본 교집합 문턱 — 설정(SuperConfig.minLists)이 이 값을 덮는다 */
const MIN_LISTS = 3;
/** 하루에 평가할 교집합 상한 — 종목당 조회 여러 번이라 폭주를 막는다 */
const MAX_EVAL = 40;

/**
 * **무지개** — 초록 위의 등급 (2026-08-31).
 *
 * ## 왜 점수가 아니라 지속성인가
 *
 * 「초록 중 점수 80점 이상」처럼 점수를 더 높이 자르는 안도 있었지만,
 * 데이터가 그것을 지지하지 않았다 — 「목록 4곳 이상」이 전체와 성적이
 * **똑같았다**(둘 다 d1 -0.13%, n=29). 좁혔는데 안 나아진 것이다.
 *
 * 갈린 것은 **지속성**이었다: 「이틀 이상 반복」 12종목이 d1 +2.16% 로
 * 전체보다 2.3%p 높았다. 그래서 무지개의 정의를 지속성에 둔다.
 *
 * ## 왜 사흘인가
 *
 * 이틀 이상은 29개 중 12개(41%)라 **배지로서 변별력이 없다** — 열에 넷이
 * 달고 있으면 눈에 안 띈다. 사흘로 올리면 드물어져 배지가 제 몫을 한다.
 *
 * ⚠️ 사흘이 이틀보다 실제로 나은지는 **아직 모른다**. 확장한 성적표가
 * 「이틀 이상」과 「사흘 이상」을 둘 다 재고 있으니, 며칠 쌓인 뒤에 이 값을
 * 옮기면 된다. 근거 없이 정한 숫자가 아니라 **재고 있는 숫자**다.
 */
/** 기본 무지개 문턱 — 설정(SuperConfig.rainbowDays)이 이 값을 덮는다 */
const RAINBOW_DAYS = 3;

/**
 * 하루 한 줄 — 편입 후 이 종목이 **어떻게 흘러갔는지**의 원장 (2026-08-26).
 * 점수는 과거로 되짚어 잴 수 없으므로(신호등은 그날 데이터로만 평가된다)
 * 매일 장 마감 뒤 적어 두는 이 기록이 점수 흐름의 유일한 소스다.
 */
export interface SuperDaily {
  date: string;
  close: number;
  score: number;
  level: string;
  /**
   * 그날 체크별 판정 (라벨·grade 0/50/100/null) — **점수 변동 사유의 재료** (2026-08-27).
   * 점수만 적어 두면 「왜 빠졌나」를 되짚을 길이 없다 — 신호등은 그날 데이터로만
   * 평가되므로, 체크 내역도 그날 적어 두는 이 기록이 유일한 소스다.
   * 화면이 전날과 견줘 「정배열 100→50」 같은 사유를 만든다. 키를 l·g 로 줄여
   * 적는다 — 120일 × 체크 열두어 개가 종목마다 쌓이는 파일이다.
   */
  checks?: { l: string; g: number | null }[];
  /**
   * 그날의 시장 신호등 (2026-08-27) — 메모 복기 브리핑용. "종목이 죽었나 장이
   * 죽었나"는 그날 시장을 같이 봐야 답이 나온다. 하루 한 번 평가한 값을 전 종목에
   * 같이 찍는다 — 종목당 비용이 늘지 않는다.
   */
  market?: { level: string; score: number };
}

/** 메모 한 줄 — 그날 무엇을 보고 무엇을 추적하려 했는지의 흔적 */
export interface SuperNote {
  date: string;
  text: string;
}

/** 이탈 기록 — 언제·얼마에·몇 점으로 떨어졌고, 그날 시장은 어땠나 */
export interface SuperExit {
  date: string;
  price: number | null;
  score: number | null;
  /** 이탈 시점의 시장 신호등 — 「내가 죽었나, 장이 죽었나」를 가른다 */
  marketLevel: string | null;
  marketScore: number | null;
  note: string;
  /** true = 신호등이 초록에서 떨어져 자동 이탈, false = 손으로 이탈 처리 */
  auto: boolean;
}

export interface SuperEntry {
  code: string;
  name: string;
  /** 편입일 (YYYY-MM-DD) */
  addedDate: string;
  /** 편입일 가격 — 그날 모집단 조회가 준 값 */
  addedPrice: number;
  /** 편입 당시 신호등 점수 */
  score: number;
  /**
   * **편입 당시 기준의 지문** (2026-08-31).
   *
   * 신호등 기준은 언제든 바뀐다. 기준이 바뀌면 **그 전의 90점과 그 뒤의 90점은
   * 다른 것**이라, 한 표에 섞으면 평균이 뜻을 잃는다. 추적기(`signalTrack`)는
   * 처음부터 이 지문을 남기고 있었는데 이 원장에는 없었다.
   *
   * ⚠️ 옛 편입분에는 이 값이 없다(`undefined`). **그것도 정보다** — 「기준을
   * 바꾸기 전에 담은 것」이라는 뜻이라, 없다고 지어내지 않는다.
   */
  configHash?: string;
  /**
   * **편입한 날의 장세** (2026-08-31).
   *
   * 같은 기준이 폭 좁은 날에는 시장에 지고 넓은 날에는 이긴다(실측 -2.15%p ↔ +2.96%p).
   * 그러면 「이 편입이 어떤 장세에서 나온 것인가」가 성적을 읽는 데 꼭 필요하다.
   * 지문(`configHash`)이 「어떤 기준으로」라면 이건 **「어떤 장세에서」**다.
   *
   * ⚠️ 옛 편입분에는 없다(`undefined`). 그것도 정보다 — 재기 전에 담은 것이다.
   */
  regime?: {
    /** 20일선 위 종목 비율 % */
    breadth: number | null;
    /** 60일 신고가 근처 비율 % */
    newHigh: number | null;
    /** 문턱 아래였나 — 「잘 안 듣는 장세」 */
    weak: boolean;
    /** 왜 약했나 — 사람이 읽는 한 줄 */
    why?: string | null;
  };
  /** 걸린 목록 (SCREEN_UNIVERSES key) — 마지막으로 걸린 날 기준 */
  lists: string[];
  /**
   * **교집합에 걸린 날이 몇 번인가** — 지속성이 곧 신호다.
   *
   * ⚠️ 「편입 후 며칠」이 **아니다.** 8/28 에 편입돼서 그 뒤로 한 번도 다시
   * 안 걸렸으면, 오늘이 8/31 이어도 이 값은 1 이다. 화면이 이걸 「1일째」로
   * 적어 편입일과 어긋나 보인다는 지적이 있었다(2026-08-31) — 그래서 경과일은
   * `daysSince` 로 따로 낸다. 두 값은 서로 다른 질문의 답이다.
   */
  seenCount: number;
  lastSeenDate: string;
  /**
   * 편입 후 N거래일 뒤 종가의 편입가 대비 (%) — 채점의 재료 (2026-08-25).
   * 봉이 아직 안 쌓였으면 null. d20 까지 차면 더 안 잰다(끝난 성적표다).
   */
  returns?: { d1: number | null; d5: number | null; d20: number | null };
  /**
   * **지수 대비 초과수익**(%p) — 같은 날짜의 코스피 수익률을 뺀 값 (2026-08-31).
   *
   * 이게 없으면 「d1 평균 -0.13%」가 나쁜 건지 알 수가 없다 — 그날 시장이 -1%
   * 였으면 오히려 이긴 것이다. 절대수익률만 보는 성적표는 상승장에서 전부
   * 좋아 보이고 하락장에서 전부 나빠 보인다.
   */
  excess?: { d1: number | null; d5: number | null; d20: number | null };
  /**
   * **이탈 후 성적** — 이탈일 종가 대비 (2026-08-31).
   *
   * 이탈 규칙이 맞았는지 재는 **유일한 길**이다. 이탈시켰는데 그 뒤로 올랐으면
   * 이탈이 이르렀던 것이고, 더 빠졌으면 잘 나온 것이다. 그 물음에 답할 자료가
   * 지금까지 없었다 — 이탈은 판정만 하고 뒤를 안 봤다.
   *
   * 부호는 **이탈한 사람 관점**이다: 양수면 「나오고 나서 올랐다(아까웠다)」,
   * 음수면 「나오길 잘했다」.
   */
  afterExit?: { d1: number | null; d5: number | null; d20: number | null };
  /** 추적 중인가 — 이탈하면 false. 교집합에 다시 걸리면 되살아난다 */
  active?: boolean;
  /** 편입 후 일별 기록 (종가·점수) — 대시보드의 점수/주가 흐름이 이걸 읽는다 */
  daily?: SuperDaily[];
  /** 이탈 이력 — 재편입돼도 지우지 않는다. 이탈→복귀 자체가 정보다 */
  exits?: SuperExit[];
  /** 자유 메모 — 마지막 것. 표의 📝 표시가 이걸 본다 (이력은 notes) */
  note?: string;
  /**
   * 메모 이력 (2026-08-27) — 덮어쓰지 않고 날짜와 함께 쌓는다.
   * "그날 무엇을 메모했고 추적하려 했는지 알아야지" — 복기는 이력이 전부다.
   */
  notes?: SuperNote[];
}

/**
 * 슈퍼신호등 설정 — **벤티지가 조절한다** (2026-08-31).
 *
 * 두 문턱 다 「재고 있는 숫자」다. 성적표가 3곳/4곳/5곳과 하루/이틀/사흘을
 * 각각 재고 있으므로, 며칠 쌓인 뒤에 여기서 옮기면 된다.
 * 코드에 박아 두면 그 실험을 하려고 매번 배포해야 한다.
 */
export interface SuperConfig {
  /** 몇 개 목록에 걸려야 「슈퍼」인가 */
  minLists: number;
  /**
   * 며칠째 계속 걸리면 **무지개**인가.
   *
   * ## 사흘 → 이틀 (2026-08-31 개정)
   *
   * 처음엔 「이틀은 29개 중 12개(41%)라 배지로서 변별력이 없다」는 이유로 사흘로
   * 뒀다. **그건 눈에 띄는가의 문제였지 성적의 문제가 아니었다.**
   *
   * 표본 19만 관측으로 되짚으니 **이틀이 가장 좋았다:**
   *
   *   첫날      초과 +1.68%p   뒤 +4.18   n 1,038
   *   이틀 연속  초과 +1.97%p   뒤 +4.09   n 1,263   ← 최고
   *   사흘 이상  초과 +1.21%p   뒤 +0.99   n 7,050
   *   닷새 이상  초과 +1.16%p   뒤 +0.55   n 4,969
   *
   * 사흘부터 떨어진다. 그리고 **실제 원장도 같은 말을 한다** — 편입분 29건에서
   * 「이틀 이상 반복 +2.16%」였다. 표본과 원장이 처음으로 일치한 지점이라
   * 근거로 삼을 만하다.
   *
   * 읽자면, 이틀은 「어제도 오늘도 걸렸다」는 확인이고 사흘 이상은 **이미 간
   * 자리**다. 교집합을 4곳·5곳으로 좁힐수록 나빠진 것과 같은 부류다.
   */
  rainbowDays: number;
  /**
   * **목록마다 몇 종목까지 받을까** (2026-08-31).
   *
   * 이게 슈퍼신호등의 **모집단**이다. 300 이면 거래대금 301위는 아무리 좋아도
   * 후보가 될 수 없다 — 신호등 찾기에서 500 으로 놓고 찾으면 나오는 종목이
   * 슈퍼에는 영영 안 들어온다. 그 경계를 사람이 정할 수 있어야 한다.
   *
   * ⚠️ 늘리면 스캔이 길어진다. 일곱 목록을 차례로 받고 사이에 400ms 를 쉬므로
   * (초당 5회 제한) 500 이면 목록마다 연속조회가 한두 쪽 더 붙는다.
   */
  universeSize: number;
  /**
   * **교집합 통과분 중 몇 개까지 신호등을 잴까.**
   *
   * ⚠️ **교집합 문턱과 직접 충돌하는 값이다.** 문턱을 2곳으로 낮추면 통과분이
   * 크게 늘어나는데, 이 상한이 그대로면 **낮춘 만큼 더 보려던 것이 오히려
   * 조용히 잘린다.** 둘을 같이 조절해야 뜻이 맞는다 — 화면이 그때 경고한다.
   *
   * 여기가 제일 무겁다: 종목당 여러 TR 이고 사이에 220ms 를 쉰다.
   * 40 → 80 이면 이 구간이 두 배가 된다.
   */
  maxEval: number;
  /**
   * **폭이 좁은 날(신호등이 잘 안 듣는 장세)에 어떻게 할까** (2026-08-31).
   *
   * 조건부 성적표 실측: 폭 하위 1/3 에서 초록이 시장에 **-2.15%p 졌고 승률 43%**
   * 였다(앞·뒤 절반 모두 음수). 폭 상위 1/3 에서는 +2.96%p. 같은 기준인데 장세에
   * 따라 부호가 뒤집힌다.
   *
   *   `mark` (기본) — **담되 표시한다.** 화면이 흐리게 그리고 성적표가 따로 채점한다
   *   `skip`        — 그날은 아예 안 담는다
   *
   * ## 왜 기본이 `mark` 인가
   *
   * `skip` 이 더 나아 보이지만, 그러면 **문턱이 틀렸을 때 영영 확인할 수 없다.**
   * 안 담았으니 「그날 담았으면 어땠을까」가 기록에 없다. 이 앱은 판단과 그 결과를
   * 한 줄에 묶어 남기는 것이 요점이라, 먼저 **재고** 나서 끊는 것이 순서다.
   * 몇 달 뒤 성적표가 「약한 장세 편입이 정말 나빴다」를 보여 주면 그때 `skip` 으로
   * 옮기면 된다 — 근거를 갖고.
   */
  weakRegimeMode: "mark" | "skip";
}

export const DEFAULT_SUPER_CONFIG: SuperConfig = {
  minLists: 3,
  /* 2026-08-31 — 19만 관측 실측에서 이틀이 최고였다(위 주석). 원장도 같은 말을 한다 */
  rainbowDays: 2,
  universeSize: 300,
  maxEval: 40,
  weakRegimeMode: "mark",
};

interface Store {
  entries: SuperEntry[];
  lastRunDate: string | null;
  config?: SuperConfig;
}

/** 저장된 설정 + 기본값 — 항목이 늘어도 옛 파일이 그것을 지우지 않게 항목별로 합친다 */
function cfgOf(store: Store): SuperConfig {
  return { ...DEFAULT_SUPER_CONFIG, ...(store.config ?? {}) };
}

export async function getSuperConfig(): Promise<SuperConfig> {
  return cfgOf(await load());
}

/** 값의 범위는 여기서 막는다 — 화면을 믿지 않는다(직접 PUT 할 수도 있다) */
export async function saveSuperConfig(input: Partial<SuperConfig>): Promise<SuperConfig> {
  const store = await load();
  const cur = cfgOf(store);
  const num = (v: unknown, lo: number, hi: number, dflt: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt;
  };
  store.config = {
    /* 2 미만이면 「교집합」이 아니고, 7 은 목록 전체라 아무것도 안 걸린다 */
    minLists: num(input.minLists, 2, 6, cur.minLists),
    /* 1 이면 편입 즉시 무지개라 등급이 아니게 된다 */
    rainbowDays: num(input.rainbowDays, 2, 10, cur.rainbowDays),
    /* 100 미만이면 교집합이 거의 안 생기고, 500 이 키움 순위 조회의 실질 천장이다 */
    universeSize: num(input.universeSize, 100, 500, cur.universeSize),
    /* 10 미만이면 볼 게 없고, 120 이면 신호등 평가만 몇 분이 된다 */
    maxEval: num(input.maxEval, 10, 120, cur.maxEval),
    /* 둘 중 하나만 — 딴 값이 오면 지금 값을 지킨다 */
    weakRegimeMode:
      input.weakRegimeMode === "skip" || input.weakRegimeMode === "mark"
        ? input.weakRegimeMode
        : cur.weakRegimeMode,
  };
  await save(store);
  return store.config;
}

const EMPTY: Store = { entries: [], lastRunDate: null };

async function load(): Promise<Store> {
  try {
    const raw = JSON.parse(await readFile(FILE, "utf-8")) as Partial<Store>;
    const entries = (Array.isArray(raw.entries) ? raw.entries : []).map((e) => ({
      ...e,
      // 대시보드 필드가 생기기 전(2026-08-26 이전) 저장분 — 전부 추적 중으로 본다
      active: e.active !== false,
      daily: Array.isArray(e.daily) ? e.daily : [],
      exits: Array.isArray(e.exits) ? e.exits : [],
      // 메모 이력이 생기기 전 저장분 — 홑 메모를 편입일 이력 한 줄로 옮긴다
      notes: Array.isArray(e.notes)
        ? e.notes
        : e.note
          ? [{ date: e.addedDate, text: e.note }]
          : [],
    }));
    return {
      entries,
      lastRunDate: typeof raw.lastRunDate === "string" ? raw.lastRunDate : null,
      /*
       * ⚠️ **설정을 여기서 빠뜨리면 저장은 되는데 안 읽힌다** — 실측에서 그랬다:
       * PUT 은 성공하고 파일에도 남는데 무지개 수가 안 바뀌었다. 읽는 쪽이
       * 통째로 버리고 있었기 때문이다. 새 필드를 Store 에 더할 때마다 여기도 봐야 한다.
       */
      config: raw.config,
    };
  } catch {
    return { ...EMPTY };
  }
}

/**
 * 사이드바 배지용 — 마지막 수집일 + 추적 중 종목의 당일 상승/하락 수.
 * 시세는 peekSnapshot(캐시만)으로 센다 — 1분 폴링이 시장 스캔을 유발하면 안 된다.
 * 캐시가 아직 없으면 up/down 은 null(배지가 그 부분만 생략).
 */
export async function superRunStatus(): Promise<{
  lastRunDate: string | null;
  up: number | null;
  down: number | null;
  /** 추적 중 종목 — 캘린더의 공시 매칭 등 가벼운 소비처용 */
  stocks: { code: string; name: string }[];
}> {
  const store = await load();
  const snap = peekSnapshot();
  let up: number | null = null;
  let down: number | null = null;
  if (snap) {
    up = 0;
    down = 0;
    for (const e of store.entries) {
      if (e.active === false) continue;
      const r = snap.byCode.get(e.code)?.changeRate;
      if (typeof r !== "number") continue;
      if (r > 0) up += 1;
      else if (r < 0) down += 1;
    }
  }
  /* 원장(active) + 「슈퍼신호등+교차」 관심 그룹 — 캘린더 공시 매칭이 합집합을 쓴다 */
  const stocks = store.entries
    .filter((e) => e.active !== false)
    .map((e) => ({ code: e.code, name: e.name }));
  try {
    const seen = new Set(stocks.map((s) => s.code));
    for (const w of await listWatchlist()) {
      if (w.groups.includes(CROSS_GROUP) && !seen.has(w.code)) {
        seen.add(w.code);
        stocks.push({ code: w.code, name: w.name });
      }
    }
  } catch {
    /* 관심종목을 못 읽어도 원장만으로 답한다 */
  }
  return { lastRunDate: store.lastRunDate, up, down, stocks };
}

async function save(s: Store): Promise<void> {
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(s, null, 2), "utf-8");
}

function todayStr(d = new Date()): string {
  const k = new Date(d.getTime() + 9 * 3600_000);
  return k.toISOString().slice(0, 10);
}

/**
 * 편입 후 성적 매기기 — 매일 실행 끝에 돌린다.
 *
 * 종목당 일봉 한 번(ka10081)으로 편입일 이후 1/5/20거래일 종가를 찾아
 * 편입가 대비 %를 적어 둔다. d20 까지 찬 종목은 성적표가 끝났으니 다시
 * 조회하지 않는다 — 그래서 호출량은 「아직 성적이 진행 중인 종목 수」만큼이다.
 */
/**
 * 코스피 일봉 종가 — 날짜(YYYYMMDD) → 종가.
 *
 * 지수 대비 성적의 기준이다. **한 번만 받는다** — 종목마다 부르면 채점이
 * 그만큼 느려지고 호출도 는다. ka20006 은 지수를 100배로 주는데, 우리는
 * 비율만 쓰므로 그대로 둬도 된다(나눗셈에서 상쇄된다).
 */
async function kospiCloses(client: KiwoomClient): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    const d = new Date(Date.now() + 9 * 3600_000);
    const { data } = await client.request<{ inds_dt_pole_qry?: Record<string, unknown>[] }>(
      "/api/dostk/chart",
      "ka20006",
      { inds_cd: "001", base_dt: d.toISOString().slice(0, 10).replace(/-/g, "") },
    );
    for (const r of dropPhantomToday((data.inds_dt_pole_qry ?? []) as Record<string, unknown>[])) {
      const dt = String(r.dt ?? "");
      const close = Math.abs(Number(String(r.cur_prc ?? "").replace(/[+,]/g, "")));
      if (/^\d{8}$/.test(dt) && close > 0) out.set(dt, close);
    }
  } catch {
    /* 지수를 못 받으면 지수 대비는 안 낸다 — 절대수익률로 대신하지 않는다 */
  }
  return out;
}

async function gradeEntries(client: KiwoomClient, store: Store): Promise<number> {
  /*
   * 채점이 남은 것 = 편입 성적이 안 찼거나(d20) **이탈 후 성적이 안 찬 것**.
   * 이탈분도 뒤를 봐야 이탈 규칙을 잴 수 있다(2026-08-31).
   */
  const pending = store.entries.filter(
    (e) =>
      e.addedPrice > 0 &&
      (e.returns?.d20 == null ||
        (e.active === false && (e.exits?.length ?? 0) > 0 && e.afterExit?.d20 == null)),
  );
  const kospi = pending.length > 0 ? await kospiCloses(client) : new Map<string, number>();
  let graded = 0;
  for (const e of pending) {
    try {
      const d = new Date(Date.now() + 9 * 3600_000);
      const base = d.toISOString().slice(0, 10).replace(/-/g, "");
      const res = await client.request<Record<string, unknown>>("/api/dostk/chart", "ka10081", {
        stk_cd: e.code,
        base_dt: base,
        upd_stkpc_tp: "1",
      });
      const rows = (dropPhantomToday((res.data?.stk_dt_pole_chart_qry ?? []) as Record<string, unknown>[]))
        .map((r) => ({
          date: String(r.dt ?? ""),
          close: Math.abs(Number(String(r.cur_prc ?? "").replace(/[+,]/g, ""))),
        }))
        .filter((r) => /^\d{8}$/.test(r.date) && r.close > 0)
        .sort((a, b) => a.date.localeCompare(b.date));
      const addedYmd = e.addedDate.replace(/-/g, "");
      const idx = rows.findIndex((r) => r.date === addedYmd);
      if (idx < 0) continue; // 편입일 봉이 아직 없다(장중 실행 등) — 다음에
      /*
       * **기준은 편입일 종가다** (2026-08-31).
       *
       * 편입은 15:45 에 일어난다. 그 시각 **NXT 애프터마켓(15:40~20:00)이 열려 있어
       * 실제로 살 수 있다** — 그러니 「불가능한 매매」는 아니다.
       *
       * 다만 애프터마켓은 **별도 호가**라 KRX 정규장 종가와 값이 다르고 유동성도
       * 얕다. 그래서 이 수익률은 「종가에 샀다면」이라는 **근사**이지 체결 가능한
       * 가격으로 잰 성과가 아니다. 그 차이를 화면에 적는다.
       *
       * 신호등 백테스트는 **다음 날 시가**를 쓴다(2026-08-31) — 일봉에 애프터마켓
       * 가격이 없어 그쪽이 더 보수적인 가정이기 때문이다.
       */
      const pct = (n: number): number | null => {
        const bar = rows[idx + n];
        return bar ? ((bar.close - e.addedPrice) / e.addedPrice) * 100 : null;
      };
      if (e.returns?.d20 == null) e.returns = { d1: pct(1), d5: pct(5), d20: pct(20) };

      /*
       * **지수 대비** — 같은 날짜의 코스피 수익률을 뺀다. 지수를 못 읽으면
       * 안 낸다(null) — 절대수익률을 초과수익이라고 적으면 상승장에서 전부
       * 이긴 것처럼 보인다.
       */
      const idxPct = (n: number): number | null => {
        const bar = rows[idx + n];
        const base = kospi.get(addedYmd);
        const then = bar ? kospi.get(bar.date) : undefined;
        if (!bar || !base || !then) return null;
        return ((then - base) / base) * 100;
      };
      const minus = (a: number | null, b: number | null) => (a === null || b === null ? null : a - b);
      e.excess = {
        d1: minus(e.returns?.d1 ?? null, idxPct(1)),
        d5: minus(e.returns?.d5 ?? null, idxPct(5)),
        d20: minus(e.returns?.d20 ?? null, idxPct(20)),
      };

      /*
       * **이탈 후 성적** — 이탈일 종가 대비. 이탈 규칙이 맞았는지 재는 유일한 길이다.
       * 부호는 이탈한 사람 관점 — 양수면 「나오고 나서 올랐다(아까웠다)」.
       */
      const lastExit = e.exits?.[e.exits.length - 1];
      if (e.active === false && lastExit) {
        const exitYmd = lastExit.date.replace(/-/g, "");
        const ei = rows.findIndex((r) => r.date === exitYmd);
        const exitClose = ei >= 0 ? rows[ei].close : null;
        if (ei >= 0 && exitClose && exitClose > 0) {
          const after = (n: number): number | null => {
            const bar = rows[ei + n];
            return bar ? ((bar.close - exitClose) / exitClose) * 100 : null;
          };
          e.afterExit = { d1: after(1), d5: after(5), d20: after(20) };
        }
      }
      graded += 1;
    } catch {
      /* 한 종목 실패는 넘어간다 — 다음 실행에 다시 잰다 */
    }
    await new Promise((r) => setTimeout(r, 260));
  }
  return graded;
}

/**
 * 일별 기록 + 자동 이탈 판정 (2026-08-26) — 매일 실행 끝에 돈다.
 *
 * 추적 중(active) 종목마다 오늘의 종가·신호등 점수를 한 줄 적는다. 점수는
 * 과거로 못 되짚으므로 이 기록이 곧 「편입 후 점수가 어떻게 흘러갔나」다.
 *
 * ## 자동 이탈
 *
 * 슈퍼신호등의 정의가 「초록」이므로, 초록에서 떨어진 게 이탈이다. 다만 노랑을
 * 하루 스치고 돌아오는 종목이 흔해서 **이틀 연속** 초록 미만일 때만 이탈로 적는다.
 * 이탈 시점의 시장 신호등을 같이 적는다 — 종목이 죽은 건지 장이 꺾인 건지는
 * 나중에 복기할 때 가장 먼저 묻게 되는 것이다.
 *
 * 조회 비용: 15:45 실행 직전에 추적기·교집합 평가가 신호등 캐시(15분)를 데워
 * 두므로 대부분 캐시로 끝난다. 그래도 상한(60종목)을 둔다.
 */
async function recordSuperDaily(client: KiwoomClient, store: Store): Promise<SuperEntry[]> {
  const today = todayStr();
  const exited: SuperEntry[] = [];
  const active = store.entries.filter((e) => e.active !== false).slice(0, 60);
  if (active.length === 0) return exited;

  const snap = await getMarketSnapshot(client).catch(() => null);
  /* 시장 신호등 — 하루 한 번 평가해 일별 기록(복기 브리핑 재료)과 이탈 기록이 같이 쓴다 */
  const market: { level: string; score: number } | null = await evaluateMarket(client)
    .then((m) => ({ level: m.level, score: m.score }))
    .catch(() => null);

  for (const e of active) {
    try {
      const sig = await evaluateSignal(client, e.code);
      const close = snap?.byCode.get(e.code)?.price ?? 0;
      const daily = (e.daily ??= []);
      const row: SuperDaily = {
        date: today,
        close,
        score: sig.score,
        level: sig.level,
        // 체크 내역 — 내일 이후 「무엇 때문에 점수가 움직였나」를 이걸로 되짚는다
        checks: sig.checks.map((c) => ({ l: c.label, g: c.grade })),
        ...(market ? { market } : {}),
      };
      const last = daily[daily.length - 1];
      if (last?.date === today) daily[daily.length - 1] = row;
      else daily.push(row);
      if (daily.length > 120) daily.splice(0, daily.length - 120); // 넉 달이면 충분하다

      // 이틀 연속 초록 미만 → 자동 이탈
      const n = daily.length;
      if (n >= 2 && daily[n - 1].level !== "green" && daily[n - 2].level !== "green") {
        e.active = false;
        (e.exits ??= []).push({
          date: today,
          price: close > 0 ? close : null,
          score: sig.score,
          marketLevel: market?.level ?? null,
          marketScore: market?.score ?? null,
          note: "신호등 초록 이탈 (이틀 연속)",
          auto: true,
        });
        exited.push(e);
        /*
         * **관심종목 그룹에서도 뺀다** (2026-08-31).
         *
         * 이탈 판정이 원장에만 반영되고 관심종목은 그대로여서 목록이 쌓이기만 했다.
         * 이탈 이력은 슈퍼신호등 메뉴가 들고 있으니(이탈 켬/끔) 관심종목에는
         * **지금 편입된 것만** 있으면 된다.
         *
         * 그룹만 뺀다 — 그 종목을 벤티지가 직접 다른 그룹에 담았을 수 있다.
         */
        await removeFromGroup(e.code, SUPER_GROUP).catch(() => undefined);
      }
    } catch {
      /* 한 종목 실패는 다음 날 다시 */
    }
    await new Promise((r) => setTimeout(r, 220));
  }
  return exited;
}

/**
 * 관심종목 「슈퍼신호등」 그룹을 원장과 **맞춘다** (2026-08-31).
 *
 * 이탈할 때 그룹에서 빼는 길은 이제 있지만, 그 기능이 생기기 **전에** 이탈한
 * 것들은 그대로 남아 있다 — 실측에서 29개 중 9개가 그랬다(한화오션·GS건설…).
 * 앞으로만 고치면 이 아홉은 영영 남는다.
 *
 * 서버가 뜰 때 한 번 맞춘다. **자가 치유**이기도 하다 — 어떤 이유로든 둘이
 * 어긋나면 다음 재시작에 제자리로 온다.
 *
 * ⚠️ 원장에 **없는** 종목은 건드리지 않는다. 벤티지가 손으로 그 그룹에 담았을
 * 수 있고, 그건 우리가 지울 것이 아니다. 원장에 있으면서 이탈한 것만 뺀다.
 */
export async function syncSuperGroup(): Promise<{ removed: string[] }> {
  const removed: string[] = [];
  try {
    const store = await load();
    const inactive = new Set(
      store.entries.filter((e) => e.active === false).map((e) => e.code),
    );
    if (inactive.size === 0) return { removed };
    for (const w of await listWatchlist()) {
      if (!w.groups.includes(SUPER_GROUP)) continue;
      if (!inactive.has(w.code)) continue;
      if (await removeFromGroup(w.code, SUPER_GROUP)) removed.push(w.name);
    }
  } catch {
    /* 맞추기가 실패해도 서버는 뜬다 — 다음 재시작에 다시 시도한다 */
  }
  return { removed };
}

// ---------------------------------------------------------------- 텔레그램 (전용 방)

/**
 * 슈퍼신호등 전용 방 (2026-08-26).
 *
 * `.env` 에 `TELEGRAM_CHAT_ID_SUPER` 를 넣으면 그 방이 **슈퍼 종목의 이벤트 허브**가
 * 된다 — 편입·이탈은 여기서 직접 보내고, 시그널·공시·키워드 알림은 각자의 발송
 * 지점이 `superRoute()` 로 물어서 슈퍼 종목 건만 이 방으로 돌린다.
 * 전용 방이 없으면 아무것도 안 바뀐다 — 전부 원래 갈래로 간다.
 */

/** 추적 중인 슈퍼 종목 — 라우팅용. 발송 지점들이 1분마다 물어봐서 캐시를 둔다 */
let activeCache: { at: number; list: { code: string; name: string }[] } | null = null;

export async function getActiveSuper(): Promise<{ code: string; name: string }[]> {
  if (activeCache && Date.now() - activeCache.at < 60_000) return activeCache.list;
  const store = await load();
  const list = store.entries
    .filter((e) => e.active !== false)
    .map((e) => ({ code: e.code, name: e.name }));
  activeCache = { at: Date.now(), list };
  return list;
}

/**
 * 이 종목의 알림을 어느 방으로 보낼까 — 슈퍼 전용 방이 있고 슈퍼 종목이면 "super",
 * 아니면 원래 갈래. 발송 지점이 한 줄로 쓰라고 만든 헬퍼다.
 */
export async function superRoute(
  code: string,
  fallback: TelegramChannel,
): Promise<TelegramChannel> {
  if (!hasDedicatedChannel("super")) return fallback;
  const list = await getActiveSuper().catch(() => [] as { code: string }[]);
  return list.some((s) => s.code === code) ? "super" : fallback;
}

const UNIVERSE_LABEL = new Map(SCREEN_UNIVERSES.map((u) => [u.key, u.label]));

function fmtWon(n: number): string {
  return Math.round(n).toLocaleString("ko-KR");
}

/** 편입·부활·이탈을 한 통으로 — 하루 한 번 15:45 실행이 보낸다 */
function formatSuperRun(
  added: SuperEntry[],
  revived: SuperEntry[],
  exited: SuperEntry[],
): string {
  const parts: string[] = [];
  const listNames = (e: SuperEntry) =>
    e.lists.map((k) => UNIVERSE_LABEL.get(k) ?? k).join(" · ");

  if (added.length > 0) {
    parts.push(
      `🌟 <b>슈퍼신호등 편입 ${added.length}건</b>\n` +
        added
          .map(
            (e) =>
              `• ${stockNameHtml(e.code, e.name)}  ${fmtWon(e.addedPrice)}  ${e.score}점\n` +
              `  목록 ${e.lists.length}곳 — ${listNames(e)}`,
          )
          .join("\n"),
    );
  }
  if (revived.length > 0) {
    parts.push(
      `♻️ <b>다시 걸림 ${revived.length}건</b> (이탈했다가 교집합 복귀)\n` +
        revived
          .map((e) => `• ${stockNameHtml(e.code, e.name)} — ${e.seenCount}일째 · 목록 ${e.lists.length}곳`)
          .join("\n"),
    );
  }
  if (exited.length > 0) {
    parts.push(
      `⛔ <b>이탈 ${exited.length}건</b> (신호등 초록에서 이틀 연속 미달)\n` +
        exited
          .map((e) => {
            const ex = e.exits?.[e.exits.length - 1];
            const ret =
              ex?.price && e.addedPrice > 0
                ? ` · 편입 대비 ${(((ex.price - e.addedPrice) / e.addedPrice) * 100).toFixed(1)}%`
                : "";
            const mkt = ex?.marketLevel ? ` · 시장 ${ex.marketLevel} ${ex.marketScore ?? ""}점` : "";
            return `• ${stockNameHtml(e.code, e.name)} — ${e.addedDate} 편입${ret}${mkt}`;
          })
          .join("\n"),
    );
  }
  return parts.join("\n\n");
}

async function notifySuperRun(
  added: SuperEntry[],
  revived: SuperEntry[],
  exited: SuperEntry[],
  /** 지금 추적 중인 수 — 변화가 없는 날의 「살아 있다」 한 줄에 쓴다 */
  activeCount = 0,
): Promise<void> {
  /* 전용 방이 있으면 거기로, 없으면 시그널 방으로 — 어쨌든 이 소식은 봐야 한다 */
  const ch: TelegramChannel = hasDedicatedChannel("super") ? "super" : "signal";
  if (!isTelegramConfigured(ch)) return;

  /*
   * ⚠️ 변화가 없으면 **아무것도 안 보냈다** (2026-08-27 수리).
   *
   * 조용한 게 맞긴 한데, 그러면 「돌고 있는지」를 알 방법이 없다 — 실제로
   * 「슈퍼신호등이 아무것도 안 온다」가 나왔고, 그게 고장인지 변화가 없는 건지
   * 사용자가 가릴 수가 없었다. 변화 없는 날은 **한 줄만** 보낸다.
   * 하루 한 번이라 소음이 되지 않고, 이 줄이 오면 「어제도 돌았다」가 증명된다.
   */
  if (added.length + revived.length + exited.length === 0) {
    const kst = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
    await sendTelegram(
      `🌟 <b>슈퍼신호등 ${kst}</b>\n오늘 편입·이탈 없음 · 추적 중 ${activeCount}종목`,
      ch,
    ).catch(() => undefined);
    return;
  }
  await sendTelegram(formatSuperRun(added, revived, exited), ch).catch(() => undefined);
}

/** 진행 상황 — 화면 진행바용. 하나만 돈다 */
export interface SuperJob {
  status: "idle" | "running" | "done" | "error";
  /** 지금 무엇을 하고 있나 */
  step: string;
  done: number;
  total: number;
  /** 이번 실행에서 새로 담은 수 */
  added: number;
  /**
   * **약한 장세라 안 담은 수** (설정이 `skip` 일 때만 는다).
   * 이게 없으면 「왜 오늘 하나도 안 늘었나」에 답할 수가 없다 — 아무것도 안 걸린
   * 날과 걸렸는데 일부러 안 담은 날이 화면에서 똑같아 보인다.
   */
  skippedWeak?: number;
  /** 그날 장세 한 줄 — 위 숫자의 이유 */
  regimeWhy?: string | null;
  error?: string;
  at: string;
}

let job: SuperJob = { status: "idle", step: "", done: 0, total: 0, added: 0, at: "" };

export function superJob(): SuperJob {
  return job;
}

/**
 * 교집합을 뽑아 담는다. 하루 한 번이 원칙이지만 `force` 로 다시 돌 수 있다
 * (그날 이미 담은 종목은 중복으로 안 담기므로 다시 돌아도 해가 없다).
 */
export async function runSuperSignal(client: KiwoomClient, force = false): Promise<Store> {
  const store = await load();
  /* 이번 회차가 쓸 설정 — 도는 도중에 바뀌어도 한 회차는 같은 값으로 끝나게 한다 */
  const runCfg = cfgOf(store);
  /*
   * 이번 회차의 **신호등 기준 지문** — 한 회차 안에서는 같은 값을 쓴다.
   * 편입마다 다시 계산하면 도는 중에 설정이 바뀌었을 때 같은 회차가 두 지문으로 갈린다.
   */
  const cfgHash = await configFingerprint().catch(() => undefined);
  /*
   * **오늘 장세** — 한 회차에 한 번만 잰다(조회 0회, 일봉 캐시).
   * `skip` 이면 이 회차는 아예 안 담는다. 기본은 `mark` — 담되 표시한다.
   */
  const regime = await regimeTrust().catch(() => ({
    weak: false,
    breadth: null,
    newHigh: null,
    why: null,
  }));
  /** 약한 장세라 안 담은 수 — 화면이 「왜 오늘 하나도 안 늘었나」에 답하려면 있어야 한다 */
  let skippedWeak = 0;
  const today = todayStr();
  if (!force && store.lastRunDate === today) return store;
  if (job.status === "running") return store;

  job = { status: "running", step: "목록 받는 중", done: 0, total: SCREEN_UNIVERSES.length, added: 0, at: new Date().toISOString() };

  try {
    /*
     * 일곱 목록을 **차례로** 받는다. 병렬로 쏘면 초당 5회 제한에 걸린다.
     * 각 목록 안의 연속조회 간격은 fetchUniverse 가 이미 지킨다.
     */
    const byCode = new Map<string, { c: Candidate; lists: string[] }>();
    for (const u of SCREEN_UNIVERSES) {
      job.step = `${u.label} 받는 중`;
      const rows = await fetchUniverse(client, u.key, "000", runCfg.universeSize).catch(
        () => [] as Candidate[],
      );
      for (const c of rows) {
        const hit = byCode.get(c.code);
        if (hit) {
          hit.lists.push(u.key);
          // 가격은 값이 있는 쪽을 남긴다 (몇 목록은 현재가를 안 준다)
          if (hit.c.price === 0 && c.price > 0) hit.c = c;
        } else {
          byCode.set(c.code, { c, lists: [u.key] });
        }
      }
      job.done += 1;
      await new Promise((r) => setTimeout(r, 400));
    }

    /*
     * 교집합에서 오늘 평가할 것들.
     *
     * ⚠️ **이미 추적 중인 종목을 먼저 넣는다** (2026-08-31 점검에서 드러남).
     *
     * 예전엔 걸린 목록 수로만 세워 앞 40개를 잘랐다. 그러면 목록 4곳에 걸린
     * **신규**가 3곳에 걸린 **기존 추적분**을 밀어낸다 — 그날 그 종목은
     * `lastSeenDate` 가 안 갱신되고 `seenCount` 도 안 는다. 실제로는 오늘도
     * 교집합에 걸렸는데 「안 걸린 날」로 기록되는 것이다.
     *
     * 원장을 정확히 유지하는 것이 새 종목 하나를 더 보는 것보다 중요하다 —
     * 성적표가 그 기록 위에 세워지기 때문이다.
     */
    const tracked = new Set(store.entries.filter((e) => e.active !== false).map((e) => e.code));
    const qualified = [...byCode.values()].filter((x) => x.lists.length >= runCfg.minLists);
    const inter = [
      ...qualified.filter((x) => tracked.has(x.c.code)),
      ...qualified.filter((x) => !tracked.has(x.c.code)),
    ]
      .sort((a, b) => {
        /* 추적 중인 것이 먼저, 그 안에서 걸린 목록이 많은 순 */
        const at = tracked.has(a.c.code) ? 1 : 0;
        const bt = tracked.has(b.c.code) ? 1 : 0;
        if (at !== bt) return bt - at;
        return b.lists.length - a.lists.length;
      })
      .slice(0, runCfg.maxEval);

    job.step = "신호등 평가 중";
    job.total = inter.length;
    job.done = 0;

    const have = new Map(store.entries.map((e) => [e.code, e]));
    let added = 0;
    /* 텔레그램에 보낼 것들 — 신규 편입과, 이탈했다 다시 걸린 부활 */
    const addedEntries: SuperEntry[] = [];
    const revivedEntries: SuperEntry[] = [];
    for (const x of inter) {
      try {
        const sig = await evaluateSignal(client, x.c.code);
        if (sig.level === "green") {
          const prev = have.get(x.c.code);
          if (prev) {
            // 이미 추적 중 — 오늘 또 걸렸다는 사실이 정보다
            if (prev.lastSeenDate !== today) prev.seenCount += 1;
            prev.lastSeenDate = today;
            prev.lists = x.lists;
            /*
             * 이탈했던 종목이 다시 걸렸다 — 되살린다. 이탈 이력은 그대로 남는다.
             * 관심종목 그룹에는 바로 아래 `ensureInGroup` 이 다시 담는다 —
             * 이탈할 때 뺐으므로(2026-08-31) 이 길이 없으면 되살아나도 목록에 안 뜬다.
             */
            if (prev.active === false) revivedEntries.push(prev);
            prev.active = true;
            // 그룹에서 빠져 있으면 다시 담는다(기능 추가 전 편입분도 이 길로 들어온다)
            await ensureInGroup(
              { code: prev.code, name: prev.name, addedPrice: prev.addedPrice },
              SUPER_GROUP,
            ).catch(() => undefined);
          } else if (regime.weak && runCfg.weakRegimeMode === "skip") {
            /*
             * **오늘은 안 담는다** (설정이 `skip` 일 때만).
             *
             * ⚠️ 기존 추적분의 `seenCount`·`lastSeenDate` 는 위에서 이미 갱신됐다 —
             * 여기서 막는 것은 **새 편입뿐**이다. 이미 담은 것을 안 세면 원장이
             * 끊겨 지속성 판정이 통째로 어긋난다.
             */
            skippedWeak += 1;
          } else {
            const entry: SuperEntry = {
              code: x.c.code,
              name: x.c.name,
              addedDate: today,
              addedPrice: x.c.price,
              score: sig.score,
              /* 어떤 기준으로 걸린 편입인가 — 나중에 기준이 바뀌면 이걸로 갈린다 */
              configHash: cfgHash,
              /* 어떤 장세에서 걸린 편입인가 — 성적표가 이걸로 갈라 채점한다 */
              regime: {
                breadth: regime.breadth,
                newHigh: regime.newHigh,
                weak: regime.weak,
                why: regime.why,
              },
              lists: x.lists,
              seenCount: 1,
              lastSeenDate: today,
            };
            store.entries.push(entry);
            have.set(entry.code, entry);
            added += 1;
            addedEntries.push(entry);
            /*
             * 관심종목 「슈퍼신호등」 그룹에도 담는다 (사용자 요청) — 관심종목이
             * 실시간·손절감시·뉴스 검색의 축이라, 거기 있어야 나머지가 따라붙는다.
             * 이미 다른 그룹에 담긴 종목이면 그룹만 더한다(편입가·메모는 그대로).
             */
            await ensureInGroup(
              {
                code: entry.code,
                name: entry.name,
                addedPrice: entry.addedPrice,
                memo: `슈퍼신호등 자동 편입 (${today} · 목록 ${entry.lists.length}곳 · ${entry.score}점)`,
              },
              SUPER_GROUP,
            ).catch(() => undefined);
          }
        }
      } catch {
        /* 한 종목 실패가 전체를 막지 않게 */
      }
      job.done += 1;
      job.added = added;
      await new Promise((r) => setTimeout(r, 260));
    }

    // 오래된 것부터 정리 — 관찰 목록이지 박물관이 아니다
    store.entries.sort((a, b) => b.addedDate.localeCompare(a.addedDate));
    store.entries = store.entries.slice(0, 200);

    // 편입 후 성적 채점 — 어제까지 담은 종목들의 1/5/20일 수익률을 갱신
    job.step = "성과 채점 중";
    await gradeEntries(client, store).catch(() => undefined);

    // 오늘의 종가·점수를 원장에 한 줄 — 대시보드의 흐름 그래프가 이걸 먹는다
    job.step = "일별 기록 중";
    const exitedEntries = await recordSuperDaily(client, store).catch(() => [] as SuperEntry[]);

    // 편입·부활·이탈을 전용 방으로 (없으면 시그널 방)
    activeCache = null; // 오늘 결과가 라우팅에 바로 반영되게
    await notifySuperRun(
      addedEntries,
      revivedEntries,
      exitedEntries,
      store.entries.filter((e) => e.active !== false).length,
    ).catch(() => undefined);

    store.lastRunDate = today;
    await save(store);
    job = {
      ...job,
      status: "done",
      step: "완료",
      skippedWeak,
      regimeWhy: regime.weak ? regime.why : null,
    };
  } catch (err) {
    job = { ...job, status: "error", error: err instanceof Error ? err.message : "실패" };
  }
  return store;
}

/** 그룹 하나의 지평별 평균 — avg 는 표본 0이면 null */
export interface GradeRow {
  label: string;
  /**
   * 어느 묶음의 줄인가 (2026-08-31) — 화면이 구획을 나눠 그린다.
   *
   * 열넉 줄을 평평하게 늘어놓으면 **무엇과 무엇을 견주는 표인지가 안 보인다.**
   * 이 표는 「축마다 짝으로 낸」 표라, 그 짝이 눈에 보여야 읽힌다.
   */
  group: "base" | "lists" | "streak" | "score" | "universe" | "regime";
  d1: { avg: number | null; n: number };
  d5: { avg: number | null; n: number };
  d20: { avg: number | null; n: number };
  /**
   * **지수 대비 초과수익** 평균(%p) — 이 줄이 없으면 위의 세 값은 뜻이 없다.
   * 「d1 -0.13%」가 나쁜 건지 좋은 건지는 그날 시장을 알아야 답할 수 있다.
   */
  ex1: { avg: number | null; n: number };
  ex5: { avg: number | null; n: number };
  ex20: { avg: number | null; n: number };
  /**
   * 승률(%) — 평균과 **같이 봐야** 뜻이 산다. 평균 +2% 가 「열 번 중 두 번 크게
   * 먹고 여덟 번 조금 잃었다」인지 「고르게 조금씩 벌었다」인지는 평균만으로
   * 갈리지 않는다. 추세추종은 앞쪽이 정상인데, 그걸 모르면 승률 30% 를 보고
   * 잘못된 결론을 내린다.
   */
  win1: { rate: number | null; n: number };
  win20: { rate: number | null; n: number };
}

function gradeRow(
  label: string,
  entries: SuperEntry[],
  group: GradeRow["group"] = "base",
): GradeRow {
  const agg = (pick: (r: NonNullable<SuperEntry["returns"]>) => number | null) => {
    const vals = entries
      .map((e) => (e.returns ? pick(e.returns) : null))
      .filter((v): v is number => v !== null);
    return {
      avg: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null,
      n: vals.length,
    };
  };
  /* 지수 대비는 다른 필드(excess)에 있다 — 같은 방식으로 평균 낸다 */
  const aggEx = (pick: (r: NonNullable<SuperEntry["excess"]>) => number | null) => {
    const vals = entries
      .map((e) => (e.excess ? pick(e.excess) : null))
      .filter((v): v is number => v !== null && Number.isFinite(v));
    return {
      avg: vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null,
      n: vals.length,
    };
  };
  const rate = (pick: (r: NonNullable<SuperEntry["returns"]>) => number | null) => {
    const vals = entries
      .map((e) => (e.returns ? pick(e.returns) : null))
      .filter((v): v is number => v !== null && Number.isFinite(v));
    return {
      rate: vals.length > 0 ? (vals.filter((v) => v > 0).length / vals.length) * 100 : null,
      n: vals.length,
    };
  };
  return {
    label,
    group,
    d1: agg((r) => r.d1),
    d5: agg((r) => r.d5),
    d20: agg((r) => r.d20),
    ex1: aggEx((r) => r.d1),
    ex5: aggEx((r) => r.d5),
    ex20: aggEx((r) => r.d20),
    win1: rate((r) => r.d1),
    win20: rate((r) => r.d20),
  };
}

/** 지평 하나의 승률 — 「편입하고 N일 뒤 플러스였나」 */
function winRate(entries: SuperEntry[], pick: (r: NonNullable<SuperEntry["returns"]>) => number | null) {
  const vals = entries
    .map((e) => (e.returns ? pick(e.returns) : null))
    .filter((v): v is number => v !== null);
  return {
    rate: vals.length ? (vals.filter((v) => v > 0).length / vals.length) * 100 : null,
    n: vals.length,
  };
}

/** 대시보드 요약 통계 — 체계 자체를 검증하는 숫자들 */
export interface SuperStats {
  activeCount: number;
  exitedCount: number;
  todayAdded: number;
  win: {
    d1: { rate: number | null; n: number };
    d5: { rate: number | null; n: number };
    d20: { rate: number | null; n: number };
  };
  best: { name: string; v: number } | null;
  worst: { name: string; v: number } | null;
}

/** 화면 한 줄 — 원장 항목 + 지금 값 + 소속 그룹 표 */
export type SuperListRow = SuperEntry & {
  price: number | null;
  changeRate: number | null;
  sinceAdded: number | null;
  /**
   * **편입일로부터 며칠 지났나** (2026-08-31).
   *
   * `seenCount`(걸린 날 수)와 **다른 질문의 답**이다. 8/28 에 편입돼서 그 뒤로
   * 다시 안 걸렸으면 seenCount 는 1 인데 오늘이 8/31 이면 여기는 3 이다.
   * 화면이 seenCount 를 「N일째」로 적어 편입일과 어긋나 보인다는 지적에서 나왔다.
   *
   * **편입 당일은 0** 이다 — 그날이 「신규」이고, 화면이 N 배지를 그 값으로 판단한다.
   * 서버가 한 번 재서 두 화면(신호등 찾기·슈퍼신호등 대시보드)이 같은 값을 쓴다.
   */
  daysSince: number;
  /** 오늘 편입된 것인가 — 화면의 N 배지 */
  isNew: boolean;
  /**
   * **무지개** — 초록 위의 등급. 사흘 이상 계속 교집합에 걸린 활성 종목.
   * 지속성이 성적을 가른 유일한 축이라 거기에 등급을 둔다(RAINBOW_DAYS 주석 참고).
   */
  rainbow: boolean;
  /**
   * 지금 이 종목의 무리가 도는가 (2026-08-28, 테마 DB 개편).
   * 든 네이버 테마 중 오늘 가장 강한 것 — 편입 점수의 「테마 강세(네이버)」와
   * 같은 분류다. 걸린 종목의 테마가 식으면 이탈이 가까운 신호다. 조회 0회(파일+스냅샷).
   */
  theme: { key: string; name: string; changeRate: number; streak: number } | null;
  /** ETF 뒷배 — 테마로 담은 상위 3 ETF 의 오늘 평균 (신호등 뒷배와 같은 규칙). 조회 0회 */
  etfBack: { rate: number; top: string } | null;
  /**
   * 어느 그룹에서 온 종목인가 (2026-08-27) — "super"=슈퍼신호등 원장,
   * "cross"=관심 그룹 「슈퍼신호등+교차」. 둘 다일 수도 있다. 화면이 심볼(🌟/⚡)로 단다.
   */
  groupTags: ("super" | "cross")[];
};

/** 화면용 — 지금 가격을 스냅샷에서 붙여 편입가 대비를 낸다 */
export async function listSuperSignal(client: KiwoomClient): Promise<{
  entries: SuperListRow[];
  lastRunDate: string | null;
  minLists: number;
  /** 지금 쓰이는 설정 — 화면이 조절 칸의 현재값으로 쓴다 */
  config: SuperConfig;
  grade: GradeRow[];
  /** 전체와 완전히 같아서 뺀 줄 수 (편입 규칙이 이미 요구하는 조건들) */
  gradeHidden: number;
  stats: SuperStats;
  /**
   * 기준 지문 — **원장에 서로 다른 기준의 편입이 섞여 있나.**
   * 섞였으면 성적표의 평균이 뜻을 잃는다. 지우는 대신 화면이 그 사실을 적는다.
   */
  fingerprint: { now?: string; mixed: boolean; sameAsNow: number; kinds: number };
}> {
  const store = await load();
  const snap = await getMarketSnapshot(client).catch(() => null);

  /*
   * 편입일로부터 며칠 — **달력일** 기준. 거래일로 세려면 공휴일 표가 필요한데
   * 그게 없다(없는 데이터를 지어내지 않는다). 편입 당일은 0 이다.
   */
  const cfg = cfgOf(store);
  const nowDay = todayStr();
  const daysFrom = (d: string): number => {
    const a = Date.parse(`${d}T00:00:00Z`);
    const b = Date.parse(`${nowDay}T00:00:00Z`);
    return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, Math.round((b - a) / 86400_000)) : 0;
  };

  /* 교차 그룹 — 대시보드에 같이 보여 달라는 요청 (2026-08-27). 원장에는 안 섞는다 —
     점수·이탈 체계는 슈퍼(초록 교집합)의 것이고, 교차는 관찰 대상일 뿐이다.
     통계(grade/stats)도 그래서 원장만 센다. */
  const crossCodes = new Set<string>();
  const crossOnly: SuperListRow[] = [];
  try {
    const items = await listWatchlist();
    const superCodes = new Set(store.entries.map((e) => e.code));
    for (const w of items) {
      if (!w.groups.includes(CROSS_GROUP)) continue;
      crossCodes.add(w.code);
      if (superCodes.has(w.code)) continue;
      const s = snap?.byCode.get(w.code);
      const price = s?.price ?? null;
      crossOnly.push({
        code: w.code,
        name: w.name,
        addedDate: w.addedAt.slice(0, 10),
        addedPrice: w.addedPrice,
        daysSince: daysFrom(w.addedAt.slice(0, 10)),
        /* 교차 전용 줄은 슈퍼 원장이 없다 — 지속성을 잴 근거가 없으므로 무지개도 없다 */
        rainbow: false,
        isNew: w.addedAt.slice(0, 10) === nowDay,
        score: 0,
        lists: [],
        seenCount: 0,
        lastSeenDate: w.addedAt.slice(0, 10),
        active: true,
        daily: [],
        exits: [],
        notes: [],
        price,
        changeRate: s?.changeRate ?? null,
        sinceAdded:
          price !== null && w.addedPrice > 0 ? ((price - w.addedPrice) / w.addedPrice) * 100 : null,
        groupTags: ["cross"],
        theme: null,
        etfBack: null,
      });
    }
  } catch {
    /* 관심종목을 못 읽어도 슈퍼 원장은 그대로 보여준다 */
  }
  /*
   * 테마·ETF 뒷배를 한 번에 준비한다 (2026-08-28) — 종목마다 부르면 테마 강도가
   * 그만큼 반복 계산된다. 강도는 한 번(수십 ms), 나머지는 파일 조회다.
   */
  const themeMap = await themeMapNow();
  const lensOf = (code: string) => stockLens(code, themeMap);

  const entries: SuperListRow[] = await Promise.all(
    store.entries.map(async (e) => {
      const s = snap?.byCode.get(e.code);
      const price = s?.price ?? null;
      return {
        ...e,
        price,
        changeRate: s?.changeRate ?? null,
        sinceAdded:
          price !== null && e.addedPrice > 0 ? ((price - e.addedPrice) / e.addedPrice) * 100 : null,
        daysSince: daysFrom(e.addedDate),
        /* 이탈한 것은 무지개가 아니다 — 지금 살아 있는 지속성이라야 뜻이 있다 */
        rainbow: e.active !== false && e.seenCount >= cfg.rainbowDays,
        /* 오늘 편입된 것 — 화면이 N 배지를 붙인다. 첫날만이다 */
        isNew: e.addedDate === nowDay,
        groupTags: crossCodes.has(e.code)
          ? (["super", "cross"] as ("super" | "cross")[])
          : (["super"] as ("super" | "cross")[]),
        ...(await lensOf(e.code)),
      };
    }),
  );
  for (const c of crossOnly) Object.assign(c, await lensOf(c.code));
  entries.push(...crossOnly);
  /*
   * 채점 요약 — 「교집합이 넓을수록·오래 걸릴수록 진짜인가」에 답하는 표.
   * 표본이 몇 건 안 될 때는 화면이 n 을 함께 보여 주므로 여기서 숨기지 않는다.
   */
  /*
   * **가설을 하나씩 가른다** (2026-08-31 확장).
   *
   * 이 표는 「슈퍼신호등이 맞는가」가 아니라 **「무엇이 맞는가」**에 답해야 한다.
   * 전체 평균 하나로는 고칠 데를 알 수 없다 — 어느 축이 성적을 가르는지가
   * 보여야 그 축만 손볼 수 있다.
   *
   * 축마다 **짝으로** 낸다(3곳 vs 4곳 이상, 하루 vs 이틀 이상). 한쪽만 내면
   * 「4곳 이상이 +2%」가 좋은 건지 알 수 없다 — 3곳이 +3% 일 수도 있다.
   *
   * ⚠️ 표본이 적으면 화면이 흐리게 그린다. 여기서 숨기지는 않는다 —
   * 「표본이 적다」도 알아야 할 사실이고, 숨기면 그 사실이 사라진다.
   */
  const E = store.entries;
  const grade = [
    gradeRow("전체", E, "base"),
    /* ① 교집합 넓이 — 많이 걸릴수록 진짜인가 */
    gradeRow("목록 3곳", E.filter((e) => e.lists.length === 3), "lists"),
    gradeRow("목록 4곳", E.filter((e) => e.lists.length === 4), "lists"),
    gradeRow("목록 5곳 이상", E.filter((e) => e.lists.length >= 5), "lists"),
    /* ② 지속성 — 며칠째 걸리나. 지금까지 가장 크게 갈린 축이다 */
    gradeRow("하루만 걸림", E.filter((e) => e.seenCount <= 1), "streak"),
    gradeRow("이틀 이상 반복", E.filter((e) => e.seenCount >= 2), "streak"),
    /* 무지개 문턱은 설정값이다 — 라벨도 그 값을 따라간다(3 이 아닐 수 있다) */
    gradeRow(`${cfg.rainbowDays}일 이상 반복 🌈`, E.filter((e) => e.seenCount >= cfg.rainbowDays), "streak"),
    /* ③ 편입 점수 — 신호등 점수가 높을수록 나은가 */
    gradeRow("편입 점수 70+", E.filter((e) => e.score >= 70), "score"),
    gradeRow("편입 점수 70 미만", E.filter((e) => e.score < 70), "score"),
    /*
     * ④ **어떤 장세에서 걸렸나** (2026-08-31).
     *
     * 조건부 성적표 실측이 「폭 좁은 날의 초록은 시장에 진다」고 말했다(-2.15%p,
     * 승률 43%). 그 말이 **이 원장에서도 맞는지**를 여기서 스스로 채점한다.
     *
     * 기본 설정은 약한 장세에도 **담되 표시**한다(`mark`). 안 담아 버리면 이 두 줄이
     * 영영 안 갈려 문턱이 맞았는지 확인할 길이 없기 때문이다. 몇 달 뒤 「약한 장세」
     * 줄이 뚜렷하게 나쁘면 그때 `skip` 으로 옮기면 된다 — 근거를 갖고.
     *
     * ⚠️ 장세를 재기 전(2026-08-31 이전) 편입분에는 `regime` 이 없다. 그것들은
     * 어느 줄에도 안 들어간다 — 「몰랐다」를 「좋았다」나 「나빴다」로 만들지 않는다.
     */
    gradeRow("정상 장세 편입", E.filter((e) => e.regime && !e.regime.weak), "regime"),
    gradeRow("약한 장세 편입", E.filter((e) => e.regime?.weak === true), "regime"),
    /* ⑤ 어느 목록에서 왔나 — 목록마다 값어치가 다를 수 있다 */
    ...SCREEN_UNIVERSES.map((u) =>
      gradeRow(`${u.label}에 걸림`, E.filter((e) => e.lists.includes(u.key)), "universe"),
    ),
  ].filter((g) => g.d1.n > 0 || g.d5.n > 0 || g.d20.n > 0);

  /*
   * **전체와 완전히 같은 줄은 뺀다** (2026-08-31 — "의미 없으면 지우던지 하자").
   *
   * 「편입 점수 70+」·「거래대금 상위에 걸림」 같은 줄은 **편입 규칙이 이미 그
   * 조건을 요구**하므로 편입분 전부가 만족한다. 그래서 표본 수도 값도 전체와
   * 똑같다 — 아무것도 안 가르는데 자리만 먹고, 표를 훑는 눈을 흐린다.
   *
   * ⚠️ **몇 줄을 뺐는지는 알린다.** 조용히 사라지면 「이 축은 아예 안 재나?」로
   * 읽힌다. 그리고 문턱을 낮추면 갈리기 시작하는 줄이라, 그때는 저절로 다시 나온다.
   */
  const baseRow = grade.find((g) => g.group === "base");
  const sameAsBase = (g: GradeRow): boolean =>
    g.group !== "base" &&
    baseRow !== undefined &&
    g.d1.n === baseRow.d1.n &&
    g.d1.avg === baseRow.d1.avg;
  const gradeHidden = grade.filter(sameAsBase).length;
  const gradeShown = grade.filter((g) => !sameAsBase(g));

  const today = todayStr();
  const d20s = store.entries
    .map((e) => ({ name: e.name, v: e.returns?.d20 ?? null }))
    .filter((x): x is { name: string; v: number } => x.v !== null);
  const stats: SuperStats = {
    activeCount: store.entries.filter((e) => e.active !== false).length,
    exitedCount: store.entries.filter((e) => e.active === false).length,
    todayAdded: store.entries.filter((e) => e.addedDate === today).length,
    win: {
      d1: winRate(store.entries, (r) => r.d1),
      d5: winRate(store.entries, (r) => r.d5),
      d20: winRate(store.entries, (r) => r.d20),
    },
    best: d20s.length ? d20s.reduce((a, b) => (b.v > a.v ? b : a)) : null,
    worst: d20s.length ? d20s.reduce((a, b) => (b.v < a.v ? b : a)) : null,
  };
  /*
   * **기준이 섞였나** (2026-08-31). 신호등 기준을 바꾸면 그 전 편입과 그 뒤 편입이
   * 한 표에 들어가면서 평균이 뜻을 잃는다. 지우는 대신 **섞였다는 사실을 알린다** —
   * 옛 기록은 「옛 기준이 어땠나」의 유일한 증거라 지우면 비교할 대상이 사라진다.
   *
   * 옛 편입분에는 지문이 아예 없다(기능 추가 전). 그것도 「다른 기준」으로 센다.
   */
  const nowHash = await configFingerprint().catch(() => undefined);
  const hashes = new Set(store.entries.map((e) => e.configHash ?? "(지문 없음)"));
  const mixed =
    hashes.size > 1 || (nowHash !== undefined && !hashes.has(nowHash) && store.entries.length > 0);
  const sameAsNow = nowHash ? store.entries.filter((e) => e.configHash === nowHash).length : 0;

  return {
    entries,
    lastRunDate: store.lastRunDate,
    minLists: cfg.minLists,
    config: cfg,
    grade: gradeShown,
    /** 전체와 값이 똑같아 뺀 줄 수 — 조용히 사라지면 「안 재나?」로 읽힌다 */
    gradeHidden,
    stats,
    /** 지금 기준의 지문 · 원장에 섞여 있나 · 지금 기준으로 담긴 건 몇 건인가 */
    fingerprint: { now: nowHash, mixed, sameAsNow, kinds: hashes.size },
  };
}

/** 수동 이탈 — 기록을 남기고 추적만 멈춘다. 목록에서 지우지 않는다 */
export async function exitSuperEntry(
  client: KiwoomClient,
  code: string,
  note: string,
): Promise<SuperEntry | null> {
  const store = await load();
  const e = store.entries.find((x) => x.code === code);
  if (!e) return null;
  const snap = await getMarketSnapshot(client).catch(() => null);
  const market = await evaluateMarket(client)
    .then((m) => ({ level: m.level, score: m.score }))
    .catch(() => null);
  const sig = await evaluateSignal(client, code).catch(() => null);
  e.active = false;
  (e.exits ??= []).push({
    date: todayStr(),
    price: snap?.byCode.get(code)?.price ?? null,
    score: sig?.score ?? null,
    marketLevel: market?.level ?? null,
    marketScore: market?.score ?? null,
    note: note.trim() || "수동 이탈",
    auto: false,
  });
  await save(store);
  activeCache = null;
  /* 자동 이탈과 같다 — 관심종목 그룹에서도 뺀다(그룹만, 종목은 남긴다) */
  await removeFromGroup(code, SUPER_GROUP).catch(() => undefined);
  await notifySuperRun([], [], [e]).catch(() => undefined);
  return e;
}

/**
 * 메모 추가 — **덮어쓰지 않고 쌓는다** (2026-08-27).
 * 같은 날 다시 적으면 그날 것을 고친 것으로 보고 마지막 줄만 바꾼다.
 * `note` 필드는 마지막 메모의 사본 — 표의 📝 표시가 본다.
 */
export async function updateSuperNote(code: string, note: string): Promise<boolean> {
  const store = await load();
  const e = store.entries.find((x) => x.code === code);
  if (!e) return false;
  const text = note.trim();
  if (text) {
    const notes = (e.notes ??= []);
    const last = notes[notes.length - 1];
    const today = todayStr();
    if (last?.date === today) last.text = text;
    else notes.push({ date: today, text });
  }
  e.note = text;
  await save(store);
  return true;
}

// ---------------------------------------------------------------- 상세 (온디맨드)

interface DailyPoint {
  date: string;
  close: number;
}

const CHART_RESOURCE = "/api/dostk/chart";

function toNum2(v: unknown): number {
  const n = Number(String(v ?? "").replace(/[+,]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/** 종목 일봉 — 옛날→최신 순 {date, close} */
async function stockDailySeries(client: KiwoomClient, code: string): Promise<DailyPoint[]> {
  const base = todayStr().replace(/-/g, "");
  const res = await client.request<Record<string, unknown>>(CHART_RESOURCE, "ka10081", {
    stk_cd: code,
    base_dt: base,
    upd_stkpc_tp: "1",
  });
  return (dropPhantomToday((res.data?.stk_dt_pole_chart_qry ?? []) as Record<string, unknown>[]))
    .map((r) => ({ date: String(r.dt ?? ""), close: Math.abs(toNum2(r.cur_prc)) }))
    .filter((r) => /^\d{8}$/.test(r.date) && r.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** 업종/지수 일봉(ka20006) — 옛날→최신 순. 값이 지수×100 이지만 비율만 쓰므로 그대로 */
async function indexDailySeries(client: KiwoomClient, indsCode: string): Promise<DailyPoint[]> {
  const base = todayStr().replace(/-/g, "");
  const res = await client.request<Record<string, unknown>>(CHART_RESOURCE, "ka20006", {
    inds_cd: indsCode,
    base_dt: base,
  });
  return (dropPhantomToday((res.data?.inds_dt_pole_qry ?? []) as Record<string, unknown>[]))
    .map((r) => ({ date: String(r.dt ?? ""), close: Math.abs(toNum2(r.cur_prc)) }))
    .filter((r) => /^\d{8}$/.test(r.date) && r.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** 일별 외인/기관 순매수 (ka10060) — 옛날→최신 순. 값은 백만원 (복기 노트도 쓴다) */
export async function investorDailySeries(
  client: KiwoomClient,
  code: string,
): Promise<{ date: string; foreign: number; inst: number }[]> {
  const base = todayStr().replace(/-/g, "");
  const res = await client.request<Record<string, unknown>>(CHART_RESOURCE, "ka10060", {
    stk_cd: code,
    dt: base,
    amt_qty_tp: "1", // 금액
    trde_tp: "0",
    unit_tp: "1000",
  });
  return ((res.data?.stk_invsr_orgn_chart ?? []) as Record<string, unknown>[])
    .map((r) => ({
      date: String(r.dt ?? ""),
      foreign: toNum2(r.frgnr_invsr),
      inst: toNum2(r.orgn),
    }))
    .filter((r) => /^\d{8}$/.test(r.date))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 종목 하나의 대시보드 상세 — 클릭했을 때만 부른다 (조회 4콜 안팎).
 *
 * 편입일 20거래일 전부터의 주가·지수·업종 시리즈와 일별 수급을 준다.
 * 상대 비교(편입일=0% 정규화)는 화면이 한다 — 서버는 원자료만.
 */
export async function superDetail(client: KiwoomClient, code: string) {
  const store = await load();
  const entry = store.entries.find((e) => e.code === code);
  if (!entry) return null;

  const [stock, flows, mood, sig, market] = await Promise.all([
    stockDailySeries(client, code).catch(() => [] as DailyPoint[]),
    investorDailySeries(client, code).catch(() => [] as { date: string; foreign: number; inst: number }[]),
    getSectorMood(client, code).catch(() => null),
    evaluateSignal(client, code).catch(() => null),
    evaluateMarket(client).catch(() => null),
  ]);
  /* 지금 시세 — 「오늘 어떤지」 (2026-08-27). peek(캐시만) — 만료 순간에 걸리면
     getMarketSnapshot 이 65업종 리빌드(15초)를 기다리게 해서 시트가 멈춘 것처럼 보인다 */
  const nowRow = peekSnapshot()?.byCode.get(code);
  const now = nowRow ? { price: nowRow.price ?? null, changeRate: nowRow.changeRate ?? null } : null;

  /*
   * 지수 — 업종 매칭이 알려 준 시장, 못 찾으면 코스피.
   *
   * ⚠️ **업종 시리즈는 더 안 받는다** (2026-08-27). 비교선이 업종이면
   * 「업종은 올랐는데 이 종목은」이라는 뜻 없는 문장이 된다 — 「화학」 한 칸에
   * 화장품·이차전지·정유가 같이 들어 있어서다. 그 자리는 **테마 지수**가 대신하고,
   * 그건 화면이 따로 받는다(`/api/super/theme/:code`) — 구성종목 일봉으로 만드는
   * 값이라 여기 실으면 종목 창이 늦게 열린다.
   */
  const marketIdx = mood?.sector?.marketKey === "kosdaq" ? "101" : "001";
  const indexSeries = await indexDailySeries(client, marketIdx).catch(() => [] as DailyPoint[]);

  /* 편입일 20거래일 전부터만 — 그 앞은 이 화면의 물음이 아니다 */
  const addedYmd = entry.addedDate.replace(/-/g, "");
  const cut = (rows: DailyPoint[]): DailyPoint[] => {
    const i = rows.findIndex((r) => r.date >= addedYmd);
    return i < 0 ? rows.slice(-1) : rows.slice(Math.max(0, i - 20));
  };

  return {
    entry,
    now,
    stock: cut(stock),
    index: { code: marketIdx, name: marketIdx === "101" ? "코스닥" : "코스피", series: cut(indexSeries) },
    /* 업종은 뺐다 — 그 자리는 테마 지수다(`/api/super/theme/:code`, 화면이 따로 받는다) */
    flows: (() => {
      const i = flows.findIndex((r) => r.date >= addedYmd);
      return i < 0 ? [] : flows.slice(Math.max(0, i - 20));
    })(),
    signalNow: sig ? { level: sig.level, score: sig.score } : null,
    marketNow: market ? { level: market.level, score: market.score, summary: market.summary } : null,
  };
}

export async function removeSuperEntry(code: string): Promise<void> {
  const store = await load();
  store.entries = store.entries.filter((e) => e.code !== code);
  await save(store);

  /*
   * 관심종목 쪽도 정리한다 — 슈퍼신호등 그룹에만 있던 종목이면 통째로 빼고,
   * 다른 그룹에도 담겨 있으면 슈퍼신호등 그룹만 뗀다(사람이 담은 건 사람 것이다).
   */
  try {
    const items = await listWatchlist();
    const w = items.find((i) => i.code === code);
    if (!w) return;
    if (w.groups.length === 1 && w.groups[0] === SUPER_GROUP) {
      await removeWatchItem(code);
    } else if (w.groups.includes(SUPER_GROUP)) {
      await updateWatchItem(code, { groups: w.groups.filter((g) => g !== SUPER_GROUP) });
    }
  } catch {
    /* 관심종목 정리는 부수 작업 — 실패해도 슈퍼 목록에서는 빠졌다 */
  }
}

/**
 * 평일 15:45 에 알아서 돈다 — 추적기(15:40)가 신호등 캐시를 데운 5분 뒤.
 * 그 시각을 지나 서버를 켠 날도 그날 안이면 한 번 돈다 (lastRunDate 가 막는다).
 */
export function startSuperSignalScheduler(client: KiwoomClient): void {
  const tick = async () => {
    const now = new Date();
    const k = new Date(now.getTime() + 9 * 3600_000);
    const day = k.getUTCDay();
    if (day === 0 || day === 6) return;
    const mins = k.getUTCHours() * 60 + k.getUTCMinutes();
    if (mins < 15 * 60 + 45 || mins > 23 * 60) return;
    await runSuperSignal(client).catch(() => undefined);
  };
  void tick();
  setInterval(() => void tick(), 60_000);
  console.log("[superSignal] 슈퍼신호등 시작 — 평일 15:45 교집합 편입");
}
