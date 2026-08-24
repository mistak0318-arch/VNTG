import { useState } from "react";
import { fmtNum } from "../api";

/**
 * 종목 목록을 **거르는 조건** — 시세분석의 모든 탭이 같이 쓴다.
 *
 * ## 왜 공통인가
 *
 * 거래대금 상위에만 필터를 달아 뒀더니, 같은 화면에서 탭만 바꿨는데 **어떤 탭은 걸리고
 * 어떤 탭은 안 걸리는** 화면이 됐다. 조건은 화면에 남는 값이라(다음에 열어도 그대로)
 * 탭을 옮겨도 따라와야 맞다.
 *
 * ## 못 내는 값으로는 거르지 않는다
 *
 * 조회마다 주는 값이 다르다 — 연속매매는 거래량을 안 줘서 회전율을 못 낸다. 그때 그
 * 조건을 그대로 적용하면 **전부 걸러져 빈 표**가 뜨고 이유는 화면 어디에도 없다.
 * 낼 수 없는 항목은 그 조회에서만 쉬고, 쉬고 있다는 걸 화면에 적는다.
 */

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


export interface FilterCapable {
  cap: number | null;
  tv: number | null;
  turn: number | null;
  common?: boolean;
  [k: string]: unknown;
}

export interface StockFilterState {
  filter: Filter;
  set: (patch: Partial<Filter>) => void;
  /** 하나라도 켜져 있나 */
  on: boolean;
  /** 이 목록이 낼 수 있는 값들 */
  has: { cap: boolean; tv: boolean; turn: boolean; rate: boolean };
  /** 거르기 — 낼 수 없는 값은 건너뛴다 */
  keep: (r: FilterCapable) => boolean;
  /** 쉬고 있는 조건 이름들 */
  idle: string[];
}

export function useStockFilter(rows: FilterCapable[], rateOf?: (r: FilterCapable) => number): StockFilterState {
  const [filter, setFilter] = useState<Filter>(loadFilter);

  const set = (patch: Partial<Filter>) => {
    setFilter((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem(FILTER_KEY, JSON.stringify(next));
      } catch {
        /* 저장 못 해도 이번 세션에는 걸린다 */
      }
      return next;
    });
  };

  const has = {
    cap: rows.some((r) => r.cap !== null),
    tv: rows.some((r) => r.tv !== null),
    turn: rows.some((r) => r.turn !== null),
    rate: Boolean(rateOf) && rows.some((r) => Number.isFinite(rateOf!(r))),
  };

  const keep = (r: FilterCapable): boolean => {
    if (filter.commonOnly && r.common === false) return false;
    if (has.tv && filter.minTv > 0 && (r.tv === null || r.tv < filter.minTv)) return false;
    if (has.cap && !capOk(r.cap, filter.caps)) return false;
    if (has.turn && filter.minTurn !== null && (r.turn === null || r.turn < filter.minTurn)) {
      return false;
    }
    if (has.rate && filter.minRate !== null && rateOf) {
      const v = rateOf(r);
      if (!Number.isFinite(v) || v < filter.minRate) return false;
    }
    return true;
  };

  const idle: string[] = [];
  if (!has.tv && filter.minTv > 0) idle.push("거래대금");
  if (!has.turn && filter.minTurn !== null) idle.push("회전율");
  if (!has.cap && filter.caps.length > 0) idle.push("시가총액");
  if (!has.rate && filter.minRate !== null) idle.push("등락률");

  return {
    filter,
    set,
    on:
      filter.minTv > 0 ||
      filter.caps.length > 0 ||
      filter.minRate !== null ||
      filter.minTurn !== null ||
      filter.commonOnly,
    has,
    keep,
    idle,
  };
}

/** 접었다 펴는 필터 줄 — 늘 펴 두면 표가 화면 밖으로 밀린다 */
export function StockFilterBar({ f, open }: { f: StockFilterState; open: boolean }) {
  if (!open) return null;
  const { filter, set, has } = f;
  return (
    <div className="scr-filter">
      <div className="scr-f-row">
        <span className="st-cfg-k">거래대금</span>
        {TV_CHIPS.map((v) => (
          <button
            key={v}
            className={`filter-btn ${filter.minTv === v ? "active" : ""}`}
            onClick={() => set({ minTv: v })}
            disabled={!has.tv}
          >
            {v === 0 ? "전체" : `${fmtNum(v)}억↑`}
          </button>
        ))}
        {!has.tv && <span className="pt-n">이 조회는 거래대금을 안 줍니다</span>}
      </div>

      <div className="scr-f-row">
        <span className="st-cfg-k">시가총액</span>
        {/* 여기만 복수 선택 — 구간이 안 겹쳐서 「또는」이 뜻을 갖는다 */}
        <button
          className={`filter-btn ${filter.caps.length === 0 ? "active" : ""}`}
          onClick={() => set({ caps: [] })}
          disabled={!has.cap}
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
            disabled={!has.cap}
            title="여러 구간을 같이 고를 수 있습니다"
          >
            {c.label}
          </button>
        ))}
      </div>

      <div className="scr-f-row">
        <span className="st-cfg-k">회전율</span>
        {[null, 1, 3, 5, 10, 20].map((v) => (
          <button
            key={String(v)}
            className={`filter-btn ${filter.minTurn === v ? "active" : ""}`}
            onClick={() => set({ minTurn: v })}
            disabled={!has.turn}
            title={v === null ? undefined : `상장주식의 ${v}% 이상이 오늘 손바뀜한 종목`}
          >
            {v === null ? "전체" : `${v}%↑`}
          </button>
        ))}
        {!has.turn && <span className="pt-n">거래량을 안 줘서 못 냅니다</span>}
      </div>

      <div className="scr-f-row">
        <span className="st-cfg-k">등락률</span>
        {[null, 0, 3, 5, 10].map((v) => (
          <button
            key={String(v)}
            className={`filter-btn ${filter.minRate === v ? "active" : ""}`}
            onClick={() => set({ minRate: v })}
            disabled={!has.rate}
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
        {f.on && (
          <button className="filter-btn" onClick={() => set(NO_FILTER)}>
            초기화
          </button>
        )}
      </div>
    </div>
  );
}

/** 필터를 여닫는 버튼 + 쉬고 있는 조건 알림 */
export function StockFilterToggle({
  f,
  open,
  onToggle,
}: {
  f: StockFilterState;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <button
        className={`filter-btn ${f.on ? "active" : ""}`}
        onClick={onToggle}
        title="거래대금·시가총액으로 좁혀 봅니다"
      >
        {open ? "필터 ▲" : "필터 ▼"}
        {f.on ? " ●" : ""}
      </button>
      {f.idle.length > 0 && (
        <span className="scr-idle" title="이 조회는 그 값을 주지 않습니다">
          {f.idle.join("·")} 필터는 쉽니다
        </span>
      )}
    </>
  );
}
