import { useEffect, useMemo, useRef, useState } from "react";
import { RotationStrip, ThermoPanel, useMarketLens } from "../components/MarketLensPanel";
import {
  api,
  fmtNum,
  normalizeStockCode,
  type IndexCard,
  type MarketFlow,
  type MarketStatus,
  type GlobalQuote,
  type StockRow,
  type ThemeRow,
  type ViRow,
  type UsMajorResult,
  type RateRow,
  type TopTraderRow,
} from "../api";
import { ConstituentSheet, type ConstituentTarget } from "../components/overview/ConstituentSheet";
import { FlowBars } from "../components/overview/FlowBars";
import { FlowIntradayChart } from "../components/overview/FlowIntradayChart";
import { IndexDetailSheet } from "../components/overview/IndexDetailSheet";
import { FuturesDetailSheet, type FuturesDetailTarget } from "../components/overview/FuturesDetailSheet";
import { YahooChartSheet, type ChartTarget } from "../components/overview/YahooChartSheet";
import { MarketSignalPanel } from "../components/MarketSignalPanel";
import { UsBoardPanel } from "../components/overview/UsBoardPanel";
import { OverviewCard } from "../components/overview/OverviewCard";
import { RankList, SegmentToggle } from "../components/overview/RankList";
import { RefreshBar } from "../components/RefreshBar";
import {
  DomesticIndexGrid,
  UpDownTable,
  useFutFlow,
} from "../components/overview/DomesticIndexGrid";
import { TurnoverPanel } from "../components/overview/TurnoverPanel";
import { useSection } from "../useSection";
import { SessionBadge } from "../components/SessionBadge";
import { kindOfGroup } from "../marketSession";
import { useCardOrder } from "../useCardOrder";
import { useMasonryGrid } from "../useMasonryGrid";
import { useSwipeTabs } from "../useSwipeTabs";
import { OVERVIEW_CARDS, type OverviewSub } from "../overviewCards";
import { PulsePanel } from "../components/overview/PulsePanel";
import { InquiryRankPanel } from "../components/overview/InquiryRankPanel";
import { WatchStar } from "../useWatchedCodes";
import { SuperMark } from "../useSuperMarks";

type SubTab = "summary" | "flow" | "rank" | "us";

const SUBTABS: { key: SubTab; label: string }[] = [
  { key: "summary", label: "요약" },
  /*
   * 「수급」 탭은 숨겼다 (2026-08-26 사용자 요청) — 지수 카드의 수급·장중 수급
   * 변화(지수/선물 시트)로 요약 쪽에 내용이 다 들어가서 따로 갈 일이 없어졌다.
   * 카드 구성(OVERVIEW_CARDS.flow)은 남겨 둔다 — 다시 켜는 건 여기 한 줄이다.
   *
   * 「순위」 탭도 같은 이유로 숨겼다 (2026-08-27 사용자 요청) — 등락·거래대금·시가총액·
   * 누적등락 순위는 시세분석이, ETF 는 ETF 메뉴가 더 깊게 보여 준다. 여기서 또 볼 일이
   * 없어졌다. 카드 구성(OVERVIEW_CARDS.rank)과 아래 렌더는 그대로 남겨 둔다 —
   * 되살리려면 이 줄의 주석만 풀면 된다:
   *   { key: "rank", label: "순위" },
   */
  // 미국 전광판 — 미국장이 열려 있는 동안 보는 자리
  { key: "us", label: "미국" },
];

function signCls(v: number): string {
  return v > 0 ? "up" : v < 0 ? "down" : "flat";
}

/**
 * 금리 카드가 쓰는 **미국 실시간 넷** (2026-09-02).
 *
 * 한투 금리 종합판은 미국·일본을 **전일 종가**로 준다(`rateBoard` 머리 주석).
 * 실시간이 필요한 미국 만기는 `usMajor` 가 이미 야후에서 받고 있어 그걸 쓴다 —
 * 조회가 늘지 않는다. 만기가 짧은 쪽부터라 장단기 역전이 왼→오로 읽힌다.
 */
/** 글로벌 줄 + 금리 줄이 같이 쓰는 모양 — asOf 는 한투 금리에만 있다 */
type GRow = GlobalQuote & { asOf?: string | null };

/** 시세 기준 시각이 3분~24시간 묵었으면 「n분 전」 */
function lagBadge(quotedAt: number | null | undefined) {
  if (!quotedAt) return null;
  const min = Math.round((Date.now() - quotedAt) / 60_000);
  if (min < 3 || min >= 24 * 60) return null;
  const txt = min < 60 ? `${min}분 전` : `${Math.floor(min / 60)}시간 전`;
  return (
    <span className="ov-g-lag" title="시세의 기준 시각 — 야후가 거래소 규정대로 지연해서 주는 만큼입니다">
      {txt}
    </span>
  );
}

const US_YIELD_KEYS = ["irx", "fvx", "tnx", "tyx"] as const;
/** 야후에 심볼이 없어 한투에서만 오는 것 — 기준금리·일본 10년 (404 실측) */
const HANTOO_ONLY_RATES = ["Y0204", "Y0207"];

/**
 * **오늘 값이 아니면 언제 값인지 적는다.**
 *
 * 날짜를 안 적으면 「+0.020%p」가 지금 움직임으로 읽힌다 — 벤티지가 걸린 자리가
 * 정확히 그것이었다. 오늘이면 배지를 안 단다(늘 붙어 있으면 아무도 안 본다).
 */
function pastBadge(asOf: string | null): string | null {
  if (!asOf || asOf.length < 10) return null;
  const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  if (asOf >= today) return null;
  return `${asOf.slice(5).replace("-", "/")} 종가`;
}

function fmtPct(v: number): string {
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function fmtSigned(v: number): string {
  return `${v > 0 ? "▲ " : v < 0 ? "▼ " : ""}${fmtNum(Math.abs(v))}`;
}

export function OverviewPage({ onSelectStock }: { onSelectStock: (code: string, name: string) => void }) {
  const [sub, setSub] = useState<SubTab>("summary");
  const [status, setStatus] = useState<MarketStatus | null>(null);
  const [now, setNow] = useState(new Date());

  /*
   * 갱신 주기.
   *
   * **여기 적힌 숫자는 외부 API 호출 주기가 아니다.** 화면은 우리 서버의 캐시만 두들기고,
   * 키움·야후·한투를 실제로 부르는 주기는 서버의 `SECTION_TTL_MS` 가 정한다.
   * 그래서 이 값을 줄이는 건 **거의 공짜**다 — 서버가 새로 받아 둔 값을 더 빨리 집어 올 뿐이다.
   *
   * 서버 TTL 의 **절반쯤**으로 둔다. 그래야 서버가 값을 갈아끼운 직후에 화면이 집어 온다.
   * 두 배 이상 느리게 두면 새 값이 있는데도 한참 옛 값을 보고 있게 된다.
   */
  const indices = useSection<IndexCard[]>("indices", 5_000);
  const flow = useSection<MarketFlow>("flow", 20_000);
  /* 선물 투자자별 수급 — 지수 타일 공용 훅(DomesticIndexGrid)으로 이사했다 */
  const futFlow = useFutFlow();
  const movers = useSection<{ rising: StockRow[]; falling: StockRow[] }>("movers", 20_000);
  const themes = useSection<{ top: ThemeRow[]; bottom: ThemeRow[] }>("themes", 60_000);
  const highLow = useSection<{ high: StockRow[]; low: StockRow[] }>("highLow", 120_000);
  const vi = useSection<ViRow[]>("vi", 20_000);
  const global = useSection<GlobalQuote[]>("global", 15_000);
  const usMajor = useSection<UsMajorResult>("usMajor", 15_000);
  const rates = useSection<RateRow[]>("rates", 30_000);
  const topTraders = useSection<TopTraderRow[]>("topTraders", 120_000);
  /* 시장 렌즈 — 체온계·테마 흐름 두 카드가 나눠 본다 (한 번만 받는다) */
  const { lens, reload: reloadLens } = useMarketLens();

  const [flowMarket, setFlowMarket] = useState<"kospi" | "kosdaq">("kospi");
  const [moverDir, setMoverDir] = useState<"rising" | "falling">("rising");
  const [themeDir, setThemeDir] = useState<"top" | "bottom">("top");
  const [hlDir, setHlDir] = useState<"high" | "low">("high");
  const [constituent, setConstituent] = useState<ConstituentTarget | null>(null);
  /** 눌러서 연 지수 상세 (001 코스피 / 101 코스닥) */
  const [indexDetail, setIndexDetail] = useState<string | null>(null);
  /** 선물 타일 → 코스피/코스닥과 같은 골격의 선물 상세 시트 */
  const [futDetail, setFutDetail] = useState<FuturesDetailTarget | null>(null);
  /* 글로벌·미장·미국 금리 줄을 누르면 — 추이 차트. 숫자 한 줄로는 「어디쯤인가」를 모른다 */
  const [chart, setChart] = useState<ChartTarget | null>(null);
  /*
   * **글로벌 판의 줄을 고른다** (2026-09-08 — 벤티지: "원/엔은 제외해줘. 글로벌 글자 옆에
   * 톱니바퀴 넣어서 뭘 넣고 뺄지 정할 수 있게. 나중에 내가 넣고 빼고 순서 바꾸고").
   * 서버가 주는 줄은 그대로 두고, **이 기기**에서 무엇을 어떤 차례로 볼지만 여기서 정한다.
   * 원/엔은 기본으로 숨긴다 — 달러/엔이 있으면 남는 정보가 없다.
   */
  const [gRows, setGRows] = useState<{ hidden: string[]; order: string[] }>(() => {
    try {
      const raw = localStorage.getItem("vntg.global.rows");
      if (raw) return JSON.parse(raw) as { hidden: string[]; order: string[] };
    } catch {
      /* 처음 */
    }
    return { hidden: ["jpykrw"], order: [] };
  });
  const [gEdit, setGEdit] = useState(false);
  const saveGRows = (next: { hidden: string[]; order: string[] }) => {
    setGRows(next);
    try {
      localStorage.setItem("vntg.global.rows", JSON.stringify(next));
    } catch {
      /* 비공개 창 */
    }
  };
  /*
   * **금리를 글로벌 안에** (2026-09-08 — 벤티지: "글로벌 카드에 금리 합치자. 미국 지수선물 밑에
   * 금리 섹션 넣어줘. 금리도 톱니바퀴 옵션에 넣어서").
   *
   * 금리 카드가 따로 있었다. 야간선물·환율·선물·아시아·원자재·암호화폐는 한 판에 있는데 금리만
   * 딴 카드라, 「밤사이 무슨 일이 있었나」를 읽으려면 두 곳을 봐야 했다. 서버는 안 건드린다 —
   * 미국 넷은 usMajor(야후, 15분 지연), 나머지는 한투 금리판(rates)을 그대로 글로벌 줄 모양으로
   * 바꿔 끼운다. 그래서 ⚙ 에서 숨기고 차례를 바꾸는 것도 다른 줄과 똑같이 된다.
   * 오늘 값이 아닌 줄은 심볼 자리에 「MM/DD 종가」를 적는다 — 규칙은 하나, 오늘 값이 아니면 언제 값인지.
   */
  const rateQuotes: GRow[] = (() => {
    const out: GRow[] = [];
    const color = "#c9a227";
    for (const k of US_YIELD_KEYS) {
      const r = (usMajor.data?.rows ?? []).find((x) => x.key === k);
      if (!r || r.price === null) continue;
      out.push({ key: `rate:${k}`, label: r.label, group: "금리", symbol: r.symbol, price: r.price, change: r.change ?? null, changeRate: null, isRate: true, error: null, color, signal: null });
    }
    const hantoo = (rates.data ?? []).filter((r) => r.group !== "해외" || HANTOO_ONLY_RATES.includes(r.code));
    /* 해외(기준금리·일본)가 먼저 — 요즘 시장을 흔드는 게 미국 금리라서. 국내는 그 뒤 */
    for (const r of [...hantoo.filter((r) => r.group === "해외"), ...hantoo.filter((r) => r.group !== "해외")]) {
      out.push({ key: `rate:${r.code}`, label: r.name, group: "금리", symbol: "", price: r.rate, change: r.change, changeRate: null, isRate: true, error: null, color, signal: null, asOf: r.asOf });
    }
    return out;
  })();
  const gAll: GRow[] = (() => {
    const base: GRow[] = global.data ?? [];
    if (rateQuotes.length === 0) return base;
    const i = base.map((g) => g.group).lastIndexOf("미국 지수선물");
    return i < 0 ? [...base, ...rateQuotes] : [...base.slice(0, i + 1), ...rateQuotes, ...base.slice(i + 1)];
  })();

  /* 순서 — 적어 둔 차례 먼저, 나머지는 서버 차례. 새 줄이 생겨도 뒤에 붙는다 */
  const gOrdered = (() => {
    const all = gAll;
    const idx = new Map(gRows.order.map((k, i) => [k, i]));
    /*
     * 적어 둔 차례에 없는 줄(새로 생긴 줄, 예: 금리)은 **끝으로 밀지 않고 제자리 근처에** 둔다 —
     * 바로 앞의 아는 줄 뒤에. 안 그러면 순서를 한 번이라도 저장한 사람에겐 새 묶음이 늘 맨 아래로 갔다.
     */
    const pos = new Map<string, number>();
    let last = -1;
    all.forEach((g, i) => {
      const k = idx.get(g.key);
      if (k !== undefined) {
        last = k;
        pos.set(g.key, k);
      } else pos.set(g.key, last + 0.5 + i * 1e-6);
    });
    return [...all].sort((a, b) => (pos.get(a.key) ?? 0) - (pos.get(b.key) ?? 0));
  })();
  const gVisible = gOrdered.filter((g) => !gRows.hidden.includes(g.key));
  const gMove = (key: string, d: -1 | 1) => {
    const keys = gOrdered.map((g) => g.key);
    const i = keys.indexOf(key);
    const j = i + d;
    if (i < 0 || j < 0 || j >= keys.length) return;
    [keys[i], keys[j]] = [keys[j], keys[i]];
    saveGRows({ ...gRows, order: keys });
  };
  const gToggle = (key: string) =>
    saveGRows({ ...gRows, hidden: gRows.hidden.includes(key) ? gRows.hidden.filter((k) => k !== key) : [...gRows.hidden, key] });

  /** 모든 섹션을 한 번에 다시 불러온다 */
  function refreshAll() {
    indices.refresh();
    flow.refresh();
    movers.refresh();
    themes.refresh();
    highLow.refresh();
    vi.refresh();
    global.refresh();
    reloadLens();
  }

  useEffect(() => {
    api.marketStatus().then(setStatus).catch(() => {});
    const timer = setInterval(() => {
      setNow(new Date());
      api.marketStatus().then(setStatus).catch(() => {});
    }, 30_000);
    return () => clearInterval(timer);
  }, []);

  // 데스크톱(700px~)에서는 서브탭 없이 전 섹션을 보여준다
  /*
   * 카드 배치.
   *
   * 목록은 `overviewCards.ts` 하나뿐이다 — 설정 화면도 같은 것을 본다.
   * 순서를 바꾸는 손잡이는 **설정 > 화면 > 시황 카드 순서**에 있다.
   * 배치는 한 번 정하면 끝나는 값이라, 매일 보는 화면의 맨 윗줄을 차지할 이유가 없다.
   */
  const keysHere =
    sub === "us" ? [] : (OVERVIEW_CARDS[sub as OverviewSub] ?? []).map((c) => c.key);
  /*
   * 저장 자리를 `overview2` 로 올림 (2026-09-10 저녁) — 기본 차례를 바꿨다(주도주·조회순위가 앞, 테마 흐름이 뒤).
   * 예전 저장본을 그대로 쓰면 새 카드가 맨 뒤에 붙고 옛 차례가 남는다.
   */
  const cards = useCardOrder(`overview2.${sub}`, keysHere);
  /* 벽돌 쌓기 — 긴 카드 옆이 비지 않게 (2026-09-10) */
  const gridRef = useRef<HTMLDivElement>(null);
  useMasonryGrid(gridRef, 700, 4, 12);

  const [wide, setWide] = useState(() => window.matchMedia("(min-width:700px)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(min-width:700px)");
    const handler = (e: MediaQueryListEvent) => setWide(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  /*
   * 어떤 카드를 보일지.
   * 넓은 화면에서는 국내 카드가 한꺼번에 뜬다. 다만 **미국 전광판을 보고 있을 때는
   * 국내 카드를 전부 내린다** — 섞어 두면 「미국장 도는 동안 보는 자리」라는 뜻이 사라진다.
   */
  /*
   * 어떤 카드를 보일지.
   *
   * **넓은 화면에서도 탭을 따른다.** 예전엔 `wide` 면 요약·수급·순위를 한꺼번에 띄웠는데,
   * PC 에서 카드 열넷이 한 화면에 쏟아져 무엇을 보러 왔는지 잃는다 —
   * 폰에서는 셋으로 나뉘어 있던 것이 PC 에서만 뒤죽박죽이었다.
   * 폰과 PC 가 같은 구조여야 오갈 때 헤매지 않는다.
   */
  const show = (sec: SubTab) => sub === sec;

  /* 폰 — 본문 좌우 스와이프로 국내↔미국 (2026-08-28) */
  const swipe = useSwipeTabs({
    order: SUBTABS.map((t) => t.key),
    current: sub,
    onChange: (k) => setSub(k as SubTab),
  });

  const idx = indices.data ?? [];
  const kospiCard = idx.find((i) => i.code === "001");
  const kosdaqCard = idx.find((i) => i.code === "101");

  function stockRow(r: StockRow, i: number) {
    const code = normalizeStockCode(r.code);
    return (
      <button key={`${r.code}-${i}`} className="ov-li" onClick={() => onSelectStock(code, r.name)}>
        <span className="ov-rank num">{i + 1}</span>
        <span className="ov-nm">
          <WatchStar code={code} />
<SuperMark code={code} />
          {r.name}
        </span>
        <span className={`ov-px num ${signCls(r.changeRate)}`}>{fmtNum(r.price)}</span>
        <span className={`ov-pct num ${signCls(r.changeRate)}`}>{fmtPct(r.changeRate)}</span>
      </button>
    );
  }

  return (
    /* ⚠️ 스프레드가 className 을 덮으므로 합쳐서 넘긴다 — "ov" 를 잃으면 화면이 통째로 깨진다 */
    <div {...swipe} className={`ov ${swipe.className}`}>
      <RefreshBar onRefresh={refreshAll} loading={indices.loading}>
        <span className="ov-statusbar" style={{ padding: 0 }}>
          <span className={`ov-dot ${status?.state ?? ""}`} />
          <span>
            {status?.label ?? "-"} · {now.toLocaleTimeString("ko-KR", { hour12: false })}
          </span>
        </span>
      </RefreshBar>

      {/*
        탭 바.
        좁은 화면에서는 넷을 다 보여 카드를 나눠 본다.
        **넓은 화면에서는 국내/미국 둘뿐이다** — 거기서는 국내 카드가 어차피 한꺼번에
        뜨므로 요약·수급·순위를 나누는 게 뜻이 없고, 미국 전광판만 갈아 끼우면 된다.
        예전엔 넓은 화면에서 탭 바를 통째로 숨겼는데, 그러면 미국으로 갈 방법이 없다.
      */}
      <div className="ov-subtabs">
        {SUBTABS.map((t) => (
          <button
            key={t.key}
            className={`ov-subtab${sub === t.key ? " on" : ""}`}
            onClick={() => setSub(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="ov-grid" ref={gridRef}>
        {/* ---------------- 요약 ---------------- */}
        {/*
          미국 전광판. 다른 탭과 달리 **넓은 화면에서도 따로 둔다**(`show` 를 안 쓴다) —
          국내 카드 사이에 섞으면 「미국장 도는 동안 보는 자리」라는 뜻이 사라진다.
        */}
        {sub === "us" && <UsBoardPanel />}

        {/*
          국내 시장 신호등도 맨 위다. 미국 전광판과 같은 자리에 같은 모양으로 둔다 —
          두 판을 오가며 볼 때 눈이 같은 곳을 찾게 해야 한다.
          좁은 화면에서는 요약 탭에만 띄운다(수급·순위 탭에서는 자리만 먹는다).
        */}
        {sub === "summary" && (
          <div className="ov-span-all">
            {/* 시황 대시보드에서는 접을 수 있고 기본이 접음 (2026-09-03 — "화면차지가 너무 큰데") */}
            <MarketSignalPanel collapsible />
          </div>
        )}

        {show("summary") && (
          <OverviewCard title="국내 지수" badge={<SessionBadge kind="kr" />} order={cards.orderOf("indices")} updatedAt={indices.updatedAt} loading={indices.loading} error={indices.error}>
            {/* 본문은 보드 지수판과 공용 (DomesticIndexGrid) — 두 번 그리면 갈라진다 */}
            <DomesticIndexGrid
              idx={idx}
              flow={flow.data}
              futFlow={futFlow}
              onOpenIndex={setIndexDetail}
              onOpenFutures={setFutDetail}
            />
          </OverviewCard>
        )}

        {show("summary") && (
          <OverviewCard
            order={cards.orderOf("updown")}
            title="종목등락현황"
            updatedAt={indices.updatedAt}
            loading={indices.loading}
            error={indices.error}
          >
            {/* 표 본체도 보드 지수판과 공용 */}
            <UpDownTable cards={[kospiCard, kosdaqCard]} />
          </OverviewCard>
        )}

        {/*
          주도주·급소 (2026-09-10) — 종목등락현황의 「상한가 12개」 다음 물음은 「누구냐」다.
          상한가 얼굴(며칠째) → 거래가 붙는 곳(급증·1년 최대) → 큰돈의 방향(프로그램).
        */}
        {show("summary") && (
          <OverviewCard order={cards.orderOf("pulse")} title="주도주·급소">
            <div className="ov-card-b">
              <PulsePanel onSelectStock={(code, name) => onSelectStock(normalizeStockCode(code), name)} />
            </div>
          </OverviewCard>
        )}
        {/* 실시간 조회순위 — 눈이 몰리는 종목 열 (2026-09-10 저녁). 시세분석 표와 같은 응답 */}
        {show("summary") && (
          <OverviewCard order={cards.orderOf("inquiry")} title="실시간 조회순위">
            <div className="ov-card-b">
              <InquiryRankPanel onSelectStock={(code, name) => onSelectStock(normalizeStockCode(code), name)} />
            </div>
          </OverviewCard>
        )}

        {/* 거래대금 현황 — 폭(위 표) 다음 물음이 유동성이다. 줄을 누르면 추이가 펼쳐진다 */}
        {show("summary") && (
          <OverviewCard order={cards.orderOf("turnover")} title="거래대금 현황">
            <TurnoverPanel />
          </OverviewCard>
        )}

        {/*
          글로벌 — **종목등락현황 바로 밑**이다.

          국내 지수 → 종목등락현황으로 "우리 시장이 지금 어떤가"를 본 직후,
          "그 힘이 어디서 왔나"를 이어서 본다. 예전엔 업종 뒤에 있어서 국내를 다 훑고
          한참 내려가야 나왔는데, 그러면 국내와 견주는 일이 안 된다.
        */}
        {show("summary") && (
          <OverviewCard
            title="글로벌"
            badge={
              <button type="button" className={`ov-gear${gEdit ? " on" : ""}`} title="무엇을 어떤 차례로 볼지" onClick={() => setGEdit((v) => !v)}>
                ⚙
              </button>
            }
            order={cards.orderOf("global")}
            updatedAt={global.updatedAt}
            loading={global.loading}
            error={global.error}
          >
            <div className="ov-card-b">
              {gEdit && (
                <div className="ov-g-edit">
                  <div className="ov-g-edit-h">
                    줄마다 켜고 끄고, ▲▼ 로 차례를 바꿉니다. 이 기기에만 남습니다.
                    <button type="button" className="filter-btn" onClick={() => saveGRows({ hidden: ["jpykrw"], order: [] })}>
                      처음대로
                    </button>
                  </div>
                  {gOrdered.map((g) => (
                    <div key={g.key} className={`ov-g-edit-row${gRows.hidden.includes(g.key) ? " off" : ""}`}>
                      <label>
                        <input type="checkbox" checked={!gRows.hidden.includes(g.key)} onChange={() => gToggle(g.key)} />
                        <span className="ov-g-edit-grp" style={{ color: g.color }}>{g.group}</span>
                        <b>{g.label}</b>
                        <i>{g.symbol}</i>
                      </label>
                      <span className="ov-g-edit-mv">
                        <button type="button" className="gt-move" onClick={() => gMove(g.key, -1)} title="위로">▲</button>
                        <button type="button" className="gt-move" onClick={() => gMove(g.key, 1)} title="아래로">▼</button>
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {/*
                섹터별로 묶는다. 스무 줄을 그냥 나열하면 **어디까지가 원자재이고
                어디부터가 아시아 지수인지** 알 수 없다 — 서버는 이미 group 을 주는데
                화면이 그걸 버리고 있었다.
              */}
              {[...new Set(gVisible.map((g) => g.group))].map((grp) => {
                // 색은 서버가 정한다 — 리포트도 같은 색을 쓴다
                const color = gVisible.find((g) => g.group === grp)?.color ?? "#8b98a5";
                return (
                <div className="ov-g-sec" key={grp} style={{ ["--g" as string]: color }}>
                  {/*
                    묶음마다 **지금 도는 장인지**를 붙인다 (2026-09-08 — 벤티지 "장이 시작된
                    건지 끝난 건지를 모르겠네"). 한 카드에 야간선물·환율·미국선물·아시아가
                    같이 있는데, 숫자만 보면 지금 뛰는 값과 몇 시간 전에 끝난 값이 똑같이 생겼다.
                  */}
                  <div className="ov-g-sec-h" title={grp === "금리" ? "%p 는 등락률이 아니라 변화폭입니다. 미국 넷은 야후(약 15분 지연), 기준금리·일본·국내는 한국투자증권 금리판 — 오늘 값이 아니면 「MM/DD 종가」를 적습니다" : undefined}>
                    {grp}
                    {kindOfGroup(grp) && <SessionBadge kind={kindOfGroup(grp)!} />}
                  </div>
                  {gVisible
                    .filter((g) => g.group === grp)
                    /*
                      줄 전체가 눌린다 — 환율·선물·원자재 전부 야후 심볼이라 같은 차트
                      시트로 추이가 열린다. 숫자 한 줄은 「지금 얼마」만 말하고
                      「어디쯤인가」는 못 말한다.
                    */
                    .map((g) => (
                <button
                  type="button"
                  className={`ov-g-row${g.symbol ? " ov-g-click" : ""}`}
                  key={g.key}
                  disabled={!g.symbol}
                  onClick={() =>
                    g.symbol &&
                    setChart({
                      /* 야간선물 줄은 야후가 아니라 한투 CM — 심볼이 월물코드다 */
                      kind: g.key === "krNightFut" ? "futures" : undefined,
                      symbol: g.symbol,
                      label: g.label,
                      digits: g.isRate ? 3 : 2,
                      hintRate: g.changeRate,
                      hintPrice: g.price,
                    })
                  }
                  title="눌러서 차트 보기"
                >
                  {/* 미장 주요지수와 같은 신호등. 판단할 게 없으면 자리만 비워 둔다 */}
                  <span
                    className={`ov-g-sig${g.signal ? ` ${g.signal.level}` : ""}`}
                    title={g.signal?.why}
                  />
                  <span className="ov-g-nm">
                    {g.label}
                    {/* 금리(한투)는 심볼이 없다 — 그 자리에 「MM/DD 종가」. 오늘 값이면 비운다 */}
                    <span className={`ov-g-tk${g.asOf && pastBadge(g.asOf) ? " ov-g-as" : ""}`}>{g.symbol || (g.asOf ? pastBadge(g.asOf) : "")}</span>
                    {/*
                      「n분 전」 (2026-09-10) — 야후는 CME 선물·원자재를 10분, 채권·아시아 지수를
                      15~20분 지연으로 준다. 3분 넘게 묵은 값이면 몇 분 전 값인지 적어 둔다.
                      하루 넘게 묵은 건(장 마감) 안 적는다 — 그건 지연이 아니라 휴장이다.
                    */}
                    {lagBadge(g.quotedAt)}
                  </span>
                  {g.error ? (
                    <span className="ov-g-pct" style={{ color: "var(--flat)" }}>
                      조회 실패
                    </span>
                  ) : (
                    <>
                      <span className="ov-g-px num">
                        {/* 금리는 소수 셋째 자리까지 그대로 — 4.550 을 4.55 로 줄이면 자릿수가 들쭉날쭉해진다 */}
                        {g.price === null ? "-" : g.isRate ? `${g.price.toFixed(3)}%` : fmtNum(Number(g.price.toFixed(2)))}
                      </span>
                      {/* 금리는 변화폭(%p)만 — 등락률로 보면 감이 안 온다 (4.71→4.72 는 0.2% 지만 0.01%p 가 뜻) */}
                      <span className={`ov-g-pct num ${signCls(g.isRate ? (g.change ?? 0) : (g.changeRate ?? 0))}`}>
                        {g.change === null
                          ? "-"
                          : g.isRate
                            ? `${g.change > 0 ? "+" : ""}${g.change.toFixed(3)}%p`
                            : `${g.change > 0 ? "+" : ""}${g.change.toFixed(2)} (${fmtPct(g.changeRate ?? 0)})`}
                      </span>
                    </>
                  )}
                </button>
                    ))}
                </div>
                );
              })}
            </div>
          </OverviewCard>
        )}

        {/*
          미장 주요지수 — 국내 지수 → 종목등락현황 **다음** 자리다.
          아침에 "밤사이 무슨 일이 있었나"를 한 표로 읽는 곳이라, 국내를 본 직후에 와야 한다.
        */}
        {/*
          미장 주요지수 카드는 숨겼다 (2026-08-25, PDF #6 — 사용자 요청).
          전일 마감값 표라 글로벌의 선물과 겹쳤다. 남길 것은 옮겼다 —
          야간선물은 글로벌 맨 위로, VIX 는 지수선물 묶음 아래로, WTI·브렌트는
          원자재로. 장단기 역전 경고는 맥박(risks)이 서버 쪽에서 계속 본다.
          미국 현물 전광판은 「미국」 서브탭에 그대로 있다.
        */}

        {/* 금리 카드는 글로벌 안 「금리」 묶음으로 합쳤다 (2026-09-08) — 위 rateQuotes */}

        {/*
          시장 체온계 (2026-08-28) — 「시장 폭 추이」를 갈아끼웠다.
          하루씩 쌓던 폭 그래프는 서버를 새로 켜면 비었는데, 체온계는 일봉 캐시로
          40일치를 소급해 낸다. 같은 물음(장이 넓게 사는가)에 더 긴 답이다.
          key 는 "breadth" 그대로 — 저장된 배치가 자리를 기억한다.
        */}
        {show("summary") && (
          <OverviewCard title="시장 체온계" order={cards.orderOf("breadth")}>
            <div className="ov-card-b">
              <ThermoPanel lens={lens} />
            </div>
          </OverviewCard>
        )}

        {/*
          여기가 ⑤ 증시주변자금 동향 자리다 — 고객예탁금·미수금·신용잔고·선물예수금.
          키움에도 한투에도 없어서 공공데이터포털 키가 생겨야 붙는다. 그때 여기 끼운다.
        */}

        {/*
          테마 흐름 (2026-08-28) — 「업종」을 갈아끼웠다. 거래소 업종 분류는 이 앱의
          눈금과 안 맞아 신호등 가중치에서도 뺐다 — 대시보드에만 남을 이유가 없다.
          대신 로테이션(주도/부상/휴식)이 「오늘 어느 판이 도는가」에 바로 답한다.
          key 는 "sectors" 그대로 — 저장된 배치가 자리를 기억한다.
        */}
        {show("summary") && (
          <OverviewCard title="테마 흐름" order={cards.orderOf("sectors")}>
            <RotationStrip lens={lens} onSelectStock={onSelectStock} />
            {lens?.rotation.ready && (
              <div className="table-note">
                거래대금 300억↑ 테마 {lens.rotation.universe}개를 오늘 × 한 달 누적으로
                나눕니다 — 판 전체는 <b>시장 흐름 분석 &gt; 테마 로테이션</b>.
              </div>
            )}
          </OverviewCard>
        )}



        {/* ---------------- 수급 ---------------- */}
        {show("flow") && (
          <OverviewCard
            title="투자자별 수급"
            subtitle={`${flowMarket === "kospi" ? "코스피" : "코스닥"} · 억원`}
            loading={flow.loading}
            error={flow.error}
            span2
          >
            <SegmentToggle
              options={[
                { key: "kospi" as const, label: "코스피" },
                { key: "kosdaq" as const, label: "코스닥" },
              ]}
              value={flowMarket}
              onChange={setFlowMarket}
            />
            {flow.data && <FlowBars flow={flow.data[flowMarket]} />}
            {/*
              누적 막대 밑에 장중 변화. 막대만 보면 오전에 팔다 오후에 산 날과
              하루 종일 판 날이 똑같이 생긴다 — 방향이 바뀐 지점이 보여야 한다.
            */}
            <FlowIntradayChart market={flowMarket} />
          </OverviewCard>
        )}

        {/* ---------------- 순위 ---------------- */}
        {/*
          순위 탭의 맨 위. 상위 계좌들이 무엇을 사는지가 다른 순위표보다 먼저 온다 —
          거래대금·등락률 순위는 "무엇이 움직였나"이고 이건 "누가 움직였나"다.
        */}
        {show("rank") && (
          <OverviewCard
            order={cards.orderOf("topTraders")}
            title="수익률 상위 고객 매매동향"
          updatedAt={topTraders.updatedAt}
          loading={topTraders.loading}
          error={topTraders.error}
        >
          <div className="ov-card-b">
            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th className="sticky-col">종목</th>
                    <th>현재가</th>
                    <th>등락률</th>
                    <th title="상위 계좌들의 순매수 금액">순매수</th>
                    <th title="이 종목을 들고 있는 상위 계좌 수 — 한 계좌의 몰빵인지 여럿이 보는지">
                      계좌
                    </th>
                    <th>평균단가</th>
                    <th title="그 계좌들의 이 종목 수익률">수익률</th>
                  </tr>
                </thead>
                <tbody>
                  {(topTraders.data ?? []).slice(0, 20).map((r) => (
                    <tr
                      key={r.code}
                      className="clickable-row"
                      onClick={() => onSelectStock(normalizeStockCode(r.code), r.name)}
                    >
                      <td className="sticky-col">{r.name}</td>
                      <td className="num">{fmtNum(r.price)}</td>
                      <td className={`num ${signCls(r.changeRate)}`}>{fmtPct(r.changeRate)}</td>
                      <td className={`num ${signCls(r.netAmount)}`}>
                        {Math.round(r.netAmount).toLocaleString("ko-KR")}억
                      </td>
                      <td className="num">{r.accounts}</td>
                      <td className="num pt-n">{fmtNum(r.avgBuyPrice)}</td>
                      <td className={`num ${signCls(r.profitRate)}`}>
                        {r.profitRate > 0 ? "+" : ""}
                        {r.profitRate.toFixed(0)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="table-note">
              키움 <b>수익률 상위 고객</b> 계좌들의 매매입니다(상위 20종목). 금액은 억원.
              <b>계좌 수</b>를 같이 보세요 — 한 계좌가 크게 담은 것과 여럿이 함께 담은 것은
              뜻이 다릅니다. <b>참고 자료</b>이지 매매 근거가 아닙니다.
            </div>
          </div>
        </OverviewCard>
      )}

        {show("rank") && (
          <OverviewCard title="등락률 순위" order={cards.orderOf("movers")} updatedAt={movers.updatedAt} loading={movers.loading} error={movers.error}>
            <SegmentToggle
              options={[
                { key: "rising" as const, label: "상승" },
                { key: "falling" as const, label: "하락" },
              ]}
              value={moverDir}
              onChange={setMoverDir}
            />
            <RankList items={movers.data?.[moverDir] ?? []} renderItem={stockRow} />
          </OverviewCard>
        )}

        {show("rank") && (
          <OverviewCard title="테마" order={cards.orderOf("themes")} updatedAt={themes.updatedAt} loading={themes.loading} error={themes.error}>
            <SegmentToggle
              options={[
                { key: "top" as const, label: "상위" },
                { key: "bottom" as const, label: "하위" },
              ]}
              value={themeDir}
              onChange={setThemeDir}
            />
            <RankList
              items={themes.data?.[themeDir] ?? []}
              renderItem={(t: ThemeRow, i) => (
                <button
                  className="ov-li"
                  key={`${t.code}-${i}`}
                  onClick={() => setConstituent({ kind: "theme", code: t.code, name: t.name })}
                >
                  <span className="ov-nm">
                    {t.name}
                    <span className="ov-sub-nm">
                      {t.stockCount}종목 · {t.mainStock}
                    </span>
                  </span>
                  <span className={`ov-pct num ${signCls(t.changeRate)}`}>{fmtPct(t.changeRate)}</span>
                </button>
              )}
            />
          </OverviewCard>
        )}

        {/*
          250일 신고가·VI 는 **순위**다. 시황이 아니다 —
          시황은 시장이 어디로 가는지를 보는 자리이고, 이 둘은 종목을 고르는 자리다.
          요약 탭에 섞여 있으니 지수·수급·금리를 훑는 흐름이 끊겼다. 순위 맨 아래로 옮긴다.
        */}
        {show("rank") && (
          <OverviewCard
            order={cards.orderOf("highLow")}
            title="250일 신고가 / 신저가"
            updatedAt={highLow.updatedAt}
            loading={highLow.loading}
            error={highLow.error}
          >
            <SegmentToggle
              options={[
                { key: "high" as const, label: "신고가" },
                { key: "low" as const, label: "신저가" },
              ]}
              value={hlDir}
              onChange={setHlDir}
            />
            <RankList items={highLow.data?.[hlDir] ?? []} renderItem={stockRow} />
          </OverviewCard>
        )}

        {show("rank") && (
          <OverviewCard title="변동성 완화 (VI)" order={cards.orderOf("vi")} updatedAt={vi.updatedAt} loading={vi.loading} error={vi.error}>
            <RankList
              items={vi.data ?? []}
              emptyText="발동 종목 없음"
              renderItem={(v: ViRow, i) => (
                <button
                  key={`${v.code}-${i}`}
                  className="ov-li"
                  onClick={() => onSelectStock(normalizeStockCode(v.code), v.name)}
                >
                  <span className="ov-nm">
                    <WatchStar code={normalizeStockCode(v.code)} />
<SuperMark code={normalizeStockCode(v.code)} />
                    {v.name}
                    <span className="ov-sub-nm">{v.motionCount}회 발동</span>
                  </span>
                  <span className="ov-px num">{fmtNum(v.motionPrice)}</span>
                  <span className={`ov-pct num ${signCls(v.openChangeRate)}`}>{fmtPct(v.openChangeRate)}</span>
                </button>
              )}
            />
          </OverviewCard>
        )}



      </div>

      {/*
        수익률 상위 고객 매매동향 — **맨 아래**다.

        키움에서 실제로 잘 벌고 있는 계좌들이 무엇을 사는지 보여 준다. 외국인·기관은
        규모가 커서 방향이 굼뜨고 개인 수급은 방향이 없는데, 이건 그 사이다 —
        개인이되 **결과로 걸러진** 개인이다.

        맨 아래인 이유는 **참고 자료**이기 때문이다. 이걸 보고 따라 사는 건 이 프로젝트가
        하려는 일이 아니라, 앞의 지표들을 다 보고 난 뒤 곁눈질하는 자리에 둔다.
      */}

      {/* 시장 폭 도움말은 카드와 함께 뺐다 (2026-08-28) — 체온계가 제 설명을 달고 있다 */}

      {indexDetail && (
        <IndexDetailSheet code={indexDetail} onClose={() => setIndexDetail(null)} />
      )}

      {futDetail && <FuturesDetailSheet target={futDetail} onClose={() => setFutDetail(null)} />}

      {/* 글로벌·미장·미국 금리 줄에서 연 추이 차트 */}
      {chart && <YahooChartSheet target={chart} onClose={() => setChart(null)} />}

      {constituent && (
        <ConstituentSheet
          target={constituent}
          onClose={() => setConstituent(null)}
          onSelectStock={(code, name) => {
            setConstituent(null);
            onSelectStock(code, name);
          }}
        />
      )}
    </div>
  );
}
