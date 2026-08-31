import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { KiwoomClient } from "./kiwoomClient.js";
import { peekSnapshot } from "./marketSnapshot.js";
import { alCode } from "./alCode.js";
import { evaluateSignal } from "./signalLight.js";
import { groupOf, type EtfGroup } from "./cisPension.js";
import { isSafeAsset } from "./cisAccounts.js";

/**
 * ETF 구성종목 분석 — **담은 것을 보고 판단한다.**
 *
 * ## 왜 이 방법이 따로 있나 (2026-08-31)
 *
 * 벤티지: "각 ETF가 담고있는 종목의 신호등 평균으로 봐도 되지 않을까? 우린 이미
 * 데이터가 있잖아." 그리고 "하나의 방법론이니깐 개별 분석 메뉴로 두던지 해서
 * 비교분석 해보면 더 좋겠지."
 *
 * 맞는 말이다. `etfAnalysis.ts` 는 **이름**으로 테마를 잇는데, 그건 근사다 —
 * 「TIGER 코리아AI전력기기TOP3」가 「의료/정밀기기」에 이어지는 사고가 실제로 났다
 * (두 글자 「기기」가 같아서). 반면 **담은 종목을 직접 보는 것은 근사가 아니다.**
 *
 * 둘을 나란히 두고 어느 쪽이 맞는지 지켜보는 것이 이 파일이 따로 있는 이유다.
 * 한쪽을 지우지 않는다 — 지우면 비교가 끝난다.
 *
 * ## 구성종목을 어디서 얻나
 *
 * 키움 ETF 묶음(ka40001~40010)에는 구성종목이 없다. 대신 `etfHolders.ts` 가
 * 「종목 → 그 종목을 담은 ETF」 역인덱스를 이미 만들어 파일에 두고 있으므로,
 * 그것을 **뒤집으면** 「ETF → 구성종목」이 나온다. **조회 0회**다.
 *
 * ⚠️ **Top10 뿐이다.** 네이버가 그만큼만 준다. 그래서 이 분석은 「ETF 전체」가
 * 아니라 「그 ETF 의 상위 비중 종목들」에 대한 판단이다 — 대체로 그것이 ETF 의
 * 성격을 결정하지만, 광범위 지수 ETF(KODEX 200)에서는 Top10 이 30% 남짓이라
 * 대표성이 떨어진다. 그 사실을 `coverage` 로 같이 내보내 화면이 말하게 한다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const FILE = join(here, "..", "data", "etfHolders.json");

type Row = Record<string, unknown>;
const STKINFO = "/api/dostk/stkinfo";

function toNum(v: unknown): number {
  const n = Number(String(v ?? "").replace(/[+,%\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/**
 * 구성종목의 이름과 등락률을 받는다.
 *
 * ⚠️ 시황 스냅샷(`peekSnapshot`)을 먼저 보되 **그것에 기대지 않는다.** 스냅샷은
 * 업종별 조회 수십 번으로 만드는 무거운 것이라 아직 없을 때가 많고, 실측에서
 * 실제로 비어 있어 등락률이 전부 null 로 나왔다.
 *
 * ka10095 는 한 번에 여러 종목을 주므로 **유니크 종목만 모아** 50개씩 끊어 받는다.
 * 103개 ETF 의 Top10 은 1,030칸이지만 유니크는 그 몇 분의 일이라 몇 번이면 된다.
 */
async function quotesOf(
  client: KiwoomClient,
  codes: string[],
): Promise<Map<string, { name: string; changeRate: number }>> {
  const out = new Map<string, { name: string; changeRate: number }>();
  const uniq = [...new Set(codes)].filter(Boolean);
  for (let i = 0; i < uniq.length; i += 50) {
    const part = uniq.slice(i, i + 50);
    try {
      const { data } = await client.request<Row>(STKINFO, "ka10095", {
        stk_cd: part.map((c) => alCode(c)).join("|"),
      });
      const rows = Array.isArray(data.atn_stk_infr) ? (data.atn_stk_infr as Row[]) : [];
      for (const q of rows) {
        const code = String(q.stk_cd ?? "").replace(/_(AL|NX)$/i, "");
        if (!code) continue;
        out.set(code, { name: String(q.stk_nm ?? code), changeRate: toNum(q.flu_rt) });
      }
    } catch {
      /* 이 묶음만 없는 채로 간다 — 하나 실패했다고 전체를 접지 않는다 */
    }
  }
  return out;
}

interface HolderRow {
  code: string;
  name: string;
  weight?: number | null;
  aumRaw?: number;
  changeRate?: number;
  index?: string;
}

export interface HoldingStock {
  code: string;
  name: string;
  /** 이 ETF 안에서의 비중(%) — 없으면 균등으로 친다 */
  weight: number | null;
  changeRate: number | null;
  sector: string | null;
  /** 신호등 — 무거워서 **부르면 그때만** 잰다 */
  signal?: { level: string; score: number } | null;
}

export interface EtfHoldingScore {
  code: string;
  name: string;
  group: EtfGroup;
  safe: boolean;
  aumRaw: number;
  /** 잡힌 구성종목 (Top10 안) */
  holdings: HoldingStock[];
  /** 비중 합(%) — Top10 만이라 100 이 안 된다. 대표성의 척도다 */
  coverage: number;
  /** 구성종목 등락률의 **비중 가중평균** */
  weighted: number | null;
  /** 오른 종목 비율(%) — 몇몇이 끌었나, 고르게 올랐나 */
  breadth: number | null;
  /** 신호등 평균 (0~100). 안 쟀으면 null */
  signalAvg: number | null;
  /** 초록 몇 개 / 빨강 몇 개 */
  green: number;
  red: number;
  score: number;
  why: string;
}

export interface HoldingsAnalysis {
  at: string;
  builtAt: string | null;
  rows: EtfHoldingScore[];
  /** 순위에서 뺀 것 — 안전자산이거나 Top10 이 너무 적게 덮는 ETF */
  aside: EtfHoldingScore[];
  scanned: number;
  withSignal: boolean;
  note: string;
}

/**
 * 역인덱스를 뒤집는다 — `종목 → [ETF]` 에서 `ETF → [종목]` 으로.
 *
 * 파일이 없으면 빈 결과다. 만드는 것은 ETF 화면의 「인덱스 다시 만들기」가 한다
 * (150곳을 훑어 40초쯤 걸리므로 여기서 자동으로 만들지 않는다).
 */
async function invert(): Promise<{
  byEtf: Map<string, { name: string; aumRaw: number; stocks: { code: string; weight: number | null }[] }>;
  builtAt: string | null;
}> {
  const byEtf = new Map<
    string,
    { name: string; aumRaw: number; stocks: { code: string; weight: number | null }[] }
  >();
  let builtAt: string | null = null;
  try {
    const j = JSON.parse(await readFile(FILE, "utf8")) as {
      builtAt?: string;
      byStock?: Record<string, HolderRow[]>;
    };
    builtAt = j.builtAt ?? null;
    for (const [stock, etfs] of Object.entries(j.byStock ?? {})) {
      for (const e of etfs) {
        const cur = byEtf.get(e.code) ?? { name: e.name, aumRaw: e.aumRaw ?? 0, stocks: [] };
        cur.stocks.push({ code: stock, weight: e.weight ?? null });
        byEtf.set(e.code, cur);
      }
    }
  } catch {
    /* 인덱스가 아직 없다 — 화면이 「만들어 주세요」라고 말한다 */
  }
  return { byEtf, builtAt };
}

/**
 * @param withSignal 신호등까지 잴까. **무겁다** — 유니크 종목마다 한 번씩 부른다.
 *                   기본은 끄고, 화면에서 눌렀을 때만 켠다.
 */
export async function analyzeHoldings(
  client: KiwoomClient,
  opts: { withSignal?: boolean; limit?: number } = {},
): Promise<HoldingsAnalysis> {
  const limit = Math.min(Math.max(opts.limit ?? 40, 5), 150);
  const withSignal = opts.withSignal === true;
  const { byEtf, builtAt } = await invert();
  const snap = peekSnapshot();

  /* 순자산이 큰 것부터 — 오래 들고 갈 자리라 규모가 성과보다 먼저다 */
  const picked = [...byEtf.entries()]
    .sort((a, b) => b[1].aumRaw - a[1].aumRaw)
    .slice(0, limit);

  /* 구성종목 시세를 **유니크로 모아** 한 번에 받는다 */
  const needQuote = new Set<string>();
  for (const [, v] of picked) for (const st of v.stocks) needQuote.add(st.code);
  const quotes = await quotesOf(client, [...needQuote]);

  /*
   * 신호등을 잴 종목을 먼저 모은다 — **유니크로 모아야** 같은 종목을 여러 번
   * 안 부른다. 150개 ETF 의 Top10 은 1,500칸이지만 유니크는 그 몇 분의 일이다.
   */
  const signalOf = new Map<string, { level: string; score: number } | null>();
  if (withSignal) {
    const need = new Set<string>();
    for (const [, v] of picked) for (const s of v.stocks) need.add(s.code);
    for (const code of need) {
      try {
        const r = await evaluateSignal(client, code);
        signalOf.set(code, { level: r.level, score: r.score });
      } catch {
        signalOf.set(code, null);
      }
    }
  }

  const rows: EtfHoldingScore[] = [];
  for (const [code, v] of picked) {
    const holdings: HoldingStock[] = v.stocks.map((s) => {
      const info = snap?.byCode.get(s.code) ?? null;
      const q = quotes.get(s.code) ?? null;
      return {
        code: s.code,
        /* 이름은 시세가 먼저 — 스냅샷은 비어 있을 때가 많다 */
        name: q?.name ?? info?.name ?? s.code,
        weight: s.weight,
        changeRate: q ? q.changeRate : info ? info.changeRate : null,
        sector: info?.sector ?? null,
        signal: withSignal ? signalOf.get(s.code) ?? null : undefined,
      };
    });

    const coverage = holdings.reduce((sum, h) => sum + (h.weight ?? 0), 0);
    const rated = holdings.filter((h) => h.changeRate !== null);

    /*
     * **비중 가중평균**이 본체다. 단순평균을 쓰면 비중 1% 짜리와 25% 짜리가
     * 같은 목소리를 내는데, ETF 가 실제로 움직이는 방식은 그게 아니다.
     * 비중을 하나도 못 읽었으면 그때만 균등으로 친다.
     */
    let weighted: number | null = null;
    if (rated.length > 0) {
      const wsum = rated.reduce((s, h) => s + (h.weight ?? 0), 0);
      weighted =
        wsum > 0
          ? rated.reduce((s, h) => s + (h.changeRate as number) * (h.weight ?? 0), 0) / wsum
          : rated.reduce((s, h) => s + (h.changeRate as number), 0) / rated.length;
      weighted = Number(weighted.toFixed(2));
    }

    /* 폭 — 몇몇이 끌었나 고르게 올랐나. 보합은 뺀다(0을 「올랐다」로 세면 안 된다) */
    const moved = rated.filter((h) => h.changeRate !== 0);
    const breadth =
      moved.length > 0
        ? Number(((moved.filter((h) => (h.changeRate as number) > 0).length / moved.length) * 100).toFixed(0))
        : null;

    const sig = holdings.map((h) => h.signal).filter((x): x is { level: string; score: number } => !!x);
    const signalAvg = sig.length > 0 ? Number((sig.reduce((s, x) => s + x.score, 0) / sig.length).toFixed(1)) : null;
    const green = sig.filter((x) => x.level === "green").length;
    const red = sig.filter((x) => x.level === "red").length;

    /*
     * 점수 — 담은 것이 오르고 있나(가중), 고르게 오르나(폭), 신호등이 막지 않나.
     * 신호등을 안 쟀으면 그 축은 0 이다 — **없는 값을 평균으로 메우지 않는다.**
     */
    const score = Number(
      (
        (weighted ?? 0) * 6 +
        ((breadth ?? 50) - 50) * 0.3 +
        (signalAvg !== null ? (signalAvg - 50) * 0.4 : 0) +
        green * 2 -
        red * 3
      ).toFixed(1),
    );

    const bits: string[] = [];
    if (weighted !== null) bits.push(`담은 것 ${weighted > 0 ? "+" : ""}${weighted}%`);
    if (breadth !== null) bits.push(`폭 ${breadth}%`);
    if (signalAvg !== null) bits.push(`신호등 평균 ${signalAvg}점 (초록 ${green}·빨강 ${red})`);
    bits.push(`Top${holdings.length} 비중 ${coverage.toFixed(0)}%`);

    rows.push({
      code,
      name: v.name,
      group: groupOf(v.name),
      safe: isSafeAsset(v.name),
      aumRaw: v.aumRaw,
      holdings: holdings.sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0)),
      coverage: Number(coverage.toFixed(1)),
      weighted,
      breadth,
      signalAvg,
      green,
      red,
      score,
      why: bits.join(" · "),
    });
  }

  /*
   * ⚠️ **안전자산과 대표성 없는 것은 순위에서 뺀다** (2026-08-31 실측).
   *
   *   - 안전자산: 하락장에서 늘 이긴다. 「지금 뭐가 강한가」의 답을 망친다
   *     (`etfAnalysis` 에서도 같은 이유로 갈랐다).
   *   - 비중 20% 미만: Top10 이 그 ETF 의 5분의 1도 못 덮는다는 뜻이다.
   *     실측에서 「Top1 비중 0%」짜리가 1위로 올라왔다 — 한 칸으로 ETF 전체를
   *     판단한 셈이라 그 점수는 아무 뜻이 없다.
   */
  const ranked = rows.filter((r) => !r.safe && r.coverage >= 20);
  const aside = rows.filter((r) => r.safe || r.coverage < 20);
  ranked.sort((a, b) => b.score - a.score);
  aside.sort((a, b) => b.aumRaw - a.aumRaw);

  return {
    at: new Date().toISOString(),
    builtAt,
    rows: ranked,
    aside: aside.slice(0, 12),
    scanned: byEtf.size,
    withSignal,
    note:
      byEtf.size === 0
        ? "구성종목 인덱스가 아직 없습니다. ETF 화면에서 인덱스를 먼저 만들어 주세요(150곳을 훑어 40초쯤 걸립니다)."
        : `인덱스에 ETF ${byEtf.size}종. **Top10 구성종목만** 잡힙니다(네이버가 그만큼만 줍니다) — ` +
          `「비중」이 20% 미만이거나 안전자산인 것은 순위에서 빼 아래에 따로 뒀습니다 — ` +
          `Top10 이 5분의 1도 못 덮으면 그 점수는 뜻이 없습니다. ` +
          (withSignal ? "신호등은 구성종목마다 재서 평균했습니다." : "신호등은 아직 안 쟀습니다 — 무거워서 눌러야 잽니다."),
  };
}
