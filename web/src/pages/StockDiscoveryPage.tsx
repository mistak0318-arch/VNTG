import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  fmtNum,
  normalizeStockCode,
  pickList,
  signClass,
  type RawRecord,
  type ScreenHit,
  type SignalResult,
  type StockSearchResult,
} from "../api";
import { IntradayLevelsBar } from "../components/IntradayLevelsBar";
import { PriceHeader } from "../components/PriceHeader";
import { useSignals, SignalDot } from "../components/SignalLight";
import { StockSummaryPanel } from "../components/StockSummaryPanel";
import { StockTabsSection } from "../components/StockTabsSection";
import { useLive } from "../useLive";
import { useStockFocus } from "../useStockFocus";
import { WatchStar } from "../useWatchedCodes";
import { SuperMark } from "../useSuperMarks";
import { WatchButton } from "../components/WatchButton";

/**
 * 종목발굴 — **넘기기 바 + 개별종목분석.**
 *
 * 이 화면의 중심은 종목 하나가 아니라 **넘기기**다. 검색해서 들어오는 게 아니라
 * 거래대금 상위 100 을 ← → 로 넘겨 가며 고른다. 그래서 넘기는 바를 화면에
 * 붙박아 두고(`.sd-nav` 가 sticky) 방향키까지 받는다.
 *
 * ## 아래는 개별종목분석과 같은 것이다 (2026-09-01)
 *
 * 벤티지: "종목발굴에서 종목 옮겨가면 그 밑에 개별종목분석 내용 나오게 해달라고
 * 한거잖아."
 *
 * 예전엔 열두 블록을 격자로 깔았다. 그런데 그 블록들은 개별종목분석 탭과 **같은
 * 컴포넌트를 두 번째로 배치한 것**이었다 — 한쪽에 기능이 붙으면 다른 쪽은 낡아 갔고,
 * 같은 종목을 두 모양으로 보게 됐다. `StockTabsSection` 을 만들며 상세 시트와
 * 분석 화면을 합쳤던 것과 정확히 같은 문제다.
 *
 * 그래서 여기도 그 모듈을 쓴다. 새 탭은 그 한 곳에만 넣으면 **세 화면에 같이 생긴다.**
 *
 * ## ⚠️ 상세 시트를 안 띄운다
 *
 * 이 화면에서 종목을 고르는 길(`goStock`)은 **모달을 부르지 않는다.** 이미 상세를
 * 펼쳐 놓은 자리라 시트가 그 위를 덮으면 훑기를 막는다 — 원래 요청이 그것이었다.
 * 창 연동만 따로 보내고, 목록 밖 종목은 목록 맨 앞에 끼워 넣어 넘기기를 살린다.
 * (App 의 `StockDetail` 렌더가 `tab !== "discovery"` 로 이 화면을 뺀다.)
 *
 * ## 부하
 *
 * 탭은 **고른 하나만** 그리므로 종목당 조회가 격자 시절보다 오히려 줄었다.
 * 목록의 신호등은 기본으로 꺼 둔다 — 백 종목을 평가하면 서버가 한참 걸린다.
 */

/* ------------------------------------------------------------------ */
/* 모집단                                                              */
/* ------------------------------------------------------------------ */

type SourceKey = "volume" | "watch" | "screen";

interface Candidate {
  code: string;
  name: string;
  price: number;
  changeRate: number;
  /** 거래대금 (억원) — 없으면 null */
  tradeValue: number | null;
  /** 신호등 스크리너에서 온 종목만 있다 */
  score?: number;
}

const SOURCES: { key: SourceKey; label: string; hint: string }[] = [
  { key: "volume", label: "거래대금 상위", hint: "오늘 돈이 몰린 순서" },
  { key: "watch", label: "관심종목", hint: "내가 담아 둔 것" },
  { key: "screen", label: "신호등 결과", hint: "가장 최근 스크리너 실행 결과" },
];

const MARKETS: { key: string; label: string }[] = [
  { key: "000", label: "전체" },
  { key: "001", label: "코스피" },
  { key: "101", label: "코스닥" },
];

/** ka10030 응답의 목록 키 — 거래상위 화면과 같은 것을 쓴다 */
const VOLUME_LIST_KEYS = ["tdy_trde_qty_upper"];

/*
 * 블록 격자는 없앴다 (2026-09-01).
 *
 * 열두 블록을 격자로 깔아 놓았었는데, 그 블록들은 개별종목분석 탭과 **같은
 * 컴포넌트를 두 번째로 배치한 것**이었다. 한쪽에 기능이 붙으면 다른 쪽은 낡아 갔고,
 * 같은 종목을 두 모양으로 보게 됐다.
 *
 * 이제 여기도 `StockTabsSection` 을 쓴다 — 시트와 개별종목분석을 합칠 때와 같은
 * 이유다. 새 탭은 그 모듈 한 곳에만 넣으면 **세 화면에 같이 생긴다.**
 * (`LazyBlock`·`BLOCKS`·`BlockBody` 도 같이 빠졌다. 탭은 고른 하나만 그리므로
 * 화면에 들어올 때까지 미루는 장치가 필요 없다.)
 */

/* ------------------------------------------------------------------ */

export function StockDiscoveryPage({
  onOpenAnalysis,
}: {
  /**
   * 「개별종목분석」 탭으로 아예 옮겨 갈 때. **버튼을 눌렀을 때만** 부른다.
   *
   * ⚠️ 예전에는 여기에 `onSelectStock`(= 상세 모달을 여는 길)이 꽂혀 있었고,
   * 넘기기·목록 고르기·구성종목 누르기가 전부 그 길로 갔다. 그래서 방향키로
   * 훑을 때마다 **이 화면 위로 상세 시트가 덮였다** — 정작 이 화면이 이미
   * 열두 블록을 펼쳐 놓은 인라인 상세인데도. (2026-09-01 벤티지)
   *
   * 그 길이 필요했던 진짜 이유는 **창 연동**(`focus.publish`)뿐이라,
   * 연동은 아래에서 직접 보내고 모달은 더 이상 부르지 않는다.
   */
  onOpenAnalysis: (code: string, name: string) => void;
}) {
  const focus = useStockFocus();
  const [source, setSource] = useState<SourceKey>("volume");
  const [market, setMarket] = useState("000");
  const [list, setList] = useState<Candidate[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [listOpen, setListOpen] = useState(false);
  /** 목록 신호등 — 백 종목 평가는 무거워서 기본은 꺼 둔다 */
  const [listSignals, setListSignals] = useState(false);

  // 검색으로 모집단 밖의 종목도 볼 수 있게 한다
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<StockSearchResult[]>([]);

  const current: Candidate | null = list[index] ?? null;
  const code = current?.code ?? "";

  /* ---------------- 모집단 불러오기 ---------------- */

  const loadList = useCallback(async () => {
    setListLoading(true);
    setListError(null);
    try {
      let next: Candidate[] = [];
      if (source === "volume") {
        const raw = (await api.volumeRanking(market, "3")) as RawRecord;
        next = pickList(raw, VOLUME_LIST_KEYS)
          .slice(0, 100)
          .map((r) => ({
            code: normalizeStockCode(String(r.stk_cd ?? "")),
            name: String(r.stk_nm ?? ""),
            price: Math.abs(Number(r.cur_prc)) || 0,
            changeRate: Number(r.flu_rt) || 0,
            // 백만원으로 오므로 100 으로 나눠 억원으로
            tradeValue: Math.round((Number(r.trde_amt) || 0) / 100),
          }));
      } else if (source === "watch") {
        // watchlist 는 이름과 코드만 준다. 넘기기 바와 목록에 시세를 띄우려면
        // tracking 쪽이어야 한다 — 관심종목 화면이 쓰는 것과 같은 응답이라 서버가 이미 캐싱한다
        const res = await api.watchlistTracking();
        next = res.items.map((i) => ({
          code: i.code,
          name: i.name,
          price: i.price,
          changeRate: i.changeRate,
          tradeValue: null,
        }));
      } else {
        const runs = (await api.signalScreenRuns()).runs;
        if (runs.length === 0) {
          setList([]);
          setListError("신호등 찾기를 아직 돌린 적이 없습니다. 「신호등 찾기」에서 먼저 실행하세요.");
          return;
        }
        const run = await api.signalScreenRun(runs[0].id);
        next = run.results.map((h: ScreenHit) => ({
          code: h.code,
          name: h.name,
          price: h.price,
          changeRate: h.changeRate,
          tradeValue: Math.round(h.tradeValue / 100),
          score: h.score,
        }));
      }
      setList(next);
      // 목록이 바뀌면 처음부터 — 예전 자리 번호를 그대로 두면 엉뚱한 종목이 뜬다
      setIndex(0);
    } catch (err) {
      setListError(err instanceof Error ? err.message : "목록을 불러오지 못했습니다");
      setList([]);
    } finally {
      setListLoading(false);
    }
  }, [source, market]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  /* ---------------- 넘기기 ---------------- */

  /**
   * 자리를 옮기고 **연동만 보낸다.**
   *
   * 보드를 띄워 놓고 여기서 화살표로 훑으면 보드도 같이 따라와야 한다 —
   * 이 화면을 쓰는 방식이 바로 그 훑기니까. 하지만 따라오게 하려고 상세 모달까지
   * 열 이유는 없다. 연동이 꺼져 있으면 `publish` 는 아무 일도 하지 않는다.
   */
  const goIndex = useCallback(
    (n: number) => {
      const hit = list[n];
      if (!hit) return;
      setIndex(n);
      setListOpen(false);
      focus.publish(hit.code, hit.name);
    },
    [list, focus],
  );

  const move = useCallback(
    (delta: number) => {
      goIndex(index + delta);
    },
    [goIndex, index],
  );

  /*
   * 방향키로 넘긴다. 훑는 도구라 손이 마우스를 떠나지 않는 게 낫다.
   * 입력칸에 있을 때는 가로채면 안 된다 — 검색어에 커서를 옮기지 못하게 된다.
   */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el?.isContentEditable) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        move(-1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        move(1);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [move]);

  /* ---------------- 현재 종목 ---------------- */

  const { data: info } = useLive<RawRecord>(
    () => (code ? (api.stockInfo(code) as Promise<RawRecord>) : Promise.resolve({} as RawRecord)),
    [code],
    10_000,
  );

  const [signal, setSignal] = useState<SignalResult | null>(null);
  useEffect(() => {
    if (!code) return;
    let alive = true;
    setSignal(null);
    api
      .signal(code)
      .then((s) => alive && setSignal(s))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [code]);

  /*
   * 다음 종목 신호등을 미리 받아 둔다.
   *
   * 서버가 신호등을 15분 캐싱하므로, 넘기기 전에 한 번 불러 두면 넘긴 순간 바로 뜬다.
   * 넘기는 게 이 화면의 본체라 그 한 박자가 크다. 다만 **다음 하나만** —
   * 앞뒤로 다섯씩 당겨 두면 훑지도 않은 종목을 백 개 평가하게 된다.
   * 1.5초를 기다리는 건 빠르게 연타할 때 지나가는 종목까지 부르지 않으려는 것이다.
   */
  useEffect(() => {
    const next = list[index + 1];
    if (!next) return;
    const timer = setTimeout(() => {
      api.signal(next.code).catch(() => undefined);
    }, 1500);
    return () => clearTimeout(timer);
  }, [list, index]);

  /*
   * 투자자 수급은 여기서 안 받는다 (2026-09-01).
   * `StockTabsSection` 이 「투자자 수급」 탭을 고를 때만 받는다 — 여기서 미리
   * 받아 두면 그 탭을 안 보는 종목까지 조회가 나간다.
   */

  /* ---------------- 검색 ---------------- */

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      return;
    }
    const timer = setTimeout(() => {
      api
        .searchStocks(q)
        .then((r) => setResults(r.results))
        .catch(() => setResults([]));
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  /**
   * 목록 밖 종목으로 **이 화면 안에서** 갈아탄다.
   *
   * 검색 결과와, 탭 안에서 누른 종목(업종·테마 구성종목, 담은 ETF, 신호등의 비슷한
   * 종목)이 다 이리로 온다. 따로 띄우면 넘기기가 안 먹어서 이 화면의 본체가 죽는다.
   * 목록에 없으면 맨 앞에 끼워 넣어 자리를 만든다 — 그래야 넘기기 바의
   * 「n / 전체」와 방향키가 계속 말이 된다.
   */
  const goStock = useCallback(
    (rawCode: string, name: string) => {
      const c = normalizeStockCode(rawCode);
      if (!c) return;
      const at = list.findIndex((i) => i.code === c);
      if (at >= 0) {
        goIndex(at);
        return;
      }
      setList((prev) => [{ code: c, name, price: 0, changeRate: 0, tradeValue: null }, ...prev]);
      setIndex(0);
      setListOpen(false);
      focus.publish(c, name);
    },
    [list, goIndex, focus],
  );

  function jumpTo(r: StockSearchResult) {
    setQuery("");
    setResults([]);
    goStock(r.code, r.name);
  }

  return (
    <div className="sd-page">
      {/* ---------------- 모집단 고르기 ---------------- */}
      {/* 폰 — 모집단 칩이 두 줄로 쌓인다. 한 줄 가로 스크롤 (2026-08-28) */}
      <div className="filter-row ctl-ribbon">
        {SOURCES.map((s) => (
          <button
            key={s.key}
            className={`filter-btn ${source === s.key ? "active" : ""}`}
            title={s.hint}
            onClick={() => setSource(s.key)}
          >
            {s.label}
          </button>
        ))}
        {source === "volume" &&
          MARKETS.map((m) => (
            <button
              key={m.key}
              className={`filter-btn ${market === m.key ? "active" : ""}`}
              onClick={() => setMarket(m.key)}
            >
              {m.label}
            </button>
          ))}
        <button className="filter-btn" onClick={() => void loadList()} disabled={listLoading}>
          {listLoading ? "불러오는 중..." : "↻ 목록 갱신"}
        </button>
      </div>

      {listError && <div className="error-banner">{listError}</div>}

      {/* ---------------- 넘기기 바 (붙박이) ---------------- */}
      <div className="sd-nav">
        <button className="sd-move" onClick={() => move(-1)} disabled={index <= 0} title="이전 종목 (←)">
          ◀
        </button>

        <button className="sd-cur" onClick={() => setListOpen((v) => !v)} title="목록에서 고르기">
          <span className="sd-pos">
            {list.length === 0 ? "0 / 0" : `${index + 1} / ${list.length}`}
          </span>
          <span className="sd-name">{current?.name ?? "종목 없음"}</span>
          {current && current.price > 0 && (
            <span className={`sd-rate ${signClass(current.changeRate)}`}>
              {fmtNum(current.price)} {current.changeRate > 0 ? "+" : ""}
              {current.changeRate.toFixed(2)}%
            </span>
          )}
          <span className="sd-caret">{listOpen ? "▲" : "▼"}</span>
        </button>

        <button
          className="sd-move"
          onClick={() => move(1)}
          disabled={index >= list.length - 1}
          title="다음 종목 (→)"
        >
          ▶
        </button>
      </div>

      {listOpen && (
        <ListPanel
          list={list}
          index={index}
          withSignals={listSignals}
          onToggleSignals={() => setListSignals((v) => !v)}
          onPick={goIndex}
        />
      )}

      <div className="search-box sd-search">
        <input
          className="search-input"
          type="text"
          inputMode="search"
          placeholder="목록에 없는 종목 찾기 (초성도 됩니다)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {query.trim() && results.length > 0 && (
          <div className="search-dropdown">
            {results.map((r) => (
              <button key={r.code} className="search-result-row" onClick={() => jumpTo(r)}>
                <span className="name">{r.name}</span>
                <span className="sub">
                  {r.code} · {r.marketName}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {!code && !listLoading && (
        <div className="page-note">
          목록이 비어 있습니다. 위에서 모집단을 고르거나 종목을 검색하세요.
        </div>
      )}

      {code && (
        <>
          {/* ---------------- 종목 머리 ---------------- */}
          <section className="card sd-head">
            <div className="sd-head-top">
              <WatchStar code={code} />
<SuperMark code={code} />
              <PriceHeader info={info} code={code} />
              <div className="sd-head-actions">
                {signal && (
                  <span className={`sd-badge ${signal.level}`} title="신호등 — 자세한 것은 아래 「신호등」 탭">
                    신호등 {signal.score}점
                  </span>
                )}
                {/*
                  ⚠️ 왼쪽 `WatchStar` 는 **표시 전용**이라 담긴 종목에만 별이 찬다.
                  거르는 자리에서 담지 못하면 거르는 뜻이 없어서, 담는 버튼을 따로 둔다.
                */}
                <WatchButton
                  code={code}
                  name={current?.name ?? ""}
                  price={Math.abs(Number(current?.price ?? 0)) || 0}
                />
              </div>
            </div>
          </section>

          {/*
            ---------------- 개별종목분석 본문 ----------------

            **개별종목분석과 똑같은 것을 여기 그대로 편다** (2026-09-01 벤티지:
            "종목발굴에서 종목 옮겨가면 그 밑에 개별종목분석 내용 나오게 해달라고
            한거잖아").

            예전엔 여기에 열두 블록을 격자로 깔았다. 그런데 그 블록들은 개별종목분석
            탭들과 **같은 컴포넌트를 두 번째로 배치한 것**이었다 — 차트·수급·재무·호가가
            양쪽에 따로 있어, 한쪽에 기능이 붙으면 다른 쪽은 낡아 갔다.
            (`StockTabsSection` 을 만들며 시트와 분석 화면을 합친 것과 같은 이유다.)

            이제 종목발굴은 **넘기기 바 + 개별종목분석**이다. 위의 붙박이 바로 넘기고,
            아래는 늘 보던 그 화면이다. 넘겨도 `code` 만 갈리므로 보고 있던 탭이 유지된다 —
            「수급만 훑는다」가 그대로 된다.
          */}
          <IntradayLevelsBar code={code} />
          <StockSummaryPanel code={code} />
          <StockTabsSection
            code={code}
            name={current?.name ?? ""}
            info={info}
            onSelectStock={goStock}
          />

          <div className="table-note sd-foot">
            ← → 방향키로 앞뒤 종목을 넘길 수 있습니다 · 넘겨도 <b>보던 탭이 그대로 유지</b>됩니다 ·
            목록 위치는 모집단을 바꾸면 처음으로 돌아갑니다
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function ListPanel({
  list,
  index,
  withSignals,
  onToggleSignals,
  onPick,
}: {
  list: Candidate[];
  index: number;
  withSignals: boolean;
  onToggleSignals: () => void;
  onPick: (i: number) => void;
}) {
  /*
   * 신호등은 켰을 때만 부른다. 백 종목을 한 번에 평가하면 서버가 종목마다
   * 여러 번 조회하므로 한참 걸린다 — 그걸 모르고 기다리게 두면 화면이 멈춘 걸로 보인다.
   * 켜도 앞의 40 개까지만 — 그 아래는 어차피 스크롤해서 볼 때 다시 판단하면 된다.
   */
  const codes = useMemo(
    () => (withSignals ? list.slice(0, 40).map((c) => c.code) : []),
    [withSignals, list],
  );
  const signals = useSignals(codes);

  const activeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [index]);

  /* 머리줄에 적을 열을 정한다 — 한 줄이라도 값이 있으면 그 열은 쓰이는 것이다 */
  const hasPrice = list.some((c) => c.price > 0);
  const hasAmt = list.some((c) => c.tradeValue !== null);
  const hasScore = list.some((c) => c.score !== undefined);

  return (
    <section className="card sd-list">
      <div className="sd-list-head">
        <span className="pt-n">{list.length}종목</span>
        <button className={`filter-btn ${withSignals ? "active" : ""}`} onClick={onToggleSignals}>
          신호등 {withSignals ? "끄기" : "켜기"}
        </button>
        {withSignals && <span className="pt-n">앞의 40종목만 · 처음엔 좀 걸립니다</span>}
      </div>
      {/*
        ⚠️ **열 이름 줄.**

        이 목록은 표가 아니라 버튼을 쌓은 것이라 머리줄이 아예 없었다. 그래서
        `186,690억` 이 거래대금인지 시가총액인지 알 방법이 없었다 — 값은 처음부터
        맞았고 **이름이 없던 것**이다. 행과 같은 flex 클래스를 그대로 써서 폭을 맞춘다.

        없는 열은 안 적는다. 조회에 따라 점수나 거래대금이 없는데 이름만 있으면
        빈 칸이 무슨 뜻인지 또 물어야 한다.
      */}
      <div className="sd-list-body">
        {/*
          ⚠️ 머리줄은 **구르는 칸 안에** 둔다.

          밖에 두면 값 행에는 세로 스크롤바가 붙고 머리줄에는 안 붙어서 **스무 남짓
          픽셀이 어긋난다** — 「거래대금」이 등락률 쪽으로 밀려 어느 열 이름인지
          오히려 헷갈린다. 안에 넣고 sticky 로 붙이면 폭이 정확히 같고, 백 종목을
          내려도 이름이 따라온다.
        */}
        {list.length > 0 && (
          <div className="sd-list-row sd-list-cols" aria-hidden>
            <span className="sd-list-rank">#</span>
            {withSignals && <span className="sig-dot" style={{ visibility: "hidden" }} />}
            <span className="sd-list-name">종목</span>
            {hasPrice && (
              <>
                <span className="sd-list-price">현재가</span>
                <span className="sd-list-rate">등락률</span>
              </>
            )}
            {hasAmt && <span className="sd-list-amt">거래대금</span>}
            {hasScore && <span className="sd-list-score">점수</span>}
          </div>
        )}
        {list.map((c, i) => (
          <button
            key={`${c.code}-${i}`}
            ref={i === index ? activeRef : undefined}
            className={`sd-list-row${i === index ? " active" : ""}`}
            onClick={() => onPick(i)}
          >
            <span className="sd-list-rank">{i + 1}</span>
            {withSignals && i < 40 && <SignalDot signal={signals[c.code]} />}
            <span className="sd-list-name" title={c.name}>{c.name}</span>
            {c.price > 0 && (
              <>
                <span className="sd-list-price">{fmtNum(c.price)}</span>
                <span className={`sd-list-rate ${signClass(c.changeRate)}`}>
                  {c.changeRate > 0 ? "+" : ""}
                  {c.changeRate.toFixed(2)}%
                </span>
              </>
            )}
            {c.tradeValue !== null && <span className="sd-list-amt">{fmtNum(c.tradeValue)}억</span>}
            {c.score !== undefined && <span className="sd-list-score">{c.score}점</span>}
          </button>
        ))}
        {list.length === 0 && <div className="empty">목록이 비어 있습니다</div>}
      </div>
    </section>
  );
}
