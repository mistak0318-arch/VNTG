import { noteFetchFailure } from "./authGuard";

export type RawRecord = Record<string, unknown>;

/**
 * 모든 요청이 지나는 자리.
 *
 * 요청이 **네트워크 단계에서** 실패하면(=`TypeError`) 인증이 끊겼는지 한 번 확인한다.
 * 밖에서 접속할 때 Cloudflare Access 세션이 끝나면 요청이 로그인 페이지로
 * 리다이렉트되는데, 브라우저가 그걸 CORS 로 막아 여기까지는 그냥 「실패」로 온다.
 * 각 화면이 그 실패를 조용히 삼키면 **아무 말 없는 빈 칸**만 남는다.
 */
async function req(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(path, init);
  } catch (e) {
    noteFetchFailure();
    throw e;
  }
}

async function getJson<T = RawRecord>(path: string): Promise<T> {
  const res = await req(path);
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) {
    const message = (body as { error?: string }).error ?? `요청 실패 (${res.status})`;
    throw new Error(message);
  }
  return body;
}

async function postJson<T = RawRecord>(path: string, body?: unknown): Promise<T> {
  const res = await req(path, {
    method: "POST",
    ...(body === undefined
      ? {}
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const parsed = (await res.json()) as T & { error?: string };
  if (!res.ok) {
    throw new Error((parsed as { error?: string }).error ?? `요청 실패 (${res.status})`);
  }
  return parsed;
}

async function patchJson<T = RawRecord>(path: string, body?: unknown): Promise<T> {
  const res = await req(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const parsed = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error((parsed as { error?: string }).error ?? `요청 실패 (${res.status})`);
  return parsed;
}

async function putJson<T = RawRecord>(path: string, body?: unknown): Promise<T> {
  const res = await req(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const parsed = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error((parsed as { error?: string }).error ?? `요청 실패 (${res.status})`);
  return parsed;
}

async function deleteJson<T = RawRecord>(path: string): Promise<T> {
  const res = await req(path, { method: "DELETE" });
  const parsed = (await res.json()) as T & { error?: string };
  if (!res.ok) {
    throw new Error((parsed as { error?: string }).error ?? `요청 실패 (${res.status})`);
  }
  return parsed;
}

export interface StockSearchResult {
  code: string;
  name: string;
  marketName: string;
}

export type FlowSubject = "foreign" | "inst" | "mainInst" | "combined" | "foreignMain";

export const FLOW_SUBJECTS: { key: FlowSubject; label: string; short: string }[] = [
  { key: "combined", label: "합산(외국인+기관)", short: "합산" },
  { key: "foreign", label: "외국인", short: "외국인" },
  { key: "inst", label: "기관계", short: "기관" },
  { key: "mainInst", label: "메인기관(투신+연기금+사모)", short: "메인기관" },
  { key: "foreignMain", label: "외국인+메인기관", short: "외인+메인" },
];

export interface AlgoConfig {
  candidateSort: "1" | "2" | "3";
  topN: number;
  periods: number[];
  maPeriods: number[];
  requirePriceAboveMa: boolean;
  minChangeRate: number | null;
  maxChangeRate: number | null;
  minPrice: number | null;
  maxPrice: number | null;
}

export interface AlgoResult {
  code: string;
  name: string;
  market: "코스피" | "코스닥";
  curPrc: number;
  fluRt: number;
  net: Record<FlowSubject, Record<string, number>>;
  pass: Record<FlowSubject, boolean>;
  trendPass: boolean | null;
  ma: Record<string, number> | null;
}

export interface AlgoJob {
  status: "running" | "done" | "error";
  total: number;
  done: number;
  results: AlgoResult[];
  error?: string;
  config: AlgoConfig;
  usedPreviousDay: boolean;
}

export const api = {
  health: () => getJson<{ ok: boolean }>("/api/health"),
  accountSummary: () => getJson("/api/account/summary"),
  accountDeposit: () => getJson("/api/account/deposit"),
  holdings: () => getJson("/api/account/holdings"),
  manualBrokers: () => getJson<{ brokers: string[] }>("/api/account/manual/brokers"),
  manualAccounts: () => getJson<{ accounts: EvaluatedAccount[] }>("/api/account/manual"),
  manualAccountAdd: (broker: string, name: string) =>
    postJson<{ accounts: EvaluatedAccount[] }>("/api/account/manual", { broker, name }),
  manualAccountRemove: (id: string) =>
    deleteJson<{ accounts: EvaluatedAccount[] }>(`/api/account/manual/${id}`),
  manualAccountCash: (id: string, cash: number) =>
    putJson<{ accounts: EvaluatedAccount[] }>(`/api/account/manual/${id}/cash`, { cash }),
  manualHoldingAdd: (id: string, h: { code: string; name: string; avgPrice: number; qty: number }) =>
    postJson<{ accounts: EvaluatedAccount[] }>(`/api/account/manual/${id}/holdings`, h),
  manualHoldingRemove: (id: string, code: string) =>
    deleteJson<{ accounts: EvaluatedAccount[] }>(`/api/account/manual/${id}/holdings/${code}`),
  /** 호가창 — 종목 상세·종목분석이 같은 것을 쓴다 */
  /** 거래원 — 부를 때마다 시계열이 한 점씩 쌓인다 */
  /** 종목별 프로그램매매 (일자별) — 단위 백만원 */
  programTradesByStock: (code: string) => getJson<RawRecord>(`/api/market/program/${code}`),
  brokerFlow: (code: string) => getJson<BrokerFlow>(`/api/market/broker-flow/${code}`),
  orderBook: (code: string) => getJson<OrderBook>(`/api/market/orderbook/${code}`),
  stockInfo: (code: string) => getJson(`/api/market/info/${code}`),
  quote: (code: string) => getJson(`/api/market/quote/${code}`),
  dailyChart: (code: string) => getJson(`/api/market/chart/daily/${code}`),
  /** 체결금액대별 매매비중 — 소액이 사고 고액이 팔면 개인이 받는 중이다 */
  tradeSize: (code: string) =>
    getJson<{ rows: TradeSizeRow[] }>(`/api/market/trade-size/${code}`),
  opinion: (code: string) => getJson<OpinionSummary>(`/api/market/opinion/${code}`),
  weeklyChart: (code: string) => getJson(`/api/market/chart/weekly/${code}`),
  monthlyChart: (code: string) => getJson(`/api/market/chart/monthly/${code}`),
  minuteChart: (code: string, tic: string) =>
    getJson(`/api/market/chart/minute/${code}?tic_scope=${tic}`),
  investorChart: (code: string) => getJson(`/api/market/chart/investor/${code}`),
  broker: (code: string) => getJson(`/api/market/broker/${code}`),
  snapshot: (code: string) => getJson(`/api/market/snapshot/${code}`),
  credit: (code: string) => getJson(`/api/market/credit/${code}`),
  dailyDetail: (code: string, days = 30) => getJson(`/api/market/daily-detail/${code}?days=${days}`),
  strength: (code: string, mode: "time" | "daily") =>
    getJson(`/api/market/strength/${code}?mode=${mode}`),
  investorDaily: (code: string) => getJson(`/api/market/investor-daily/${code}`),
  programTrend: (code: string) => getJson(`/api/market/program/${code}`),
  sectorMood: (code: string) => getJson<MoodResult>(`/api/market/sector-mood/${code}`),
  foreignTrend: (code: string) => getJson(`/api/market/foreign/${code}`),
  shortSale: (code: string, days = 60) => getJson(`/api/market/shortsale/${code}?days=${days}`),
  stockLending: (code: string, days = 60) => getJson(`/api/market/lending/${code}?days=${days}`),
  searchStocks: (q: string) =>
    getJson<{ results: StockSearchResult[] }>(`/api/market/search?q=${encodeURIComponent(q)}`),
  volumeRanking: (market: string, sort: string) => getJson(`/api/ranking/volume?market=${market}&sort=${sort}`),
  sameNetTradeRanking: (market: string, trade: string) =>
    getJson(`/api/ranking/same-net-trade?market=${market}&trade=${trade}`),
  continuousTradeRanking: (market: string, days: string) =>
    getJson(`/api/ranking/continuous-trade?market=${market}&days=${days}`),
  algoConfigDefault: () => getJson<AlgoConfig>("/api/algo/config/default"),
  algoScanStart: (config: AlgoConfig) =>
    postJson<{ jobId: string; config: AlgoConfig }>("/api/algo/scan/start", config),
  algoScanStatus: (jobId: string) => getJson<AlgoJob>(`/api/algo/scan/status/${jobId}`),
  marketStatus: () => getJson<MarketStatus>("/api/overview/status"),
  overviewSection: <T>(name: string) => getJson<SectionResult<T>>(`/api/overview/section/${name}`),
  indexDetail: (code: string, range: IndexRange) =>
    getJson<IndexDetailData>(`/api/overview/index/${code}?range=${range}`),
  flowIntraday: (date?: string) =>
    getJson<{ day: FlowIntradayDay | null; dates: string[] }>(
      `/api/overview/flow-intraday${date ? `?date=${date}` : ""}`,
    ),
  watchlist: () => getJson<{ items: WatchItem[] }>("/api/watchlist"),
  watchGroups: () => getJson<{ groups: string[] }>("/api/watchlist/groups"),
  watchGroupAdd: (name: string) => postJson<{ groups: string[] }>("/api/watchlist/groups", { name }),
  watchGroupRename: (from: string, name: string) =>
    patchJson<{ groups: string[] }>(`/api/watchlist/groups/${encodeURIComponent(from)}`, { name }),
  /** 그룹 안 종목 순서 — 보이는 순서를 통째로 보낸다 */
  watchReorder: (group: string, codes: string[]) =>
    putJson<{ items: unknown[] }>("/api/watchlist/reorder", { group, codes }),
  /** 구분선 한 줄 넣기 */
  watchAddDivider: (group: string, label = "") =>
    postJson<{ items: unknown[] }>("/api/watchlist/divider", { group, label }),
  watchGroupReorder: (order: string[]) =>
    putJson<{ groups: string[] }>("/api/watchlist/groups/reorder", { order }),
  watchGroupRemove: (name: string) =>
    deleteJson<{ groups: string[] }>(`/api/watchlist/groups/${encodeURIComponent(name)}`),
  watchlistAdd: (item: {
    code: string;
    name: string;
    addedPrice: number;
    memo?: string;
    group?: string;
    /** 한 종목을 여러 그룹에 담을 수 있다 */
    groups?: string[];
  }) => postJson<{ items: WatchItem[] }>("/api/watchlist", item),
  /** 그룹 하나를 넣거나 뺀다 — 표에서 칩을 눌러 토글 */
  watchGroupToggle: (code: string, group: string) =>
    postJson<{ items: WatchItem[] }>(
      `/api/watchlist/${code}/groups/${encodeURIComponent(group)}`,
    ),
  watchlistSetGroup: (code: string, group: string) =>
    patchJson<{ items: WatchItem[] }>(`/api/watchlist/${code}`, { group }),
  watchStatuses: () =>
    getJson<{ statuses: { key: WatchStatus; label: string; hint: string }[] }>(
      "/api/watchlist/statuses",
    ),
  /** 관찰/대기/보유/청산 — 그룹(성격)과 **다른 축**이다 */
  watchlistSetStatus: (code: string, status: WatchStatus) =>
    patchJson<{ items: WatchItem[] }>(`/api/watchlist/${code}`, { status }),
  watchlistRemove: (code: string) => deleteJson<{ items: WatchItem[] }>(`/api/watchlist/${code}`),
  watchlistTracking: (force = false) =>
    getJson<{ items: TrackedStock[] }>(`/api/watchlist/tracking${force ? "?force=1" : ""}`),
  kiwoomGroups: () => getJson<{ groups: KiwoomGroup[] }>("/api/watchlist/kiwoom/groups"),
  kiwoomGroupStocks: (code: string) =>
    getJson<{ items: KiwoomGroupStock[] }>(`/api/watchlist/kiwoom/groups/${code}`),
  channels: () =>
    getJson<{ configured: boolean; channels: ChannelEntry[] }>("/api/channels"),
  channelsRefresh: () => postJson<{ channels: ChannelEntry[] }>("/api/channels/refresh"),
  channelsSetEnabled: (updates: { id: string; enabled: boolean }[]) =>
    putJson<{ channels: ChannelEntry[] }>("/api/channels/enabled", { updates }),
  channelsReportStatus: (jobId: string) => getJson<PublishJob>(`/api/channels/report/${jobId}`),
  /** 끝날 때까지 기다리는 옛 방식 — 진행 표시가 필요 없는 짧은 확인용 */
  channelsReportSync: (o: { ai?: boolean; send?: boolean; minutes?: number } = {}) => {
    const q = new URLSearchParams();
    if (o.ai === false) q.set("ai", "0");
    if (o.send) q.set("send", "1");
    if (o.minutes) q.set("minutes", String(o.minutes));
    return postJson<ChannelReport>(`/api/channels/report-sync${q.toString() ? "?" + q : ""}`);
  },
  /** 곧바로 jobId 를 돌려준다. 진행은 channelsReportStatus 로 폴링 */
  channelsReport: (o: { ai?: boolean; send?: boolean; minutes?: number } = {}) => {
    const q = new URLSearchParams();
    if (o.ai === false) q.set("ai", "0");
    if (o.send) q.set("send", "1");
    if (o.minutes) q.set("minutes", String(o.minutes));
    return postJson<{ jobId: string }>(`/api/channels/report${q.toString() ? "?" + q : ""}`);
  },
  askStatus: () => getJson<{ ready: boolean }>("/api/ask/status"),
  ask: (
    question: string,
    history: AskTurn[] = [],
    opts: { useSearch?: boolean; useMarketData?: boolean } = {},
  ) => postJson<AskResult>("/api/ask", { question, history, ...opts }),
  aiConfig: () =>
    getJson<{
      config: AiConfig;
      defaults: AiConfig;
      models: VisionModelOption[];
      purposes: Record<string, string>;
      fallback: string | null;
    }>("/api/ai/config"),
  aiConfigSave: (config: AiConfig) => putJson<{ config: AiConfig }>("/api/ai/config", config),
  calendarEconomic: () =>
    getJson<{ verifiedAt: string; events: { date: string; title: string }[] }>(
      "/api/calendar/economic",
    ),
  calendarEconomicInstall: () =>
    postJson<{ added: number; replaced: number; verifiedAt: string }>("/api/calendar/economic"),
  calendarVisionStatus: () =>
    getJson<{ ready: boolean; providers: string[]; models: VisionModelOption[] }>(
      "/api/calendar-vision/status",
    ),
  calendarVisionParse: (
    image: string,
    mimeType: string,
    provider?: string,
    model?: string,
  ) =>
    postJson<{
      events: ParsedEvent[];
      provider: string | null;
      model: string | null;
      inputTokens: number;
      outputTokens: number;
      error?: string;
    }>("/api/calendar-vision/parse", { image, mimeType, provider, model }),
  calendarVisionCommit: (events: ParsedEvent[], fileName: string) =>
    postJson<{ added: number }>("/api/calendar-vision/commit", { events, fileName }),
  channelReports: (limit = 10) =>
    getJson<{ reports: ChannelReport[] }>(`/api/channels/reports?limit=${limit}`),
  alertConfig: () =>
    getJson<{ config: AlertConfig; defaults: AlertConfig; channels: TelegramChannelStatus[] }>(
      "/api/alert/config",
    ),
  alertConfigSave: (config: AlertConfig) =>
    putJson<{ config: AlertConfig }>("/api/alert/config", config),
  alertScan: (send = false) =>
    postJson<{ alerts: FiredAlert[]; sent: boolean; error?: string; preview: string }>(
      `/api/alert/scan${send ? "?send=1" : ""}`,
    ),
  /** 종목 한 장 요약 — 몸값 + 오늘 수급. 서버가 조회 넷을 합쳐 준다 */
  stockSummary: (code: string) => getJson<StockSummaryData>(`/api/market/summary/${code}`),
  /** 장중 기준선 — 분봉+일봉 2회 조회다. 종목을 「들여다보는」 화면에서만 부른다 */
  intraday: (code: string) =>
    getJson<{ levels: IntradayLevels | null }>(`/api/market/intraday/${code}`),
  /** 키움 미국 세부 — 업종·프리장·52주·10호가. 한투 상세에 **얹는** 값이다(교체 아님) */
  usKiwoomDetail: (symbol: string) =>
    getJson<UsKiwoomDetailData>(`/api/us-kiwoom/detail/${encodeURIComponent(symbol)}`),
  /* 마켓 브리핑 — 셋 다 서버 캐시·파일만 읽는다. 외부 호출 0 */
  briefingTimeline: (limit = 60) =>
    getJson<{ items: BriefingEvent[] }>(`/api/briefing/timeline?limit=${limit}`),
  briefingHeat: () =>
    getJson<{ traded: boolean; tiles: BriefingTile[] }>("/api/briefing/heat"),
  briefingBrief: () =>
    getJson<{ brief: { date: string; label: string; text: string } | null }>("/api/briefing/brief"),
  backtestRules: () => getJson<{ rules: BacktestRuleDef[] }>("/api/backtest/rules"),
  backtestRun: (cfg: BacktestConfig) => postJson<{ id: string }>("/api/backtest/run", cfg),
  backtestJob: (id: string) => getJson<BacktestJob>(`/api/backtest/job/${id}`),
  /** 돌려 본 조건들 — 엣지 순 리더보드. 통찰은 실행들 사이의 비교에서 나온다 */
  backtestRuns: () =>
    getJson<{
      runs: {
        id: string;
        at: string;
        label: string;
        hit: BacktestStat;
        base: BacktestStat;
        edge: number | null;
        from: string;
        to: string;
        codes: number;
        verdict: { tone: "good" | "weak" | "thin" | "bad"; text: string };
      }[];
    }>("/api/backtest/runs"),
  /** 손절 감시 상태 — 보내지 않는다. 「감시 못 하는 자리가 몇인가」를 보는 창 */
  stopWatch: () =>
    getJson<{
      /** 들고 있는 자리 수 (복기 노트의 매수·매도를 FIFO 로 맞춘 것) */
      positions: number;
      /** 그중 손절선을 적어 둬 감시되는 자리 */
      watched: number;
      /** 손절선이 없어 감시 못 하는 자리 */
      unwatched: number;
      breaks: {
        code: string;
        name: string;
        price: number;
        stop: number;
        entry: number;
        qty: number;
        lossPct: number;
        from: string;
      }[];
      preview: string;
    }>("/api/alert/stop-watch"),
  trade: (force = false) =>
    getJson<{
      items: TradeSummary[];
      fetchedAt: string;
      configured: boolean;
      error?: string;
    }>(`/api/trade${force ? "?force=1" : ""}`),
  customThemes: (force = false) =>
    getJson<{ themes: EvaluatedTheme[]; snapshotAt: number; coverage: string }>(
      `/api/custom-themes${force ? "?force=1" : ""}`,
    ),
  disclosureAlert: () =>
    getJson<{ config: DisclosureAlertConfig; intervals: number[]; telegramReady: boolean }>(
      "/api/disclosure-alert",
    ),
  disclosureAlertSave: (config: DisclosureAlertConfig) =>
    putJson<{ config: DisclosureAlertConfig }>("/api/disclosure-alert", config),
  disclosureAlertRun: (send: boolean) =>
    postJson<DisclosureRunResult>(`/api/disclosure-alert/run${send ? "?send=1" : ""}`),
  keywordConfig: () =>
    getJson<{ config: KeywordConfig; keywords: KeywordSource[]; intervals: number[] }>("/api/keyword"),
  keywordSave: (config: KeywordConfig) =>
    putJson<{ config: KeywordConfig; keywords: KeywordSource[] }>("/api/keyword", config),
  keywordRun: (send: boolean) =>
    postJson<KeywordRunResult>(`/api/keyword/run${send ? "?send=1" : ""}`),
  usWatch: (force = false) => getJson<UsWatchResult>(`/api/us-watch${force ? "?force=1" : ""}`),
  usWatchSearch: (q: string) =>
    getJson<{ results: UsSearchResult[] }>(`/api/us-watch/search?q=${encodeURIComponent(q)}`),
  usWatchGroupAdd: (name: string, memo = "") =>
    postJson<{ groups: UsWatchGroup[] }>("/api/us-watch/groups", { name, memo }),
  usWatchGroupRemove: (id: string) =>
    deleteJson<{ groups: UsWatchGroup[] }>(`/api/us-watch/groups/${id}`),
  usWatchGroupOrder: (ids: string[]) =>
    putJson<UsWatchResult>("/api/us-watch/groups/order", { ids }),
  usWatchStockAdd: (groupId: string, symbol: string, name: string) =>
    postJson<{ groups: UsWatchGroup[] }>(`/api/us-watch/groups/${groupId}/stocks`, { symbol, name }),
  usWatchStockOrder: (groupId: string, symbols: string[]) =>
    putJson<{ groups: UsWatchGroup[] }>(`/api/us-watch/groups/${groupId}/stocks/order`, { symbols }),
  usWatchStockRemove: (groupId: string, symbol: string) =>
    deleteJson<{ groups: UsWatchGroup[] }>(`/api/us-watch/groups/${groupId}/stocks/${symbol}`),
  dartToday: (force = false) =>
    getJson<{ day: string; events: DartEvent[] }>(`/api/dart/today${force ? "?force=1" : ""}`),
  journal: () => getJson<JournalData>("/api/journal"),
  /** 내 판단 추적 — 종목마다 일봉을 받아 몇 십 초 걸릴 수 있다 */
  journalTrack: () => getJson<TradeTrackResult>("/api/journal/track"),
  journalSave: (e: Partial<JournalEntry> & { date: string }) =>
    putJson<{ entries: JournalEntry[]; stats: JournalStats }>("/api/journal", e),
  paperTrades: () => getJson<PaperResult>("/api/paper"),
  paperTradeAdd: (t: { code: string; name: string; entryPrice: number; qty: number; thesis?: string }) =>
    postJson<PaperResult>("/api/paper", t),
  paperTradeClose: (id: string, exitPrice: number, exitNote?: string) =>
    postJson<PaperResult>(`/api/paper/${id}/close`, { exitPrice, exitNote }),
  paperTradeRemove: (id: string) => deleteJson<PaperResult>(`/api/paper/${id}`),
  marketSignal: (force = false) =>
    getJson<MarketSignal>(`/api/signal/market${force ? "?force=1" : ""}`),
  signalScreenStart: (market: string, level: "green" | "yellow", limit: number, universe = "trade-value") =>
    postJson<{ jobId: string }>(
      `/api/signal/screen/start?market=${market}&level=${level}&limit=${limit}&universe=${encodeURIComponent(universe)}`,
    ),
  /** 고를 수 있는 모집단 — 서버가 정한다. 화면에 박아 두면 서버와 갈린다 */
  signalScreenUniverses: () =>
    getJson<{ universes: { key: string; label: string; hint: string }[] }>(
      "/api/signal/screen/universes",
    ),
  signalScreenStatus: (jobId: string) => getJson<ScreenJob>(`/api/signal/screen/${jobId}`),
  /** 슈퍼신호등 — 여러 목록에 동시에 걸린 초록의 관찰 목록 */
  signalSuper: () =>
    getJson<{
      entries: {
        code: string;
        name: string;
        addedDate: string;
        addedPrice: number;
        score: number;
        lists: string[];
        seenCount: number;
        lastSeenDate: string;
        price: number | null;
        changeRate: number | null;
        sinceAdded: number | null;
      }[];
      lastRunDate: string | null;
      minLists: number;
    }>("/api/signal/super"),
  signalSuperJob: () =>
    getJson<{
      status: "idle" | "running" | "done" | "error";
      step: string;
      done: number;
      total: number;
      added: number;
      error?: string;
    }>("/api/signal/super/job"),
  signalSuperRun: () =>
    postJson<{ status: string }>("/api/signal/super/run", {}),
  signalSuperRemove: (code: string) => deleteJson<{ ok: boolean }>(`/api/signal/super/${code}`),
  /** 지금 돌고 있는 찾기 — 전역 작업 띠와 화면 복귀가 본다 */
  signalScreenActive: () =>
    getJson<{
      jobs: {
        id: string;
        done: number;
        total: number;
        market: string;
        universe: string;
        universeLabel: string;
        hits: number;
      }[];
    }>("/api/signal/screen/active"),
  yahooChart: (symbol: string, range: string) =>
    getJson<YahooChart>(
      `/api/market/yahoo-chart?symbol=${encodeURIComponent(symbol)}&range=${range}`,
    ),
  usDetail: (symbol: string) => getJson<UsDetail>(`/api/market/us-detail/${encodeURIComponent(symbol)}`),
  usChart: (symbol: string, period: "D" | "W" | "M") =>
    getJson<{
      candles: { t: string; open: number; high: number; low: number; close: number; volume: number }[];
      error: string | null;
    }>(`/api/market/us-chart/${encodeURIComponent(symbol)}?period=${period}`),
  futuresChart: (code: string, period: "D" | "W" | "M", days: number) =>
    getJson<{
      code: string;
      candles: { t: string; open: number; high: number; low: number; close: number; volume: number }[];
      error: string | null;
    }>(`/api/market/futures-chart?code=${encodeURIComponent(code)}&period=${period}&days=${days}`),
  /** 표 칸 너비 — 화면 이름 → 칸 키 → 픽셀. 카드 배치와 같은 층이라 서버에 둔다 */
  columnWidths: () => getJson<Record<string, Record<string, number>>>("/api/settings/columns"),
  columnWidthsSave: (o: Record<string, Record<string, number>>) =>
    putJson<Record<string, Record<string, number>>>("/api/settings/columns", o),
  cardOrder: () => getJson<Record<string, string[]>>("/api/settings/cards"),
  cardOrderSave: (o: Record<string, string[]>) =>
    putJson<Record<string, string[]>>("/api/settings/cards", o),
  /** `saved` 는 서버에 한 번이라도 저장된 적이 있는지 — 첫 이사 때 필요하다 */
  menuPrefs: () => getJson<MenuPrefsDto & { saved: boolean }>("/api/settings/menu"),
  menuPrefsSave: (p: MenuPrefsDto) => putJson<MenuPrefsDto>("/api/settings/menu", p),
  signalTrack: () => getJson<TrackSummary>("/api/signal/track"),
  /** 시작만 시킨다 — 몇 분짜리 일이라 붙들고 기다리면 프록시가 먼저 끊는다 */
  signalTrackRun: (force = false) =>
    postJson<TrackJob>(`/api/signal/track/run${force ? "?force=1" : ""}`),
  signalTrackJob: () => getJson<TrackJob | null>("/api/signal/track/job"),
  signalTrackConfig: () => getJson<TrackConfig>("/api/signal/track/config"),
  signalTrackConfigSave: (c: TrackConfig) =>
    putJson<TrackConfig>("/api/signal/track/config", c),
  signalScreenRuns: () => getJson<{ runs: ScreenRunSummary[] }>("/api/signal/screen/runs"),
  signalScreenRun: (id: string) => getJson<ScreenRun>(`/api/signal/screen/runs/${id}`),
  signalScreenDiff: (from: string, to: string) =>
    getJson<{ added: ScreenHit[]; removed: ScreenHit[]; stayed: ScreenHit[] }>(
      `/api/signal/screen/diff?from=${from}&to=${to}`,
    ),
  reviewableReports: () =>
    getJson<{ reports: ReviewableReport[] }>("/api/report/reviewable"),
  reviewReport: (date: string, edition: string) =>
    getJson<{ result: ReviewResult | null }>(
      `/api/report/review?date=${date}&edition=${encodeURIComponent(edition)}`,
    ),
  reportSchedule: () =>
    getJson<{ schedule: { slots: EditionSlot[] }; defaults: { slots: EditionSlot[] } }>(
      "/api/report/schedule",
    ),
  reportScheduleSave: (slots: EditionSlot[]) =>
    putJson<{ schedule: { slots: EditionSlot[] } }>("/api/report/schedule", { slots }),
  /** 곧바로 jobId 를 돌려준다. 진행 상황은 reportPublishStatus 로 폴링한다 */
  reportPublishNow: (deliver = false) =>
    postJson<{ jobId: string }>("/api/report/publish-now", { deliver }),
  reportPublishStatus: (jobId: string) => getJson<PublishJob>(`/api/report/publish/${jobId}`),
  /** 지금 돌고 있는 작업 — 페이지를 옮겨도 진행 상황을 되찾으려고 */
  activeJobs: () => getJson<{ jobs: { id: string; job: PublishJob }[] }>("/api/report/jobs/active"),
  exchangeQuotes: (code: string) =>
    getJson<{ code: string; exchanges: ExchangeQuote[] }>(`/api/market/exchanges/${code}`),
  channelConfig: () =>
    getJson<{
      config: { pickAuto: PickAutoConfig; pinned: string[] };
      defaults: { pickAuto: PickAutoConfig; pinned: string[] };
      intervals: number[];
      mailConfigured: boolean;
    }>("/api/channels/config"),
  channelConfigSave: (config: { pickAuto: PickAutoConfig; pinned: string[] }) =>
    putJson<{ config: { pickAuto: PickAutoConfig; pinned: string[] } }>(
      "/api/channels/config",
      config,
    ),
  /** 고정 채널 원문 — 선별·AI 를 안 거친다 */
  channelPinned: (edition: string, limit = 3, force = false) =>
    getJson<{ posts: PinnedPost[]; health?: PinnedHealth }>(
      `/api/channels/pinned?edition=${edition}&limit=${limit}${force ? "&force=1" : ""}`,
    ),
  /** 주도주 탐색기. 뉴스는 섹터마다 네이버를 부르므로 원할 때만 켠다 */
  /** 일정 매매 — 목록은 가볍고, 추적은 종목마다 일봉을 받아 몇 십 초 걸린다 */
  /** 종가배팅 — 지금 시장 조건 */
  betGauge: () => getJson<{ day: BetGaugeDay; verdicts: BetVerdict[] }>("/api/pulse/closebet/gauge"),
  /** 과거 검증. 종목마다 일봉을 받아 몇 십 초 걸린다 */
  /*
   * 유가·환율은 **일부러 안 건다**(999). 둘은 조건별 표에서 따로 보는 쪽이 낫다 —
   * 넷을 한꺼번에 걸면 남는 날이 너무 적어서 승률이 아무 말도 못 한다.
   * 금리는 사용자가 정한 상승폭 상한을 그대로 넘긴다.
   */
  betBacktest: (
    codes: string,
    days: number,
    venue: "krx" | "nxt",
    futuresMin: number,
    y10MaxRise: number,
    y30MaxRise: number,
  ) =>
    getJson<BetBacktest>(
      `/api/pulse/closebet/backtest?codes=${encodeURIComponent(codes)}&days=${days}&venue=${venue}` +
        `&futuresMin=${futuresMin}&oilMax=999&fxMax=999` +
        `&y10MaxRise=${y10MaxRise}&y30MaxRise=${y30MaxRise}`,
    ),
  betLog: (settled = false) =>
    getJson<BetLogSummary>(`/api/pulse/closebet/log${settled ? "?settled=1" : ""}`),
  betLogRun: () => postJson<{ days: number; scored: number }>("/api/pulse/closebet/log/run"),
  eventPlays: () => getJson<{ plays: EventPlay[] }>("/api/event-plays"),
  eventPlaysTrack: () => getJson<{ plays: EventPlayResult[] }>("/api/event-plays/track"),
  eventPlaySave: (p: Partial<EventPlay>) =>
    putJson<{ plays: EventPlay[] }>("/api/event-plays", p),
  eventPlayRemove: (id: string) =>
    deleteJson<{ plays: EventPlay[] }>(`/api/event-plays/${encodeURIComponent(id)}`),
  leaderScan: (withNews = false) =>
    getJson<LeaderScan>(`/api/pulse/leaders${withNews ? "" : "?news=0"}`),
  /** 탐색기 성적 — 종목마다 일봉을 받아 몇 십 초 걸린다 */
  leaderTrack: () => getJson<LeaderTrackResult>("/api/pulse/leaders/track"),
  leaderConfig: () => getJson<LeaderConfig>("/api/pulse/leaders/config"),
  leaderConfigSave: (c: LeaderConfig) => putJson<LeaderConfig>("/api/pulse/leaders/config", c),
  pulse: (force = false) => getJson<MarketPulse>(`/api/pulse${force ? "?force=1" : ""}`),
  pulseBrief: (force = false) =>
    getJson<PulseBrief>(`/api/pulse/brief${force ? "?force=1" : ""}`),
  usKr: () => getJson<{ links: EvaluatedLink[]; themeNames: string[]; at: string }>("/api/us-kr"),
  usKrCorrelation: () => getJson<{ result: CorrelationResult | null }>("/api/us-kr/correlation"),
  usKrCorrelate: (days = 60) =>
    postJson<{ result: CorrelationResult }>(`/api/us-kr/correlation?days=${days}`),
  /**
   * 보드 화면 구성 — **서버(전역)**.
   *
   * localStorage 는 창끼리 공유돼서 창 하나가 다른 창의 구성을 덮어썼다.
   * `saved` 가 false 면 아직 서버에 올린 적이 없다는 뜻이라, 화면이 예전 로컬 값을
   * 그때 한 번 올려 준다(빈 값으로 덮어쓰면 짜 둔 구성이 사라진다).
   */
  boardPrefs: () =>
    getJson<{ presets: BoardPresetDto[]; saved: boolean }>("/api/settings/board"),
  boardPrefsSave: (presets: BoardPresetDto[]) =>
    putJson<{ presets: BoardPresetDto[] }>("/api/settings/board", { presets }),

  rankSpecs: () => getJson<{ groups: RankSpecGroup[] }>("/api/rank/specs"),
  rank: (key: string, market = "000", exchange = "3", limit = 100) =>
    getJson<RankResult>(`/api/rank/${key}?market=${market}&exchange=${exchange}&limit=${limit}`),
  sectorFlow: (subject = "foreign", window = 5) =>
    getJson<SectorFlowResult>(`/api/sector-flow?subject=${subject}&window=${window}`),
  sectorFlowStocks: (market: string, code: string) =>
    getJson<{
      stocks: { code: string; name: string; price: number; changeRate: number }[];
      /** 전 종목 등락률이 0 — 아직 장이 열리지 않았다는 뜻 */
      beforeTrading: boolean;
    }>(`/api/sector-flow/stocks?market=${market}&code=${code}`),
  sectorFlowBackfill: (days = 60) =>
    postJson<{ added: number; skipped: number; total: number }>(
      `/api/sector-flow/backfill?days=${days}`,
    ),
  customThemeCreate: (t: {
    name: string;
    memo?: string;
    codes?: string[];
    source?: "manual" | "infostock";
  }) =>
    postJson<{ themes: unknown[] }>("/api/custom-themes", t),
  customThemeUpdate: (id: string, patch: { name?: string; memo?: string; codes?: string[] }) =>
    patchJson<{ themes: unknown[] }>(`/api/custom-themes/${id}`, patch),
  customThemeRemove: (id: string) => deleteJson<{ themes: unknown[] }>(`/api/custom-themes/${id}`),
  customThemeToggleStock: (id: string, code: string) =>
    postJson<{ themes: unknown[] }>(`/api/custom-themes/${id}/stocks/${code}`),
  customThemeFromWatchlist: (name: string, group?: string, memo?: string) =>
    postJson<{ themes: unknown[] }>("/api/custom-themes/from-watchlist", { name, group, memo }),
  tradeStocks: (key: string) =>
    getJson<{
      stocks: { code: string; name: string; changeRate: number; marketCap?: number | null }[];
      from: "theme" | "sector" | "none";
      label: string;
    }>(`/api/trade/${key}/stocks`),
  /** 품목의 월별 수출·수입 시계열 (36개월) — 품목을 펼칠 때만 부른다 */
  tradeHistory: (key: string) =>
    getJson<{ months: { month: string; exportUsd: number; importUsd: number }[] }>(
      `/api/trade/${key}/history`,
    ),
  /** 품목의 나라별 상위 — 어느 나라로 얼마나 + 그 나라 안의 세부 품목 구성 */
  tradeCountries: (key: string) =>
    getJson<{
      month: string;
      watch: "export" | "import";
      rows: {
        country: string;
        exportUsd: number;
        importUsd: number;
        yoy: number | null;
        top: { name: string; usd: number; share: number }[];
      }[];
    }>(`/api/trade/${key}/countries`),
  breadth: (days = 60) =>
    getJson<{ days: number; points: BreadthPoint[]; summary: string }>(
      `/api/breadth?days=${days}`,
    ),
  signal: (code: string, force = false) =>
    getJson<SignalResult>(`/api/signal/${code}${force ? "?force=1" : ""}`),
  signalBatch: (codes: string[]) =>
    getJson<{ results: Record<string, SignalResult> }>(
      `/api/signal/batch?codes=${codes.join(",")}`,
    ),
  signalConfig: () =>
    getJson<{ config: SignalConfig; defaults: SignalConfig }>("/api/signal/config"),
  signalConfigSave: (config: SignalConfig) =>
    putJson<{ config: SignalConfig }>("/api/signal/config", config),
  notes: (code: string) => getJson<{ name: string; notes: StockNote[] }>(`/api/notes/${code}`),
  notesRecent: (limit = 30) =>
    getJson<{ items: { code: string; name: string; note: StockNote }[] }>(
      `/api/notes/recent?limit=${limit}`,
    ),
  noteAdd: (code: string, name: string, text: string) =>
    postJson<{ name: string; notes: StockNote[] }>(`/api/notes/${code}`, { name, text }),
  noteUpdate: (code: string, id: string, text: string) =>
    patchJson<{ name: string; notes: StockNote[] }>(`/api/notes/${code}/${id}`, { text }),
  noteRemove: (code: string, id: string) =>
    deleteJson<{ name: string; notes: StockNote[] }>(`/api/notes/${code}/${id}`),
  calendarList: (month?: string) =>
    getJson<{ events: CalendarEvent[] }>(`/api/calendar${month ? `?month=${month}` : ""}`),
  calendarUpcoming: (days = 14) =>
    getJson<{ events: CalendarEvent[] }>(`/api/calendar/upcoming?days=${days}`),
  calendarAdd: (e: Omit<CalendarEvent, "id">) =>
    postJson<{ events: CalendarEvent[] }>("/api/calendar", e),
  calendarSubs: () =>
    getJson<{ subs: { label: string; masked: string; url: string; count: number }[] }>(
      "/api/calendar/subs",
    ),
  calendarSubAdd: (url: string, label: string) =>
    postJson<{ added: number; events: CalendarEvent[] }>("/api/calendar/subs", { url, label }),
  calendarSubRemove: (url: string) =>
    deleteJson<{ events: CalendarEvent[] }>(`/api/calendar/subs?url=${encodeURIComponent(url)}`),
  calendarSync: () =>
    postJson<{ results: { label: string; added: number; error?: string }[]; events: CalendarEvent[] }>(
      "/api/calendar/sync",
    ),
  calendarImport: (filename: string, text: string, kind: EventKind) =>
    postJson<{ added: number; replaced: number; events: CalendarEvent[] }>("/api/calendar/import", {
      filename,
      text,
      kind,
    }),
  calendarRemove: (id: string) => deleteJson<{ events: CalendarEvent[] }>(`/api/calendar/${id}`),
  apiUsage: () => getJson<{ day: string; providers: ProviderUsage[] }>("/api/settings/usage"),
  apiUsageTotals: (days = 30) => getJson<UsageTotals>(`/api/settings/usage/totals?days=${days}`),
  apiUsageHistory: (days = 14) =>
    getJson<{ history: { day: string; counts: Record<string, number> }[] }>(
      `/api/settings/usage/history?days=${days}`,
    ),
  apiKeys: () =>
    getJson<{ keys: { name: string; configured: boolean }[]; isMock: boolean }>("/api/settings/keys"),
  news: (q: string, opts: { scope?: "major" | "all"; display?: number } = {}) =>
    getJson<{ items: NewsItem[]; counts: { major: number; all: number } }>(
      `/api/feed/news?q=${encodeURIComponent(q)}&display=${opts.display ?? 30}&scope=${opts.scope ?? "major"}`,
    ),
  publishedReport: (date?: string, edition?: string) => {
    const q = new URLSearchParams();
    if (date) q.set("date", date);
    if (edition) q.set("edition", edition);
    const qs = q.toString();
    return getJson<PublishedReportResponse>(`/api/report/published${qs ? `?${qs}` : ""}`);
  },
  reportPublish: (edition: string) =>
    postJson<{ report: PublishedReport }>("/api/report/publish", { edition }),
  reportDeliver: (date: string, edition: string) =>
    postJson<{ telegram: { ok: boolean; error?: string }; mail: { ok: boolean; error?: string } }>(
      "/api/report/deliver",
      { date, edition },
    ),
  indexIntraday: (code: string, tic = "5") =>
    getJson(`/api/market/index-intraday/${code}?tic=${tic}`),
  marketDrivers: (top = 5) => getJson<MarketDriverReport>(`/api/report/drivers?top=${top}`),
  newsSectors: (scope: "major" | "all" = "major", per = 20, sort: "importance" | "recent" = "importance") =>
    getJson<{
      sectors: { key: string; label: string; items: ScoredNews[] }[];
      fetchedAt: string;
      /** 어느 목록에서 종목을 뽑아 검색했는지 — 안 밝히면 왜 이 기사가 떴는지 모른다 */
      mineSources?: string[];
      mineNames?: string[];
    }>(
      `/api/feed/news/sectors?scope=${scope}&per=${per}&sort=${sort}`,
    ),
  /** 속보 — [속보]·[단독]·[긴급] 머리표가 붙은 것만. 증시·기업 갈래가 먼저다 */
  newsBreaking: () =>
    getJson<{
      categories: { key: string; label: string; items: NewsItem[] }[];
      fetchedAt: string;
    }>("/api/feed/news/breaking"),
  finance: (code: string) => getJson<FinanceResult>(`/api/feed/finance/${code}`),
  disclosures: (code: string, days = 180) =>
    getJson<{ items: DisclosureItem[] }>(`/api/feed/disclosures/${code}?days=${days}`),
  programTrades: (market: string, scope: string) =>
    getJson<{ items: ProgramRow[] }>(`/api/overview/program/${market}/${scope}`),
  themeStocks: (code: string) => getJson<{ items: StockRow[] }>(`/api/overview/theme/${code}/stocks`),
  sectorStocks: (market: string, code: string) =>
    getJson<{ items: StockRow[] }>(`/api/overview/sector/${market}/${code}/stocks`),
};

/** 증권사 투자의견 한 건 (한국투자증권) */
export interface OpinionItem {
  date: string;
  broker: string;
  opinionRaw: string;
  stance: "매수" | "중립" | "매도" | "기타";
  prevStance: "매수" | "중립" | "매도" | "기타";
  /** 직전 대비 상향(+1)·하향(-1)·유지(0) */
  move: number;
  goalPrice: number | null;
  prevGoalPrice: number | null;
  /** 같은 증권사의 직전 목표가 대비 % */
  goalChange: number | null;
}

export interface OpinionSummary {
  code: string;
  items: OpinionItem[];
  brokerCount: number;
  goalMedian: number | null;
  goalMin: number | null;
  goalMax: number | null;
  upside: number | null;
  price: number | null;
  stanceCount: { 매수: number; 중립: number; 매도: number; 기타: number };
  goalTrend: number | null;
  truncated: boolean;
  upgrades: OpinionItem[];
  downgrades: OpinionItem[];
  fetchedAt: string;
}

export interface WatchItem {
  /**
   * 그룹 안에서의 자리 — 그룹 이름 → 순번. 없으면 맨 아래(새로 담은 것).
   * 한 종목이 여러 그룹에 드므로 **그룹마다 따로** 둔다.
   */
  order?: Record<string, number>;
  /** 구분선인가 — 종목이 아니라 눈으로 묶음을 가르는 빈 줄 */
  divider?: boolean;
  code: string;
  name: string;
  addedAt: string;
  addedPrice: number;
  memo: string;
  /** @deprecated 한 그룹만 담던 옛 필드 */
  group?: string;
  /** 소속 그룹들 — 한 종목이 여러 그룹에 담긴다 */
  groups: string[];
  /**
   * 지금 이 종목과 나의 관계 — **그룹(성격)과 다른 축**이다.
   * 같은 종목이 「반도체」이면서 동시에 「진입 대기」일 수 있다.
   */
  status?: WatchStatus;
}

export type WatchStatus = "watching" | "ready" | "holding" | "closed";

export interface KiwoomGroup {
  code: string;
  name: string;
}

export interface KiwoomGroupStock {
  code: string;
  name: string;
  price: number;
  change: number;
  changeRate: number;
  volume: number;
  tradeAmount: number;
}

export interface TrackedStock extends WatchItem {
  price: number;
  changeRate: number;
  returnRate: number | null;
  foreign5: number;
  foreign10: number;
  foreign20: number;
  inst5: number;
  inst60: number;
  /** 종가가 5일선/20일선 위인가 */
  above5: boolean | null;
  above20: boolean | null;
  /** 최근 3일 추세 +1 늘었다 / -1 줄었다 / 0 그대로 / null 모름 */
  shortTrend: number | null;
  lendingTrend: number | null;
  profitUp: boolean | null;
  sectorStrong: boolean | null;
  /** 조건 충족 수 / 판단 가능한 수 */
  passCount: number;
  passTotal: number;
  /** 목표가(컨센서스 중앙값)까지 남은 폭 % */
  upside: number | null;
  /** 최근 60일 의견 변경: +1 상향, -1 하향, 0 없음 */
  opinionMove: number | null;
  brokerCount: number | null;
  inst20: number;
  trendPass: boolean | null;
  ma5: number | null;
  ma20: number | null;
  ma60: number | null;
  ma120: number | null;
  error: string | null;
}

export interface MarketStatus {
  state: "pre" | "open" | "closed" | "holiday";
  label: string;
  /** 지금 체결이 도는가 — NXT 시간외(08:00~09:00, 15:30~20:00)를 포함한다 */
  live?: boolean;
  venue?: "none" | "nxt" | "krx";
}

export interface SectionResult<T> {
  data: T | null;
  updatedAt: number | null;
  error: string | null;
  stale: boolean;
}

export interface IndexCard {
  code: string;
  name: string;
  price: number;
  change: number;
  changeRate: number;
  sparkline: number[];
  upperLimit: number;
  rising: number;
  flat: number;
  falling: number;
  lowerLimit: number;
  /** 코스피200 에만 붙는다 — 그 옆의 선물 (한국투자증권) */
  futures?: FuturesQuote | null;
}

export interface FuturesQuote {
  code: string;
  name: string;
  price: number | null;
  change: number | null;
  changeRate: number | null;
  theoretical: number | null;
  openInterest: number | null;
  volume: number | null;
  /** 선물 − 현물. 음수면 백워데이션이고 프로그램 매도가 붙기 쉽다 */
  basis: number | null;
}

export interface FlowSample {
  /** HHmm (한국시간) */
  t: string;
  foreign: number;
  institution: number;
  individual: number;
}

export interface FlowIntradayDay {
  date: string;
  kospi: FlowSample[];
  kosdaq: FlowSample[];
}

export type IndexRange = "day" | "week" | "month";

export interface IndexCandle {
  dt: string;
  open: number;
  high: number;
  low: number;
  close: number;
  /** 그날 시장 전체 거래대금(억원) — 지수가 오르는 날과 돈이 들어오는 날은 다르다 */
  tradeValue: number;
  /** 거래량(천주) */
  volume: number;
}

export interface IndexFlowRow {
  date: string;
  changeRate: number;
  foreign: number;
  institution: number;
  individual: number;
  pension: number;
  trust: number;
}

export interface IndexDetailData {
  code: string;
  name: string;
  range: IndexRange;
  candles: IndexCandle[];
  flows: IndexFlowRow[];
}

export interface TradeSizeRow {
  /** "3백이하", "5억초과" 같은 구간 이름 */
  band: string;
  buyQty: number;
  sellQty: number;
  totalQty: number;
  netQty: number;
  buyRate: number;
  sellRate: number;
  netRate: number;
  buyAvgPrice: number;
  sellAvgPrice: number;
}

export interface TopTraderRow {
  rank: number;
  code: string;
  name: string;
  price: number;
  changeRate: number;
  /** 순매수 금액 (억원) */
  netAmount: number;
  netQty: number;
  /** 이 종목을 들고 있는 상위 계좌 수 */
  accounts: number;
  avgBuyPrice: number;
  /** 그 계좌들의 수익률(%) */
  profitRate: number;
}

export interface RateRow {
  code: string;
  name: string;
  /** 금리 (%) */
  rate: number | null;
  /** 전일대비 (%p) — 등락률이 아니다 */
  change: number | null;
  group: "국내" | "해외";
}

/** 미장 표의 줄 단위 경고 — 신호등(green/yellow/red)과는 다른 개념이다 */
export type RowLevel = "danger" | "warn" | "ok";

export interface RowSignal {
  level: RowLevel;
  why: string;
}

export interface UsMajorRow {
  key: string;
  label: string;
  symbol: string;
  price: number | null;
  change: number | null;
  changeRate: number | null;
  /** 금리는 값 자체가 % 다 */
  isRate: boolean;
  digits: number;
  quotedAt: number | null;
  /** 어디서 받은 값인가 — 야후가 막히면 한투로 메운다 */
  source: "yahoo" | "hantoo";
  /** 지금 눈여겨볼 상태인가 (없으면 평범한 것) */
  signal: RowSignal | null;
  error: string | null;
}

export interface UsBoardSignal {
  level: "green" | "yellow" | "red";
  summary: string;
  reasons: string[];
}

export interface UsMajorResult {
  /** 줄 경고들을 한 덩어리로 굴린 판정. 판정은 서버에서만 한다 */
  boardSignal: UsBoardSignal;
  rows: UsMajorRow[];
  /** 코스피 야간선물 — 이것만 지금 움직인다 */
  nightFutures: UsMajorRow | null;
  /** 장단기 금리차 한 줄 */
  curveNote: string | null;
  fetchedAt: number;
}

export interface InvestorFlow {
  individual: number;
  foreign: number;
  institution: number;
  financialInvestment: number;
  investmentTrust: number;
  pensionFund: number;
  privateFund: number;
  insurance: number;
  bank: number;
  otherFinance: number;
  nation: number;
  otherCorp: number;
}

export interface MarketFlow {
  kospi: InvestorFlow;
  kosdaq: InvestorFlow;
}

/** 시가총액(marketCap)은 억원 단위. 상장주식수를 못 찾으면 null */
export interface EvaluatedHolding {
  code: string;
  name: string;
  avgPrice: number;
  qty: number;
  price: number;
  changeRate: number;
  value: number;
  cost: number;
  profit: number;
  returnRate: number | null;
}

export interface EvaluatedAccount {
  id: string;
  broker: string;
  name: string;
  holdings: EvaluatedHolding[];
  totalCost: number;
  /** 주식 평가금액 */
  totalValue: number;
  totalProfit: number;
  totalReturnRate: number | null;
  /** 예수금 */
  cash: number;
  /** 주식 + 예수금 = 실제 잔고 */
  totalAssets: number;
  /** 총자산 대비 주식 비중(%) */
  stockRatio: number | null;
  cashUpdatedAt?: string;
}

export interface AskTurn {
  role: "user" | "assistant";
  text: string;
}

export interface AskResult {
  text: string | null;
  searches: string[];
  sources: { title: string; url: string }[];
  inputTokens: number;
  outputTokens: number;
  model: string;
  error?: string;
}

export interface AiChoice {
  provider: string;
  model: string;
}

export interface AiConfig {
  report: AiChoice | null;
  channel: AiChoice | null;
  research: AiChoice | null;
  /** 시황 질문하기 — Claude 만 고를 수 있다 */
  ask: AiChoice | null;
  /** 시장 흐름 요약. 안 고르면 report 를 따라간다 */
  pulse: AiChoice | null;
}

export interface VisionModelOption {
  provider: string;
  model: string;
  label: string;
  hint: string;
}

export interface ParsedEvent {
  date: string;
  time?: string;
  title: string;
  kind: string;
  memo?: string;
}

export interface ChannelEntry {
  id: string;
  name: string;
  username: string | null;
  broadcast: boolean;
  participants: number | null;
  lastAt: string | null;
  enabled: boolean;
}

/** 고정 채널이 어디서 막혔나 — 빈 목록만으로는 원인을 못 가린다 */
export interface PinnedHealth {
  triedAt: string | null;
  /** 마지막으로 **글을 실제로 가져온** 시각 */
  okAt: string | null;
  okCount: number;
  stage: string | null;
  pinned: string[];
  visible: string[];
  detail: string;
}

export interface PinnedPost {
  channelName: string;
  username: string | null;
  at: string;
  text: string;
  link: string;
}

export interface ScoredChannelItem {
  text: string;
  at: string;
  channels: string[];
  channelName?: string;
  link?: string;
  coverage: number;
  mentions: string[];
  /** 본문에서 찾아낸 종목 (관심종목 + 내 테마 종목). 비어 있으면 못 찾은 것 */
  stocks?: string[];
  /** 그 종목들이 속한 내 테마 */
  themes?: string[];
  score: number;
}

export interface ChannelReport {
  date: string;
  generatedAt: string;
  channels: number;
  rawCount: number;
  usedCount: number;
  items: ScoredChannelItem[];
  summary: string | null;
  inputTokens: number;
  outputTokens: number;
  error?: string;
  skipped: string[];
  /** 몇 시간치를 훑었는지 */
  windowMinutes?: number;
  /** 실제로 잡힌 메시지의 시각 범위 */
  oldestAt?: string | null;
  newestAt?: string | null;
}

export interface AlertRule {
  key: string;
  label: string;
  enabled: boolean;
  threshold: number;
  hint: string;
}

export interface AlertConfig {
  enabled: boolean;
  intervalMin: number;
  rules: AlertRule[];
}

export interface TelegramChannelStatus {
  channel: "report" | "signal" | "log";
  chatId: string;
  dedicated: boolean;
}

export interface FiredAlert {
  code: string;
  name: string;
  rule: string;
  ruleLabel: string;
  detail: string;
  price: number;
  changeRate: number;
  context: string[];
}

export interface EvaluatedTheme {
  id: string;
  name: string;
  memo: string;
  codes: string[];
  color: string;
  createdAt: string;
  /** 시총 가중평균 등락률 */
  changeRate: number | null;
  /** 단순평균 — 가중과 크게 다르면 대형주가 끌고 있다는 뜻 */
  simpleRate: number | null;
  stocks: {
    code: string;
    name: string;
    changeRate: number;
    marketCap: number | null;
    weight: number | null;
    found: boolean;
  }[];
  risingCount: number;
  fallingCount: number;
  missing: number;
  /** manual = 내가 만든 것, infostock = 인포스탁 테마표에서 옮겨온 것 */
  source?: "manual" | "infostock";
}

/** 리포트 발행 판 하나 */
export interface ScreenHit {
  code: string;
  name: string;
  price: number;
  changeRate: number;
  /** 거래대금(백만원). 개장 전에 돌리면 0 — 메울 재료가 없어 화면이 「-」로 적는다 */
  tradeValue: number;
  level: "green" | "yellow" | "red" | "unknown";
  score: number;
  passed: string[];
  failed: string[];
  /** 개장 전이라 등락률·현재가를 **직전 거래일 값**으로 메운 줄 */
  stale?: boolean;
}

export interface ScreenJob {
  status: "running" | "done" | "error";
  total: number;
  done: number;
  results: ScreenHit[];
  market: string;
  minLevel: string;
  /** 어느 목록에서 찾았나 — 예전 기록에는 없다(거래대금 상위였다) */
  universe?: string;
  startedAt: string;
  error?: string;
}

export interface ScreenRunSummary {
  id: string;
  at: string;
  market: string;
  minLevel: string;
  universe?: string;
  total: number;
  hits: number;
}

export interface ScreenRun extends ScreenRunSummary {
  results: ScreenHit[];
}

export interface ReviewableReport {
  date: string;
  edition: string;
  label: string;
  publishedAt: string;
  count: number;
  /** 발행 후 며칠 지났나. 0이면 아직 채점할 수 없다 */
  elapsedDays: number;
}

export interface ScoredCheckpoint {
  kind: "stock" | "theme" | "market";
  key: string;
  label: string;
  direction: "up" | "down" | "flat";
  reason: string;
  basePrice: number | null;
  lastPrice: number | null;
  /** 실제 등락률(%) */
  actual: number | null;
  verdict: "hit" | "miss" | "partial" | "pending" | "unknown";
  note: string;
}

export interface ReviewResult {
  date: string;
  edition: string;
  label: string;
  publishedAt: string;
  elapsedDays: number;
  items: ScoredCheckpoint[];
  hit: number;
  miss: number;
  partial: number;
}

export interface EditionSlot {
  id: string;
  label: string;
  hour: number;
  minute: number;
  /** 어떤 프롬프트를 쓸지 */
  kind: "morning" | "intraday" | "closing" | "weekend";
  enabled: boolean;
  days: "weekday" | "weekend" | "always";
  /** 발행 후 텔레그램·메일로 보낼지 */
  deliver: boolean;
}

export interface PickAutoConfig {
  enabled: boolean;
  /** 발송 주기(분) */
  intervalMin: number;
  /** 몇 시간치를 훑을지 */
  windowHours: number;
  telegram: boolean;
  mail: boolean;
  weekdayOnly: boolean;
  startHour: number;
  endHour: number;
}

export interface ExchangeQuote {
  key: "krx" | "nxt" | "all";
  label: string;
  price: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
  /** 거래대금(백만원) — 08~09시 NXT 프리마켓에는 KRX 쪽이 0 이라 이게 있어야 한다 */
  tradeValue: number | null;
  /** 상장주식수(천주) — 회전율의 분모 */
  shares: number | null;
  changeRate: number;
  error: string | null;
}

export interface UsQuote {
  symbol: string;
  name: string;
  price: number | null;
  changeRate: number | null;
  error: string | null;
}

export interface LinkStat {
  us: string;
  kr: string;
  /** 미국 D일 → 국내 D+1일 상관계수 */
  corr: number;
  /** 미국 1% 당 국내 평균 % */
  beta: number;
  samples: number;
}

export interface CorrelationResult {
  at: string;
  days: number;
  pairs: {
    label: string; us: string; kr: string;
    sameDay: number | null; nextDay: number | null;
    samples: number; beta: number | null;
  }[];
  krFetched: number;
  krFailed: number;
}

export interface EvaluatedLink {
  label: string;
  us: string[];
  kr: string[];
  memo?: string;
  usQuotes: UsQuote[];
  usAvg: number | null;
  krThemes: { name: string; changeRate: number | null; found: boolean }[];
  krAvg: number | null;
  /** 미국 대비 국내가 얼마나 따라왔는가(%p) */
  gap: number | null;
  /** 검증된 연동 강도. 아직 계산 전이면 null */
  stat: LinkStat | null;
  /** 평소 연동대로면 국내가 갔어야 할 등락률 */
  expected: number | null;
  /** 기대 대비 실제(%p) */
  surprise: number | null;
}

export interface RankSpecGroup {
  group: string;
  items: { key: string; label: string }[];
}

export interface RankResult {
  spec: {
    key: string;
    label: string;
    columns: { key: string; label: string; type?: "text" | "price" | "num" | "pct" }[];
    exchange: boolean;
    note: string;
  };
  market: string;
  exchange: string;
  /**
   * code·name 은 항상 있고, 나머지는 명세의 컬럼 키로 들어온다.
   *
   * `cap`·`tv`·`mkt`·`sector`·`common` 은 **거르라고 서버가 얹어 주는 값**이다 —
   * 키움 순위 TR 에는 시가총액이 없어서 종목 목록(하루 캐시)에서 붙인다.
   */
  rows: (Record<string, unknown> & {
    code: string;
    name: string;
    /** 시가총액(억원). 상장주식수를 못 찾으면 null */
    cap: number | null;
    /** 거래대금(억원). 못 내면 null */
    tv: number | null;
    /** 거래대금이 어림값(거래량 × 현재가)인가 */
    tvEst: boolean;
    /** KRX 몫의 거래대금(억원). `tv` 는 통합(=KRX+NXT)이다 */
    tvKrx: number | null;
    /** 회전율(%) — 거래량 ÷ 상장주식수. 「그 종목 치고 얼마나 돌았나」 */
    turn: number | null;
    /** 코스피 / 코스닥 */
    mkt: string;
    sector: string;
    /** ETF·ETN·리츠·우선주가 아닌 보통주인가 */
    common: boolean;
  })[];
}

export interface SectorFlowStat {
  code: string;
  name: string;
  /** "코스피 전기/전자" */
  label: string;
  market: "kospi" | "kosdaq";
  /** 기간 누적 순매수(억원) */
  sum: number;
  today: number;
  delta: number;
  rank: number;
  /** 직전 기간 대비 순위 변화. +면 올라온 것 */
  rankChange: number | null;
}

export interface SectorConsensus {
  code: string;
  name: string;
  label: string;
  market: "kospi" | "kosdaq";
  /** consensusSubjects 순서대로의 기간 누적 */
  values: number[];
  /** 같은 방향으로 움직인 주체 수 */
  agree: number;
  side: 1 | -1;
  total: number;
}

export interface SectorFlowResult {
  subject: string;
  subjectLabel: string;
  window: number;
  dates: string[];
  stats: SectorFlowStat[];
  streaks: {
    code: string;
    name: string;
    label: string;
    market: "kospi" | "kosdaq";
    streak: number;
    sum: number;
  }[];
  splits: {
    code: string;
    name: string;
    label: string;
    market: "kospi" | "kosdaq";
    pension: number;
    trust: number;
  }[];
  /** 여러 주체가 같은 방향으로 움직인 업종 */
  consensusBuy: SectorConsensus[];
  consensusSell: SectorConsensus[];
  /** values 배열의 순서와 이름 */
  consensusSubjects: { key: string; label: string }[];
  sizes: { label: string; foreign: number; institution: number }[];
  subjects: { key: string; label: string }[];
}

export interface TradeSummary {
  key: string;
  label: string;
  hs: string;
  sectors: string[];
  note: string;
  /** 이 품목에서 봐야 할 쪽. 원유처럼 사오기만 하는 품목은 수입을 본다 */
  watch: "export" | "import";
  month: string;
  exportUsd: number;
  importUsd: number;
  balanceUsd: number;
  exportYoy: number | null;
  importYoy: number | null;
  top: { name: string; exportUsd: number; yoy: number | null }[];
}

export interface BreadthPoint {
  date: string;
  advanceDecline: number;
  adLine: number;
  risingPct: number;
  newHigh: number;
  newLow: number;
  highLowDiff: number;
  kospiRate: number;
  kosdaqRate: number;
  foreign: number;
  institution: number;
  individual: number;
  foreignCum: number;
  instCum: number;
  individualCum: number;
}

export type SignalLevel = "green" | "yellow" | "red" | "unknown";

export type SignalAxis = "trend" | "flow" | "value" | "risk";

export interface SignalCheck {
  key: string;
  label: string;
  axis: SignalAxis;
  /** 0 · 50 · 100. 판단 불가면 null */
  grade: number | null;
  /**
   * 통과 여부. 일반 기준은 grade >= 50, **위험 기준은 반대로** grade < 50(안전)이 통과다.
   * 그래서 위험 기준의 이름은 「매물 부담 낮음」처럼 안전한 상태로 적혀 있다.
   */
  pass: boolean | null;
  value: string;
  weight: number;
  link?: { kind: "sector" | "theme"; code: string; name: string };
}

export interface SignalAxisResult {
  key: SignalAxis;
  label: string;
  /** 0~100. 위험 축은 **위험도**(높을수록 나쁘다), 나머지는 높을수록 좋다 */
  score: number | null;
  level: SignalLevel;
}

export interface SignalResult {
  code: string;
  level: SignalLevel;
  /** 추세·수급·실적 세 축의 가중평균. 위험은 섞지 않는다 */
  score: number;
  checks: SignalCheck[];
  axes: SignalAxisResult[];
  /** 위험이 빨강이라 초록이 막혔나 */
  riskCapped: boolean;
  evaluatedAt: string;
}

export interface SignalCheckConfig {
  key: string;
  label: string;
  axis: SignalAxis;
  enabled: boolean;
  weight: number;
  /** 50점 선 */
  threshold: number;
  /** 100점 선 */
  strongAt: number;
  hint: string;
  /** 켜면 종목당 조회가 몇 번 더 나가나 — 「신호등 찾기」 100종목이면 그 100배다 */
  cost: number;
  /** 같은 호출을 나눠 쓰는 기준끼리 묶는 이름. 비용을 셀 때 묶음마다 한 번만 센다 */
  costGroup?: string;
}

export interface SignalConfig {
  checks: SignalCheckConfig[];
  greenAt: number;
  yellowAt: number;
  flowDays: 5 | 10 | 20;
  maLines: number[];
  /** 축끼리의 가중치 */
  axisWeights: Record<"trend" | "flow" | "value", number>;
  /** 위험도가 이 이상이면 노랑 */
  riskYellowAt: number;
  /** 위험도가 이 이상이면 빨강 */
  riskRedAt: number;
  /** 위험이 빨강이면 종합을 초록으로 올리지 않는다 */
  riskBlocksGreen: boolean;
}

export interface StockNote {
  id: string;
  at: string;
  price: number;
  changeRate: number;
  text: string;
}

export type EventKind = "market" | "personal" | "earnings" | "holiday";

export interface CalendarEvent {
  id: string;
  date: string;
  time?: string;
  title: string;
  kind: EventKind;
  memo?: string;
}

export interface AiSummary {
  text: string | null;
  basedOn: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  error?: string;
  digest?: string;
}

export interface PublishedReport {
  date: string;
  edition: string;
  label: string;
  publishedAt: string;
  summary: AiSummary;
}

export interface PublishedReportResponse {
  report: PublishedReport | null;
  requested: { date: string; edition: string };
  editions: { key: string; label: string; hour: number }[];
  recent: { date: string; edition: string }[];
}

export interface ThemeWithReason {
  code: string;
  name: string;
  changeRate: number;
  stockCount: number;
  mainStock: string;
  reasons: ScoredNews[];
}

export interface SectorWithReason {
  code: string;
  name: string;
  changeRate: number;
  market: "코스피" | "코스닥";
  reasons: ScoredNews[];
}

/** 웹·메일·텔레그램이 공유하는 리포트 조립 결과 */
export interface MarketDriverReport {
  fetchedAt: string;
  themes: { up: ThemeWithReason[]; down: ThemeWithReason[] };
  sectors: SectorWithReason[];
}

export interface StockRow {
  marketCap?: number | null;
  code: string;
  name: string;
  price: number;
  change: number;
  changeRate: number;
}

export interface SectorRow {
  code: string;
  name: string;
  changeRate: number;
}

export interface ThemeRow {
  code: string;
  name: string;
  changeRate: number;
  stockCount: number;
  mainStock: string;
}

export interface GlobalQuote {
  key: string;
  label: string;
  group: string;
  symbol: string;
  price: number | null;
  change: number | null;
  changeRate: number | null;
  isRate: boolean;
  error: string | null;
  /** 묶음 색 — 서버가 정한다. 시황과 리포트가 같은 색을 쓰게 하려는 것이다 */
  color: string;
  /** 줄 단위 경고. 색만 있으면 왜 빨간지 모르므로 why 를 같이 준다 */
  signal: RowSignal | null;
}

export interface ProviderUsage {
  provider: string;
  label: string;
  limit: number | null;
  note: string;
  total: number;
  ok: number;
  failed: number;
  rateLimited: number;
  usageRate: number | null;
  topEndpoints: { endpoint: string; count: number }[];
  /** 실패 사유별 — 실패 건수만 보면 무엇을 고쳐야 할지 알 수 없다 */
  failReasons: { reason: string; count: number }[];
  /** AI provider 전용 — 토큰과 추정 비용(USD) */
  tokens: {
    input: number;
    output: number;
    cacheWrite: number;
    cacheRead: number;
    webSearches: number;
    estimatedUsd: number;
    byModel: { model: string; calls: number; input: number; output: number; usd: number }[];
    byFeature: { feature: string; label: string; calls: number; usd: number }[];
    detail: {
      feature: string;
      label: string;
      model: string;
      calls: number;
      input: number;
      output: number;
      usd: number;
    }[];
    hasLegacy: boolean;
  } | null;
}

export interface UsageTotals {
  from: string;
  to: string;
  days: number;
  estimatedUsd: number;
  byFeature: { feature: string; label: string; calls: number; usd: number }[];
  byModel: { model: string; calls: number; input: number; output: number; usd: number }[];
  byDay: { day: string; usd: number }[];
  hasLegacy: boolean;
}

export interface FinancialPeriod {
  label: string;
  revenue: number | null;
  operatingProfit: number | null;
  netIncome: number | null;
  assets: number | null;
  liabilities: number | null;
  equity: number | null;
}

export interface DividendInfo {
  yieldRate: number | null;
  perShare: number | null;
  payoutRatio: number | null;
  eps: number | null;
}

export interface QuarterRow {
  period: string;
  /** 2026 3Q */
  label: string;
  /** **그 분기만의** 값 (한투가 주는 누적을 되돌린 것). 단위 억원 */
  revenue: number | null;
  operatingProfit: number | null;
  netIncome: number | null;
  /** 영업이익률 (%) */
  margin: number | null;
  /** 직전 분기 대비 영업이익 증감률 (%) */
  qoq: number | null;
  /** 1년 전 같은 분기 대비 (%) */
  yoy: number | null;
}

export interface EstimateColumn {
  /** 2026.12E 처럼 뒤에 E 가 붙으면 추정치다 */
  period: string;
  revenue: number | null;
  revenueGrowth: number | null;
  operatingProfit: number | null;
  operatingGrowth: number | null;
  netIncome: number | null;
  netGrowth: number | null;
  roe: number | null;
  debtRatio: number | null;
  per: number | null;
  eps: number | null;
}

export interface EstimateResult {
  code: string;
  name: string;
  opinion: string | null;
  estimatedAt: string | null;
  columns: EstimateColumn[];
}

export interface FinanceResult {
  basis: "연결" | "별도" | null;
  /** DART 연간 — 단위는 **원**이다 */
  periods: FinancialPeriod[];
  /** 한투 분기 — 단위는 **억원**이다. 연간과 단위가 다르니 섞어 쓰면 안 된다 */
  quarters: QuarterRow[];
  /** 애널리스트 추정 (한투). 160여 개 대형주만 있고 없으면 null 이다 */
  estimate: EstimateResult | null;
  dividend: DividendInfo | null;
  note: string | null;
}

export interface SectorMood {
  code: string;
  name: string;
  changeRate: number;
  rank: number | null;
  total: number | null;
  market: "코스피" | "코스닥";
  marketKey: "kospi" | "kosdaq";
}

export interface ThemeMood {
  code: string;
  name: string;
  changeRate: number;
  stockCount: number;
  risingCount: number;
  fallingCount: number;
  periodReturn: number;
  mainStocks: string;
}

export interface MoodResult {
  sector: SectorMood | null;
  themes: ThemeMood[];
  note?: string;
  /** 표준산업분류 (한투). 키움 업종보다 자세하다 — 등락률은 없고 이름만 있다 */
  industry?: string | null;
}

export interface NewsItem {
  title: string;
  press: string;
  link: string;
  originalLink: string;
  publishedAt: string;
  major: boolean;
  summary: string;
}

/** 섹터 뉴스는 점수·보도량 정보가 더 붙는다 */
export interface ScoredNews extends NewsItem {
  coverage: number;
  alsoPress: string[];
  mentions: string[];
  score: number;
}

export interface DisclosureItem {
  reportName: string;
  filerName: string;
  receiptDate: string;
  receiptNo: string;
  url: string;
}

export interface ProgramRow {
  time: string;
  arbSell: number;
  arbBuy: number;
  arbNet: number;
  nonArbSell: number;
  nonArbBuy: number;
  nonArbNet: number;
  allSell: number;
  allBuy: number;
  allNet: number;
}

export interface ViRow {
  code: string;
  name: string;
  motionPrice: number;
  openChangeRate: number;
  releaseTime: string;
  motionCount: number;
}

/** 콤마 포함 숫자 포맷. 값이 숫자가 아니면 "-" */
export function fmtNum(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "-";
  return n.toLocaleString("ko-KR");
}

/** cur_prc 등 "부호가 포함된 숫자"로 오는 가격 필드용 - 절댓값으로 표시 */
export function fmtAbsNum(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "-";
  return Math.abs(n).toLocaleString("ko-KR");
}

/** 양수면 positive(빨강), 음수면 negative(파랑) 클래스 */
export function signClass(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return "";
  return n > 0 ? "positive" : "negative";
}

/**
 * 키움 응답 필드는 문서 접근 없이는 100% 확정하기 어려워, 흔히 쓰이는 후보 키 여러 개를
 * 순서대로 시도해서 값을 찾는다. 실제 응답을 콘솔/원본 JSON 뷰로 확인 후 필요하면
 * 이 목록에 실제 필드명을 추가하면 된다.
 */
export function pick(record: RawRecord | undefined, keys: string[]): string {
  if (!record) return "-";
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && value !== "") {
      return String(value);
    }
  }
  return "-";
}

export function pickList(record: RawRecord | undefined, keys: string[]): RawRecord[] {
  if (!record) return [];
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return value as RawRecord[];
  }
  // 후보 키에 못 찾으면, 배열 타입인 첫 필드를 자동으로 사용
  for (const value of Object.values(record)) {
    if (Array.isArray(value)) return value as RawRecord[];
  }
  return [];
}

/**
 * 종목코드를 순수 6자리로 정규화한다.
 * 키움은 응답에 따라 접두어("A005930": 주식/J:ELW/Q:ETN)나
 * 거래소 접미어("226340_AL": 통합, "_NX": NXT)를 붙여 보낸다.
 */
export function normalizeStockCode(code: string): string {
  const withoutSuffix = code.replace(/_(AL|NX)$/, "");
  return /^[A-Z]\d{6}$/.test(withoutSuffix) ? withoutSuffix.slice(1) : withoutSuffix;
}

/** 발행 진행 상황 — 서버가 단계별로 채운다 */
export type JobKind = "report" | "channel";

export interface ProgressStep {
  key: string;
  label: string;
  state: "pending" | "running" | "done" | "failed" | "skipped";
  note?: string;
  ms?: number;
}

export interface PublishJob {
  status: "running" | "done" | "error";
  /** 어느 화면이 시작한 작업인가 — 돌아왔을 때 자기 작업을 되찾는 데 쓴다 */
  kind: JobKind;
  label: string;
  steps: ProgressStep[];
  startedAt: string;
  report?: { date: string; edition: string; label: string };
  error?: string;
}


/** 시장 전체 신호등 */
export interface MarketCheck {
  key: string;
  label: string;
  pass: boolean | null;
  value: string;
  why: string;
  weight: number;
}

export interface MarketSignal {
  level: "green" | "yellow" | "red" | "unknown";
  score: number;
  checks: MarketCheck[];
  summary: string;
  evaluatedAt: string;
}


/** 모의투자 */
export interface EntryEvidence {
  level: "green" | "yellow" | "red" | "unknown";
  score: number;
  checks: { key: string; label: string; pass: boolean | null; value: string }[];
  market: { level: string; score: number; summary: string } | null;
  themes: { name: string; changeRate: number | null }[];
  sector: { name: string; foreign5: number; inst5: number } | null;
  marketBreadth: string | null;
}

export interface EvaluatedTrade {
  id: string;
  code: string;
  name: string;
  entryAt: string;
  entryPrice: number;
  qty: number;
  thesis: string;
  evidence: EntryEvidence;
  exitAt?: string | null;
  exitPrice?: number | null;
  exitNote?: string | null;
  price: number;
  pnl: number;
  returnRate: number;
  open: boolean;
  holdingDays: number;
}

export interface EvidenceEdge {
  key: string;
  label: string;
  withCount: number;
  withWinRate: number | null;
  withAvgReturn: number | null;
  withoutCount: number;
  withoutWinRate: number | null;
  withoutAvgReturn: number | null;
  edge: number | null;
}

export interface PaperResult {
  trades: EvaluatedTrade[];
  stats: {
    invested: number;
    value: number;
    pnl: number;
    returnRate: number;
    openCount: number;
    closedCount: number;
    winRate: number | null;
    avgReturn: number | null;
  };
  edges: EvidenceEdge[];
}


/** 종목 한 장 요약 */
export interface StockSummaryData {
  code: string;
  date: string;
  facts: {
    price: number;
    changeRate: number;
    /** 억원 */
    marketCap: number | null;
    shares: number | null;
    /** 억원 */
    tradeValue: number | null;
    volume: number;
    /** % */
    turnover: number | null;
    strength: number | null;
    prevClose: number;
    high: number;
    low: number;
    open: number;
    upperLimit: number;
    lowerLimit: number;
  };
  /** 순매수 금액(백만원). 부호가 방향이다 */
  main: { key: string; label: string; amount: number }[];
  institution: { key: string; label: string; amount: number }[];
  /** 프로그램 순매수(백만원) — 위 셋과 **겹치는 값**이라 더하면 안 된다 */
  program: number | null;
  /** 못 받은 조각 — 「0」과 「못 받음」은 다르다 */
  missing: string[];
}

/** 장중 기준선 — VWAP·시가갭·전일고저·장초반 30분 */
export interface IntradayLevels {
  code: string;
  date: string;
  price: number;
  open: number;
  high: number;
  low: number;
  /** ⚠️ 분봉 전형가로 낸 **어림값** — 진짜 VWAP 은 체결 단위라 REST 로 못 받는다 */
  vwap: number | null;
  vsVwap: number | null;
  prevClose: number | null;
  prevHigh: number | null;
  prevLow: number | null;
  gapPct: number | null;
  /** 갭이 ±0.5% 안이면 `null` — 메울 갭이 없다 */
  gapFilled: boolean | null;
  or30High: number | null;
  or30Low: number | null;
  bars: number;
}

/* ── 키움 미국 세부 ────────────────────────────────────────── */

export interface UsKiwoomDetailData {
  summary: {
    symbol: string;
    stex: string;
    name: string;
    sectorLg: string;
    sectorSm: string;
    /** 백만 달러 */
    marketCap: number | null;
    shares: number | null;
    price: number | null;
    changeRate: number | null;
    volume: number | null;
    week52: {
      high: number | null;
      highDate: string;
      highGap: number | null;
      low: number | null;
      lowDate: string;
      lowGap: number | null;
    };
    pre: { open: number | null; high: number | null; low: number | null };
    baseClose: number | null;
    exchangeRate: number | null;
  } | null;
  book: {
    asks: { price: number | null; qty: number }[];
    bids: { price: number | null; qty: number }[];
    totalAsk: number;
    totalBid: number;
    tradeValue: number | null;
    turnover: number | null;
    at: string;
    date: string;
  } | null;
  unsupported?: string;
}

/* ── 마켓 브리핑 ───────────────────────────────────────────── */

/** 타임라인 한 줄. `t` 가 "HH:mm" 이 아니면(공시) 시각 없는 묶음이다 */
export interface BriefingEvent {
  t: string;
  kind: string;
  badge: string;
  code?: string;
  name: string;
  summary: string;
  source?: string;
  watch: boolean;
  link?: string;
}

export interface BriefingTile {
  code: string;
  name: string;
  rate: number | null;
  /** 억원 — 타일 크기의 기준 (스냅샷에 거래대금이 없어 시총으로 잰다) */
  cap: number | null;
  status: string;
}

/* ── 조건 백테스트 ─────────────────────────────────────────── */

export type BacktestRuleKey =
  | "maAlign"
  | "aboveMa"
  | "volSurge"
  | "newHigh"
  | "minRate"
  | "nearHigh52"
  | "disparity"
  | "volValue"
  | "gapUp"
  | "minScore";

export interface BacktestRuleDef {
  key: BacktestRuleKey;
  label: string;
  hint: string;
  hasValue: boolean;
  defaultValue: number;
}

export interface BacktestConfig {
  market: string;
  universe: number;
  /** 며칠 들고 있다 파나 (거래일) */
  holdDays: number;
  rules: { key: BacktestRuleKey; value: number }[];
}

export interface BacktestStat {
  count: number;
  avg: number;
  median: number;
  winRate: number;
  best: number;
  worst: number;
}

export interface BacktestResult {
  config: BacktestConfig;
  hit: BacktestStat;
  /** 조건을 안 걸고 같은 기간·같은 종목에서 잰 것 — 이게 없으면 위 숫자는 못 읽는다 */
  base: BacktestStat;
  /** 조건이 만든 차이(%p) — 진짜 봐야 할 숫자 */
  edge: number | null;
  codes: number;
  failed: number;
  from: string;
  to: string;
  samples: { code: string; name: string; date: string; rate: number }[];
}

export interface BacktestJob {
  status: "running" | "done" | "error";
  total: number;
  done: number;
  startedAt: string;
  result: BacktestResult | null;
  error?: string;
}

/** 복기 노트 */
export interface DayContext {
  marketLevel: string;
  marketScore: number;
  marketSummary: string;
  breadth: string | null;
  trend: string | null;
  topThemes: { name: string; changeRate: number }[];
  bottomThemes: { name: string; changeRate: number }[];
}

export interface JournalTrade {
  id: string;
  kind: "buy" | "sell";
  code: string;
  name: string;
  price: number;
  qty: number;
  note: string;
  /** 근거 태그 — 자유 서술은 그대로 두고, 셀 수 있는 형태를 같이 받는다 */
  reasons?: string[];
  level?: string;
  score?: number;
  passed?: string[];
  /** 손절선(원) — 살 때만 적는다. R 배수의 분모 */
  stop?: number;
  /** 목표가(원) */
  target?: number;
  /** 이 매매에 건 위험 — 계좌 대비 % */
  risk?: number;
}

export interface JournalEntry {
  date: string;
  updatedAt: string;
  /** 오늘 매매했나 쉬었나 — 안 사는 것도 판단이다 */
  stance?: "trade" | "watch" | null;
  /** 쉰 이유 */
  watchReasons?: string[];
  what: string;
  why: string;
  followedRules: boolean | null;
  brokenRule: string;
  trades: JournalTrade[];
  mistakes: string[];
  mood: string;
  lesson: string;
  tomorrow: string;
  context: DayContext | null;
}

export interface JournalStats {
  days: number;
  streak: number;
  ruleRate: number | null;
  mistakes: { key: string; label: string; count: number }[];
  moods: { key: string; label: string; count: number; ruleRate: number | null }[];
  ruleEdge: {
    keptDays: number;
    keptAvgReturn: number | null;
    brokeDays: number;
    brokeAvgReturn: number | null;
  };
  /** 전체 실현 R — 손절선을 적은 매매에서만 */
  rStat: { count: number; avg: number | null; best: number | null; worst: number | null };
  reasonEdge: EdgeRow[];
  signalEdge: EdgeRow[];
  marketEdge: EdgeRow[];
  watch: {
    days: number;
    tradeDays: number;
    reasons: { key: string; label: string; count: number }[];
    byMarket: { key: string; count: number }[];
    tradeByMarket: { key: string; count: number }[];
  };
  lessons: { date: string; lesson: string }[];
}

/** 무엇으로 묶든 성적은 같은 모양 */
export interface EdgeRow {
  key: string;
  label: string;
  /** 판 건수 — 적으면 평균이 우연이다 */
  count: number;
  avgReturn: number;
  winRate: number;
  /** 평균 실현 R — 손절선을 적은 매매에서만. 승률 옆에 꼭 같이 본다 */
  avgR: number | null;
  /** R 을 낼 수 있었던 건수 */
  rCount: number;
}

export interface JournalData {
  entries: JournalEntry[];
  stats: JournalStats;
  mistakeTags: { key: string; label: string; hint: string }[];
  moodTags: { key: string; label: string }[];
  reasonTags: { key: string; label: string; hint: string }[];
  watchTags: { key: string; label: string; hint: string }[];
}


/** 오늘 공시 (DART) */
export interface DartEvent {
  corpName: string;
  stockCode: string;
  market: string;
  title: string;
  date: string;
  url: string;
  weight: number;
  watched: boolean;
  themes: string[];
  amended: boolean;
}


/** 관심종목 (미국) */
export interface UsSearchResult {
  symbol: string;
  name: string;
  exchange: string;
  type: string;
}

export interface UsQuoteRow {
  symbol: string;
  name: string;
  price: number | null;
  changeRate: number | null;
  returnRate: number | null;
  addedPrice: number | null;
  memo: string;
  marketState: string | null;
  /** Yahoo 가 알려준 체결 시각(ms) */
  quotedAt: number | null;
  error: string | null;
  /** 원화 환산가 (한국투자증권) */
  /*
   * 미국 주간거래(오버나이트) — **프리마켓이 아니다.**
   * 미 동부 프리마켓은 한국 밤이라 우리가 볼 때는 이미 끝나 있다.
   * 이건 한국 낮에 열리는 세션이고, 국내장이 도는 동안 움직이는 미국 가격은 이것뿐이다.
   */
  /** 애프터장 (미 동부 16:00~20:00) — 괄호에 들어간다 */
  afterPrice: number | null;
  afterChangeRate: number | null;
  dayPrice: number | null;
  dayChangeRate: number | null;
  dayVolume: number | null;
  wonPrice: number | null;
  /** 오늘 거래량 ÷ 전일 거래량 × 100 */
  volumeVsPrev: number | null;
  /** 52주 구간에서 지금 위치 (0=저가, 100=고가) */
  pos52: number | null;
  high52: number | null;
  low52: number | null;
  /** 체결강도 — 100 보다 크면 사는 쪽이 세다 */
  power: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  /** 한투가 알려준 장 상태 */
  state: string | null;
  /** 통화 — 나라가 섞이면 78.89 가 달러인지 엔인지 알 수 없다 */
  currency: string | null;
  country: string | null;
  flag: string | null;
  source: "hantoo" | "yahoo";
}

export interface UsWatchGroup {
  id: string;
  name: string;
  memo: string;
  changeRate: number | null;
  rising: number;
  falling: number;
  stocks: UsQuoteRow[];
}

export interface UsWatchResult {
  groups: UsWatchGroup[];
  /** 거래소 마지막 체결 시각(ms) */
  quotedAt: number | null;
  /** 우리가 받아온 시각(ms) */
  fetchedAt: number;
}


/** 내 관심 키워드 */
export interface KeywordConfig {
  enabled: boolean;
  intervalMin: number;
  keywords: string[];
  useWatchlist: boolean;
  useThemes: boolean;
  weekdayOnly: boolean;
  startHour: number;
  endHour: number;
  maxPerRun: number;
}

export interface KeywordSource {
  word: string;
  from: string;
}

export interface KeywordHit {
  key: string;
  channelName: string;
  at: string;
  text: string;
  link: string;
  words: string[];
}

export interface KeywordRunResult {
  scanned: number;
  matched: number;
  sent: number;
  skipped: number;
  hits: KeywordHit[];
  error?: string;
}


/** 관심종목 공시 알림 */
export interface DisclosureAlertConfig {
  enabled: boolean;
  intervalMin: number;
  watchedOnly: boolean;
  includeThemes: boolean;
  marketWeightMin: number;
  weekdayOnly: boolean;
  startHour: number;
  endHour: number;
  maxPerRun: number;
}

export interface DisclosureHit {
  event: DartEvent;
  reason: string;
}

export interface DisclosureRunResult {
  scanned: number;
  matched: number;
  sent: number;
  skipped: number;
  hits: DisclosureHit[];
  error?: string;
}


/* ------------------------------------------------------------------ */
/* 시장 맥박 — 돈이 어디로 가고 있나                                    */
/* ------------------------------------------------------------------ */

export type PhaseKey =
  | "foreignLed"
  | "instLed"
  | "bothIn"
  | "retailOnly"
  | "bothOut"
  | "mixed";

export interface PulseFlow {
  /** 5일 누적 순매수 (억원) */
  foreign5: number;
  inst5: number;
  individual5: number;
  foreign20: number;
  inst20: number;
  individual20: number;
  /** 양수면 연속 순매수 일수, 음수면 연속 순매도 일수 */
  foreignStreak: number;
  instStreak: number;
}

export interface MarketPulse {
  /** 며칠치가 쌓였나. 적으면 아래 판정은 전부 잠정이다 */
  days: number;
  phase: { key: PhaseKey; label: string; note: string };
  flow: PulseFlow;
  divergence: {
    warning: boolean;
    indexMove: number | null;
    breadthMove: number | null;
    note: string;
  };
  /** 누적과 최근 방향이 어긋나는가 — 변곡점 */
  turn: { turning: boolean; who: string | null; note: string };
  signal: { level: string; score: number; summary: string } | null;
  basis: number | null;
  risks: { key: string; label: string; detail: string; level: "warn" | "danger" }[];
  external: { label: string; value: string; changeRate: number | null; note?: string }[];
  at: string;
}

export interface PulseBrief {
  text: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  at: string;
  error: string | null;
}


/* ------------------------------------------------------------------ */
/* 신호등 추적기 — 신호등이 정말 맞는지 스스로 검증한다                  */
/* ------------------------------------------------------------------ */

export interface TrackResult {
  days: number;
  price: number;
  /** 편입가 대비 (%) */
  rate: number;
  at: string;
}

export interface TrackEntry {
  id: string;
  code: string;
  name: string;
  /** 어느 문턱(70·80·90)으로 들어왔나 */
  tier: number;
  date: string;
  score: number;
  level: string;
  /** 편입 당시 축별 점수 */
  axes: Partial<Record<"trend" | "flow" | "value" | "risk", number | null>>;
  riskCapped: boolean;
  basePrice: number;
  /** 그때의 신호등 기준 지문 — 기준이 바뀌면 같은 90점도 다른 뜻이다 */
  configHash: string;
  results: TrackResult[];
  closed: boolean;
}

export interface TrackSummary {
  entries: TrackEntry[];
  tiers: {
    tier: number;
    count: number;
    pending: number;
    byHorizon: {
      days: number;
      n: number;
      winRate: number;
      avg: number;
      median: number;
      best: number;
      worst: number;
    }[];
  }[];
  currentConfig: string;
  mixedConfig: boolean;
  lastRunDate: string | null;
}


/** 사이드바 메뉴 설정 — 서버에 둔다(기기가 달라도 같은 메뉴여야 한다) */
export interface MenuPrefsDto {
  order: string[];
  hidden: string[];
  labels: Record<string, string>;
  groupOf: Record<string, string>;
  extraGroups: string[];
  favorites: string[];
}


/** 추적기 편입 조건 — 무엇을 담았는지 눈에 보여야 나중 숫자를 믿을 수 있다 */
export interface TrackConfig {
  tiers: number[];
  universe: number;
  market: "000" | "001" | "101";
  minTradeValue: number;
  includeRiskCapped: boolean;
}

export interface TrackJob {
  status: "running" | "done" | "error";
  total: number;
  done: number;
  current: string;
  added: number;
  skippedDuplicate: number;
  /** 평가 자체가 실패한 종목 수 — 0건일 때 이유를 가르는 숫자다 */
  failed: number;
  firstError?: string;
  startedAt: string;
  report?: {
    date: string;
    scanned: number;
    added: number;
    skippedDuplicate: number;
    failed: number;
    belowTier: number;
    byTier: Record<string, number>;
    note: string;
  };
  error?: string;
}


/** 야후 심볼 봉 데이터 — 전광판의 지수·원자재를 눌렀을 때 */
export interface YahooChart {
  symbol: string;
  range: string;
  interval: string;
  candles: { t: string; open: number; high: number; low: number; close: number; volume: number }[];
  prevClose: number | null;
  error: string | null;
}


/** 내 매매 판단 추적 — 매도는 부호가 뒤집힌다(팔고 내렸으면 잘 판 것) */
export interface TradeTrackResult {
  trades: {
    id: string;
    date: string;
    kind: "buy" | "sell";
    code: string;
    name: string;
    price: number;
    qty: number;
    note: string;
    outcomes: { days: number; price: number; move: number; edge: number }[];
    error?: string;
  }[];
  buy: TradeHorizonStat[];
  sell: TradeHorizonStat[];
  soldTooEarly: { date: string; name: string; days: number; move: number; note: string }[];
  fetched: number;
  failed: number;
}

export interface TradeHorizonStat {
  days: number;
  n: number;
  hitRate: number;
  avgEdge: number;
  best: number;
  worst: number;
}


/**
 * 해외종목 상세 (한투).
 * ⚠️ **종목명은 안 온다** — 부르는 쪽이 이미 아는 이름을 쓴다. 재무제표·수급도 없다.
 */
export interface UsDetail {
  symbol: string;
  excd: string | null;
  sector: string;
  price: number | null;
  base: number | null;
  change: number | null;
  changeRate: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
  prevVolume: number | null;
  high52: number | null;
  low52: number | null;
  marketCap: number | null;
  per: number | null;
  pbr: number | null;
  eps: number | null;
  bps: number | null;
  shares: number | null;
  currency: string;
  wonPrice: number | null;
  fxRate: number | null;
  tradable: string;
  error: string | null;
}


/** 주도주 탐색기 */
export interface LeaderConfig {
  minTradeValue: number;
  universe: number;
  surgeRate: number;
  volumeSpike: number;
  topSectors: number;
  minMembers: number;
}

export interface LeaderStock {
  code: string;
  name: string;
  sector: string;
  price: number;
  changeRate: number;
  /** 억원 */
  tradeValue: number;
  marketCap: number | null;
  volumeRatio: number | null;
  tags: string[];
  score: number;
}

export interface LeaderScan {
  at: string;
  date: string;
  config: LeaderConfig;
  sectors: {
    name: string;
    /** 거래대금 가중 등락률 */
    weightedRate: number;
    simpleRate: number;
    tradeValue: number;
    members: number;
    rising: number;
    /** 오른 종목 비율(%) — 낮으면 섹터가 아니라 종목 이슈 */
    breadth: number;
    leaders: LeaderStock[];
    streak: number | null;
    carryOver: number | null;
    news: { title: string; press: string; link: string }[];
  }[];
  stocks: LeaderStock[];
  scanned: number;
  belowThreshold: number;
  note: string;
}


/** 주도주 탐색기 성적 */
export interface LeaderGroupStat {
  key: string;
  n: number;
  byHorizon: {
    days: number;
    n: number;
    winRate: number;
    avg: number;
    median: number;
    best: number;
    worst: number;
  }[];
}

export interface LeaderTrackResult {
  picks: {
    date: string;
    code: string;
    name: string;
    sector: string;
    price: number;
    changeRate: number;
    tradeValue: number;
    tags: string[];
    outcomes: { days: number; price: number; rate: number }[];
  }[];
  /** 태그별 — 내가 어떤 신호를 잘 고르는지 */
  byTag: LeaderGroupStat[];
  bySector: LeaderGroupStat[];
  overall: LeaderGroupStat;
  days: number;
  codes: number;
  failed: number;
  note: string;
}


/** 일정 매매 — 일정을 보고 미리 들어가서 일정 즈음에 나온다 */
export interface EventPlay {
  id: string;
  date: string;
  title: string;
  note: string;
  themeIds: string[];
  calendarId?: string;
  createdAt: string;
}

export interface EventPlayResult extends EventPlay {
  themes: {
    themeId: string;
    themeName: string;
    members: number;
    /** D-1 종가를 100 으로 놓은 상대 곡선 */
    points: { offset: number; index: number; rate: number }[];
    runUp: number | null;
    after: number | null;
    /** 일정일이 고점이었나 — 「소문에 사서 뉴스에 판다」가 맞았는지 */
    peakedAtEvent: boolean | null;
  }[];
  upcoming: boolean;
}


/* ── 종가배팅 ── */

export interface BetGaugeDay {
  date: string;
  futuresBody: number | null;
  oilMove: number | null;
  fxMove: number | null;
  /** 실제 값 — 변동률만으로는 수준을 모른다 */
  futuresPrice: number | null;
  oilPrice: number | null;
  fxPrice: number | null;
  /** 미 국채금리 — 하루 변화·5일 변화는 bp, 수준은 % */
  y10Move: number | null;
  y30Move: number | null;
  y10Trend: number | null;
  y30Trend: number | null;
  y10: number | null;
  y30: number | null;
}

export interface BetVerdict {
  key: "futures" | "oil" | "fx" | "y10" | "y30";
  label: string;
  level: "ok" | "warn" | "bad";
  value: string;
  /** 지금 값 */
  price: string;
  why: string;
}

export interface BetStat {
  key: string;
  n: number;
  openWin: number;
  openAvg: number;
  closeWin: number;
  closeAvg: number;
  /** 코스피 대비(%p) — 이게 없으면 시장이 오른 건지 종목을 고른 건지 모른다 */
  openExcess: number;
  closeExcess: number;
  excessWin: number;
}

export interface BetBacktest {
  venue: "krx" | "nxt";
  stocks: { code: string; name: string; days: number }[];
  matched: BetStat;
  unmatched: BetStat;
  perCondition: BetStat[];
  benchDays: number;
  note: string;
}

export interface BetLogStat {
  key: string;
  n: number;
  openWin: number;
  openAvg: number;
  openExcess: number;
  excessWin: number;
}

export interface BetLogSummary {
  days: number;
  scored: number;
  watch: { code: string; name: string }[];
  periods: { label: string; matched: BetLogStat; unmatched: BetLogStat }[];
  recent: {
    date: string;
    atClose: BetGaugeDay | null;
    settled: BetGaugeDay | null;
    scored: boolean;
    stocks: {
      code: string;
      name: string;
      close: number;
      nxtClose: number | null;
      openRate: number | null;
      openExcess: number | null;
      nxtOpenRate: number | null;
      nxtOpenExcess: number | null;
    }[];
  }[];
  note: string;
}


/** 호가창 */
export interface OrderBook {
  code: string;
  at: string;
  asks: { step: number; price: number; qty: number }[];
  bids: { step: number; price: number; qty: number }[];
  totalAsk: number;
  totalBid: number;
  overtimeAsk: number;
  overtimeBid: number;
  /** 매수잔량 ÷ 매도잔량. **체결강도가 아니다** — 대기 물량이다 */
  ratio: number | null;
  price: number;
  changeRate: number;
  open: number;
  krxHigh: number;
  krxLow: number;
  nxtHigh: number | null;
  nxtLow: number | null;
  high250: number;
  low250: number;
  upperLimit: number;
  lowerLimit: number;
  volume: number;
  /** 거래량 ÷ 상장주식수 (%) */
  turnover: number | null;
  /** 체결강도(%). 100 초과면 매수 체결이 우세. **잔량비와 다르다 — 실제 체결이다** */
  strength: number | null;
  /** 기준가(전일 종가) — 호가마다 등락률을 붙이는 기준 */
  basePrice: number;
  /** 누적거래대금(원). `ka10003` 이 준다 */
  tradeValue: number;
  /** 최근 체결 — 수량 부호가 방향이다(음수면 매도 체결) */
  ticks: { t: string; price: number; qty: number }[];
  error: string | null;
}


/** 거래원 */
export interface BrokerFlow {
  code: string;
  at: string;
  sell: { rank: number; code: string; name: string; qty: number; delta: number; foreign: boolean }[];
  buy: { rank: number; code: string; name: string; qty: number; delta: number; foreign: boolean }[];
  foreignNet: number;
  /** 우리가 쌓은 시간대별 — 화면을 안 본 시간은 빈다 */
  series: { t: string; net: Record<string, number> }[];
  names: Record<string, string>;
  error: string | null;
}

/**
 * 보드 화면 구성 한 벌 — 서버가 주고받는 모양.
 * 화면 쪽 `Preset` 과 같은 모양이지만, 서버 계약이라 여기에도 적어 둔다.
 */
export interface BoardPresetDto {
  id: string;
  name: string;
  pick: string[];
  sizes: Record<string, { w: number; h: number }>;
  pins: string[];
  locks: Record<string, { code: string; name: string }>;
  /** 잠갔나 — 이름·순서·삭제·덮어쓰기가 막힌다 */
  locked?: boolean;
}
