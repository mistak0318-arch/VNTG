import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dropPhantomToday } from "./candleGuard.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { brokerFlow } from "./brokerFlow.js";
import type { KiwoomClient } from "./kiwoomClient.js";
import { getSectorMood } from "./sectorMood.js";
import { evaluateMarket } from "./marketSignal.js";
import { stockNameHtml } from "./telegram.js";

/**
 * 관심종목 시그널 판정.
 *
 * 리포트는 웹에서 봐도 되지만 이건 즉시성이 생명이다 — 놓치면 의미가 없다.
 * 그래서 조건을 넉넉하게 잡기보다 **울리면 반드시 볼 만한 것**으로 좁게 잡는다.
 * 하루에 20건 오는 알림은 0건 오는 알림과 똑같이 무시된다.
 *
 * 판정에 쓰는 데이터는 전부 이미 조회하고 있던 것들이라 새 TR이 필요 없다.
 * 종목당 최대 3콜(기본정보/일봉/투자자)이고, 관심종목이 30개면 90콜이라
 * 초당 5회 제한에 맞춰 청크로 나눠 돈다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "data");
const CONFIG_FILE = join(DATA_DIR, "alertConfig.json");
const STATE_FILE = join(DATA_DIR, "alertState.json");

export type AlertKey =
  | "priceJump"
  | "volumeSurge"
  | "flowTurn"
  | "newHigh"
  | "trendAlign"
  /** 아래 둘은 실시간에서 꺼낸다 — 조회 0, 1분마다 */
  | "viHit"
  | "strengthJump"
  /** 이것만 조회가 필요해 10분 검사에 붙어 돈다 */
  | "brokerExit";

export interface AlertRule {
  key: AlertKey;
  label: string;
  enabled: boolean;
  /** 기준값 — 규칙마다 의미가 다르다 */
  threshold: number;
  hint: string;
}

export interface AlertConfig {
  /** 시그널 검사 자체를 끌 수 있다 */
  enabled: boolean;
  /** 검사 간격(분). 너무 짧으면 API 한도를 먹는다 */
  intervalMin: number;
  /**
   * **점수대 자동 그룹(60~90점대)만 든 종목도 볼까** (2026-09-03 알람 전수 점검).
   *
   * 점수대 그룹은 신호등이 매일 갈아 끼우는 수십 종목이라, 여기까지 훑으면 종목당 3콜이
   * 그만큼 늘고 「내가 담지도 않은 종목」의 급변이 울린다. 기본은 끔 — 내가 담은 그룹과
   * 슈퍼신호등·교차만 본다. 켜면 관심종목 전부.
   */
  scanBands?: boolean;
  rules: AlertRule[];
}

export const DEFAULT_ALERT_CONFIG: AlertConfig = {
  enabled: true,
  intervalMin: 10,
  scanBands: false,
  rules: [
    {
      key: "priceJump",
      label: "급변",
      enabled: true,
      threshold: 5,
      hint: "당일 등락률 절대값이 기준값(%) 이상",
    },
    {
      key: "volumeSurge",
      label: "거래량 급증",
      enabled: true,
      threshold: 3,
      hint: "당일 거래량이 20일 평균의 기준값 배 이상",
    },
    {
      key: "flowTurn",
      label: "수급 전환",
      enabled: true,
      threshold: 0,
      hint: "외국인 5일 순매수가 직전 5일 순매도에서 매수로 전환",
    },
    {
      key: "newHigh",
      label: "250일 신고가",
      enabled: true,
      threshold: 0,
      hint: "당일 고가가 최근 250일 최고가를 넘음",
    },
    {
      key: "trendAlign",
      label: "정배열 진입",
      enabled: true,
      threshold: 0,
      hint: "어제까지 아니었다가 오늘 5>20>60 정렬 달성",
    },
    /*
     * ── 아래 셋은 **다른 길로 돈다.**
     *
     * 위의 것들은 종목마다 조회를 부르므로 10분 간격을 지킨다. 아래 둘(VI·체결강도)은
     * **이미 물고 있는 실시간에서** 값을 꺼내므로 조회가 0 이고, 그래서 **1분마다** 본다.
     * VI 는 몇 초 뒤에 알면 이미 끝나 있다.
     *
     * 거래원 이탈만 조회가 필요해서 위쪽 검사에 붙어 돈다.
     */
    {
      key: "viHit",
      label: "VI 발동",
      enabled: true,
      threshold: 0,
      hint: "관심종목에 변동성완화장치가 걸렸다 — 실시간에서 바로 받는다(조회 0)",
    },
    {
      key: "strengthJump",
      label: "체결강도 급변",
      enabled: true,
      threshold: 30,
      hint: "체결강도가 직전보다 기준값만큼 뛰었고 100을 넘겼다 — 실시간(조회 0)",
    },
    {
      key: "brokerExit",
      label: "거래원 이탈",
      enabled: false,
      threshold: 0,
      hint: "⚠️ 종목당 조회가 1회 더 나갑니다. 오늘 제일 많이 산 창구가 순매도로 돌아섰을 때",
    },
  ],
};

// ---------------------------------------------------------------- 설정

let configCache: AlertConfig | null = null;

export async function getAlertConfig(): Promise<AlertConfig> {
  if (configCache) return configCache;
  try {
    const saved = JSON.parse(await readFile(CONFIG_FILE, "utf-8")) as AlertConfig;
    configCache = {
      ...DEFAULT_ALERT_CONFIG,
      ...saved,
      // 규칙이 나중에 추가돼도 저장본이 깨지지 않게 기본값과 합친다
      rules: DEFAULT_ALERT_CONFIG.rules.map(
        (d) => saved.rules?.find((s) => s.key === d.key) ?? d,
      ),
    };
  } catch {
    configCache = DEFAULT_ALERT_CONFIG;
  }
  return configCache;
}

export async function saveAlertConfig(cfg: AlertConfig): Promise<AlertConfig> {
  const next: AlertConfig = {
    ...cfg,
    // 1분 미만으로 돌면 API 한도를 먹는다
    intervalMin: Math.min(Math.max(Math.round(cfg.intervalMin) || 10, 3), 120),
  };
  configCache = next;
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(next, null, 2), "utf-8");
  return next;
}

// ---------------------------------------------------------------- 중복 방지

/** `YYYY-MM-DD|종목코드|규칙` 을 키로 이미 보낸 것을 기억한다 */
type AlertState = Record<string, string>;

async function readState(): Promise<AlertState> {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf-8")) as AlertState;
  } catch {
    return {};
  }
}

async function writeState(state: AlertState): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

/** 오래된 기록은 버린다 — 무한히 커지면 안 된다 */
function prune(state: AlertState, keepDays = 7): AlertState {
  const cutoff = new Date(Date.now() - keepDays * 86400_000).toISOString().slice(0, 10);
  const out: AlertState = {};
  for (const [k, v] of Object.entries(state)) {
    if (k.slice(0, 10) >= cutoff) out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------- 판정

export interface FiredAlert {
  code: string;
  name: string;
  rule: AlertKey;
  ruleLabel: string;
  /** 왜 울렸는지 한 줄 */
  detail: string;
  /**
   * **숫자만 압축한 꼬리** (2026-09-03 — 벤티지: "관심종목 급변이라고만 오니깐 얘가 어디서 어디로
   * 급변인지 모르겠더라. 꼭 눌러야 해"). 알림함 한 줄에 `두산에너빌리티 급변 +5.5% (81,000)` 처럼
   * 붙는다 — 열지 않고 판단하라고 있는 것이 알림이다.
   */
  brief: string;
  price: number;
  changeRate: number;
  /** 부가 정보 — 메시지 본문에 같이 붙인다 */
  context: string[];
}

const CHART_RESOURCE = "/api/dostk/chart";
const STKINFO_RESOURCE = "/api/dostk/stkinfo";

function toNum(v: unknown): number {
  const n = Number(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}
function toAbs(v: unknown): number {
  return Math.abs(toNum(v));
}
/** 시장 신호등 색을 화면에서 쓰는 말로 — 영어로 적으면 한 번 더 옮겨 읽어야 한다 */
const LEVEL_KO: Record<string, string> = { green: "초록", yellow: "노랑", red: "빨강" };

function sma(values: number[], n: number): number | null {
  if (values.length < n) return null;
  return values.slice(0, n).reduce((s, v) => s + v, 0) / n;
}
function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("ko-KR");
}
function todayYyyymmdd(): string {
  const d = new Date();
  const kst = new Date(d.getTime() + (9 * 60 + d.getTimezoneOffset()) * 60_000);
  return `${kst.getFullYear()}${String(kst.getMonth() + 1).padStart(2, "0")}${String(kst.getDate()).padStart(2, "0")}`;
}

/** 한 종목을 검사해 발동한 시그널들을 돌려준다 */
async function evaluateStock(
  client: KiwoomClient,
  item: { code: string; name: string; addedPrice?: number },
  cfg: AlertConfig,
  /** 그날 시장 신호등 — 스캔 한 번에 한 번만 받아 돌려 쓴다 */
  market: { level: string; score: number } | null,
): Promise<FiredAlert[]> {
  const rules = new Map(cfg.rules.filter((r) => r.enabled).map((r) => [r.key, r]));
  if (rules.size === 0) return [];

  const [info, chart, flow] = await Promise.all([
    client
      .request<Record<string, unknown>>(STKINFO_RESOURCE, "ka10001", { stk_cd: item.code })
      .catch(() => null),
    client
      .request<Record<string, unknown>>(CHART_RESOURCE, "ka10081", {
        stk_cd: item.code,
        base_dt: todayYyyymmdd(),
        upd_stkpc_tp: "1",
      })
      .catch(() => null),
    rules.has("flowTurn")
      ? client
          .request<Record<string, unknown>>(CHART_RESOURCE, "ka10060", {
            stk_cd: item.code,
            dt: todayYyyymmdd(),
            amt_qty_tp: "1",
            trde_tp: "0",
            unit_tp: "1000",
          })
          .catch(() => null)
      : null,
  ]);

  const price = toAbs(info?.data?.cur_prc);
  const changeRate = toNum(info?.data?.flu_rt);
  if (price === 0) return []; // 시세를 못 받으면 판단하지 않는다

  const rows = dropPhantomToday((chart?.data?.stk_dt_pole_chart_qry ?? []) as Record<string, unknown>[]);
  const closes = rows.map((r) => toAbs(r.cur_prc)).filter((n) => n > 0);
  const volumes = rows.map((r) => toNum(r.trde_qty));

  const fired: FiredAlert[] = [];

  /*
   * 부가정보를 **라벨 붙은 줄**로 짠다.
   *
   * 예전엔 「+5.20%」처럼 값만 늘어놓아서, 폰에서 받으면 **무슨 소리인지 모르고**
   * 결국 앱을 열어 봐야 했다. 그러면 알림의 뜻이 없다 — 알림은 **열지 않고 판단하라고**
   * 있는 것이다.
   *
   * 그래서 「지금·수급·자리·시장·내것」 다섯 줄로 나눈다. 다섯 가지는 사람이 종목을 볼 때
   * 실제로 묻는 순서다 — 지금 어떤가, 누가 사고 있나, 비싼 자리인가, 시장은 받쳐주나,
   * 나는 얼마에 담았나.
   *
   * ⚠️ **여기서 TR 을 더 부르지 않는다.** 이미 받아 둔 기본정보(ka10001)와 일봉(ka10081)에
   * 다 있다. 관심종목이 서른 개면 한 번 더 부르는 것만으로 서른 콜이 늘어난다.
   */
  const context: string[] = [];

  const dayHigh = toAbs(info?.data?.high_pric);
  const dayLow = toAbs(info?.data?.low_pric);
  const todayVol = toNum(info?.data?.trde_qty);
  const avgVol20 = sma(volumes.slice(1), 20); // 오늘 제외 20일

  // ── 지금 : 오늘 어디쯤에서 움직이고 있나
  const nowBits: string[] = [];
  if (dayHigh > 0 && dayLow > 0 && dayHigh > dayLow) {
    const pos = ((price - dayLow) / (dayHigh - dayLow)) * 100;
    nowBits.push(`오늘 ${pos.toFixed(0)}% 자리(고 ${fmtInt(dayHigh)} / 저 ${fmtInt(dayLow)})`);
  }
  if (todayVol > 0 && avgVol20 && avgVol20 > 0) {
    nowBits.push(`거래량 20일 평균의 ${(todayVol / avgVol20).toFixed(1)}배`);
  }
  if (nowBits.length > 0) context.push(`지금  ${nowBits.join(" · ")}`);

  // ── 수급 : 누가 사고 있나
  const flowRows = (flow?.data?.stk_invsr_orgn_chart ?? []) as Record<string, unknown>[];
  const foreign5 = flowRows.slice(0, 5).reduce((s, r) => s + toNum(r.frgnr_invsr), 0);
  const foreignPrev5 = flowRows.slice(5, 10).reduce((s, r) => s + toNum(r.frgnr_invsr), 0);
  const inst5 = flowRows.slice(0, 5).reduce((s, r) => s + toNum(r.orgn), 0);
  if (flowRows.length > 0) {
    context.push(
      `수급  외인 5일 ${foreign5 > 0 ? "+" : ""}${fmtInt(foreign5)} · 기관 ${inst5 > 0 ? "+" : ""}${fmtInt(inst5)}`,
    );
  }

  /*
   * ── 자리 : **비싼 자리에서 울린 건지**를 가른다.
   * 같은 급등이라도 20일선 아래에서 올라온 것과 신고가에서 더 뛴 것은 뜻이 정반대다.
   */
  const seatBits: string[] = [];
  const ma20 = sma(closes, 20);
  if (ma20 && ma20 > 0) {
    const gap = ((price - ma20) / ma20) * 100;
    seatBits.push(`20일선 ${gap > 0 ? "위 +" : "아래 "}${gap.toFixed(1)}%`);
  }
  const hi250 = toAbs(info?.data?.["250hgst"]);
  if (hi250 > 0) {
    const gap = ((price - hi250) / hi250) * 100;
    seatBits.push(gap >= 0 ? "250일 신고가권" : `250일 고점 ${gap.toFixed(1)}%`);
  }
  if (seatBits.length > 0) context.push(`자리  ${seatBits.join(" · ")}`);

  // ── 시장 : 종목만 보고 사면 안 된다
  const mood = await getSectorMood(client, item.code).catch(() => null);
  const mktBits: string[] = [];
  if (market) mktBits.push(`신호등 ${LEVEL_KO[market.level] ?? market.level} ${market.score}점`);
  if (mood?.sector?.name) {
    const r = mood.sector.changeRate;
    mktBits.push(`${mood.sector.name} ${r > 0 ? "+" : ""}${r.toFixed(2)}%`);
  }
  if (mktBits.length > 0) context.push(`시장  ${mktBits.join(" · ")}`);

  // ── 내것 : 담아 둔 값과 견준다. 편입가가 없으면 안 적는다
  if (item.addedPrice && item.addedPrice > 0) {
    const gain = ((price - item.addedPrice) / item.addedPrice) * 100;
    context.push(
      `내것  편입 ${fmtInt(item.addedPrice)} → ${gain > 0 ? "+" : ""}${gain.toFixed(1)}%`,
    );
  }

  const base = { code: item.code, name: item.name, price, changeRate, context };
  const ratePart = `${changeRate > 0 ? "+" : ""}${changeRate.toFixed(1)}%`;

  // --- 급변
  const jump = rules.get("priceJump");
  if (jump && Math.abs(changeRate) >= jump.threshold) {
    /* 어제 종가 → 지금 — 「어디서 어디로」가 한 줄에 있어야 한다 */
    const prevClose = changeRate !== -100 ? price / (1 + changeRate / 100) : 0;
    fired.push({
      ...base,
      rule: "priceJump",
      ruleLabel: jump.label,
      detail: `어제 ${fmtInt(prevClose)} → 지금 ${fmtInt(price)} (${ratePart}) — 기준 ±${jump.threshold}%`,
      brief: `${ratePart} · ${fmtInt(prevClose)}→${fmtInt(price)}`,
    });
  }

  // --- 거래량 급증
  const surge = rules.get("volumeSurge");
  if (surge && avgVol20 && avgVol20 > 0 && todayVol / avgVol20 >= surge.threshold) {
    const x = todayVol / avgVol20;
    fired.push({
      ...base,
      rule: "volumeSurge",
      ruleLabel: surge.label,
      detail: `20일 평균의 ${x.toFixed(1)}배 (${fmtInt(todayVol)}주 / 평균 ${fmtInt(avgVol20)}) — 기준 ${surge.threshold}배 · 주가 ${ratePart}`,
      brief: `${x.toFixed(1)}배 · 주가 ${ratePart}`,
    });
  }

  // --- 수급 전환 (직전 5일 순매도 → 최근 5일 순매수)
  const turn = rules.get("flowTurn");
  if (turn && flowRows.length >= 10 && foreignPrev5 < 0 && foreign5 > 0) {
    fired.push({
      ...base,
      rule: "flowTurn",
      ruleLabel: turn.label,
      detail: `외국인 5일 순매수 ${fmtInt(foreignPrev5)}백만 → +${fmtInt(foreign5)}백만 (팔다가 사는 쪽으로) · 주가 ${ratePart}`,
      brief: `외인 5일 ${fmtInt(foreignPrev5)}→+${fmtInt(foreign5)}백만`,
    });
  }

  // --- 250일 신고가 (오늘 제외한 과거 최고가를 오늘 고가가 넘었는지)
  const high = rules.get("newHigh");
  if (high && rows.length >= 60) {
    const todayHigh = toAbs(info?.data?.high_pric) || price;
    const past = rows.slice(1, 251).map((r) => toAbs(r.high_pric)).filter((n) => n > 0);
    const prevMax = past.length > 0 ? Math.max(...past) : 0;
    if (prevMax > 0 && todayHigh > prevMax) {
      fired.push({
        ...base,
        rule: "newHigh",
        ruleLabel: high.label,
        detail: `${past.length}일 최고 ${fmtInt(prevMax)} 를 오늘 고가 ${fmtInt(todayHigh)} 가 넘었습니다 · 지금 ${fmtInt(price)} (${ratePart})`,
        brief: `고점 ${fmtInt(prevMax)}→${fmtInt(todayHigh)} · ${ratePart}`,
      });
    }
  }

  // --- 정배열 진입 (어제까지는 아니었는데 오늘 달성한 것만)
  const align = rules.get("trendAlign");
  if (align && closes.length >= 61) {
    const aligned = (offset: number): boolean | null => {
      const s = closes.slice(offset);
      const m5 = sma(s, 5);
      const m20 = sma(s, 20);
      const m60 = sma(s, 60);
      if (!m5 || !m20 || !m60) return null;
      return s[0] >= m5 && m5 >= m20 && m20 >= m60;
    };
    // 오늘은 정배열인데 어제는 아니었을 때만 — 계속 정배열이면 매일 울릴 이유가 없다
    if (aligned(0) === true && aligned(1) === false) {
      const m5 = sma(closes, 5) ?? 0;
      const m20 = sma(closes, 20) ?? 0;
      const m60 = sma(closes, 60) ?? 0;
      fired.push({
        ...base,
        rule: "trendAlign",
        ruleLabel: align.label,
        detail: `5일선 ${fmtInt(m5)} > 20일선 ${fmtInt(m20)} > 60일선 ${fmtInt(m60)} — 어제까진 아니었는데 오늘 정배열 · 지금 ${fmtInt(price)} (${ratePart})`,
        brief: `5>20>60 오늘 성립 · ${ratePart}`,
      });
    }
  }

  /*
   * ── 거래원 이탈
   *
   * **오늘 제일 많이 산 창구가 지금은 팔고 있나.**
   *
   * `ka10040` 은 누적과 함께 **직전 조회 대비 증감**(`delta`)을 준다. 1위 매수 창구의
   * 증감이 음수면 그 창구가 방향을 바꾼 것이다 — 하루 종일 산 창구가 돌아서는 건
   * 「끌던 손이 손을 뗐다」는 뜻이라 값이 있다.
   *
   * ⚠️ **조회가 한 번 더 나간다.** 그래서 기본이 꺼져 있고, 설정에 그렇게 적어 뒀다.
   * 덤으로 이 조회가 거래원 시계열도 채운다 — 화면을 안 보는 시간이 그만큼 덜 빈다.
   */
  const exit = rules.get("brokerExit");
  if (exit) {
    const bf = await brokerFlow(client, item.code).catch(() => null);
    const top = bf?.buy?.[0];
    if (top && top.delta < 0 && top.qty > 0) {
      fired.push({
        ...base,
        rule: "brokerExit",
        ruleLabel: exit.label,
        detail:
          `오늘 제일 많이 산 ${top.name}(누적 ${fmtInt(top.qty)}주)이 ` +
          `직전 조회 대비 ${fmtInt(Math.abs(top.delta))}주 순매도로 돌아섰습니다`,
        brief: `${top.name} 누적 +${fmtInt(top.qty)}주 → ${fmtInt(Math.abs(top.delta))}주 매도`,
      });
    }
  }

  return fired;
}

/**
 * 관심종목 전체를 검사한다.
 * 이미 오늘 보낸 시그널은 걸러서, **처음 발동한 것만** 돌려준다.
 */
export async function scanAlerts(
  client: KiwoomClient,
  watch: { code: string; name: string; addedPrice?: number }[],
  opts: { dryRun?: boolean } = {},
): Promise<FiredAlert[]> {
  const cfg = await getAlertConfig();
  if (!cfg.enabled || watch.length === 0) return [];

  /*
   * 시장 신호등은 **스캔 한 번에 한 번만** 받는다. 종목마다 부르면 서른 번인데
   * 그날 시장은 종목마다 다르지 않다. (안 되면 그냥 그 줄을 안 적는다)
   */
  const market = await evaluateMarket(client)
    .then((m) => ({ level: m.level, score: m.score }))
    .catch(() => null);

  const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  const state = prune(await readState());
  const out: FiredAlert[] = [];

  // 초당 5회 제한 — 종목당 3콜이므로 한 번에 2종목씩
  for (let i = 0; i < watch.length; i += 2) {
    const chunk = watch.slice(i, i + 2);
    const results = await Promise.all(
      chunk.map((w) => evaluateStock(client, w, cfg, market).catch(() => [] as FiredAlert[])),
    );
    for (const list of results) {
      for (const a of list) {
        const key = `${today}|${a.code}|${a.rule}`;
        if (state[key]) continue; // 같은 종목·같은 시그널은 하루 1회
        state[key] = new Date().toISOString();
        out.push(a);
      }
    }
    if (i + 2 < watch.length) await new Promise((r) => setTimeout(r, 700));
  }

  // dryRun이면 상태를 남기지 않는다 — 테스트가 진짜 알림을 잡아먹으면 안 된다
  if (!opts.dryRun && out.length > 0) await writeState(state);
  return out;
}

// ---------------------------------------------------------------- 메시지

const RULE_ICON: Record<AlertKey, string> = {
  priceJump: "🔴",
  volumeSurge: "📊",
  flowTurn: "🔄",
  newHigh: "🚀",
  trendAlign: "📈",
  viHit: "⚡",
  strengthJump: "📈",
  brokerExit: "🚪",
};

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * 발동한 시그널을 한 통으로 묶는다.
 * 종목별로 묶어서 보내야 스크롤이 줄고, 같은 종목이 두 조건에 걸린 게 한눈에 보인다.
 */
export function formatAlerts(alerts: FiredAlert[]): string {
  const byCode = new Map<string, FiredAlert[]>();
  for (const a of alerts) {
    const list = byCode.get(a.code) ?? [];
    list.push(a);
    byCode.set(a.code, list);
  }

  const blocks: string[] = [];
  for (const list of byCode.values()) {
    const head = list[0];
    const icons = list.map((a) => RULE_ICON[a.rule]).join("");
    const sign = head.changeRate > 0 ? "+" : "";
    blocks.push(
      [
        // 첫 줄은 「무엇이 얼마에 몇 퍼센트」 — 종목명은 개별종목분석 딥링크다
        `${icons} ${stockNameHtml(head.code, head.name)}  ${fmtInt(head.price)}  ${sign}${head.changeRate.toFixed(2)}%`,
        // 왜 울렸나 — 임계값과 같이 적어야 값의 반복이 아니라 뜻이 된다
        ...list.map((a) => `<b>${esc(a.ruleLabel)}</b> · ${esc(a.detail)}`),
        ...head.context.map((c) => esc(c)),
      ].join("\n"),
    );
  }

  const now = new Date(Date.now() + 9 * 3600_000).toISOString().slice(11, 16);
  return (
    `<b>관심종목 시그널 ${alerts.length}건</b>  ${now}\n\n` + blocks.join("\n\n")
  );
}
