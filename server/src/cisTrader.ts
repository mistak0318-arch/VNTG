import type { KiwoomClient } from "./kiwoomClient.js";
import { evaluateMarket } from "./marketSignal.js";
import { evaluateSignal } from "./signalLight.js";
import { regimeTrust } from "./regimeWatch.js";
import { listTrackSummary } from "./listTrack.js";
import { leaderScan, type LeaderStock } from "./leaderScan.js";
import { getMarketSnapshot } from "./marketSnapshot.js";
import {
  addTradingDays,
  buy,
  buyingPower,
  equityOf,
  loadAccount,
  markToMarket,
  misuDue,
  saveAccount,
  sell,
  today,
  type CisAccount,
  type Funding,
  type Position,
} from "./cisAccount.js";

/**
 * CIS 트레이더 — **규칙으로 판단한다.**
 *
 * ## 왜 AI 가 아니라 규칙인가
 *
 * 벤티지가 물었다 — "AI 안 붙어도 가능할까?" 가능할 뿐 아니라 **그게 맞다.**
 *
 * 이 일지의 쓸모는 수익률이 아니라 **왜 그렇게 했는지가 남는 것**이다. LLM 이 매일
 * 판단하면 같은 날을 다시 돌려도 다른 답이 나온다. 성적이 나빠도 어느 판단이
 * 나빴는지 짚을 수가 없고, 그러면 복기가 「그날은 그렇게 느꼈나 보다」가 된다.
 *
 * 규칙이면 재현된다. 성적이 나쁘면 **어느 규칙이 나빴는지**를 숫자로 집어낼 수 있고,
 * 그 규칙만 고치면 된다. 그게 이 계좌를 굴리는 이유다.
 *
 * AI 는 나중에 붙어도 **문장을 쓰는 자리**다 — 판단은 여기서 끝나 있어야 한다.
 *
 * ## 역할 — 단기 추세 추종 스윙
 *
 * 오르고 있는 것을, 돈이 몰리는 곳에서, 신호등이 막지 않을 때 산다. 며칠 끌되
 * 추세가 꺾이면 그날 나온다. 바닥을 맞히려 하지 않는다 — 그건 다른 전략이고
 * 이 계좌의 규칙과 섞으면 둘 다 망가진다.
 *
 * ## 하루 세 번, 그리고 **진입은 세 갈래**
 *
 *   - **아침**(장 전): 시장을 보고 계획을 세운다. **시가배팅** 자리를 잡는다.
 *   - **점심**(장중): 보유를 점검하고, **장중배팅** 조건이 선 것만 잡는다.
 *   - **저녁**(마감 무렵): **종가배팅** 자리를 잡고, 오늘을 채점한다.
 *
 * 진입을 한 시각에 묶지 않는 이유 (2026-08-31 — "어떨때는 종가배팅도 하고 어떨때는
 * 시가배팅. 장중배팅"): 자리마다 성질이 다르다. 마감에 강하게 끝난 것은 다음 날
 * 갭을 노리는 자리고, 아침에 눌렸다 회복하는 것은 그날 안에 답이 나오는 자리다.
 * **한 시각으로 묶으면 그중 하나만 잡고 나머지는 영영 못 잡는다.**
 *
 * 다만 아무 때나 사는 것은 아니다. 각 모드에 **들어갈 조건**이 따로 있고,
 * 조건이 안 서면 그 시간대엔 아무것도 안 산다. 그게 「능동적」과 「충동적」의 차이다.
 *
 * ⚠️ **시가배팅의 값은 그날 시가다.** 어제 종가를 보고 그 종가에 사는 것은 불가능한데,
 * 그렇게 적으면 성적이 통째로 거짓이 된다(`signalBacktest` 에서 같은 이유로
 * 익일 시가 진입으로 바꿨다).
 *
 * ## 매도는 버틴다
 *
 * 흔들린다고 팔지 않는다. **손절선·목표가·시간만료**에 닿을 때만 나간다.
 * 중간에 마음이 바뀌어 파는 자리를 만들면, 나중에 「그때 왜 팔았나」를 물을 수 없다.
 */

/* ------------------------------------------------------------------ 규칙 값 */

/**
 * 규칙의 숫자들을 **한자리에 모은다.** 코드 여기저기에 흩어지면 「왜 3% 인가」를
 * 물을 자리가 없어지고, 고칠 때 한 군데를 빠뜨린다.
 */
/**
 * 진입 모드 — 자리마다 성질이 다르다.
 *
 *   open   시가배팅 — 어제 신호가 살아 있고 시가가 안 튀었을 때. 아침.
 *   intra  장중배팅 — 눌렸다 회복하며 거래가 붙을 때. 점심.
 *   close  종가배팅 — 오늘 강하게 마감하고 판이 연속으로 강할 때. 저녁.
 */
export type EntryMode = "open" | "intra" | "close";

export const ENTRY_LABEL: Record<EntryMode, string> = {
  open: "시가배팅",
  intra: "장중배팅",
  close: "종가배팅",
};

export interface CisRules {
  /** 한 종목에 순자산의 몇 %까지 (분산) */
  maxPerStock: number;
  /** 동시에 몇 종목까지 */
  maxPositions: number;
  /** 손절 — 평단 대비 몇 % */
  stopPct: number;
  /** 익절 — 평단 대비 몇 % */
  targetPct: number;
  /** 며칠 지나도 안 움직이면 자리를 비운다 (기회비용) */
  maxHoldDays: number;
  /**
   * **신호등 분석 원장을 후보로 쓸까** (2026-08-31 — "CIS 도 이거 참고로 매매할 수
   * 있게 알고리즘 세팅해주고").
   *
   * 켜면 매일 16:30 에 쌓이는 목록별 추적 원장(추적 중인 초록)을 후보 풀에 더한다.
   * 두 가지가 좋아진다:
   *
   *   ① **신호등을 다시 안 부른다** — 이미 재서 초록으로 확정된 종목들이다.
   *      주도주 풀은 종목당 신호등 조회가 나가는데 이쪽은 0회다
   *   ② **주도주 스캔이 못 보는 자리**를 본다 — 외국인 연속순매매·동일순매매처럼
   *      「오늘 많이 오른 것」이 아닌 목록에서 온 종목들이다
   *
   * ⚠️ 원장은 **전날 16:30 기준**이다. 장중에 새로 뜬 것은 주도주 스캔이 잡는다 —
   * 그래서 둘을 **합쳐서** 쓴다(하나로 갈아타는 게 아니다).
   */
  useListTrack: boolean;
  /** 후보의 최소 신호등 점수 */
  minScore: number;
  /** 후보의 최소 거래대금 (억) */
  minTradeValue: number;
  /**
   * **후보의 최소 시가총액 (억)** — 기본 1,000 (2026-09-01).
   *
   * 벤티지: "CIS 말야. 얘도 시총 1000억 이상 거래대금 최소 100억 이상 되는
   * 종목에서만 거래하게 세팅해놔. 잡주는 안되!"
   *
   * ## 왜 거래대금만으로는 모자라나
   *
   * 거래대금 문턱은 **오늘 하루**를 본다. 시총 300억짜리가 테마에 걸려 하루
   * 800억이 돌면 그 문턱을 통과한다 — 그런데 그건 유동성이 아니라 **소나기**다.
   * 다음 날 30억으로 돌아가면 들고 있는 물량을 못 판다.
   *
   * 시총은 그 종목의 **바닥 크기**라 하루 이벤트로 안 변한다. 둘을 같이 걸어야
   * 「오늘도 돌고 평소에도 큰」 종목만 남는다.
   *
   * ⚠️ 이건 실측이 아니라 **벤티지가 정한 규칙**이다. 표본에서는 오히려
   * 1~3천억 소형주가 가장 좋았고 3천억~10조가 골짜기였다(시가총액 U자).
   * 다만 그 표본은 **못 사는 것까지 세고 있었다** — 실제로 넣을 수 있는 돈에는
   * 그 값이 안 나온다. 0 으로 두면 문턱이 없다.
   */
  minMarketCap: number;
  /** 시장이 이 아래면 **아무것도 안 산다** */
  minMarketScore: number;
  /**
   * **장세 신뢰도 문을 쓸까** — 「내 신호등이 오늘 골라낼 수 있나」.
   * 끄면 시장 점수만 본다(2026-08-31 이전 동작).
   */
  useRegimeGate: boolean;
  /** 이익이 이만큼 나면 손절선을 본전으로 올린다 */
  trailAfterPct: number;

  /* ── 진입 모드별 문 (2026-08-31) ───────────────────────────────── */
  /** 시가배팅을 쓸까 */
  useOpen: boolean;
  /** 장중배팅을 쓸까 */
  useIntra: boolean;
  /** 종가배팅을 쓸까 */
  useClose: boolean;
  /**
   * 시가가 이만큼 넘게 갭상승했으면 **안 산다**. 갭에 다 주고 들어가면
   * 손절선까지의 거리가 사라진다 — 사자마자 손절 사거리에 들어간다.
   */
  maxOpenGap: number;
  /** 장중배팅 — 시가 대비 이만큼은 올라와 있어야(회복 확인) */
  intraMinFromOpen: number;
  /** 종가배팅 — 오늘 등락률이 이만큼은 되어야(강하게 마감) */
  closeMinRate: number;
}

export const DEFAULT_RULES: CisRules = {
  /*
   * 한 종목 12% — 여덟 종목이면 꽉 찬다. 더 몰면 한 번의 갭하락이 계좌를 끝내고,
   * 더 쪼개면 이겨도 티가 안 나 전략을 판단할 수 없다.
   */
  maxPerStock: 12,
  maxPositions: 8,
  /*
   * 손절 -7% / 익절 +15%. 추세추종은 **이기는 횟수가 적고 이길 때 크게** 먹는
   * 전략이라 손익비가 2 를 넘어야 한다. 손절을 좁히면(-3%) 흔들림에 다 털리고,
   * 넓히면(-15%) 한 번에 두 달치를 잃는다.
   */
  stopPct: -7,
  targetPct: 15,
  /* 열흘 안에 안 가면 내 판단이 틀린 것이다. 돈이 묶이는 게 더 비싸다 */
  maxHoldDays: 10,
  /* 신호등 분석 원장을 후보에 더한다 — 조회를 안 늘리면서 보는 자리가 넓어진다 */
  useListTrack: true,
  minScore: 60,
  /*
   * 500억 미만은 내가 사는 수량에 값이 밀린다 — 모의라도 못 살 걸 샀다고 적지 않는다.
   *
   * 벤티지가 "거래대금 최소 100억 이상"이라고 했는데 **여기는 이미 500 이라 더
   * 세다.** 100 으로 내리면 규칙이 느슨해지므로 그대로 둔다 — "잡주는 안되"라는
   * 말의 방향과 반대가 되기 때문이다. 낮추고 싶으면 화면에서 바꾸면 된다.
   */
  minTradeValue: 500,
  /* 시총 1000억 — 하루 소나기로 통과하는 잡주를 막는 바닥 크기 문턱 */
  minMarketCap: 1000,
  minMarketScore: 40,
  /*
   * 장세 신뢰도 문(2026-08-31) — 기본 켬.
   * 폭·신고가 문턱은 장세 점검 설정(설정 > 분석 > 장세 점검)에서 조절한다.
   */
  useRegimeGate: true,
  /* +7% 넘어가면 손절을 본전으로 — 이익을 손실로 바꾸지 않는다 */
  trailAfterPct: 7,

  useOpen: true,
  useIntra: true,
  useClose: true,
  /*
   * 갭 +4% 까지만. 손절이 -7% 인데 갭으로 5% 를 주고 들어가면 남은 거리가 2% 다 —
   * 그 자리는 흔들림 한 번에 털린다.
   */
  maxOpenGap: 4,
  /* 시가보다 +1% 위 — 눌렸다 「회복했다」의 최소 증거 */
  intraMinFromOpen: 1,
  /* 종가배팅은 그날 3% 이상 오른 것만. 어중간하게 끝난 것은 갭을 안 준다 */
  closeMinRate: 3,
};

/* ------------------------------------------------------------------ 후보 */

export interface Candidate {
  code: string;
  name: string;
  price: number;
  changeRate: number;
  tradeValue: number;
  sector: string;
  /** 신호등 점수 */
  signalScore: number | null;
  signalLevel: string | null;
  /** 주도주 점수 */
  leaderScore: number;
  /** 최종 점수 — 무엇을 얼마나 반영했는지 `used` 에 남는다 */
  score: number;
  /** 어느 화면을 보고 이 점수가 나왔나 — 일지의 「HTS 활용법」이 이걸 센다 */
  used: string[];
  /** 왜 후보인가 — 사람이 읽을 한 줄 */
  why: string;
  /** 못 산 이유 (걸러졌으면) */
  rejected?: string;
  /** 어느 자리로 들어갈까 — 시간대가 정하는 게 아니라 **자리의 성질**이 정한다 */
  mode?: EntryMode;
}

/**
 * 오늘의 후보를 뽑는다.
 *
 * 순서가 중요하다 — **주도주에서 시작해 신호등으로 거른다.** 반대로 하면(전 종목
 * 신호등 → 강한 것 고르기) 신호등을 수천 번 불러야 하고, 그건 키움 호출 한도에
 * 걸린다. 주도주가 이미 「돈이 몰린 곳」으로 좁혀 놓았으니 그 위에서만 판단한다.
 */
export async function pickCandidates(
  client: KiwoomClient,
  rules: CisRules = DEFAULT_RULES,
  limit = 12,
): Promise<{ candidates: Candidate[]; rejected: Candidate[]; note: string }> {
  const scan = await leaderScan(client);

  /* 오늘 거래 자체가 없으면 판단하지 않는다 — 0을 「약하다」로 읽으면 안 된다 */
  if (scan.noTrade) {
    return { candidates: [], rejected: [], note: "오늘 거래가 아직 없어 후보를 뽑지 않았다." };
  }

  /*
   * ## **잡주 거르개** (2026-09-01) — 벤티지: "잡주는 안되!"
   *
   * 스냅샷에 종목별 **시가총액과 거래대금**이 둘 다 들어 있다. 이미 받아 둔
   * 것이라 조회가 안 는다. 못 받으면 맵이 비고, 그때는 **거르지 않는다** —
   * 「모른다」로 후보를 통째로 비우는 게 더 나쁘다.
   */
  const capOf = new Map<string, number | null>();
  const valOf = new Map<string, number | null>();
  if (rules.minMarketCap > 0) {
    try {
      const snap = await getMarketSnapshot(client);
      for (const [code, r] of snap.byCode) {
        capOf.set(code, r.marketCap ?? null);
        valOf.set(code, r.tradeValue ?? null);
      }
    } catch {
      /* 못 받으면 시총 문턱만 못 건다. 거래대금 문턱은 주도주 스캔 값으로 걸린다 */
    }
  }
  /** 이 종목이 문턱을 통과하나 — 못 재면 통과시킨다(「모른다」≠「작다」) */
  const tooSmall = (code: string, tradeValue?: number): string | null => {
    const cap = capOf.get(code);
    if (rules.minMarketCap > 0 && cap !== null && cap !== undefined && cap < rules.minMarketCap) {
      return `시총 ${Math.round(cap).toLocaleString("ko-KR")}억 < ${rules.minMarketCap}억`;
    }
    const tv = tradeValue !== undefined && tradeValue > 0 ? tradeValue : valOf.get(code);
    if (rules.minTradeValue > 0 && tv !== null && tv !== undefined && tv > 0 && tv < rules.minTradeValue) {
      return `거래대금 ${Math.round(tv).toLocaleString("ko-KR")}억 < ${rules.minTradeValue}억`;
    }
    return null;
  };

  const pool = scan.stocks
    .filter((s) => s.tradeValue >= rules.minTradeValue)
    .slice(0, 30);

  const out: Candidate[] = [];
  const bad: Candidate[] = [];

  for (const s of pool) {
    const base = toCandidate(s, scan);
    /* 거래대금은 위에서 걸렀고, 여기서 시총을 본다 */
    const small = tooSmall(s.code, s.tradeValue);
    if (small) {
      base.rejected = small;
      bad.push(base);
      continue;
    }
    /*
     * 신호등은 한 종목씩 부르는 무거운 조회라 **후보에만** 쓴다. 실패하면 그 종목만
     * 신호등 없이 간다 — 하나 실패했다고 그날 전체를 못 하게 만들 이유가 없다.
     */
    try {
      const sig = await evaluateSignal(client, s.code);
      base.signalScore = sig.score;
      base.signalLevel = sig.level;
      base.used.push(`신호등:${sig.level}(${sig.score})`);
      if (sig.level === "red") {
        base.rejected = "신호등 빨강";
        bad.push(base);
        continue;
      }
      if (sig.score < rules.minScore) {
        base.rejected = `신호등 ${sig.score}점 < ${rules.minScore}`;
        bad.push(base);
        continue;
      }
      /* 신호등 점수를 절반 얹는다 — 주도주가 본체고 신호등은 거르개다 */
      base.score += sig.score * 0.5;
    } catch {
      base.used.push("신호등:조회실패");
    }
    out.push(base);
  }

  /*
   * **신호등 분석 원장에서 더 담는다** (2026-08-31).
   *
   * 이미 신호등을 재서 초록으로 확정된 종목들이라 **조회가 0회**다. 그리고
   * 주도주 스캔이 못 보는 목록(외국인 연속순매매·동일순매매 등)에서 온 종목이
   * 섞이므로 보는 자리가 넓어진다.
   *
   * 중복은 제외한다 — 주도주 쪽에 이미 있으면 그쪽 점수를 쓴다(주도주 정보가
   * 더 풍부하다).
   */
  if (rules.useListTrack) {
    try {
      const have = new Set([...out, ...bad].map((c) => c.code));
      const lt = await listTrackSummary();
      /** 같은 종목이 여러 목록에 있으면 한 줄로 — 걸린 목록 수를 세어 둔다 */
      const byCode = new Map<string, { e: (typeof lt.entries)[number]; lists: string[] }>();
      for (const e of lt.entries) {
        if (e.active === false || have.has(e.code)) continue;
        const prev = byCode.get(e.code);
        if (prev) prev.lists.push(e.list);
        else byCode.set(e.code, { e, lists: [e.list] });
      }
      for (const { e, lists } of byCode.values()) {
        if (e.score < rules.minScore) continue;
        /*
         * ⚠️ **이 갈래에는 거르개가 아예 없었다** (2026-09-01 발견).
         *
         * 주도주 갈래는 `minTradeValue` 로 걸렀는데 여기는 점수만 보고 `tradeValue: 0`
         * 으로 밀어 넣었다. 원장에 담긴 초록이면 무조건 후보가 됐다는 뜻이라,
         * 잡주가 새는 자리가 정확히 여기였다.
         */
        const small = tooSmall(e.code);
        if (small) {
          bad.push({
            code: e.code,
            name: e.name,
            price: e.addedPrice,
            changeRate: 0,
            tradeValue: valOf.get(e.code) ?? 0,
            sector: "",
            signalScore: e.score,
            signalLevel: "green",
            leaderScore: 0,
            score: e.score,
            used: [`신호등 분석:${lists.length}목록`],
            why: `${lists.length}개 목록에서 초록 · ${e.seenCount}일째`,
            rejected: small,
          });
          continue;
        }
        out.push({
          code: e.code,
          name: e.name,
          price: e.addedPrice,
          changeRate: 0,
          /* 스냅샷에서 채운다 — 0 으로 두면 화면이 「거래 없음」으로 읽는다 */
          tradeValue: valOf.get(e.code) ?? 0,
          sector: "",
          signalScore: e.score,
          signalLevel: "green",
          leaderScore: 0,
          /*
           * 점수는 **신호등만**으로 낸다 — 주도주 점수가 없으니 그 자리를 0 으로 두고
           * 신호등을 온전히 반영한다. 주도주에서 온 후보와 견줄 때 불리하지만,
           * 그건 「주도주 정보가 있는 쪽이 더 안다」는 뜻이라 맞는 순서다.
           */
          score: e.score,
          used: [`신호등 분석:${lists.length}목록`, `신호등:green(${e.score})`],
          why: `${lists.length}개 목록에서 초록 · ${e.seenCount}일째`,
        });
      }
    } catch {
      /* 원장을 못 읽어도 주도주 후보는 그대로 간다 */
    }
  }

  out.sort((a, b) => b.score - a.score);
  return {
    candidates: out.slice(0, limit),
    rejected: bad,
    note: scan.note,
  };
}

function toCandidate(s: LeaderStock, scan: Awaited<ReturnType<typeof leaderScan>>): Candidate {
  const used = ["주도주 스캔"];
  const sec = scan.sectors.find((x) => x.name === s.sector);
  let score = s.score;
  const bits: string[] = [`${s.sector} ${s.changeRate.toFixed(1)}%`];

  /*
   * **섹터가 같이 강한지**를 얹는다. 혼자 오른 종목은 다음 날 혼자 빠진다.
   * 돈이 그 판 전체로 들어왔는지가 스윙에서는 종목 자체보다 중요하다.
   */
  if (sec) {
    used.push(`섹터강도:${sec.name}`);
    if (sec.breadth >= 60) {
      score += 10;
      bits.push(`섹터 폭 ${sec.breadth.toFixed(0)}%`);
    }
    if (sec.streak && sec.streak >= 2) {
      score += 8;
      bits.push(`${sec.streak}일 연속 강세`);
      used.push("섹터 연속성");
    }
  }
  /* 거래량이 터진 것 — 추세의 시작은 거래량이 먼저 온다 */
  if (s.volumeRatio && s.volumeRatio >= 2) {
    score += 6;
    bits.push(`거래량 ${s.volumeRatio.toFixed(1)}배`);
    used.push("거래량 배수");
  }

  return {
    code: s.code,
    name: s.name,
    price: s.price,
    changeRate: s.changeRate,
    tradeValue: s.tradeValue,
    sector: s.sector,
    signalScore: null,
    signalLevel: null,
    leaderScore: s.score,
    score,
    used,
    why: bits.join(" · "),
  };
}

/* ------------------------------------------------------------------ 진입 문 */

/** 이 시간대에 어느 모드로 들어가나 */
export function modeOfSlot(slot: "morning" | "noon" | "evening"): EntryMode {
  return slot === "morning" ? "open" : slot === "noon" ? "intra" : "close";
}

export interface EntryGate {
  ok: boolean;
  reason: string;
}

/**
 * 이 후보가 **지금 이 자리로** 들어갈 만한가.
 *
 * 시간대마다 조건이 다르다. 같은 종목이라도 아침의 이유와 저녁의 이유가 다르고,
 * 이유가 없으면 안 산다 — **그게 「능동적」과 「충동적」의 차이다.**
 *
 * ⚠️ 여기서 쓰는 값은 **지금 값과 시가**뿐이다. 우리가 확실히 아는 것만 쓴다.
 * 시가를 못 읽으면 갭·회복을 판단할 수 없으므로 **안 사는 쪽**이다 — 모르는 자리에
 * 들어가는 것이 가장 비싸다.
 */
export function entryGate(
  mode: EntryMode,
  c: Candidate,
  now: number | null,
  open: number | null,
  prevClose: number | null,
  rules: CisRules = DEFAULT_RULES,
): EntryGate {
  if (mode === "open" && !rules.useOpen) return { ok: false, reason: "시가배팅 꺼짐" };
  if (mode === "intra" && !rules.useIntra) return { ok: false, reason: "장중배팅 꺼짐" };
  if (mode === "close" && !rules.useClose) return { ok: false, reason: "종가배팅 꺼짐" };
  if (now === null || now <= 0) return { ok: false, reason: "값을 못 읽었다" };

  if (mode === "open") {
    /*
     * 시가배팅 — **갭이 크면 안 산다.** 손절이 -7% 인데 갭으로 5% 를 주고 들어가면
     * 남은 거리가 2% 라, 그 자리는 흔들림 한 번에 털린다. 자리가 좋아도 값이 나쁘면
     * 그 매매는 나쁜 매매다.
     */
    if (prevClose === null || prevClose <= 0) return { ok: false, reason: "전일 종가를 못 읽어 갭을 못 잰다" };
    const gap = ((now - prevClose) / prevClose) * 100;
    if (gap > rules.maxOpenGap) {
      return { ok: false, reason: `갭 +${gap.toFixed(1)}% > 허용 ${rules.maxOpenGap}% — 손절까지 거리가 없다` };
    }
    if (gap < -3) {
      return { ok: false, reason: `갭 ${gap.toFixed(1)}% — 어제 신호가 밤새 깨졌다` };
    }
    return { ok: true, reason: `갭 ${gap > 0 ? "+" : ""}${gap.toFixed(1)}% — 살 만한 자리` };
  }

  if (mode === "intra") {
    /*
     * 장중배팅 — **눌렸다 회복한 것**만. 시가부터 쭉 오른 것은 이미 늦었고,
     * 시가 밑에 있는 것은 아직 아니다. 그 사이가 이 모드의 자리다.
     */
    if (open === null || open <= 0) return { ok: false, reason: "시가를 못 읽었다" };
    const fromOpen = ((now - open) / open) * 100;
    if (fromOpen < rules.intraMinFromOpen) {
      return { ok: false, reason: `시가 대비 ${fromOpen.toFixed(1)}% — 아직 회복 못 했다` };
    }
    if (fromOpen > 8) {
      return { ok: false, reason: `시가 대비 +${fromOpen.toFixed(1)}% — 이미 갔다, 추격은 안 한다` };
    }
    return { ok: true, reason: `시가 대비 +${fromOpen.toFixed(1)}% 회복` };
  }

  /*
   * 종가배팅 — **강하게 마감한 것**만. 다음 날 갭을 노리는 자리라, 어중간하게
   * 끝난 것은 갭을 안 준다. 판(섹터)이 연속으로 강한지도 본다 — 하루짜리는
   * 다음 날 되돌린다.
   */
  if (c.changeRate < rules.closeMinRate) {
    return { ok: false, reason: `오늘 ${c.changeRate.toFixed(1)}% < ${rules.closeMinRate}% — 강하게 끝나지 않았다` };
  }
  if (!c.used.includes("섹터 연속성")) {
    return { ok: false, reason: "판이 연속으로 강하지 않다 — 하루짜리는 다음 날 되돌린다" };
  }
  /* 담는 자리는 NXT 애프터마켓(15:40~20:00)이다 — 마감 뒤에도 종가 근처에 살 수 있다 */
  return { ok: true, reason: `${c.changeRate.toFixed(1)}% 로 마감 · 판이 연속 강세 (NXT 애프터에서 담는다)` };
}

/* ------------------------------------------------------------------ 매도 판단 */

export interface ExitCall {
  position: Position;
  price: number;
  reason: string;
  kind: "stop" | "target" | "stale" | "misu" | "trail";
}

/**
 * 지금 팔아야 할 것들. **판단은 여기 한 곳**이고, 아침·점심·저녁이 모두 이걸 부른다 —
 * 시간대마다 따로 적으면 손절 규칙이 셋으로 갈라져 서로 달라진다.
 */
export function exitCalls(
  a: CisAccount,
  priceOf: (code: string) => number | null,
  rules: CisRules = DEFAULT_RULES,
  date = today(),
): ExitCall[] {
  const out: ExitCall[] = [];
  for (const p of a.positions) {
    const px = priceOf(p.code);
    if (px === null || px <= 0) continue;
    const pct = ((px - p.avg) / p.avg) * 100;
    const held = Math.max(0, Math.round((Date.parse(date) - Date.parse(p.openedAt)) / 86400_000));

    /*
     * 미수 만기가 **가장 먼저다.** 다른 이유로 들고 있고 싶어도 못 들고 있는다 —
     * 실제로는 반대매매가 나간다. 여기서 안 팔면 장부가 현실을 벗어난다.
     */
    if (p.funding === "misu" && p.dueDate && p.dueDate <= date) {
      out.push({ position: p, price: px, kind: "misu", reason: `미수 만기(${p.dueDate})` });
      continue;
    }
    if (p.stop !== null && px <= p.stop) {
      out.push({ position: p, price: px, kind: "stop", reason: `손절선 ${p.stop.toLocaleString()}원 이탈` });
      continue;
    }
    if (pct <= rules.stopPct) {
      out.push({ position: p, price: px, kind: "stop", reason: `${pct.toFixed(1)}% (손절 ${rules.stopPct}%)` });
      continue;
    }
    if (p.target !== null && px >= p.target) {
      out.push({ position: p, price: px, kind: "target", reason: `목표가 ${p.target.toLocaleString()}원 도달` });
      continue;
    }
    if (pct >= rules.targetPct) {
      out.push({ position: p, price: px, kind: "target", reason: `${pct.toFixed(1)}% (익절 ${rules.targetPct}%)` });
      continue;
    }
    if (held >= rules.maxHoldDays) {
      out.push({
        position: p,
        price: px,
        kind: "stale",
        reason: `${held}일째 제자리 (${pct.toFixed(1)}%)`,
      });
    }
  }
  return out;
}

/**
 * 이익이 난 자리는 손절선을 **본전으로 올린다.** 판단이 아니라 관리라서 매도와
 * 나눠 둔다 — 이걸 안 하면 +12% 를 보고도 -7% 로 끝나는 날이 생긴다.
 */
export function trailStops(
  a: CisAccount,
  priceOf: (code: string) => number | null,
  rules: CisRules = DEFAULT_RULES,
): { code: string; name: string; from: number | null; to: number }[] {
  const moved: { code: string; name: string; from: number | null; to: number }[] = [];
  for (const p of a.positions) {
    const px = priceOf(p.code);
    if (px === null || px <= 0) continue;
    const pct = ((px - p.avg) / p.avg) * 100;
    if (pct < rules.trailAfterPct) continue;
    if (p.stop !== null && p.stop >= p.avg) continue; // 이미 본전 위
    moved.push({ code: p.code, name: p.name, from: p.stop, to: p.avg });
    p.stop = p.avg;
  }
  return moved;
}

/* ------------------------------------------------------------------ 매수 실행 */

/**
 * 자금을 무엇으로 쓸까.
 *
 * 규칙은 단순하다 — **예수금이 있으면 예수금.** 없을 때만 빌리고, 그때는
 * **오래 끌 것이면 신용, 짧게 칠 것이면 미수**다. 판단 근거는 「그 종목을 며칠
 * 볼 것인가」인데 우리는 그걸 섹터 연속성으로 어림한다: 며칠째 강한 판이면 더 끈다.
 *
 * ⚠️ 빌리는 것을 **기본으로 두지 않는다.** 레버리지는 이기는 전략을 더 이기게
 * 하지만 지는 전략을 훨씬 빨리 죽인다. 이 계좌는 아직 이기는지 모른다.
 */
export function fundingFor(a: CisAccount, need: number, keepDays: number): Funding {
  if (a.cash >= need) return "cash";
  return keepDays >= 3 ? "credit" : "misu";
}

export interface BuyPlan {
  candidate: Candidate;
  qty: number;
  price: number;
  funding: Funding;
  stop: number;
  target: number;
  amount: number;
}

/**
 * 후보에서 실제 주문을 만든다. **살 수 있는 것만** 만든다 — 여력을 넘는 계획을
 * 세워 두고 나중에 못 사면, 일지에는 「사려 했다」가 남고 계좌에는 아무것도 없어
 * 둘이 어긋난다.
 */
export function planBuys(
  a: CisAccount,
  cands: Candidate[],
  priceOf: (code: string) => number | null,
  rules: CisRules = DEFAULT_RULES,
): { plans: BuyPlan[]; skipped: { name: string; reason: string }[] } {
  const plans: BuyPlan[] = [];
  const skipped: { name: string; reason: string }[] = [];
  const { equity } = equityOf(a, priceOf);
  const room = rules.maxPositions - a.positions.length;
  if (room <= 0) {
    return { plans: [], skipped: cands.map((c) => ({ name: c.name, reason: "보유 종목이 꽉 찼다" })) };
  }

  const budget = Math.floor((equity * rules.maxPerStock) / 100);

  for (const c of cands) {
    if (plans.length >= room) {
      skipped.push({ name: c.name, reason: "자리 없음" });
      continue;
    }
    if (a.positions.some((p) => p.code === c.code)) {
      skipped.push({ name: c.name, reason: "이미 보유" });
      continue;
    }
    const price = priceOf(c.code) ?? c.price;
    if (price <= 0) {
      skipped.push({ name: c.name, reason: "값을 못 읽었다" });
      continue;
    }
    /* 며칠 볼 것인가 — 섹터가 연속으로 강하면 길게 본다(fundingFor 의 근거) */
    const keepDays = c.used.some((u) => u === "섹터 연속성") ? 4 : 2;
    const funding = fundingFor(a, budget, keepDays);
    const power = buyingPower(a, funding, priceOf);
    const amount = Math.min(budget, power);
    const qty = Math.floor(amount / price);
    if (qty <= 0) {
      skipped.push({ name: c.name, reason: `${funding} 여력 부족` });
      continue;
    }
    plans.push({
      candidate: c,
      qty,
      price,
      funding,
      stop: Math.round(price * (1 + rules.stopPct / 100)),
      target: Math.round(price * (1 + rules.targetPct / 100)),
      amount: qty * price,
    });
  }
  return { plans, skipped };
}

/* ------------------------------------------------------------------ 시장 문 */

export interface MarketGate {
  ok: boolean;
  score: number;
  label: string;
  reason: string;
  /**
   * **내 신호등이 오늘 유효한가** (2026-08-31) — 시장 점수와 **다른 물음**이다.
   *
   * 19만 관측 조건부 실측에서 나온 것: 폭이 좁은 날의 초록은 시장에 **-2.15%p
   * 지고 승률이 43%** 였다(폭 넓은 날은 +2.20%p, 53%). 그런데 그 두 날의
   * **시장 평균은 +3.19% vs +3.91% 로 거의 같았다.**
   *
   * 즉 「시장이 나빠서 초록도 나빴다」가 아니다 — 시장은 비슷했는데 **초록만
   * 갈렸다.** 신호등이 골라내는 기능이 꺼지는 것이라, 시장 점수로는 이걸 못 잡는다.
   */
  regime?: {
    weak: boolean;
    breadth: number | null;
    newHigh: number | null;
    why: string | null;
  };
}

/**
 * 오늘 사도 되는 시장인가.
 *
 * **살 이유가 아니라 안 살 이유를 찾는 문이다.** 추세추종은 시장이 무너질 때
 * 가장 크게 다친다 — 개별 종목이 아무리 좋아도 지수가 무너지면 같이 빠진다.
 * 벤티지가 "요즘 시장이 어지러워서 거래를 안 하고 있다"고 한 그 판단을 규칙으로 옮긴 것이다.
 */
export async function marketGate(
  client: KiwoomClient,
  rules: CisRules = DEFAULT_RULES,
): Promise<MarketGate> {
  try {
    /*
     * **두 문을 따로 연다** (2026-08-31).
     *
     *   ① 시장 점수  — 「시장이 무너지는 중인가」
     *   ② 장세 신뢰도 — 「내 신호등이 오늘 골라낼 수 있나」
     *
     * 둘은 다른 물음이고, 실측은 ②가 더 크게 갈랐다. 폭 좁은 날과 넓은 날의
     * **시장 평균은 거의 같았는데**(+3.19% vs +3.91%) 초록만 -2.15%p ↔ +2.20%p 로
     * 갈렸다. ①만 보면 이걸 통째로 놓친다.
     */
    const [m, reg] = await Promise.all([
      evaluateMarket(client),
      rules.useRegimeGate === false
        ? Promise.resolve(null)
        : regimeTrust().catch(() => null),
    ]);
    const score = typeof m.score === "number" ? m.score : 0;
    const scoreOk = score >= rules.minMarketScore;
    const regimeOk = !reg?.weak;
    const ok = scoreOk && regimeOk;

    /*
     * **왜 안 사는지가 일지에 남아야 한다.** 「오늘은 안 산다」만 적으면 나중에
     * 그날을 다시 볼 때 이유를 알 수 없다 — 이 시스템의 값어치는 판단과 근거를
     * 한 줄에 묶는 데 있다.
     */
    const reason = !scoreOk
      ? `시장 ${score}점 < ${rules.minMarketScore}점 — 오늘은 안 산다`
      : !regimeOk
        ? `시장은 ${score}점으로 괜찮지만 **신호등이 잘 안 듣는 장세**다 (${reg?.why}). ` +
          `이 구간의 초록은 실측에서 시장에 -2.15%p 지고 승률이 43% 였다 — 오늘은 쉰다`
        : `시장 ${score}점 · 폭 ${reg?.breadth ?? "-"}% — 매수 허용`;

    return {
      ok,
      score,
      label: m.level ?? "",
      reason,
      regime: reg
        ? { weak: reg.weak, breadth: reg.breadth, newHigh: reg.newHigh, why: reg.why }
        : undefined,
    };
  } catch {
    /* 못 읽었으면 **안 사는 쪽**이다. 모르는 시장에서 사는 것이 가장 비싸다 */
    return { ok: false, score: 0, label: "", reason: "시장 판단을 못 읽어 오늘은 쉰다" };
  }
}

/* ------------------------------------------------------------------ 실행 */

export { loadAccount, saveAccount, markToMarket, misuDue, buy, sell, addTradingDays };
