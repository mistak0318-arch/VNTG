export type RawRecord = Record<string, unknown>;

async function getJson<T = RawRecord>(path: string): Promise<T> {
  const res = await fetch(path);
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) {
    const message = (body as { error?: string }).error ?? `요청 실패 (${res.status})`;
    throw new Error(message);
  }
  return body;
}

async function postJson<T = RawRecord>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
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
  const res = await fetch(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const parsed = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error((parsed as { error?: string }).error ?? `요청 실패 (${res.status})`);
  return parsed;
}

async function putJson<T = RawRecord>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const parsed = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error((parsed as { error?: string }).error ?? `요청 실패 (${res.status})`);
  return parsed;
}

async function deleteJson<T = RawRecord>(path: string): Promise<T> {
  const res = await fetch(path, { method: "DELETE" });
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
  stockInfo: (code: string) => getJson(`/api/market/info/${code}`),
  quote: (code: string) => getJson(`/api/market/quote/${code}`),
  dailyChart: (code: string) => getJson(`/api/market/chart/daily/${code}`),
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
  usWatchStockAdd: (groupId: string, symbol: string, name: string) =>
    postJson<{ groups: UsWatchGroup[] }>(`/api/us-watch/groups/${groupId}/stocks`, { symbol, name }),
  usWatchStockOrder: (groupId: string, symbols: string[]) =>
    putJson<{ groups: UsWatchGroup[] }>(`/api/us-watch/groups/${groupId}/stocks/order`, { symbols }),
  usWatchStockRemove: (groupId: string, symbol: string) =>
    deleteJson<{ groups: UsWatchGroup[] }>(`/api/us-watch/groups/${groupId}/stocks/${symbol}`),
  dartToday: (force = false) =>
    getJson<{ day: string; events: DartEvent[] }>(`/api/dart/today${force ? "?force=1" : ""}`),
  journal: () => getJson<JournalData>("/api/journal"),
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
  signalScreenStart: (market: string, level: "green" | "yellow", limit: number) =>
    postJson<{ jobId: string }>(
      `/api/signal/screen/start?market=${market}&level=${level}&limit=${limit}`,
    ),
  signalScreenStatus: (jobId: string) => getJson<ScreenJob>(`/api/signal/screen/${jobId}`),
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
      config: { pickAuto: PickAutoConfig };
      defaults: { pickAuto: PickAutoConfig };
      intervals: number[];
      mailConfigured: boolean;
    }>("/api/channels/config"),
  channelConfigSave: (config: { pickAuto: PickAutoConfig }) =>
    putJson<{ config: { pickAuto: PickAutoConfig } }>("/api/channels/config", config),
  usKr: () => getJson<{ links: EvaluatedLink[]; themeNames: string[]; at: string }>("/api/us-kr"),
  usKrCorrelation: () => getJson<{ result: CorrelationResult | null }>("/api/us-kr/correlation"),
  usKrCorrelate: (days = 60) =>
    postJson<{ result: CorrelationResult }>(`/api/us-kr/correlation?days=${days}`),
  rankSpecs: () => getJson<{ groups: RankSpecGroup[] }>("/api/rank/specs"),
  rank: (key: string, market = "000", exchange = "3") =>
    getJson<RankResult>(`/api/rank/${key}?market=${market}&exchange=${exchange}`),
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
    getJson<{ sectors: { key: string; label: string; items: ScoredNews[] }[]; fetchedAt: string }>(
      `/api/feed/news/sectors?scope=${scope}&per=${per}&sort=${sort}`,
    ),
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
  code: string;
  name: string;
  addedAt: string;
  addedPrice: number;
  memo: string;
  /** @deprecated 한 그룹만 담던 옛 필드 */
  group?: string;
  /** 소속 그룹들 — 한 종목이 여러 그룹에 담긴다 */
  groups: string[];
}

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
  error: string | null;
}

export interface UsMajorResult {
  rows: UsMajorRow[];
  /** 코스피 야간선물 — 이것만 지금 움직인다 */
  nightFutures: UsMajorRow | null;
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
  /** 거래대금(백만원) */
  tradeValue: number;
  level: "green" | "yellow" | "red" | "unknown";
  score: number;
  passed: string[];
  failed: string[];
}

export interface ScreenJob {
  status: "running" | "done" | "error";
  total: number;
  done: number;
  results: ScreenHit[];
  market: string;
  minLevel: string;
  startedAt: string;
  error?: string;
}

export interface ScreenRunSummary {
  id: string;
  at: string;
  market: string;
  minLevel: string;
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
  /** code·name 은 항상 있고, 나머지는 명세의 컬럼 키로 들어온다 */
  rows: (Record<string, unknown> & { code: string; name: string })[];
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

export interface SignalCheck {
  key: string;
  label: string;
  pass: boolean | null;
  value: string;
  weight: number;
  link?: { kind: "sector" | "theme"; code: string; name: string };
}

export interface SignalResult {
  code: string;
  level: SignalLevel;
  score: number;
  checks: SignalCheck[];
  evaluatedAt: string;
}

export interface SignalCheckConfig {
  key: string;
  label: string;
  enabled: boolean;
  weight: number;
  threshold: number;
  hint: string;
}

export interface SignalConfig {
  checks: SignalCheckConfig[];
  greenAt: number;
  yellowAt: number;
  flowDays: 5 | 10 | 20;
  maLines: number[];
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

export interface FinanceResult {
  basis: "연결" | "별도" | null;
  periods: FinancialPeriod[];
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
  level?: string;
  score?: number;
  passed?: string[];
}

export interface JournalEntry {
  date: string;
  updatedAt: string;
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
  lessons: { date: string; lesson: string }[];
}

export interface JournalData {
  entries: JournalEntry[];
  stats: JournalStats;
  mistakeTags: { key: string; label: string; hint: string }[];
  moodTags: { key: string; label: string }[];
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
