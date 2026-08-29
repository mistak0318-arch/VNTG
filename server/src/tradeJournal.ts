import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { KiwoomClient } from "./kiwoomClient.js";
import { evaluateMarket } from "./marketSignal.js";
import { peekSnapshot } from "./marketSnapshot.js";
import { listThemes } from "./customThemes.js";
import { evaluateSignal } from "./signalLight.js";
import { investorDailySeries } from "./superSignal.js";
import { futuresFlow, type FuturesFlowDay } from "./naverFuturesFlow.js";

/**
 * 복기 노트 — 하루를 적고, 쌓아서 나를 고친다.
 *
 * 매매일지를 자유 서술로만 두면 **다시 안 읽는 일기**가 된다. 그러면 반성은 남고
 * 개선은 안 남는다. 그래서 두 가지를 지킨다.
 *
 *  1) **나중에 셀 수 있게 적는다.** 실수와 감정을 태그로 고르게 해서, 몇 달 뒤에
 *     "내가 제일 자주 하는 실수"와 "어떤 상태일 때 성적이 나빴나"를 숫자로 낸다.
 *     자유 서술은 그 옆에 붙는 것이지 본체가 아니다.
 *
 *  2) **결과와 과정을 갈라 적는다.** 벌었는지가 아니라 *내 규칙대로 했는지*를 따로 묻는다.
 *     규칙을 어겼는데 번 날이 제일 위험하다 — 그날 배운 게 다음에 크게 잃게 만든다.
 *
 * 그날의 시장·테마·거래는 **자동으로 채운다.** 손으로 적게 하면 안 적는다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "data");
const FILE = join(DATA_DIR, "journal.json");

/**
 * 실수 태그.
 *
 * 목록을 주는 이유는 **자유 입력이면 매번 다르게 적혀서 못 세기** 때문이다.
 * "뇌동매매"와 "충동적으로 삼"을 같은 것으로 묶을 방법이 없다.
 */
export const MISTAKE_TAGS = [
  { key: "chase", label: "추격매수", hint: "이미 오른 걸 못 참고 따라 샀다" },
  { key: "noCut", label: "손절 미이행", hint: "정한 선을 넘었는데 안 팔았다" },
  { key: "impulse", label: "뇌동매매", hint: "계획에 없던 종목을 즉흥적으로" },
  { key: "oversize", label: "과다 비중", hint: "한 종목에 너무 크게 걸었다" },
  { key: "noThesis", label: "근거 없이 매수", hint: "왜 사는지 한 줄로 못 쓰겠는 걸 샀다" },
  { key: "newsOnly", label: "뉴스만 보고", hint: "수급·차트 확인 없이 재료만 보고" },
  { key: "earlyExit", label: "조급한 익절", hint: "목표 전에 무서워서 팔았다" },
  { key: "revenge", label: "복수매매", hint: "잃은 걸 만회하려고 바로 다시" },
  { key: "againstMarket", label: "시장 역행", hint: "시장 신호등이 빨간데 크게 샀다" },
  { key: "overtrade", label: "과매매", hint: "할 게 없는 날인데 계속 사고팔았다" },
] as const;

/**
 * **왜 샀나** — 근거 태그.
 *
 * 「왜 샀나」는 이미 자유 서술로 적고 있었다. 그런데 자유 서술은 **못 센다.**
 * "거래원이 붙어서"와 "창구가 계속 담아서"를 같은 것으로 묶을 방법이 없다.
 * 실수 태그를 목록으로 준 이유와 똑같다.
 *
 * 이걸 세면 **내 로직 중 뭐가 맞는지**가 숫자로 나온다 — 이 시스템의 원래 목적이다.
 * 「신호등 보고 산 것」과 「수급 보고 산 것」 중 어느 쪽이 나한테 통하는지는
 * 몇 달 치를 세 봐야 안다. 자유 서술은 그 옆에 남는다.
 *
 * 목록은 **이 화면에서 실제로 볼 수 있는 것**으로 짰다 — 볼 수 없는 근거를 적게 하면
 * 나중에 확인할 방법이 없다.
 */
export const REASON_TAGS = [
  { key: "signal", label: "신호등", hint: "종목 신호등이 초록·점수가 높아서" },
  { key: "broker", label: "거래원", hint: "특정 창구가 계속 담고 있어서" },
  { key: "program", label: "프로그램", hint: "프로그램 순매수가 붙어서" },
  { key: "foreign", label: "외국인·기관", hint: "투자자 수급이 며칠째 들어와서" },
  { key: "strength", label: "체결강도", hint: "매수 체결이 세게 붙어서" },
  { key: "chart", label: "차트 자리", hint: "이평선·매물대 등 자리가 좋아서" },
  { key: "breakout", label: "돌파", hint: "전고점·박스권을 뚫어서" },
  { key: "theme", label: "테마·업종", hint: "속한 테마가 도는 중이라" },
  { key: "news", label: "뉴스·공시", hint: "재료가 나와서" },
  { key: "earnings", label: "실적", hint: "실적·재무를 보고" },
  { key: "closeBet", label: "종가배팅", hint: "장 마감 무렵 다음 날을 보고" },
  { key: "hunch", label: "감", hint: "근거를 대기 어렵다 — 이것도 세어 둔다" },
] as const;

/**
 * **관망한 이유** — 안 사는 것도 판단이다.
 *
 * 노트가 매매를 전제로 짜여 있었다. 그런데 시장이 어지러울 때는 **하루 종일 안 사는 날이
 * 더 많고**, 그 판단이야말로 성적을 가장 크게 가른다 — 빨간 날 안 산 것이 초록 날 잘 산
 * 것보다 계좌에 더 남는다.
 *
 * 그런데 안 산 날은 기록이 없으니 나중에 셀 수가 없다. **쉰 날도 적어야** 「위험할 때
 * 쉬었나」에 답할 수 있다.
 *
 * 채점은 새 데이터 없이 된다 — 그날 시장 신호등이 이미 박제되므로, **쉰 날의 국면**과
 * **산 날의 국면**을 견주면 내가 위험을 피해 쉬는지 그냥 겁이 나서 쉬는지가 갈린다.
 */
export const WATCH_TAGS = [
  { key: "marketRed", label: "시장이 위험", hint: "신호등이 빨강·노랑이라 쉬었다" },
  { key: "noSetup", label: "자리가 없음", hint: "볼 만한 종목이 없었다" },
  { key: "choppy", label: "혼조·방향 없음", hint: "위아래로 흔들려서 붙을 자리가 아니었다" },
  { key: "waiting", label: "기다리는 중", hint: "봐 둔 종목이 아직 자리에 안 왔다" },
  { key: "afterLoss", label: "손실 직후", hint: "잃은 뒤라 일부러 쉬었다" },
  { key: "noCash", label: "자금 없음", hint: "현금이 없거나 이미 다 물려 있다" },
  { key: "offDay", label: "컨디션·일정", hint: "볼 수 있는 상태가 아니었다" },
  { key: "rule", label: "내 규칙", hint: "매매하지 않기로 정한 조건에 걸렸다" },
] as const;

/** 그날의 상태. 성적과 엮으면 "어떤 상태일 때 지는가"가 나온다 */
export const MOOD_TAGS = [
  { key: "calm", label: "평온" },
  { key: "confident", label: "자신감" },
  { key: "greedy", label: "조급·욕심" },
  { key: "fearful", label: "불안·공포" },
  { key: "bored", label: "지루함" },
  { key: "tilted", label: "흔들림" },
] as const;

/** 자동으로 채워 넣는 그날의 맥락 — 손으로 적게 하면 안 적는다 */
export interface DayContext {
  /** 시장 신호등 */
  marketLevel: string;
  marketScore: number;
  marketSummary: string;
  /** 그날 시장 폭 / 지수 추세 — 문장 그대로 */
  breadth: string | null;
  trend: string | null;
  /**
   * 국내 선물 수급 (2026-08-27) — **순매수 계약**.
   *
   * 외국인 선물이 시장을 이끄는 날이 많다. 「선물을 이만큼 산 날의 다음날 예측이
   * 실제로 맞았나」를 나중에 세려면 그날 값이 박제돼 있어야 한다 —
   * 되짚어 부를 수는 있지만, 예측할 때 내가 본 값이 그대로 남는 게 복기에 맞다.
   */
  futures?: { foreign: number; institution: number; individual: number } | null;
  /** 그날 내 테마 상위·하위 */
  topThemes: { name: string; changeRate: number }[];
  bottomThemes: { name: string; changeRate: number }[];
}

/**
 * 그날의 매매 한 건 — **직접 적는다.**
 *
 * 처음엔 모의투자에서 끌어왔는데 그건 틀렸다. 모의투자는 시나리오를 짜 보는 자리고,
 * 실제 매매는 증권사 계좌에서 일어난다. 복기해야 하는 건 후자다.
 *
 * 종목을 코드까지 골라 주면 **그 순간의 신호등을 함께 박제한다** — 이게 이 HTS 를
 * 쓰는 이유다. "왜 샀나"를 사람이 적고, "그때 지표가 뭐였나"는 기계가 적는다.
 */
export interface JournalTrade {
  id: string;
  kind: "buy" | "sell";
  code: string;
  name: string;
  price: number;
  qty: number;
  /** 왜 샀나 / 왜 팔았나 */
  note: string;
  /**
   * 근거 태그 — **셀 수 있게 적는 자리.**
   * 자유 서술(`note`)은 그대로 두고, 나중에 집계할 수 있는 형태를 같이 받는다.
   */
  reasons?: string[];
  /** 기록 시점의 신호등 (코드를 골랐을 때만) */
  level?: string;
  score?: number;
  passed?: string[];
  /** 기록 시점의 당일 외인·기관 순매수 (백만원) — 「누가 사고 있을 때 샀나」 (2026-08-27) */
  flow?: { foreign: number; inst: number };

  /*
   * ── 포지션 노트 — **살 때만 적는 세 칸**
   *
   * 이 노트는 「무엇을 볼까」까지는 잘 적어 왔는데 **「얼마나 잃을 각오인가」를 적을
   * 자리가 없었다.** 어긴 규칙 칸에 「손절 미이행」이라는 태그만 있었다 — 손절선을
   * **미리** 적어 두는 자리가 없으니 지켰는지 어겼는지도 사실은 기억에 기대는 것이다.
   *
   * 추세추종의 핵심은 진입이 아니라 손실 관리다. 세 칸이면 R 배수까지 따라 나온다.
   *
   *   R = (목표가 − 진입가) ÷ (진입가 − 손절가)
   *
   * 그리고 판 뒤에는 **실현 R** 이 나온다 — 승률보다 이게 진짜 성적이다.
   * 승률 70% 인데 평균 −0.3R 이면 지는 매매다.
   */
  /** 손절선(원). 이 아래로 가면 판다 */
  stop?: number;
  /** 목표가(원) */
  target?: number;
  /** 이 매매에 건 위험 — **계좌 대비 %** */
  risk?: number;
}

/**
 * 예측 종목 (2026-08-27) — **내일 이게 오를까 내릴까.**
 *
 * 매매와 다르다. 매매는 돈이 걸린 결정이고, 예측은 **판단만 걸린 것**이다.
 * 사지 않아도 예측은 할 수 있고, 그 적중률이 쌓이면 「내 판단이 실제로 맞는가」에
 * 답이 나온다 — 매매 성적은 크기·타이밍이 섞여 있어서 판단력만 따로 못 잰다.
 *
 * 예측한 날의 종가를 기준가로 박제하고, **다음 거래일 종가**로 채점한다.
 * 채점은 조회할 때 아직 결과가 없는 것만 일봉으로 채운다(신호등 박제와 같은 문법).
 */
export interface JournalPick {
  id: string;
  code: string;
  name: string;
  /** 오를 것 / 내릴 것 */
  dir: "up" | "down";
  /** 왜 그렇게 봤나 — 한 줄 */
  note?: string;
  /** 예측한 날의 종가 (저장 때 박제) */
  basePrice?: number;
  /**
   * 예측한 순간의 판 (2026-08-27) — 슈퍼신호등 상세와 같은 문법.
   * 「어떤 시장에서 한 예측이 맞았나」를 나중에 세려면 그때 값이 남아 있어야 한다.
   * 시장은 그날 맥락(context)에서 복사하므로 조회가 안 는다.
   */
  market?: { level: string; score: number };
  /** 예측한 순간의 그 종목 신호등 */
  signal?: { level: string; score: number };
  /** 그날 국내 선물 외국인 순매수(계약) — 「선물을 산 날의 예측이 맞나」 */
  futForeign?: number;
  /** 채점 결과 — 다음 거래일 종가 기준 */
  result?: {
    /** 채점에 쓴 거래일 (YYYYMMDD) */
    date: string;
    close: number;
    /** 기준가 대비 % */
    rate: number;
    /** 방향이 맞았나 */
    hit: boolean;
  };
}

export interface JournalEntry {
  /** YYYY-MM-DD (KST) — 하루에 하나 */
  date: string;
  updatedAt: string;
  /** 오늘의 예측 (2026-08-27) */
  picks?: JournalPick[];

  /**
   * 오늘 매매했나, 쉬었나.
   *
   * `watch` 면 매매 칸 대신 **왜 쉬었나**를 묻는다. 안 적으면 `null` 이고,
   * 그때는 매매 기록이 있으면 매매한 날로 친다.
   */
  stance?: "trade" | "watch" | null;
  /** 쉰 이유 (관망일 때) */
  watchReasons?: string[];

  /** 오늘 무엇을 했나 (짧게) */
  what: string;
  /** 왜 그렇게 했나 — 그때의 판단 */
  why: string;
  /**
   * 내 규칙대로 했나. 결과와 별개로 묻는다.
   * 규칙을 어겼는데 번 날이 제일 위험하다.
   */
  followedRules: boolean | null;
  /** 어긴 규칙이 있으면 무엇을 */
  brokenRule: string;

  /** 그날 실제로 한 매매 */
  trades: JournalTrade[];

  mistakes: string[];
  mood: string;
  /** 오늘 배운 것 한 줄 — 이게 다음 달의 나를 바꾼다 */
  lesson: string;
  /** 내일 할 것 */
  tomorrow: string;

  context: DayContext | null;
}

async function readAll(): Promise<JournalEntry[]> {
  try {
    const parsed = JSON.parse(await readFile(FILE, "utf-8")) as JournalEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeAll(rows: JournalEntry[]): Promise<void> {
  rows.sort((a, b) => a.date.localeCompare(b.date));
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(FILE, JSON.stringify(rows, null, 2), "utf-8");
}

export async function listEntries(limit = 90): Promise<JournalEntry[]> {
  const rows = await readAll();
  return rows.slice(-limit).reverse();
}

/** 마지막 종가 — 스냅샷이 비었을 때 기준가를 메우는 데만 쓴다 (조회 1회) */
async function lastClose(client: KiwoomClient, code: string): Promise<number | null> {
  const { data } = await client.request<Record<string, unknown>>("/api/dostk/chart", "ka10081", {
    stk_cd: code,
    base_dt: kstDate().replace(/-/g, ""),
    upd_stkpc_tp: "1",
  });
  const rows = (data?.stk_dt_pole_chart_qry ?? []) as Record<string, unknown>[];
  const v = Math.abs(Number(String(rows[0]?.cur_prc ?? "").replace(/[+,\s]/g, "")) || 0);
  return v > 0 ? v : null;
}

/**
 * 예측 채점 (2026-08-27) — **결과가 아직 없는 것만** 다음 거래일 종가로 매긴다.
 *
 * 조회할 때 돌린다. 이미 매긴 것은 건드리지 않으므로 종목당 일봉 한 번이고,
 * 채점할 게 없으면 조회가 0회다. 오늘 것은 아직 다음 거래일이 없어 그냥 넘어간다.
 * 실패는 삼킨다 — 채점이 안 됐다고 노트가 안 열리면 안 된다.
 */
async function gradePicks(client: KiwoomClient): Promise<boolean> {
  const rows = await readAll();
  const today = kstDate();
  /*
   * 채점할 것: 결과 없음 + 예측일이 오늘보다 이전.
   *
   * ⚠️ 예전엔 **기준가가 있는 것만** 골랐다(`p.basePrice > 0`). 그런데 기준가는
   * 저장 순간의 전종목 스냅샷에서 가져오는데, 서버를 막 켰거나 장 밖이면 그게
   * 비어 있다 — 그때 넣은 예측은 기준가 없이 저장되고 **영원히 「채점 대기」**로
   * 남았다. 며칠이 지나도 안 매겨지던 것이 이것이다.
   * 이제 기준가가 없으면 **예측한 날의 종가를 일봉에서 찾아** 쓴다. 어차피
   * 일봉을 받고 있으므로 조회가 늘지도 않는다.
   *
   * ⚠️ 코드 정규식도 넓혔다 — ETF·신주인수권에는 `0182R0` 처럼 영문이 섞인
   * 여섯 자리가 있는데, 숫자만 받으면 그것들도 영영 채점이 안 됐다.
   */
  const todo = rows.flatMap((e) =>
    (e.picks ?? [])
      .filter((p) => !p.result && e.date < today && /^[0-9A-Z]{6}$/i.test(p.code))
      .map((p) => ({ entryDate: e.date, pick: p })),
  );
  if (todo.length === 0) return false;

  let changed = false;
  /* 같은 종목을 여러 날 예측했을 수 있다 — 일봉은 종목당 한 번만 */
  const byCode = new Map<string, typeof todo>();
  for (const t of todo) byCode.set(t.pick.code, [...(byCode.get(t.pick.code) ?? []), t]);

  for (const [code, items] of byCode) {
    try {
      const { data } = await client.request<Record<string, unknown>>(
        "/api/dostk/chart",
        "ka10081",
        { stk_cd: code, base_dt: today.replace(/-/g, ""), upd_stkpc_tp: "1" },
      );
      const bars = ((data?.stk_dt_pole_chart_qry ?? []) as Record<string, unknown>[])
        .map((r) => ({
          dt: String(r.dt ?? ""),
          close: Math.abs(Number(String(r.cur_prc ?? "").replace(/[+,\s]/g, "")) || 0),
        }))
        .filter((b) => /^\d{8}$/.test(b.dt) && b.close > 0)
        .sort((a, b) => a.dt.localeCompare(b.dt));
      if (bars.length === 0) continue;

      for (const it of items) {
        const ymd = it.entryDate.replace(/-/g, "");
        // 예측한 날 **다음** 거래일 — 그날 봉이 없으면(휴장·미래) 채점하지 않는다
        const next = bars.find((b) => b.dt > ymd);
        if (!next) continue;
        /*
         * 기준가 — 박제된 값이 우선이다(예측한 그 순간의 값). 없으면 예측한 날의
         * 종가로 대신한다. 그날 봉조차 없으면(장 열기 전에 넣은 예측 등) 바로
         * 앞 거래일 종가를 쓴다 — 「예측 직전에 보던 값」이 그것이다.
         */
        let base = it.pick.basePrice ?? 0;
        if (!(base > 0)) {
          const sameDay = bars.find((b) => b.dt === ymd);
          const before = [...bars].reverse().find((b) => b.dt < ymd);
          base = sameDay?.close ?? before?.close ?? 0;
          if (base > 0) it.pick.basePrice = base; // 다음부터는 다시 안 찾게 박아 둔다
        }
        if (!(base > 0)) continue; // 그래도 못 구하면 다음 기회에
        const rate = ((next.close - base) / base) * 100;
        it.pick.result = {
          date: next.dt,
          close: next.close,
          rate: Math.round(rate * 100) / 100,
          hit: it.pick.dir === "up" ? rate > 0 : rate < 0,
        };
        changed = true;
      }
    } catch {
      /* 이 종목만 다음 기회에 */
    }
  }
  if (changed) await writeAll(rows);
  return changed;
}

/** 화면이 부르는 목록 — 열 때마다 밀린 예측을 채점하고 준다 */
export async function listEntriesGraded(client: KiwoomClient, limit = 90): Promise<JournalEntry[]> {
  await gradePicks(client).catch(() => false);
  return listEntries(limit);
}

function kstDate(d = new Date()): string {
  return new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}

/**
 * 그날의 맥락을 모은다.
 *
 * 시장 신호등·테마·거래는 이미 우리가 들고 있는 것이다. 사용자가 다시 적을 이유가 없고,
 * 무엇보다 **손으로 적으면 기억으로 적게 된다** — 그러면 복기의 근거가 흔들린다.
 */
export async function captureContext(client: KiwoomClient, date: string): Promise<DayContext | null> {
  const [market, themes, futDays] = await Promise.all([
    evaluateMarket(client).catch(() => null),
    listThemes().catch(() => []),
    /* 선물 수급 — 네이버 캐시(10분)라 조회 부담이 없다. 최근 하루만 쓴다 */
    futuresFlow(3).catch(() => [] as FuturesFlowDay[]),
  ]);
  const snap = peekSnapshot();
  const fut = futDays.length > 0 ? futDays[futDays.length - 1] : null;

  const rated = themes
    .map((t) => {
      const rates = t.codes
        .map((c) => snap?.byCode.get(c)?.changeRate)
        .filter((x): x is number => typeof x === "number");
      return {
        name: t.name,
        changeRate: rates.length > 0 ? rates.reduce((a, b) => a + b, 0) / rates.length : null,
      };
    })
    .filter((t): t is { name: string; changeRate: number } => t.changeRate !== null)
    .sort((a, b) => b.changeRate - a.changeRate);


  return {
    marketLevel: market?.level ?? "unknown",
    marketScore: market?.score ?? 0,
    marketSummary: market?.summary ?? "",
    // 시장 폭 한 줄 — "지수는 올랐는데 내 종목은 죽은 날"이 복기에서 제일 중요하다
    breadth: market?.checks.find((c) => c.key === "breadth")?.value ?? null,
    trend: market?.checks.find((c) => c.key === "trend")?.value ?? null,
    futures: fut
      ? { foreign: fut.foreign, institution: fut.institution, individual: fut.individual }
      : null,
    topThemes: rated.slice(0, 3),
    bottomThemes: rated.slice(-3).reverse(),
  };
}

/**
 * 새로 들어온 매매에만 신호등을 붙인다.
 *
 * 이미 붙어 있는 건 그대로 둔다 — 사흘 뒤에 노트를 고치면서 신호등이 오늘 값으로
 * 덮이면, 그건 매수 시점의 근거가 아니라 오늘의 값이 된다.
 */
async function withSignals(
  client: KiwoomClient,
  next: JournalTrade[],
  prev: JournalTrade[],
): Promise<JournalTrade[]> {
  const before = new Map(prev.map((t) => [t.id, t]));
  return Promise.all(
    next.map(async (t) => {
      const old = before.get(t.id);
      if (old?.level) {
        return { ...t, level: old.level, score: old.score, passed: old.passed, flow: old.flow };
      }
      if (!/^\d{6}$/.test(t.code)) return t;
      /* 신호등과 함께 그날 수급도 박제한다 (2026-08-27) — 「누가 사고 있을 때 샀나」.
         복기 때 제일 먼저 묻게 되는 것인데 손으로 찾아 적게 하면 안 적는다. */
      const [sig, flows] = await Promise.all([
        evaluateSignal(client, t.code).catch(() => null),
        investorDailySeries(client, t.code).catch(
          () => [] as { date: string; foreign: number; inst: number }[],
        ),
      ]);
      const lastFlow = flows[flows.length - 1];
      const flow = lastFlow ? { foreign: lastFlow.foreign, inst: lastFlow.inst } : undefined;
      if (!sig) return { ...t, flow };
      return {
        ...t,
        level: sig.level,
        score: sig.score,
        passed: sig.checks.filter((c) => c.pass === true).map((c) => c.label),
        flow,
      };
    }),
  );
}

export async function saveEntry(
  client: KiwoomClient,
  input: Partial<JournalEntry> & { date?: string },
): Promise<JournalEntry[]> {
  const date = input.date && /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? input.date : kstDate();
  const rows = await readAll();
  const prev = rows.find((r) => r.date === date);

  /*
   * 맥락은 **처음 적을 때 한 번만** 잡는다. 며칠 뒤에 노트를 고치면서 오늘 시장이
   * 덮여 버리면, 그날을 복기하는 게 아니라 오늘을 적는 게 된다.
   */
  /*
   * 시장 맥락은 처음 적을 때 한 번만 잡는다 — 며칠 뒤 노트를 고치면서 오늘 시장이
   * 덮이면 그날을 복기하는 게 아니라 오늘을 적는 게 된다.
   *
   * 다만 **매매 내역은 매번 다시 잡는다.** 아침에 노트를 쓰고 오후에 사고파는 게
   * 보통이라, 처음 저장 때 고정하면 그날 매매가 영영 안 들어온다.
   */
  const context = prev?.context ?? (await captureContext(client, date).catch(() => null));

  const entry: JournalEntry = {
    date,
    updatedAt: new Date().toISOString(),
    /*
     * ⚠️ 2026-08-25 — **여기 빠져 있었다.** 관망 기능을 넣으면서 인터페이스와
     * 통계(watch 집계)는 만들었는데 정작 저장 조립에서 이 두 줄이 빠져, 「관망 +
     * 사유」를 적고 저장을 눌러도 **소리 없이 버려졌다.** 화면은 저장 직후엔 제
     * 상태를 그대로 보여 주니 알 길이 없었고, 날짜를 옮겼다 돌아와서야 드러났다.
     */
    stance: input.stance ?? prev?.stance ?? null,
    watchReasons: (input.watchReasons ?? prev?.watchReasons ?? []).slice(0, 12),
    what: (input.what ?? prev?.what ?? "").slice(0, 1000),
    why: (input.why ?? prev?.why ?? "").slice(0, 1000),
    followedRules: input.followedRules ?? prev?.followedRules ?? null,
    brokenRule: (input.brokenRule ?? prev?.brokenRule ?? "").slice(0, 300),
    trades: await withSignals(client, input.trades ?? prev?.trades ?? [], prev?.trades ?? []),
    mistakes: input.mistakes ?? prev?.mistakes ?? [],
    mood: input.mood ?? prev?.mood ?? "",
    lesson: (input.lesson ?? prev?.lesson ?? "").slice(0, 500),
    tomorrow: (input.tomorrow ?? prev?.tomorrow ?? "").slice(0, 500),
    picks: await withPickPrices(client, input.picks ?? prev?.picks ?? [], prev?.picks ?? [], context),
    context,
  };

  const next = rows.filter((r) => r.date !== date);
  next.push(entry);
  await writeAll(next);
  return listEntries();
}

/**
 * 예측에 **기준가를 박제**한다 — 그때 얼마였는지가 있어야 채점이 된다.
 *
 * 이미 박힌 것(기준가·결과)은 건드리지 않는다. 사흘 뒤에 노트를 고치면서 기준가가
 * 오늘 값으로 덮이면 그건 그날의 예측이 아니게 된다 — 신호등 박제와 같은 이유다.
 * 시세는 캐시(peekSnapshot)에서만 읽는다: 예측 몇 건 때문에 시장 스캔을 부를 일이 아니다.
 */
async function withPickPrices(
  client: KiwoomClient,
  next: JournalPick[],
  prev: JournalPick[],
  context: DayContext | null,
): Promise<JournalPick[]> {
  const before = new Map(prev.map((p) => [p.id, p]));
  const snap = peekSnapshot();
  return Promise.all(
    next.slice(0, 20).map(async (p) => {
      const old = before.get(p.id);
      // 이미 박힌 예측은 통째로 그대로 — 나중에 고쳐도 그날의 판단이 남는다
      if (old?.basePrice) {
        return {
          ...p,
          basePrice: old.basePrice,
          result: old.result,
          market: old.market,
          signal: old.signal,
        };
      }
      /*
       * 기준가 — 스냅샷(전종목 캐시)에서 읽는다. **비어 있을 수 있다**: 서버를 막
       * 켰거나 장 밖이면 스캔이 아직 안 돌았다. 그때 기준가 없이 저장되면 나중에
       * 채점이 밀리므로(그건 gradePicks 가 일봉으로 메운다) 여기서도 한 번 더
       * 시도한다 — 마지막 종가라도 있으면 그게 「예측 직전에 보던 값」이다.
       */
      let price = snap?.byCode.get(p.code)?.price ?? null;
      if (!(price && price > 0) && /^[0-9A-Z]{6}$/i.test(p.code)) {
        price = await lastClose(client, p.code).catch(() => null);
      }
      /* 종목 신호등은 매매와 같은 문법으로 그 순간 값을 박제한다 */
      const sig = /^\d{6}$/.test(p.code)
        ? await evaluateSignal(client, p.code).catch(() => null)
        : null;
      return {
        ...p,
        basePrice: price && price > 0 ? price : undefined,
        market: context ? { level: context.marketLevel, score: context.marketScore } : undefined,
        signal: sig ? { level: sig.level, score: sig.score } : undefined,
        futForeign: context?.futures?.foreign,
      };
    }),
  );
}

export async function removeEntry(date: string): Promise<JournalEntry[]> {
  await writeAll((await readAll()).filter((r) => r.date !== date));
  return listEntries();
}

// ---------------------------------------------------------------- 트래킹

/**
 * 쌓인 노트에서 나를 읽는다.
 *
 * **이게 노트를 일기와 가르는 지점이다.** 하루치는 반성이지만, 석 달치를 세면
 * 내가 어떤 사람인지가 나온다 — 제일 자주 하는 실수, 어떤 상태일 때 규칙을 어기는지,
 * 규칙을 지킨 날과 어긴 날의 성적 차이.
 */
/** 예측 성적 (2026-08-27) — 「내 판단이 실제로 맞는가」 */
export interface PickStats {
  /** 채점이 끝난 예측 수 */
  graded: number;
  /** 아직 결과를 기다리는 수 */
  pending: number;
  /** 방향 적중률(%) */
  hitRate: number | null;
  /** 예측 방향대로 봤을 때의 평균 수익률(%) — 내림 예측은 부호를 뒤집어 더한다 */
  avgEdge: number | null;
  /** 오를 것 / 내릴 것 각각의 적중률 */
  up: { n: number; hitRate: number | null };
  down: { n: number; hitRate: number | null };
  /**
   * **어떤 시장에서 한 예측이 맞았나** — 이 표가 예측 노트를 쓰는 이유다.
   * 초록장에서만 맞는 사람은 상승장을 읽는 게 아니라 그냥 따라간 것이고,
   * 빨간장에서도 맞으면 그건 진짜 판단이다.
   */
  byMarket: { level: string; n: number; hitRate: number; avgEdge: number }[];
  /**
   * **국내 선물 외국인 수급별** 적중률 (2026-08-27 요청) — 「선물을 산 날의
   * 다음날 예측이 실제로 맞나」. ±2,000계약을 경계로 셋으로 가른다
   * (시장 신호등의 선물 체크와 같은 문턱이라 두 화면이 같은 말을 한다).
   */
  byFutures: { band: "매수" | "중립" | "매도"; n: number; hitRate: number; avgEdge: number }[];
  /** 여러 번 예측한 종목 — 「이 종목은 내가 잘 본다」 (2회 이상, 적중률 순) */
  byStock: { code: string; name: string; n: number; hitRate: number; avgEdge: number }[];
  /**
   * **예측한 순간 그 종목 신호등이 무슨 색이었나별 적중률** (2026-08-29).
   *
   * 값은 진작부터 박제해 두고(`pick.signal`) 한 번도 세지 않았다. 이게 이 앱에서
   * 제일 물어보고 싶은 것에 가깝다 — 「신호등이 초록일 때 내 예측이 실제로 맞나」.
   * 맞으면 신호등을 믿고 걸러도 되고, 색과 무관하면 신호등이 예측에는 안 통하는 것이다.
   */
  bySignal: { level: string; n: number; hitRate: number; avgEdge: number }[];
  /**
   * **나아지고 있나** (2026-08-29) — 최근 10건과 그 이전을 갈라 본다.
   *
   * 누적 적중률 하나만 보면 **훈련이 되고 있는지가 안 보인다.** 석 달 전의 실수가
   * 평균에 계속 섞여 있어서, 요즘 잘 맞아도 숫자가 안 움직인다.
   * 표본이 적을 때는 둘 다 null 이다 — 다섯 건으로 「나아졌다」고 말하면 거짓말이다.
   */
  trend: { recent: number | null; earlier: number | null; recentN: number; earlierN: number };
  /** 최근 채점분 — 화면이 히스토리로 보여 준다 (최신순 30건) */
  recent: {
    date: string;
    code: string;
    name: string;
    dir: "up" | "down";
    rate: number;
    hit: boolean;
    note?: string;
    /** 그날의 판 — 시장 신호등·종목 신호등 */
    market?: { level: string; score: number };
    signal?: { level: string; score: number };
    /** 채점에 쓴 날 (YYYYMMDD) */
    gradedAt: string;
  }[];
}

export interface JournalStats {
  /** 예측 성적 */
  picks: PickStats;
  /** 기록한 날 수 */
  days: number;
  /** 연속 기록 일수 — 습관이 붙었는지 */
  streak: number;
  /** 규칙 준수율(%) */
  ruleRate: number | null;
  /** 실수 태그별 횟수, 잦은 순 */
  mistakes: { key: string; label: string; count: number }[];
  /** 상태별 — 그날 규칙을 지킨 비율까지 같이 본다 */
  moods: { key: string; label: string; count: number; ruleRate: number | null }[];
  /**
   * 규칙을 지킨 날 vs 어긴 날의 그날 매수 종목 성적.
   * "규칙을 어겼는데 번 날"이 보이면 그게 제일 위험한 신호다.
   */
  ruleEdge: {
    keptDays: number;
    keptAvgReturn: number | null;
    brokeDays: number;
    brokeAvgReturn: number | null;
  };
  /**
   * **내 매매는 대체로 몇 R 짜리인가.**
   *
   * 승률·평균 수익률만 보면 「건 것 대비」가 안 보인다. 8% 를 걸고 번 3% 와 1% 를
   * 걸고 번 3% 는 전혀 다른 매매인데 둘 다 「+3%」로 적힌다.
   *
   * ⚠️ **손절선을 적어 둔 매매에서만** 낸다. 안 적은 건 세지 않으므로 `count` 가
   * 전체 매매 수보다 적을 수 있다 — 그 차이 자체가 「내가 손절선을 얼마나 적는가」다.
   */
  rStat: { count: number; avg: number | null; best: number | null; worst: number | null };
  /**
   * **무엇을 보고 산 것이 통했나** — 이 시스템의 원래 목적에 가장 가까운 숫자.
   * 근거가 여럿이면 각각에 다 센다(섞여 있었다는 것 자체가 정보다).
   */
  reasonEdge: EdgeRow[];
  /** 살 때 종목 신호등이 무슨 색이었나별 성적 */
  signalEdge: EdgeRow[];
  /** 그날 시장 국면별 성적 */
  marketEdge: EdgeRow[];
  /**
   * 쉰 날과 산 날의 국면 — **위험할 때 쉬었나.**
   * 쉰 날이 빨강에 몰려 있으면 위험을 피한 것이고, 초록에 몰려 있으면 겁이 난 것이다.
   */
  watch: {
    days: number;
    tradeDays: number;
    /** 쉰 이유 잦은 순 */
    reasons: { key: string; label: string; count: number }[];
    /** 쉰 날의 국면 분포 */
    byMarket: { key: string; count: number }[];
    /** 산 날의 국면 분포 — 견줘 봐야 뜻이 생긴다 */
    tradeByMarket: { key: string; count: number }[];
  };
  /**
   * **판단 vs 실행** (2026-08-29) — 예측은 맞는데 매매는 지고 있나.
   *
   * 두 숫자가 따로 놀면 원인을 못 짚는다. 예측 적중률이 높은데 매매 승률이 낮으면
   * 문제는 **보는 눈이 아니라 손**이다(늦게 들어가거나 일찍 판다). 반대면 방향을
   * 잘못 보는 것이라 고칠 자리가 전혀 다르다.
   * 둘 다 있을 때만 낸다 — 한쪽만으로는 견줄 수가 없다.
   */
  judgeVsAct: { pickHit: number | null; tradeWin: number | null; tradeN: number } | null;
  /** 최근에 적은 배운 것들 — 다시 읽으라고 */
  lessons: { date: string; lesson: string }[];
}

/**
 * **아직 안 판 자리** — 손절 감시가 볼 대상.
 *
 * 노트의 매수·매도를 종목별로 선입선출(FIFO)로 맞추고 **남은 로트**를 돌려준다.
 * 「지금 들고 있는 것」을 따로 적는 자리를 만들지 않은 이유는, **적는 자리가 둘이면
 * 반드시 갈라지기 때문**이다. 노트에 사고판 것만 정직하게 적으면 보유는 계산된다.
 */
export interface OpenPosition {
  code: string;
  name: string;
  /** 산 날 */
  date: string;
  /** 평균 진입가 — 로트가 여럿이면 수량 가중 */
  price: number;
  qty: number;
  /** 적어 둔 손절선. 안 적었으면 `null` — 그 자리는 감시할 수가 없다 */
  stop: number | null;
  target: number | null;
}

export async function openPositions(): Promise<OpenPosition[]> {
  const rows = await readAll();
  interface Lot {
    date: string;
    price: number;
    qty: number;
    stop: number | null;
    target: number | null;
  }
  const lots = new Map<string, { name: string; arr: Lot[] }>();

  for (const r of [...rows].sort((a, b) => a.date.localeCompare(b.date))) {
    for (const t of r.trades ?? []) {
      const key = t.code || t.name;
      if (!key || t.price <= 0 || t.qty <= 0) continue;
      const slot = lots.get(key) ?? { name: t.name || key, arr: [] };
      if (t.name) slot.name = t.name;
      if (t.kind === "buy") {
        slot.arr.push({
          date: r.date,
          price: t.price,
          qty: t.qty,
          // 손절선이 진입가보다 위면 적다 만 것이다 — 감시 대상으로 삼으면 즉시 울린다
          stop: typeof t.stop === "number" && t.stop > 0 && t.stop < t.price ? t.stop : null,
          target: typeof t.target === "number" && t.target > t.price ? t.target : null,
        });
      } else {
        let left = t.qty;
        while (left > 0 && slot.arr.length > 0) {
          const lot = slot.arr[0];
          const take = Math.min(left, lot.qty);
          lot.qty -= take;
          left -= take;
          if (lot.qty <= 0) slot.arr.shift();
        }
      }
      lots.set(key, slot);
    }
  }

  const out: OpenPosition[] = [];
  for (const [code, { name, arr }] of lots) {
    if (arr.length === 0) continue;
    const qty = arr.reduce((a, l) => a + l.qty, 0);
    if (qty <= 0) continue;
    /*
     * 손절선이 로트마다 다를 수 있다. 그때는 **제일 높은 것**을 쓴다 —
     * 가장 먼저 닿는 선이고, 「어느 하나라도 손절 조건이면 알린다」가 맞는 쪽이다.
     */
    const stops = arr.map((l) => l.stop).filter((x): x is number => x !== null);
    const targets = arr.map((l) => l.target).filter((x): x is number => x !== null);
    out.push({
      code,
      name,
      date: arr[0].date,
      price: arr.reduce((a, l) => a + l.price * l.qty, 0) / qty,
      qty,
      stop: stops.length > 0 ? Math.max(...stops) : null,
      target: targets.length > 0 ? Math.min(...targets) : null,
    });
  }
  return out;
}

/** 무엇으로 묶든 성적은 같은 모양으로 낸다 */
export interface EdgeRow {
  key: string;
  label: string;
  /** 판 건수 — 이게 적으면 평균이 우연이다 */
  count: number;
  /** 평균 실현 수익률(%) */
  avgReturn: number;
  /** 이긴 비율(%) */
  winRate: number;
  /**
   * **평균 실현 R** — 손절선을 적어 둔 매매에서만 낸다. 없으면 `null`.
   *
   * 수익률(%)만으로는 성적을 못 잰다. 3% 를 벌었어도 **8% 를 걸고 번 3%** 와
   * **1% 를 걸고 번 3%** 는 전혀 다른 매매다. R 은 그 둘을 갈라 준다.
   *
   *   실현 R = (판 가격 − 산 가격) ÷ (산 가격 − 손절가)
   *
   * 승률 70% 인데 평균 −0.3R 이면 지는 매매다. 그래서 **승률 옆에 꼭 같이 둔다.**
   */
  avgR: number | null;
  /** R 을 낼 수 있었던 건수 — 이게 적으면 avgR 은 아직 우연이다 */
  rCount: number;
}

const MISTAKE_LABEL = new Map(MISTAKE_TAGS.map((t) => [t.key as string, t.label]));
const REASON_LABEL = new Map(REASON_TAGS.map((t) => [t.key as string, t.label]));
const WATCH_LABEL = new Map(WATCH_TAGS.map((t) => [t.key as string, t.label]));

/**
 * 체결 한 건의 성적.
 *
 * `r` 은 **손절선을 적어 둔 매매에서만** 나온다. 안 적었으면 `null` 이고, 그 건은
 * R 평균에서 빠진다 — 없는 것을 0 으로 세면 평균이 통째로 거짓말이 된다.
 */
interface Fill {
  rate: number;
  r: number | null;
}

/** 수익률 묶음 → 성적 한 줄 */
function edge(map: Map<string, Fill[]>, label: (k: string) => string): EdgeRow[] {
  return [...map.entries()]
    .map(([key, xs]) => {
      const rs = xs.map((x) => x.r).filter((x): x is number => x !== null);
      return {
        key,
        label: label(key),
        count: xs.length,
        avgReturn: xs.reduce((a, b) => a + b.rate, 0) / xs.length,
        winRate: (xs.filter((x) => x.rate > 0).length / xs.length) * 100,
        avgR: rs.length > 0 ? rs.reduce((a, b) => a + b, 0) / rs.length : null,
        rCount: rs.length,
      };
    })
    // 건수가 아니라 **성적** 순으로 — 뭐가 통했나를 보는 표다
    .sort((a, b) => b.avgReturn - a.avgReturn);
}
const MOOD_LABEL = new Map(MOOD_TAGS.map((t) => [t.key as string, t.label]));

/**
 * 예측 성적을 센다 — **채점이 끝난 것만.**
 *
 * 아직 결과가 없는 오늘 예측을 승률에 넣으면 승률이 매일 아침 떨어진다.
 * 「맞았나」는 방향이고, 「얼마나」는 예측 방향으로 본 수익률이다 —
 * 내릴 것을 맞히면 −3% 는 +3% 의 값어치다(그래서 부호를 뒤집어 더한다).
 */
function pickStats(rows: JournalEntry[]): PickStats {
  const all = rows.flatMap((e) => (e.picks ?? []).map((p) => ({ date: e.date, p })));
  const done = all.filter((x) => x.p.result);
  const pending = all.length - done.length;
  const rate = (xs: typeof done) =>
    xs.length === 0 ? null : (xs.filter((x) => x.p.result!.hit).length / xs.length) * 100;
  const up = done.filter((x) => x.p.dir === "up");
  const down = done.filter((x) => x.p.dir === "down");
  const edge = (x: (typeof done)[number]) =>
    x.p.dir === "up" ? x.p.result!.rate : -x.p.result!.rate;
  const edges = done.map(edge);

  /** 묶어서 적중률·평균 우위를 낸다 — 시장 상태별·종목별이 같은 모양이라 하나로 */
  const agg = <K extends string>(keyOf: (x: (typeof done)[number]) => K | null) => {
    const m = new Map<K, (typeof done)[number][]>();
    for (const x of done) {
      const k = keyOf(x);
      if (k === null) continue;
      m.set(k, [...(m.get(k) ?? []), x]);
    }
    return [...m.entries()].map(([k, xs]) => ({
      key: k,
      n: xs.length,
      hitRate: (xs.filter((x) => x.p.result!.hit).length / xs.length) * 100,
      avgEdge: xs.reduce((a, b) => a + edge(b), 0) / xs.length,
    }));
  };

  const byMarket = agg((x) => x.p.market?.level ?? null)
    .map((r) => ({ level: r.key, n: r.n, hitRate: r.hitRate, avgEdge: r.avgEdge }))
    /* 초록 → 노랑 → 빨강 차례로 — 화면에서 읽는 순서가 늘 같아야 한다 */
    .sort((a, b) => {
      const rank = (l: string) => (l === "green" ? 0 : l === "yellow" ? 1 : l === "red" ? 2 : 3);
      return rank(a.level) - rank(b.level);
    });

  const byStock = agg((x) => x.p.code)
    .filter((r) => r.n >= 2) // 한 번은 우연이다
    .map((r) => ({
      code: r.key,
      name: done.find((x) => x.p.code === r.key)?.p.name ?? r.key,
      n: r.n,
      hitRate: r.hitRate,
      avgEdge: r.avgEdge,
    }))
    .sort((a, b) => b.hitRate - a.hitRate || b.n - a.n)
    .slice(0, 12);

  const byFutures = agg((x) => {
    const f = x.p.futForeign;
    if (typeof f !== "number") return null;
    return (f >= 2000 ? "매수" : f <= -2000 ? "매도" : "중립") as "매수" | "중립" | "매도";
  })
    .map((r) => ({ band: r.key, n: r.n, hitRate: r.hitRate, avgEdge: r.avgEdge }))
    .sort((a, b) => {
      const rank = (x: string) => (x === "매수" ? 0 : x === "중립" ? 1 : 2);
      return rank(a.band) - rank(b.band);
    });

  /* 예측한 순간의 종목 신호등별 — 값은 진작 박제해 두고 안 쓰고 있었다 */
  const bySignal = agg((x) => x.p.signal?.level ?? null)
    .map((r) => ({ level: r.key, n: r.n, hitRate: r.hitRate, avgEdge: r.avgEdge }))
    .sort((a, b) => {
      const rank = (l: string) => (l === "green" ? 0 : l === "yellow" ? 1 : l === "red" ? 2 : 3);
      return rank(a.level) - rank(b.level);
    });

  /*
   * 나아지고 있나 — **채점된 순서대로** 최근 10건과 그 이전.
   * 예측일로 정렬한다(채점된 날이 아니라). 열 건이 안 되면 가르지 않는다 —
   * 다섯 건으로 「나아졌다」고 말하면 그건 숫자가 아니라 기분이다.
   */
  const ordered = [...done].sort((a, b) => a.date.localeCompare(b.date));
  const RECENT = 10;
  const recentArr = ordered.slice(-RECENT);
  const earlierArr = ordered.slice(0, -RECENT);
  const trend = {
    recent: recentArr.length >= RECENT ? rate(recentArr) : null,
    earlier: earlierArr.length >= 5 ? rate(earlierArr) : null,
    recentN: recentArr.length,
    earlierN: earlierArr.length,
  };

  return {
    byMarket,
    byFutures,
    byStock,
    bySignal,
    trend,
    graded: done.length,
    pending,
    hitRate: rate(done),
    avgEdge: edges.length > 0 ? edges.reduce((a, b) => a + b, 0) / edges.length : null,
    up: { n: up.length, hitRate: rate(up) },
    down: { n: down.length, hitRate: rate(down) },
    recent: done
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 30)
      .map((x) => ({
        date: x.date,
        code: x.p.code,
        name: x.p.name,
        dir: x.p.dir,
        rate: x.p.result!.rate,
        hit: x.p.result!.hit,
        note: x.p.note,
        market: x.p.market,
        signal: x.p.signal,
        gradedAt: x.p.result!.date,
      })),
  };
}

export async function journalStats(): Promise<JournalStats> {
  const rows = await readAll();

  // 연속 기록 — 오늘(또는 어제)부터 거꾸로 하루씩
  const dates = new Set(rows.map((r) => r.date));
  let streak = 0;
  const cur = new Date(Date.now() + 9 * 3600_000);
  if (!dates.has(cur.toISOString().slice(0, 10))) cur.setDate(cur.getDate() - 1);
  while (dates.has(cur.toISOString().slice(0, 10))) {
    streak += 1;
    cur.setDate(cur.getDate() - 1);
  }

  const judged = rows.filter((r) => r.followedRules !== null);
  const kept = judged.filter((r) => r.followedRules);

  const mistakeCount = new Map<string, number>();
  for (const r of rows) for (const m of r.mistakes) mistakeCount.set(m, (mistakeCount.get(m) ?? 0) + 1);

  const moodAgg = new Map<string, { count: number; judged: number; kept: number }>();
  for (const r of rows) {
    if (!r.mood) continue;
    const a = moodAgg.get(r.mood) ?? { count: 0, judged: 0, kept: 0 };
    a.count += 1;
    if (r.followedRules !== null) {
      a.judged += 1;
      if (r.followedRules) a.kept += 1;
    }
    moodAgg.set(r.mood, a);
  }

  /*
   * 실현 수익률을 **매수한 날에 귀속**시킨다.
   *
   * 노트에 적힌 매수·매도를 종목별로 선입선출(FIFO)로 맞춘다. 판 날이 아니라 **산 날**에
   * 붙이는 이유는, 여기서 재는 게 "그날의 판단이 좋았나"이기 때문이다 — 규칙을 지키고
   * 산 종목이 결국 어떻게 됐는지를 봐야 규칙의 값어치가 나온다.
   *
   * 아직 안 판 것은 세지 않는다. 결과가 없는 걸 성적에 넣으면 물려 있는 게 실패로 잡힌다.
   */
  interface Lot {
    date: string;
    price: number;
    qty: number;
    /** 살 때 고른 근거 — 성적을 여기에 붙인다 */
    reasons: string[];
    /** 살 때 박제된 종목 신호등 */
    level: string;
    /** 그날 시장 신호등 — 국면별 성적을 내는 기준 */
    market: string;
    /**
     * 살 때 적어 둔 손절선. 실현 R 의 분모가 여기서 나온다.
     *
     * **판 뒤에 손절선을 고쳐 적을 수 없다** — 산 로트에 그때 값이 실려 있기 때문이다.
     * 그게 이 숫자를 믿을 수 있게 하는 유일한 이유다.
     */
    stop: number | null;
  }
  const lots = new Map<string, Lot[]>();
  const realized = new Map<string, number[]>(); // 매수일 → 실현 수익률들
  /*
   * **무엇을 보고 산 것이 통했나.**
   *
   * 실현 수익률을 매수일에만 붙이면 「규칙을 지킨 날」까지밖에 못 센다.
   * 산 **로트마다** 근거·신호등·시장 국면을 실어 두면, 판 순간 그 성적이
   * 그 근거에 꽂힌다 — 내 로직 중 뭐가 맞는지가 그제야 숫자로 나온다.
   */
  const byReason = new Map<string, Fill[]>();
  const byLevel = new Map<string, Fill[]>();
  const byMarket = new Map<string, Fill[]>();
  /** 전체 실현 R — 「내 매매가 대체로 몇 R 짜리인가」 */
  const allR: number[] = [];
  for (const r of [...rows].sort((a, b) => a.date.localeCompare(b.date))) {
    for (const t of r.trades ?? []) {
      const key = t.code || t.name;
      if (!key || t.price <= 0 || t.qty <= 0) continue;
      if (t.kind === "buy") {
        const arr = lots.get(key) ?? [];
        arr.push({
          date: r.date,
          price: t.price,
          qty: t.qty,
          reasons: t.reasons ?? [],
          level: t.level ?? "",
          market: r.context?.marketLevel ?? "",
          // 손절선이 진입가보다 위면 적다 만 것이다 — 그런 값으로 R 을 내면 부호가 뒤집힌다
          stop: typeof t.stop === "number" && t.stop > 0 && t.stop < t.price ? t.stop : null,
        });
        lots.set(key, arr);
        continue;
      }
      let left = t.qty;
      const arr = lots.get(key) ?? [];
      while (left > 0 && arr.length > 0) {
        const lot = arr[0];
        const take = Math.min(left, lot.qty);
        const rate = ((t.price - lot.price) / lot.price) * 100;
        /*
         * **실현 R** — 건 것 대비 얼마를 벌었나.
         *
         *   R = (판 가격 − 산 가격) ÷ (산 가격 − 손절가)
         *
         * 손절선을 안 적은 로트는 `null` 이다. 0 으로 세면 평균이 통째로 거짓말이 된다 —
         * **못 내는 값을 지어내지 않는다**는 이 앱의 규칙이 여기서도 그대로다.
         */
        const r = lot.stop !== null ? (t.price - lot.price) / (lot.price - lot.stop) : null;
        if (r !== null) allR.push(r);
        const fill: Fill = { rate, r };
        const got = realized.get(lot.date) ?? [];
        // 수량만큼 가중하지 않고 건별로 넣는다 — 승률·평균을 보려는 것이므로
        got.push(rate);
        realized.set(lot.date, got);
        // 한 매매에 근거가 여럿이면 **각각에 다 넣는다** — 어느 근거가 섞여 있었는지가 정보다
        for (const k of lot.reasons) byReason.set(k, [...(byReason.get(k) ?? []), fill]);
        if (lot.level) byLevel.set(lot.level, [...(byLevel.get(lot.level) ?? []), fill]);
        if (lot.market) byMarket.set(lot.market, [...(byMarket.get(lot.market) ?? []), fill]);
        lot.qty -= take;
        left -= take;
        if (lot.qty <= 0) arr.shift();
      }
      lots.set(key, arr);
    }
  }
  const returnOn = (date: string) => realized.get(date) ?? [];
  const keptReturns = kept.flatMap((r) => returnOn(r.date));
  const brokeReturns = judged.filter((r) => !r.followedRules).flatMap((r) => returnOn(r.date));
  const avg = (xs: number[]) => (xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

  /*
   * 판단 vs 실행 — 예측 적중률과 **실현 매매 승률**을 나란히 놓는다.
   * 승률은 판 건 기준(수량 가중 안 함) — 「몇 번 중 몇 번 이겼나」를 묻는 것이라
   * 큰 매매가 평균을 끌면 그 물음이 흐려진다. 위 실현 집계와 같은 규칙이다.
   */
  const allRealized = [...realized.values()].flat();
  const pk = pickStats(rows);
  const judgeVsAct =
    pk.hitRate !== null && allRealized.length > 0
      ? {
          pickHit: pk.hitRate,
          tradeWin: (allRealized.filter((x) => x > 0).length / allRealized.length) * 100,
          tradeN: allRealized.length,
        }
      : null;

  return {
    picks: pk,
    judgeVsAct,
    days: rows.length,
    streak,
    ruleRate: judged.length > 0 ? (kept.length / judged.length) * 100 : null,
    mistakes: [...mistakeCount.entries()]
      .map(([key, count]) => ({ key, label: MISTAKE_LABEL.get(key) ?? key, count }))
      .sort((a, b) => b.count - a.count),
    moods: [...moodAgg.entries()]
      .map(([key, a]) => ({
        key,
        label: MOOD_LABEL.get(key) ?? key,
        count: a.count,
        ruleRate: a.judged > 0 ? (a.kept / a.judged) * 100 : null,
      }))
      .sort((a, b) => b.count - a.count),
    ruleEdge: {
      keptDays: kept.length,
      keptAvgReturn: avg(keptReturns),
      brokeDays: judged.length - kept.length,
      brokeAvgReturn: avg(brokeReturns),
    },
    rStat: {
      count: allR.length,
      avg: avg(allR),
      best: allR.length > 0 ? Math.max(...allR) : null,
      worst: allR.length > 0 ? Math.min(...allR) : null,
    },
    reasonEdge: edge(byReason, (k) => REASON_LABEL.get(k) ?? k),
    signalEdge: edge(byLevel, (k) => k),
    marketEdge: edge(byMarket, (k) => k),
    watch: (() => {
      /*
       * 쉰 날은 **적어야 세진다.** `stance` 를 안 고른 날은 매매 기록으로 갈음한다 —
       * 예전에 적은 노트에는 이 칸이 아예 없어서다.
       */
      const isWatch = (r: JournalEntry) =>
        r.stance === "watch" || (r.stance == null && (r.trades ?? []).length === 0);
      const watchDays = rows.filter(isWatch);
      const tradeDays = rows.filter((r) => !isWatch(r));
      const count = (list: JournalEntry[]) => {
        const m = new Map<string, number>();
        for (const r of list) {
          const k = r.context?.marketLevel;
          if (k) m.set(k, (m.get(k) ?? 0) + 1);
        }
        return [...m.entries()].map(([key, c]) => ({ key, count: c })).sort((a, b) => b.count - a.count);
      };
      const reasonCount = new Map<string, number>();
      for (const r of watchDays) {
        for (const k of r.watchReasons ?? []) reasonCount.set(k, (reasonCount.get(k) ?? 0) + 1);
      }
      return {
        days: watchDays.length,
        tradeDays: tradeDays.length,
        reasons: [...reasonCount.entries()]
          .map(([key, c]) => ({ key, label: WATCH_LABEL.get(key) ?? key, count: c }))
          .sort((a, b) => b.count - a.count),
        byMarket: count(watchDays),
        tradeByMarket: count(tradeDays),
      };
    })(),
    lessons: rows
      .filter((r) => r.lesson.trim())
      .slice(-12)
      .reverse()
      .map((r) => ({ date: r.date, lesson: r.lesson })),
  };
}
