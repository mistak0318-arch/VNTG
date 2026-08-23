import { useEffect, useState } from "react";
import { removePref, setPref } from "../prefs";
import { api, fmtNum, type RankResult, type RankSpecGroup } from "../api";
import { SameNetTradeRankingPage } from "./SameNetTradeRankingPage";
import { ContinuousTradePage } from "./ContinuousTradePage";
import { TopTradersTable } from "../components/TopTradersTable";
import { CumulativeRank } from "../components/CumulativeRank";

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
 * ## 거래소 토글
 *
 * 키움의 「통합」은 실측하면 KRX 와 같은 값이라, NXT 에서만 급등한 종목은
 * 기본 조회에 아예 안 나온다. 그래서 토글을 남겨 둔다.
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
  { key: "3", label: "통합", hint: "실측상 KRX와 같은 값이 나옵니다" },
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
  /** ETF·ETN·우선주를 뺀다 */
  commonOnly: boolean;
}

const NO_FILTER: Filter = { minTv: 0, caps: [], minRate: null, commonOnly: false };
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
  if (type === "pct") return { text: `${n > 0 ? "+" : ""}${n.toFixed(2)}%`, cls: sign };
  // 가격은 부호로 색을 칠하지 않는다 (음수 표기는 하락을 뜻하는 키움 관행이라 헷갈린다)
  if (type === "price") return { text: fmtNum(Math.abs(n)), cls: "" };
  return { text: fmtNum(n), cls: sign };
}

/**
 * 위에 세울 다섯 — 실제로 보던 것들.
 *
 * `rank` 는 서버 명세를 그리는 기존 machinery 를 그대로 쓴다.
 * `page` 는 이미 따로 있던 화면을 그대로 끼운다 — 같은 표를 두 벌 만들면
 * 한쪽만 고쳐지는 날이 온다.
 */
const TABS = [
  { key: "trade-value", label: "거래대금 상위", kind: "rank" as const },
  { key: "same-net", label: "기관/외국인 동일 순매매", kind: "page" as const },
  { key: "cont", label: "기관/외국인 연속매매", kind: "page" as const },
  { key: "cum", label: "누적등락률 상위", kind: "page" as const },
  { key: "flu-rate", label: "등락률 상위", kind: "rank" as const },
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

  /** 지금 그릴 명세 — 탭이 rank 면 탭 것, 「그 밖에」면 트리에서 고른 것 */
  const current = TABS.find((t) => t.key === tab);
  const rankKey = current?.kind === "rank" ? tab : active;

  useEffect(() => {
    api
      .rankSpecs()
      .then((r) => setGroups(r.groups))
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .rank(rankKey, market, exchange)
      .then((r) => !cancelled && setData(r))
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [rankKey, market, exchange]);

  const cols = data?.spec.columns ?? [];
  const all = data?.rows ?? [];

  /*
   * 거르기. **못 재는 값으로는 안 거른다** — 시가총액이 null 인 종목(상장주식수를
   * 못 찾은 것)을 「조건 미달」로 버리면 조용히 사라진다. 조건을 켠 항목에 대해
   * 값이 없으면 그때만 뺀다.
   */
  const rows = all.filter((r) => {
    if (filter.commonOnly && !r.common) return false;
    if (filter.minTv > 0 && (r.tv === null || r.tv < filter.minTv)) return false;
    if (!capOk(r.cap, filter.caps)) return false;
    if (filter.minRate !== null) {
      const rate = Number(r.flu_rt ?? r.jmp_rt);
      if (!Number.isFinite(rate) || rate < filter.minRate) return false;
    }
    return true;
  });

  const hasCap = all.some((r) => r.cap !== null);
  const estimated = rows.some((r) => r.tvEst);
  const on =
    filter.minTv > 0 || filter.caps.length > 0 || filter.minRate !== null || filter.commonOnly;

  return (
    <div>
      {/* 실제로 보는 다섯이 앞이다 — 트리를 매번 훑지 않게 */}
      <div className="filter-row scr-tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`filter-btn ${tab === t.key ? "active" : ""}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "same-net" && <SameNetTradeRankingPage onSelectStock={onSelectStock ?? (() => {})} />}
      {tab === "cont" && <ContinuousTradePage onSelectStock={onSelectStock ?? (() => {})} />}
      {tab === "top-traders" && <TopTradersTable onSelectStock={onSelectStock} />}
      {tab === "cum" && <CumulativeRank onSelectStock={onSelectStock} />}

      {current?.kind !== "page" && (
        <div className="screener">
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
        <div className="filter-row">
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
          {/* 필터는 접어 둔다 — 늘 펴 두면 표가 화면 밖으로 밀린다 */}
          <button
            className={`filter-btn ${on ? "active" : ""}`}
            onClick={() => setOpenFilter(!openFilter)}
            title="거래대금·시가총액으로 좁혀 봅니다"
          >
            {openFilter ? "필터 ▲" : "필터 ▼"}
            {on ? " ●" : ""}
          </button>
        </div>

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
            <h3 className="section-heading">{data.spec.label}</h3>
            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th className="sticky-col">종목명</th>
                    {cols
                      .filter((c) => c.key !== "stk_nm")
                      .map((c) => (
                        <th key={c.key}>{c.label}</th>
                      ))}
                    {/* 걸러 보는 기준이면 표에도 있어야 한다 */}
                    {hasCap && <th title="상장주식수 × 현재가">시가총액</th>}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={`${r.code}-${i}`}>
                      <td className="sticky-col">
                        <button
                          className="link-btn"
                          onClick={() => onSelectStock?.(r.code, r.name)}
                        >
                          {r.name}
                        </button>
                        {/* 시장이 「전체」면 어느 시장인지가 정보다 */}
                        {market === "000" && r.mkt && <i className="scr-mkt">{r.mkt}</i>}
                      </td>
                      {cols
                        .filter((c) => c.key !== "stk_nm")
                        .map((c) => {
                          const v = cell(r[c.key], c.type);
                          return (
                            <td key={c.key} className={`num ${v.cls}`}>
                              {v.text}
                            </td>
                          );
                        })}
                      {hasCap && <td className="num pt-n">{eok(r.cap)}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
