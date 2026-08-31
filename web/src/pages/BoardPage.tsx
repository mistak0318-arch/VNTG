import { useCallback, useEffect, useRef, useState } from "react";
import { removePref, setPref } from "../prefs";
import { api, pickList, type RawRecord } from "../api";
import { InvestorTrendTable } from "../components/InvestorTrendTable";
import { ChartPanel } from "../components/ChartPanel";
import { IndexChartCell } from "../components/IndexChartCell";
import { OrderBookPanel } from "../components/OrderBookPanel";
import { BrokerFlowPanel } from "../components/BrokerFlowPanel";
import { ProgramFlowPanel } from "../components/ProgramFlowPanel";
import { OpinionPanel } from "../components/OpinionPanel";
import { SupplyDetailPanel } from "../components/SupplyDetailPanel";
import { SignalPanel } from "../components/SignalLight";
import { ChartInsights } from "../components/ChartInsights";
import { IntradayFlow } from "../components/IntradayPanels";
import { NewsList, DisclosureList } from "../components/NewsDisclosurePanel";
import { FinancePanel } from "../components/FinancePanel";
import { CompanySnapshot } from "../components/CompanySnapshot";
import { SectorMoodPanel } from "../components/SectorMoodPanel";
import { StockNotes } from "../components/StockNotes";
import { BreadthPanel } from "../components/BreadthPanel";
import { MarketSignalPanel } from "../components/MarketSignalPanel";
import { MarketPulsePanel } from "../components/MarketPulsePanel";
import { SectorFlowPanel } from "../components/SectorFlowPanel";
import { ViPanel } from "../components/ViPanel";
import { WatchTicker } from "../components/WatchTicker";
import { IndexBoard } from "../components/IndexBoard";
import { BriefingTrioCell } from "../components/BriefingBlocks";
import { ChannelDigestPanel } from "../components/ChannelDigestPanel";
import { ChannelSearchPanel } from "../components/ChannelSearchPanel";
import { SupplyMini } from "../components/SupplyMini";
import { StockSummaryPanel } from "../components/StockSummaryPanel";
import { PriceHeader } from "../components/PriceHeader";
import { IntradayLevelsBar } from "../components/IntradayLevelsBar";
import { useLive } from "../useLive";
import { useStockFocus } from "../useStockFocus";
import { BoardCell, CellStockFinder, type CellSize } from "../components/BoardCell";
import { winStore } from "../boardStore";

/**
 * 보드 — **다른 창에서 고른 종목을 따라 그린다.**
 *
 * ## 왜 따로 있나
 *
 * 종목발굴이나 순위 화면은 「고르는 자리」다. 거기서 종목을 하나씩 눌러 보며
 * 차트와 수급을 같이 보려면 창을 계속 열었다 닫아야 한다.
 * 모니터가 여러 대면 **한쪽은 고르고 한쪽은 보는** 게 자연스러운데, 브라우저 창은
 * 서로 남남이라 그게 저절로 안 된다. 이 화면이 받는 쪽이다.
 *
 * ## 쓰는 법
 *
 *   1. 이 창에서 **연동을 켠다**
 *   2. 다른 창(다른 모니터)에서도 연동을 켜고 종목을 누른다
 *   3. 이 창이 그 종목으로 바뀐다
 *
 * ## 무엇을 띄울지는 고른다
 *
 * 여섯 개를 다 켜면 한 화면에 안 들어온다. **보고 싶은 것만** 켜서 모니터 크기에
 * 맞추는 게 맞다 — 27인치 한 대와 노트북은 담을 수 있는 양이 다르다.
 * 고른 것은 이 기기에만 남는다.
 */

/**
 * 투자자 수급만 **스스로 받아 온다.**
 *
 * 다른 칸들은 `code` 만 주면 알아서 그리는데, 투자자 수급표는 종목 상세가 받아 둔
 * 값을 얻어 쓰는 구조라 여기서는 쓸 수가 없다. 표를 고치면 상세 화면까지 흔들리므로
 * **받아 오는 껍데기만** 여기에 둔다.
 */
function InvestorBlock({ code }: { code: string }) {
  const [rows, setRows] = useState<RawRecord[] | null>(null);

  useEffect(() => {
    let alive = true;
    setRows(null);
    api
      .investorChart(code)
      .then((r) => {
        if (alive) setRows(pickList(r as RawRecord, ["stk_invsr_orgn_chart"]));
      })
      .catch(() => {
        if (alive) setRows([]);
      });
    return () => {
      alive = false;
    };
  }, [code]);

  if (rows === null) return <div className="empty">불러오는 중…</div>;
  return <InvestorTrendTable rows={rows} />;
}

/**
 * 종목 기본정보를 받아 두는 껍데기.
 *
 * 「기업분석」과 「장중 수급」은 `code` 만으로는 못 그린다 — 시가총액·기준가 같은
 * 값이 필요한데 그건 종목 상세가 따로 받아 두는 것이다.
 * 두 칸이 각자 받으면 같은 걸 두 번 받게 되므로 여기서 한 번 받아 나눠 준다.
 */
function useStockInfo(code: string): RawRecord | null {
  const [info, setInfo] = useState<RawRecord | null>(null);
  useEffect(() => {
    let alive = true;
    setInfo(null);
    if (!code) return;
    api
      .stockInfo(code)
      .then((r) => {
        if (alive) setInfo(r as RawRecord);
      })
      .catch(() => {
        if (alive) setInfo(null);
      });
    return () => {
      alive = false;
    };
  }, [code]);
  return info;
}

/**
 * 보드에 띄울 수 있는 칸.
 *
 * **종목 상세에서 볼 수 있는 것은 다 있어야 한다.** 보드를 띄워 두고 다른 창에서
 * 종목만 바꿔 가며 보는 자리인데, 여기서 못 보는 게 있으면 결국 상세 창을 또 열게 되고
 * 그러면 보드를 쓸 이유가 없어진다.
 *
 * 순서는 **자주 보는 것부터**다 — 처음 켰을 때 위에서부터 고르게 된다.
 */
const BLOCKS = [
  /*
   * **종목과 무관한 칸**(`market: true`).
   *
   * 여기가 없어서 보드로 HTS 1·3번 모니터를 못 흉내 냈다 — 지수판·시장 수급 같은 건
   * 종목이 바뀌어도 안 바뀌는 것들인데, 모든 칸이 종목에 매여 있었다.
   * 연동이 꺼져 있거나 종목이 아직 안 왔을 때도 **이 칸들은 그려진다.**
   */
  /* 시황의 세 카드(국내 지수·등락현황·거래대금)를 일자로 붙인 판이라 넓은 칸이 맞다 (2026-08-26) */
  { key: "mktIndex", label: "지수판", wide: true },
  /*
    지수 봉차트 칸. 지수판이 「지금 몇인가」라면 이건 「어떻게 왔나」다.
    칸마다 어느 지수를 볼지 따로 기억하므로 **왼쪽은 코스피, 오른쪽은 코스닥**으로 둘 수 있다.
  */
  { key: "mktIndexChart", label: "지수 차트", wide: false },
  { key: "mktSignal", label: "시장 신호등", wide: false },
  { key: "mktPulse", label: "시장 맥박", wide: false },
  { key: "mktBreadth", label: "상승·하락 종목수", wide: false },
  { key: "mktSector", label: "업종 수급", wide: true },
  { key: "mktVi", label: "VI 발동", wide: false },
  { key: "mktWatch", label: "관심종목 시세판", wide: false },
  /* 마켓 브리핑의 세 조각(오늘 수급·테마·관심종목 히트맵)을 한 줄로 (2026-08-27) */
  { key: "mktBrief", label: "수급·테마·관심종목", wide: true },
  /*
   * 텔레그램 **동향** — 채널 전체가 무슨 말을 하나. 종목과 무관하다.
   * 수집 구간과 선별·AI 정리는 패널이 이미 갖고 있다.
   */
  { key: "mktTelegram", label: "텔레그램 동향", wide: true },

  { key: "chart", label: "차트", wide: true },
  { key: "insights", label: "이동평균·매물대", wide: false },
  { key: "signal", label: "신호등", wide: false },
  { key: "orderbook", label: "호가", wide: false },
  { key: "intraday", label: "장중 수급", wide: false },
  /*
   * 당일 수급 **미니** — 곁눈으로 보는 자리.
   *
   * 투자자 수급표는 열세 칸에 며칠치를 쌓아서 파고들 때는 맞지만 보드에 놓으면 크다.
   * 오늘 하루만 세 줄로 줄이고, 기관은 성격이 다른 넷으로 쪼개 아래에 붙인다.
   */
  { key: "supplyMini", label: "당일수급(미니)", wide: false },
  /* KRX/NXT 저·고·종가 한눈 카드 — 상세 종합의 한 장 요약을 그대로 (PDF #12) */
  { key: "priceSummary", label: "가격 요약", wide: false },
  { key: "investor", label: "투자자 수급", wide: false },
  { key: "broker", label: "거래원", wide: false },
  { key: "program", label: "프로그램", wide: false },
  { key: "supply", label: "공매도·대차", wide: false },
  { key: "opinion", label: "목표주가", wide: false },
  { key: "news", label: "뉴스", wide: false },
  { key: "disclosure", label: "공시", wide: false },
  { key: "finance", label: "재무", wide: false },
  { key: "summary", label: "기업분석", wide: false },
  { key: "sector", label: "업종·테마", wide: false },
  /*
   * 텔레그램 **검색** — 종목을 따라간다.
   *
   * 「동향」과 다른 물음이다. 동향은 채널 전체가 무슨 말을 하나이고 이건
   * **이 종목이 언급됐나**다. 정리본에는 그 종목이 아예 안 뽑혔을 수 있다.
   * 보드에 띄워 두면 종목을 바꿀 때마다 그 종목으로 저절로 찾는다.
   */
  { key: "telegram", label: "텔레그램 검색", wide: true },
  { key: "notes", label: "메모", wide: false },
] as const;

type BlockKey = (typeof BLOCKS)[number]["key"];

/**
 * 종목과 무관한 칸.
 *
 * 블록 객체에 표시를 달면 `as const` 때문에 어떤 항목에만 그 속성이 생겨서
 * 타입이 갈린다. 키 목록으로 두는 편이 단순하다.
 */
/**
 * 칸 **인스턴스 id**.
 *
 * 예전엔 `pick` 이 블록 키 목록이라 **같은 칸을 두 번 담을 수 없었다** — 차트를 둘 띄우고
 * 하나는 일봉, 하나는 3분봉으로 보는 게 HTS 에서 늘 하던 일인데 그게 안 됐다.
 *
 * 그래서 `chart`, `chart#2` 처럼 뒤에 번호를 붙인다. 크기·고정·종목잠금이 전부 이 id 를
 * 키로 쓰므로 **인스턴스마다 따로** 기억된다. 번호가 없는 것(`chart`)은 첫 칸이라,
 * 예전에 저장해 둔 구성이 그대로 살아난다 — 마이그레이션이 필요 없다.
 */
function blockOf(id: string): string {
  const at = id.indexOf("#");
  return at < 0 ? id : id.slice(0, at);
}

/** 그 블록의 다음 인스턴스 id — 이미 있는 번호는 건너뛴다 */
function nextInstance(pick: string[], key: string): string {
  if (!pick.includes(key)) return key;
  for (let n = 2; n < 50; n += 1) {
    const id = `${key}#${n}`;
    if (!pick.includes(id)) return id;
  }
  return `${key}#${Date.now()}`;
}

const MARKET_KEYS = new Set<string>(["mktIndex", "mktIndexChart", "mktSignal", "mktPulse", "mktBreadth", "mktSector", "mktVi", "mktWatch", "mktBrief", "mktTelegram"]);
const isMarket = (id: string) => MARKET_KEYS.has(blockOf(id));

/*
 * 칸 크기 — **기기마다 따로.**
 * 27인치와 노트북이 같을 수 없으니 서버에 두면 한쪽에 맞춘 크기가 다른 쪽을 망친다.
 */
const SIZE_KEY = "vntg.board.sizes";
/** 칸별 글자 크기(%) — 기기마다 다르게(해상도가 제각각). 크기와 같은 저장소 */
const FONT_KEY = "vntg.board.fonts";

function readSizes(): Record<string, CellSize> {
  try {
    const raw = JSON.parse(winStore.get(SIZE_KEY) ?? "null") as unknown;
    if (!raw || typeof raw !== "object") return {};
    const out: Record<string, CellSize> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const s = v as { w?: unknown; h?: unknown };
      const w = Number(s?.w);
      const h = Number(s?.h);
      if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) out[k] = { w, h };
    }
    return out;
  } catch {
    return {};
  }
}

const PIN_KEY = "vntg.board.pins";

/**
 * 칸마다 붙들어 둔 종목.
 *
 * 안 붙들면 연동을 따라가고, 붙들면 그 종목에 머문다. HTS 로 치면 한 창에서
 * 삼성전자를 파면서 옆 창은 하이닉스를 띄워 두는 것 — 보드가 종목 하나만 보던
 * 구조로는 못 하던 일이다.
 *
 * **구성에 담는다.** 「종목은 안 담는다」던 원칙의 예외인데, 붙들어 둔 종목은
 * 「지금 보는 종목」이 아니라 **그 배치의 일부**이기 때문이다 — 감시용 배치라면
 * 늘 같은 종목을 보고 있어야 뜻이 있다.
 */
const LOCK_KEY = "vntg.board.locks";

function readLocks(): Record<string, { code: string; name: string }> {
  try {
    const raw = JSON.parse(winStore.get(LOCK_KEY) ?? "null") as unknown;
    if (!raw || typeof raw !== "object") return {};
    const out: Record<string, { code: string; name: string }> = {};
    for (const [k, v] of Object.entries(raw as Record<string, { code?: unknown; name?: unknown }>)) {
      if (typeof v?.code === "string" && v.code) {
        out[k] = { code: v.code, name: typeof v.name === "string" ? v.name : v.code };
      }
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * 화면 구성 네 벌 — **즐겨찾기처럼.**
 *
 * 장중에 보는 구성과 마감 뒤에 보는 구성이 다르고, 종목을 고를 때와 파고들 때가 또
 * 다르다. 그때마다 칸을 켜고 끄고 크기를 다시 잡는 건 **하던 일을 멈추는 것**이라,
 * 몇 벌 만들어 두고 숫자 하나로 갈아 끼우는 편이 낫다.
 *
 * 담는 것은 「무엇을·어떤 순서로·얼마나 크게·어디를 고정했나」 넷이다.
 * 종목은 안 담는다 — 구성은 **틀**이지 내용이 아니다.
 */
const PRESET_KEY = "vntg.board.presets";

/**
 * 처음 쓸 때 깔아 두는 세 벌 — **모니터 세 대를 쓰던 HTS 구조**를 옮긴 것.
 *
 * 창을 셋 띄우고 각각 다른 구성을 불러오면 그 배치가 재현된다.
 * 종목을 고르는 창에서 누르면 「종목 파기」 창만 따라오고 나머지는 안 흔들린다.
 *
 * 시장 신호등·맥박·상승하락 종목수·업종 수급은 **종목과 무관한 칸**이라
 * 연동이 꺼져 있어도 그려진다 — HTS 1번 모니터가 하던 일이 그것이다.
 * (아직 없는 것: 지수판 여러 장, 관심종목 다종목 시세판)
 *
 * ## 이 셋은 **못 고치고 못 지운다**
 *
 * 나머지 구성은 마음대로 만들고 지우는데, **잠근 것**은 못 건드린다.
 *
 * ## 왜 잠그나
 *
 * **돌아올 자리**가 필요해서다 — 배치를 이리저리 헤집다가 「원래대로」가 없으면 처음부터
 * 다시 짜야 한다. 실제로 한 번 지워져서 다시 만들었다.
 *
 * ⚠️ 예전엔 `K1`~`K3` 라는 **우리가 지은 구성 셋을 코드에 박아** 뒀다. 그런데 돌아올
 * 자리는 쓰는 사람이 정하는 것이지 우리가 정해 줄 게 아니다 — 실제로 그 셋은 안 쓰이고
 * 사람이 따로 만든 구성이 그 자리를 하고 있었다. 씨앗을 없애고 **자물쇠를 사람 손에** 준다.
 *
 * 잠긴 건 이름·순서·삭제·덮어쓰기다. **불러오는 건 그대로** 되고, 불러온 뒤 화면에서
 * 칸을 바꾸는 것도 자유다 — 그건 구성이 아니라 지금 화면이라서다.
 * 바꾼 배치를 남기고 싶으면 「＋ 새로 담기」로 새 구성을 만들면 된다.
 */

/** 예전에 코드로 박아 두었던 구성 — 목록에서 걷어낸다 */
const RETIRED_IDS = new Set(["k1", "k2", "k3"]);

interface Preset {
  id: string;
  name: string;
  pick: string[];
  sizes: Record<string, CellSize>;
  pins: string[];
  /** 칸마다 붙들어 둔 종목 — 배치의 일부다 */
  locks?: Record<string, { code: string; name: string }>;
  /** 잠갔나 — 이름·순서·삭제·덮어쓰기가 막힌다 */
  locked?: boolean;
}

/** 잠긴 구성인가 — 목록에서 찾아 본다 */
function isFixed(list: Preset[], id: string): boolean {
  return Boolean(list.find((p) => p.id === id)?.locked);
}

/**
 * 저장된 구성을 읽는다.
 *
 * 예전에는 K1~K4 네 칸으로 **고정**돼 있었다(`{K1:{...}}` 모양).
 * 그 모양이 남아 있으면 목록으로 옮긴다 — 쓰던 구성을 잃으면 안 된다.
 */
/**
 * 예전에 박아 두었던 K1~K3 를 걷어낸다.
 *
 * 코드에서 씨앗만 지우면 **이미 저장된 것은 그대로 남는다** — 서버에 들어 있기 때문이다.
 * 읽을 때 걸러 내고, 걸러졌으면 그 상태로 다시 저장한다(부르는 쪽에서 한다).
 */
function withFixed(list: Preset[]): Preset[] {
  return list.filter((p) => !RETIRED_IDS.has(p.id));
}

function readPresets(): Preset[] {
  try {
    const raw = JSON.parse(localStorage.getItem(PRESET_KEY) ?? "null") as unknown;
    if (Array.isArray(raw)) {
      const out = raw
        .filter((p): p is Preset => Boolean(p) && typeof (p as Preset).id === "string")
        .map((p) => ({ ...p, name: p.name || p.id, pick: p.pick ?? [], sizes: p.sizes ?? {}, pins: p.pins ?? [] }));
      return withFixed(out);
    }
    // 옛 모양 → 목록으로
    if (raw && typeof raw === "object") {
      const out: Preset[] = [];
      for (const [k, v] of Object.entries(raw as Record<string, Partial<Preset>>)) {
        // 예전 슬롯은 이름이 없어서 「1」「K2」로 보였다 — 사람이 읽을 이름을 준다
        const nice = v?.name || (/^\d+$/.test(k) ? `구성 ${k}` : k);
        out.push({ id: k, name: nice, pick: v?.pick ?? [], sizes: v?.sizes ?? {}, pins: v?.pins ?? [] });
      }
      if (out.length > 0) return withFixed(out);
    }
    return [];
  } catch {
    return [];
  }
}

const PICK_KEY = "vntg.board.blocks";
/**
 * `pick` 은 이제 **인스턴스 id 목록**이라 `string[]` 이다.
 * `chart` 는 첫 칸, `chart#2` 는 둘째 칸. 블록 키만 담던 예전 값도 그대로 읽힌다.
 */
const DEFAULT_PICK: string[] = ["chart", "investor", "supply", "opinion"];

function readPick(): string[] {
  try {
    const raw = JSON.parse(winStore.get(PICK_KEY) ?? "null") as unknown;
    if (!Array.isArray(raw)) return DEFAULT_PICK;
    const keys = new Set(BLOCKS.map((b) => b.key as string));
    // 인스턴스 id 라 `#` 뒤를 떼고 실제 있는 칸인지 본다
    const out = raw.filter((k): k is string => typeof k === "string" && keys.has(blockOf(k)));
    return out.length > 0 ? out : DEFAULT_PICK;
  } catch {
    return DEFAULT_PICK;
  }
}

/**
 * 구성에 든 패널을 사람 말로.
 *
 * 「15칸」은 개수만 알려 줄 뿐 **무엇이 들었는지는 안 알려 준다** — 12칸짜리와
 * 뭐가 다른지 알려면 결국 눌러 봐야 했다. 앞의 셋을 이름으로 적고 나머지는 세어 준다.
 */
function summarize(pick: string[]): string {
  const names: string[] = [];
  for (const k of pick) {
    const label = BLOCKS.find((b) => b.key === k)?.label;
    if (label) names.push(label);
  }
  if (names.length === 0) return "빈 구성";
  const head = names.slice(0, 3).join("·");
  return names.length > 3 ? `${head} 외 ${names.length - 3}개` : head;
}

/**
 * **칸 하나만 띄운 창**인가 — `#/board?only=<칸 id>&code=..&name=..`
 *
 * 모니터를 여러 대 쓰면 보드 하나를 통째로 띄우는 것보다 「호가만 저 화면에」가 더 쓸모
 * 있다. 새 창은 `sessionStorage` 가 비어 있으므로 무엇을 띄울지는 **URL 로만** 전할 수 있다.
 *
 * 칸의 **인스턴스 id 를 그대로** 넘긴다(`chart#2`). 그래야 그 칸에 맞춰 둔 차트 설정이
 * 새 창에서도 그대로 나온다 — 봉과 구간을 그 id 로 적어 두기 때문이다.
 */
/**
 * 「가격 요약」 칸 (2026-08-25, PDF #12) — 상세 종합의 맨 위를 **통째로**.
 *
 * 종가·장마감 헤더(PriceHeader: KRX/NXT 시·고·저·종가, 기간 상승률) + VWAP
 * 기준선 줄(IntradayLevelsBar) + 오늘 수급 막대(StockSummaryPanel). 상세와
 * **같은 컴포넌트 셋**이라 두 화면이 다른 값을 말할 일이 없다.
 * 현재가는 3초로 산다 — 보드는 곁눈 화면이라 1초까지는 필요 없다.
 */
function PriceSummaryCell({ code }: { code: string }) {
  const live = useLive(() => api.stockInfo(code), [code], 3000);
  const info = (live.data ?? null) as Record<string, unknown> | null;
  return (
    <>
      <PriceHeader info={info} code={code} />
      <IntradayLevelsBar code={code} />
      <StockSummaryPanel code={code} />
    </>
  );
}

function readOnly(): { id: string; code: string; name: string } | null {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const q = raw.split("?")[1];
  if (!q) return null;
  const params = new URLSearchParams(q);
  const id = params.get("only");
  if (!id) return null;
  return { id, code: params.get("code") ?? "", name: params.get("name") ?? "" };
}

export function BoardPage({ onSelectStock }: { onSelectStock?: (c: string, n: string) => void }) {
  const { on, toggle, focus, publish } = useStockFocus();
  /* 새 창으로 떼어 낸 칸이면 그것만 그린다 — 설정 줄도 구성 목록도 없다 */
  const [solo] = useState(readOnly);
  const [pick, setPick] = useState<string[]>(() => (solo ? [solo.id] : readPick()));
  const [sizes, setSizes] = useState<Record<string, CellSize>>(readSizes);

  const setSize = useCallback((key: string, s: CellSize) => {
    setSizes((prev) => {
      const had = prev[key];
      if (had && had.w === s.w && had.h === s.h) return prev;
      const next = { ...prev, [key]: s };
      try {
        winStore.set(SIZE_KEY, JSON.stringify(next));
      } catch {
        /* 저장 못 해도 이번 세션에는 그 크기로 본다 */
      }
      return next;
    });
  }, []);

  /* 칸별 글자 크기(%) — 70~150, 10% 걸음. 기기별(winStore) */
  const [fonts, setFonts] = useState<Record<string, number>>(() => {
    try {
      const raw = JSON.parse(winStore.get(FONT_KEY) ?? "{}") as Record<string, unknown>;
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(raw)) if (typeof v === "number") out[k] = v;
      return out;
    } catch {
      return {};
    }
  });
  const bumpFont = useCallback((key: string, delta: number) => {
    setFonts((prev) => {
      const next = { ...prev, [key]: Math.min(150, Math.max(70, (prev[key] ?? 100) + delta)) };
      if (next[key] === 100) delete next[key];
      try {
        winStore.set(FONT_KEY, JSON.stringify(next));
      } catch {
        /* 저장 못 해도 이번 세션에는 그 크기로 본다 */
      }
      return next;
    });
  }, []);

  const resetSizes = useCallback(() => {
    /*
     * 확인창 (2026-08-26 사용자 요청) — 공들여 맞춘 칸 크기가 실수 클릭 한 번에
     * 전부 날아간다. 목록 덮기와 같은 원칙: 지우는 건 물어보고 지운다.
     */
    if (!window.confirm("모든 칸의 크기를 처음 값으로 되돌릴까요?\n맞춰 둔 크기가 전부 지워집니다.")) return;
    setSizes({});
    try {
      winStore.remove(SIZE_KEY);
    } catch {
      /* 무시 */
    }
  }, []);

  /* ---------------- 고정 ---------------- */
  const [pins, setPins] = useState<string[]>(() => {
    try {
      const raw = JSON.parse(winStore.get(PIN_KEY) ?? "[]") as unknown;
      return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  });

  const [locks, setLocks] = useState<Record<string, { code: string; name: string }>>(readLocks);

  const persistLocks = useCallback((next: Record<string, { code: string; name: string }>) => {
    setLocks(next);
    try {
      winStore.set(LOCK_KEY, JSON.stringify(next));
    } catch {
      /* 무시 */
    }
  }, []);

  /* 끄는 도중에 읽어야 해서 ref 로도 들고 있는다 */
  const pinsRef = useRef<string[]>(pins);
  useEffect(() => {
    pinsRef.current = pins;
  }, [pins]);

  const flipPin = useCallback((k: string) => {
    setPins((prev) => {
      const next = prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k];
      try {
        winStore.set(PIN_KEY, JSON.stringify(next));
      } catch {
        /* 무시 */
      }
      return next;
    });
  }, []);

  /* ---------------- 자리 바꾸기 ---------------- */
  const [dragKey, setDragKey] = useState<string | null>(null);

  /*
   * 끄는 동안 **실시간으로 자리를 바꾼다.**
   *
   * 놓을 때 한 번에 옮기면 어디에 떨어질지 모르는 채로 끌게 된다. 지나가는 칸과
   * 즉시 자리를 바꾸면 결과가 눈앞에서 보이므로 미리보기가 따로 필요 없다.
   *
   * 고정된 칸은 **자리를 내주지 않는다** — 고정의 뜻이 그것이다.
   */
  const onDragStart = useCallback(
    (key: string) => (e: React.PointerEvent) => {
      e.preventDefault();
      setDragKey(key);

      const move = (ev: PointerEvent) => {
        /*
         * 가장자리 자동 스크롤 (2026-08-25 — 「자리 이동이 안 된다」의 실체).
         * 끄는 손이 화면 위·아래 끝에 닿아도 페이지가 안 따라와서, 보이는 화면
         * 밖의 칸으로는 **영영 못 옮겼다**. 스왑 자체는 멀쩡했다(실측) — 못 가는
         * 곳이 있었을 뿐이다. 끝 70px 안이면 그 방향으로 밀어 준다.
         */
        const EDGE = 70;
        if (ev.clientY < EDGE) window.scrollBy(0, -20);
        else if (ev.clientY > window.innerHeight - EDGE) window.scrollBy(0, 20);

        const under = document
          .elementFromPoint(ev.clientX, ev.clientY)
          ?.closest<HTMLElement>(".board-cell");
        const over = under?.dataset.cell;
        if (!over || over === key) return;
        /*
         * 고정 목록은 **ref 로 읽는다.**
         *
         * 처음엔 `setPins` 갱신 함수 안에서 `setPick` 을 불렀는데, 그건 React 가
         * 보장하지 않는 자리라 **아무 일도 안 일어났다** — 끌어도 순서가 그대로였다.
         * 갱신 함수는 값을 계산해서 돌려주는 곳이지 다른 상태를 건드리는 곳이 아니다.
         */
        if (pinsRef.current.includes(over)) return; // 고정된 칸은 안 밀린다
        setPick((cur) => {
          const from = cur.indexOf(key);
          const to = cur.indexOf(over);
          if (from < 0 || to < 0 || from === to) return cur;
          const next = [...cur];
          next.splice(to, 0, next.splice(from, 1)[0]);
          return next;
        });
      };
      const up = () => {
        setDragKey(null);
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);

      /*
       * 포인터 캡처는 **맨 마지막에, 실패해도 그만인 것으로** 건다.
       *
       * 처음엔 리스너보다 먼저 불렀는데, 이게 예외를 던지면 **그 뒤 줄이 통째로 안
       * 돌아서** 리스너가 하나도 안 붙었다 — 끌어도 아무 반응이 없던 게 이것이다.
       * 캡처는 손가락이 칸 밖으로 나가도 따라오게 하는 편의 장치일 뿐이고,
       * 어차피 `window` 에서 듣고 있으므로 없어도 동작한다.
       */
      try {
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      } catch {
        /* 못 걸어도 window 에서 듣는다 */
      }
    },
    [],
  );

  /*
   * 보드에 있는 동안 **본문 폭 제한을 푼다.**
   *
   * 본문은 1400px 로 묶여 있다. 글이 많은 화면에서는 그게 맞지만 보드는 칸을 늘어놓는
   * 화면이라 3440 모니터에서 오른쪽 2000px 이 통째로 놀았다.
   * 떠날 때 되돌린다 — 안 되돌리면 가이드·리포트에서 한 줄이 화면을 가로질러 눈이 줄을 놓친다.
   */
  useEffect(() => {
    document.documentElement.setAttribute("data-page", "board");
    return () => document.documentElement.removeAttribute("data-page");
  }, []);

  /* ---------------- 화면 구성 (목록) ---------------- */
  const [presets, setPresets] = useState<Preset[]>(readPresets);
  const [editing, setEditing] = useState(false);

  /*
   * **기본 세 벌을 처음 한 번 저장해 둔다.**
   *
   * 예전엔 저장 없이 보여주기만 했다. 화면에는 K1·K2·K3 이 멀쩡히 있는데
   * 저장소는 비어 있어서, 이름을 고치거나 하나를 지우면 **나머지가 갑자기 나타나거나
   * 사라지는 것처럼** 보였다 — 「저장이 안 된다」는 말이 그 뜻이었다.
   * 보이는 것과 저장된 것이 처음부터 같아야 한다.
   */
  /*
   * 구성을 **서버에서 읽는다.**
   *
   * 예전엔 localStorage 였는데, 그건 **창끼리 공유**된다 — 창 A 가 K1 을 불러오면
   * 창 B 의 K2 를 덮어썼다. 모니터 세 대에 다른 구성을 띄우려고 만든 기능인데
   * 그 쓰임 자체가 깨져 있었다. 기기가 바뀌면 아예 없기도 했다.
   *
   * ⚠️ 서버가 **아직 저장한 적 없으면**(`saved: false`) 이 기기에 있던 것을 올려 준다.
   * 빈 값으로 덮어쓰면 짜 두었던 구성이 그 자리에서 사라진다.
   */
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = await api.boardPrefs();
        if (!alive) return;
        if (r.saved && r.presets.length > 0) {
          /*
            예전에 박아 두었던 K1~K3 는 걷어낸다. 서버에 이미 저장돼 있으므로 코드에서
            씨앗만 지워서는 안 사라진다 — 걸러진 게 있으면 그 상태로 되돌려 저장한다.
          */
          const kept = withFixed(r.presets as Preset[]);
          setPresets(kept);
          if (kept.length !== r.presets.length)
            void api.boardPrefsSave(kept as unknown as Parameters<typeof api.boardPrefsSave>[0]);
          return;
        }
        const local = readPresets();
        setPresets(local);
        await api.boardPrefsSave(local as unknown as Parameters<typeof api.boardPrefsSave>[0]);
      } catch {
        // 서버를 못 읽어도 화면은 서야 한다 — 이 기기 것으로 그린다
        if (alive) setPresets(readPresets());
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const persist = useCallback((next: Preset[]) => {
    setPresets(next);
    // 서버가 본체다. 실패해도 화면은 이미 바뀌어 있고, 다음 저장에서 다시 올라간다
    void api
      .boardPrefsSave(next as unknown as Parameters<typeof api.boardPrefsSave>[0])
      .catch(() => undefined);
  }, []);

  /** 지금 화면을 그 구성에 덮어쓴다 */
  const saveInto = useCallback(
    (id: string) => {
      // 잠근 구성은 덮어쓰기도 막는다 — 돌아올 자리가 흔들리면 뜻이 없다
      if (isFixed(presets, id)) return;
      const target = presets.find((p) => p.id === id);
      if (!target) return;
      /*
       * 묻고 덮는다 (2026-08-25, PDF #10 — 「자꾸 덮어써진다」).
       * 덮기는 기존 배치를 지우는 일인데 한 번 누르면 소리 없이 끝났다 —
       * 실수로 눌러도 알 길이 없었다. 예를 눌러야 전역(서버) 구성에 저장된다.
       */
      if (
        !window.confirm(
          `지금 화면 배치를 「${target.name}」 구성에 덮어쓸까요?\n기존 배치는 사라지고, 모든 기기에 적용됩니다.`,
        )
      )
        return;
      persist(presets.map((p) => (p.id === id ? { ...p, pick, sizes, pins, locks } : p)));
    },
    [persist, presets, pick, sizes, pins, locks],
  );

  /** 지금 화면을 새 구성으로 */
  const addPreset = useCallback(() => {
    /*
     * 이름을 **만들 때** 받는다. 「구성 4」로 만들어 놓고 편집에서 고치게 하면
     * 대부분 그냥 두게 되고, 그러면 이름이 있으나 마나가 된다.
     */
    const name = window.prompt("새 구성 이름", `구성 ${presets.length + 1}`);
    if (name === null) return;
    const id = `p${Date.now().toString(36)}`;
    persist([...presets, { id, name: name.trim() || `구성 ${presets.length + 1}`, pick, sizes, pins, locks }]);
  }, [persist, presets, pick, sizes, pins, locks]);

  const rename = useCallback(
    (id: string, name: string) => {
      if (isFixed(presets, id)) return;
      persist(presets.map((p) => (p.id === id ? { ...p, name } : p)));
    },
    [persist, presets],
  );

  const remove = useCallback(
    (id: string) => {
      if (isFixed(presets, id)) return;
      persist(presets.filter((p) => p.id !== id));
    },
    [persist, presets],
  );

  /** 잠그기·풀기 — 푸는 쪽만 묻는다 */
  const toggleLock = useCallback(
    (id: string) => {
      const p = presets.find((x) => x.id === id);
      if (!p) return;
      if (p.locked && !window.confirm(`「${p.name}」 잠금을 풀까요? 풀면 지우거나 덮어쓸 수 있게 됩니다.`)) {
        return;
      }
      persist(presets.map((x) => (x.id === id ? { ...x, locked: !x.locked } : x)));
    },
    [persist, presets],
  );

  /** 한 칸 앞/뒤로 — 자주 쓰는 걸 왼쪽에 두게 된다 */
  const move = useCallback(
    (id: string, delta: -1 | 1) => {
      if (isFixed(presets, id)) return;
      const at = presets.findIndex((p) => p.id === id);
      const to = at + delta;
      if (at < 0 || to < 0 || to >= presets.length) return;
      // 잠근 것과는 자리를 안 바꾼다 — 그러면 걔가 밀려난다
      if (presets[to].locked) return;
      const next = [...presets];
      [next[at], next[to]] = [next[to], next[at]];
      persist(next);
    },
    [persist, presets],
  );

  const loadFrom = useCallback(
    (id: string) => {
      const p = presets.find((x) => x.id === id);
      if (!p) return;
      const keys = new Set(BLOCKS.map((b) => b.key as string));
      const nextPick = (p.pick ?? []).filter((k): k is string => keys.has(blockOf(k)));
      setPick(nextPick.length > 0 ? nextPick : DEFAULT_PICK);
      setSizes(p.sizes ?? {});
      setPins(p.pins ?? []);
      persistLocks(p.locks ?? {});
      try {
        winStore.set(PICK_KEY, JSON.stringify(nextPick));
        winStore.set(SIZE_KEY, JSON.stringify(p.sizes ?? {}));
        winStore.set(PIN_KEY, JSON.stringify(p.pins ?? []));
      } catch {
        /* 무시 */
      }
    },
    [presets, persistLocks],
  );

  useEffect(() => {
    try {
      winStore.set(PICK_KEY, JSON.stringify(pick));
    } catch {
      /* 저장 못 해도 이번 세션에는 그대로 쓴다 */
    }
  }, [pick]);

  /*
   * 켜면 **그 칸으로 스크롤한다** (2026-08-25 — 「가격 요약을 넣었는데 왜 없냐」).
   * 새 칸은 보드 맨 끝에 생기는데, 칸이 여럿이면 화면 밖이라 **켜져도 안 보였다** —
   * 안 만든 걸로 오해받은 이유다. 생기는 자리를 바꾸는 대신(기존 배치가 밀리면 그것대로
   * 사고다) 생긴 곳을 보여준다. 자리는 ⠿ 로 끌어 옮기면 된다.
   */
  const flip = (k: string) => {
    const adding = !pick.includes(k);
    setPick((p) => (p.includes(k) ? p.filter((x) => x !== k) : [...p, k]));
    if (adding) {
      setTimeout(() => {
        document.querySelector(`[data-cell="${k}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 80);
    }
  };

  /*
   * **이 창이 직접 고른 종목.**
   *
   * 연동이 꺼져 있으면 `publish` 는 아무 일도 안 한다 — 그게 연동을 끈다는 뜻이니 맞다.
   * 그런데 그러면 보드 설정의 검색창으로 종목을 골라도 화면이 안 바뀐다. 연동을 켜야만
   * 종목을 고를 수 있다면 「보드 하나로 끝낸다」가 안 된다.
   *
   * 그래서 고른 것을 이 창에만 따로 들고 있는다. 다른 창이 종목을 누르면(= `focus` 가
   * 새로 오면) 그건 지운다 — 연동을 켜 뒀다면 따라가는 게 맞기 때문이다.
   */
  const [ownStock, setOwnStock] = useState<{ code: string; name: string } | null>(
    /*
      떼어 낸 창은 URL 에 실려 온 종목으로 시작한다. 새 창은 `sessionStorage` 가 비어 있고
      연동이 꺼져 있을 수도 있으므로, 이걸 안 넣으면 「종목 없음」이 뜬 창이 열린다.
    */
    solo && solo.code ? { code: solo.code, name: solo.name || solo.code } : null,
  );
  /*
   * ⚠️ **첫 렌더에서 지우면 안 된다.**
   *
   * `useEffect` 는 마운트 직후에도 한 번 돈다. 그냥 지우게 두면 URL 로 실려 온 종목이
   * 그 자리에서 없어져 떼어 낸 창이 「종목 없음」으로 열린다 — 실제로 그랬다.
   * 값이 **정말 바뀌었을 때만** 손 뗀다.
   */
  const seenFocusAt = useRef(focus?.at);
  useEffect(() => {
    if (seenFocusAt.current === focus?.at) return;
    seenFocusAt.current = focus?.at;
    setOwnStock(null);
  }, [focus?.at]);

  const code = ownStock?.code ?? focus?.code ?? "";
  const name = ownStock?.name ?? focus?.name ?? "";
  /* 칸 안에서 쓰는 이름 — 칸마다 종목이 다를 수 있어서 바깥 것과 헷갈리면 안 된다 */
  const focusCode = code;
  const focusName = name;
  /* 기업분석·장중 수급이 쓴다. 한 번 받아 두 칸이 나눠 쓴다 */
  const info = useStockInfo(code);

  /*
   * 설정 줄은 **접어 둘 수 있다.**
   *
   * 한 번 맞추고 나면 다시 볼 일이 거의 없는데, 펼친 채로 두면 화면 위쪽 두세 줄을
   * 늘 잡아먹는다. 보드는 **본문을 넓게 보려고 만든 화면**이라 그 자리가 아깝다.
   * 접힌 상태를 기억해서 다음에 들어와도 넓은 채로 시작한다.
   */
  const [cfgOpen, setCfgOpen] = useState(() => {
    try {
      return localStorage.getItem("vntg.board.cfgOpen") !== "0";
    } catch {
      return true;
    }
  });
  const toggleCfg = useCallback(() => {
    setCfgOpen((v) => {
      try {
        setPref("vntg.board.cfgOpen", v ? "0" : "1");
      } catch {
        /* 무시 */
      }
      return !v;
    });
  }, []);

  return (
    <div className={`board${solo ? " board-solo" : ""}`}>
      {/*
        떼어 낸 창에는 **설정 줄을 안 그린다.**

        작은 창에서 설정과 구성 목록이 화면의 절반을 먹는다. 떼어 낸 이유가 「저 모니터에
        호가만」인데 설정이 자리를 차지하면 뜻이 없다. 종목은 URL 로 실려 온다.

        닫기만은 준다 (2026-08-25, PDF #3) — 떼어 낸 창은 브라우저 틀이 최소라
        닫을 길이 안 보였다. 스크립트로 연 창이라 window.close() 가 그대로 먹는다.
      */}
      {solo && (
        <button
          className="board-solo-close"
          onClick={() => window.close()}
          title="이 창 닫기"
        >
          ✕ 닫기
        </button>
      )}
      {!solo && (
      <section className="card board-cfg">
        {/*
          접었을 때도 **지금 무슨 종목인지와 연동 상태**는 남는다.
          그 둘은 화면을 보는 내내 알아야 하는 값이라 설정이 아니다.
        */}
        <h2 className="board-cfg-h">
          <span>
            보드
            {code && (
              <span className="pt-n">
                {" "}
                지금 {name} ({code})
              </span>
            )}
            {!on && <span className="board-off"> 연동 꺼짐</span>}
          </span>
          <button className="filter-btn board-cfg-btn" onClick={toggleCfg}>
            {cfgOpen ? "설정 접기" : "⚙ 설정"}
          </button>
        </h2>

        {cfgOpen && (
        <>
        {/*
          **여기서도 종목을 고를 수 있어야 한다.**

          보드는 다른 창이 종목을 눌러 주기를 기다리는 화면이었다. 그런데 모니터 한 대에
          보드만 띄워 놓고 쓰는 일이 실제로 잦다 — 그때는 종목을 바꾸려고 다른 메뉴를 열었다
          닫아야 했다. 보드 하나로 끝낼 수 있어야 독립적으로 쓰인다.

          여기서 고른 종목은 **연동과 같은 자리**에 들어간다(칸에 붙드는 게 아니다) —
          연동을 켜 둔 다른 창들도 같이 따라온다.
        */}
        <div className="filter-row board-cfg-find">
          <span className="st-cfg-k">종목 찾기</span>
          <CellStockFinder
            onPick={(c, n) => {
              setOwnStock({ code: c, name: n });
              publish(c, n); // 연동이 켜져 있으면 다른 창도 같이 온다
            }}
            onClose={() => undefined}
          />
        </div>

        <div className="filter-row">
          <label className="st-cfg-chk">
            <input type="checkbox" checked={on} onChange={(e) => toggle(e.target.checked)} />
            <b>종목 연동</b>
          </label>
          <span className="pt-n">
            {on
              ? "다른 창에서 종목을 누르면 이 화면이 따라옵니다"
              : "꺼져 있습니다 — 켜야 다른 창을 따라갑니다"}
          </span>
        </div>

        <div className="filter-row">
          {BLOCKS.map((b) => (
            <button
              key={b.key}
              className={`filter-btn ${pick.includes(b.key) ? "active" : ""}`}
              onClick={() => flip(b.key)}
            >
              {b.label}
            </button>
          ))}
          {Object.keys(sizes).length > 0 && (
            <button className="filter-btn" onClick={resetSizes}>
              크기 초기화
            </button>
          )}
        </div>

        {/*
          화면 구성 — **개수도 이름도 순서도 내가 정한다.**

          편집을 같은 줄에 욱여넣었더니 이름칸·화살표·삭제가 다닥다닥 붙어서 누르기가
          어려웠다. 편집은 **아래로 펼쳐서 한 줄에 하나씩** 둔다 — 평소에는 이름만
          늘어놓고, 고칠 때만 자리를 내준다.
        */}
        <div className="filter-row">
          <span className="st-cfg-k">화면 구성</span>
          {presets.map((p) => (
            <button
              key={p.id}
              className="filter-btn"
              onClick={() => loadFrom(p.id)}
              title={`${p.name} — ${summarize(p.pick)}`}
            >
              {p.name}
            </button>
          ))}
          <button className="filter-btn" onClick={addPreset} title="지금 화면을 새 구성으로 담기">
            ＋ 새로 담기
          </button>
          <button
            className={`filter-btn ${editing ? "active" : ""}`}
            onClick={() => setEditing((v) => !v)}
          >
            {editing ? "편집 끝" : "✏ 편집"}
          </button>
        </div>

        {editing && (
          <div className="bp-list">
            {presets.length === 0 && <div className="empty">담아 둔 구성이 없습니다.</div>}
            {presets.map((p, i) => (
              <div className="bp-row" key={p.id}>
                <span className="bp-ord">
                  <button
                    className="gt-move"
                    onClick={() => move(p.id, -1)}
                    disabled={i === 0 || p.locked || presets[i - 1]?.locked}
                    title="위로"
                  >
                    ▲
                  </button>
                  <button
                    className="gt-move"
                    onClick={() => move(p.id, 1)}
                    disabled={i === presets.length - 1 || p.locked}
                    title="아래로"
                  >
                    ▼
                  </button>
                </span>
                {/* 잠근 것은 이름칸 대신 글자만 — 못 고치는 걸 눌러 보고 알게 하면 안 된다 */}
                {p.locked ? (
                  <span className="bp-name fixed">
                    {p.name}
                    <i className="bp-lock" title="잠겨 있어 고치거나 지울 수 없습니다">
                      🔒 잠김
                    </i>
                  </span>
                ) : (
                  <input
                    className="bp-name"
                    value={p.name}
                    onChange={(e) => rename(p.id, e.target.value)}
                    placeholder="구성 이름"
                  />
                )}
                {/*
                  개수만 적으면 「15칸」과 「12칸」의 차이를 알려면 눌러 봐야 한다.
                  앞의 몇 개를 이름으로 보여 주면 불러오기 전에 무엇이 든 구성인지 안다.
                */}
                <span className="bp-meta">{summarize(p.pick)}</span>
                {!p.locked && (
                  <>
                    <button
                      className="filter-btn"
                      onClick={() => saveInto(p.id)}
                      title="지금 화면 배치를 이 구성에 덮어쓰기"
                    >
                      지금 화면으로 덮기
                    </button>
                    <button className="row-del-btn" onClick={() => remove(p.id)} title="이 구성 삭제">
                      ✕
                    </button>
                  </>
                )}
                {/*
                  자물쇠는 **잠긴 것에도 보여야 한다.** 안 그러면 한 번 잠근 걸 풀 방법이 없다.
                  잠글 때는 안 묻고, 풀 때만 묻는다 — 잠근 이유가 실수로 안 건드리려는 것이라
                  푸는 쪽이 되돌리기 어려운 문 앞이다.
                */}
                <button
                  className={`bp-locker${p.locked ? " on" : ""}`}
                  onClick={() => toggleLock(p.id)}
                  title={p.locked ? "잠금 풀기" : "잠그기 — 이름·순서·삭제·덮어쓰기가 막힙니다"}
                >
                  {p.locked ? "🔒" : "🔓"}
                </button>
              </div>
            ))}
            <div className="table-note">
              이름은 적는 대로 저장됩니다. <b>덮기</b>는 지금 보고 있는 배치(칸·크기·고정·
              종목 고정)를 그 구성에 넣습니다.
              <br />
              <b>🔓 를 눌러 잠그면</b> 이름·순서·삭제·덮어쓰기가 막힙니다 — 배치를 헤집다가
              <b>돌아올 자리</b>가 필요해서입니다. 잠가도 <b>불러오는 건 그대로</b> 되고,
              불러온 뒤 화면에서 칸을 바꾸는 것도 자유입니다(그건 구성이 아니라 지금 화면입니다).
              바꾼 배치를 남기려면 <b>＋ 새로 담기</b>로 새 구성을 만드세요.
            </div>
          </div>
        )}

        <div className="table-note">
          칸 제목의 <b>⠿</b>를 끌어 자리를 바꾸고, <b>오른쪽 아래 모서리</b>를 끌어 크기를
          바꿉니다. 다 맞췄으면 <b>📍</b>를 눌러 고정하세요 — 고정한 칸은 크기도 자리도
          안 움직입니다. <b>화면 구성</b>은 틀만 담습니다(종목은 안 담습니다) — <b>✏ 편집</b>에서 이름·순서를
          바꾸고 지우고, <b>＋</b>로 지금 화면을 새 구성으로 담을 수 있습니다. 모두 이 기기에만
          남습니다.
        </div>
        </>
        )}

        {/* 아래 둘은 접어도 남는다 — 「왜 아무것도 안 뜨나」의 답이라 설정이 아니다 */}
        {!on && (
          <div className="alert-note">
            연동을 켜세요. <b>보내는 창에서도</b> 켜야 합니다 — 메뉴 맨 아래 📡 버튼입니다.
          </div>
        )}
        {on && !code && (
          <div className="empty">
            다른 창에서 종목을 고르면 여기에 뜹니다.
            <br />
            <span className="pt-n">
              같은 브라우저의 창은 즉시, 다른 기기는 1~2초 안에 따라옵니다.
            </span>
          </div>
        )}
      </section>
      )}

      {/*
        **시장 칸은 종목이 없어도 그린다.**
        종목과 무관한 칸만 켜 둔 구성(K1 같은)에서 연동이 아직 안 왔다고
        화면이 통째로 비면 그 구성은 쓸 수가 없다.
      */}
      {/*
        ⚠️ **종목이 없어도 칸은 그린다.**

        예전엔 종목이 없으면 그리드를 통째로 안 그렸다. 그런데 칸마다 종목을 찾는 버튼이
        칸 머리에 있으므로, 안 그리면 **고를 방법 자체가 사라진다** — 연동을 끄고 쓰려면
        다른 창에서 종목을 한 번 눌러 줘야만 보드가 열리는 이상한 구조가 된다.
        빈 칸 안에 「종목 없음」이 뜨고, 거기서 🔍 로 고르면 된다.
      */}
      {pick.length > 0 && (
        <div className="board-grid">
          {/*
            **`pick` 순서대로** 그린다. 예전엔 `BLOCKS` 를 훑어 걸러냈는데,
            그러면 자리를 바꿔도 늘 원래 순서로 되돌아갔다 — 옮긴 결과가 안 보였다.
          */}
          {pick
            .map((id) => ({ id, b: BLOCKS.find((x) => x.key === blockOf(id)) }))
            .filter((x): x is { id: string; b: (typeof BLOCKS)[number] } => Boolean(x.b))
            .map(({ id, b }) => (
            <BoardCell
              key={id}
              cellKey={id}
              title={b.label}
              sub={isMarket(id) ? undefined : (locks[id]?.name ?? name)}
              wide={b.wide}
              onDuplicate={() => setPick((prev) => {
                // 바로 뒤에 꽂는다 — 맨 끝에 붙이면 어디 생겼는지 찾아야 한다
                const at = prev.indexOf(id);
                const next = [...prev];
                next.splice(at < 0 ? prev.length : at + 1, 0, nextInstance(prev, b.key));
                return next;
              })}
              /*
                칸 닫기 (2026-08-25, PDF #3) — 복제(⧉)로 만든 칸을 지우려면 설정을
                열어야 했다. 만든 자리에서 닫는다. 떼어 낸 창(solo)은 위의 「✕ 닫기」가 맡는다.
              */
              onRemove={solo ? undefined : () => setPick((prev) => prev.filter((x) => x !== id))}
              /*
                이 칸만 새 창으로. 인스턴스 id 와 지금 보고 있는 종목을 URL 에 실어 보낸다 —
                새 창은 sessionStorage 가 비어 있어 URL 말고는 전할 길이 없다.
              */
              onPopOut={solo ? undefined : () => {
                const q = new URLSearchParams({ only: id });
                const stock = locks[id]?.code ? locks[id] : code ? { code, name } : null;
                if (stock && !isMarket(id)) {
                  q.set("code", stock.code);
                  q.set("name", stock.name || stock.code);
                }
                window.open(
                  `${window.location.pathname}#/board?${q.toString()}`,
                  `vntg-${id}`,
                  "width=760,height=620",
                );
              }}
              onPickStock={isMarket(id) ? undefined : (c, n) => {
                persistLocks({ ...locks, [id]: { code: c, name: n } });
              }}
              locked={isMarket(id) ? null : (locks[id] ?? null)}
              onToggleLock={isMarket(id) ? undefined : () => {
                /*
                 * 잠글 땐 **지금 이 칸이 보고 있는 종목**을 붙든다.
                 * 연동으로 흘러온 종목이 곧 사람이 보고 있는 것이므로,
                 * 따로 고르게 하지 않아도 뜻이 맞는다.
                 */
                const next = { ...locks };
                if (next[id]) delete next[id];
                else if (code) next[id] = { code, name };
                persistLocks(next);
              }}
              size={sizes[id] ?? null}
              onSize={(s) => setSize(id, s)}
              pinned={pins.includes(id)}
              onPin={() => flipPin(id)}
              onDragStart={onDragStart(id)}
              dragging={dragKey === id}
              fontScale={fonts[id] ?? 100}
              onFontScale={(d) => bumpFont(id, d)}
            >
              {({ height, tick }) => {
                /* 붙들어 뒀으면 그 종목, 아니면 연동을 따라간다 */
                const lock = locks[id];
                const code = lock?.code ?? focusCode;
                const name = lock?.name ?? focusName;
                if (!isMarket(id) && !code) return <div className="empty">종목 없음</div>;
                return (
                <>
                  {b.key === "mktIndex" && <IndexBoard />}
                  {/* 히트맵·테마 클릭 = 종목 찾기와 같은 길: 이 창 종목 + 연동 전파 */}
                  {b.key === "mktBrief" && (
                    <BriefingTrioCell
                      onSelectStock={(c, n) => {
                        setOwnStock({ code: c, name: n });
                        publish(c, n);
                      }}
                    />
                  )}
                  {/* 지수 차트 — 칸 이름을 주면 어느 지수를 보던 중이었는지 기억한다 */}
                  {b.key === "mktIndexChart" && (
                    <IndexChartCell viewId={id} height={Math.max(140, height - 110)} />
                  )}
                  {b.key === "mktSignal" && <MarketSignalPanel />}
                  {b.key === "mktPulse" && <MarketPulsePanel />}
                  {b.key === "mktBreadth" && <BreadthPanel />}
                  {b.key === "mktSector" && <SectorFlowPanel onSelectStock={onSelectStock} />}
                  {b.key === "mktVi" && <ViPanel onSelectStock={onSelectStock} />}
                  {b.key === "mktWatch" && <WatchTicker onSelectStock={onSelectStock} />}
                  {b.key === "mktTelegram" && <ChannelDigestPanel />}
                  {b.key === "telegram" && <ChannelSearchPanel code={code} name={name} />}
                  {b.key === "supplyMini" && <SupplyMini key={code} code={code} />}
                  {/*
                    가격 요약 (2026-08-25, PDF #12) — KRX/NXT 시·고·저·종가 한눈 카드.
                    처음엔 StockSummaryPanel 만 넣었는데 그건 **수급 막대 두 표**였다 —
                    사용자가 가리킨 건 그 위의 종가·장마감 블록(PriceHeader)이다.
                    상세 종합과 같은 조합(가격 헤더 + 수급)을 그대로 쓴다.
                  */}
                  {b.key === "priceSummary" && <PriceSummaryCell key={code} code={code} />}
                  {/*
                    `key={code}` 를 준다. 종목이 바뀌면 패널을 **새로 만든다** —
                    안 그러면 어떤 패널은 이전 종목의 값을 그대로 들고 있다가
                    자기 주기에 맞춰 뒤늦게 갱신되어, 잠깐 **다른 종목의 숫자**가 보인다.
                    보드는 여러 칸을 동시에 보는 화면이라 그 어긋남이 바로 눈에 띈다.
                  */}
                  {b.key === "chart" && (
                    /*
                      차트만 높이를 받아 간다. 표는 칸이 커지면 알아서 늘어나지만
                      캔버스는 그렇지 않아서, 알려 주지 않으면 여백만 생긴다.
                      판독 줄이 아래 붙으므로 그만큼 뺀다.
                    */
                    <ChartPanel
                      key={code}
                      code={code}
                      name={name}
                      height={Math.max(140, height - 150)}
                      sizeTick={tick}
                      /*
                        칸의 인스턴스 id 를 준다 — 이걸로 봉·거래소·구간을 기억한다.
                        `key={code}` 라 종목을 바꾸면 새로 태어나는데, 그때 일봉으로
                        돌아가던 것이 이 한 줄로 해결된다. 칸마다 따로 기억하므로
                        왼쪽 칸은 분봉, 오른쪽 칸은 주봉으로 둘 수 있다.
                      */
                      viewId={id}
                    />
                  )}
                  {b.key === "insights" && <ChartInsights key={code} code={code} />}
                  {b.key === "signal" && (
                    <SignalPanel key={code} code={code} onSelectStock={onSelectStock} />
                  )}
                  {b.key === "orderbook" && <OrderBookPanel key={code} code={code} />}
                  {b.key === "intraday" && (
                    <IntradayFlow
                      key={code}
                      code={code}
                      basePrice={Math.abs(Number(info?.base_pric)) || 0}
                    />
                  )}
                  {b.key === "investor" && <InvestorBlock key={code} code={code} />}
                  {b.key === "broker" && <BrokerFlowPanel key={code} code={code} />}
                  {b.key === "program" && <ProgramFlowPanel key={code} code={code} />}
                  {b.key === "supply" && <SupplyDetailPanel key={code} code={code} />}
                  {b.key === "opinion" && <OpinionPanel key={code} code={code} />}
                  {/* 뉴스는 종목명으로 찾는다 — 코드로는 기사 검색이 안 된다 */}
                  {b.key === "news" && <NewsList key={code} query={name || code} />}
                  {b.key === "disclosure" && <DisclosureList key={code} code={code} />}
                  {b.key === "finance" && <FinancePanel key={code} code={code} />}
                  {b.key === "summary" && (
                    <CompanySnapshot key={code} info={info} returns={null} />
                  )}
                  {b.key === "sector" && (
                    <SectorMoodPanel key={code} code={code} onSelectStock={onSelectStock} />
                  )}
                  {b.key === "notes" && (
                    <StockNotes
                      key={code}
                      code={code}
                      name={name}
                      currentPrice={Math.abs(Number(info?.cur_prc)) || undefined}
                    />
                  )}
                </>
                );
              }}
            </BoardCell>
          ))}
        </div>
      )}

      {code && onSelectStock && (
        <div className="filter-row">
          <button className="filter-btn" onClick={() => onSelectStock(code, name)}>
            {name} 개별종목분석으로
          </button>
        </div>
      )}
    </div>
  );
}
