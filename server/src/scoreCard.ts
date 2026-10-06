import { listLedger, type ListEntry } from "./listTrack.js";
import { superEntries } from "./superSignal.js";

/**
 * 실전 성적표 — **원장이 지금까지 무슨 말을 하고 있나** (2026-10-07).
 *
 * 벤티지: "이제 이 앱을 운영한지도 꽤 되었는데 말야. 그간 누적된 데이터와 검증 값들
 * 그리고 활용도에서 개선하거나 추가하거나 했음 기능 잇니."
 *
 * ## 이미 있는 두 표와 무엇이 다른가
 *
 * 「신호등 분석」은 **목록별**로 센다 — 어느 갈래로 걸린 것이 좋았나. 시뮬레이터는
 * **점수대별**로 세는데 그건 *표본*(원장에서 되짚어 만든 관측)이다. 그런데 정작
 * 물어야 할 것이 빠져 있었다 —
 *
 *   **매일 실제로 돌린 원장에서, 70·80·90 이 정말 갈렸나.**
 *
 * 되짚은 표본과 실제로 돌린 원장은 다르다. 표본은 「그때 알 수 있었을 것」을 일봉으로
 * 재구성한 것이고, 원장은 **그날 신호등이 진짜로 낸 점수**다. 12월 말에 문턱을 손볼 때
 * 근거가 되는 쪽은 뒤쪽이다.
 *
 * ## 이 파일이 지키는 것 하나 — **잰 것과 안 잰 것을 같이 센다**
 *
 * 평균 옆에 **n(편입)** 과 **잰 것(채점된 건수)** 을 나란히 적는다. 이 코드베이스에서
 * 가장 비싸게 배운 것이 그거다 — 덜 잰 점수는 부풀려진다. 2026-10-07 에 실제로 겪었다:
 * 1,172건 중 300건만 채점돼 있었고, 그 300건은 **20거래일이 지난 오래된 편입**뿐이었다.
 * 원장이 9/02 에 시작했으니 당연한 일인데, 그 상태로 「약한 장이 나빴다」를 읽으면
 * 실은 **「오래된 편입만 쟀다」**를 읽는 것이 된다. 기준 지문이 그 시기와 겹쳐 있어
 * 지문별 채점률을 **표 맨 위에 경고로** 올린다 — 쏠림을 보는 가장 싼 자다.
 *
 * 조회 0회 — 원장에 이미 적힌 값만 센다.
 */

/** 한 칸의 성적 — 평균 하나로 끝내지 않는다 */
export interface ScoreStat {
  /** 이 칸에 들어온 편입 건수 */
  n: number;
  /** 그중 **채점된** 건수. n 과 벌어지면 평균을 믿을 수 없다 */
  graded: number;
  /** 지수 대비 평균(%p) */
  avg: number | null;
  /** 중앙값(%p) — 평균이 한둘에 끌려갔는지 본다 */
  med: number | null;
  /** 이긴 비율(%) — 지수를 이긴 건수 / 잰 건수 */
  win: number | null;
  /** 가장 나빴던 한 건(%p) — 「한 번에 얼마나 다치나」 */
  worst: number | null;
}

export interface ScoreRow {
  label: string;
  d5: ScoreStat;
  d20: ScoreStat;
}

export interface ScoreCut {
  /** 무엇으로 갈랐나 */
  title: string;
  /** 이 가로지르기가 무엇을 묻는가 — 화면에 한 줄로 */
  asks: string;
  rows: ScoreRow[];
}

export interface ScoreCard {
  builtAt: string;
  source: "listTrack" | "super";
  lastRunDate: string | null;
  /** 편입 전체 */
  total: number;
  /** 그중 20일 지수 대비가 채점된 건수 */
  graded: number;
  /**
   * 5일이 채점된 건수. **20일보다 늘 많다** — 원장이 어리면 20일은 아직 못 낸다.
   * 20일 칸이 얇을 때 어느 칸을 읽어야 하는지 화면이 판단하는 근거다.
   */
  graded5: number;
  /**
   * 기준 지문별 채점률 — **쏠림 감시**. 한 지문만 다 채점돼 있으면 모든 가로지르기가
   * 실은 「지문 차이」를 보고 있을 수 있다.
   */
  byHash: { hash: string; n: number; graded: number }[];
  /** 커버리지가 낮거나 쏠려 있으면 한 줄. 없으면 null */
  warn: string | null;
  cuts: ScoreCut[];
}

function stat(list: (number | null | undefined)[], n: number): ScoreStat {
  const vs = list.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (vs.length === 0) return { n, graded: 0, avg: null, med: null, win: null, worst: null };
  const sorted = [...vs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return {
    n,
    graded: vs.length,
    avg: r2(vs.reduce((a, b) => a + b, 0) / vs.length),
    med: r2(sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2),
    win: Math.round((vs.filter((v) => v > 0).length / vs.length) * 100),
    worst: r2(sorted[0]),
  };
}

/** 가로지르기 하나 — 갈래 함수가 null 을 주면 그 건은 뺀다(모르는 것은 안 센다) */
function cut<T>(
  title: string,
  asks: string,
  rows: T[],
  by: (r: T) => string | null,
  order: string[] | null,
  ex: (r: T) => { d5: number | null | undefined; d20: number | null | undefined },
): ScoreCut {
  const g = new Map<string, T[]>();
  for (const r of rows) {
    const k = by(r);
    if (k === null) continue;
    const arr = g.get(k);
    if (arr) arr.push(r);
    else g.set(k, [r]);
  }
  const keys = order ? order.filter((k) => g.has(k)) : [...g.keys()].sort();
  return {
    title,
    asks,
    rows: keys.map((k) => {
      const sub = g.get(k) ?? [];
      return {
        label: k,
        d5: stat(
          sub.map((r) => ex(r).d5),
          sub.length,
        ),
        d20: stat(
          sub.map((r) => ex(r).d20),
          sub.length,
        ),
      };
    }),
  };
}

function band(score: number | undefined): string | null {
  if (typeof score !== "number" || !Number.isFinite(score)) return null;
  if (score >= 90) return "90점+";
  if (score >= 85) return "85~89";
  if (score >= 80) return "80~84";
  if (score >= 75) return "75~79";
  if (score >= 70) return "70~74";
  return "70점 미만";
}
const BANDS = ["70점 미만", "70~74", "75~79", "80~84", "85~89", "90점+"];

/**
 * 신호등 원장(`listTrack`) 성적표.
 *
 * 지수 대비(`excess`)로만 센다. 절대수익률로 세면 상승장에서 전부 이긴 것처럼 보인다 —
 * 이 코드베이스가 그걸로 한 번 속았다.
 */
export async function listScoreCard(): Promise<ScoreCard> {
  const { entries, lastRunDate } = await listLedger();
  const ex = (e: ListEntry) => ({ d5: e.excess?.d5, d20: e.excess?.d20 });
  const graded = entries.filter((e) => typeof e.excess?.d20 === "number").length;
  const graded5 = entries.filter((e) => typeof e.excess?.d5 === "number").length;

  /* 기준 지문별 채점률 — 쏠림이 있으면 아래 표 전부를 의심해야 한다 */
  const hashes = new Map<string, { n: number; graded: number }>();
  for (const e of entries) {
    const h = e.configHash || "(지문 없음)";
    const cur = hashes.get(h) ?? { n: 0, graded: 0 };
    cur.n += 1;
    if (typeof e.excess?.d20 === "number") cur.graded += 1;
    hashes.set(h, cur);
  }
  const byHash = [...hashes.entries()]
    .map(([hash, v]) => ({ hash, ...v }))
    .sort((a, b) => b.n - a.n);

  /*
   * 경고는 **두 가지**를 본다. 하나라도 걸리면 평균을 읽는 눈이 달라져야 한다.
   *  · 전체 채점률이 낮다 → 표본이 얇다
   *  · 지문마다 채점률이 크게 다르다 → 가로지르기가 「지문 차이」를 볼 수 있다
   */
  const rate = entries.length > 0 ? (graded / entries.length) * 100 : 0;
  const big = byHash.filter((h) => h.n >= 30);
  const rates = big.map((h) => (h.graded / h.n) * 100);
  const spread = rates.length >= 2 ? Math.max(...rates) - Math.min(...rates) : 0;
  const rate5 = entries.length > 0 ? (graded5 / entries.length) * 100 : 0;
  let warn: string | null = null;
  if (entries.length === 0) warn = "원장이 비어 있습니다 — 아직 아무것도 담지 않았습니다.";
  else if (rate < 50 && rate5 >= 70)
    /*
     * 20일이 얇은 것은 **결함이 아니라 나이**다 — 편입이 20거래일을 지나야 낼 수 있다.
     * 그러니 「고쳐라」가 아니라 「5일 칸을 읽어라」가 맞는 말이다.
     */
    /* 화면은 평문만 그린다 — 별표를 쓰면 `**5일 칸**` 이 그대로 찍힌다 */
    warn = `20일 칸은 ${entries.length}건 중 ${graded}건만 찼습니다 — 나머지는 아직 20거래일이 안 지났습니다. 지금은 5일 칸(${graded5}건)으로 읽으세요.`;
  else if (rate < 50)
    warn = `${entries.length}건 중 ${graded}건(${Math.round(rate)}%)만 채점됐습니다 — 아래 평균은 아직 얇습니다.`;
  else if (spread >= 40)
    warn = `기준이 바뀐 전후로 채점률이 ${Math.round(spread)}%p 벌어져 있습니다 — 20일 칸은 오래된 편입에 쏠려 있으니, 아래 차이가 장세가 아니라 편입 시기 차이일 수 있습니다. 5일 칸이 더 고릅니다.`;

  return {
    builtAt: new Date().toISOString(),
    source: "listTrack",
    lastRunDate,
    total: entries.length,
    graded,
    graded5,
    byHash,
    warn,
    cuts: [
      cut(
        "점수대별",
        "문턱이 값어치가 있나 — 90점이 70점보다 정말 나았나",
        entries,
        (e) => band(e.score),
        BANDS,
        ex,
      ),
      cut(
        "장세별",
        "약한 장에서 걸린 신호도 믿을 만했나",
        entries,
        (e) => (e.regime ? (e.regime.weak ? "약한 장" : "보통 장") : null),
        ["보통 장", "약한 장"],
        ex,
      ),
      /*
       * ⚠️ 아래 두 칸은 **편입 시점에 알 수 없는 값**으로 가른다.
       *
       * `seenCount`·`alerts` 는 원장이 **마지막으로 잰 날**까지 갱신된다. 그러니
       * 「10일째 걸린 것」은 편입일에 알 수 없고(앞으로 10일 더 걸릴지는 미래다),
       * 경보도 편입일 경보가 아니다. 숫자는 뜻이 있지만 **고르는 기준으로는 못 쓴다** —
       * 쓰면 미래를 보고 고른 셈이 되어 실전에서 재현되지 않는다. 표에 적어 둔다.
       */
      cut(
        "며칠째 걸렸나 ⚠️",
        "오래 걸려 있는 종목은 편입 직후가 어땠나 — ⚠️ 편입일엔 알 수 없는 값이라 고르는 기준으로는 못 씁니다",
        entries,
        (e) =>
          typeof e.seenCount !== "number"
            ? null
            : e.seenCount <= 1
              ? "첫날"
              : e.seenCount <= 4
                ? "2~4일째"
                : e.seenCount <= 9
                  ? "5~9일째"
                  : "10일째+",
        ["첫날", "2~4일째", "5~9일째", "10일째+"],
        ex,
      ),
      cut(
        "목록 안 순위",
        "상위권으로 걸린 것이 더 나았나 — 순위를 볼 값어치가 있나",
        entries,
        (e) =>
          typeof e.rank !== "number"
            ? null
            : e.rank <= 5
              ? "1~5위"
              : e.rank <= 20
                ? "6~20위"
                : "21위+",
        ["1~5위", "6~20위", "21위+"],
        ex,
      ),
      cut(
        "경보가 붙어 있나 ⚠️",
        "🔥쏠림·⏳늦음이 붙은 종목의 편입 직후 성적 — ⚠️ 경보는 **마지막 잰 날** 기준입니다. 편입일 경보가 아니므로 「경보 있으면 안 산다」가 맞는지는 이 칸으로 답할 수 없습니다",
        entries,
        (e) => {
          if (!e.alerts) return null;
          const hot = e.alerts.hot?.length ?? 0;
          const late = e.alerts.late?.length ?? 0;
          if (hot === 0 && late === 0) return "경보 없음";
          if (hot > 0 && late > 0) return "둘 다";
          return hot > 0 ? "🔥쏠림" : "⏳늦음";
        },
        ["경보 없음", "🔥쏠림", "⏳늦음", "둘 다"],
        ex,
      ),
      cut(
        "목록별",
        "어느 갈래로 걸린 것이 좋았나 — 신호등 분석 표와 같은 값(견주는 자리)",
        entries,
        (e) => e.list || null,
        null,
        ex,
      ),
    ],
  };
}

/**
 * 슈퍼신호등 원장 성적표 — **같은 자로 잰다.**
 *
 * 슈퍼는 건수가 적다(수십 건). 그래서 이 표의 쓸모는 「숫자를 믿는 것」이 아니라
 * **신호등 원장과 나란히 놓고 교집합이 값어치가 있었나**를 보는 것이다.
 * 건수가 적다는 사실 자체가 화면에 보여야 해서 n 을 같이 낸다.
 */
export async function superScoreCard(): Promise<ScoreCard> {
  const entries = await superEntries();
  const ex = (e: { returns?: { d5: number | null; d20: number | null } }) => ({
    d5: e.returns?.d5,
    d20: e.returns?.d20,
  });
  const graded = entries.filter((e) => typeof e.returns?.d20 === "number").length;
  const graded5 = entries.filter((e) => typeof e.returns?.d5 === "number").length;
  return {
    builtAt: new Date().toISOString(),
    source: "super",
    lastRunDate: null,
    total: entries.length,
    graded,
    graded5,
    byHash: [],
    /*
     * ⚠️ 슈퍼의 `returns` 는 **지수 대비가 아니라 편입가 대비**다. 신호등 원장의
     * 칸(지수 대비)과 **뜻이 다르다** — 나란히 놓고 숫자를 직접 견주면 안 된다.
     * 화면이 속지 않게 경고로 못 박는다.
     */
    warn:
      entries.length === 0
        ? "슈퍼신호등 원장이 비어 있습니다."
        : "슈퍼 쪽 값은 편입가 대비입니다(지수 대비가 아닙니다) — 위 표와 숫자를 직접 견주지 마세요.",
    cuts: [
      cut("점수대별", "교집합 안에서도 점수가 갈렸나", entries, (e) => band(e.score), BANDS, ex),
      cut(
        "며칠째 걸렸나",
        "교집합이 이어진 것이 더 나았나",
        entries,
        (e) =>
          typeof e.seenCount !== "number"
            ? null
            : e.seenCount <= 1
              ? "첫날"
              : e.seenCount <= 4
                ? "2~4일째"
                : "5일째+",
        ["첫날", "2~4일째", "5일째+"],
        ex,
      ),
    ],
  };
}
