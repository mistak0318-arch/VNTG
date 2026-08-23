import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { removePref, setPref } from "../prefs";
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
import { ChartPanel } from "../components/ChartPanel";
import { FinancePanel } from "../components/FinancePanel";
import { InvestorTrendTable } from "../components/InvestorTrendTable";
import { OpinionPanel } from "../components/OpinionPanel";
import { PriceHeader } from "../components/PriceHeader";
import { SectorMoodPanel } from "../components/SectorMoodPanel";
import { SignalPanel, useSignals, SignalDot } from "../components/SignalLight";
import { OrderBookPanel } from "../components/OrderBookPanel";
import { BrokerFlowPanel } from "../components/BrokerFlowPanel";
import { StockNotes } from "../components/StockNotes";
import { SupplyDetailPanel } from "../components/SupplyDetailPanel";
import { TradeSizePanel } from "../components/TradeSizePanel";
import { useLive } from "../useLive";
import { WatchStar } from "../useWatchedCodes";

/**
 * 종목발굴.
 *
 * 키움 HTS 에서 창을 열두 개 띄워 놓고 한 종목을 훑던 걸 한 화면으로 옮긴 자리다.
 * 「개별종목분석」과 다른 점은 **탭이 없다**는 것 — 거기는 한 번에 하나씩 보지만
 * 여기는 펼쳐 놓고 위에서 아래로 훑는다.
 *
 * 그리고 이 화면의 중심은 종목 하나가 아니라 **넘기기**다.
 * 검색해서 들어오는 게 아니라 거래대금 상위 100 을 ← → 로 넘겨 가며 고른다.
 * 그래서 넘기는 바를 화면에 붙박아 두고 방향키까지 받는다.
 *
 * ## 부하
 *
 * 한 종목을 다 펼치면 API 가 열 번 넘게 나간다. 넘기면서 보는 도구라 그게 곧 부하다.
 * 세 가지로 막는다 —
 *   1. **화면에 들어온 블록만 부른다** (`LazyBlock`). 모바일에서는 처음에 두어 개만 뜬다.
 *   2. **간단히 보기**가 기본이다. 네 블록만 켜고 시작한다.
 *   3. 블록별로 끌 수 있고 그 선택을 기억한다.
 * 목록의 신호등도 기본은 꺼 둔다 — 백 종목을 평가하면 서버가 한참 걸린다.
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

/* ------------------------------------------------------------------ */
/* 블록                                                                */
/* ------------------------------------------------------------------ */

type BlockKey =
  | "chart"
  | "signal"
  | "opinion"
  | "investor"
  | "supply"
  | "tradeSize"
  | "finance"
  | "sector"
  | "quote"
  | "broker"
  | "notes";

const BLOCKS: {
  key: BlockKey;
  label: string;
  /** 격자 전체 폭을 차지한다 — 표가 넓거나 차트라서 좁으면 못 읽는 것들 */
  wide?: boolean;
  /** 간단히 보기에 들어가는 넷 */
  basic?: boolean;
}[] = [
  // 신호등이 맨 위다. 차트보다 먼저 본다 — 볼 만한 종목인지부터 갈라야
  // 나머지를 들여다볼지 정할 수 있다. 넘기며 훑을 때 이 순서가 특히 중요하다
  { key: "signal", label: "신호등", wide: true, basic: true },
  { key: "chart", label: "차트", wide: true, basic: true },
  { key: "opinion", label: "목표주가·투자의견", basic: true },
  // 기간 상승률은 블록으로 두지 않는다 — PriceHeader 가 이미 들고 있어 두 번 나온다
  { key: "investor", label: "투자자별 매매동향", wide: true, basic: true },
  { key: "supply", label: "공매도·대차잔고" },
  { key: "tradeSize", label: "체결금액대별 매매비중" },
  { key: "finance", label: "재무" },
  { key: "sector", label: "업종·테마" },
  { key: "quote", label: "호가" },
  { key: "broker", label: "거래원" },
  { key: "notes", label: "메모", wide: true },
];

const BASIC_KEYS = BLOCKS.filter((b) => b.basic).map((b) => b.key);
const PREF_KEY = "vntg.discovery.blocks";

function loadBlockPref(): BlockKey[] {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (!raw) return BASIC_KEYS;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return BASIC_KEYS;
    // 블록 이름이 바뀌었을 수 있으니 지금 있는 것만 남긴다
    const valid = parsed.filter((k): k is BlockKey => BLOCKS.some((b) => b.key === k));
    return valid.length > 0 ? valid : BASIC_KEYS;
  } catch {
    return BASIC_KEYS;
  }
}

/** 화면에 닿기 이만큼 전에 미리 부른다 — 스크롤이 멈추고 나서 뜨면 늦다 */
const PRELOAD_PX = 300;

/**
 * 화면에 들어올 때까지 자식을 만들지 않는다.
 *
 * 블록마다 자기 API 를 부르므로 **마운트 자체가 호출**이다. 한 번 보이면 계속 둔다 —
 * 스크롤을 올렸다 내렸다 할 때마다 다시 부르면 그게 더 나쁘다.
 *
 * IntersectionObserver 를 쓰지 않는다. 그게 정석이지만 **콜백이 안 오는 환경이 있다** —
 * 화면을 그리지 않는 탭에서 그렇다. 안 오면 블록이 영영 자리만 차지한 채 남는다.
 * 자리를 직접 재면 어디서든 같은 답이 나온다.
 *
 * 묶는 데에 requestAnimationFrame 도 쓰지 않는다. 같은 이유로 굶는다 — 그리지 않는 탭에서는
 * 프레임이 안 오므로 콜백도 안 온다. 타이머는 그리든 말든 돈다.
 */
function LazyBlock({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (shown) return;
    let timer = 0;

    function check() {
      timer = 0;
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      if (r.top < window.innerHeight + PRELOAD_PX && r.bottom > -PRELOAD_PX) setShown(true);
    }

    function onScroll() {
      // 스크롤은 한 번 움직일 때 수십 번 온다. 100ms 에 한 번만 잰다
      if (timer === 0) timer = window.setTimeout(check, 100);
    }

    check();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      if (timer !== 0) clearTimeout(timer);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [shown]);

  return (
    <div ref={ref} className="sd-lazy">
      {shown ? children : <div className="sd-placeholder">스크롤하면 불러옵니다</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ */

export function StockDiscoveryPage({
  onSelectStock,
}: {
  /** 「개별종목분석」으로 넘겨 더 깊게 보고 싶을 때 */
  onSelectStock: (code: string, name: string) => void;
}) {
  const [source, setSource] = useState<SourceKey>("volume");
  const [market, setMarket] = useState("000");
  const [list, setList] = useState<Candidate[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [listOpen, setListOpen] = useState(false);
  /** 목록 신호등 — 백 종목 평가는 무거워서 기본은 꺼 둔다 */
  const [listSignals, setListSignals] = useState(false);
  const [blocks, setBlocks] = useState<BlockKey[]>(loadBlockPref);
  const [blockPanel, setBlockPanel] = useState(false);

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

  /*
   * ⚠️ **넘길 때도 연동을 보낸다.**
   *
   * 종목을 눌러서 고르는 길(`onSelectStock`)에는 연동이 붙어 있었는데, **화살표로
   * 넘기는 길에는 없었다.** 그래서 보드를 띄워 놓고 여기서 화살표로 훑으면
   * 보드는 처음 종목에 멈춰 있었다 — 이 화면을 쓰는 방식이 바로 그 훑기인데.
   *
   * 목록에서 고르는 것(`setIndex`)도 같은 길로 보낸다.
   */
  const move = useCallback(
    (delta: number) => {
      setIndex((i) => {
        const n = i + delta;
        if (n < 0 || n >= list.length) return i;
        const hit = list[n];
        if (hit) onSelectStock(hit.code, hit.name);
        return n;
      });
      setListOpen(false);
    },
    [list, onSelectStock],
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

  const [investorRows, setInvestorRows] = useState<RawRecord[]>([]);
  useEffect(() => {
    if (!code || !blocks.includes("investor")) return;
    let alive = true;
    setInvestorRows([]);
    api
      .investorChart(code)
      .then((r) => alive && setInvestorRows(pickList(r as RawRecord, ["stk_invsr_orgn_chart"])))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [code, blocks]);

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
   * 검색해서 고른 종목은 **목록 맨 앞에 끼워 넣는다.**
   * 따로 띄우면 넘기기가 안 먹어서 이 화면의 본체가 죽는다.
   */
  function jumpTo(r: StockSearchResult) {
    const c = normalizeStockCode(r.code);
    setQuery("");
    setResults([]);
    const at = list.findIndex((i) => i.code === c);
    if (at >= 0) {
      setIndex(at);
      return;
    }
    setList((prev) => [{ code: c, name: r.name, price: 0, changeRate: 0, tradeValue: null }, ...prev]);
    setIndex(0);
  }

  /* ---------------- 블록 설정 ---------------- */

  function toggleBlock(key: BlockKey) {
    setBlocks((prev) => {
      const next = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key];
      setPref(PREF_KEY, JSON.stringify(next));
      return next;
    });
  }

  function setPreset(keys: BlockKey[]) {
    setBlocks(keys);
    setPref(PREF_KEY, JSON.stringify(keys));
  }

  const shown = BLOCKS.filter((b) => blocks.includes(b.key));
  const allKeys = BLOCKS.map((b) => b.key);
  const isBasic = blocks.length === BASIC_KEYS.length && BASIC_KEYS.every((k) => blocks.includes(k));
  const isAll = blocks.length === allKeys.length;

  return (
    <div className="sd-page">
      {/* ---------------- 모집단 고르기 ---------------- */}
      <div className="filter-row">
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
          onPick={(i) => {
            setIndex(i);
            // 목록에서 고르는 것도 연동으로 내보낸다
            if (list[i]) onSelectStock(list[i].code, list[i].name);
            setListOpen(false);
          }}
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
              <PriceHeader info={info} code={code} />
              <div className="sd-head-actions">
                {signal && (
                  <span className={`sd-badge ${signal.level}`} title="신호등 — 자세한 것은 아래 블록">
                    신호등 {signal.score}점
                  </span>
                )}
                <button className="filter-btn" onClick={() => onSelectStock(code, current?.name ?? "")}>
                  개별종목분석으로
                </button>
              </div>
            </div>
          </section>

          {/* ---------------- 블록 설정 ---------------- */}
          <div className="filter-row sd-preset">
            <button
              className={`filter-btn ${isBasic ? "active" : ""}`}
              onClick={() => setPreset(BASIC_KEYS)}
              title="차트·신호등·목표주가·수급 넷만 — 넘겨 가며 훑을 때"
            >
              간단히
            </button>
            <button
              className={`filter-btn ${isAll ? "active" : ""}`}
              onClick={() => setPreset(allKeys)}
              title="열두 블록 전부 — 한 종목을 파고들 때"
            >
              전체
            </button>
            <button className="filter-btn" onClick={() => setBlockPanel((v) => !v)}>
              블록 고르기 ({blocks.length}/{allKeys.length}) {blockPanel ? "▲" : "▼"}
            </button>
          </div>

          {blockPanel && (
            <section className="card sd-blockpick">
              <div className="mg-picker">
                {BLOCKS.map((b) => {
                  const on = blocks.includes(b.key);
                  return (
                    <button
                      key={b.key}
                      className={`mg-chip${on ? " on" : ""}`}
                      onClick={() => toggleBlock(b.key)}
                    >
                      {on ? "☑" : "☐"} {b.label}
                    </button>
                  );
                })}
              </div>
              <div className="table-note">
                끈 블록은 조회도 하지 않습니다. 켠 블록도 <b>화면에 들어올 때</b> 부릅니다 —
                한 종목을 전부 펼치면 API 가 열 번 넘게 나갑니다.
              </div>
            </section>
          )}

          {/* ---------------- 블록 격자 ---------------- */}
          <div className="sd-grid">
            {shown.map((b) => (
              <section key={b.key} className={`card sd-block${b.wide ? " wide" : ""}`}>
                <h2>{b.label}</h2>
                <LazyBlock>
                  <BlockBody
                    blockKey={b.key}
                    code={code}
                    name={current?.name ?? ""}
                    price={Math.abs(Number(String(info?.cur_prc ?? "").replace(/[+,]/g, ""))) || undefined}
                    investorRows={investorRows}
                    onSelectStock={onSelectStock}
                  />
                </LazyBlock>
              </section>
            ))}
          </div>

          <div className="table-note sd-foot">
            ← → 방향키로 앞뒤 종목을 넘길 수 있습니다 · 목록 위치는 모집단을 바꾸면 처음으로 돌아갑니다
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function BlockBody({
  blockKey,
  code,
  name,
  price,
  investorRows,
  onSelectStock,
}: {
  blockKey: BlockKey;
  code: string;
  name: string;
  price?: number;
  investorRows: RawRecord[];
  onSelectStock: (code: string, name: string) => void;
}) {
  switch (blockKey) {
    case "chart":
      return <ChartPanel code={code} name={name} />;
    case "signal":
      return <SignalPanel code={code} onSelectStock={onSelectStock} />;
    case "opinion":
      return <OpinionPanel code={code} />;
    case "investor":
      return investorRows.length > 0 ? (
        <InvestorTrendTable rows={investorRows} />
      ) : (
        <div className="empty">불러오는 중...</div>
      );
    case "supply":
      return <SupplyDetailPanel code={code} />;
    case "tradeSize":
      return <TradeSizePanel code={code} />;
    case "finance":
      return <FinancePanel code={code} />;
    case "sector":
      return <SectorMoodPanel code={code} onSelectStock={onSelectStock} />;
    case "quote":
      return <OrderBookPanel code={code} />;
    case "broker":
      return <BrokerFlowPanel code={code} />;
    case "notes":
      return <StockNotes code={code} name={name} currentPrice={price} />;
    default:
      return null;
  }
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

  return (
    <section className="card sd-list">
      <div className="sd-list-head">
        <span className="pt-n">{list.length}종목</span>
        <button className={`filter-btn ${withSignals ? "active" : ""}`} onClick={onToggleSignals}>
          신호등 {withSignals ? "끄기" : "켜기"}
        </button>
        {withSignals && <span className="pt-n">앞의 40종목만 · 처음엔 좀 걸립니다</span>}
      </div>
      <div className="sd-list-body">
        {list.map((c, i) => (
          <button
            key={`${c.code}-${i}`}
            ref={i === index ? activeRef : undefined}
            className={`sd-list-row${i === index ? " active" : ""}`}
            onClick={() => onPick(i)}
          >
            <span className="sd-list-rank">{i + 1}</span>
            {withSignals && i < 40 && <SignalDot signal={signals[c.code]} />}
            <span className="sd-list-name">{c.name}</span>
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
