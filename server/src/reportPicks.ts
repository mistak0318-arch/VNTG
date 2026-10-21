import { loadCloses } from "./dailyCloses.js";
import { loadSamples, type Sample } from "./signalSamples.js";

/**
 * **데일리 리포트에 붙는 종목 목록** (2026-10-21).
 *
 * 벤티지: "지금 일련의 구현한 것들이 실제 도움이 되려면 내가 가장 중요시 여기는 게
 * 되어야 할 거 같아. 데일리 브리핑 아침 조간 석간에 이거 넣자 — 외국인 수급 순매수
 * (5·10·20일) / 기관 수급 / 쌍끌이 / 정배열 전환 / 52주 신고가 / 눌림목."
 *
 * ## 조회가 0 이다
 *
 * 재료가 **이미 다 있다.** 신호등 표본(`signalSamples`)이 종목마다 그날의 이동평균
 * 다섯·수급 5/10/20/60일·낙폭·시총을 들고 있고, 일봉 창고(`dailyCloses`)에 2년치
 * 봉이 있다. 둘을 맞대면 된다 — **키움을 한 번도 안 부른다.**
 *
 * ## ⚠️ 목록만 내면 거짓말이 된다
 *
 * 2026-09-11 재검증(29,570관측·87거래일, 시총 중립 초과수익)에서 나온 것들이다:
 *
 *   · **쌍끌이는 단독 신호로 못 쓴다.** 빨강 안에서 −0.1, 시총 상위 5분위 −2.0/44.
 *     20일 신호이고(5일은 −0.2) 약세장·소형주에서만 값이 있다. 그래서 「외국인 세 칸」
 *     (+3.2/59, 하루 17.3개)이 본체이고 쌍끌이는 그중 더 좁은 갈래다.
 *   · **눌림목은 방향이 거꾸로였다.** 신호등에서 끄면 초록이 +1.8 → +2.5 로 올랐다.
 *
 * 그래서 각 묶음에 **그 실측을 한 줄로 달아 내보낸다**(`note`). 숫자를 보여 주면서
 * 그 숫자가 어떤 성적이었는지를 같이 말하지 않으면, 목록이 추천으로 읽힌다.
 */

export interface Pick {
  code: string;
  name: string;
  /** 한 줄 근거 — 화면에 그대로 */
  why: string;
}

export interface PickGroup {
  key: string;
  label: string;
  picks: Pick[];
  /** 이 묶음을 어떻게 읽어야 하나 — 실측이 있으면 그 말 */
  note: string;
}

export interface ReportPicks {
  /** 어느 날 원장으로 뽑았나 (YYYYMMDD) */
  date: string;
  /**
   * 그 원장이 **며칠 묵었나**. 0 이면 오늘, 1 이면 어제.
   *
   * ⚠️ 리포트에 **반드시 같이 보인다.** 표본은 마감 뒤 정리에서 다시 만들어지는데,
   * 그게 하루 걸러지면 목록이 조용히 옛날 것이 된다 — 숫자는 멀쩡해 보이고 날짜만
   * 틀린 꼴이라 제일 위험하다. 실제로 로컬 표본이 한 달 묵어 있던 것을 보고 넣었다.
   */
  ageDays: number;
  groups: PickGroup[];
}

/** 원장이 이보다 묵었으면 목록을 안 낸다 — 옛 종목을 오늘 것처럼 보여 주느니 비운다 */
const MAX_AGE_DAYS = 4;

const TOP = 8;
/** 너무 작은 종목은 뺀다 — 목록에 올라도 들어갈 자리가 아니다 */
const MIN_CAP_EOK = 1000;
/** 그날 거래대금이 이만큼(억)은 돼야 */
const MIN_VOL_EOK = 30;

const eok = (v: number) => `${Math.round(v).toLocaleString("ko-KR")}억`;
const sign = (v: number) => `${v > 0 ? "+" : ""}${Math.round(v).toLocaleString("ko-KR")}`;

/** 수급 칸은 **백만원** 단위로 쌓여 있다 — 억으로 고쳐 읽는다 */
const toEok = (v: number) => v / 100;

function tradable(s: Sample): boolean {
  return (s.mktCap ?? 0) >= MIN_CAP_EOK && (s.volEok ?? 0) >= MIN_VOL_EOK;
}

/** 정배열 — 5 > 20 > 60 (MA_PERIODS 는 [5,10,20,60,120]) */
function aligned(s: Sample): boolean {
  const [m5, , m20, m60] = s.ma;
  return m5 != null && m20 != null && m60 != null && m5 > m20 && m20 > m60;
}

export async function buildReportPicks(): Promise<ReportPicks | null> {
  const file = await loadSamples();
  if (!file || file.samples.length === 0) return null;

  /* 가장 최근 날짜 줄만 — 그 전날은 「전환」을 가리는 데 쓴다 */
  const days = [...new Set(file.samples.map((s) => s.date))].sort();
  const today = days[days.length - 1];
  const prevDay = days[days.length - 2] ?? "";
  if (!today) return null;

  const cur = file.samples.filter((s) => s.date === today && tradable(s));
  const prev = new Map(file.samples.filter((s) => s.date === prevDay).map((s) => [s.code, s]));

  /* 며칠 묵었나 — 달력 날짜로 센다(주말이 끼면 2~3일이 정상이다) */
  const asDate = new Date(
    Number(today.slice(0, 4)),
    Number(today.slice(4, 6)) - 1,
    Number(today.slice(6, 8)),
  );
  const ageDays = Math.max(0, Math.round((Date.now() - asDate.getTime()) / 86400_000));
  if (ageDays > MAX_AGE_DAYS) {
    console.warn(`[reportPicks] 원장이 ${ageDays}일 묵었다(${today}) — 목록을 안 낸다`);
    return { date: today, ageDays, groups: [] };
  }

  const groups: PickGroup[] = [];
  const add = (key: string, label: string, picks: Pick[], note: string) => {
    if (picks.length > 0) groups.push({ key, label, picks, note });
  };

  /* ── 외국인·기관 순매수 (5·10·20일) ───────────────────────── */
  const flowTop = (
    pick: (s: Sample) => number | null | undefined,
    label: string,
    note: string,
    key: string,
  ) => {
    const rows = cur
      .map((s) => ({ s, v: pick(s) }))
      .filter((x): x is { s: Sample; v: number } => Number.isFinite(x.v as number) && (x.v as number) > 0)
      .sort((a, b) => b.v - a.v)
      .slice(0, TOP);
    add(
      key,
      label,
      rows.map(({ s, v }) => ({
        code: s.code,
        name: s.name,
        why: `${eok(toEok(v))} · 시총 ${eok(s.mktCap ?? 0)}`,
      })),
      note,
    );
  };

  const FGN_NOTE =
    "외국인 5·10·20일이 모두 순매수인 「외국인 세 칸」이 재검증에서 가장 넓고 좋았다 (20일 +3.2%p · 승률 59 · 하루 17.3개).";
  flowTop((s) => s.fgn5, "외국인 순매수 5일", FGN_NOTE, "fgn5");
  flowTop((s) => s.fgn10, "외국인 순매수 10일", FGN_NOTE, "fgn10");
  flowTop((s) => s.fgn20, "외국인 순매수 20일", FGN_NOTE, "fgn20");

  const INST_NOTE =
    "기관 단독은 힘이 약하다 — 인덱스·헤지 물량이 섞인다. 외국인과 같이 볼 때만 뜻이 있다(아래 쌍끌이).";
  flowTop((s) => s.inst5, "기관 순매수 5일", INST_NOTE, "inst5");
  flowTop((s) => s.inst10, "기관 순매수 10일", INST_NOTE, "inst10");
  flowTop((s) => s.inst20, "기관 순매수 20일", INST_NOTE, "inst20");

  /* ── 쌍끌이 — 외인·기관이 5·10·20일 **모두** 순매수 ─────────── */
  const twin = cur
    .filter(
      (s) =>
        (s.fgn5 ?? 0) > 0 && (s.fgn10 ?? 0) > 0 && (s.fgn20 ?? 0) > 0 &&
        (s.inst5 ?? 0) > 0 && (s.inst10 ?? 0) > 0 && (s.inst20 ?? 0) > 0,
    )
    .sort((a, b) => (b.fgn20 ?? 0) + (b.inst20 ?? 0) - ((a.fgn20 ?? 0) + (a.inst20 ?? 0)))
    .slice(0, TOP);
  add(
    "twin",
    "쌍끌이 (외인·기관 5·10·20 모두 순매수)",
    twin.map((s) => ({
      code: s.code,
      name: s.name,
      why: `외인 ${sign(toEok(s.fgn20 ?? 0))}억 · 기관 ${sign(toEok(s.inst20 ?? 0))}억 (20일)`,
    })),
    "⚠️ 단독 신호로는 못 쓴다 — 재검증에서 빨강 안 −0.1, 시총 상위 5분위 −2.0. 20일 신호라 5일로 보면 −0.2 다. 약세장·소형주에서만 값이 있었다.",
  );

  /* ── 정배열 전환 — 오늘 5>20>60 인데 어제는 아니었다 ────────── */
  const maTurn = cur
    .filter((s) => aligned(s) && prev.has(s.code) && !aligned(prev.get(s.code)!))
    .sort((a, b) => (b.volEok ?? 0) - (a.volEok ?? 0))
    .slice(0, TOP);
  add(
    "maTurn",
    "정배열 전환 (오늘 5>20>60)",
    maTurn.map((s) => ({
      code: s.code,
      name: s.name,
      why: `거래대금 ${eok(s.volEok ?? 0)} · 20일선 이격 ${(s.gap20 ?? 0).toFixed(1)}%`,
    })),
    "어제까지 아니었다가 오늘 처음 선 것만. 추세의 시작 자리이지 그 자체가 매수 신호는 아니다 (신조 ②추세).",
  );

  /* ── 52주 신고가 — 일봉 250봉 최고 ──────────────────────── */
  const store = await loadCloses().catch(() => null);
  const high52: { p: Pick; vol: number }[] = [];
  if (store?.bars) {
    for (const s of cur) {
      const bars = store.bars[s.code];
      if (!bars || bars.length < 60) continue;
      const win = bars.slice(-250);
      const last = win[win.length - 1];
      if (!last || !(last.c > 0)) continue;
      /* 오늘 종가가 창 안에서 가장 높다 — 직전 최고와 같아도 신고가로 본다 */
      const prevMax = Math.max(...win.slice(0, -1).map((b) => b.c));
      if (last.c >= prevMax && prevMax > 0) {
        high52.push({
          p: {
            code: s.code,
            name: s.name,
            why: `${win.length}봉 최고 · 거래대금 ${eok(s.volEok ?? 0)}`,
          },
          vol: s.volEok ?? 0,
        });
      }
    }
  }
  /* 거래대금 큰 것부터 — 신고가는 많이 나오므로 들어갈 자리가 있는 것 먼저 */
  high52.sort((a, b) => b.vol - a.vol);
  add(
    "high52",
    "52주 신고가",
    high52.slice(0, TOP).map((x) => x.p),
    "250봉(약 1년) 안에서 종가가 가장 높은 종목. 봉이 모자란 신규 상장은 빠진다.",
  );

  /* ── 눌림목 — 올랐다가 20일 고점에서 물러난 자리 ───────────── */
  const pullback = cur
    .filter((s) => (s.rise20 ?? 0) >= 8 && (s.dd20 ?? 0) <= -5 && (s.dd20 ?? 0) >= -15 && aligned(s))
    .sort((a, b) => (b.volEok ?? 0) - (a.volEok ?? 0))
    .slice(0, TOP);
  add(
    "pullback",
    "눌림목 (20일 +8%↑ 뒤 고점 대비 −5~−15%, 정배열)",
    pullback.map((s) => ({
      code: s.code,
      name: s.name,
      why: `20일 ${(s.rise20 ?? 0).toFixed(0)}% 오른 뒤 고점 대비 ${(s.dd20 ?? 0).toFixed(1)}%`,
    })),
    "⚠️ 재검증에서 **방향이 거꾸로였다** — 신호등에서 이 기준을 끄면 초록 성적이 +1.8 → +2.5 로 올랐다. 참고로만 본다.",
  );

  return { date: today, ageDays, groups };
}
