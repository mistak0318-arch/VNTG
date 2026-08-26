import { useCallback, useEffect, useState } from "react";
import { removePref, setPref } from "../prefs";
import { api, fmtNum, type RankResult, type RankSpecGroup } from "../api";
import { SameNetTradeRankingPage } from "./SameNetTradeRankingPage";
import { ContinuousTradePage } from "./ContinuousTradePage";
import { TopTradersTable } from "../components/TopTradersTable";
import { CumulativeRank } from "../components/CumulativeRank";
import { SortableTh, useSortableTable } from "../useSortableTable";
import { fid, krxOverlayLive, useRealtime } from "../useRealtime";
import { SignalCell, useSignalColumn } from "../components/SignalColumn";
import { ColumnGrip, useColumnWidths } from "../components/ColumnWidths";
import { useCardOrder } from "../useCardOrder";
import { useAutoRefresh } from "../useAutoRefresh";

/**
 * 시세분석 — **실제로 보는 다섯 개를 앞에 세운다.**
 *
 * ## 왜 다시 짰나
 *
 * 예전엔 왼쪽 트리에 열두 개가 늘어서 있었다. 서버 명세를 그대로 그린 것이라
 * **만들기는 편했지만 쓰기는 불편했다** — 매번 트리를 훑어 같은 것을 찾게 된다.
 * 실제로 보는 것은 다섯이고 나머지는 가끔이다. 다섯을 탭으로 앞에 세우고
 * 나머지는 「그 밖에」에 그대로 둔다(쓰던 것을 지우지는 않는다).
 *
 * ## 거래소 — 거래대금은 통합, 가격은 KRX
 *
 * 2026-08-24 실측(삼성전자 하루치):
 *
 * | 거래소 | 거래대금 | 현재가 |
 * |---|---|---|
 * | KRX | 84,561억 | 257,000 |
 * | NXT | 52,463억 | 256,000 |
 * | **통합** | **137,023억** | 256,000 |
 *
 * 통합의 거래대금은 **정확히 합계**다(하루 거래가 NXT 프리 + KRX 정규 + NXT 애프터라
 * 합계가 맞다). 그런데 **가격은 NXT 최종가**를 준다.
 *
 * 그래서 기본은 통합이되 **서버가 가격만 KRX 로 덮어** 준다. KRX 만 보면 삼성전자
 * 거래대금이 84,561억으로 줄어 순위 자체가 틀어진다.
 *
 * ## 필터
 *
 * 백 줄을 눈으로 훑는 화면이었다. 실제로 보는 건 「거래대금 얼마 이상, 시총 어느 구간」
 * 인데 그걸 매번 머릿속으로 걸렀다.
 *
 * **거르는 일은 화면에서 한다** — 키움 순위 TR 은 조건을 거의 안 받고(받는 척하고 무시하는
 * 것도 있다), 무엇보다 서버에 다시 물으면 순위가 그 사이에 바뀐다. 받아 온 백 줄을
 * 그 자리에서 좁히는 게 빠르고 정확하다.
 *
 * 시가총액은 순위 TR 에 아예 없어서 **서버가 종목 목록(하루 캐시)에서 붙여 준다.**
 * 상장주식수 × 현재가다.
 */

const MARKETS = [
  { key: "000", label: "전체" },
  { key: "001", label: "코스피" },
  { key: "101", label: "코스닥" },
];

const EXCHANGES = [
  { key: "3", label: "통합", hint: "하루 전체 — NXT 프리 + KRX 정규 + NXT 애프터 (가격은 KRX 기준으로 맞춥니다)" },
  { key: "1", label: "KRX", hint: "한국거래소" },
  { key: "2", label: "NXT", hint: "대체거래소 — 여기서만 움직인 종목이 있습니다" },
];

/** 거르는 조건 — 화면에 남는다(다음에 열어도 그대로) */
interface Filter {
  /** 거래대금 최소(억원) */
  minTv: number;
  /**
   * 고른 시가총액 구간들.
   *
   * **여기만 복수 선택이 뜻을 갖는다.** 거래대금·등락률은 「얼마 이상」이라 겹쳐 있어서
   * 둘을 고르면 느슨한 쪽만 남는다(100억↑ 과 500억↑ 을 같이 고르면 결국 100억↑ 이다).
   * 시가총액은 구간이 서로 안 겹치므로 「3천억 미만 **또는** 1조~10조」처럼
   * **중간을 빼고 양끝만** 보는 게 실제로 된다.
   *
   * 빈 배열이면 안 건다.
   */
  caps: string[];
  /** 등락률 최소(%). null 이면 안 건다 */
  minRate: number | null;
  /**
   * **회전율 최소(%)** — 거래량 ÷ 상장주식수.
   *
   * 거래대금과 같이 걸어야 뜻이 산다. 거래대금만 보면 큰 종목이 늘 위에 있는데,
   * 「500억 이상이면서 회전율 5% 이상」이면 **작은데도 크게 돈** 종목이 남는다.
   */
  minTurn: number | null;
  /** ETF·ETN·우선주를 뺀다 */
  commonOnly: boolean;
}

const NO_FILTER: Filter = { minTv: 0, caps: [], minRate: null, minTurn: null, commonOnly: false };
const FILTER_KEY = "vntg.screener.filter";

/** 거래대금 빠른 선택(억원) */
const TV_CHIPS = [0, 100, 300, 500, 1000, 3000];
/**
 * 시가총액 구간(억원).
 *
 * 「대형·중형·소형」은 거래소 분류가 따로 있지만 **연 1회 정기 변경**이라 지금
 * 감각과 다르다. 숫자로 끊는 게 헷갈리지 않는다.
 */
const CAP_CHIPS: { label: string; min: number; max: number }[] = [
  { label: "3천억 미만", min: 0, max: 3000 },
  { label: "3천억~1조", min: 3000, max: 10000 },
  { label: "1조~10조", min: 10000, max: 100000 },
  { label: "10조 이상", min: 100000, max: 0 },
];

/** 고른 구간 중 **하나라도** 맞으면 통과 */
function capOk(cap: number | null, picked: string[]): boolean {
  if (picked.length === 0) return true;
  if (cap === null) return false;
  return picked.some((label) => {
    const c = CAP_CHIPS.find((x) => x.label === label);
    if (!c) return false;
    return cap >= c.min && (c.max === 0 || cap <= c.max);
  });
}

function loadFilter(): Filter {
  try {
    const raw = localStorage.getItem(FILTER_KEY);
    if (raw) return { ...NO_FILTER, ...(JSON.parse(raw) as Partial<Filter>) };
  } catch {
    /* 저장된 게 깨졌으면 그냥 안 건 상태로 */
  }
  return NO_FILTER;
}

/** 억원을 짧게 — 1조가 넘으면 조로 */
function eok(v: number | null): string {
  if (v === null) return "-";
  if (Math.abs(v) >= 10000) return `${(v / 10000).toFixed(v >= 100000 ? 0 : 1)}조`;
  return `${fmtNum(v)}억`;
}

function cell(value: unknown, type?: string): { text: string; cls: string } {
  if (type === "text") return { text: String(value ?? ""), cls: "" };
  if (value === null || value === undefined) return { text: "-", cls: "" };
  const n = Number(value);
  if (!Number.isFinite(n)) return { text: "-", cls: "" };
  const sign = n > 0 ? "positive" : n < 0 ? "negative" : "";
  /* 등락률은 이 표의 주인공 — 색에 더해 굵게. 온 표가 빨갛던 시절엔 이게 파묻혔다 */
  if (type === "pct") return { text: `${n > 0 ? "+" : ""}${n.toFixed(2)}%`, cls: `scr-rate ${sign}` };
  // 가격은 부호로 색을 칠하지 않는다 (음수 표기는 하락을 뜻하는 키움 관행이라 헷갈린다)
  if (type === "price") return { text: fmtNum(Math.abs(n)), cls: "" };
  /*
   * ⚠️ 색은 **부호가 정보인 숫자**(순매수·대비 = signed)에만 (2026-08-25).
   * 예전엔 num 전부를 부호로 칠해서 거래대금·거래량·순위까지 죄다 빨갰다 —
   * KRX/NXT 를 고르면 표가 온통 빨가니 정작 등락률이 안 보였다.
   */
  if (type === "signed") return { text: fmtNum(n), cls: sign };
  return { text: fmtNum(n), cls: "" };
}

/**
 * 위에 세울 다섯 — 실제로 보던 것들.
 *
 * `rank` 는 서버 명세를 그리는 기존 machinery 를 그대로 쓴다.
 * `page` 는 이미 따로 있던 화면을 그대로 끼운다 — 같은 표를 두 벌 만들면
 * 한쪽만 고쳐지는 날이 온다.
 */
/** 순위 칸들 — 숫자 서너 자리라 좁게 둔다 */
const RANK_COLS = new Set(["now_rank", "pred_rank", "rank", "prev_rank"]);

export const SCREENER_TABS = [
  { key: "trade-value", label: "거래대금 상위", kind: "rank" as const },
  { key: "same-net", label: "기관/외국인 동일 순매매", kind: "page" as const },
  { key: "cont", label: "기관/외국인 연속매매", kind: "page" as const },
  { key: "cum", label: "누적등락률 상위", kind: "page" as const },
  { key: "flu-rate", label: "등락률 상위", kind: "rank" as const },
  /* 키움 순위에는 없어서 시황 스냅샷으로 우리가 세운다 */
  { key: "market-cap", label: "시가총액 상위", kind: "rank" as const },
  { key: "top-traders", label: "수익률 상위고객", kind: "page" as const },
  { key: "etc", label: "그 밖에", kind: "tree" as const },
];

export function ScreenerPage({
  onSelectStock,
}: {
  onSelectStock?: (code: string, name: string) => void;
}) {
  const [groups, setGroups] = useState<RankSpecGroup[]>([]);
  const [tab, setTab] = useState<string>("trade-value");
  const [active, setActive] = useState("flu-rate");
  const [market, setMarket] = useState("000");
  /*
   * 기본은 **통합**이다 — 거래대금이 하루 전체(NXT 프리 + KRX 정규 + NXT 애프터)라
   * 순위가 맞다. 2026-08-24 실측: 삼성전자 KRX 84,561억 + NXT 52,463억 = 통합 137,023억.
   * KRX 만 보면 순위 자체가 틀어진다.
   *
   * ⚠️ 가격은 통합이 NXT 최종가를 주므로 **서버가 KRX 값으로 덮어** 준다.
   * 그래야 목록과 종목 상세가 같은 값을 말한다.
   */
  const [exchange, setExchange] = useState("3");
  const [data, setData] = useState<RankResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>(loadFilter);
  const [openFilter, setOpenFilter] = useState(false);

  const set = (patch: Partial<Filter>) => {
    const next = { ...filter, ...patch };
    setFilter(next);
    try {
      setPref(FILTER_KEY, JSON.stringify(next));
    } catch {
      /* 저장 못 해도 이번 화면에서는 걸린다 */
    }
  };

  /*
   * **몇 건 받고, 한 화면에 몇 개 볼까.**
   *
   * 둘은 다른 질문이다. 받는 건수는 「거래대금 150위까지 궁금하다」이고, 한 화면 개수는
   * 「한 번에 눈에 들어오는 양」이다. 300건을 받아 놓고 50개씩 보는 게 실제로 쓰는 방식이라
   * 하나로 묶으면 둘 중 하나를 포기하게 된다.
   *
   * 조회 건수를 늘리면 **연속조회가 그만큼 더 나간다**(100건에 한 번). 기본 100 은
   * 예전과 같아서, 안 건드리면 부하도 예전 그대로다.
   */
  const [limit, setLimit] = useState<number>(() => Number(localStorage.getItem("vntg.screener.limit")) || 100);
  /*
   * 자유 입력 칸의 글자 — limit 과 따로 둔다 (2026-08-25, 신호등 찾기와 같은 문법).
   * 글자마다 limit 을 바꾸면 타이핑마다 순위 TR 이 나간다. Enter·포커스아웃에서 확정.
   */
  const [limitText, setLimitText] = useState<string>(() => String(Number(localStorage.getItem("vntg.screener.limit")) || 100));
  const commitLimit = (raw: number) => {
    const n = Math.round(raw);
    // 서버 클램프(20~500)와 같은 값 — 화면과 서버가 다른 숫자를 말하면 안 된다
    const next = Number.isFinite(n) && n > 0 ? Math.min(500, Math.max(20, n)) : limit;
    setLimitText(String(next));
    if (next === limit) return;
    setLimit(next);
    try {
      localStorage.setItem("vntg.screener.limit", String(next));
    } catch {
      /* 저장 못 해도 이번 세션에는 바뀐다 */
    }
  };
  const [pageSize, setPageSize] = useState<number>(() => Number(localStorage.getItem("vntg.screener.pageSize")) || 100);
  const [page, setPage] = useState(0);
  /* 신호등은 **켤 때만** — 목록을 여는 것만으로 백 종목을 평가하면 안 된다 */
  const [sigOn, setSigOn] = useState(false);
  const [editTabs, setEditTabs] = useState(false);
  /** 열 순서 편집 중 — 켜면 머리 칸에 ◀▶ 가 붙는다 */
  const [editCols, setEditCols] = useState(false);
  /** 신호등 색깔순 — 지금 쪽 안에서만 */
  const [sigSort, setSigSort] = useState<"desc" | "asc" | null>(null);
  /* 종목 상세 탭과 같은 훅 — 서버에 저장되어 기기가 달라도 같은 순서다 */
  /*
   * 칸 너비 — **조회마다 따로** 기억한다. 조회를 바꾸면 열 구성이 통째로 달라지므로
   * 하나로 묶으면 「거래대금 상위에서 넓힌 칸」이 「연속매매」의 엉뚱한 칸을 넓힌다.
   */
  const cw = useColumnWidths(`rank.${tab}`);
  const tabOrder = useCardOrder(
    "screener.tabs",
    SCREENER_TABS.map((t) => t.key),
  );

  /** 지금 그릴 명세 — 탭이 rank 면 탭 것, 「그 밖에」면 트리에서 고른 것 */
  const current = SCREENER_TABS.find((t) => t.key === tab);
  const rankKey = current?.kind === "rank" ? tab : active;

  useEffect(() => {
    api
      .rankSpecs()
      .then((r) => setGroups(r.groups))
      .catch((e: Error) => setError(e.message));
  }, []);

  /*
   * 조회를 한 번 부른다.
   *
   * `quiet` 는 **스스로 다시 받을 때** 쓴다 — 그때 로딩을 띄우면 이십 초마다 표가
   * 깜빡이고, 읽던 자리를 놓친다. 값만 조용히 갈아끼운다.
   */
  const fetchRank = useCallback(
    (quiet = false) => {
      if (!quiet) setLoading(true);
      setError(null);
      api
        .rank(rankKey, market, exchange, limit)
        .then((r) => setData(r))
        .catch((e: Error) => setError(e.message))
        .finally(() => setLoading(false));
    },
    [rankKey, market, exchange, limit],
  );

  useEffect(() => {
    fetchRank();
  }, [fetchRank]);

  /*
   * 장중에는 스스로 다시 받는다 — 순위는 계속 뒤집히는 값이다.
   * 10초 (2026-08-25, 20초에서) — 300건이어도 연속조회 3콜/10초 = TR 한도의 6%다.
   * 가격·등락률은 아래 실시간 오버레이가 1.5초로 덧씌우므로, 이 주기는 **순위 재편**만 맡는다.
   */
  const auto = useAutoRefresh(() => fetchRank(true), {
    storeKey: "vntg.auto.screener",
    intervalMs: 10_000,
  });

  /* 조회가 바뀌면 첫 장으로 — 3쪽을 보다가 다른 순위로 갔는데 3쪽이면 빈 화면이 뜬다 */
  useEffect(() => {
    setPage(0);
  }, [rankKey, market, exchange, limit, pageSize, filter]);

  const cols = data?.spec.columns ?? [];
  const all = data?.rows ?? [];

  /*
   * 열 순서 — **조회마다 따로**, 탭·칸너비와 같은 훅(서버 저장, 기기 공유).
   * 종목명은 sticky 첫 칸이라 못 옮긴다. 표는 CSS order 로는 못 세우므로
   * (머리와 몸이 같은 순서여야 한다) 배열을 실제로 다시 세운다.
   */
  const colOrder = useCardOrder(
    `rank.cols.${rankKey}`,
    cols.filter((c) => c.key !== "stk_nm").map((c) => c.key),
  );
  const orderedCols = [...cols.filter((c) => c.key !== "stk_nm")].sort(
    (a, b) => colOrder.orderOf(a.key) - colOrder.orderOf(b.key),
  );

  /*
   * 거르기. **못 재는 값으로는 안 거른다** — 시가총액이 null 인 종목(상장주식수를
   * 못 찾은 것)을 「조건 미달」로 버리면 조용히 사라진다. 조건을 켠 항목에 대해
   * 값이 없으면 그때만 뺀다.
   */
  /*
   * ⚠️ **이 조회가 낼 수 없는 값으로는 거르지 않는다.**
   *
   * 회전율 필터를 켜 둔 채 시가총액 상위로 가면 그 조회에는 회전율이 없어서 **전부
   * 걸러졌다** — 빈 표가 뜨고 이유는 화면에 없었다. 필터는 조회를 옮겨도 남는 값이라
   * (그게 편한 점이기도 하다) 낼 수 없는 항목은 그 조회에서만 조용히 쉰다.
   */
  const hasTurnCol = all.some((r) => r.turn !== null);
  const hasCapCol = all.some((r) => r.cap !== null);
  const hasTvCol = all.some((r) => r.tv !== null);

  const rows = all.filter((r) => {
    if (filter.commonOnly && !r.common) return false;
    if (hasTvCol && filter.minTv > 0 && (r.tv === null || r.tv < filter.minTv)) return false;
    if (hasCapCol && !capOk(r.cap, filter.caps)) return false;
    if (filter.minRate !== null) {
      const rate = Number(r.flu_rt ?? r.jmp_rt);
      if (!Number.isFinite(rate) || rate < filter.minRate) return false;
    }
    /* 상장주식수를 못 찾아 회전율이 없는 종목은, 이 조건을 켰을 때만 뺀다 */
    if (hasTurnCol && filter.minTurn !== null && (r.turn === null || r.turn < filter.minTurn)) {
      return false;
    }
    return true;
  });

  const hasCap = hasCapCol;
  const hasTurn = hasTurnCol;
  /*
   * 정렬.
   *
   * 키움이 준 **순위 그대로**가 기본이다 — 「거래대금 상위」는 이미 거래대금순이고
   * 그게 이 조회의 뜻이다. 열 이름을 누르면 그때만 다시 세운다.
   *
   * ⚠️ **이 화면에 온 백 종목 안에서만** 다시 세운다. 시가총액순으로 누른다고
   * 시장 전체의 시총 순위가 나오는 게 아니다 — 거래대금 상위 100 중 시총이 큰 순서다.
   * 그 둘은 다른 질문이라 표 아래에 적어 둔다.
   */
  const sort = useSortableTable(rows);

  /*
   * 한 장씩 잘라 그린다. **거른 뒤·정렬한 뒤**에 자른다 — 거르기 전에 자르면
   * 「1쪽에 조건에 맞는 게 없다」가 되고, 정렬 전에 자르면 1쪽만 정렬된 꼴이 된다.
   */
  const pageCount = Math.max(1, Math.ceil(sort.sorted.length / pageSize));
  const pageAt = Math.min(page, pageCount - 1);
  const shown = sort.sorted.slice(pageAt * pageSize, (pageAt + 1) * pageSize);
  /* 지금 쪽만 평가한다 — 안 볼 것을 미리 계산할 이유가 없다 */
  const signals = useSignalColumn(shown.map((r) => r.code), sigOn);

  /*
   * 실시간 오버레이 (2026-08-25) — **이 쪽 줄들의 현재가·등락률을 1.5초로.**
   *
   * 순위 조회는 10초마다지만 가격은 그보다 빨리 움직인다. 거래대금 상위는 스케줄러가
   * 이미 웹소켓으로 물고 있으므로(낮 국면 190종목) **읽기 전용**으로 최신값만 얹는다 —
   * 키움 호출도, 구독 정원도 안 는다. 값이 없는 줄(구독 밖)은 REST 값 그대로다.
   *
   * ⚠️ 통합일 때만. KRX/NXT 를 콕 집어 보는 중이면 실시간(통합 최신가)을 덮는 게
   * 거짓말이 된다 — 그 화면은 그 거래소의 값을 보겠다는 뜻이다.
   */
  // KRX 정규장 밖(NXT 프리·애프터)엔 오버레이를 끈다 — KRX 0% 가 통합 값을 덮어 「왜 0이냐」가 됐다
  const liveOn = (!data?.spec.exchange || exchange === "3") && krxOverlayLive();
  /*
   * NXT 서브 줄은 **정규장엔 숨긴다** (2026-08-26 — 「정규장 돌아가는데 나타났다
   * 사라졌다 헷갈린다」). 목록은 통합 숫자 하나면 되고, NXT 가 궁금하면 종목을
   * 누르면 상세에 있다. 프리·애프터·마감(NXT 가 그날의 주인공인 시간)엔 보여 준다.
   */
  const showNxtSub = !krxOverlayLive();
  const rt = useRealtime(liveOn ? shown.map((r) => `0B:${r.code}`) : [], 1500, { readOnly: true });
  const liveOf = (code: string): { price: number; rate: number | null } | null => {
    if (!liveOn) return null;
    if (!rt.healthy) return null;
    const v = rt.values[`0B:${code}`];
    if (!v || Date.now() - v.at > 90_000) return null;
    const p = fid(v, "10");
    if (p === null || p === 0) return null;
    return { price: Math.abs(p), rate: fid(v, "12") };
  };

  /*
   * 색깔순은 **이 쪽 안에서** 다시 세운다. 평가한 것이 이 쪽뿐이라 그 밖은 셀 수가 없다.
   * 평가가 아직인 줄은 늘 아래로 — 위에 섞이면 초록이 몇 개인지 세다가 헷갈린다.
   */
  const RANK: Record<string, number> = { green: 3, yellow: 2, red: 1, unknown: 0 };
  const drawn =
    sigOn && sigSort
      ? [...shown].sort((a, b) => {
          const av = signals[a.code] ? RANK[signals[a.code].level] ?? 0 : -1;
          const bv = signals[b.code] ? RANK[signals[b.code].level] ?? 0 : -1;
          if (av === bv) return 0;
          if (av < 0) return 1;
          if (bv < 0) return -1;
          return sigSort === "desc" ? bv - av : av - bv;
        })
      : shown;
  const estimated = rows.some((r) => r.tvEst);
  const on =
    filter.minTv > 0 ||
    filter.caps.length > 0 ||
    filter.minRate !== null ||
    filter.minTurn !== null ||
    filter.commonOnly;

  return (
    <div>
      {/* 실제로 보는 다섯이 앞이다 — 트리를 매번 훑지 않게 */}
      {/* 폰에서는 한 줄로 세우고 옆으로 넘긴다 — 컨트롤이 표를 밀어내지 않게 */}
      <div className="filter-row scr-tabs ctl-ribbon">
        {/*
          탭 순서는 사람이 정한다. 자주 쓰는 조회는 사람마다 다른데 여덟 개나 되니
          늘 쓰는 게 뒤에 있으면 매번 눈으로 훑어야 한다. 종목 상세 탭과 **같은 훅**이라
          서버에 저장되어 기기가 달라도 같은 순서다.

          JSX 를 재배열하지 않고 CSS `order` 만 준다 — 배열을 흔들면 리액트가 칸을
          다시 만든다.
        */}
        {SCREENER_TABS.map((t) => (
          <button
            key={t.key}
            className={`filter-btn ${tab === t.key ? "active" : ""}${tabOrder.drag.cls(t.key)}`}
            style={{ order: tabOrder.orderOf(t.key) }}
            onClick={() => setTab(t.key)}
            {...tabOrder.drag.props(t.key)}
          >
            {t.label}
            {editTabs && (
              <>
                <span
                  className="dt-move"
                  role="button"
                  title="앞으로"
                  onClick={(e) => {
                    e.stopPropagation();
                    tabOrder.move(t.key, -1);
                  }}
                >
                  ◀
                </span>
                <span
                  className="dt-move"
                  role="button"
                  title="뒤로"
                  onClick={(e) => {
                    e.stopPropagation();
                    tabOrder.move(t.key, 1);
                  }}
                >
                  ▶
                </span>
              </>
            )}
          </button>
        ))}
        <button
          className={`filter-btn dt-edit${editTabs ? " active" : ""}`}
          style={{ order: 999 }}
          onClick={() => setEditTabs((v) => !v)}
          title="자주 보는 조회를 앞으로 옮깁니다"
        >
          {editTabs ? "순서 끝" : "탭 순서"}
        </button>
      </div>
      {editTabs && (
        <div className="table-note">
          탭 이름 옆 <b>◀ ▶</b> 로 옮깁니다. 서버에 저장되어 <b>다른 기기에서도 같은 순서</b>입니다.
          {tabOrder.customized && (
            <button className="filter-btn dt-reset" onClick={tabOrder.reset}>
              원래대로
            </button>
          )}
        </div>
      )}

      {tab === "same-net" && <SameNetTradeRankingPage onSelectStock={onSelectStock ?? (() => {})} />}
      {tab === "cont" && <ContinuousTradePage onSelectStock={onSelectStock ?? (() => {})} />}
      {tab === "top-traders" && <TopTradersTable onSelectStock={onSelectStock} />}
      {tab === "cum" && <CumulativeRank onSelectStock={onSelectStock} />}

      {current?.kind !== "page" && (
        /*
          ⚠️ 격자가 늘 `178px 1fr` 이었다. 그런데 트리는 「그 밖에」에서만 그리므로,
          다른 탭에서는 표가 **178px 칸에 갇혔다** — 1025px 화면에서 표가 178px 안에
          들어앉고 옆의 831px 이 통째로 비어 있었다. 열 이름이 「전/일/순/위」처럼
          세로로 쪼개져 보이던 게 그것이다. 해상도 문제로 보였지만 칸 문제였다.
        */
        <div className={`screener${tab === "etc" ? "" : " no-tree"}`}>
          {/* 「그 밖에」일 때만 트리를 편다 — 다섯 탭에서는 자리만 먹는다 */}
          {tab === "etc" && (
            <aside className="scr-tree">
              {groups.map((g) => (
                <div className="scr-group" key={g.group}>
                  <div className="scr-group-name">{g.group}</div>
                  {g.items.map((it) => (
                    <button
                      key={it.key}
                      className={`scr-item${active === it.key ? " active" : ""}`}
                      onClick={() => setActive(it.key)}
                    >
                      {it.label}
                    </button>
                  ))}
                </div>
              ))}
            </aside>
          )}

      <div className="scr-main">
        <div className="filter-row ctl-ribbon">
          {MARKETS.map((m) => (
            <button
              key={m.key}
              className={`filter-btn ${market === m.key ? "active" : ""}`}
              onClick={() => setMarket(m.key)}
            >
              {m.label}
            </button>
          ))}
          {data?.spec.exchange && (
            <>
              <span className="news-scope-sep" />
              {EXCHANGES.map((e) => (
                <button
                  key={e.key}
                  className={`filter-btn ${exchange === e.key ? "active" : ""}`}
                  onClick={() => setExchange(e.key)}
                  title={e.hint}
                >
                  {e.label}
                </button>
              ))}
            </>
          )}
          {data && (
            <span className="breadth-count">
              {on ? `${rows.length} / ${all.length}건` : `${all.length}건`}
            </span>
          )}
          {/*
            **쉬고 있는 필터를 말해 준다.** 안 그러면 「거래대금 500억↑ 을 켜 뒀는데
            왜 다 나오지」가 된다 — 조용히 무시하는 것도 조용히 거르는 것만큼 나쁘다.
          */}
          {data &&
            (() => {
              const idle: string[] = [];
              if (!hasTvCol && filter.minTv > 0) idle.push("거래대금");
              if (!hasTurnCol && filter.minTurn !== null) idle.push("회전율");
              if (!hasCapCol && filter.caps.length > 0) idle.push("시가총액");
              return idle.length > 0 ? (
                <span className="scr-idle" title="이 조회는 그 값을 주지 않습니다">
                  {idle.join("·")} 필터는 쉽니다
                </span>
              ) : null;
            })()}
          {/*
            스스로 갱신 스위치. 순위는 장중에 계속 뒤집히는 값이라 새로고침을 누르러
            오게 하면 안 된다. 장이 닫혀 있으면 켜져 있어도 쉰다.
          */}
          <button
            className={`refresh-auto${auto.on ? " on" : ""}`}
            onClick={auto.toggle}
            title={
              auto.on
                ? auto.marketOpen
                  ? "장중에는 20초마다 스스로 다시 받습니다 — 눌러서 끄기"
                  : "켜져 있지만 장이 닫혀 쉬는 중입니다"
                : "스스로 다시 받게 하기"
            }
          >
            {auto.on ? (auto.marketOpen ? "⟳ 자동" : "⟳ 자동(대기)") : "⟳ 자동 꺼짐"}
          </button>
          <button
            className={`filter-btn ${sigOn ? "active" : ""}`}
            onClick={() => setSigOn((v) => !v)}
            title="지금 보고 있는 쪽만 평가합니다 — 처음엔 좀 걸립니다"
          >
            🚦 신호등 {sigOn ? "끄기" : "켜기"}
          </button>
          {/*
            받을 건수. 늘리면 연속조회가 그만큼 더 나가므로 **기본은 예전과 같은 100** 이다.
            안 건드리면 부하도 예전 그대로다.
          */}
          <span className="scr-page-k">조회</span>
          {[100, 300, 500].map((n) => (
            <button
              key={n}
              className={`filter-btn ${limit === n ? "active" : ""}`}
              onClick={() => commitLimit(n)}
              title={n === 100 ? "예전과 같습니다" : `연속조회 ${Math.ceil(n / 100)}번 — 쪽으로 나눠 보므로 화면 부담은 같습니다`}
            >
              {n}
            </button>
          ))}
          {/*
            자유 입력 (신호등 찾기와 같은 문법) — 버튼 셋이 정답일 리 없다. 20~500.
            ⚠️ 확정은 Enter·포커스아웃에서만 — 글자마다 확정하면 「3」을 치는 순간
            조회가 나가고, 「30」에서 또 나간다. 순위 TR 을 타이핑 속도로 부르면 안 된다.
          */}
          <input
            className="pt-input short"
            type="number"
            inputMode="numeric"
            min={20}
            max={500}
            value={limitText}
            onChange={(e) => setLimitText(e.target.value)}
            onBlur={() => commitLimit(Number(limitText))}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitLimit(Number(limitText));
            }}
            title="상위 몇 위까지 받을지 — 20~500, Enter 로 확정"
          />
          <span className="pt-n">위까지</span>
          {/* 필터는 접어 둔다 — 늘 펴 두면 표가 화면 밖으로 밀린다 */}
          <button
            className={`filter-btn ${on ? "active" : ""}`}
            onClick={() => setOpenFilter(!openFilter)}
            title="거래대금·시가총액으로 좁혀 봅니다"
          >
            {openFilter ? "필터 ▲" : "필터 ▼"}
            {on ? " ●" : ""}
          </button>
          {/* 열 순서 — 자주 보는 값(등락률·거래대금)을 앞으로. 조회마다 따로 저장된다 */}
          <button
            className={`filter-btn ${editCols ? "active" : ""}`}
            onClick={() => setEditCols((v) => !v)}
            title="머리 칸의 ◀▶ 로 열 자리를 옮깁니다 — 조회마다 따로, 서버에 저장됩니다"
          >
            {editCols ? "칸 순서 끝" : "칸 순서"}
          </button>
        </div>
        {editCols && (
          <div className="table-note">
            머리 칸의 <b>◀ ▶</b> 로 열을 옮깁니다. <b>조회마다 따로</b> 저장되어 다른
            기기에서도 같은 순서입니다. 종목명은 고정 첫 칸이라 못 옮깁니다.
            {colOrder.customized && (
              <button className="filter-btn dt-reset" onClick={colOrder.reset}>
                원래대로
              </button>
            )}
          </div>
        )}

        {openFilter && (
          <div className="scr-filter">
            <div className="scr-f-row">
              <span className="st-cfg-k">거래대금</span>
              {TV_CHIPS.map((v) => (
                <button
                  key={v}
                  className={`filter-btn ${filter.minTv === v ? "active" : ""}`}
                  onClick={() => set({ minTv: v })}
                >
                  {v === 0 ? "전체" : `${fmtNum(v)}억↑`}
                </button>
              ))}
              <input
                className="scr-f-num"
                type="number"
                inputMode="numeric"
                placeholder="직접"
                value={filter.minTv || ""}
                onChange={(e) => set({ minTv: Math.max(0, Number(e.target.value) || 0) })}
              />
              <span className="pt-n">억 이상</span>
            </div>

            <div className="scr-f-row">
              <span className="st-cfg-k">시가총액</span>
              {/* 여기만 복수 선택 — 구간이 안 겹쳐서 「또는」이 뜻을 갖는다 */}
              <button
                className={`filter-btn ${filter.caps.length === 0 ? "active" : ""}`}
                onClick={() => set({ caps: [] })}
                disabled={!hasCap}
              >
                전체
              </button>
              {CAP_CHIPS.map((c) => (
                <button
                  key={c.label}
                  className={`filter-btn ${filter.caps.includes(c.label) ? "active" : ""}`}
                  onClick={() =>
                    set({
                      caps: filter.caps.includes(c.label)
                        ? filter.caps.filter((x) => x !== c.label)
                        : [...filter.caps, c.label],
                    })
                  }
                  disabled={!hasCap}
                  title="여러 구간을 같이 고를 수 있습니다"
                >
                  {c.label}
                </button>
              ))}
            </div>

            {/*
              회전율 — **거래대금과 짝**이다. 거래대금만 걸면 큰 종목만 남고,
              회전율만 걸면 거래가 거의 없는 종목이 몇 주 돌아도 높게 나온다.
            */}
            <div className="scr-f-row">
              <span className="st-cfg-k">회전율</span>
              {[null, 1, 3, 5, 10, 20].map((v) => (
                <button
                  key={String(v)}
                  className={`filter-btn ${filter.minTurn === v ? "active" : ""}`}
                  onClick={() => set({ minTurn: v })}
                  disabled={!hasTurn}
                  title={
                    v === null
                      ? undefined
                      : `상장주식의 ${v}% 이상이 오늘 손바뀜한 종목`
                  }
                >
                  {v === null ? "전체" : `${v}%↑`}
                </button>
              ))}
              {!hasTurn && <span className="pt-n">상장주식수를 못 찾아 못 냅니다</span>}
            </div>

            <div className="scr-f-row">
              <span className="st-cfg-k">등락률</span>
              {[null, 0, 3, 5, 10].map((v) => (
                <button
                  key={String(v)}
                  className={`filter-btn ${filter.minRate === v ? "active" : ""}`}
                  onClick={() => set({ minRate: v })}
                >
                  {v === null ? "전체" : `+${v}%↑`}
                </button>
              ))}
              <span className="news-scope-sep" />
              <button
                className={`filter-btn ${filter.commonOnly ? "active" : ""}`}
                onClick={() => set({ commonOnly: !filter.commonOnly })}
                title="거래대금 상위는 KODEX·TIGER 같은 ETF와 우선주가 늘 위에 있습니다"
              >
                보통주만
              </button>
              {on && (
                <button className="filter-btn" onClick={() => set(NO_FILTER)}>
                  초기화
                </button>
              )}
            </div>

            <div className="table-note">
              {/*
                정렬은 **여기 온 백 종목 안에서만** 다시 세운다. 이걸 안 적으면
                「시가총액순으로 눌렀는데 왜 삼성전자가 없냐」가 된다.
              */}
              열 이름을 누르면 <b>이 목록 안에서</b> 다시 세웁니다 — 거래대금 상위 100 중
              시총이 큰 순서지, 시장 전체의 시총 순위가 아닙니다.
              <br />
              코스피·코스닥은 위의 <b>시장</b>에서 고릅니다(키움에 그대로 물어보는 값입니다).
              시가총액은 <b>상장주식수 × 현재가</b>로 낸 값입니다 — 순위 조회에는 시가총액이
              없어서 종목 목록에서 붙입니다.
              {estimated && (
                <>
                  {" "}
                  ⚠️ 이 조회는 거래대금을 안 주므로 <b>거래량 × 현재가로 어림</b>합니다(평균단가가
                  아니라 현재가로 곱한 값이라 정확하지 않습니다).
                </>
              )}
            </div>
          </div>
        )}

        {error && <div className="error-banner">{error}</div>}
        {loading && !data && <div className="empty">불러오는 중…</div>}

        {data && (
          <>
            <h3 className="section-heading">
              {data.spec.label}
              {/*
                칸 너비를 건드린 뒤에만 뜬다 — 안 건드렸으면 되돌릴 게 없다.
                이 버튼이 없으면 잘못 끌었을 때 되돌릴 길이 없어서 아예 못 끌게 된다.
              */}
              {cw.customized && (
                <button className="filter-btn dt-reset" onClick={cw.reset} title="칸 너비를 기본으로">
                  칸 너비 원래대로
                </button>
              )}
            </h3>
            <div className="data-table-wrap">
              {/*
                **칸 너비를 내가 정한다.**

                이 표는 열이 열댓 개다. 종목명 칸이 넓게 잡혀 있으면 회전율·시가총액이
                오른쪽으로 밀려 가로로 한참 스크롤해야 한다. 그런데 **어느 칸이 중요한지는
                그날 무엇을 보느냐마다 다르다** — 코드가 정해 줄 값이 아니다.

                머리 칸 오른쪽 가장자리를 끌면 바뀌고, 서버에 저장되어 기기가 달라도 같다.
                조회를 바꾸면 열 구성이 통째로 달라지므로 **조회마다 따로** 기억한다.
              */}
              <table className={`data-table${cw.customized ? " col-fixed" : ""}`}>
                <colgroup>
                  {sigOn && <col style={{ width: "2.4rem" }} />}
                  <col style={cw.styleOf("stk_nm")} />
                  {orderedCols.map((c) => (
                    <col key={c.key} style={cw.styleOf(c.key)} />
                  ))}
                  {hasTurn && <col style={cw.styleOf("turn")} />}
                  {hasCap && <col style={cw.styleOf("cap")} />}
                </colgroup>
                <thead>
                  <tr>
                    {sigOn && (
                      /*
                        머리를 누르면 **색깔로 줄을 세운다.** 초록이 위로 오는 게 기본이라
                        「볼 만한 게 뭔가」가 첫 화면에 모인다.

                        ⚠️ **지금 쪽 안에서만** 세운다. 신호등은 보이는 쪽만 평가하므로
                        전체를 세우려 하면 평가 안 된 줄이 대부분이라 아무 뜻이 없다.
                        그걸 화면에 적어 둔다 — 안 적으면 「초록이 이것뿐인가」로 읽는다.
                      */
                      <th
                        className={`sig-th sortable-th${sigSort ? " active" : ""}`}
                        onClick={() =>
                          setSigSort((v) => (v === null ? "desc" : v === "desc" ? "asc" : null))
                        }
                        title="이 쪽 안에서 색깔순으로 — 초록 먼저 → 빨강 먼저 → 원래대로"
                      >
                        🚦{sigSort === "desc" ? "▾" : sigSort === "asc" ? "▴" : ""}
                      </th>
                    )}
                    <th className="sticky-col">
                      종목명
                      <ColumnGrip cw={cw} k="stk_nm" />
                    </th>
                    {orderedCols.map((c) => (
                      <SortableTh
                        key={c.key}
                        columnKey={c.key}
                        label={c.label}
                        /* 끌어서 열 자리 옮기기 — 화살표(칸 순서 모드)와 같은 저장으로 떨어진다 */
                        thProps={colOrder.drag.props(c.key)}
                        /* 순위 칸은 숫자 서너 자리면 충분하다 — 폰에서 자리를 아낀다 */
                        className={`${RANK_COLS.has(c.key) ? "num-narrow" : ""}${colOrder.drag.cls(c.key)}`}
                        accessor={(r: (typeof rows)[number]) => {
                          const v = r[c.key];
                          if (c.type === "text") return String(v ?? "");
                          const n = Number(v);
                          return Number.isFinite(n) ? n : -Infinity;
                        }}
                        sort={sort}
                        extra={
                          <>
                            {/* 열 순서 편집 — 화살표는 정렬 클릭과 섞이면 안 되므로 전파를 막는다 */}
                            {editCols && (
                              <>
                                <span
                                  className="dt-move"
                                  role="button"
                                  title="왼쪽으로"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    colOrder.move(c.key, -1);
                                  }}
                                >
                                  ◀
                                </span>
                                <span
                                  className="dt-move"
                                  role="button"
                                  title="오른쪽으로"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    colOrder.move(c.key, 1);
                                  }}
                                >
                                  ▶
                                </span>
                              </>
                            )}
                            <ColumnGrip cw={cw} k={c.key} />
                          </>
                        }
                      />
                    ))}
                    {/* 걸러 보는 기준이면 표에도 있어야 한다 */}
                    {hasTurn && (
                      <SortableTh
                        columnKey="turn"
                        label="회전율"
                        accessor={(r: (typeof rows)[number]) => r.turn ?? -Infinity}
                        sort={sort}
                        extra={<ColumnGrip cw={cw} k="turn" />}
                      />
                    )}
                    {hasCap && (
                      <SortableTh
                        columnKey="cap"
                        label="시가총액"
                        accessor={(r: (typeof rows)[number]) => r.cap ?? -Infinity}
                        sort={sort}
                        extra={<ColumnGrip cw={cw} k="cap" />}
                      />
                    )}
                  </tr>
                </thead>
                <tbody>
                  {/*
                    **줄 아무 데나 눌러도 상세가 열린다.**

                    이름 글자만 눌러야 열리게 두었더니, 거래대금이나 등락률을 보다가
                    누르면 아무 일도 안 났다 — 거래상위·연속매매·동일순매매는 이미
                    줄 전체가 눌린다. **같은 표인데 화면마다 다르면 그때마다 다시 배운다.**

                    신호등 칸은 자기 동작(색 정렬·상세)이 따로 있으므로 `stopPropagation`
                    으로 막는다. 여기서 안 막으면 신호등을 눌렀는데 상세가 열린다.
                  */}
                  {drawn.map((r, i) => (
                    <tr
                      key={`${r.code}-${i}`}
                      className={onSelectStock ? "clickable-row" : ""}
                      onClick={() => onSelectStock?.(r.code, r.name)}
                    >
                      {sigOn && (
                        <td className="sig-td" onClick={(e) => e.stopPropagation()}>
                          <SignalCell
                            code={r.code}
                            name={r.name}
                            signal={signals[r.code]}
                            onSelectStock={onSelectStock}
                          />
                        </td>
                      )}
                      {/* 이름이 길면 잘린다(CSS) — 전체는 마우스를 올려서 본다 */}
                      <td className="sticky-col" title={r.name}>
                        {/* 줄 전체가 눌리므로 여기선 글자만 — 버튼 모양은 남겨 둔다(눌리는 자리라는 표) */}
                        <span className="link-btn">{r.name}</span>
                        {/* 시장이 「전체」면 어느 시장인지가 정보다 */}
                        {market === "000" && r.mkt && <i className="scr-mkt">{r.mkt}</i>}
                      </td>
                      {orderedCols.map((c) => {
                          const v = cell(r[c.key], c.type);
                          /*
                           * 거래대금은 **어디서 돌았는지**까지 보여준다.
                           *
                           * 하루 거래는 NXT 프리(08~09시) + KRX 정규 + NXT 애프터 셋이다.
                           * 합계만 적으면 「이 종목이 NXT 에서 돈 게 절반」 같은 걸 놓친다 —
                           * 삼성전자는 오늘 137,023억 중 52,462억(38%)이 NXT 였다.
                           *
                           * ⚠️ 서브 줄은 **NXT 몫이 있을 때만** (2026-08-25). NXT 에서 안 돈
                           * 종목까지 「KRX 27,238」을 달아 주니 통합인데 KRX 만 줄줄이
                           * 보였다 — 합계가 곧 KRX 인 종목은 굵은 값 하나면 끝난 얘기다.
                           */
                          if (c.key === "trde_prica" && r.tvKrx !== null && r.tv !== null) {
                            const nxt = r.tv - r.tvKrx;
                            return (
                              <td key={c.key} className="num">
                                <b>{fmtNum(r.tv)}억</b>
                                {showNxtSub && nxt > 0 && (
                                  <i className="scr-split">
                                    KRX {fmtNum(r.tvKrx)} · NXT {fmtNum(nxt)}
                                  </i>
                                )}
                              </td>
                            );
                          }
                          /*
                           * 현재가·등락률 — **실시간이 있으면 그 값이 먼저다**(●이 그 표시).
                           * 없으면 REST 값(통합은 KRX 기준으로 맞춘 것). 저녁의 NXT
                           * 애프터 값은 작은 줄로 — 해외 관심종목의 시간외 괄호와 같은 문법.
                           */
                          if (c.key === "cur_prc") {
                            const lv = liveOf(r.code);
                            return (
                              <td key={c.key} className="num">
                                {lv && <span className="uw-live-dot" title="키움 실시간 (1.5초)" />}
                                {lv ? fmtNum(lv.price) : v.text}
                                {showNxtSub && r.nxtPrice != null && !lv && (
                                  <i className="scr-split" title="NXT 최종가 — 프리·애프터장 포함">
                                    NXT {fmtNum(r.nxtPrice)}
                                  </i>
                                )}
                              </td>
                            );
                          }
                          if (c.key === "flu_rt") {
                            const lv = liveOf(r.code);
                            const rate =
                              lv?.rate ?? (Number.isFinite(Number(r.flu_rt)) ? Number(r.flu_rt) : null);
                            const rc = rate === null ? "" : rate > 0 ? "positive" : rate < 0 ? "negative" : "";
                            return (
                              <td key={c.key} className={`num scr-rate ${rc}`}>
                                {rate === null ? "-" : `${rate > 0 ? "+" : ""}${rate.toFixed(2)}%`}
                                {showNxtSub && r.nxtRate != null && lv?.rate == null && (
                                  <i
                                    className={`scr-split ${Number(r.nxtRate) > 0 ? "positive" : Number(r.nxtRate) < 0 ? "negative" : ""}`}
                                    title="NXT 최종 등락률 — 프리·애프터장 포함"
                                  >
                                    NXT {Number(r.nxtRate) > 0 ? "+" : ""}
                                    {Number(r.nxtRate).toFixed(2)}%
                                  </i>
                                )}
                              </td>
                            );
                          }
                          return (
                            <td
                              key={c.key}
                              className={`num ${v.cls}${RANK_COLS.has(c.key) ? " num-narrow" : ""}`}
                            >
                              {v.text}
                            </td>
                          );
                        })}
                      {hasTurn && (
                        <td className={`num ${r.turn !== null && r.turn >= 5 ? "positive" : "pt-n"}`}>
                          {r.turn === null ? "-" : `${r.turn.toFixed(r.turn >= 10 ? 0 : 1)}%`}
                        </td>
                      )}
                      {hasCap && <td className="num pt-n">{eok(r.cap)}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/*
              쪽 넘기기. **한 쪽에 몇 개**는 받는 건수와 다른 질문이라 따로 둔다 —
              300건을 받아 놓고 50개씩 보는 게 실제로 쓰는 방식이다.
              한 쪽에 다 들어가면 줄 자체를 안 그린다.
            */}
            {sort.sorted.length > 0 && (
              <div className="filter-row scr-pager">
                <span className="scr-page-k">한 쪽에</span>
                {[50, 100].map((n) => (
                  <button
                    key={n}
                    className={`filter-btn ${pageSize === n ? "active" : ""}`}
                    onClick={() => {
                      setPageSize(n);
                      try {
                        localStorage.setItem("vntg.screener.pageSize", String(n));
                      } catch {
                        /* 저장 못 해도 이번 세션에는 바뀐다 */
                      }
                    }}
                  >
                    {n}
                  </button>
                ))}
                {pageCount > 1 && (
                  <>
                    <span className="news-scope-sep" />
                    <button
                      className="filter-btn"
                      onClick={() => setPage(pageAt - 1)}
                      disabled={pageAt === 0}
                    >
                      ‹ 앞
                    </button>
                    <span className="breadth-count">
                      {pageAt + 1} / {pageCount}쪽
                      <b className="pt-n">
                        {" "}
                        ({pageAt * pageSize + 1}~{Math.min((pageAt + 1) * pageSize, sort.sorted.length)}위)
                      </b>
                    </span>
                    <button
                      className="filter-btn"
                      onClick={() => setPage(pageAt + 1)}
                      disabled={pageAt >= pageCount - 1}
                    >
                      뒤 ›
                    </button>
                  </>
                )}
              </div>
            )}

            {all.length === 0 && (
              <div className="empty">
                조회 결과가 없습니다. 장 시간에만 값이 들어오는 항목일 수 있습니다.
              </div>
            )}
            {all.length > 0 && rows.length === 0 && (
              <div className="empty">
                필터에 걸리는 종목이 없습니다 — <b>{all.length}건</b>이 전부 걸러졌습니다.
                조건을 풀어 보세요.
              </div>
            )}
            {data.spec.note && <div className="table-note">{data.spec.note}</div>}
          </>
        )}
          </div>
        </div>
      )}
    </div>
  );
}
