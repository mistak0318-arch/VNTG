import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { setPref } from "../prefs";
import { NotifySoundPanel } from "../components/NotifySoundPanel";
import { NumPad, PatternPad } from "../components/EntryPads";
import {
  api,
  fmtNum,
  normalizeStockCode,
  signClass,
  type CancelTicket,
  type ModifyTicket,
  type OrderAccount,
  type OrderHolding,
  type Position,
  type PositionsView,
  type LedgerView,
  type LedgerPeriodRow,
  type BuyPower,
  type OrderLogRow,
  type OrderRow,
  type AutoWatch,
  type WatchBasis,
  type WatchExec,
  type WatchLeg,
  type WatchSpec,
  type AccessAudit,
  type OrderDevice,
  type OrderGuard,
  type OrderSettings,
  type OrderStatus,
  type OrderTicket,
  type OrderVenue,
  type TradeType,
  fmtKst,
} from "../api";
import { OrderBookPanel } from "../components/OrderBookPanel";
import { StockSearchBox } from "../components/StockSearchBox";
import { latestStock } from "../useRecentStocks";
import { LiveDot } from "../components/LiveDot";
import { StockPeek } from "../components/StockPeek";

/**
 * 주문 (2026-09-03) — 벤티지: "주문 메뉴 들어갈 때는 아이디랑 비밀번호를 한 번 더,
 * 그 세션을 유지하는 동안. 주문 걸 때도 비밀번호 한 번 더. 대신 자동주문은 아니어야겠지."
 *
 * ## 이 화면의 규칙 — 다른 화면과 다르다
 *
 * 1. **남이 쓴 글자를 안 그린다.** 뉴스·텔레그램·공시는 이 화면에 없다. 주문 버튼과
 *    같은 문서 안에 남의 콘텐츠가 있으면 그게 곧 XSS 로 주문을 누르는 길이다.
 * 2. **문이 셋이다.** 앱 로그인(이미 지남) → 주문 메뉴 열기(아이디·비밀번호 재입력,
 *    세션 10분) → 주문 실행마다 주문 비밀번호. 셋은 서로 다른 비밀번호다.
 * 3. **한 번에 안 나간다.** 주문서(prepare, 30초)를 받아 **금액을 눈으로 확인**한 뒤에야
 *    실행(execute)이 있다. 더블클릭은 두 번째가 만료로 죽는다.
 * 4. **자동은 없다.** 이 화면에서 사람이 누르는 것 말고 주문이 나가는 길은 서버에 없다.
 *
 * 시간이 남았는지·모의인지 실전인지는 **머리띠에 상시** 붙는다. 헷갈리는 순간이 사고다.
 */

/*
 * 거래소 — **통합이 먼저** (2026-09-04, 벤티지: "통합 · KRX · NXT 이 순으로 나와 줘야지").
 *
 * 통합(SOR)은 키움이 두 시장을 보고 더 좋은 쪽으로 보내는 것이라 **기본으로 고를 만한 것이
 * 맨 앞**에 있어야 한다. 「그때 열려 있는 곳」 설정도 이 차례로 훑으므로 통합이 먼저 잡힌다.
 */
const VENUES: { key: OrderVenue; label: string; hint: string }[] = [
  { key: "SOR", label: "통합(SOR)", hint: "키움이 KRX·NXT 중 더 좋은 쪽으로 보낸다" },
  { key: "KRX", label: "KRX", hint: "정규장 08:30~15:30" },
  { key: "NXT", label: "NXT", hint: "프리 08:00 · 메인 09:00~15:20 · 애프터 ~20:00" },
];

/*
 * 탭 넷 (2026-09-07 밤, 개편 ④) — 벤티지: "니가 나라면 어떻게 개편하라고 할래?" → "가자."
 * 여덟 탭(매수·매도 / 자동감시 / 감시 히스토리 / 미체결 / 체결 / 잔고 / 기록 / 설정)을 사람이 실제로 하는
 * 세 가지로 접었다: **사고(주문) · 출구를 걸고 상태를 보고(포지션) · 지난 일을 본다(기록)**. 설정은 톱니.
 * 포지션 탭이 잔고·자동감시·미체결·체결을 종목 카드 하나로 합친다.
 */
type Sub = "order" | "positions" | "ledger" | "history" | "config";

/*
 * 설정 절 접기 (2026-09-08 — 벤티지 "설정의 메뉴들 너무 기니깐 접었다가 펼 수 있게. 기본은 모두 접음").
 * 절이 아홉 개고 컴포넌트가 넷으로 갈라져 있어 상태를 모듈에 둔다. 펼친 것만 기억한다(기기별).
 */
const CFG_FOLD_KEY = "vntg.order.cfgOpen";
let cfgOpenSet: Set<string> = (() => {
  try {
    return new Set(JSON.parse(localStorage.getItem(CFG_FOLD_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
})();
const cfgFoldSubs = new Set<() => void>();
function useCfgFold(): { open: (id: string) => boolean; toggle: (id: string) => void } {
  const [, bump] = useState(0);
  useEffect(() => {
    const f = () => bump((n) => n + 1);
    cfgFoldSubs.add(f);
    return () => {
      cfgFoldSubs.delete(f);
    };
  }, []);
  return {
    open: (id) => cfgOpenSet.has(id),
    toggle: (id) => {
      const next = new Set(cfgOpenSet);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      cfgOpenSet = next;
      try {
        localStorage.setItem(CFG_FOLD_KEY, JSON.stringify([...next]));
      } catch {
        /* 비공개 창 */
      }
      for (const f of cfgFoldSubs) f();
    },
  };
}
/** 절 머리 — 누르면 접힌다 */
function CfgH4({ id, children }: { id: string; children: ReactNode }) {
  const f = useCfgFold();
  return (
    <h4 className="ord-cfg-h4" onClick={() => f.toggle(id)} role="button" aria-expanded={f.open(id)}>
      <i className="ord-cfg-caret">{f.open(id) ? "▾" : "▸"}</i>
      {children}
    </h4>
  );
}
function cfgSecClass(open: boolean): string {
  return `ord-cfg-sec${open ? "" : " folded"}`;
}

/*
 * 탭 차례 (2026-09-08 — 벤티지 "주문 포지션 기록 잔고 설정 이 순서로. 설정에서 바꿀 수도 있게").
 * `vntg.` 로 시작하는 키라 setPref 가 서버에도 올린다 — 기기마다 다르면 손이 헷갈린다.
 */
const SUB_ORDER_KEY = "vntg.order.subOrder";
const SUB_ORDER_DEFAULT: Sub[] = ["order", "positions", "history", "ledger", "config"];
function readSubOrder(): Sub[] {
  try {
    const raw = JSON.parse(localStorage.getItem(SUB_ORDER_KEY) ?? "null") as Sub[] | null;
    if (Array.isArray(raw)) {
      const keep = raw.filter((k) => SUB_ORDER_DEFAULT.includes(k));
      return [...keep, ...SUB_ORDER_DEFAULT.filter((k) => !keep.includes(k))];
    }
  } catch {
    /* 처음 */
  }
  return SUB_ORDER_DEFAULT;
}

const SUBS: { key: Sub; label: string }[] = [
  { key: "order", label: "주문" },
  { key: "positions", label: "포지션" },
  /* 잔고 (2026-09-07 밤) — 벤티지: "총 잔액과 예수금 이런 것도 한 번에. 수익률 현황 일별·주별·월별·종목별" */
  { key: "ledger", label: "잔고" },
  { key: "history", label: "기록" },
  /* 설정 (2026-09-04) — 한도는 여기 없다. 그건 파일을 직접 연다 */
  { key: "config", label: "⚙ 설정" },
];

/**
 * 큰 돈은 **만원**으로 (2026-09-07 밤) — 벤티지: "숫자 표시하는 UI 들이 굉장히 어색해."
 * 1,350,000원 / 5,000,000원 처럼 자리수 긴 숫자를 나란히 두면 눈이 못 센다. 요약 자리는
 * 「135만 / 500만」, 정확한 값이 필요한 자리는 「1,350,000원 <small>(135만)</small>」.
 */
function manwon(n: number | null | undefined): string {
  const v = Math.round(n ?? 0);
  const a = Math.abs(v);
  const sign = v < 0 ? "−" : "";
  if (a >= 100_000_000) return `${sign}${(a / 100_000_000).toFixed(a >= 1_000_000_000 ? 0 : 1)}억`;
  if (a >= 1_000_000) return `${sign}${Math.round(a / 10_000).toLocaleString()}만`;
  if (a >= 10_000) return `${sign}${(a / 10_000).toFixed(1).replace(/\.0$/, "")}만`;
  return `${sign}${a.toLocaleString()}원`;
}

/** 정확한 값 + 만원 어림을 한 자리에 — 총액·예수금처럼 두 번 읽는 숫자 */
function Krw({ n, unit = "원" }: { n: number | null | undefined; unit?: string }) {
  const v = Math.round(n ?? 0);
  return (
    <span className="krw">
      <b>{v.toLocaleString()}</b>
      <i>{unit}</i>
      {Math.abs(v) >= 10_000 && <em>{manwon(v)}</em>}
    </span>
  );
}

/** 폰 폭인가 — 카드 접힘 기본 같은 「폰에서만」 판단에 (2026-09-07 밤) */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => (typeof window !== "undefined" ? window.matchMedia("(max-width: 900px)").matches : false));
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 900px)");
    const on = () => setNarrow(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return narrow;
}

/** 매수/매도 색 칩 — 표·카드 어디서나 같은 모양 */
function SideChip({ side }: { side: string | null | undefined }) {
  const s = String(side ?? "");
  const buy = /매수|buy/i.test(s);
  const sell = /매도|sell/i.test(s);
  if (!buy && !sell) return <span className="ord-wchip none">{s || "-"}</span>;
  return <span className={`ord-wchip ${buy ? "buy" : "sell"}`}>{buy ? "매수" : "매도"}</span>;
}

function won(n: number | null | undefined): string {
  return n === null || n === undefined ? "-" : `${Math.round(n).toLocaleString()}원`;
}

/** 서버가 「없는 길」이라고 답하면 세션이 끊긴 것이다 — 그때만 로그인 칸으로 되돌린다 */
function isGone(e: unknown): boolean {
  return e instanceof Error && /not found/i.test(e.message);
}

/**
 * 주소로 넘어온 값 (2026-09-04) — 손절 알림이 「값이 채워진 매도 폼」으로 보낸다.
 *
 *   #/order?stk=034020&name=두산에너빌리티&side=sell&tt=28&cond=75000&price=75000&qty=100
 *
 * ⚠️ 종목 칸 이름이 `stk` 인 이유: `code` 를 쓰면 해시 라우터가 **종목 이동**으로 읽어
 * 주문 화면 위에 종목 상세 시트를 띄운다(2026-09-04 실측). 라우터가 모르는 이름이어야 한다.
 *
 * ⚠️ **채워 주기만 한다.** 주문서 확인과 주문 비밀번호는 그대로 남아 있다 — 링크 하나로
 * 주문이 나가면 그건 알림에 링크를 심은 사람이 주문을 낼 수 있다는 뜻이 된다.
 */
interface Prefill {
  code: string;
  name: string;
  side: "buy" | "sell" | null;
  tradeType: string | null;
  price: string;
  cond: string;
  qty: string;
  /** 신용(융자) 줄에서 온 매도 — `credit=1&loan=YYYYMMDD` (2026-09-07) */
  credit: boolean;
  loanDate: string;
  /** 자동감시로 열기 — `watch=1&wb=avg&wp=-5&wx=market` (2026-09-07 밤) */
  watch: boolean;
  watchBasis: WatchBasis | null;
  watchPct: string;
  watchExec: WatchExec | null;
  /** 값이 바뀌었는지 가리는 열쇠 — 같은 화면에서 링크를 또 눌러도 다시 채워진다 */
  /** 미체결 정정으로 열기 — 주문 탭의 「정정/취소」가 이 주문번호를 고른다 (2026-09-08) */
  amend: string;
  key: string;
}

/**
 * ⚠️ **해시 라우터보다 먼저 집어 둔다** (2026-09-04 실측).
 *
 * 라우터(`useHashRoute`)는 해시를 `{tab, stock}` 만으로 **다시 쓴다** — `#/order?stk=…&qty=…`
 * 로 들어와도 곧 `#/order` 가 되어 우리 값이 사라진다. 실제로 그래서 프리필이 통째로 날아갔다.
 *
 * 이 파일은 App 이 import 하는 순간 실행되므로, 여기서 건 `hashchange` 리스너가 라우터의
 * 것(첫 렌더 뒤 useEffect 에서 건다)보다 **먼저 등록되고 먼저 불린다.** 그 틈에 값을 집어
 * 모듈 변수에 둔다. 화면은 그걸 꺼내 쓰고 비운다 — 한 번 쓰고 버리는 쪽지다.
 */
let pendingPrefill: Prefill | null = null;

function grabPrefill(): void {
  const p = readPrefill();
  if (p.code) pendingPrefill = p;
}

if (typeof window !== "undefined") {
  grabPrefill();
  window.addEventListener("hashchange", grabPrefill);
}

const EMPTY_PREFILL: Prefill = { code: "", name: "", side: null, tradeType: null, price: "", cond: "", qty: "", credit: false, loanDate: "", watch: false, watchBasis: null, watchPct: "", watchExec: null, amend: "", key: "" };

/**
 * 쪽지를 **보기만** 한다 — 비우지 않는다.
 *
 * 주문 화면은 잠겨 있을 때도(세션 없음·비밀번호 없음) 뜬다. 거기서 쪽지를 비워 버리면
 * 로그인을 마치고 폼이 뜨는 순간엔 이미 값이 없다 — 알림을 눌러 온 사람이 빈 폼을 만난다.
 * 그래서 **폼이 실제로 값을 채운 뒤에** 비운다(`clearPrefill`).
 */
function peekPrefill(): Prefill {
  return pendingPrefill ?? EMPTY_PREFILL;
}

function clearPrefill(): void {
  pendingPrefill = null;
}

function readPrefill(): Prefill {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const q = new URLSearchParams(raw.split("?")[1] ?? "");
  const num = (k: string) => {
    const v = (q.get(k) ?? "").replace(/\D/g, "");
    return v;
  };
  const side = q.get("side");
  return {
    code: normalizeStockCode(q.get("stk") ?? ""),
    name: q.get("name") ?? "",
    side: side === "sell" || side === "buy" ? side : null,
    tradeType: q.get("tt"),
    price: num("price"),
    cond: num("cond"),
    qty: num("qty"),
    credit: q.get("credit") === "1",
    loanDate: num("loan").slice(0, 8),
    watch: q.get("watch") === "1",
    watchBasis: (["price", "prevClose", "avg", "now"].includes(q.get("wb") ?? "") ? q.get("wb") : null) as WatchBasis | null,
    watchPct: (q.get("wp") ?? "").replace(/[^-\d.]/g, ""),
    watchExec: (["market", "limit_trigger", "limit_now", "limit_fixed"].includes(q.get("wx") ?? "") ? q.get("wx") : null) as WatchExec | null,
    /*
     * 열쇠에 시각을 붙인다 (2026-09-08 — 벤티지 "포지션에서 매도 버튼이 잘 동작을 안 하네").
     * 열쇠가 주소 문자열뿐이라 **같은 종목 매도를 두 번째 누르면** 같은 쪽지로 보고 폼이 안
     * 바뀌었다(effect 가 key 로만 다시 돈다). 눌릴 때마다 새 쪽지여야 한다.
     */
    /** 미체결 정정으로 열기 — 주문 탭의 「정정/취소」가 이 주문번호를 고른다 (2026-09-08) */
    amend: q.get("amend") ?? "",
    key: `${raw}#${Date.now()}`,
  };
}

function legsSay(legs: WatchLeg[]): string {
  return legs.map((l) => `${l.pct > 0 ? "+" : ""}${l.pct}%에 ${l.qtyPct}% ${l.exec === "market" ? "시장가" : "지정가"}`).join(" · ");
}

/**
 * 단계 편집기 (2026-09-07 밤) — 벤티지: "스탑로스 기능에 몇 프로만 팔 건지도 설정해야지."
 * 한 줄이 한 단계: 기준 대비 % · 수량의 % · 시장가/지정가. 합이 100 을 넘으면 빨갛게. 자주 쓰는 모양은 단추로.
 */
const LEG_PRESETS: { label: string; legs: WatchLeg[] }[] = [
  { label: "−5% 전량", legs: [{ pct: -5, qtyPct: 100, exec: "market" }] },
  { label: "−3% 반 · −7% 반", legs: [{ pct: -3, qtyPct: 50, exec: "market" }, { pct: -7, qtyPct: 50, exec: "market" }] },
  { label: "+10% 반 익절 · −5% 손절", legs: [{ pct: 10, qtyPct: 50, exec: "market" }, { pct: -5, qtyPct: 100, exec: "market" }] },
  { label: "3단 −3/−5/−8", legs: [{ pct: -3, qtyPct: 30, exec: "market" }, { pct: -5, qtyPct: 30, exec: "market" }, { pct: -8, qtyPct: 40, exec: "market" }] },
];

function LegsEditor({ legs, onChange, total, basisPrice, disabled }: { legs: WatchLeg[]; onChange: (l: WatchLeg[]) => void; total: number; basisPrice: number; disabled?: boolean }) {
  const sum = legs.reduce((a, l) => a + (Number(l.qtyPct) || 0), 0);
  const set = (i: number, patch: Partial<WatchLeg>) => onChange(legs.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  /*
   * % 칸에 **치는 중인 글자**를 따로 든다 (2026-09-08 — 벤티지 "여기에 소수점이 안들어간다").
   *
   * 값이 숫자로만 저장되니 "1." 을 치면 Number("1.") = 1 → 화면이 "1" 로 되돌아가 점이
   * 사라졌다. 소수점을 넣을 길이 없었다. 칸마다 문자열을 들고, 숫자로 읽히면 그때 저장한다.
   * 단계가 지워지거나 프리셋을 누르면 draft 도 지운다 — 옛 글자가 새 값 위에 떠 있으면 안 된다.
   */
  const [draft, setDraft] = useState<Record<number, string>>({});
  const pctShown = (i: number, v: number) => (draft[i] !== undefined ? draft[i] : String(Math.abs(v)));
  const onPctInput = (i: number, raw: string, down: boolean) => {
    const cleaned = raw.replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1");
    setDraft((d) => ({ ...d, [i]: cleaned }));
    const abs = Number(cleaned);
    if (cleaned !== "" && Number.isFinite(abs)) set(i, { pct: down ? -abs : abs });
  };
  const changeAll = (next: WatchLeg[]) => {
    setDraft({});
    onChange(next);
  };
  const qtyOf = (i: number) => {
    if (total <= 0) return 0;
    const raw = legs.map((l) => Math.floor((total * (Number(l.qtyPct) || 0)) / 100));
    if (sum === 100) raw[raw.length - 1] += total - raw.reduce((a, b) => a + b, 0);
    return raw[i];
  };
  return (
    <div className={`ord-legs${disabled ? " off" : ""}`}>
      <div className="ord-legs-presets">
        {LEG_PRESETS.map((pr) => (
          <button key={pr.label} type="button" disabled={disabled} onClick={() => changeAll(pr.legs.map((l) => ({ ...l })))}>
            {pr.label}
          </button>
        ))}
      </div>
      {legs.map((l, i) => {
        const tr = basisPrice > 0 && Number(l.pct) ? toTick(basisPrice * (1 + Number(l.pct) / 100)) : 0;
        return (
          <div key={i} className={`ord-leg ${Number(l.pct) <= 0 ? "loss" : "gain"}`}>
            <span className="ord-leg-n">{i + 1}단계</span>
            {/*
              부호는 단추로, 숫자는 절대값으로 (2026-09-08 — 벤티지 "- 표시가 안먹히네.
              차라리 상승 하락시 버튼 만들고 앞에는 숫자 쓰는게 낫겠다").

              전엔 한 칸에 "-5" 를 치게 했는데 `Number("-")` 가 NaN 이라 `-` 를 치는 순간
              0 으로 지워졌다 — **음수를 넣을 길이 없었다.** 폰에서 `-` 키 찾기도 일이다.
              단추를 누르면 부호가 뒤집히고 색이 따라 바뀐다. 0 은 하락으로 친다 —
              출구 계획은 손절이 기본이라, 숫자를 지웠다 다시 치면 손절이 되어야 한다.
            */}
            {(() => {
              const v = Number(l.pct);
              const down = v <= 0;
              return (
                <button
                  type="button"
                  className={`ord-leg-dir ${down ? "loss" : "gain"}`}
                  disabled={disabled}
                  onClick={() => {
                    setDraft((d) => { const n = { ...d }; delete n[i]; return n; });
                    set(i, { pct: down ? Math.abs(v) || 5 : -Math.abs(v) });
                  }}
                  title={down ? "하락하면 (손절) — 눌러서 상승으로" : "상승하면 (익절) — 눌러서 하락으로"}
                >
                  {down ? "▼ 하락" : "▲ 상승"}
                </button>
              );
            })()}
            <input
              className="ord-in ord-watch-in sm"
              inputMode="decimal"
              value={pctShown(i, Number(l.pct))}
              disabled={disabled}
              onChange={(e) => onPctInput(i, e.target.value, Number(l.pct) <= 0)}
              onBlur={() => setDraft((d) => { const n = { ...d }; delete n[i]; return n; })}
              title="기준가 대비 몇 % — 소수점 됩니다 (1.5)"
            />
            <span className="ord-watch-unit">%에</span>
            <input
              className="ord-in ord-watch-in sm"
              inputMode="numeric"
              value={String(l.qtyPct)}
              disabled={disabled}
              onChange={(e) => set(i, { qtyPct: Math.min(100, Number(e.target.value.replace(/\D/g, "")) || 0) })}
              title="대상 수량의 몇 %"
            />
            <span className="ord-watch-unit">%</span>
            <select className="ord-in ord-watch-sel" value={l.exec} disabled={disabled} onChange={(e) => set(i, { exec: e.target.value as WatchLeg["exec"] })}>
              <option value="market">시장가</option>
              <option value="limit_now">그때 현재가 지정가</option>
            </select>
            <span className="ord-leg-est">
              {tr > 0 ? `${tr.toLocaleString()}원` : ""}
              {total > 0 ? ` · ${qtyOf(i)}주` : ""}
            </span>
            {legs.length > 1 && (
              <button type="button" className="ord-leg-x" disabled={disabled} onClick={() => changeAll(legs.filter((_, j) => j !== i))} title="이 단계 빼기">
                ✕
              </button>
            )}
          </div>
        );
      })}
      <div className="ord-legs-foot">
        {legs.length < 4 && (
          <button type="button" className="ord-mk" disabled={disabled} onClick={() => changeAll([...legs, { pct: -5, qtyPct: Math.max(0, 100 - sum), exec: "market" }])}>
            ＋ 단계 추가
          </button>
        )}
        <span className={`ord-legs-sum${sum > 100 ? " ord-bad" : ""}`}>
          합 {sum}%{sum > 100 ? " — 100 을 넘는다" : sum < 100 ? ` · ${100 - sum}% 는 남긴다` : " · 전량"}
        </span>
      </div>
    </div>
  );
}

/** 감시 조건을 한 줄로 — 서버 watchSay 와 같은 말 */
function watchSay(s: WatchSpec): string {
  const basisKo = s.basis === "prevClose" ? "전일 종가" : s.basis === "avg" ? "평단" : "등록 때 값";
  const cond =
    s.basis === "price"
      ? `${s.trigger.toLocaleString()}원 ${s.dir === "le" ? "이하" : "이상"}`
      : `${basisKo}(${(s.basisPrice ?? 0).toLocaleString()}) 대비 ${(s.pct ?? 0) > 0 ? "+" : ""}${s.pct}% → ${s.trigger.toLocaleString()}원 ${s.dir === "le" ? "이하" : "이상"}`;
  const exec =
    s.exec === "market" ? "시장가" : s.exec === "limit_trigger" ? "발동가 지정가" : s.exec === "limit_now" ? "그때 현재가 지정가" : `${(s.limitPrice ?? 0).toLocaleString()}원 지정가`;
  const then = s.then && s.then.length > 0 ? ` · 체결되면 체결가 대비 ${legsSay(s.then)} 매도 감시` : "";
  if (s.legs && s.legs.length > 0) return `${basisKo}(${(s.basisPrice ?? 0).toLocaleString()}) 대비 ${legsSay(s.legs)} — ${s.legs.length}단계 매도`;
  return `${cond}면 ${exec}${then}`;
}

const WATCH_STATUS_KO: Record<AutoWatch["status"], string> = {
  waiting: "지켜보는 중",
  fired: "발동 — 체결 대기",
  filled: "체결",
  failed: "실패",
  expired: "만료",
  cancelled: "취소됨",
};

/**
 * 서버 시각(ISO, UTC)을 **보는 사람의 시계**로 (2026-09-07). 여태 `at.slice(5,16)` 로 UTC 를 그대로
 * 적어 기록·접근 로그가 아홉 시간 이르게 보였다 — 자동감시 탭을 만들다 눈에 띄었다.
 */
/** 오늘(KST) YYYY-MM-DD — 폼의 「당일」 판정 */
function kstToday(): string {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
}

/**
 * 키움이 주는 `HHMMSS` 를 **읽는 시각**으로 (2026-09-08 — 벤티지 "시간도 좀 한번에 보기 좋게").
 * 「111620」은 눈으로 자릿수를 세야 읽힌다. 표는 훑는 곳이지 푸는 곳이 아니다.
 */
function hms(t: string): string {
  const d = String(t ?? "").replace(/\D/g, "");
  if (d.length === 6) return `${d.slice(0, 2)}:${d.slice(2, 4)}:${d.slice(4, 6)}`;
  if (d.length === 4) return `${d.slice(0, 2)}:${d.slice(2, 4)}`;
  return t || "-";
}

function localTs(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(5, 16).replace("T", " ");
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 호가 단위 (KRX 2023-01 개편) — 손절 % 를 발동가로 바꿀 때 호가에 맞춘다 */
function tickOf(p: number): number {
  if (p < 2_000) return 1;
  if (p < 5_000) return 5;
  if (p < 20_000) return 10;
  if (p < 50_000) return 50;
  if (p < 200_000) return 100;
  if (p < 500_000) return 500;
  return 1_000;
}
const toTick = (p: number) => Math.floor(p / tickOf(p)) * tickOf(p);

/** 잔고 줄 → 주문 폼으로 가는 주소 — 잔고 탭·「잔고에서 고르기」가 같은 길을 쓴다 */
function orderLink(h: { code: string; name: string; ableQty: number; creditType: string | null; loanDate: string | null }, side: "buy" | "sell", extra = ""): string {
  const base = `#/order?stk=${h.code}&name=${encodeURIComponent(h.name)}&side=${side}`;
  const qty = side === "sell" ? `&qty=${h.ableQty}` : "";
  const credit = side === "sell" && h.creditType ? `&credit=1&loan=${h.loanDate ?? ""}` : "";
  return `${base}${qty}${credit}${extra}`;
}

/**
 * **화면 미리보기** — 로컬 개발 서버에서만 산다 (2026-09-08).
 *
 * 주문 화면은 세션·비밀번호를 통과해야 폼이 나온다. 그래서 로컬에서는 폼을 아예 못 봤고,
 * 「타입 검사만 하고 배포」→「폰에서 깨짐」을 그날 네 번 반복했다. 이제
 * `#/order?preview=1` 이면 세션이 있는 척하고 폼을 그린다. 그 안의 시세·잔고 호출은
 * 서버가 막아 실패하지만, **폭과 배치는 눈으로 확인된다** — 그게 목적이다.
 *
 * **개발 서버(localhost:5173)에서만** 산다. 미니PC 배포본은 다른 포트라 이 길이 아예 안 열리고,
 * 열려 봐야 서버가 주문을 전부 거절한다 — 화면만 그려 보는 문이다.
 */
const devPreview = () =>
  window.location.port === "5173" &&
  /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname) &&
  /[?&]preview=1/.test(window.location.hash);

export function OrderPage({ onSelectStock }: { onSelectStock?: (code: string, name: string) => void }) {
  const [status, setStatus] = useState<OrderStatus | null>(null);
  const [subOrder, setSubOrder] = useState<Sub[]>(readSubOrder);
  const [err, setErr] = useState<string | null>(null);
  const [sub, setSub] = useState<Sub>(() => (peekPrefill().watch ? "positions" : "order"));
  const [left, setLeft] = useState(0);
  /* 주소가 값을 들고 오면 그 값으로 폼을 채운다 — 손절 알림이 이 길로 들어온다 */
  const [prefill, setPrefill] = useState<Prefill>(peekPrefill);

  const load = useCallback(async () => {
    try {
      const s = await api.orderStatus();
      /* 미리보기는 「열려 있고 세션도 있다」로 갈아 끼운다 — 로컬 개발 서버에서만 (위 devPreview 주석) */
      const shown: OrderStatus = devPreview()
        ? { ...s, enabled: true, configured: true, session: true, hasPassword: true, uiLocked: false, sessionLeftSec: 900, reason: null }
        : s;
      setStatus(shown);
      setLeft(shown.sessionLeftSec);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "상태를 못 읽었다");
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load]);

  /* 이미 주문 화면인 채로 알림을 또 누르면 해시만 바뀐다 — 그때도 채워져야 한다 */
  useEffect(() => {
    const onHash = () => {
      /* 쪽지는 위 모듈 리스너가 이미 집어 뒀다 — 여기서는 보기만 한다 */
      const p = peekPrefill();
      if (!p.code) return;
      setPrefill(p);
      /* 자동감시 링크(watch=1)는 포지션 탭(감시 폼)으로 — 호가창 주문과 섞지 않는다 */
      setSub(p.watch ? "positions" : "order");
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  /* 남은 시간은 눈앞에서 줄어야 한다 — 서버 값에서 시작해 1초씩 */
  const ticking = left > 0;
  useEffect(() => {
    if (!ticking) return;
    const t = setInterval(() => setLeft((v) => Math.max(0, v - 1)), 1000);
    return () => clearInterval(t);
  }, [ticking]);

  /* 0 이 되면 서버에 물어 실제로 닫혔는지 확인한다 — 화면만 닫으면 거짓말이 된다 */
  useEffect(() => {
    if (status?.session && left === 0) void load();
  }, [left, status?.session, load]);

  if (err && !status)
    return (
      <div className="page">
        <p className="empty">{err}</p>
      </div>
    );
  if (!status)
    return (
      <div className="page">
        <p className="empty">불러오는 중…</p>
      </div>
    );

  /* 킬 스위치·앱키 — 여기서 막히면 화면이 아니라 서버 .env 를 고쳐야 한다 */
  if (!status.enabled || !status.configured) {
    return (
      <div className="page ord">
        <h2 className="page-title">주문</h2>
        <div className="ord-off">
          <div className="ord-off-mark">🔒</div>
          <b>주문 기능이 꺼져 있다</b>
          <p>{status.reason}</p>
          <pre className="ord-env">{`# server/.env
ORDERS_ENABLED=1
KIWOOM_ORDER_APP_KEY=...       # 조회용 키와 별도 (소액 전용 계좌)
KIWOOM_ORDER_APP_SECRET=...
KIWOOM_ORDER_IS_MOCK=true      # 실전은 false 를 손으로 적어야 한다
TELEGRAM_CHAT_ID_ORDER=...     # 주문·체결이 갈 방`}</pre>
          <p className="ord-note">
            고친 뒤 서버를 다시 켜야 한다. 모의투자 앱키는 키움 REST 개발자 포털에서 따로 신청한다.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="page ord">
      <Band status={status} left={left} onChange={load} />
      {!status.session ? (
        <SessionGate status={status} onDone={load} />
      ) : !status.hasPassword ? (
        <PasswordSetup onDone={load} />
      ) : status.uiLocked ? (
        <LockedCard status={status} onDone={load} />
      ) : (
        <>
          <div className="ord-subs">
            {subOrder.map((k) => SUBS.find((x) => x.key === k)!).map((s) => (
              <button
                key={s.key}
                type="button"
                className={`ord-sub${sub === s.key ? " on" : ""}`}
                onClick={() => setSub(s.key)}
              >
                {s.label}
                {s.key === "positions" && (status.autoWatch?.waiting ?? 0) + (status.autoWatch?.fired ?? 0) > 0 && (
                  <i className="ord-sub-n" title="지켜보는 감시">{(status.autoWatch?.waiting ?? 0) + (status.autoWatch?.fired ?? 0)}</i>
                )}
              </button>
            ))}
          </div>
          {sub === "order" && (
            <OrderForm status={status} prefill={prefill} onDone={load} onSelectStock={onSelectStock} />
          )}
          {sub === "positions" && <PositionsTab status={status} prefill={prefill} onDone={load} onSelectStock={onSelectStock} />}
          {sub === "ledger" && <LedgerTab />}
          {sub === "history" && <HistoryTab status={status} onDone={load} />}
          {sub === "config" && <ConfigTab status={status} onDone={load} subOrder={subOrder} onSubOrder={(o) => { setSubOrder(o); setPref(SUB_ORDER_KEY, JSON.stringify(o)); }} />}
        </>
      )}
    </div>
  );
}

/* ── 머리띠 ─────────────────────────────────────────────────────────────── */

function Band({ status, left, onChange }: { status: OrderStatus; left: number; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const mm = String(Math.floor(left / 60)).padStart(2, "0");
  const ss = String(left % 60).padStart(2, "0");

  async function lock() {
    setBusy(true);
    try {
      await api.orderLock(true);
    } catch {
      /* 잠그기가 실패해도 알릴 것이 없다 — 다시 누르면 된다 */
    } finally {
      setBusy(false);
      onChange();
    }
  }

  async function close() {
    setBusy(true);
    try {
      await api.orderCloseSession();
    } catch {
      /* 이미 닫혔어도 결과는 같다 */
    } finally {
      setBusy(false);
      onChange();
    }
  }

  return (
    <div className={`ord-band ${status.mock ? "mock" : "real"}`}>
      <span className="ord-band-tag">{status.mock ? "모의투자" : "실전 계좌"}</span>
      <span className="ord-band-mid">
        <span className="ord-stat" title="오늘 나간 주문 건수 / 하루 건수 한도">
          <i>오늘</i>
          <b>{status.today.count}</b>/{status.guard.maxDailyCount}건
        </span>
        <span className="ord-stat" title={`오늘 나간 매수 금액 ${won(status.today.krw)} / 하루 한도 ${won(status.guard.maxDailyKrw)} — 매도(출구)는 한도에 안 센다`}>
          <i>금액</i>
          <b>{manwon(status.today.krw)}</b>/{manwon(status.guard.maxDailyKrw)}
        </span>
        {status.watching > 0 && (
          <span className="ord-stat" title="체결을 지켜보는 주문">
            <i>체결 감시</i>
            <b>{status.watching}</b>
          </span>
        )}
      </span>
      {status.session && (
        <>
          <span className="ord-band-timer" title="가만히 두면 10분에 닫힌다">
            ⏳ {mm}:{ss}
          </span>
          <button type="button" className="ord-band-btn" disabled={busy} onClick={() => void lock()}>
            잠금
          </button>
          <button type="button" className="ord-band-btn" disabled={busy} onClick={() => void close()}>
            닫기
          </button>
        </>
      )}
    </div>
  );
}

/* ── 문 ① 주문 메뉴 열기 ────────────────────────────────────────────────── */

/**
 * 잠금 풀기 (2026-09-08 — 벤티지 "5분 잠금 이런 거 하지 말고 아이디 패스워드 넣어서 풀 수 있게").
 * 잠금 문구가 뜬 자리마다 이 카드가 따라온다 — 진입 문·주문 모달·설정.
 */
function UnlockCard({ onDone }: { onDone: () => void }) {
  const [u, setU] = useState("");
  const [p, setP] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function go() {
    if (!u || !p) return;
    setBusy(true);
    setErr(null);
    try {
      await api.orderUnlock(u, p);
      setU("");
      setP("");
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "실패");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="ord-unlock">
      <b>🔓 잠금 풀기</b>
      <small>앱 아이디·비밀번호를 넣으면 바로 풀린다 — 틀린 횟수도 지워진다</small>
      <div className="ord-unlock-row">
        <input className="ord-in" placeholder="아이디" autoComplete="username" value={u} onChange={(e) => setU(e.target.value)} />
        <input className="ord-in" type="password" placeholder="앱 비밀번호" autoComplete="current-password" value={p} onChange={(e) => setP(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void go()} />
        <button type="button" className="ord-mk" disabled={busy || !u || !p} onClick={() => void go()}>
          {busy ? "…" : "풀기"}
        </button>
      </div>
      {err && <span className="ord-err">{err}</span>}
    </div>
  );
}

function SessionGate({ status, onDone }: { status: OrderStatus; onDone: () => void }) {
  const [id, setId] = useState("");
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /*
   * 등록 안 된 기기면 서버가 `needDevice` 로 돌려보낸다 (2026-09-04). 그때만 메일 확인
   * 단계로 넘어간다 — 등록된 기기는 이 화면을 평생 안 본다.
   */
  const [ticket, setTicket] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [devName, setDevName] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  /* PIN 으로 여는 판 — 설정이 정한다. 새 기기 등록만은 아이디·비밀번호로 (서버가 막는다) */
  const [pin, setPin] = useState("");
  /*
   * **등록하러 아이디·비밀번호 칸으로 건너간다** (2026-09-04).
   *
   * 벤티지: "태블릿에서 알맞은 비밀번호를 입력해도 다시 로그인 화면으로 가버려.
   * 이 기기를 새로 등록을 눌러도 로그인 화면으로."
   *
   * PIN 판에는 아이디·비밀번호 칸이 없어서 `id`·`pw` 가 **늘 빈 문자열**이었다. 그 상태로
   * 「이 기기를 새로 등록」을 누르면 빈 자격증명이 서버로 갔고, 서버는 당연히 401 을 줬다.
   * 그 401 이 앱 로그인 칸을 올렸다(`api.ts` 에서 같이 고쳤다). 즉 **PIN 판에서는 새 기기를
   * 등록할 길이 아예 없었다** — 단추만 있고 길이 없었던 것이다.
   *
   * 「새 기기는 아이디·비밀번호로만」이라는 규칙 자체는 그대로 둔다. 네 자리로 기기를
   * 늘릴 수 있으면 기기 겹이 뜻을 잃는다. 대신 **물어볼 자리를 만든다.**
   */
  const [regMode, setRegMode] = useState(false);
  const entry = status.settings?.entryMode ?? "password";
  /* PIN 과 패턴은 같은 문이다 — 서버도 같은 자리에서 본다. 다른 것은 **입력하는 손**뿐 */
  const byPin = (entry === "pin" || entry === "pattern") && !regMode;
  const byPattern = entry === "pattern" && !regMode;

  /** 패드가 다 찼을 때 — 단추를 안 눌러도 보낸다. 네 자리 치고 또 「열기」를 누르게 하지 않는다 */
  async function openWith(code: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.orderOpenSessionPin(code);
      setPin("");
      onDone();
    } catch (e2) {
      const msg = e2 instanceof Error ? e2.message : "열지 못했다";
      setPin("");
      if (/등록/.test(msg)) {
        setRegMode(true);
        setError("이 기기는 주문에 등록돼 있지 않습니다 — 등록은 아이디·비밀번호로만 됩니다");
        return;
      }
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    /* 등록 판에서 엔터를 치면 **등록**이다 — 세션을 열려 하면 아직 등록이 없어 되돌아온다 */
    if (regMode) {
      void startDevice();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (byPin) {
        await api.orderOpenSessionPin(pin);
        setPin("");
        onDone();
        return;
      }
      await api.orderOpenSession(id, pw);
      setPw("");
      onDone();
    } catch (e2) {
      const msg = e2 instanceof Error ? e2.message : "열지 못했다";
      /* 서버가 준 문구에 「등록」이 있으면 기기 단계다 — 상태 코드는 api 층이 안 넘긴다 */
      if (/등록/.test(msg)) {
        /*
         * PIN 으로 들어왔으면 **곧장 메일을 못 쏜다** — 등록은 아이디·비밀번호로만 되고
         * 그 값이 이 판엔 없다. 빈 값으로 보내면 401 만 받는다(여태 그랬다).
         * 칸을 먼저 내주고, 왜 또 묻는지 적는다.
         */
        if (byPin) {
          setRegMode(true);
          setError("이 기기는 주문에 등록돼 있지 않습니다 — 등록은 아이디·비밀번호로만 됩니다");
          return;
        }
        setError(null);
        void startDevice();
        return;
      }
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  async function startDevice() {
    /* 아이디·비밀번호가 없으면 보내지 않는다 — 빈 값은 401 만 받고 사람은 이유를 모른다 */
    if (!id || !pw) {
      setRegMode(true);
      setError("등록하려면 앱 아이디와 비밀번호를 넣어 주세요 (PIN 으로는 새 기기를 못 들입니다)");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api.orderDeviceStart(id, pw);
      setTicket(r.ticket);
      setSent("메일로 6자리 숫자를 보냈습니다 (10분)");
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : "확인 메일을 못 보냈다");
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.orderDeviceVerify(ticket ?? "", code, devName);
      /*
       * 등록됐으면 곧바로 세션을 연다 — 비밀번호를 또 치게 하지 않는다.
       * PIN 판에서도 이 길이 통한다(2026-09-04 서버에서 같이 고쳤다): 아이디·비밀번호는
       * PIN 보다 약한 열쇠가 아니라, PIN 이 안 오면 원래 길로 본다.
       */
      await api.orderOpenSession(id, pw);
      setPw("");
      setCode("");
      setTicket(null);
      setRegMode(false);
      onDone();
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : "확인 실패");
    } finally {
      setBusy(false);
    }
  }

  if (ticket) {
    return (
      <form className="ord-gate" onSubmit={(e) => void verify(e)}>
        <div className="ord-gate-mark">📧</div>
        <b>이 기기를 주문에 등록합니다</b>
        <p>
          아이디·비밀번호는 <b>아는 것</b>이라 새어 나가면 어디서든 쓸 수 있습니다. 기기는{" "}
          <b>가진 것</b>이라, 둘 다 알아도 등록 안 된 기기에서는 주문 메뉴가 열리지 않습니다.
        </p>
        {sent && <p className="ord-ok">{sent}</p>}
        <input
          className="ord-in"
          inputMode="numeric"
          placeholder="메일로 받은 6자리"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
        />
        <input
          className="ord-in"
          placeholder="이 기기 이름 (예: 갤럭시 S25)"
          value={devName}
          onChange={(e) => setDevName(e.target.value)}
        />
        {error && <p className="ord-err">{error}</p>}
        {/* 잠금 풀기 카드는 한 장이면 된다 — 두 줄이 겹쳐 두 장이 떴다 (2026-09-08 검진 11) */}
        {error && /잠금/.test(error) && <UnlockCard onDone={() => { setError(null); onDone(); }} />}
        <button type="submit" className="ord-go" disabled={busy || code.length !== 6}>
          {busy ? "확인 중…" : "등록하고 열기"}
        </button>
        <button type="button" className="ord-cancel" onClick={() => setTicket(null)}>
          그만
        </button>
      </form>
    );
  }

  if (byPin) {
    return (
      <form className="ord-gate" onSubmit={(e) => void submit(e)}>
        <div className="ord-gate-mark">{byPattern ? "✦" : "🔢"}</div>
        <b>{byPattern ? "진입 패턴" : "진입 PIN 네 자리"}</b>
        <p>
          <b>등록된 기기</b>에서만 열립니다 — 그래서 {byPattern ? "패턴" : "네 자리"}로 충분합니다. 다섯 번 틀리면 30분
          잠기고 텔레그램으로 알립니다. 주문을 낼 때는 <b>주문 비밀번호</b>를 따로 묻습니다.
        </p>
        {status.pinIsDefault && !byPattern && (
          <p className="ord-err">
            아직 기본값 <b>0000</b> 입니다 — 열고 나서 <b>설정 › 진입 PIN</b> 에서 바꾸세요.
          </p>
        )}
        {/*
          입력칸 대신 **화면에 그린 패드** (2026-09-08). type="password" 칸은 브라우저가 저장된
          비밀번호를 들이밀어 걸리적거렸다. 패드는 키보드를 안 띄우니 그럴 자리가 없고,
          다 누르면 그대로 보낸다 — 「열기」를 한 번 더 누를 일이 없다.
        */}
        {byPattern ? (
          <PatternPad value={pin} onChange={setPin} disabled={busy} onComplete={(v) => void openWith(v)} />
        ) : (
          <NumPad value={pin} onChange={setPin} disabled={busy} onComplete={(v) => void openWith(v)} />
        )}
        {error && <p className="ord-err">{error}</p>}
        {error && /잠금/.test(error) && <UnlockCard onDone={() => { setError(null); onDone(); }} />}
        {busy && <p className="ord-note">확인 중…</p>}
        {/*
          여태 여기서 곧장 메일을 쏘려 했다 — 그런데 이 판엔 아이디·비밀번호 칸이 없어
          빈 값이 나갔고 401 만 돌아왔다. 이제 **칸부터 내준다.**
        */}
        <button type="button" className="ord-cancel" onClick={() => setRegMode(true)} disabled={busy}>
          이 기기를 새로 등록
        </button>
      </form>
    );
  }

  return (
    <form className="ord-gate" onSubmit={(e) => void submit(e)}>
      <div className="ord-gate-mark">{regMode ? "🆕" : "🔐"}</div>
      <b>{regMode ? "이 기기를 주문에 등록합니다" : "주문 메뉴는 한 번 더 확인한다"}</b>
      <p>
        {regMode ? (
          <>
            앱 로그인과 같은 <b>아이디·비밀번호</b>를 넣으면 등록 확인 메일을 보냅니다.
            <b> PIN 으로는 새 기기를 못 들입니다</b> — 네 자리로 기기를 늘릴 수 있으면 「등록된
            기기에서만」이라는 겹이 뜻을 잃기 때문입니다.
          </>
        ) : (
          "앱 로그인과 같은 아이디·비밀번호입니다. 등록 안 된 기기라면 메일 확인이 한 번 더 있습니다."
        )}
      </p>
      <input
        className="ord-in"
        autoComplete="username"
        placeholder="아이디"
        value={id}
        onChange={(e) => setId(e.target.value)}
      />
      <input
        className="ord-in"
        type="password"
        autoComplete="current-password"
        placeholder="비밀번호"
        value={pw}
        onChange={(e) => setPw(e.target.value)}
      />
      {error && <p className="ord-err">{error}</p>}
      {regMode ? (
        <>
          <button
            type="button"
            className="ord-go"
            disabled={busy || !id || !pw}
            onClick={() => void startDevice()}
          >
            {busy ? "메일 보내는 중…" : "확인 메일 보내기"}
          </button>
          <button
            type="button"
            className="ord-cancel"
            onClick={() => {
              setRegMode(false);
              setError(null);
            }}
            disabled={busy}
          >
            PIN 으로 돌아가기
          </button>
        </>
      ) : (
        <button type="submit" className="ord-go" disabled={busy || !id || !pw}>
          {busy ? "확인 중…" : "주문 메뉴 열기"}
        </button>
      )}
    </form>
  );
}

/* ── 문 ② 주문 비밀번호 ─────────────────────────────────────────────────── */

function PasswordSetup({ onDone }: { onDone: () => void }) {
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (a !== b) {
      setError("두 칸이 다르다");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.orderSetPassword(a, null);
      setA("");
      setB("");
      onDone();
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : "정하지 못했다");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="ord-gate" onSubmit={(e) => void submit(e)}>
      <div className="ord-gate-mark">🔑</div>
      <b>주문 비밀번호를 정한다</b>
      <p>
        앱 비밀번호와 <b>다른 것</b>으로. 주문을 실행할 때마다 이걸 묻는다. 서버는 해시만 남기므로 잊으면
        <code> server/data/orderAuth.json </code>을 지우고 다시 정해야 한다.
      </p>
      <input
        className="ord-in"
        type="password"
        autoComplete="new-password"
        placeholder="주문 비밀번호 (6자 이상)"
        value={a}
        onChange={(e) => setA(e.target.value)}
      />
      <input
        className="ord-in"
        type="password"
        autoComplete="new-password"
        placeholder="한 번 더"
        value={b}
        onChange={(e) => setB(e.target.value)}
      />
      {error && <p className="ord-err">{error}</p>}
      <button type="submit" className="ord-go" disabled={busy || a.length < 6}>
        {busy ? "저장 중…" : "정하기"}
      </button>
    </form>
  );
}

function LockedCard({ status, onDone }: { status: OrderStatus; onDone: () => void }) {
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function unlock(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.orderLock(false, pw);
      setPw("");
      onDone();
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : "풀지 못했다");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="ord-gate" onSubmit={(e) => void unlock(e)}>
      <div className="ord-gate-mark">🛑</div>
      <b>주문이 잠겨 있다</b>
      <p>잠금이 걸린 동안에는 어떤 주문도 나가지 않는다. 풀려면 주문 비밀번호가 필요하다.</p>
      {status.settings.passwordMode === "pattern" ? (
        <PatternPad value={pw} onChange={setPw} disabled={busy} />
      ) : (
        <input
          className="ord-in"
          type="password"
          placeholder="주문 비밀번호"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
        />
      )}
      {error && <p className="ord-err">{error}</p>}
      <button type="submit" className="ord-go" disabled={busy || !pw}>
        잠금 풀기
      </button>
    </form>
  );
}

/* ── 매수·매도 ──────────────────────────────────────────────────────────── */

function OrderForm({
  status,
  prefill,
  onDone,
  onSelectStock,
}: {
  status: OrderStatus;
  prefill: Prefill;
  onDone: () => void;
  onSelectStock?: (code: string, name: string) => void;
}) {
  const [side, setSide] = useState<"buy" | "sell">(prefill.side ?? "buy");
  /*
   * **직전에 보던 종목으로 연다** (2026-09-04 — 벤티지: "매번 검색해야 돼서 불편").
   *
   * 링크로 온 값이 먼저다. 없을 때만 최근 본 종목을 채운다.
   *
   * ⚠️ 종목만 채우고 **수량·가격은 안 채운다.** 주문 화면에서 자동으로 채워진 값은
   * 사람이 「내가 고른 것」으로 착각하기 쉬운데, 종목은 틀려도 주문서 확인 화면에서
   * 이름이 보여 걸리지만 수량은 안 걸린다. 그리고 채운 사실을 칸 옆에 적어 둔다 —
   * 자동으로 들어온 값은 자동이라고 말해야 한다.
   */
  const [autoPicked] = useState(() => (prefill.code ? null : latestStock()));
  const [code, setCode] = useState(prefill.code || autoPicked?.code || "");
  const [name, setName] = useState(prefill.name || autoPicked?.name || "");
  /*
   * 기본 거래소는 **지금 열려 있는 곳** (2026-09-04).
   *
   * 예전엔 무조건 KRX 였다. 그래서 아침 8시대(NXT 프리마켓만 열린 시간)에 들어오면
   * 「KRX 가 주문을 받는 시간이 아니다」만 뜨고 — NXT 를 누르면 되는데 그 말이 없었다.
   * 벤티지: "nxt에서는 거래 안되는거야?" 되는데 **화면이 안 되는 것처럼 보였다.**
   */
  const [venue, setVenue] = useState<OrderVenue>(() => {
    /*
     * 설정에서 못 박아 뒀으면 그것, 「그때 열려 있는 곳」이면 열린 데를 고른다.
     * 다만 **낼 수 없는 거래소는 애초에 안 고른다** — 모의투자는 KRX 뿐이라, 통합(SOR)이
     * 먼저 있다고 그걸 잡으면 눌러 보고서야 RC9000 을 만난다 (2026-09-04).
     */
    const allowed = status.venueAllowed ?? VENUES.map((v) => v.key);
    const fixed = status.settings?.defaultVenue;
    if (fixed && fixed !== "auto" && allowed.includes(fixed)) return fixed;
    return allowed.find((k) => status.open[k]) ?? allowed[0] ?? "KRX";
  });
  /*
   * 매매구분 (2026-09-04). 예전엔 「시장가」 스위치 하나였는데 실제로는 18가지다 —
   * 목록은 **서버가 준다**(status.tradeTypes). 화면이 표를 들고 있으면 언젠가 서버와 갈린다.
   */
  const [tradeType, setTradeType] = useState(prefill.tradeType ?? status.settings?.defaultTradeType ?? "0");
  const [qty, setQty] = useState(prefill.qty);
  /*
   * 정정/취소 갈래 — 고른 미체결. null 이면 평범한 주문 화면이다.
   * 목록은 이 갈래를 켤 때만 부른다(미체결은 5초 폴링이 따로 있고, 여기서 또 돌 이유가 없다).
   */
  const [amend, setAmend] = useState<{ ordNo: string; side: "buy" | "sell"; qty: number; price: number; name: string; code: string; venue: string; remain: number } | null>(null);
  const [openRows, setOpenRows] = useState<OrderRow[] | null>(null);
  /* 링크(#/order?amend=…)로 들어오면 정정 갈래를 켠다 */
  useEffect(() => {
    if (!prefill.amend) return;
    setAmend({ ordNo: "", side: "buy", qty: 0, price: 0, name: "", code: "", venue: "KRX", remain: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill.key]);
  useEffect(() => {
    if (!amend) return;
    let alive = true;
    const pull = () =>
      void api
        .orderOpen()
        .then((r) => alive && setOpenRows(r.rows))
        .catch(() => alive && setOpenRows([]));
    pull();
    const t = setInterval(pull, 5_000);
    const f = () => pull();
    window.addEventListener("vntg:fill", f);
    return () => {
      alive = false;
      clearInterval(t);
      window.removeEventListener("vntg:fill", f);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amend !== null]);
  /* 링크가 준 주문번호가 목록에 있으면 골라 둔다 — 사람이 한 번 더 안 눌러도 되게 */
  const pickedAmend = useRef("");
  useEffect(() => {
    if (!prefill.amend || !openRows || pickedAmend.current === prefill.amend) return;
    const r = openRows.find((x) => x.ordNo === prefill.amend);
    if (!r) return;
    pickedAmend.current = prefill.amend;
    const sd: "buy" | "sell" = /매도/.test(r.side) ? "sell" : "buy";
    setAmend({ ordNo: r.ordNo, side: sd, qty: r.remain || r.qty, price: r.price, name: r.name, code: r.code, venue: r.venue || "KRX", remain: r.remain || r.qty });
    takeCode(r.code, r.name);
    setSide(sd);
    setQty(String(r.remain || r.qty));
    setPrice(r.price ? String(r.price) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRows, prefill.amend]);
  const [price, setPrice] = useState(prefill.price);
  const [cond, setCond] = useState(prefill.cond);
  /*
   * 호가를 누르면 **어느 칸**에 넣나 (2026-09-04). 보통은 가격 칸 하나뿐이라 고민이 없는데,
   * 스톱지정가는 발동가와 주문단가 둘이라 받을 곳을 정해야 한다. 스톱을 고르면 발동가가
   * 먼저다 — 그게 본론이고, 주문단가는 대개 거기서 몇 호가 안쪽이라 뒤에 정한다.
   */
  const [condFocus, setCondFocus] = useState(true);
  /* 호가창이 올려 주는 지금 값 — 종목 이름 옆에 적는다. 따로 조회하지 않는다 */
  const [quote, setQuote] = useState<{
    price: number;
    changeRate: number | null;
    krxHigh: number;
    krxLow: number;
    nxtHigh: number | null;
    nxtLow: number | null;
  } | null>(null);
  /*
   * 「가능금액의 몇 %」·「보유의 몇 %」를 세려면 계좌를 알아야 한다 (2026-09-04).
   * 폼을 열 때 한 번만 받는다 — 잔고 탭처럼 10초마다 부르면 주문 앱키에 조회가 계속 나간다.
   */
  const [acct, setAcct] = useState<OrderAccount | null>(null);
  const [acctAt, setAcctAt] = useState(0);
  const [holdOpen, setHoldOpen] = useState(false);
  const pullAcct = useCallback(() => {
    void api
      .orderAccount()
      .then((a) => {
        setAcct(a);
        setAcctAt(Date.now());
      })
      /*
       * 미리보기에서는 **가짜 잔고 한 줄**을 세운다 (2026-09-09). 매도 화면의 폭·배치를
       * (예상 손익 줄이 그렇다) 눈으로 보려면 보유가 있어야 하는데, 개발 서버에는 주문 세션이
       * 없어 잔고가 늘 비어 있다 — 그래서 「매도 화면은 배포한 뒤에야 보인다」가 됐다.
       * `devPreview()` 안이라 배포본에서는 이 길이 아예 안 열린다(위 주석).
       */
      .catch(() =>
        setAcct(
          devPreview()
            ? {
                deposit: 1_000_000,
                creditLoan: 0,
                stops: {},
                holdings: [
                  {
                    code: "000660",
                    name: "SK하이닉스",
                    qty: 3,
                    ableQty: 3,
                    avg: 1_800_000,
                    cur: 1_850_000,
                    pnl: 150_000,
                    pnlRate: 2.78,
                    creditType: null,
                    loanDate: null,
                  },
                ],
              }
            : null,
        ),
      );
  }, []);
  /*
   * 폼을 열 때 한 번 + **매도로 바꾸거나 종목이 바뀌면 다시** + 매도 중엔 5초마다 (2026-09-08 —
   * 벤티지 "방금 매수하고 매도 갔는데 계좌에 없는 종목이라고 뜨네"). 한 번만 읽던 잔고가 묵어서
   * 방금 체결된 종목이 안 보였다. 키움 쪽도 체결 뒤 몇 초는 잔고에 안 잡힌다 — 그래서 폴링.
   */
  useEffect(() => {
    pullAcct();
  }, [pullAcct, side, code]);
  useEffect(() => {
    if (side !== "sell") return;
    const t = setInterval(pullAcct, 5_000);
    return () => clearInterval(t);
  }, [side, pullAcct]);
  /* 체결 알림이 오면 즉시 — 토스트 폴러가 vntg:fill 을 쏜다 */
  useEffect(() => {
    const f = () => pullAcct();
    window.addEventListener("vntg:fill", f);
    return () => window.removeEventListener("vntg:fill", f);
  }, [pullAcct]);
  /**
   * 수량과 금액은 서로를 고친다 — **누가 마지막에 손댔는지**를 알아야 무한히 되돌지 않는다.
   * 수량을 고쳤으면 금액이 따라오고, 금액을 고쳤으면 수량이 따라온다.
   */
  const lastEdit = useRef<"qty" | "amount">("qty");
  /** 「직접」을 누르면 커서를 수량 칸에 놓는다 */
  const qtyRef = useRef<HTMLInputElement>(null);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ticket, setTicket] = useState<{ nonce: string; expiresAt: number; ticket: OrderTicket } | null>(null);

  /*
   * **신용** (2026-09-07). 벤티지: "신용 기능도 넣어서 최대 얼마까지 매수 가능한지, 신용 섞어서
   * 매수하는 거 체크, 각 종목이 신용이 가능한지, 현금만일 때와 신용 썼을 때 총 매수 가능 수량."
   *
   * 매수는 「기준」으로 고른다 — 현금만 / 증거금(미수 포함) / 신용. 기준이 곧 「최대」의 뜻이다.
   * 매도는 잔고 줄이 정한다 — 융자 줄을 고르면 신용 매도(융자 상환)이고 대출일이 따라온다.
   */
  const [basis, setBasis] = useState<"cash" | "margin" | "credit">("cash");
  /*
   * **출구 계획이 기본** (개편 ①) — 매수엔 손절·익절 단계가 붙은 채로 열린다. 체결되면 단계마다 매도
   * 감시가 자동으로 걸린다. 출구 없이 사려면 스위치를 일부러 꺼야 한다 — 벤티지: "걸어 두면 팔리는 줄 알았다"는
   * 사고는 구조가 막아야 한다.
   */
  /*
   * 출구 계획은 **기본 꺼짐·접힘** (2026-09-08 — 벤티지 "자동 선택되어 있게 하지 말고 접힘 메뉴로").
   * 09-07 개편은 켜짐이 기본이었는데, 1주 왕복 같은 손 매매마다 손절 감시가 딸려 나가는 게
   * 거추장스러웠다. 머리를 누르면 펼쳐지고, 펼친 채 체크해야 걸린다.
   */
  const [exitOn, setExitOn] = useState(false);
  const [exitLegs, setExitLegs] = useState<WatchLeg[]>([{ pct: -5, qtyPct: 100, exec: "market" }]);
  const [loanDate, setLoanDate] = useState<string | null>(prefill.credit ? prefill.loanDate || null : null);
  const [sellCredit, setSellCredit] = useState<boolean>(prefill.credit);
  const [power, setPower] = useState<BuyPower | null>(null);
  const [powerBusy, setPowerBusy] = useState(false);

  /*
   * 링크로 새 값이 오면 갈아 끼운다. **비어 있는 칸은 안 건드린다** — 사용자가 손으로
   * 고쳐 둔 값을 링크가 지우면 안 된다. 다만 링크가 값을 명시했으면 그쪽이 이긴다.
   */
  /*
   * **가격 칸을 현재가로 미리 채운다** (2026-09-08 — 벤티지 "처음 들어가면 해당 가격이 자동
   * 입력되도록. 지금은 일일이 클릭해야 되네"). 종목마다 한 번, 칸이 비어 있을 때만 — 손으로
   * 고친 값이나 링크가 준 값은 안 건드린다. 시장가는 가격이 없으니 안 채운다.
   */
  const autoPricedFor = useRef<string>("");
  /* 자동으로 채운 값은 자동이라고 말한다 — 채운 시각을 들고 있다가 사람이 칸을 만지면 지운다 */
  const [autoPriceAt, setAutoPriceAt] = useState<number | null>(null);
  /** 「가격 자동」 — 켜 두면 현재가(정정이면 원주문가)를 계속 따라간다 */
  const [autoPrice, setAutoPrice] = useState(false);
  /*
   * ⚠️ **종목이 바뀌면 가격·발동가를 비운다** (2026-09-08 — 벤티지 "종목을 옮길 때 자꾸 현금이
   * 0원으로 잡혀서 매수가 안 된다"). 옛 종목의 값이 칸에 남아 있으면 그 값으로 가능수량을
   * 조회한다 — 90,000원짜리를 보다 2,400원짜리로 옮기면 「현금만 0주」가 나온다. 값도 틀리고
   * 주문도 그 값으로 나갈 뻔한다. 링크가 값을 주고 온 경우(prefill)는 아래 effect 가 다시 채운다.
   */
  const lastCode = useRef(code);
  /** 종목이 바뀌면 옛 값을 턴다 — 값과 표식을 한자리에 둔다 */
  const wipeFor = useCallback((c: string) => {
    lastCode.current = c;
    setPrice("");
    setCond("");
    setQty("");
    setAmount("");
    setAutoPriceAt(null);
    autoPricedFor.current = "";
    /* 옛 종목의 신용·대출일도 같이 턴다 — 남으면 엉뚱한 대출일로 신용 매도가 나간다 (검진 6) */
    setSellCredit(false);
    setLoanDate(null);
  }, []);
  useEffect(() => {
    if (lastCode.current === code) return;
    wipeFor(code);
  }, [code, wipeFor]);
  /**
   * **종목을 바꾸면서 값을 같이 넣는 자리**는 이걸 쓴다 (2026-09-08 검진 1).
   *
   * 위 effect 는 `code` 가 바뀐 **다음 커밋**에 값을 턴다. 그래서 종목과 수량을 같이 넣는
   * 자리(잔고에서 고르기 · 정정 목록 · 계좌 매도 링크)는 방금 넣은 값이 한 박자 뒤에
   * 지워졌다 — 정정과 잔고 매도가 통째로 못 쓸 뻔했다. 여기서 **먼저 털고 표식을 갱신**해
   * 두면 뒤이어 부르는 setQty·setPrice 가 살아남는다. 같은 종목이면 아무것도 안 턴다.
   */
  const takeCode = useCallback(
    (c: string, n: string) => {
      if (lastCode.current !== c) wipeFor(c);
      setCode(c);
      setName(n);
      setQuote(null);
    },
    [wipeFor],
  );
  useEffect(() => {
    if (!code || !quote || !(quote.price > 0)) return;
    if (autoPricedFor.current === code) return;
    if (tradeType === "3") return;
    autoPricedFor.current = code;
    if (price === "") {
      setPrice(String(Math.round(quote.price)));
      setAutoPriceAt(Date.now());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, quote?.price]);

  useEffect(() => {
    if (!prefill.code) return;
    takeCode(prefill.code, prefill.name);
    if (prefill.side) setSide(prefill.side);
    if (prefill.tradeType) setTradeType(prefill.tradeType);
    if (prefill.qty) setQty(prefill.qty);
    if (prefill.price) setPrice(prefill.price);
    if (prefill.cond) setCond(prefill.cond);
    setSellCredit(prefill.credit);
    setLoanDate(prefill.credit ? prefill.loanDate || null : null);
    /* 발동가가 채워져 왔으면 다음 호가 클릭은 주문단가 차례다 */
    setCondFocus(!prefill.cond);
    /* 다 썼으니 쪽지를 비운다 — 화면을 옮겼다 돌아왔을 때 손으로 고친 값을 덮지 않게 */
    clearPrefill();
  }, [prefill.key]);

  const types: TradeType[] = status.tradeTypes ?? [];
  const tt = types.find((t) => t.code === tradeType) ?? null;
  /* 「값을 안 쓰는 구분」이면 가격 칸을 잠근다 — 넣어 봐야 서버가 거절한다 */
  const usesPrice = tt ? tt.price !== "no" : true;
  const needsPrice = tt?.price === "req";
  /* 가격 자동이 켜져 있으면 시세를 따라간다 — 정정 중이면 원주문가를 지킨다(키움과 같다) */
  useEffect(() => {
    if (!autoPrice || !usesPrice) return;
    if (amend && amend.ordNo) {
      if (amend.price > 0) setPrice(String(amend.price));
      return;
    }
    if (quote && quote.price > 0) {
      setPrice(String(Math.round(quote.price)));
      setAutoPriceAt(Date.now());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPrice, usesPrice, quote?.price, amend?.price]);
  const usesCond = tt?.cond === true;
  /*
   * **이 종목이 NXT 에서 도는가.** 오늘 NXT 고가가 왔는지로 본다 (아래 거래소 단추의 설명 참고).
   * 여기서 한 번 재고, 도는 곳이 아니면 **거래소를 KRX 로 되돌린다** (2026-09-08 검진 6) —
   * NXT 종목을 보다 미거래 종목으로 옮기면 NXT 가 선택된 채 남아 주문이 거절됐다.
   */
  const nxtDead = Boolean(code) && quote !== null && !quote.nxtHigh;
  useEffect(() => {
    if (nxtDead && venue === "NXT") setVenue("KRX");
  }, [nxtDead, venue]);
  /* 시간외 구분은 정규장 밖에 내는 것이 정상이라 「시간 아님」 경고를 띄우지 않는다 */
  const open = tt?.late ? true : status.open[venue];
  /* 셈에 쓸 값 — 지정가면 그 값, 아니면 호가창이 아는 현재가(스톱은 발동가) */
  /* 시장가면 지정가 칸에 남은 옛 값을 셈에 안 쓴다 — 예상 금액·최대 수량이 그 값으로 나왔다 (2차 검진 🟡) */
  const unit = (usesPrice ? Number(price) : 0) || Number(cond) || Number(quote?.price) || 0;
  /*
   * 매도의 기준 줄 — 같은 종목이 현금 줄·융자 줄로 나뉘어 있을 수 있다. 융자 줄을 골랐으면
   * (대출일이 있으면) 그 줄, 아니면 현금 줄. 「전량 매도」는 **매매가능수량**이다.
   */
  const rows = acct?.holdings.filter((h) => h.code === code) ?? [];
  const heldRow =
    (sellCredit && loanDate ? rows.find((h) => h.creditType && h.loanDate === loanDate) : rows.find((h) => !h.creditType)) ??
    rows[0] ??
    null;
  const held = heldRow?.ableQty ?? 0;
  /*
   * 보유가 **신용 줄뿐**이면 매도도 신용 매도여야 한다 (2026-09-08 — 벤티지 "보유가 없다 라고. 매도수량은
   * 잡히는데"). 폼은 현금 매도였고 잔고는 융자 줄이라 서버가 「현금 보유가 없다」로 막았다. 현금 줄이
   * 없고 신용 줄이 있으면 신용 매도로 알아서 바꾼다(대출일 포함). 현금 줄이 있으면 손대지 않는다.
   */
  useEffect(() => {
    if (side !== "sell" || !code || !acct) return;
    const cash = acct.holdings.find((h) => h.code === code && !h.creditType);
    const cr = acct.holdings.find((h) => h.code === code && h.creditType);
    if (!cash && cr && !sellCredit) {
      setSellCredit(true);
      setLoanDate(cr.loanDate ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [side, code, acct]);

  /*
   * **매수 가능 수량** — 종목·가격이 서면 서버에 묻는다(kt00011·12·kt20017). 0.6초 뒤에 한 번.
   * 가격 칸을 치는 동안 매 글자마다 키움을 부르면 안 된다.
   */
  useEffect(() => {
    if (side !== "buy" || !/^\d{6}$/.test(code) || unit <= 0) {
      setPower(null);
      return;
    }
    let alive = true;
    setPowerBusy(true);
    const t = setTimeout(() => {
      api
        .orderBuyPower(code, unit)
        .then((r) => alive && setPower(r))
        .catch(() => alive && setPower(null))
        .finally(() => alive && setPowerBusy(false));
    }, 600);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [side, code, unit]);

  /* 신용을 못 쓰는 상황이면 기준을 현금으로 되돌린다 — 「신용」이 눌린 채 현금 주문이 나가면 안 된다 */
  const creditOk = Boolean(power?.creditEnabled && power?.credit?.allowed === true);
  useEffect(() => {
    if (basis === "credit" && power && !creditOk) setBasis("cash");
  }, [basis, power, creditOk]);

  /*
   * 「100%·최대」가 뜻하는 것. 매수는 **고른 기준의 가능 수량**(서버가 잰 것), 매도는 **매매가능수량**.
   * 서버 값이 아직 없으면 예수금/단가로 어림한다. 한 건 한도(기본 100만)도 같이 본다 —
   * 100% 를 눌렀는데 서버가 거절하면 그 단추는 없느니만 못하다. 줄었으면 아래에 적는다.
   */
  const guardQty = unit > 0 ? Math.floor(status.guard.maxOrderKrw / unit) : 0;
  const powerQty = power
    ? basis === "credit"
      ? (power.credit?.qty ?? 0)
      : basis === "margin"
        ? power.margin.qty
        : power.cashOnly.qty
    : unit > 0
      ? Math.floor((acct?.deposit ?? 0) / unit)
      : 0;
  const maxQty = side === "buy" ? Math.min(powerQty, guardQty) : held;
  const cappedByGuard = side === "buy" && powerQty > guardQty;
  const credit = side === "buy" ? basis === "credit" : sellCredit;
  function setPct(pct: number) {
    lastEdit.current = "qty";
    setQty(String(Math.max(0, Math.floor((maxQty * pct) / 100))));
  }

  /* 수량·가격이 바뀌면 금액이 따라온다 (금액을 손대는 중이면 가만둔다) */
  useEffect(() => {
    if (lastEdit.current !== "qty") return;
    const n = Number(qty) || 0;
    setAmount(n > 0 && unit > 0 ? String(n * unit) : "");
  }, [qty, unit]);

  const openVenues = VENUES.filter((v) => status.open[v.key]).map((v) => v.label);
  const ready = Boolean(code) && Number(qty) > 0 && (!needsPrice || Number(price) > 0) && (!usesCond || Number(cond) > 0);

  /** 호가창이 부른다 — 값을 안 쓰는 구분이면 무시한다(넣어 봐야 서버가 거절한다) */
  function pickPrice(p: number) {
    if (usesCond && condFocus) {
      setCond(String(p));
      /* 발동가를 찍었으면 다음 클릭은 주문단가다 — 두 번 눌러 스톱 하나를 완성한다 */
      setCondFocus(false);
      return;
    }
    if (usesPrice) setPrice(String(p));
  }

  async function prepare(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.orderPrepare({
        side,
        code,
        name,
        qty: Number(qty),
        price: usesPrice && price ? Number(price) : null,
        condPrice: tt?.cond && cond ? Number(cond) : null,
        tradeType,
        venue,
        credit,
        loanDate: credit && side === "sell" ? loanDate : null,
        exit: side === "buy" && exitOn && !usesCond ? exitLegs.map((l) => ({ pct: Number(l.pct), qtyPct: Number(l.qtyPct), exec: l.exec })) : null,
      });
      setTicket(r);
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : "주문서를 못 만들었다");
      if (isGone(e2)) onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    /*
     * ⚠️ **확인 창을 이 폼 안에 두지 말 것** (2026-09-04 실측으로 잡음).
     *
     * 벤티지: "매수 주문 넣어봤는데 주문도 안 들어가고 창도 안 닫히고."
     *
     * 확인 창도 `<form>` 이라, 주문 폼 **안에** 그리면 폼이 겹친다. HTML 은 폼 중첩을 허용하지
     * 않아서 브라우저가 안쪽 폼 태그를 조용히 버린다 — 그러면 「매수 실행」 단추가 **바깥 폼**을
     * 제출한다. 즉 실행 대신 `prepare` 가 다시 돌아 **새 주문서가 만들어지고**, 창은 그대로 남고,
     * 주문은 한 건도 안 나간다. 정확히 그 증상이었다.
     *
     * 확인 창은 화면에 떠 있는 덮개(position: fixed)라 자리를 안 먹는다 — 폼 **밖에** 둔다.
     */
    <>
      <form className={`ord-wrap ${side}`} onSubmit={(e) => void prepare(e)}>
      {/*
        머리는 폭을 다 쓴다 — 종목과 매수·매도는 「무엇을 어느 쪽으로」라서 제일 먼저 정한다.
        키움 앱도 이 둘을 호가창 **위**에 두고, 그 아래를 호가 | 주문으로 가른다.
      */}
      <div className="ord-head">
        <div className="ord-pick">
          <StockSearchBox
            placeholder="종목명 또는 6자리 코드"
            clearOnPick={false}
            onPick={(c, n) => takeCode(c, n)}
          />
          {holdOpen && (
            <div className="ord-hold-list" role="listbox">
              {!acct && <div className="ord-caps">잔고를 읽는 중…</div>}
              {acct && acct.holdings.length === 0 && <div className="ord-caps">보유 종목이 없다</div>}
              {acct?.holdings.map((h) => {
                /* 그 종목으로 폼을 세운다 — 매도면 수량까지 채운다(키움 잔고에서 매도를 누른 것과 같다) */
                const go = (sd: "buy" | "sell") => {
                  takeCode(h.code, h.name);
                  setSide(sd);
                  setAmend(null);
                  setSellCredit(sd === "sell" ? Boolean(h.creditType) : false);
                  setLoanDate(sd === "sell" && h.creditType ? h.loanDate ?? null : null);
                  setQty(sd === "sell" ? String(h.ableQty > 0 ? h.ableQty : h.qty) : "");
                  setHoldOpen(false);
                };
                return (
                  <div key={`${h.code}-${h.creditType ?? ""}-${h.loanDate ?? ""}`} className="ord-hold-row">
                    <button type="button" className="ord-hold-main" onClick={() => go("sell")}>
                      <b>{h.name}</b>
                      {h.creditType && <i className="ord-crd ok">신용</i>}
                      <span className="num">{h.qty.toLocaleString()}주</span>
                      <span className="num ord-hold-avg">평단 {h.avg.toLocaleString()}</span>
                      <span className={`num ${signClass(h.pnl)}`}>
                        {h.pnlRate > 0 ? "+" : ""}
                        {h.pnlRate.toFixed(2)}%
                      </span>
                    </button>
                    <span className="ord-hold-acts">
                      <button type="button" className="ord-x buy" onClick={() => go("buy")}>
                        매수
                      </button>
                      <button type="button" className="ord-x sell" onClick={() => go("sell")}>
                        매도
                      </button>
                    </span>
                  </div>
                );
              })}
            </div>
          )}
          {code && (
            <div className="ord-picked">
              {/*
                이름을 누르면 **그 자리에 작은 카드** (2026-09-07) — 값을 적기 전에 그 종목을 한 번
                더 보는 길. 예전(09-04)엔 새 탭으로 개별종목분석을 열었는데, 「지금 어디쯤인가」
                하나 보자고 앱을 하나 더 띄우는 건 과했고 미니창에서는 더 이상했다.
                벤티지: "미니 팝업이나 플로팅으로도 충분한 기능일 거 같은데."
                적어 둔 수량·가격은 그대로다 — 이 화면을 안 떠난다.
              */}
              <StockPeek
                code={code}
                name={name || code}
                className="ord-name-go"
                onOpenDetail={() =>
                  window.open(
                    `${window.location.pathname}#/stockAnalysis?code=${code}&name=${encodeURIComponent(name || code)}`,
                    "_blank",
                  )
                }
              />
              <span className="ord-code">{code}</span>
              {/*
                신용 표 (2026-09-08 — 벤티지 "종목명 앞에 신용 가능인지 아닌지도 표시. 키움에서 어떻게
                표시하는지 참고"). 키움 앱은 종목명 옆에 「신용A」처럼 군을 단다. 같은 모양으로 —
                가능이면 군을, 불가면 「신용불가」, 아직 못 받았으면 안 단다.
              */}
              {power?.creditEnabled && power.credit && power.credit.allowed !== null && (
                <em className={`ord-crd${power.credit.allowed ? " ok" : " no"}`} title={power.credit.text ?? (power.credit.allowed ? "신용 가능" : "신용 불가")}>
                  {power.credit.allowed ? `신용${power.credit.grade ?? ""}` : "신용불가"}
                </em>
              )}
              {/* 자동으로 들어온 값은 **자동이라고 말한다** — 고른 것으로 착각하면 안 된다 */}
              {autoPicked && code === autoPicked.code && (
                <em className="ord-auto" title="직전에 보던 종목을 채워 뒀습니다. 위에서 다시 검색하면 바뀝니다">
                  직전에 보던 종목
                </em>
              )}
              {/* 지금 값 — 가격을 적기 전에 「어디쯤인가」가 먼저 보여야 한다 */}
              {/*
                주문 화면에서는 이 표시가 **제일 중요한 자리**다 — 멈춘 값으로 주문을 내는 것이
                이 도구에서 가장 비싼 실수다. 상단 줄에도 같은 표시가 있지만, 가격을 적는
                눈길이 닿는 곳에 한 번 더 둔다.
              */}
              <LiveDot code={code} name={name} />
              {quote && quote.price > 0 && (
                <span className={`ord-quote ${signClass(quote.changeRate)}`}>
                  {fmtNum(quote.price)}
                  {quote.changeRate !== null && (
                    <i>
                      {quote.changeRate > 0 ? "+" : ""}
                      {quote.changeRate.toFixed(2)}%
                    </i>
                  )}
                </span>
              )}
            </div>
          )}
          {/*
            당일 고·저 — **KRX 와 NXT 를 갈라서** (2026-09-04). 두 시장은 고저가 다르고,
            지금 어느 쪽에 내는지에 따라 「위쪽이 어디였나」가 달라진다.
            호가창이 이미 받은 값이라 조회가 늘지 않는다.
          */}
          {code && quote && (quote.krxHigh > 0 || quote.nxtHigh) && (() => {
            /*
             * 고·저 옆에 **전일 종가 대비 등락률** (2026-09-08 벤티지). 값만 있으면 「오늘 얼마나
             * 벌어졌나」를 머리로 나눠야 한다. 기준가는 현재가와 등락률에서 되돌려 낸다
             * (현재가 = 기준가 × (1+등락률)) — 서버에 새로 물을 필요가 없다.
             */
            const base = quote.changeRate !== null && quote.changeRate !== -100 ? quote.price / (1 + quote.changeRate / 100) : 0;
            const rate = (v: number) => (base > 0 && v > 0 ? `${((v - base) / base) * 100 > 0 ? "+" : ""}${(((v - base) / base) * 100).toFixed(2)}%` : "");
            return (
              <div className="ord-hl">
                {quote.krxHigh > 0 && (
                  <span>
                    <i>KRX</i> 고 <b className="positive">{fmtNum(quote.krxHigh)}</b>
                    <em className="positive">{rate(quote.krxHigh) && ` (${rate(quote.krxHigh)})`}</em> 저{" "}
                    <b className="negative">{fmtNum(quote.krxLow)}</b>
                    <em className="negative">{rate(quote.krxLow) && ` (${rate(quote.krxLow)})`}</em>
                  </span>
                )}
                {quote.nxtHigh ? (
                  <span>
                    <i>NXT</i> 고 <b className="positive">{fmtNum(quote.nxtHigh)}</b>
                    <em className="positive">{rate(quote.nxtHigh) && ` (${rate(quote.nxtHigh)})`}</em> 저{" "}
                    <b className="negative">{fmtNum(quote.nxtLow ?? 0)}</b>
                    <em className="negative">{rate(quote.nxtLow ?? 0) && ` (${rate(quote.nxtLow ?? 0)})`}</em>
                  </span>
                ) : null}
              </div>
            );
          })()}
        </div>
        {/*
          매수 · 매도 · **정정/취소** (2026-09-08 — 벤티지가 키움 MTS 화면을 보내며 "미체결 수정은
          주문 메뉴에서, 키움 같은 MTS 처럼"). 키움도 주문 화면 안에 셋째 갈래를 두고 미체결을
          고르면 원주문가·수량이 채워진다. 호가를 눌러 값을 고치는 손이 그대로 이어진다.
        */}
        <div className="ord-side three">
          {/* 매수·매도를 누르면 정정 갈래에서 빠져나온다 — 안 그러면 제출 단추가 「정정/취소」에 갇힌다 (검진 6) */}
          <button type="button" className={side === "buy" ? "on buy" : ""} onClick={() => { setSide("buy"); setAmend(null); }}>
            매수
          </button>
          <button type="button" className={side === "sell" ? "on sell" : ""} onClick={() => { setSide("sell"); setAmend(null); }}>
            매도
          </button>
          <button type="button" className={amend ? "on amend" : ""} onClick={() => setAmend((v) => (v ? null : { ordNo: "", side: "buy", qty: 0, price: 0, name: "", code: "", venue: "KRX", remain: 0 }))}>
            정정/취소
          </button>
          {/*
            **잔고도 여기** (2026-09-08 — 벤티지가 키움 매도 탭을 가리키며 "저 위치에 잔고 넣고 해당
            잔고 메뉴에서 바로 매수 매도 할 수 있게"). 키움도 매수·매도 옆에 두고, 누르면 보유 목록이
            펼쳐진다. 검색칸 옆에 있던 것을 옮겼다 — 손이 가는 자리가 여기다.
          */}
          <button type="button" className={`ord-hold-tab${holdOpen ? " on" : ""}`} onClick={() => { setHoldOpen((v) => !v); pullAcct(); }} title="내 계좌 보유 종목">
            잔고{acct ? ` ${acct.holdings.length}` : ""}
          </button>
        </div>
      </div>

      {amend && (
        <div className="ord-amend">
          <div className="ord-amend-h">
            <b>정정/취소</b>
            <small>미체결을 고르면 원주문가·남은 수량이 채워진다. 값을 고쳐 「정정」, 그대로 두고 「취소」.</small>
          </div>
          {openRows === null && <div className="ord-caps">미체결을 읽는 중…</div>}
          {openRows?.length === 0 && <div className="ord-caps">미체결 주문이 없다</div>}
          {openRows && openRows.length > 0 && (
            <div className="ord-amend-list" role="listbox">
              {openRows.map((r) => {
                const on = amend.ordNo === r.ordNo;
                return (
                  <button
                    key={r.ordNo}
                    type="button"
                    className={`ord-amend-row${on ? " on" : ""}`}
                    onClick={() => {
                      const sd: "buy" | "sell" = /매도/.test(r.side) ? "sell" : "buy";
                      setAmend({ ordNo: r.ordNo, side: sd, qty: r.remain || r.qty, price: r.price, name: r.name, code: r.code, venue: r.venue || "KRX", remain: r.remain || r.qty });
                      takeCode(r.code, r.name);
                      setSide(sd);
                      setQty(String(r.remain || r.qty));
                      setPrice(r.price ? String(r.price) : "");
                    }}
                  >
                    <SideChip side={r.side} />
                    <b>{r.name || r.code}</b>
                    <span className="num">{fmtNum(r.remain || r.qty)}주</span>
                    <span className="num">{r.price ? `${fmtNum(r.price)}원` : "시장가"}</span>
                    <span className="ord-caps">{hms(r.time)}</span>
                  </button>
                );
              })}
            </div>
          )}
          {amend.ordNo && (
            <div className="ord-amend-cur">
              원주문 <b>{amend.ordNo}</b> · {amend.name} · {amend.side === "buy" ? "매수" : "매도"} 남은 <b>{fmtNum(amend.remain)}주</b> @ <b>{amend.price ? fmtNum(amend.price) : "시장가"}</b>
              <span className="ord-caps"> — 아래 수량·가격을 고치고 「정정」</span>
            </div>
          )}
        </div>
      )}

      {/*
        **잔고에서 고르기** (2026-09-07). 벤티지: "매도할 때 잔고 버튼이 보여서 잔고에서 뭘 매도할지
        고르는 기능." 매도만이 아니라 매수에도 둔다 — 들고 있는 것을 더 사는 일이 잦다.
        줄을 누르면 종목이 들어오고, 매도면 수량도 **매매가능수량**으로 채워진다. 융자 줄이면
        신용 매도(융자 상환)가 되고 대출일이 따라온다 — 같은 종목이 현금·융자 두 줄이면 둘 다 뜬다.
      */}
      {acct && acct.holdings.length > 0 && (
        <div className="ord-hold">
          <span className="ord-hold-t">잔고에서</span>
          {acct.holdings.map((h) => {
            const on = h.code === code && (side !== "sell" || (h.creditType ? sellCredit && loanDate === h.loanDate : !sellCredit));
            return (
              <button
                key={`${h.code}:${h.loanDate ?? "cash"}`}
                type="button"
                className={`ord-hold-b${on ? " on" : ""}${h.creditType ? " crd" : ""}`}
                title={`${h.name} · 보유 ${h.qty}주 · 매매가능 ${h.ableQty}주 · 평단 ${h.avg.toLocaleString()}${h.creditType ? ` · ${h.creditType} ${h.loanDate ?? ""}` : ""}`}
                onClick={() => {
                  takeCode(h.code, h.name);
                  if (side === "sell") {
                    lastEdit.current = "qty";
                    setQty(String(h.ableQty));
                    setSellCredit(Boolean(h.creditType));
                    setLoanDate(h.creditType ? h.loanDate : null);
                  }
                }}
              >
                {h.name}
                <i>
                  {h.ableQty}주{h.creditType ? ` · ${h.creditType}` : ""}
                  <b className={signClass(h.pnlRate)}> {h.pnlRate > 0 ? "+" : ""}{h.pnlRate.toFixed(1)}%</b>
                </i>
              </button>
            );
          })}
        </div>
      )}

      {/*
        호가 | 주문칸 (2026-09-04 — 벤티지: "호가창이 밀려서 안보여, 주문도 세로 배치라 불편해.
        키움처럼 구현할 수 있겠니?").

        예전엔 폰에서 폼을 세우고 호가를 **그 아래로** 내렸다. 그러면 값을 넣는 동안 호가가
        화면 밖이라, 호가를 눌러 값을 넣는다는 이 화면의 핵심이 죽는다. 키움 앱처럼 **폰에서도
        나란히** 둔다 — 왼쪽은 호가(좁게, 가격·잔량만), 오른쪽은 입력칸.
      */}
      <div className="ord-grid">
        <div className="ord-book">
          {code ? (
            <OrderBookPanel code={code} onPickPrice={pickPrice} onQuote={setQuote} />
          ) : (
            <p className="empty">종목을 고르면 호가가 뜬다</p>
          )}
        </div>

        <div className="ord-fields">
          <label className="ord-lab">거래소</label>
          <div className="ord-venue">
            {VENUES.map((v) => {
              const can = (status.venueAllowed ?? VENUES.map((x) => x.key)).includes(v.key);
              /*
               * **이 종목이 NXT 에서 도는가** (2026-09-08 — 벤티지 "NXT 거래 불가 종목인데 NXT 가
               * 열려 있네"). 거래소가 열린 것과 그 종목이 거기서 거래되는 것은 다르다. NXT 는 상장
               * 전 종목이 아니라 정해진 종목만 받는다. 키움이 종목별 NXT 가능 여부를 따로 주지 않아
               * **오늘 NXT 고가가 왔는지**로 본다 — 값이 오면 확실히 되는 것이고, 안 오면 장 초반이라
               * 아직 체결이 없을 수도 있으니 막지는 않고 「거래 없음」이라 적는다.
               */
              const noNxt = v.key === "NXT" && nxtDead;
              const shut = !can || !status.open[v.key] || noNxt;
              return (
                <button
                  key={v.key}
                  type="button"
                  disabled={!can}
                  title={!can ? "모의투자에서는 못 냅니다 — 실전 계좌에서만" : noNxt ? "이 종목은 오늘 NXT 체결이 없습니다 — NXT 미지원 종목이거나 아직 거래 전입니다" : v.hint}
                  className={`${venue === v.key ? "on" : ""}${shut ? " shut" : ""}`}
                  onClick={() => setVenue(v.key)}
                >
                  {v.label}
                  <i>{!can ? "모의 불가" : noNxt ? "거래 없음" : status.open[v.key] ? "열림" : "닫힘"}</i>
                </button>
              );
            })}
          </div>

          {status.mock && (status.venueAllowed ?? []).length === 1 && (
            <div className="ord-caps">
              모의투자는 <b>KRX 만</b> 받습니다 — 통합(SOR)·NXT 는 실전 계좌에서만 (키움 RC9000)
            </div>
          )}

          <label className="ord-lab">매매구분</label>
          <select
            className="ord-in"
            value={tradeType}
            onChange={(e) => {
              setTradeType(e.target.value);
              /* 구분이 바뀌면 호가 클릭이 갈 곳도 처음으로 — 스톱을 새로 고르면 발동가부터다 */
              setCondFocus(true);
            }}
          >
            {types.map((t) => (
              <option key={t.code} value={t.code}>
                {t.label}
              </option>
            ))}
          </select>
          {tt && <div className="ord-caps">{tt.hint}</div>}

          <label className="ord-lab">수량</label>
          <div className="ord-step">
            <button
              type="button"
              onClick={() => {
                lastEdit.current = "qty";
                setQty((v) => String(Math.max(0, (Number(v) || 0) - 1)));
              }}
            >
              −
            </button>
            <input
              ref={qtyRef}
              className="ord-in"
              inputMode="numeric"
              value={qty}
              onChange={(e) => {
                lastEdit.current = "qty";
                setQty(e.target.value.replace(/\D/g, ""));
              }}
              placeholder="주"
            />
            <button
              type="button"
              onClick={() => {
                lastEdit.current = "qty";
                setQty((v) => String((Number(v) || 0) + 1));
              }}
            >
              ＋
            </button>
          </div>

          {/*
            비율 단추 (2026-09-04, 벤티지 요청). 매수는 가능금액, 매도는 보유수량 기준.
            기준을 못 잡으면(가격이 없거나 계좌를 못 읽으면) 눌리지 않는다 — 0 주가 들어가는 게 더 나쁘다.
          */}
          <div className="ord-pct">
            {[10, 25, 50].map((n) => (
              <button key={n} type="button" disabled={maxQty <= 0} onClick={() => setPct(n)}>
                {n}%
              </button>
            ))}
            {/* 「최대」 = 100%. 벤티지: "매수할 때도 최대, 매도할 때도 최대 이런 버튼" — 무엇의 최대인지는 아래 줄이 말한다 */}
            <button
              type="button"
              className="ord-pct-max"
              disabled={maxQty <= 0}
              onClick={() => setPct(100)}
              title={side === "buy" ? "고른 기준(현금만·증거금·신용)으로 살 수 있는 최대" : "매매가능수량 전부"}
            >
              최대
            </button>
            <button
              type="button"
              className="ord-pct-self"
              onClick={() => {
                lastEdit.current = "qty";
                setQty("");
                qtyRef.current?.focus();
              }}
            >
              직접
            </button>
          </div>
          {side === "buy" ? (
            /*
             * **가능 수량 판** — 현금만 · 증거금(미수) · 신용, 셋을 나란히. 하나를 고르면 그게 「최대」다.
             * 「0주」와 「못 잼」을 가른다 — 못 재면 그렇게 적는다. 신용은 셋 중 가장 위험한 돈이라
             * 종목이 신용 불가면 그 자리에 그렇게 쓰고, 가드가 꺼져 있으면 켜는 법을 적는다.
             */
            <div className="ord-power">
              {!power ? (
                <div className="ord-caps">
                  {powerBusy
                    ? "가능 수량 재는 중…"
                    : unit > 0
                      ? acct
                        ? `가능금액 ${manwon(acct.deposit)} → 어림 ${maxQty.toLocaleString()}주${cappedByGuard ? " (한 건 한도까지만)" : ""}`
                        : "계좌를 못 읽어 비율을 못 셉니다"
                      : "가격이 서면 가능 수량이 나옵니다"}
                </div>
              ) : (
                <>
                  <div className="ord-basis">
                    <button type="button" className={basis === "cash" ? "on" : ""} onClick={() => setBasis("cash")} title="미수·신용 없이 예수금만으로">
                      현금만 <b>{power.cashOnly.qty.toLocaleString()}주</b>
                      <i>{manwon(power.cashOnly.amt)}</i>
                      {/* 0 주면 왜 0 인지 — 「돈이 없다」와 「값이 이상하다」를 가른다 (2026-09-08) */}
                      {power.cashOnly.qty === 0 && unit > 0 && (
                        <i className="ord-bad">{power.cashOnly.amt > 0 ? `${fmtNum(unit)}원짜리 1주도 안 된다` : "주문가능금액 0"}</i>
                      )}
                    </button>
                    <button
                      type="button"
                      className={basis === "margin" ? "on" : ""}
                      onClick={() => setBasis("margin")}
                      title={`종목 증거금율 ${power.margin.rate}% 만 현금으로 걸고 나머지는 미수 — 이틀 뒤(T+2) 갚아야 합니다`}
                    >
                      증거금 {power.margin.rate}% <b>{power.margin.qty.toLocaleString()}주</b>
                      <i>{manwon(power.margin.amt)} · 미수 포함</i>
                    </button>
                    {power.creditEnabled ? (
                      <button
                        type="button"
                        className={`crd${basis === "credit" ? " on" : ""}`}
                        disabled={!creditOk}
                        onClick={() => setBasis("credit")}
                        title={
                          !power.credit || power.credit.allowed === null
                            ? status.mock
                              ? "모의투자는 신용 조회·주문을 받지 않습니다 — 실전 계좌에서 열립니다"
                              : "신용 조회를 못 했습니다 — 잠시 뒤 다시"
                            : !power.credit.allowed
                              ? `키움 응답이 「불가」 — ${power.credit.why ?? ""}`
                              : `보증금율 ${power.credit.rate ?? "?"}% — 나머지는 융자(이자가 붙습니다)`
                        }
                      >
                        신용 {power.credit?.rate ? `${power.credit.rate}%` : ""}{" "}
                        {/* 못 받은 것(모의)과 불가 종목을 갈라 적는다 — 「불가 종목」은 종목에 대한 단정이라 틀리면 안 된다 */}
                        <b>{!power.credit || power.credit.allowed === null ? (status.mock ? "모의 불가" : "못 잼") : power.credit.allowed ? `${power.credit.qty.toLocaleString()}주` : "불가 종목"}</b>
                        <i>{power.credit?.allowed === true ? `${manwon(power.credit.amt)} · 융자` : status.mock && power.credit?.allowed !== false ? "실전에서만" : "신용 불가"}</i>
                      </button>
                    ) : (
                      <span className="ord-basis-off" title="설정 › 규칙·한도 › 「신용 주문 허용」을 켜면 열린다 (주문 비밀번호)">
                        신용 <i>꺼짐 — 설정 › 규칙·한도</i>
                      </span>
                    )}
                  </div>
                  <div className="ord-caps">
                    {basis === "credit" ? "🔴 신용(융자) 매수" : basis === "margin" ? "증거금 매수 — 미수는 T+2 결제" : "현금 매수"}
                    {" · "}최대 <b>{maxQty.toLocaleString()}주</b>
                    {cappedByGuard ? ` (한 건 한도 ${manwon(status.guard.maxOrderKrw)}원까지)` : ""}
                    {power.missing.length > 0 ? ` · 못 받음: ${power.missing.join(", ")}` : ""}
            {power.credit && power.credit.allowed === false && power.credit.why ? ` · 신용 응답: ${power.credit.why}` : ""}
                  </div>
                </>
              )}
            </div>
          ) : (
            <div className="ord-caps">
              {heldRow
                ? `${sellCredit && heldRow.creditType ? `🔴 신용 매도(융자 상환 · 대출일 ${loanDate ?? "?"}) · ` : ""}매매가능 ${held.toLocaleString()}주 (보유 ${heldRow.qty.toLocaleString()}주 · 평단 ${heldRow.avg.toLocaleString()})`
                : code
                  ? "잔고에 아직 없다 — 방금 산 것이면 몇 초 뒤 잡힌다 (5초마다 다시 본다)"
                  : "종목을 고르면 보유 수량이 나옵니다"}
              {code && !heldRow && (
                <button type="button" className="ord-mk" onClick={pullAcct} title={acctAt ? `마지막 조회 ${new Date(acctAt).toLocaleTimeString("ko-KR", { hour12: false })}` : ""}>
                  다시 보기
                </button>
              )}
            </div>
          )}

          {usesCond && (
            <>
              <label className="ord-lab">발동가</label>
              {/*
                손절 % 칩 (2026-09-07) — 벤티지: "스탑로스 기능도 사용자 편의성 좋게." 평단에서
                몇 % 아래를 발동가로. 호가 단위에 맞춰 내림한다. 주문단가는 발동가와 같게 두면
                발동 즉시 그 값 지정가가 나간다 — 한두 호가 아래로 두려면 호가창에서 누른다.
              */}
              {side === "sell" && sellCredit && (
                <div className="ord-caps">신용(융자) 줄에는 스톱지정가를 못 겁니다 — 현금 줄로 걸거나 보통 매도로</div>
              )}
              {side === "sell" && !sellCredit && heldRow && heldRow.avg > 0 && (
                <div className="ord-stopchips">
                  <span className="pt-n">평단 {heldRow.avg.toLocaleString()} 대비</span>
                  {[3, 5, 7, 10].map((pct) => (
                    <button
                      key={pct}
                      type="button"
                      onClick={() => {
                        const v = toTick(heldRow.avg * (1 - pct / 100));
                        setCond(String(v));
                        if (!price) setPrice(String(v));
                        setCondFocus(false);
                      }}
                    >
                      −{pct}%
                    </button>
                  ))}
                  {quote && quote.price > 0 && (
                    <span className="pt-n">현재가 {quote.price.toLocaleString()}</span>
                  )}
                </div>
              )}
              <input
                className="ord-in"
                inputMode="numeric"
                value={cond}
                onChange={(e) => setCond(e.target.value.replace(/\D/g, ""))}
                placeholder="발동가"
              />
            </>
          )}

          <label className="ord-lab">{usesCond ? "주문단가" : "가격"}</label>
          <div className="ord-step">
            <button type="button" disabled={!usesPrice} onClick={() => setPrice((v) => String(Math.max(0, (Number(v) || 0) - 100)))}>
              −
            </button>
            <input
              className="ord-in"
              inputMode="numeric"
              disabled={!usesPrice}
              value={usesPrice ? price : ""}
              onChange={(e) => {
                setPrice(e.target.value.replace(/\D/g, ""));
                setAutoPriceAt(null);
                setAutoPrice(false);
              }}
              placeholder={usesPrice ? "원" : "값 없음"}
            />
            <button type="button" disabled={!usesPrice} onClick={() => setPrice((v) => String((Number(v) || 0) + 100))}>
              ＋
            </button>
          </div>
          {/*
            키움 주문 화면의 손잡이 둘 (2026-09-08 — 벤티지가 MTS 캡처를 보내며 "각각의 소메뉴 구성
            참고해서 우리도 저렇게. 접근성도 좋고"):
              · **시장가** — 매매구분을 고르러 안 가고 한 번에. 다시 누르면 지정가로 돌아온다
              · **가격 자동** — 켜 두면 값이 현재가를 계속 따라간다. 호가를 누르거나 손으로 고치면 꺼진다
          */}
          <div className="ord-price-tools">
            <button
              type="button"
              className={`filter-btn${tradeType === "3" ? " active" : ""}`}
              onClick={() => {
                setTradeType((t) => (t === "3" ? "0" : "3"));
                setAutoPrice(false);
              }}
              title="시장가 — 값을 안 정하고 지금 시세로 낸다"
            >
              시장가
            </button>
            <label className={`ord-auto-chk${!usesPrice ? " off" : ""}`} title="현재가를 계속 따라간다 — 호가를 누르거나 손으로 고치면 꺼진다">
              <input
                type="checkbox"
                checked={autoPrice && usesPrice}
                disabled={!usesPrice}
                onChange={(e) => {
                  setAutoPrice(e.target.checked);
                  if (e.target.checked && quote && quote.price > 0) {
                    setPrice(String(Math.round(quote.price)));
                    setAutoPriceAt(Date.now());
                  }
                }}
              />
              가격 자동{amend ? " (원주문가)" : " (현재가)"}
            </label>
            {amend && amend.ordNo > "" && (
              <label className="ord-auto-chk" title="남은 수량 전부로 정정한다">
                <input
                  type="checkbox"
                  checked={Number(qty) === amend.remain}
                  onChange={(e) => setQty(e.target.checked ? String(amend.remain) : "")}
                />
                잔량전부
              </label>
            )}
          </div>
          {/* 자동으로 들어온 값은 자동이라고 말한다 (2차 검진 🟠C-3) — 묵으면 「묵은 값」 */}
          {autoPriceAt !== null && usesPrice && price !== "" && (
            <em className="ord-auto" title="들어올 때 현재가로 채웠다. 호가를 누르거나 손으로 고치면 그 값이 된다">
              {Date.now() - autoPriceAt > 60_000 ? "⚠ 현재가로 채운 지 1분 넘음 — 값을 확인" : "현재가로 채움"}
              {quote && quote.price > 0 && Number(price) !== Math.round(quote.price) ? ` · 지금 ${fmtNum(Math.round(quote.price))}` : ""}
            </em>
          )}

          {/*
            예상 금액도 **적을 수 있다** (2026-09-04, 벤티지: "금액을 넣으면 수량이 자동으로
            입력되게끔"). 「30만 원어치」로 생각할 때가 있는데, 그걸 수량으로 바꾸는 나눗셈을
            사람이 할 이유가 없다. 딱 나누어떨어지지 않으면 **내림** — 넘치면 주문이 거절된다.
          */}
          <label className="ord-lab">예상 금액</label>
          <div className="ord-amt">
            <input
              className="ord-in"
              inputMode="numeric"
              value={amount ? Number(amount).toLocaleString() : ""}
              onChange={(e) => {
                lastEdit.current = "amount";
                const v = e.target.value.replace(/\D/g, "");
                setAmount(v);
                setQty(unit > 0 && v ? String(Math.floor(Number(v) / unit)) : "");
              }}
              placeholder={unit > 0 ? "금액 → 수량" : "가격 먼저"}
              disabled={unit <= 0}
            />
            <span>원</span>
          </div>

          {/*
            **이 값에 팔면 얼마 남나** (2026-09-09).

            벤티지: "매도할 때 예상 매도금액 밑에 수익금액이랑 수익률 좀 같이 적어줘.
            해당 호가에서 팔면 얼마나 이득인지 손해인지 바로 알 수 있게."

            여태 평단은 위에 「평단 2,465」로 적혀 있었고 매도가는 아래 칸에 있었다 —
            두 숫자를 놓고 **사람이 뺄셈을 하고 있었다.** 호가를 눌러 값을 갈아 볼 때마다
            그 뺄셈을 다시 하게 되는데, 그것이야말로 기계가 할 일이다.

            ⚠️ **수수료·세금은 안 뺀다.** 증권거래세와 수수료는 채널·계좌마다 다른데,
            여기서 어림으로 깎으면 「그만큼은 확실히 남는다」로 읽힌다. 실제로는 이 값보다
            조금 덜 남으므로 **밑에 그렇게 적는다** — 없는 정확도를 흉내 내지 않는다.
          */}
          {side === "sell" && heldRow && heldRow.avg > 0 && unit > 0 && Number(qty) > 0 && (() => {
            const q = Number(qty);
            const gain = (unit - heldRow.avg) * q;
            const rate = ((unit - heldRow.avg) / heldRow.avg) * 100;
            const cls = gain > 0 ? "positive" : gain < 0 ? "negative" : "";
            return (
              <div className="ord-pnl" title={`(${fmtNum(unit)} − 평단 ${fmtNum(heldRow.avg)}) × ${fmtNum(q)}주`}>
                <span className="ord-pnl-lab">{gain >= 0 ? "예상 수익" : "예상 손실"}</span>
                <b className={cls}>
                  {gain > 0 ? "+" : ""}
                  {fmtNum(Math.round(gain))}원
                </b>
                <b className={cls}>
                  {rate > 0 ? "+" : ""}
                  {rate.toFixed(2)}%
                </b>
                {/* 평단은 바로 위 「매매가능 …(평단 …)」에 이미 있다 — 두 번 적으면 줄만 길어진다 */}
                <em>수수료·세금 전</em>
              </div>
            );
          })()}

          <div className="ord-caps ord-caps-row">
            <span>한 건 <b>{manwon(status.guard.maxOrderKrw)}</b></span>
            <span>지정가 현재가 <b>±{status.guard.priceCollarPct}%</b></span>
            {usesCond && <span>발동가 <b>±{status.guard.stopCollarPct}%</b></span>}
            <span>남은 <b>{Math.max(0, status.guard.maxDailyCount - status.today.count)}</b>건</span>
          </div>

          {/* 출구 계획 — 체크 하나로 켜면 펼쳐지고 끄면 접힌다 (벤티지 "지금은 이중으로 해야 되네") */}
          {/* 신용 매수도 출구를 건다 — 매도 감시는 체결 때 잔고의 대출일을 붙여 신용 매도로 나간다 (2026-09-08) */}
          {side === "buy" && !usesCond && (
            <div className={`ord-exit${exitOn ? " on open" : " folded"}`}>
              <label className="ord-exit-head">
                <input type="checkbox" checked={exitOn} onChange={(e) => setExitOn(e.target.checked)} />
                <b>🛡 출구 계획</b>
                <small>{exitOn ? "체결되면 손절·익절 감시를 건다" : "꺼짐 — 출구 없이 산다"}</small>
              </label>
              {exitOn && <LegsEditor legs={exitLegs} onChange={setExitLegs} total={Number(qty) || 0} basisPrice={unit} />}
            </div>
          )}
        </div>

        <div className="ord-submit">
          {!open && status.guard.marketHoursOnly && (
            <p className="ord-err">
              {venue} 는 지금 주문을 안 받는다
              {openVenues.length > 0 ? (
                <>
                  {" — "}
                  <b>{openVenues.join(" · ")}</b> 는 열려 있다
                </>
              ) : (
                <> — 지금은 어느 거래소도 안 받는다 (NXT 프리 08:00 · KRX 08:30 · NXT 애프터 ~20:00)</>
              )}
            </p>
          )}
          {error && <p className="ord-err">{error}</p>}
        {error && /잠금/.test(error) && <UnlockCard onDone={() => { setError(null); onDone(); }} />}
          {amend ? (
            <div className="ord-amend-go">
              <button
                type="button"
                className="ord-go amend"
                disabled={busy || !amend.ordNo || Number(qty) <= 0 || Number(price) <= 0}
                onClick={async () => {
                  setBusy(true);
                  setError(null);
                  try {
                    const t = await api.orderModifyPrepare({
                      ordNo: amend.ordNo,
                      code: amend.code,
                      name: amend.name,
                      side: amend.side,
                      qty: Number(qty) || 0,
                      price: Number(price) || 0,
                      condPrice: usesCond && cond ? Number(cond) : null,
                      venue: (amend.venue as OrderVenue) || "KRX",
                      remain: amend.remain,
                    });
                    setTicket(t as unknown as { nonce: string; expiresAt: number; ticket: OrderTicket });
                  } catch (e2) {
                    setError(e2 instanceof Error ? e2.message : "정정 주문서를 못 만들었다");
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? "확인 중…" : "정정"}
              </button>
              <button
                type="button"
                className="ord-go cancel"
                disabled={busy || !amend.ordNo}
                onClick={async () => {
                  setBusy(true);
                  setError(null);
                  try {
                    const t = await api.orderCancelPrepare({ ordNo: amend.ordNo, code: amend.code, name: amend.name, qty: amend.remain, venue: (amend.venue as OrderVenue) || "KRX" });
                    setTicket(t as unknown as { nonce: string; expiresAt: number; ticket: OrderTicket });
                  } catch (e2) {
                    setError(e2 instanceof Error ? e2.message : "취소 주문서를 못 만들었다");
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                취소
              </button>
            </div>
          ) : (
            <button type="submit" className={`ord-go ${side}`} disabled={busy || !ready}>
              {busy ? "확인 중…" : side === "buy" ? "매수 주문" : "매도 주문"}
            </button>
          )}
          <p className="ord-note">
            {code && (
              <>
                호가를 누르면 {usesCond ? <b>{condFocus ? "발동가" : "주문단가"}</b> : "가격"} 칸에 들어간다
                {usesCond && (
                  <>
                    {" · "}
                    <button type="button" className="ord-mk" onClick={() => setCondFocus((v) => !v)}>
                      {condFocus ? "발동가로 받는 중" : "주문단가로 받는 중"}
                    </button>
                  </>
                )}
                {" · "}
              </>
            )}
            {usesCond ? "발동가에 닿으면 주문단가로 나간다 — 지켜보는 쪽은 키움이라 앱을 꺼 둬도 산다. " : ""}
            주문서를 눈으로 확인하고 비밀번호를 넣어야 실제로 나간다.
          </p>
        </div>
      </div>

      </form>

      {ticket && (
        <Confirm
          nonce={ticket.nonce}
          expiresAt={ticket.expiresAt}
          ticket={ticket.ticket}
          status={status}
          onClose={() => setTicket(null)}
          onDone={() => {
            setTicket(null);
            setQty("");
            onDone();
          }}
        />
      )}
    </>
  );
}

/* ── 두 번째 단계 — 주문서 확인 + 비밀번호 ──────────────────────────────── */

function Confirm({
  nonce,
  expiresAt,
  ticket,
  status,
  onClose,
  onDone,
}: {
  nonce: string;
  expiresAt: number;
  ticket: OrderTicket | CancelTicket | ModifyTicket;
  status: OrderStatus;
  onClose: () => void;
  onDone: () => void;
}) {
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sec, setSec] = useState(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)));
  const pwRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    pwRef.current?.focus();
    const t = setInterval(() => setSec(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000))), 250);
    return () => clearInterval(t);
  }, [expiresAt]);

  const dead = sec <= 0;
  const isCancel = ticket.kind === "cancel";
  const isModify = ticket.kind === "modify";
  const isWatch = ticket.kind === "order" && Boolean(ticket.watch);
  const sideKo = isCancel ? "취소" : isModify ? `${ticket.side === "buy" ? "매수" : "매도"} 정정` : `${isWatch ? "자동감시 " : ""}${ticket.credit ? "신용" : ""}${ticket.side === "buy" ? "매수" : "매도"}`;
  const [okMsg, setOkMsg] = useState<string | null>(null);
  /*
   * 비밀번호를 지금 안 물어도 되는 상태인가 (2026-09-04) — 설정에서 「기억하기」를 켜고
   * 앞선 주문에서 한 번 맞힌 뒤, 아직 시한 안일 때. **비밀번호를 어디에 저장한 게 아니라**
   * 서버가 이 주문 세션에 「확인됨」 시각을 찍어 둔 것이다.
   */
  const graced = status.settings.rememberPassword && status.passwordLeftSec > 0;
  const [remember, setRemember] = useState(status.settings.rememberPassword);

  async function go(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.orderExecute(nonce, pw, remember);
      setPw("");
      setOkMsg(isWatch ? r.msg : `${sideKo} 접수 — 주문번호 ${r.ordNo || "?"} ${r.msg}`);
      setTimeout(onDone, 1200);
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : "실패");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ord-modal-back" onClick={onClose}>
      <form
        className={`ord-modal ${isCancel ? "cancel" : ticket.side}${isWatch ? " deferred" : ""}`}
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => void go(e)}
      >
        {ticket.kind === "order" && !isWatch && ticket.side === "buy" && (
          ticket.exit && ticket.exit.length > 0 ? (
            <div className="ord-modal-plan">
              🛡 체결되면 체결가 대비 <b>{legsSay(ticket.exit)}</b> 매도 감시가 자동으로 걸립니다.
            </div>
          ) : (
            <div className="ord-modal-plan bad">⚠️ 출구 계획 없이 삽니다 — 손절선이 없는 포지션이 됩니다.</div>
          )
        )}
        {isWatch && ticket.kind === "order" && ticket.watch && (
          <div className="ord-modal-deferred">
            👁 지금 나가지 않습니다 — <b>{watchSay(ticket.watch)}</b>. {ticket.watch.validUntil} 까지 정규장에 지켜보다 닿으면 한 번 냅니다.
            그 전엔 자동감시 탭에서 취소할 수 있습니다.
            {ticket.watch.replaceId ? <b> · 기존 감시는 이것으로 바뀝니다.</b> : null}
          </div>
        )}
        <h3>
          {sideKo}하시겠습니까? <span className={`ord-tick${dead ? " dead" : ""}`}>{dead ? "만료" : `${sec}초`}</span>
        </h3>
        <div className="ord-modal-name">
          {ticket.name || ticket.code} <span className="ord-code">{ticket.code}</span>
        </div>
        <dl className="ord-modal-kv">
          <div>
            <dt>수량</dt>
            <dd>{ticket.qty.toLocaleString()}주</dd>
          </div>
          {ticket.kind === "order" && (
            <>
              <div>
                <dt>구분</dt>
                <dd>{ticket.tradeLabel}</dd>
              </div>
              <div>
                <dt>가격</dt>
                <dd>
                  {isWatch && ticket.watch
                    ? ticket.watch.exec === "market"
                      ? "시장가"
                      : ticket.watch.exec === "limit_fixed"
                        ? `${(ticket.watch.limitPrice ?? 0).toLocaleString()}원 지정가`
                        : ticket.watch.exec === "limit_trigger"
                          ? `발동가(${ticket.watch.trigger.toLocaleString()}) 지정가`
                          : "그때 현재가 지정가"
                    : ticket.price === null
                      ? ticket.tradeLabel
                      : `${ticket.price.toLocaleString()}원`}
                </dd>
              </div>
              {isWatch && ticket.watch && (
                <div className="ord-stop-kv">
                  <dt>발동가</dt>
                  <dd>
                    {ticket.watch.trigger.toLocaleString()}원 {ticket.watch.dir === "le" ? "이하" : "이상"}
                  </dd>
                </div>
              )}
              {/* 스톱은 발동가가 본론이다 — 총액보다 먼저 눈에 들어와야 한다 */}
              {ticket.condPrice !== null && (
                <div className="ord-stop-kv">
                  <dt>발동가</dt>
                  <dd>{ticket.condPrice.toLocaleString()}원</dd>
                </div>
              )}
              <div>
                <dt>현재가</dt>
                <dd>{ticket.refPrice ? `${ticket.refPrice.toLocaleString()}원` : "-"}</dd>
              </div>
            </>
          )}
          {ticket.kind === "cancel" && (
            <div>
              <dt>원주문</dt>
              <dd>{ticket.ordNo}</dd>
            </div>
          )}
          {ticket.kind === "modify" && (
            <>
              <div>
                <dt>원주문</dt>
                <dd>{ticket.ordNo}</dd>
              </div>
              <div>
                <dt>정정 수량</dt>
                <dd>{ticket.qty.toLocaleString()}주</dd>
              </div>
              <div>
                <dt>정정 단가</dt>
                <dd>{ticket.price.toLocaleString()}원</dd>
              </div>
              {ticket.condPrice !== null && (
                <div>
                  <dt>발동가</dt>
                  <dd>{ticket.condPrice.toLocaleString()}원</dd>
                </div>
              )}
            </>
          )}
          <div>
            <dt>거래소</dt>
            <dd>{ticket.venue}</dd>
          </div>
        </dl>
        {ticket.kind === "order" && (
          <div className="ord-modal-amt">
            <span>{ticket.condPrice !== null || isWatch ? "발동되면 총액(어림)" : "총액"}</span>
            <Krw n={ticket.amount} />
          </div>
        )}
        {graced ? (
          <div className="ord-graced">
            🔓 비밀번호 기억 중 — {Math.ceil(status.passwordLeftSec / 60)}분 남음. 이번엔 안 묻습니다.
          </div>
        ) : (
          <>
            {/*
              패턴 모드면 패드로 (2026-09-08 — 벤티지 "주문비밀번호도 패턴쓸수 잇게").
              손을 떼면 그대로 실행하지는 않는다 — 주문은 돈이 나가는 자리라 「실행」을
              한 번 더 누르게 둔다. 진입 문과 다른 점이다.
            */}
            {status.settings.passwordMode === "pattern" ? (
              <PatternPad value={pw} onChange={setPw} disabled={busy || dead} />
            ) : (
              <input
                ref={pwRef}
                className="ord-in"
                type="password"
                autoComplete="off"
                placeholder="주문 비밀번호"
                value={pw}
                onChange={(e) => setPw(e.target.value)}
              />
            )}
            {status.settings.rememberPassword && (
              <label className="ord-remember">
                <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                {status.settings.rememberMinutes}분 동안 다시 묻지 않기
                <i>비밀번호를 저장하지 않습니다 — 이 주문 세션에만, 닫으면 사라집니다</i>
              </label>
            )}
          </>
        )}
        {error && <p className="ord-err">{error}</p>}
        {error && /잠금/.test(error) && <UnlockCard onDone={() => { setError(null); onDone(); }} />}
        {okMsg && <p className="ord-ok">{okMsg}</p>}
        <div className="ord-modal-btns">
          <button type="button" className="ord-cancel" onClick={onClose}>
            그만
          </button>
          <button type="submit" className={`ord-go ${isCancel ? "" : ticket.side}`} disabled={busy || dead || (!graced && !pw)}>
            {busy ? "보내는 중…" : dead ? "만료됨 — 다시" : `${sideKo} 실행`}
          </button>
        </div>
      </form>
    </div>
  );
}

/* ── 자동감시 (2026-09-07 밤) ──────────────────────────────────────────── */

/**
 * 자동감시 폼 (2026-09-07 밤, 두 번째) — 벤티지: "자동감시주문이랑 호가창 주문이랑 섞어놨는데 아예 따로 빼줘.
 * 헷갈린다." 호가창 없이 조건만 적는 폼. 종목을 고르면 지금 값·전일 종가·평단을 서버가 한 번에 준다.
 */
function WatchForm({
  status,
  prefill,
  edit,
  onDone,
  onCancelEdit,
}: {
  status: OrderStatus;
  prefill: Prefill;
  /** 수정 — 이 감시의 값으로 채우고, 등록되면 이것을 대체한다 (2026-09-07 밤) */
  edit: AutoWatch | null;
  onDone: () => void;
  onCancelEdit?: () => void;
}) {
  const es = edit?.spec ?? null;
  const [autoPicked] = useState(() => (prefill.code || edit ? null : latestStock()));
  const [code, setCode] = useState(edit?.ticket.code || prefill.code || autoPicked?.code || "");
  const [name, setName] = useState(edit?.ticket.name || prefill.name || autoPicked?.name || "");
  const [side, setSide] = useState<"buy" | "sell">(edit?.ticket.side ?? prefill.side ?? "buy");
  const [qty, setQty] = useState(edit ? String(edit.ticket.qty) : prefill.qty);
  const [wDir, setWDir] = useState<"le" | "ge">(es ? es.dir : (Number(prefill.watchPct) || 0) > 0 ? "ge" : "le");
  const [wBasis, setWBasis] = useState<WatchBasis>(es?.basis ?? prefill.watchBasis ?? "now");
  const [wPct, setWPct] = useState(es && es.pct !== null ? String(es.pct) : prefill.watchPct || "-5");
  const [wPrice, setWPrice] = useState(es && es.basis === "price" ? String(es.trigger) : "");
  const [wExec, setWExec] = useState<WatchExec>(es?.exec ?? prefill.watchExec ?? "market");
  const [wLimit, setWLimit] = useState(es?.limitPrice ? String(es.limitPrice) : "");
  const [wUntil, setWUntil] = useState(es && es.validUntil !== kstToday() ? es.validUntil : "");
  const [wThenOn, setWThenOn] = useState(Boolean(es?.then && es.then.length > 0));
  const [wThen, setWThen] = useState<WatchLeg[]>(es?.then && es.then.length > 0 ? es.then.map((l) => ({ ...l })) : [{ pct: -5, qtyPct: 100, exec: "market" }]);
  /* 매도를 단계로 — 켜면 조건 줄 대신 단계 편집기. 기준은 평단(없으면 지금 값) */
  const [wSplit, setWSplit] = useState(false);
  const [wLegs, setWLegs] = useState<WatchLeg[]>([{ pct: -3, qtyPct: 50, exec: "market" }, { pct: -7, qtyPct: 50, exec: "market" }]);
  const [q, setQ] = useState<{ price: number; prevClose: number; changeRate: number; avg: number | null; held: number; ableQty: number; deposit: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ticket, setTicket] = useState<{ nonce: string; expiresAt: number; ticket: OrderTicket } | null>(null);

  /* 링크로 다시 들어오면 채운다 (수정 중엔 수정 값이 이긴다) */
  useEffect(() => {
    if (!prefill.code || edit) return;
    setCode(prefill.code);
    setName(prefill.name);
    if (prefill.side) setSide(prefill.side);
    if (prefill.qty) setQty(prefill.qty);
    if (prefill.watchBasis) setWBasis(prefill.watchBasis);
    if (prefill.watchPct) {
      setWPct(prefill.watchPct);
      setWDir((Number(prefill.watchPct) || 0) > 0 ? "ge" : "le");
    }
    if (prefill.watchExec) setWExec(prefill.watchExec);
    clearPrefill();
  }, [prefill.key]);

  /* 종목이 정해지면 값을 한 번 — 15초마다 갱신(감시 폼은 호가창이 없다) */
  useEffect(() => {
    if (!code) return;
    let alive = true;
    const pull = () =>
      void api
        .orderWatchQuote(code)
        .then((v) => alive && setQ(v))
        .catch(() => alive && setQ(null));
    pull();
    const t = setInterval(pull, 15_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [code]);

  useEffect(() => {
    if (wBasis === "price") return;
    const n = Number(wPct);
    if (n < 0) setWDir("le");
    else if (n > 0) setWDir("ge");
  }, [wBasis, wPct]);
  useEffect(() => {
    if (wBasis === "avg" && side !== "sell") setWBasis("now");
  }, [wBasis, side]);

  const basisPrice = wBasis === "prevClose" ? (q?.prevClose ?? 0) : wBasis === "now" ? (q?.price ?? 0) : wBasis === "avg" ? (q?.avg ?? 0) : 0;
  const trigger = wBasis === "price" ? Number(wPrice) || 0 : basisPrice > 0 && Number(wPct) ? toTick(basisPrice * (1 + Number(wPct) / 100)) : 0;
  const unit = wExec === "limit_fixed" ? Number(wLimit) || trigger : trigger;
  const guardQty = unit > 0 ? Math.floor(status.guard.maxOrderKrw / unit) : 0;
  const maxQty = side === "buy" ? Math.min(guardQty, unit > 0 ? Math.floor((q?.deposit ?? 0) / unit) : 0) : (q?.ableQty ?? 0);
  const alreadyHit = q && trigger > 0 ? (wDir === "le" ? q.price <= trigger : q.price >= trigger) : false;
  const legsOk = (ls: WatchLeg[]) => ls.length > 0 && ls.every((l) => Number(l.pct) !== 0 && l.qtyPct >= 1) && ls.reduce((s, l) => s + l.qtyPct, 0) <= 100 && new Set(ls.map((l) => l.pct)).size === ls.length;
  const splitOn = side === "sell" && wSplit;
  const splitHit = splitOn && q && basisPrice > 0 ? wLegs.some((l) => { const tr = toTick(basisPrice * (1 + l.pct / 100)); return l.pct < 0 ? q.price <= tr : q.price >= tr; }) : false;
  const ready =
    Boolean(code) &&
    Number(qty) > 0 &&
    (splitOn
      ? basisPrice > 0 && legsOk(wLegs) && !splitHit
      : trigger > 0 && !alreadyHit && (wExec !== "limit_fixed" || Number(wLimit) > 0)) &&
    (!wThenOn || side !== "buy" || legsOk(wThen));
  const allowed = status.guard.allowAutoWatch !== false && status.autoWatch?.allowed !== false;

  async function prepare(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = splitOn
        ? await api.orderPrepare({
            side,
            code,
            name,
            qty: Number(qty),
            /* 단계 매도 — 틀만 보낸다. 첫 단계 값으로 모양을 맞추고, 실제 단계는 서버가 나눈다 */
            price: null,
            condPrice: null,
            tradeType: "3",
            venue: "KRX",
            credit: false,
            loanDate: null,
            watch: {
              dir: wLegs[0].pct < 0 ? "le" : "ge",
              basis: wBasis === "price" ? "avg" : wBasis,
              pct: wLegs[0].pct,
              price: null,
              exec: "market",
              limitPrice: null,
              validUntil: wUntil || null,
              then: null,
              legs: wLegs.map((l) => ({ pct: Number(l.pct), qtyPct: Number(l.qtyPct), exec: l.exec })),
              replaceId: edit?.id ?? null,
            },
          })
        : await api.orderPrepare({
            side,
            code,
            name,
            qty: Number(qty),
            price: wExec === "market" ? null : wExec === "limit_fixed" ? Number(wLimit) || null : trigger || null,
            condPrice: null,
            tradeType: wExec === "market" ? "3" : "0",
            venue: "KRX",
            credit: false,
            loanDate: null,
            watch: {
              dir: wDir,
              basis: wBasis,
              pct: wBasis === "price" ? null : Number(wPct),
              price: wBasis === "price" ? Number(wPrice) || null : null,
              exec: wExec,
              limitPrice: wExec === "limit_fixed" ? Number(wLimit) || null : null,
              validUntil: wUntil || null,
              then: side === "buy" && wThenOn ? wThen.map((l) => ({ pct: Number(l.pct), qtyPct: Number(l.qtyPct), exec: l.exec })) : null,
              legs: null,
              replaceId: edit?.id ?? null,
            },
          });
      setTicket(r);
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : "감시 주문서를 못 만들었다");
      if (isGone(e2)) onDone();
    } finally {
      setBusy(false);
    }
  }

  if (!allowed) return null;

  return (
    <>
      <form className={`ord-wform ${side}${edit ? " editing" : ""}`} onSubmit={(e) => void prepare(e)}>
        {edit && (
          <div className="ord-wform-edit">
            ✏️ <b>{edit.ticket.name}</b> {edit.ticket.side === "buy" ? "매수" : "매도"} 감시를 고치는 중 — 확인하고 비밀번호를 넣으면 옛 감시는 이것으로 바뀐다.
            {onCancelEdit && (
              <button type="button" className="ord-mk" onClick={onCancelEdit}>
                그만두기
              </button>
            )}
          </div>
        )}
        <div className="ord-wform-head">
          <StockSearchBox
            placeholder="종목명 또는 6자리 코드"
            clearOnPick={false}
            onPick={(c, n) => {
              setCode(c);
              setName(n);
              setQ(null);
            }}
          />
          {code && (
            <div className="ord-wform-quote">
              <b>{name || code}</b> <span className="ord-code">{code}</span>
              {q ? (
                <>
                  {" · "}지금 <b>{q.price.toLocaleString()}</b>
                  <span className={signClass(q.changeRate)}> {q.changeRate >= 0 ? "+" : ""}{q.changeRate.toFixed(2)}%</span>
                  {" · "}전일 종가 {q.prevClose.toLocaleString()}
                  {q.avg ? <> · 평단 {q.avg.toLocaleString()} ({q.ableQty}주 가능)</> : null}
                </>
              ) : (
                <span className="ord-caps"> 값 읽는 중…</span>
              )}
              {autoPicked && code === autoPicked.code && <i className="ord-auto">직전에 보던 종목</i>}
            </div>
          )}
          <div className="ord-side-tabs">
            <button type="button" className={`buy${side === "buy" ? " on" : ""}`} onClick={() => setSide("buy")}>
              매수 감시
            </button>
            <button type="button" className={`sell${side === "sell" ? " on" : ""}`} onClick={() => setSide("sell")}>
              매도 감시
            </button>
          </div>
        </div>

        <div className="ord-watch-body">
          {side === "sell" && !edit && (
            <label className="ord-watch-split">
              <input
                type="checkbox"
                checked={wSplit}
                onChange={(e) => {
                  setWSplit(e.target.checked);
                  if (e.target.checked && (wBasis === "price" || (wBasis === "avg" && !q?.avg))) setWBasis(q?.avg ? "avg" : "now");
                }}
              />
              <span>
                <b>단계로 나눠 팔기</b> — 「−3%에 반, −7%에 나머지」처럼. 단계마다 감시가 하나씩 걸린다
              </span>
            </label>
          )}
          <div className="ord-watch-row">
            <span className="ord-watch-lab">기준</span>
            <div className="ord-basis">
              {(
                [
                  ["now", "지금 값 대비"],
                  ["prevClose", "전일 종가 대비"],
                  ...(side === "sell" ? [["avg", "평단 대비"]] : []),
                  ...(splitOn ? [] : [["price", "값 직접"]]),
                ] as [WatchBasis, string][]
              ).map(([k, label]) => (
                <button key={k} type="button" className={wBasis === k ? "on" : ""} onClick={() => setWBasis(k)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          {splitOn ? (
            <>
              <div className="ord-caps">
                기준가 {basisPrice > 0 ? `${Math.round(basisPrice).toLocaleString()}원` : "(아직 모름 — 평단이 없으면 지금 값)"}
                {splitHit ? <b className="ord-bad"> — 어느 단계가 지금 값에서 이미 조건 안이다</b> : null}
              </div>
              <LegsEditor legs={wLegs} onChange={setWLegs} total={Number(qty) || 0} basisPrice={basisPrice} />
            </>
          ) : null}
          {!splitOn && (
          <div className="ord-watch-row">
            <span className="ord-watch-lab">조건</span>
            {wBasis === "price" ? (
              <>
                <input className="ord-in ord-watch-in" inputMode="numeric" placeholder="발동가" value={wPrice} onChange={(e) => setWPrice(e.target.value.replace(/\D/g, ""))} />
                <div className="ord-basis">
                  <button type="button" className={wDir === "le" ? "on" : ""} onClick={() => setWDir("le")}>
                    이하면
                  </button>
                  <button type="button" className={wDir === "ge" ? "on" : ""} onClick={() => setWDir("ge")}>
                    이상이면
                  </button>
                </div>
              </>
            ) : (
              <>
                <input className="ord-in ord-watch-in" inputMode="decimal" placeholder="−5" value={wPct} onChange={(e) => setWPct(e.target.value.replace(/[^-\d.]/g, ""))} />
                <span className="ord-watch-unit">%</span>
                <div className="ord-watch-chips">
                  {(side === "buy" ? [-2, -3, -5, -7, -10] : [-3, -5, -7, -10, 5, 10]).map((v) => (
                    <button key={v} type="button" onClick={() => setWPct(String(v))}>
                      {v > 0 ? `+${v}` : v}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          )}
          {!splitOn && (
          <div className={`ord-caps${alreadyHit ? " ord-bad" : ""}`}>
            {wBasis !== "price" && (basisPrice > 0 ? `기준가 ${Math.round(basisPrice).toLocaleString()}원 → ` : "기준가를 아직 모른다 · ")}
            {trigger > 0 ? `발동가 ${trigger.toLocaleString()}원 ${wDir === "le" ? "이하" : "이상"}` : "발동가 미정"}
            {alreadyHit ? " — 지금 값이 이미 조건 안이다. 그건 감시가 아니라 바로 주문이다" : ""}
            {wBasis === "prevClose" ? " · 전일 종가 기준은 당일만" : ""}
          </div>
          )}

          {!splitOn && (
          <div className="ord-watch-row">
            <span className="ord-watch-lab">닿으면</span>
            <div className="ord-basis">
              {(
                [
                  ["market", "시장가"],
                  ["limit_trigger", "발동가 지정가"],
                  ["limit_now", "그때 현재가 지정가"],
                  ["limit_fixed", "지정가 직접"],
                ] as [WatchExec, string][]
              ).map(([k, label]) => (
                <button key={k} type="button" className={wExec === k ? "on" : ""} onClick={() => setWExec(k)}>
                  {label}
                </button>
              ))}
            </div>
            {wExec === "limit_fixed" && (
              <input className="ord-in ord-watch-in" inputMode="numeric" placeholder="지정가" value={wLimit} onChange={(e) => setWLimit(e.target.value.replace(/\D/g, ""))} />
            )}
          </div>
          )}

          <div className="ord-watch-row">
            <span className="ord-watch-lab">{splitOn ? "대상 수량" : "수량"}</span>
            <input className="ord-in ord-watch-in" inputMode="numeric" placeholder="주" value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ""))} />
            <div className="ord-watch-chips">
              {[10, 25, 50, 100].map((pc) => (
                <button key={pc} type="button" disabled={maxQty <= 0} onClick={() => setQty(String(Math.max(0, Math.floor((maxQty * pc) / 100))))}>
                  {pc === 100 ? "최대" : `${pc}%`}
                </button>
              ))}
            </div>
            <span className="ord-caps">
              {side === "buy"
                ? `예수금 ${won(q?.deposit ?? 0)} · 한 건 ${won(status.guard.maxOrderKrw)} → 최대 ${maxQty}주`
                : `매매가능 ${q?.ableQty ?? 0}주`}
              {unit > 0 && Number(qty) > 0 ? ` · 어림 ${won(unit * Number(qty))}` : ""}
            </span>
          </div>

          <div className="ord-watch-row">
            <span className="ord-watch-lab">유효</span>
            <div className="ord-basis">
              <button type="button" className={!wUntil ? "on" : ""} onClick={() => setWUntil("")}>
                당일
              </button>
              <input type="date" className="ord-in ord-watch-in" value={wUntil} disabled={wBasis === "prevClose"} onChange={(e) => setWUntil(e.target.value)} title="30일까지" />
            </div>
          </div>

          {side === "buy" && (
            <div className="ord-watch-then">
              <label className="ord-watch-then-head">
                <input type="checkbox" checked={wThenOn} onChange={(e) => setWThenOn(e.target.checked)} />
                <span>
                  <b>체결되면 매도 감시를 자동으로 건다</b> — 체결가 대비, 체결 수량의 몇 %씩
                </span>
              </label>
              {wThenOn && <LegsEditor legs={wThen} onChange={setWThen} total={Number(qty) || 0} basisPrice={trigger > 0 ? trigger : (q?.price ?? 0)} />}
            </div>
          )}

          {error && <p className="ord-err">{error}</p>}
        {error && /잠금/.test(error) && <UnlockCard onDone={() => { setError(null); onDone(); }} />}
          <button type="submit" className={`ord-go ${side} deferred`} disabled={busy || !ready}>
            {busy ? "확인 중…" : edit ? "이렇게 고치기" : side === "buy" ? "매수 감시 걸기" : splitOn ? `${wLegs.length}단계 매도 감시 걸기` : "매도 감시 걸기"}
          </button>
          <p className="ord-note">
            KRX · 현금만 · 정규장 09:00~15:30 에만 발동 · <b>한 번뿐</b> · 발동 순간 한도와 가격 자(±{status.guard.priceCollarPct}%)를 다시 잰다.
            주문서를 눈으로 확인하고 비밀번호를 넣어야 감시가 걸린다.
          </p>
        </div>
      </form>

      {ticket && (
        <Confirm
          nonce={ticket.nonce}
          expiresAt={ticket.expiresAt}
          ticket={ticket.ticket}
          status={status}
          onClose={() => setTicket(null)}
          onDone={() => {
            setTicket(null);
            setQty("");
            onDone();
          }}
        />
      )}
    </>
  );
}

/**
 * 감시 히스토리 탭 (2026-09-07 밤) — 지난 감시를 한 줄씩. 누르면 카드로 펼쳐진다. 삭제·모두 지우기.
 * 지우는 것은 이 목록에서만이다 — 주문 기록(orderLog)엔 남는다.
 */
function WatchHistoryTab() {
  const [rows, setRows] = useState<AutoWatch[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | AutoWatch["status"]>("all");

  const load = useCallback(async () => {
    try {
      const r = await api.orderWatch();
      setRows((r.rows ?? []).filter((x) => x.status !== "waiting" && x.status !== "fired"));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "조회 실패");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function remove(r: AutoWatch) {
    setBusy(r.id);
    try {
      await api.orderWatchDelete(r.id);
      setRows((prev) => prev.filter((x) => x.id !== r.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "삭제 실패");
    } finally {
      setBusy(null);
    }
  }
  async function clearAll() {
    if (!window.confirm(`지난 감시 ${rows.length}건을 모두 지울까요? 주문 기록에는 남습니다.`)) return;
    setBusy("*");
    try {
      await api.orderWatchClear();
      setRows([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "삭제 실패");
    } finally {
      setBusy(null);
    }
  }

  const shown = filter === "all" ? rows : rows.filter((r) => r.status === filter);
  const counts = rows.reduce<Record<string, number>>((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {});

  return (
    <div className="ord-tab">
      {error && <p className="ord-err">{error}</p>}
      <div className="ord-wt-head">
        <h4 className="ord-h4">
          감시 히스토리 {rows.length > 0 && <span className="ord-count">{rows.length}</span>}
          <i className="ord-h4-sub">줄을 누르면 펼쳐진다 · 지워도 주문 기록엔 남는다</i>
        </h4>
        {rows.length > 0 && (
          <button type="button" className="ord-x" disabled={busy === "*"} onClick={() => void clearAll()}>
            모두 지우기
          </button>
        )}
      </div>
      {rows.length > 0 && (
        <div className="ord-wh-filter">
          {(["all", "filled", "failed", "expired", "cancelled"] as const).map((k) => (
            <button key={k} type="button" className={filter === k ? "on" : ""} onClick={() => setFilter(k)}>
              {k === "all" ? "전체" : WATCH_STATUS_KO[k]}
              {k !== "all" && counts[k] ? ` ${counts[k]}` : ""}
            </button>
          ))}
        </div>
      )}
      {shown.length === 0 ? (
        <p className="empty">지난 감시가 없다</p>
      ) : (
        <div className="ord-wh-list">
          {shown.map((r) => {
            const t = r.ticket;
            const s = r.spec;
            const isOpen = Boolean(open[r.id]);
            return (
              <div key={r.id} className={`ord-wh-row ${t.side}${isOpen ? " open" : ""}`}>
                <button type="button" className="ord-wh-line" onClick={() => setOpen((m) => ({ ...m, [r.id]: !isOpen }))}>
                  <span className="ord-wh-when">{localTs(r.firedAt ?? r.at)}</span>
                  <b className={`ord-side ${t.side}`}>{t.side === "buy" ? "매수" : "매도"}</b>
                  <span className="ord-wh-name">{t.name || t.code}</span>
                  <span className="ord-wh-cond">
                    {s.trigger.toLocaleString()} {s.dir === "le" ? "이하" : "이상"} · {t.qty}주
                  </span>
                  <b className={`ord-rsv-st ${r.status}`}>{WATCH_STATUS_KO[r.status]}</b>
                  {r.status === "filled" && r.fillPrice ? <span className="ord-wh-fill">@ {r.fillPrice.toLocaleString()}</span> : null}
                  <i className="ord-wh-arrow">{isOpen ? "▲" : "▼"}</i>
                </button>
                {isOpen && (
                  <div className="ord-wh-body">
                    <WatchCard r={r} cur={null} busy={false} onCancel={null} onEdit={null} editing={false} open onToggle={() => undefined} />
                    <button type="button" className="ord-x" disabled={busy === r.id} onClick={() => void remove(r)}>
                      {busy === r.id ? "…" : "이 기록 지우기"}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * 감시 한 장 (2026-09-07 밤, 네 번째) — 벤티지: "핸드폰에서 보려니깐 카드가 너무 크다. 접을 수 있게.
 * 매수/매도 확실히 구분." **접힌 두 줄이 기본**: ① 매수/매도 칩 · 종목 · 발동가(↓이하/↑이상) · 상태
 * ② 지금 값 · 발동까지 % · 수량·방법 · 유효. 누르면 상세(기준·단계·수정·취소)가 열린다.
 */
function WatchCard({
  r,
  cur,
  busy,
  onCancel,
  onEdit,
  editing,
  open,
  onToggle,
}: {
  r: AutoWatch;
  cur: { price: number; from: string } | null;
  busy: boolean;
  /** 취소. 실패하면 던진다 — 카드가 받아서 **그 자리에** 적는다 */
  onCancel: (() => Promise<void>) | null;
  onEdit: (() => void) | null;
  editing: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const t = r.ticket;
  const s = r.spec;
  /*
   * 취소 확인을 **카드 안에서** 받는다 (2026-09-08 — 벤티지 "매도감시 취소 로직이 안 먹는다").
   *
   * 전엔 `window.confirm` 이었다. 홈 화면에 깐 앱(PWA standalone)에서는 그 창이
   * 안 뜨고 곧장 false 를 돌려주는 기기가 있다 — 그러면 취소를 눌러도 **아무 일도
   * 안 일어난다.** 게다가 실패했을 때 사유는 화면 맨 위에 적혀서, 카드를 보려고
   * 스크롤을 내린 사람은 그것도 못 본다.
   *
   * 그래서 취소를 누르면 그 버튼 자리가 「정말? [취소하기] [아니오]」로 바뀌고,
   * 실패 사유도 바로 그 밑에 적힌다. 확인창을 안 쓰니 어떤 기기에서도 같다.
   */
  const [confirming, setConfirming] = useState(false);
  const [cancelErr, setCancelErr] = useState<string | null>(null);
  async function doCancel() {
    if (!onCancel) return;
    setCancelErr(null);
    try {
      await onCancel();
      setConfirming(false);
    } catch (e) {
      setCancelErr(e instanceof Error ? e.message : "취소 실패");
    }
  }
  const sideKo = t.side === "buy" ? "매수" : "매도";
  const basisKo = s.basis === "price" ? null : s.basis === "prevClose" ? "전일 종가" : s.basis === "avg" ? "평단" : "등록 때 값";
  const execShort = s.exec === "market" ? "시장가" : s.exec === "limit_trigger" ? "발동가 지정" : s.exec === "limit_now" ? "현재가 지정" : `${(s.limitPrice ?? 0).toLocaleString()} 지정`;
  const est = (s.limitPrice ?? s.trigger) * t.qty;
  const gap = cur && cur.price > 0 ? ((s.trigger - cur.price) / cur.price) * 100 : null;
  const hit = gap !== null && (s.dir === "le" ? gap >= 0 : gap <= 0);
  const near = gap !== null && !hit && Math.abs(gap) <= 1;
  const start = s.basisPrice ?? cur?.price ?? s.trigger;
  const span = Math.abs(s.trigger - start);
  const walked = cur && span > 0 ? Math.min(100, Math.max(0, (Math.abs(cur.price - start) / span) * 100 * (s.dir === "le" ? (cur.price <= start ? 1 : 0) : cur.price >= start ? 1 : 0))) : 0;
  const stKo = WATCH_STATUS_KO[r.status];
  const waiting = r.status === "waiting";
  return (
    <div className={`ord-wcard ${t.side} st-${r.status}${editing ? " editing" : ""}${open ? " open" : ""}`}>
      <button type="button" className="ord-wcard-sum" onClick={onToggle} aria-expanded={open}>
        <span className={`ord-wchip ${t.side}`}>{sideKo}</span>
        <span className="ord-wcard-name">
          {t.name || t.code}
          {r.parentId && <i className="ord-watch-tag">자동</i>}
          {r.groupId && <i className="ord-watch-tag">단계</i>}
        </span>
        <span className={`ord-wtrig ${s.dir}`}>
          {s.trigger.toLocaleString()}
          <i>{s.dir === "le" ? "↓이하" : "↑이상"}</i>
        </span>
        <span className={`ord-rsv-st ${r.status}`}>{waiting ? "" : stKo}</span>
        <i className="ord-wcard-arrow">{open ? "▲" : "▼"}</i>
        {/*
          ⚠️ **숫자마다 이름을 붙인다** (2026-09-08 — 벤티지: "저것만 봐서는 -3.6이 뭘 의미하는
          건지, 37주 시장가의 의미는 뭔지, 이 카드가 의미하는 바가 뭔지").

          예전 줄은 「277,000 -3.6% · 37주 시장가 · 09/08」이었다. 값 넷이 라벨 없이 붙어 있으니
          277,000 이 발동가인지 현재가인지, -3.6% 가 손익인지 남은 거리인지 알 길이 없었다.
          (실은 현재가 · 발동까지 남은 거리 · 낼 수량 · 감시 마감일이다.)
        */}
        <span className="ord-wcard-line2">
          {waiting ? (
            cur ? (
              <>
                <i className="ord-wlbl">지금</i>
                <b>{cur.price.toLocaleString()}</b>
                <i className="ord-wlbl">발동까지</i>
                <em className={hit ? "hit" : near ? "near" : ""}>
                  {hit ? "닿음" : `${gap! > 0 ? "+" : ""}${gap!.toFixed(1)}%`}
                </em>
              </>
            ) : (
              <span className="ord-caps">값 없음</span>
            )
          ) : r.status === "fired" ? (
            <>
              <i className="ord-wlbl">발동가</i>
              <b>{r.firePrice?.toLocaleString() ?? "-"}</b>
            </>
          ) : r.status === "filled" && r.fillPrice ? (
            <>
              <i className="ord-wlbl">체결가</i>
              <b>{r.fillPrice.toLocaleString()}</b>
            </>
          ) : (
            <span>{r.msg?.slice(0, 22) ?? ""}</span>
          )}
          <span className="ord-wsep">·</span>
          <i className="ord-wlbl">{t.side === "buy" ? "살 양" : "팔 양"}</i>
          {t.qty.toLocaleString()}주
          <i className="ord-wlbl">낼 때</i>
          {execShort}
          <span className="ord-wsep">·</span>
          <i className="ord-wlbl">감시 마감</i>
          {s.validUntil.slice(5).replace("-", "/")}
          {s.then && s.then.length > 0 && (
            <>
              <span className="ord-wsep">·</span>↳{s.then.length}단계
            </>
          )}
        </span>
        {waiting && cur && span > 0 && (
          <span className="ord-wbar">
            <i style={{ width: `${walked}%` }} />
          </span>
        )}
      </button>
      {open && (
        <div className="ord-wcard-body">
          {/*
            **이 카드가 뭔지 한 문장으로.** 격자 넷(기준·닿으면·지금 값·걸어 둔 때)은 값을
            나눠 적을 뿐이라, 처음 보는 사람은 그걸 다 읽고도 「그래서 뭘 한다는 건가」를
            스스로 조립해야 했다. 조립한 결과를 먼저 적는다.
          */}
          <p className="ord-wcard-say">
            <b>{t.name || t.code}</b>가 <b>{s.trigger.toLocaleString()}원 {s.dir === "le" ? "이하로 내려가면" : "이상으로 올라가면"}</b>{" "}
            {t.qty.toLocaleString()}주를{" "}
            {s.exec === "market"
              ? "시장가로"
              : s.exec === "limit_trigger"
                ? "발동가에 지정가로"
                : s.exec === "limit_now"
                  ? "그때 현재가에 지정가로"
                  : `${(s.limitPrice ?? 0).toLocaleString()}원 지정가로`}{" "}
            <b>{sideKo}</b>합니다. {s.validUntil} 까지 정규장에 지켜보다 닿으면 <b>한 번만</b> 냅니다.
            {r.parentId && " 앞 주문이 체결돼서 자동으로 걸린 감시입니다."}
          </p>
          <div className="ord-wcard-grid">
            <div className="ord-wcard-cell">
              <dt>기준</dt>
              <dd>{basisKo ? `${basisKo} ${(s.basisPrice ?? 0).toLocaleString()} 대비 ${(s.pct ?? 0) > 0 ? "+" : ""}${s.pct}%` : "값 직접"}</dd>
            </div>
            <div className="ord-wcard-cell">
              <dt>닿으면</dt>
              <dd>
                {s.exec === "market" ? "시장가" : s.exec === "limit_trigger" ? "지정가 · 발동가로" : s.exec === "limit_now" ? "지정가 · 그때 현재가로" : `지정가 ${(s.limitPrice ?? 0).toLocaleString()}원`}
              </dd>
              <small>어림 {won(est)}</small>
            </div>
            <div className="ord-wcard-cell">
              <dt>지금 값</dt>
              <dd>{cur ? `${cur.price.toLocaleString()}원 (${cur.from})` : r.firePrice ? `발동 ${r.firePrice.toLocaleString()}원` : "-"}</dd>
              {waiting && gap !== null && <small>발동까지 {gap > 0 ? "+" : ""}{gap.toFixed(2)}%</small>}
            </div>
            <div className="ord-wcard-cell">
              <dt>걸어 둔 때</dt>
              <dd>{localTs(r.at)}</dd>
              <small>{s.validUntil} 까지</small>
            </div>
          </div>
          {s.then && s.then.length > 0 && (
            <div className="ord-wcard-then">
              ↳ 체결되면 체결가 대비 <b>{legsSay(s.then)}</b> 매도 감시
              {r.childIds?.length ? ` · ${r.childIds.length}건 걸렸다` : r.childId ? " · 걸렸다" : ""}
            </div>
          )}
          {r.status === "fired" && (
            <div className="ord-wcard-foot">
              발동 {r.firedAt ? localTs(r.firedAt) : ""} · 주문번호 {r.ordNo || "?"} · {r.msg || "체결 대기"}
            </div>
          )}
          {(r.status === "filled" || r.status === "failed" || r.status === "expired" || r.status === "cancelled") && (
            <div className={`ord-wcard-foot${r.status === "failed" ? " bad" : ""}`}>
              {r.status === "filled" && r.fillPrice ? `${(r.fillQty ?? 0).toLocaleString()}주 @ ${r.fillPrice.toLocaleString()} 체결 · ` : ""}
              {r.msg || ""} {r.firedAt ? `· ${localTs(r.firedAt)}` : ""}
            </div>
          )}
          {waiting && (onEdit || onCancel) && (
            <div className="ord-wcard-acts">
              {onEdit && !confirming && (
                <button type="button" className={`ord-x edit${editing ? " on" : ""}`} disabled={busy} onClick={onEdit}>
                  ✏️ 수정
                </button>
              )}
              {onCancel && !confirming && (
                <button type="button" className="ord-x" disabled={busy} onClick={() => setConfirming(true)}>
                  취소
                </button>
              )}
              {onCancel && confirming && (
                <div className="ord-wcard-confirm">
                  <span>
                    {t.name} {sideKo} {t.qty}주 감시를 취소할까요?
                  </span>
                  <button type="button" className="ord-x danger" disabled={busy} onClick={() => void doCancel()}>
                    {busy ? "…" : "취소하기"}
                  </button>
                  <button type="button" className="ord-x" disabled={busy} onClick={() => setConfirming(false)}>
                    아니오
                  </button>
                </div>
              )}
            </div>
          )}
          {cancelErr && <p className="ord-err ord-wcard-err">{cancelErr}</p>}
        </div>
      )}
    </div>
  );
}

/* ── 미체결·체결 ────────────────────────────────────────────────────────── */

/**
 * 주기 조회 (2026-09-07 밤 손질) — 벤티지: "체결/미체결은 클릭하면 반응도 느리고 미체결은 아예 화면이 안 나오네."
 * ① 겹치지 않는다 — 앞 조회가 안 끝났으면 다음 틱은 건너뛴다(느린 키움에 요청이 쌓이던 것)
 * ② 실패해도 **옛 줄은 남긴다** — 화면이 비는 대신 「읽기 실패 · 마지막 hh:mm:ss」
 * ③ 읽은 시각·걸린 시간을 돌려준다 — 「느리다」가 몇 초인지 화면에 적힌다
 */
function useRows(fetcher: () => Promise<{ rows: OrderRow[] }>, ms: number) {
  const [rows, setRows] = useState<OrderRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [readAt, setReadAt] = useState<Date | null>(null);
  const [tookMs, setTookMs] = useState(0);
  const inflight = useRef(false);

  const run = useCallback(() => {
    if (inflight.current) return;
    inflight.current = true;
    setBusy(true);
    const t0 = Date.now();
    void fetcher()
      .then((r) => {
        setRows(r.rows ?? []);
        setError(null);
        setReadAt(new Date());
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "조회 실패"))
      .finally(() => {
        inflight.current = false;
        setTookMs(Date.now() - t0);
        setBusy(false);
        setLoading(false);
      });
  }, [fetcher]);

  useEffect(() => {
    run();
    const t = setInterval(run, ms);
    return () => clearInterval(t);
  }, [run, ms]);

  return { rows, error, loading, busy, readAt, tookMs, reload: run };
}

function ReadMeta({ readAt, tookMs, busy, error }: { readAt: Date | null; tookMs: number; busy: boolean; error: string | null }) {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    <div className={`ord-readmeta${error ? " bad" : ""}`}>
      {busy ? "읽는 중…" : readAt ? `${p(readAt.getHours())}:${p(readAt.getMinutes())}:${p(readAt.getSeconds())} 읽음` : "아직 못 읽음"}
      {tookMs > 0 && ` · ${tookMs >= 1000 ? `${(tookMs / 1000).toFixed(1)}초` : `${tookMs}ms`}`}
      {error && ` · 마지막 읽기 실패: ${error}`}
    </div>
  );
}

function OpenTab({ status, onDone }: { status: OrderStatus; onDone: () => void }) {
  const { rows, error, loading, busy, readAt, tookMs, reload } = useRows(api.orderOpen, 5000);
  const [ticket, setTicket] = useState<{ nonce: string; expiresAt: number; ticket: CancelTicket | ModifyTicket } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function cancel(r: OrderRow) {
    setMsg(null);
    try {
      const t = await api.orderCancelPrepare({
        ordNo: r.ordNo,
        code: r.code,
        name: r.name,
        qty: r.remain || r.qty,
        venue: (r.venue as OrderVenue) || "KRX",
      });
      setTicket(t);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "취소 주문서를 못 만들었다");
      if (isGone(e)) onDone();
    }
  }

  return (
    <div className="ord-tab">
      <ReadMeta readAt={readAt} tookMs={tookMs} busy={busy} error={error} />
      {loading && <p className="empty">불러오는 중…</p>}
      {msg && <p className="ord-err">{msg}</p>}
      {!loading && rows.length === 0 && !error && <p className="empty">미체결 주문이 없다</p>}
      {!loading && rows.length === 0 && error && <p className="empty">미체결을 못 읽었다 — 위 이유. 5초마다 다시 시도한다</p>}
      {rows.length > 0 && (
        <div className="ord-scroll">
          <table className="ord-table stack">
            <thead>
              <tr>
                <th>시각</th>
                <th>종목</th>
                <th>구분</th>
                <th className="r">주문</th>
                <th className="r">체결</th>
                <th className="r">남은</th>
                <th className="r">가격</th>
                <th className="r">발동가</th>
                <th>상태</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.ordNo}-${r.time}`}>
                  <td data-l="시각" className="ord-when">{hms(r.time)}</td>
                  <td className="ord-name">
                    <SideChip side={r.side} /> {r.name || r.code} <span className="ord-code">{r.code}</span>
                    <span className="ord-name-sub">
                      {hms(r.time)} · {r.status || "접수"}
                    </span>
                  </td>
                  <td data-l="구분">{r.side || "-"}</td>
                  <td className="r" data-l="주문">{fmtNum(r.qty)}주</td>
                  <td className="r" data-l="체결">{fmtNum(r.filled)}주</td>
                  <td className="r" data-l="남은">
                    <b>{fmtNum(r.remain)}주</b>
                  </td>
                  <td className="r" data-l="가격">{r.price ? `${r.price.toLocaleString()}원` : "시장가"}</td>
                  <td className="r" data-l="발동가">{r.stopPrice ? `${r.stopPrice.toLocaleString()}원` : ""}</td>
                  <td data-l="상태">{r.status || "-"}</td>
                  <td className="ord-open-acts">
                    {/* 정정은 주문 탭의 「정정/취소」에서 — 호가를 눌러 값을 고치는 손이 거기 있다 (2026-09-08) */}
                    <a className="ord-x" href={`#/order?stk=${r.code}&name=${encodeURIComponent(r.name)}&amend=${r.ordNo}`}>
                      정정
                    </a>
                    <button type="button" className="ord-x" onClick={() => void cancel(r)}>
                      취소
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {ticket && (
        <Confirm
          nonce={ticket.nonce}
          expiresAt={ticket.expiresAt}
          ticket={ticket.ticket}
          status={status}
          onClose={() => setTicket(null)}
          onDone={() => {
            setTicket(null);
            reload();
            onDone();
          }}
        />
      )}
    </div>
  );
}

function FillsTab() {
  const { rows, error, loading, busy, readAt, tookMs } = useRows(api.orderFills, 8000);
  return (
    <div className="ord-tab">
      <ReadMeta readAt={readAt} tookMs={tookMs} busy={busy} error={error} />
      {loading && <p className="empty">불러오는 중…</p>}
      {!loading && rows.length === 0 && !error && <p className="empty">오늘 체결이 없다</p>}
      {!loading && rows.length === 0 && error && <p className="empty">체결을 못 읽었다 — 위 이유. 8초마다 다시 시도한다</p>}
      {rows.length > 0 && (
        <div className="ord-scroll">
          <table className="ord-table stack">
            <thead>
              <tr>
                <th>시각</th>
                <th>종목</th>
                <th>구분</th>
                {/* 낸 양과 체결된 양을 갈라 적는다 — 부분체결이 표에서 안 보였다 (2026-09-08) */}
                <th className="r">주문 / 체결</th>
                <th className="r">체결가</th>
                <th className="r">체결 금액</th>
                <th>주문번호</th>
                <th>상태</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.ordNo}-${i}`}>
                  <td data-l="시각" className="ord-when">{hms(r.time)}</td>
                  <td className="ord-name">
                    <SideChip side={r.side} /> {r.name || r.code} <span className="ord-code">{r.code}</span>
                    <span className="ord-name-sub">
                      {hms(r.time)} · {r.status || "체결"} · #{r.ordNo}
                    </span>
                  </td>
                  <td data-l="구분">{r.side || "-"}</td>
                  {/* 부분체결이면 두 수가 다르다 — 같으면 앞의 흐린 숫자가 눈에 안 밟힌다 */}
                  <td className="r" data-l="주문 / 체결">
                    {r.qty > 0 && r.qty !== (r.filled || r.qty) && <span className="ord-dim">{fmtNum(r.qty)} / </span>}
                    <b>{fmtNum(r.filled || r.qty)}</b>주
                  </td>
                  <td className="r" data-l="체결가">{r.price ? `${r.price.toLocaleString()}원` : "-"}</td>
                  <td className="r" data-l="체결 금액">
                    {r.price ? (
                      <>
                        <b>{manwon(r.price * (r.filled || r.qty))}</b>
                        <small className="ord-dim2">{Math.round(r.price * (r.filled || r.qty)).toLocaleString()}원</small>
                      </>
                    ) : (
                      "-"
                    )}
                  </td>
                  <td data-l="주문번호">{r.ordNo}</td>
                  <td data-l="상태">{r.status || "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="ord-note">
        체결되면 이 표를 안 보고 있어도 <b>알림함(종)과 텔레그램</b>이 먼저 울린다 — 우리가 낸 주문만 감시한다.
      </p>
    </div>
  );
}

/**
 * 잔고 — **손절선을 여기서 적는다** (2026-09-04).
 *
 * 벤티지: "그걸 복기노트에서 하면 안되지 주문메뉴의 계좌에서 해야지."
 *
 * 맞다. 어제까지 손절선은 복기 노트의 매수 기록에만 붙었는데, 그건 「돌아보며 적는 장부」지
 * 「지금 들고 있는 것」이 아니다. 계좌에 있는데 복기 노트에 안 적은 종목은 감시가 안 됐다.
 * 이제 **들고 있는 줄에 바로** 적고, 그 값으로 손절 감시가 돌고, 옆 단추가 스톱주문을 연다.
 */
/* ── 포지션 (개편 ①) ────────────────────────────────────────────────────── */

/**
 * 포지션 탭 — 종목 하나가 카드 하나. 잔고·감시·미체결·체결·출구가 한 장에 있고, **출구 없는 포지션은 빨갛다.**
 * 위에는 진입 대기(매수 감시), 아래에는 보유가 없는 미체결. 「＋ 감시 걸기」가 감시 폼을 연다.
 */
function PositionsTab({ status, prefill, onDone, onSelectStock }: { status: OrderStatus; prefill: Prefill; onDone: () => void; onSelectStock?: (code: string, name: string) => void }) {
  const [view, setView] = useState<PositionsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showForm, setShowForm] = useState<boolean>(Boolean(prefill.watch));
  const [editing, setEditing] = useState<AutoWatch | null>(null);
  const [openIds, setOpenIds] = useState<Record<string, boolean>>({});
  const [ticket, setTicket] = useState<{ nonce: string; expiresAt: number; ticket: OrderTicket } | null>(null);
  const [stopEdit, setStopEdit] = useState<Record<string, string>>({});
  const inflight = useRef(false);
  /* 폰에서는 포지션 카드가 접혀서 시작한다 — 벤티지: "카드들이 너무 커서 모바일로 보기에는 불편해" */
  const narrow = useNarrow();
  const [openPos, setOpenPos] = useState<Record<string, boolean>>({});
  /* 표에서는 모두 접혀서 시작 — 줄을 누르면 그 종목만 펼친다 (영웅문S 도 그렇다) */
  const posOpen = (code: string) => Boolean(openPos[code]);
  const [kbOpen, setKbOpen] = useState(true);
  const [twoLine, setTwoLine] = useState(true);
  void narrow;

  const load = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    try {
      const v = await api.orderPositions();
      setView(v);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "조회 실패");
    } finally {
      inflight.current = false;
    }
  }, []);
  /* 체결 알림이 오면 즉시 — 5초 폴링을 기다리지 않는다 (2026-09-08 벤티지 "동기화 바로바로") */
  useEffect(() => {
    const f = () => void load();
    window.addEventListener("vntg:fill", f);
    return () => window.removeEventListener("vntg:fill", f);
  }, [load]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5_000);
    return () => clearInterval(t);
  }, [load]);
  useEffect(() => {
    if (prefill.watch) setShowForm(true);
  }, [prefill.key, prefill.watch]);

  const toggle = (id: string) => setOpenIds((m) => ({ ...m, [id]: !m[id] }));

  /**
   * 감시 취소. 확인은 카드가 받고(`WatchCard`), 실패도 카드가 받아 그 자리에 적는다 —
   * 그래서 여기서는 묻지도 잡지도 않는다. `window.confirm` 을 쓰던 시절엔 홈 화면
   * 앱에서 창이 안 떠 취소가 통째로 무시됐다.
   */
  async function cancelWatch(r: AutoWatch) {
    setBusy(r.id);
    try {
      await api.orderWatchCancel(r.id);
      await load();
      onDone();
    } finally {
      setBusy(null);
    }
  }

  /** 자동 손절 — 값 이하면 남은 수량을 시장가로. 확인 창·비밀번호를 지난다 */
  async function armStop(pos: Position, raw: string) {
    const price = Number(raw.replace(/\D/g, "")) || 0;
    const qty = pos.freeQty;
    if (price <= 0) return;
    if (qty <= 0) {
      setError(`${pos.name} — 남은 수량이 없다. 감시를 하나 지우거나 미체결 매도를 취소해야 건다`);
      return;
    }
    setBusy(pos.code);
    setError(null);
    try {
      const until = new Date(Date.now() + 30 * 86400_000 + 9 * 3600_000).toISOString().slice(0, 10);
      const r = await api.orderPrepare({
        side: "sell",
        code: pos.code,
        name: pos.name,
        qty,
        price: null,
        condPrice: null,
        tradeType: "3",
        venue: "KRX",
        credit: false,
        loanDate: null,
        watch: { dir: "le", basis: "price", pct: null, price, exec: "market", limitPrice: null, validUntil: until, then: null, legs: null, replaceId: null, dual: true },
      });
      setTicket(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : "자동 손절 주문서를 못 만들었다");
      if (isGone(e)) onDone();
    } finally {
      setBusy(null);
    }
  }

  if (error && !view)
    return (
      <div className="ord-tab">
        <p className="ord-err">{error}</p>
      </div>
    );
  if (!view)
    return (
      <div className="ord-tab">
        <p className="empty">불러오는 중…</p>
      </div>
    );

  const noExitCount = view.positions.filter((x) => x.noExit).length;
  const tickAgo = status.watchTickAgoSec;
  const loopBad = tickAgo !== null && tickAgo !== undefined && tickAgo > 90;

  return (
    <div className="ord-tab">
      {error && <p className="ord-err">{error}</p>}
      {/*
        영웅문S 잔고 화면을 따라 (2026-09-07 밤, 벤티지가 캡처를 보내며 "유사하게 만들어봐"):
        「총 손익 | −710 원 | −3.80%」 머리 → 총 매입 / 총 평가 / 실현손익 / 추정자산 2×2 → 종목 표(두 줄 칸).
      */}
      <div className={`kb ${view.pnlTotal > 0 ? "up" : view.pnlTotal < 0 ? "down" : ""}`}>
        <button type="button" className="kb-head" onClick={() => setKbOpen((v) => !v)} aria-expanded={kbOpen}>
          <span className="kb-title">총 손익</span>
          <b className="kb-pnl">
            {view.pnlTotal > 0 ? "+" : view.pnlTotal < 0 ? "−" : ""}
            {Math.abs(Math.round(view.pnlTotal)).toLocaleString()} <i>원</i>
          </b>
          <em className="kb-rate">{pctKo(view.pnlRateTotal)}</em>
          <span className="kb-arrow">{kbOpen ? "︿" : "﹀"}</span>
        </button>
        {kbOpen && (
          <>
          <div className="kb-grid">
            <div className="kb-cell">
              <span>총 매입</span>
              <b>{Math.round(view.investTotal).toLocaleString()}</b>
            </div>
            <div className="kb-cell">
              <span>총 평가</span>
              <b>{Math.round(view.valueTotal).toLocaleString()}</b>
            </div>
            <div className="kb-cell">
              <span>실현손익</span>
              <b className={signClass(view.realizedToday ?? 0)}>{view.realizedToday === null ? "-" : Math.round(view.realizedToday).toLocaleString()}</b>
            </div>
            <div className="kb-cell">
              <span>추정자산</span>
              <b>{Math.round(view.totalAsset ?? view.equity).toLocaleString()}</b>
            </div>
            <div className="kb-cell">
              <span>예수금</span>
              <b>{Math.round(view.deposit).toLocaleString()}</b>
              {view.accountError && <small className="ord-bad">못 읽음</small>}
            </div>
            <div className="kb-cell">
              <span>오늘 감시 실현</span>
              <b className={signClass(view.todayLoss)}>{view.todayLoss !== 0 ? Math.round(view.todayLoss).toLocaleString() : "0"}</b>
            </div>
          </div>
          {view.accountError && (
            <p className="ord-bad" style={{ margin: "0.3rem 0 0", fontSize: "0.8rem" }}>
              ⚠️ 계좌 조회 실패 — {view.accountError}. 위 예수금·보유는 「없다」가 아니라 <b>못 읽은 것</b>이다.
            </p>
          )}
          </>
        )}
      </div>
      <div className="ord-acct">
        {view.todayLoss !== 0 && (
          <span className={`ord-stat ${signClass(view.todayLoss)}`}>
            <i>오늘 실현</i>
            <b>{manwon(view.todayLoss)}</b>
          </span>
        )}
        <span className={`ord-stat${loopBad ? " bad" : ""}`} title="자동감시 루프가 마지막으로 돈 지">
          <i>감시</i>
          <b>{tickAgo === null || tickAgo === undefined ? "아직" : loopBad ? `${tickAgo}초 멎음` : "살아 있음"}</b>
        </span>
        {view.buyLocked && <span className="ord-stat bad">🔒 {view.buyLocked}</span>}
        {noExitCount > 0 && <span className="ord-stat bad">⚠️ 출구 없는 포지션 {noExitCount}</span>}
      </div>

      {/*
        감시 파일을 못 읽었다 (2026-09-08 검진 9). 카드에 손절선이 안 보이는 것이 「없다」가
        아니라 「못 읽었다」임을 말해야 한다 — 이 띠가 없으면 출구가 사라진 줄도 모른다.
      */}
      {view.watchError && (
        <div className="error-banner">
          ⚠️ 자동감시 기록(orderWatch.json)을 못 읽었다 — 아래 카드의 손절·출구 표시는 <b>비어 있는 것</b>이지
          없는 것이 아니다. 서버에서 파일을 확인하라. ({view.watchError})
        </div>
      )}

      <div className="kb-bar">
        <span className="kb-bar-l">
          보유 <b>{view.positions.length}</b>종목
          {noExitCount > 0 && <i className="ord-noexit">⚠️ 출구 없음 {noExitCount}</i>}
        </span>
        <span className="kb-seg">
          <button type="button" className={twoLine ? "on" : ""} onClick={() => setTwoLine(true)}>
            2줄
          </button>
          <button type="button" className={!twoLine ? "on" : ""} onClick={() => setTwoLine(false)}>
            1줄
          </button>
        </span>
      </div>
      {view.positions.length === 0 ? (
        <p className="empty">이 계좌에 보유 종목이 없다</p>
      ) : (
        <div className={`kb-table${twoLine ? " two" : " one"}`}>
          <div className="kb-th">
            <span className="kb-c-name">종목명</span>
            <span className="kb-c">
              매입가{twoLine && <small>현재가</small>}
            </span>
            <span className="kb-c">
              보유수량{twoLine && <small>가능수량</small>}
            </span>
            {/*
              **접힌 줄에서도 돈이 보여야 한다** (2026-09-08 — 벤티지: "접혔을 때 매수총액
              손익 이렇게 보여줘야지"). 단가와 수량만 있으면 곱셈은 사람 몫이었다.
            */}
            <span className="kb-c">
              매수금액{twoLine && <small>평가금액</small>}
            </span>
            <span className="kb-c">
              평가손익{twoLine && <small>수익률</small>}
            </span>
          </div>
          {view.positions.map((pos) => {
            const price = view.prices[pos.code]?.price ?? pos.cur;
            const pnl = (price - pos.avg) * pos.qty;
            const rate = pos.avg > 0 ? ((price - pos.avg) / pos.avg) * 100 : 0;
            const isOpen = posOpen(pos.code);
            return (
              <div key={pos.code} className={`kb-row${isOpen ? " open" : ""}${pos.noExit ? " noexit" : ""}`}>
                <button type="button" className="kb-tr" onClick={() => setOpenPos((m) => ({ ...m, [pos.code]: !isOpen }))}>
                  <span className="kb-c-name">
                    <b>{pos.name || pos.code}</b>
                    <small>
                      {pos.creditType ? `${pos.creditType} · ` : ""}
                      {pos.noExit ? <i className="ord-bad">출구 없음</i> : <i>손절 {pos.stopLine ? fmtNum(pos.stopLine) : "-"}</i>}
                      {/*
                        「👁17」이 뭔지 아무도 모른다 (2026-09-08 벤티지). **감시 주문이 걸린
                        수량**이다 — 보유 74주 중 74주에 매도 감시가 걸려 있으면 「감시 74주」.
                        그림쇠 하나로 줄이지 말고 말로 적는다.
                      */}
                      {pos.watchQty > 0 && (
                        <i className="kb-watch" title={`매도 감시가 걸린 수량입니다 — 보유 ${fmtNum(pos.qty)}주 중 ${fmtNum(pos.watchQty)}주`}>
                          · <i className="ord-eye">👁</i> 감시 <b>{fmtNum(pos.watchQty)}</b>주
                        </i>
                      )}
                    </small>
                  </span>
                  <span className="kb-c">
                    <b>{fmtNum(pos.avg)}</b>
                    {twoLine && <small className={signClass(pnl)}>{fmtNum(price)}</small>}
                  </span>
                  <span className="kb-c">
                    <b>{fmtNum(pos.qty)}</b>
                    {twoLine && <small>{fmtNum(pos.ableQty)}</small>}
                  </span>
                  <span className="kb-c">
                    <b>{Math.round(pos.avg * pos.qty).toLocaleString()}</b>
                    {twoLine && <small>{Math.round(price * pos.qty).toLocaleString()}</small>}
                  </span>
                  <span className={`kb-c ${signClass(pnl)}`}>
                    <b>{Math.round(pnl).toLocaleString()}</b>
                    {twoLine && <small>{pctKo(rate)}</small>}
                  </span>
                </button>
                {isOpen && (
                  <div className="kb-detail">
                    <PositionCard
                      pos={pos}
                      cur={view.prices[pos.code] ?? null}
                      busy={busy === pos.code}
                      stopValue={stopEdit[pos.code] ?? ""}
                      onStopChange={(v) => setStopEdit((m) => ({ ...m, [pos.code]: v }))}
                      onArmStop={() => void armStop(pos, stopEdit[pos.code] ?? "")}
                      onCancelWatch={(w) => cancelWatch(w)}
                      onEditWatch={(w) => {
                        setEditing(w);
                        setShowForm(true);
                      }}
                      openIds={openIds}
                      onToggle={toggle}
                      onSelectStock={onSelectStock}
                      open
                      onToggleOpen={() => setOpenPos((m) => ({ ...m, [pos.code]: false }))}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="ord-wt-head">
        <h4 className="ord-h4">
          진입 대기 {view.entries.length > 0 && <span className="ord-count">{view.entries.length}</span>}
          <i className="ord-h4-sub">조건에 닿으면 사는 매수 감시</i>
        </h4>
        <button type="button" className={`ord-wt-new${showForm ? " on" : ""}`} onClick={() => setShowForm((v) => !v)}>
          {showForm ? "폼 접기" : "＋ 감시 걸기"}
        </button>
      </div>
      {view.entries.length === 0 ? (
        <p className="empty">기다리는 매수 감시가 없다</p>
      ) : (
        <div className="ord-wcards">
          {view.entries.map((r) => (
            <WatchCard
              key={r.id}
              r={r}
              cur={view.prices[r.ticket.code] ?? null}
              busy={busy === r.id}
              onCancel={() => cancelWatch(r)}
              onEdit={() => {
                setEditing(r);
                setShowForm(true);
              }}
              editing={editing?.id === r.id}
              open={Boolean(openIds[r.id])}
              onToggle={() => toggle(r.id)}
            />
          ))}
        </div>
      )}

      {showForm && (
        <WatchForm
          key={editing?.id ?? "new"}
          status={status}
          prefill={prefill}
          edit={editing}
          onCancelEdit={() => setEditing(null)}
          onDone={() => {
            setEditing(null);
            void load();
            onDone();
          }}
        />
      )}

      {view.orphanOpen.length > 0 && (
        <>
          <h4 className="ord-h4">보유가 없는 미체결</h4>
          <div className="ord-plines">
            {view.orphanOpen.map((o) => (
              <div key={o.ordNo} className="ord-pline">
                <SideChip side={o.side} /> {o.name} <span className="ord-code">{o.code}</span> · {o.remain}/{o.qty}주 · {o.price ? `${o.price.toLocaleString()}원` : "시장가"} · {o.time} {o.status}
              </div>
            ))}
          </div>
          <p className="ord-caps">취소는 기록 탭 › 미체결에서</p>
        </>
      )}

      <p className="ord-note">
        <b>자동 손절</b> — 값 + Enter → 「그 값 이하면 남은 수량 시장가 매도」 감시 주문서 → 확인·비밀번호. 그 뒤는 서버가 정규장에 보다가 팔고,
        {status.guard.dualStop !== false ? " 아침마다 키움 스톱지정가도 같이 걸어 서버가 죽어도 키움이 판다(🛡)." : " 키움 스톱은 꺼져 있다(orderGuard.dualStop)."}
        {" "}단계로 나누거나 익절을 섞으려면 「출구 걸기」.
      </p>

      {ticket && (
        <Confirm
          nonce={ticket.nonce}
          expiresAt={ticket.expiresAt}
          ticket={ticket.ticket}
          status={status}
          onClose={() => setTicket(null)}
          onDone={() => {
            setTicket(null);
            setStopEdit({});
            void load();
            onDone();
          }}
        />
      )}
    </div>
  );
}

function PositionCard({
  pos,
  cur,
  busy,
  stopValue,
  onStopChange,
  onArmStop,
  onCancelWatch,
  onEditWatch,
  openIds,
  onToggle,
  onSelectStock,
  open,
  onToggleOpen,
}: {
  pos: Position;
  cur: { price: number; from: string } | null;
  busy: boolean;
  stopValue: string;
  onStopChange: (v: string) => void;
  onArmStop: () => void;
  onCancelWatch: (w: AutoWatch) => Promise<void>;
  onEditWatch: (w: AutoWatch) => void;
  openIds: Record<string, boolean>;
  onToggle: (id: string) => void;
  onSelectStock?: (code: string, name: string) => void;
  open: boolean;
  onToggleOpen: () => void;
}) {
  const price = cur?.price ?? pos.cur;
  const pnl = (price - pos.avg) * pos.qty;
  const pnlRate = pos.avg > 0 ? ((price - pos.avg) / pos.avg) * 100 : 0;
  const room = pos.stopLine && price > 0 ? ((price - pos.stopLine) / price) * 100 : null;
  /* 매도 링크 수량은 ableQty 가 아니라 freeQty+watchQty — ableQty 엔 이중 스톱이 문 수량이 빠져 폼이 0주로 열렸다 (2차 검진 🟠C-4) */
  const h: OrderHolding = { code: pos.code, name: pos.name, qty: pos.qty, ableQty: Math.max(pos.ableQty, pos.freeQty + pos.watchQty), avg: pos.avg, cur: pos.cur, pnl: pos.pnl, pnlRate: pos.pnlRate, creditType: pos.creditType, loanDate: pos.loanDate };
  const sells = pos.watches.filter((w) => w.ticket.side === "sell");
  const stopW = sells.find((w) => w.status === "waiting" && w.spec.dir === "le" && w.spec.trigger === pos.stopLine) ?? null;
  return (
    <div className={`ord-pcard${pos.noExit ? " noexit" : ""}${pnl < 0 ? " down" : " up"}${open ? " open" : " closed"}`}>
      <div className="ord-pcard-top" onClick={onToggleOpen} role="button" tabIndex={0}>
        <button
          type="button"
          className="ord-pcard-name"
          onClick={(e) => {
            e.stopPropagation();
            onSelectStock?.(pos.code, pos.name);
          }}
          title="종목 상세"
        >
          {pos.name} <span className="ord-code">{pos.code}</span>
        </button>
        {pos.creditType && (
          <span className="ord-crd-badge" title={`대출일 ${pos.loanDate ?? "?"}`}>
            {pos.creditType} {pos.loanDate ? `${pos.loanDate.slice(4, 6)}/${pos.loanDate.slice(6)}` : ""}
          </span>
        )}
        {pos.boughtByWatch && <span className="ord-watch-badge"><i className="ord-eye">👁</i> 감시로 삼</span>}
        {pos.noExit ? <span className="ord-noexit">⚠️ 출구 없음</span> : <span className="ord-hasexit">🛡 출구 있음</span>}
        <span className={`ord-pcard-pnl ${signClass(pnl)}`}>
          {pnl >= 0 ? "+" : ""}
          {Math.round(pnl).toLocaleString()}원 <small>({pnlRate >= 0 ? "+" : ""}{pnlRate.toFixed(2)}%)</small>
        </span>
        <i className="ord-wcard-arrow">{open ? "▲" : "▼"}</i>
      </div>
      {!open && (
        <div className="ord-pcard-brief">
          <span>{fmtNum(pos.qty)}주 · 평가 {manwon(price * pos.qty)}</span>
          <span className={pos.stopLine ? "" : "ord-bad"}>손절 {pos.stopLine ? fmtNum(pos.stopLine) : "없음"}</span>
          {pos.takeLine && <span>익절 {fmtNum(pos.takeLine)}</span>}
          {pos.watchQty > 0 && <span>👁 {pos.watchQty}</span>}
          {pos.freeQty > 0 && <span className="positive">남은 {pos.freeQty}</span>}
        </div>
      )}
      {open && (
      <>
      <div className="ord-pcard-money">
        매입 <b>{Math.round(pos.avg * pos.qty).toLocaleString()}</b>원 → 평가 <b className={signClass(pnl)}>{Math.round(price * pos.qty).toLocaleString()}</b>원
      </div>

      <div className="ord-qs">
        <span className="ord-qs-c">
          보유 <b>{fmtNum(pos.qty)}</b>주
        </span>
        {pos.pendingQty > 0 && <span className="ord-qs-c dim">주문 중 {fmtNum(pos.pendingQty)}</span>}
        {/*
          이모지 바로 뒤의 숫자는 폰에서 이모지 글꼴로 이어져 찍혀 「1 6 5」처럼 벌어지고 흐렸다
          (2026-09-08 벤티지 "감시 안에 숫자 좀 잘 보이게"). 이모지를 제 상자에 가두고 숫자는 <b>.
        */}
        {pos.watchQty > 0 && (
          <span className="ord-qs-c watch">
            <i className="ord-eye">👁</i> 감시 <b>{fmtNum(pos.watchQty)}</b>주
          </span>
        )}
        <span className={`ord-qs-c free${pos.freeQty > 0 ? " on" : ""}`}>
          남은 <b>{fmtNum(pos.freeQty)}</b>주
        </span>
      </div>

      <div className="ord-pcard-grid">
        <div className="ord-wcard-cell">
          <dt>평단</dt>
          <dd>{fmtNum(pos.avg)}</dd>
        </div>
        <div className="ord-wcard-cell">
          <dt>지금 값</dt>
          <dd>
            {fmtNum(price)}
            {cur && <small>({cur.from})</small>}
          </dd>
        </div>
        <div className="ord-wcard-cell">
          <dt>손절선</dt>
          <dd className={pos.stopLine ? "" : "ord-bad"}>
            {pos.stopLine ? `${fmtNum(pos.stopLine)}` : "없음"}
            {pos.kiwoomStop && <small title={`키움 스톱지정가 미체결 #${pos.kiwoomStop.ordNo}`}>🛡 키움</small>}
          </dd>
          {room !== null && <small className={room < 0 ? "ord-bad" : ""}>여유 {room.toFixed(1)}%</small>}
        </div>
        <div className="ord-wcard-cell">
          <dt>익절선</dt>
          <dd>{pos.takeLine ? fmtNum(pos.takeLine) : "-"}</dd>
        </div>
      </div>

      {pos.watches.length > 0 && (
        <div className="ord-pcard-watches">
          {pos.watches.map((w) => (
            <WatchCard key={w.id} r={w} cur={cur} busy={busy} onCancel={() => onCancelWatch(w)} onEdit={() => onEditWatch(w)} editing={false} open={Boolean(openIds[w.id])} onToggle={() => onToggle(w.id)} />
          ))}
        </div>
      )}

      {(pos.open.length > 0 || pos.fills.length > 0) && (
        <div className="ord-plines">
          {pos.open.map((o) => (
            <div key={o.ordNo} className="ord-pline">
              미체결 <SideChip side={o.side} /> {o.remain}/{o.qty}주 · {o.price ? `${o.price.toLocaleString()}원` : "시장가"}
              {o.stopPrice ? ` · 발동 ${o.stopPrice.toLocaleString()}` : ""} · {o.time}
            </div>
          ))}
          {pos.fills.map((f, i) => (
            <div key={`${f.ordNo}-${i}`} className="ord-pline dim">
              오늘 체결 <SideChip side={f.side} /> {f.filled}주 @ {f.price.toLocaleString()} · {f.time}
            </div>
          ))}
        </div>
      )}

      <div className="ord-pcard-acts">
        {!stopW && !pos.creditType && pos.freeQty > 0 && (
          <div className="ord-stop-arm">
            <input
              className="ord-stop-in"
              inputMode="numeric"
              placeholder={`자동 손절 값 + Enter (${pos.freeQty}주)`}
              value={stopValue}
              onChange={(e) => onStopChange(e.target.value.replace(/\D/g, ""))}
              onKeyDown={(e) => {
                if (e.key === "Enter") onArmStop();
              }}
              disabled={busy}
            />
            <button type="button" className="ord-mk" disabled={busy || !stopValue} onClick={onArmStop}>
              걸기
            </button>
          </div>
        )}
        <a className="ord-x buy" href={orderLink(h, "buy")}>
          매수
        </a>
        <a className="ord-x sell" href={orderLink(h, "sell")}>
          매도
        </a>
        {!pos.creditType && pos.freeQty > 0 && (
          <a className="ord-x watch" href={`${orderLink(h, "sell", `&watch=1&wb=avg&wp=-5&wx=market`).replace(/&qty=\d+/, "")}&qty=${pos.freeQty}`} title="단계·익절을 섞어 출구를 건다">
            🛡 출구 걸기 {pos.freeQty}주
          </a>
        )}
      </div>
      </>
      )}
    </div>
  );
}

/* ── 잔고·수익률 현황 (2026-09-07 밤) ─────────────────────────────────── */

const LEDGER_RANGES: { days: number; label: string }[] = [
  { days: 7, label: "1주" },
  { days: 30, label: "1개월" },
  { days: 90, label: "3개월" },
  { days: 180, label: "6개월" },
  { days: 365, label: "1년" },
];

function pctKo(v: number, digits = 2): string {
  return `${v > 0 ? "+" : ""}${v.toFixed(digits)}%`;
}
function signedWon(v: number): string {
  return `${v > 0 ? "+" : ""}${Math.round(v).toLocaleString()}원`;
}

/** 자산 곡선 + 일별 실현손익 막대 — 라이브러리 없이 SVG 하나 */
function LedgerChart({ assets, daily }: { assets: LedgerView["assets"]; daily: LedgerView["daily"] }) {
  const W = 640;
  const H = 180;
  const padL = 8;
  const padR = 8;
  const top = 10;
  const lineH = 110;
  const barTop = top + lineH + 14;
  const barH = H - barTop - 4;
  if (assets.length < 2 && daily.length === 0) return <p className="empty">추이가 아직 없다</p>;
  const dates = [...new Set([...assets.map((a) => a.date), ...daily.map((d) => d.date)])].sort();
  const x = (date: string) => padL + ((W - padL - padR) * dates.indexOf(date)) / Math.max(1, dates.length - 1);
  const vals = assets.map((a) => a.asset);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const y = (v: number) => top + lineH - (hi === lo ? lineH / 2 : ((v - lo) / (hi - lo)) * lineH);
  const path = assets.map((a, i) => `${i === 0 ? "M" : "L"}${x(a.date).toFixed(1)},${y(a.asset).toFixed(1)}`).join(" ");
  const area = assets.length > 1 ? `${path} L${x(assets[assets.length - 1].date).toFixed(1)},${top + lineH} L${x(assets[0].date).toFixed(1)},${top + lineH} Z` : "";
  const pmax = Math.max(1, ...daily.map((d) => Math.abs(d.pnl)));
  const mid = barTop + barH / 2;
  const bw = Math.max(2, ((W - padL - padR) / Math.max(1, dates.length)) * 0.7);
  const first = assets[0];
  const last = assets[assets.length - 1];
  return (
    <div className="ord-lchart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="자산 추이와 일별 실현손익">
        {area && <path d={area} className="ord-lchart-area" />}
        {path && <path d={path} className="ord-lchart-line" />}
        <line x1={padL} x2={W - padR} y1={mid} y2={mid} className="ord-lchart-axis" />
        {daily.map((d) => {
          const h = (Math.abs(d.pnl) / pmax) * (barH / 2);
          return <rect key={d.date} x={x(d.date) - bw / 2} y={d.pnl >= 0 ? mid - h : mid} width={bw} height={Math.max(1, h)} className={d.pnl >= 0 ? "ord-lchart-up" : "ord-lchart-down"} />;
        })}
      </svg>
      <div className="ord-lchart-legend">
        {first && last && (
          <span>
            자산 {first.date.slice(5).replace("-", "/")} <b>{manwon(first.asset)}</b> → {last.date.slice(5).replace("-", "/")} <b>{manwon(last.asset)}</b>
            {first.asset > 0 && <em className={signClass(last.asset - first.asset)}> {pctKo(((last.asset - first.asset) / first.asset) * 100)}</em>}
          </span>
        )}
        <span className="ord-caps">아래 막대 = 일별 실현손익(빨강 이익·파랑 손실)</span>
      </div>
    </div>
  );
}

function LedgerTab() {
  const [days, setDays] = useState(90);
  const [view, setView] = useState<LedgerView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sec, setSec] = useState<"daily" | "weekly" | "monthly" | "stock" | "trades">("daily");

  const load = useCallback(async (d: number) => {
    setBusy(true);
    try {
      setView(await api.orderLedger(d));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "조회 실패");
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    void load(days);
  }, [days, load]);

  if (error && !view)
    return (
      <div className="ord-tab">
        <p className="ord-err">{error}</p>
      </div>
    );
  if (!view)
    return (
      <div className="ord-tab">
        <p className="empty">잔고를 읽는 중… (키움에 여섯 가지를 묻는다)</p>
      </div>
    );
  const n = view.now;
  const total = n.totalAsset ?? n.deposit + n.valueTotal;
  const pr = view.period;
  const netRate = pr && pr.netStart > 0 ? ((pr.netEnd - pr.deposits + pr.withdrawals - pr.netStart) / pr.netStart) * 100 : null;

  return (
    <div className="ord-tab ord-ledger">
      {error && <p className="ord-err">{error}</p>}
      {/* ① 총 잔액 — 제일 큰 숫자 */}
      <div className={`ord-total ${n.pnlTotal > 0 ? "up" : n.pnlTotal < 0 ? "down" : ""}`}>
        <div className="ord-total-main">
          <i>총 잔액 (추정예탁자산)</i>
          <Krw n={total} />
        </div>
        <div className="ord-total-pnl">
          <i>보유 평가손익</i>
          <b>{signedWon(n.pnlTotal)}</b>
          <em>{pctKo(n.pnlRateTotal)}</em>
          <small>{n.pnlTotal > 0 ? "수익권" : n.pnlTotal < 0 ? "손실권" : "본전"}</small>
        </div>
        <div className="ord-total-sub">
          <span>
            예수금 <b>{Math.round(n.deposit).toLocaleString()}</b>원
          </span>
          <span>
            주문 가능 <b>{Math.round(n.orderable).toLocaleString()}</b>원
          </span>
          {n.withdrawable !== null && (
            <span>
              출금 가능 <b>{Math.round(n.withdrawable).toLocaleString()}</b>원
            </span>
          )}
          {n.d1Deposit !== null && (
            <span title="내일 결제 뒤 예수금">
              D+1 <b>{Math.round(n.d1Deposit).toLocaleString()}</b>
            </span>
          )}
          {n.d2Deposit !== null && (
            <span title="모레 결제 뒤 예수금">
              D+2 <b>{Math.round(n.d2Deposit).toLocaleString()}</b>
            </span>
          )}
          <span>
            보유 평가 <b>{Math.round(n.valueTotal).toLocaleString()}</b>원 ({n.holdings}종목)
          </span>
          <span>
            매입 <b>{Math.round(n.investTotal).toLocaleString()}</b>원
          </span>
          {n.receivable > 0 && (
            <span className="ord-bad">
              미수 <b>{Math.round(n.receivable).toLocaleString()}</b>원
            </span>
          )}
          {n.loan > 0 && (
            <span className="ord-bad">
              융자 <b>{Math.round(n.loan).toLocaleString()}</b>원
            </span>
          )}
        </div>
      </div>

      {/* ② 기간 */}
      <div className="ord-wt-head">
        <h4 className="ord-h4">
          수익률 현황 <i className="ord-h4-sub">{view.range.from.slice(5).replace("-", "/")} ~ {view.range.to.slice(5).replace("-", "/")}{busy ? " · 읽는 중…" : ""}</i>
        </h4>
        <div className="ord-hist-tabs">
          {LEDGER_RANGES.map((r) => (
            <button key={r.days} type="button" className={days === r.days ? "on" : ""} onClick={() => setDays(r.days)}>
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <div className="ord-lstats">
        {pr && (
          <>
            <div className="ord-lstat">
              <i>순자산 (기간 초 → 말)</i>
              <b>
                {manwon(pr.netStart)} → {manwon(pr.netEnd)}
              </b>
              <small>
                입금 {manwon(pr.deposits)} · 출금 {manwon(pr.withdrawals)}
              </small>
            </div>
            <div className={`ord-lstat ${signClass(pr.evalPnl)}`}>
              <i>기간 손익 (입출금 제외)</i>
              <b>{signedWon(pr.evalPnl)}</b>
              <small>수익률 {pctKo(pr.rate)}{netRate !== null && Math.abs(netRate - pr.rate) > 0.5 ? ` · 우리 셈 ${pctKo(netRate)}` : ""}</small>
            </div>
          </>
        )}
        <div className={`ord-lstat ${signClass(view.realized.pnl)}`}>
          <i>실현손익 (매도로 확정)</i>
          <b>{signedWon(view.realized.pnl)}</b>
          <small>
            {view.realized.wins + view.realized.losses}번 매매 · 승률 {view.realized.winRate.toFixed(0)}% · 수수료+세금 {manwon(view.realized.fee + view.realized.tax)}
          </small>
        </div>
        <div className="ord-lstat">
          <i>매매 규모</i>
          <b>
            매수 {manwon(view.realized.buyAmt)} · 매도 {manwon(view.realized.sellAmt)}
          </b>
          <small>{view.daily.length}일 거래</small>
        </div>
      </div>

      <LedgerChart assets={view.assets} daily={view.daily} />

      {/* ③ 표 */}
      <div className="ord-hist-tabs ord-ltabs">
        {(
          [
            ["daily", "일별"],
            ["weekly", "주별"],
            ["monthly", "월별"],
            ["stock", "종목별"],
            ["trades", "매매 내역"],
          ] as const
        ).map(([k, label]) => (
          <button key={k} type="button" className={sec === k ? "on" : ""} onClick={() => setSec(k)}>
            {label}
          </button>
        ))}
      </div>

      {sec === "daily" && (
        <LedgerPeriodTable
          rows={[...view.daily].reverse().map((d) => {
            const a = view.assets.find((x) => x.date === d.date);
            const i = view.assets.findIndex((x) => x.date === d.date);
            const prev = i > 0 ? view.assets[i - 1] : null;
            return {
              key: d.date,
              label: d.date.slice(2).replace(/-/g, "."),
              from: d.date,
              to: d.date,
              assetEnd: a?.asset ?? null,
              assetChange: a && prev ? a.asset - prev.asset : null,
              assetChangeRate: a && prev && prev.asset > 0 ? ((a.asset - prev.asset) / prev.asset) * 100 : null,
              pnl: d.pnl,
              buyAmt: d.buyAmt,
              sellAmt: d.sellAmt,
              cost: d.fee + d.tax,
              days: 1,
            };
          })}
          unit="일"
        />
      )}
      {sec === "weekly" && <LedgerPeriodTable rows={view.weekly} unit="주" />}
      {sec === "monthly" && <LedgerPeriodTable rows={view.monthly} unit="월" />}
      {sec === "stock" &&
        (view.byStock.length === 0 ? (
          <p className="empty">이 기간에 판 종목이 없다</p>
        ) : (
          <div className="ord-scroll">
            <table className="ord-table stack">
              <thead>
                <tr>
                  <th>종목</th>
                  <th className="r">실현손익</th>
                  <th className="r">평균 수익률</th>
                  <th className="r">매매</th>
                  <th className="r">승률</th>
                  <th className="r">최고 / 최저</th>
                  <th>마지막</th>
                </tr>
              </thead>
              <tbody>
                {view.byStock.map((s) => (
                  <tr key={s.code}>
                    <td className="ord-name">
                      {s.name || s.code} <span className="ord-code">{s.code}</span>
                    </td>
                    <td className={`r ${signClass(s.pnl)}`} data-l="실현손익">{signedWon(s.pnl)}</td>
                    <td className={`r ${signClass(s.avgRate)}`} data-l="평균 수익률">{pctKo(s.avgRate)}</td>
                    <td className="r" data-l="매매">{s.trades}번 · {fmtNum(s.qty)}주</td>
                    <td className="r" data-l="승률">{s.trades > 0 ? `${((s.wins / s.trades) * 100).toFixed(0)}%` : "-"}</td>
                    <td className="r" data-l="최고 / 최저">
                      <span className="positive">{pctKo(s.bestRate)}</span> / <span className="negative">{pctKo(s.worstRate)}</span>
                    </td>
                    <td data-l="마지막">{s.lastDate.slice(5).replace("-", "/")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      {sec === "trades" &&
        (view.trades.length === 0 ? (
          <p className="empty">이 기간에 매도 체결이 없다</p>
        ) : (
          <div className="ord-scroll">
            <table className="ord-table stack">
              <thead>
                <tr>
                  <th>일자</th>
                  <th>종목</th>
                  <th className="r">수량</th>
                  <th className="r">매입가 → 매도가</th>
                  <th className="r">손익</th>
                  <th className="r">수익률</th>
                </tr>
              </thead>
              <tbody>
                {view.trades.map((t, i) => (
                  <tr key={`${t.date}-${t.code}-${i}`}>
                    <td data-l="일자">{t.date.slice(2).replace(/-/g, ".")}</td>
                    <td className="ord-name">
                      {t.name || t.code} <span className="ord-code">{t.code}</span>
                      <span className="ord-name-sub">{t.date.slice(5).replace("-", "/")}</span>
                    </td>
                    <td className="r" data-l="수량">{fmtNum(t.qty)}주</td>
                    <td className="r" data-l="매입가 → 매도가">
                      {fmtNum(t.buyPrice)} → {fmtNum(t.sellPrice)}
                    </td>
                    <td className={`r ${signClass(t.pnl)}`} data-l="손익">{signedWon(t.pnl)}</td>
                    <td className={`r ${signClass(t.pnlRate)}`} data-l="수익률">{pctKo(t.pnlRate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}

      {view.missing.length > 0 && (
        <p className="ord-caps">
          키움이 안 준 것: {view.missing.join(" · ")} — 모의투자는 일부 계좌 조회를 안 준다. 실전 계좌에서 다시 확인.
        </p>
      )}
      <p className="ord-note">
        <b>총 잔액</b>은 키움의 추정예탁자산(예수금 + 보유 평가 − 미수·융자), <b>기간 손익</b>은 키움이 입출금을 뺀 순자산으로 잰 값, <b>실현손익</b>은 매도로 확정된 것만(수수료·세금 별도).
        보유 중인 종목의 평가손익은 실현손익에 안 들어간다. 60초마다 새로 읽는다.
      </p>
    </div>
  );
}

function LedgerPeriodTable({ rows, unit }: { rows: LedgerPeriodRow[]; unit: string }) {
  if (rows.length === 0) return <p className="empty">이 기간에 기록이 없다</p>;
  return (
    <div className="ord-scroll">
      <table className="ord-table stack">
        <thead>
          <tr>
            <th>{unit}</th>
            <th className="r">자산 (말)</th>
            <th className="r">증감</th>
            <th className="r">실현손익</th>
            <th className="r">매수 / 매도</th>
            <th className="r">수수료+세금</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td className="ord-name">
                {r.label}
                {unit !== "일" && <span className="ord-name-sub">{r.from.slice(5).replace("-", "/")} ~ {r.to.slice(5).replace("-", "/")} · {r.days}일 거래</span>}
              </td>
              <td className="r" data-l="자산 (말)">{r.assetEnd !== null ? `${Math.round(r.assetEnd).toLocaleString()}원` : "-"}</td>
              <td className={`r ${signClass(r.assetChange ?? 0)}`} data-l="증감">
                {r.assetChange !== null ? `${signedWon(r.assetChange)}${r.assetChangeRate !== null ? ` (${pctKo(r.assetChangeRate)})` : ""}` : "-"}
              </td>
              <td className={`r ${signClass(r.pnl)}`} data-l="실현손익">{r.pnl !== 0 ? signedWon(r.pnl) : "-"}</td>
              <td className="r" data-l="매수 / 매도">{r.buyAmt || r.sellAmt ? `${manwon(r.buyAmt)} / ${manwon(r.sellAmt)}` : "-"}</td>
              <td className="r" data-l="수수료+세금">{r.cost ? `${Math.round(r.cost).toLocaleString()}원` : "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── 기록 (개편 ④) — 미체결·체결·주문 기록·감시 히스토리를 한 탭에 ─────── */

function HistoryTab({ status, onDone }: { status: OrderStatus; onDone: () => void }) {
  const [sec, setSec] = useState<"open" | "fills" | "log" | "watch">("open");
  return (
    <div className="ord-tab">
      <div className="ord-hist-tabs">
        {(
          [
            ["open", "미체결"],
            ["fills", "오늘 체결"],
            ["log", "주문 기록"],
            ["watch", "감시 히스토리"],
          ] as const
        ).map(([k, label]) => (
          <button key={k} type="button" className={sec === k ? "on" : ""} onClick={() => setSec(k)}>
            {label}
          </button>
        ))}
      </div>
      {sec === "open" && <OpenTab status={status} onDone={onDone} />}
      {sec === "fills" && <FillsTab />}
      {sec === "log" && <LogTab />}
      {sec === "watch" && <WatchHistoryTab />}
    </div>
  );
}

/**
 * 주문 › 설정 (2026-09-04) — 벤티지: "기록 옆에 설정 메뉴도 만들어 줘."
 *
 * **여기서 못 고치는 것이 무엇인지가 더 중요하다.** 한 건·하루 한도, 가격 울타리, 장중만 —
 * 이것들은 `server/data/orderGuard.json` 을 직접 열어 고치고 서버를 다시 켜야 한다.
 * 화면에서 고칠 수 있으면 그건 한도가 아니다(설계 L3). 여기서는 **보여만 준다.**
 */
function ConfigTab({ status, onDone, subOrder, onSubOrder }: { status: OrderStatus; onDone: () => void; subOrder: Sub[]; onSubOrder: (o: Sub[]) => void }) {
  const fold = useCfgFold();
  const [cfg, setCfg] = useState(status.settings);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /* 어느 폼이 마지막으로 눌렸나 — 결과를 그 폼 밑에만 적는다 */
  const [last, setLast] = useState<"pin" | "pw" | null>(null);
  const [resetU, setResetU] = useState("");
  const [resetP, setResetP] = useState("");
  const [pwA, setPwA] = useState("");
  const [pwB, setPwB] = useState("");
  const [pwCur, setPwCur] = useState("");
  const [pinA, setPinA] = useState("");
  const [pinCur, setPinCur] = useState("");
  /**
   * PIN ↔ 패턴 사이를 오갈 때 **새 값을 먼저 받고 그다음에 문을 바꾼다** (2026-09-08).
   *
   * 둘은 같은 해시 자리를 쓴다. 문만 먼저 패턴으로 바꿔 두면 저장된 것은 아직 PIN 이라,
   * 그 사이에 앱을 닫은 사람은 **PIN 숫자를 점으로 그려야 열리는** 문 앞에 서게 된다.
   * 그래서 「패턴」을 누르면 저장하지 않고 여기에 적어 두기만 하고, 아래에서 새 패턴을
   * 등록하는 순간에 비로소 모드를 바꾼다. 아이디·비밀번호로 가는 것은 해시와 무관하니 곧장.
   */
  const [pendingMode, setPendingMode] = useState<"pin" | "pattern" | null>(null);
  /** 바꾸기 폼이 지금 어느 손을 받나 — 바꾸려는 중이면 그쪽, 아니면 지금 문 */
  const padMode: "pin" | "pattern" = pendingMode ?? (cfg.entryMode === "pattern" ? "pattern" : "pin");

  async function save(patch: Partial<typeof cfg>) {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      const r = await api.orderSettingsSave(patch);
      setCfg(r.settings);
      setMsg("저장했습니다");
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "저장 실패");
    } finally {
      setBusy(false);
    }
  }

  async function changePin(e: React.FormEvent) {
    e.preventDefault();
    setLast("pin");
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      await api.orderSetPin(pinA, pinCur, padMode);
      /* 새 값이 들어갔으니 이제 문을 바꿔도 안전하다 */
      if (pendingMode && pendingMode !== cfg.entryMode) {
        const r = await api.orderSettingsSave({ entryMode: pendingMode });
        setCfg(r.settings);
        setPendingMode(null);
      }
      setPinA("");
      setPinCur("");
      setMsg(padMode === "pattern" ? "진입 패턴을 등록했습니다 — 이제 패턴으로 엽니다" : "진입 PIN 을 바꿨습니다 — 이제 PIN 으로 엽니다");
      onDone();
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : "실패");
    } finally {
      setBusy(false);
    }
  }

  /**
   * 주문 비밀번호도 글자 ↔ 패턴을 오간다 (2026-09-08). 진입 PIN 과 같은 순서 —
   * **새 값을 먼저 받고 그다음에 방식을 바꾼다.** 방식만 먼저 바꾸면 저장된 것은 아직
   * 글자인데 주문 모달은 패턴을 그리라고 하는 상태가 된다.
   */
  const [pendingPwMode, setPendingPwMode] = useState<"text" | "pattern" | null>(null);
  const pwPadMode: "text" | "pattern" = pendingPwMode ?? cfg.passwordMode ?? "text";

  async function changePw(e: React.FormEvent) {
    e.preventDefault();
    setLast("pw");
    if (pwPadMode === "text" && pwA !== pwB) {
      setError("새 비밀번호 두 칸이 다릅니다");
      return;
    }
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      await api.orderSetPassword(pwA, pwCur, pwPadMode);
      if (pendingPwMode && pendingPwMode !== cfg.passwordMode) {
        const r = await api.orderSettingsSave({ passwordMode: pendingPwMode });
        setCfg(r.settings);
        setPendingPwMode(null);
      }
      setPwA("");
      setPwB("");
      setPwCur("");
      setMsg(pwPadMode === "pattern" ? "주문 패턴을 등록했습니다 — 이제 주문할 때 패턴을 그립니다" : "주문 비밀번호를 바꿨습니다");
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : "실패");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ord-tab ord-cfg">
      {msg && <p className="ord-ok">{msg}</p>}
      {error && <p className="ord-err">{error}</p>}

      {/* 체결 알림음 — 발행·알림 설정과 같은 판 (2026-09-08 벤티지 "주문의 설정 메뉴에서 알림음 선택·미리듣기") */}
      <section className={cfgSecClass(fold.open("notify"))}>
        <CfgH4 id="notify">체결 알림 — 화면·소리·진동 (이 기기)</CfgH4>
        <NotifySoundPanel />
      </section>

      <section className={cfgSecClass(fold.open("tabs"))}>
        <CfgH4 id="tabs">탭 차례</CfgH4>
        <p className="ord-note">주문 메뉴 위쪽 탭의 차례. ▲▼ 로 옮긴다 — 어느 기기에서나 같다.</p>
        <div className="ord-tab-order">
          {subOrder.map((k, i) => (
            <span key={k} className="ord-tab-order-row">
              <b>{SUBS.find((x) => x.key === k)?.label}</b>
              <button type="button" className="gt-move" disabled={i === 0} onClick={() => { const o = [...subOrder]; [o[i - 1], o[i]] = [o[i], o[i - 1]]; onSubOrder(o); }} title="앞으로">▲</button>
              <button type="button" className="gt-move" disabled={i === subOrder.length - 1} onClick={() => { const o = [...subOrder]; [o[i + 1], o[i]] = [o[i], o[i + 1]]; onSubOrder(o); }} title="뒤로">▼</button>
            </span>
          ))}
          <button type="button" className="filter-btn" onClick={() => onSubOrder(SUB_ORDER_DEFAULT)}>처음대로</button>
        </div>
      </section>

      <section className={cfgSecClass(fold.open("remember"))}>
        <CfgH4 id="remember">주문 비밀번호 기억하기</CfgH4>
        <p className="ord-note">
          켜면 한 번 맞힌 뒤 정해 둔 시간 동안 실행마다 묻지 않습니다.{" "}
          <b>비밀번호를 저장하지 않습니다</b> — 서버가 이 주문 세션에 「확인됨」 시각만 찍어 둡니다.
          주문 메뉴를 닫거나 잠그면 그 자리에서 사라지고, 세션의 최대 수명(60분)을 넘지 않습니다.
        </p>
        <div className="ord-cfg-row">
          <label>
            <input
              type="checkbox"
              checked={cfg.rememberPassword}
              disabled={busy}
              onChange={(e) => void save({ rememberPassword: e.target.checked })}
            />
            기억하기 쓰기
          </label>
          <select
            className="ord-in"
            value={cfg.rememberMinutes}
            disabled={busy || !cfg.rememberPassword}
            onChange={(e) => void save({ rememberMinutes: Number(e.target.value) })}
          >
            {[5, 10, 15, 30, 60].map((m) => (
              <option key={m} value={m}>
                {m}분
              </option>
            ))}
          </select>
          <span className="ord-caps">
            {status.passwordLeftSec > 0 ? `지금 ${Math.ceil(status.passwordLeftSec / 60)}분 남음` : "지금은 매번 묻습니다"}
          </span>
          <button
            type="button"
            className="ord-x"
            disabled={busy || status.passwordLeftSec <= 0}
            onClick={() => void api.orderForget().then(onDone)}
          >
            지금 잊기
          </button>
        </div>
      </section>

      <section className={cfgSecClass(fold.open("close"))}>
        <CfgH4 id="close">주문 메뉴가 닫히는 시간</CfgH4>
        <p className="ord-note">
          열어 두면 잊고 자리를 뜨게 됩니다. <b>가만히 두면</b> 그 시간에 닫히고, 계속 쓰더라도{" "}
          <b>최대 시간</b>이 지나면 닫습니다. 짧을수록 안전하고 길수록 편합니다 — 기기를 잃어버렸을 때
          남에게 열려 있는 시간이 이 값입니다.
        </p>
        <div className="ord-cfg-row">
          <span className="ord-caps">가만히 두면</span>
          <select
            className="ord-in"
            value={cfg.idleMinutes}
            disabled={busy}
            onChange={(e) => void save({ idleMinutes: Number(e.target.value) })}
          >
            {[3, 5, 10, 20, 30, 60].map((m) => (
              <option key={m} value={m}>
                {m}분
              </option>
            ))}
          </select>
          <span className="ord-caps">최대</span>
          <select
            className="ord-in"
            value={cfg.maxMinutes}
            disabled={busy}
            onChange={(e) => void save({ maxMinutes: Number(e.target.value) })}
          >
            {[30, 60, 120, 240].map((m) => (
              <option key={m} value={m}>
                {m}분
              </option>
            ))}
          </select>
          <span className="ord-caps">바꾼 값은 다음에 열 때부터</span>
        </div>
      </section>

      <DeviceSection cfg={cfg} busy={busy} onSave={save} />

      <section className={cfgSecClass(fold.open("defaults"))}>
        <CfgH4 id="defaults">기본값</CfgH4>
        <div className="ord-cfg-row">
          <span className="ord-caps">거래소</span>
          <select
            className="ord-in"
            value={cfg.defaultVenue}
            disabled={busy}
            onChange={(e) => void save({ defaultVenue: e.target.value as typeof cfg.defaultVenue })}
          >
            <option value="auto">그때 열려 있는 곳</option>
            {VENUES.map((v) => (
              <option key={v.key} value={v.key}>
                {v.label}
              </option>
            ))}
          </select>
          <span className="ord-caps">매매구분</span>
          <select
            className="ord-in"
            value={cfg.defaultTradeType}
            disabled={busy}
            onChange={(e) => void save({ defaultTradeType: e.target.value })}
          >
            {(status.tradeTypes ?? []).map((t) => (
              <option key={t.code} value={t.code}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
      </section>

      <section className={cfgSecClass(fold.open("entry"))}>
        <CfgH4 id="entry">주문 메뉴를 무엇으로 여나</CfgH4>
        <p className="ord-note">
          <b>PIN 네 자리</b>는 손이 편합니다. 대신 네 자리는 만 가지뿐이라 <b>혼자 서는 문이 아닙니다</b> —
          그래서 <b>「등록된 기기에서만 주문」이 켜져 있을 때만</b> 고를 수 있습니다(서버가 막습니다).
          앞에 등록된 기기가 있고, 뒤에 주문 비밀번호가 따로 있어서 겹이 유지됩니다.
          다섯 번 틀리면 30분 잠기고 텔레그램으로 알립니다.
        </p>
        <div className="ord-cfg-row">
          {(["password", "pin", "pattern"] as const).map((m) => {
            const active = pendingMode ? pendingMode === m : cfg.entryMode === m;
            return (
              <button
                key={m}
                type="button"
                className={`filter-btn ${active ? "active" : ""}${pendingMode === m ? " pending" : ""}`}
                disabled={busy}
                onClick={() => {
                  if (m === "password") {
                    setPendingMode(null);
                    void save({ entryMode: m });
                    return;
                  }
                  /* PIN·패턴은 새 값을 먼저 받는다 — 아래 폼이 그 손으로 바뀐다 */
                  if (m === cfg.entryMode) {
                    setPendingMode(null);
                    return;
                  }
                  setPendingMode(m);
                  setPinA("");
                  setMsg(null);
                  setError(null);
                }}
              >
                {m === "password" ? "아이디·비밀번호" : m === "pin" ? "PIN 네 자리" : "패턴"}
              </button>
            );
          })}
          {pendingMode && (
            <span className="ord-note">
              아래에서 새 {pendingMode === "pattern" ? "패턴을 등록" : "PIN 을 정"}하면 그때 바뀝니다
            </span>
          )}
          {status.pinIsDefault && <span className="ord-err">PIN 이 아직 기본값 0000 입니다</span>}
          {status.pinLockedUntilMs > 0 && (
            <span className="ord-err">
              PIN 잠금 — {Math.ceil((status.pinLockedUntilMs - Date.now()) / 60000)}분 남음
            </span>
          )}
          {(status.pinLockedUntilMs > 0 || status.lockedUntilMs > 0) && <UnlockCard onDone={onDone} />}
        </div>
      </section>

      <form className={cfgSecClass(fold.open("pin"))} onSubmit={(e) => void changePin(e)}>
        <CfgH4 id="pin">{padMode === "pattern" ? "진입 패턴 바꾸기" : "진입 PIN 바꾸기"}</CfgH4>
        <p className="ord-note">
          지금 {padMode === "pattern" ? "패턴" : "PIN"} 또는 <b>주문 비밀번호</b>로 확인합니다 — 잊어도 되돌릴 길이 있어야
          합니다.{" "}
          {padMode === "pattern"
            ? "네 점 이상을 이어야 하고, 한 줄로만 긋는 것은 막습니다."
            : "0000·1234 처럼 뻔한 숫자는 막습니다."}{" "}
          <b>주문 비밀번호와 다른 것</b>으로 하세요 — 같게 두면 겹이 둘에서 하나로 줍니다.
        </p>
        {/*
          「지금 것」은 글자 칸으로 둔다 — 주문 비밀번호가 올 수도 있어서 패드로는 못 받는다.
          「새 것」은 패드로 — 정하는 손과 여는 손이 같아야 나중에 헷갈리지 않는다.
        */}
        <input
          className="ord-in"
          type="password"
          autoComplete="off"
          placeholder={
            status.pinIsDefault && padMode !== "pattern"
              ? "지금 PIN (기본값 0000) 또는 주문 비밀번호"
              : `지금 ${padMode === "pattern" ? "패턴(숫자열)" : "PIN"} 또는 주문 비밀번호`
          }
          value={pinCur}
          onChange={(e) => setPinCur(e.target.value)}
        />
        <div className="ord-cfg-pad">
          <span className="ord-note">새 {padMode === "pattern" ? "패턴을 그리세요" : "PIN 네 자리"}</span>
          {padMode === "pattern" ? (
            <PatternPad value={pinA} onChange={setPinA} disabled={busy} />
          ) : (
            <NumPad value={pinA} onChange={setPinA} disabled={busy} />
          )}
        </div>
        <button
          type="submit"
          className="ord-go"
          disabled={busy || !pinCur || (padMode === "pattern" ? pinA.length < 4 : pinA.length !== 4)}
        >
          {busy ? "저장 중…" : "바꾸기"}
        </button>
        {/* 결과는 **단추 바로 밑**에 (2026-09-08 — 벤티지 "바꾸기 하면 저장되었습니다 라고 문구 표시 좀"). 탭 맨 위에만 찍혀서 아래서 누른 사람은 못 봤다 */}
        {last === "pin" && msg && <p className="ord-ok">✅ 저장되었습니다 — {msg}</p>}
        {last === "pin" && error && <p className="ord-err">❌ 저장 안 됨 — {error}</p>}
        {last === "pin" && error && /잠금/.test(error) && <UnlockCard onDone={() => { setError(null); setMsg("잠금을 풀었습니다 — 다시 바꾸기를 누르세요"); onDone(); }} />}
      </form>

      <form className={cfgSecClass(fold.open("password"))} onSubmit={(e) => void changePw(e)}>
        <CfgH4 id="password">주문 비밀번호 {pwPadMode === "pattern" ? "— 패턴" : "바꾸기"}</CfgH4>
        <p className="ord-note">
          주문을 실행할 때마다 묻는 것입니다. 글자 6자 이상이나 3×3 패턴 중 고릅니다.{" "}
          {(cfg.entryMode === "pattern" || pendingMode === "pattern") && pwPadMode === "pattern" && (
            <b className="ord-err">진입 패턴과 다른 패턴으로 하세요 — 같으면 문이 하나로 줍니다.</b>
          )}
        </p>
        <div className="ord-cfg-row">
          {(["text", "pattern"] as const).map((m) => {
            const active = pendingPwMode ? pendingPwMode === m : (cfg.passwordMode ?? "text") === m;
            return (
              <button
                key={m}
                type="button"
                className={`filter-btn ${active ? "active" : ""}${pendingPwMode === m ? " pending" : ""}`}
                disabled={busy}
                onClick={() => {
                  setPendingPwMode(m === (cfg.passwordMode ?? "text") ? null : m);
                  setPwA("");
                  setPwB("");
                  setMsg(null);
                  setError(null);
                }}
              >
                {m === "text" ? "글자" : "패턴"}
              </button>
            );
          })}
          {pendingPwMode && <span className="ord-note">아래에서 새 {pendingPwMode === "pattern" ? "패턴을 등록" : "비밀번호를 정"}하면 그때 바뀝니다</span>}
        </div>
        <input
          className="ord-in"
          type="password"
          autoComplete="off"
          placeholder={(cfg.passwordMode ?? "text") === "pattern" ? "지금 패턴(숫자열) 또는 옛 비밀번호" : "지금 비밀번호"}
          value={pwCur}
          onChange={(e) => setPwCur(e.target.value)}
        />
        {pwPadMode === "pattern" ? (
          <div className="ord-cfg-pad">
            <span className="ord-note">새 패턴을 그리세요</span>
            <PatternPad value={pwA} onChange={setPwA} disabled={busy} />
          </div>
        ) : (
          <>
            <input className="ord-in" type="password" autoComplete="new-password" placeholder="새 비밀번호 (6자 이상)" value={pwA} onChange={(e) => setPwA(e.target.value)} />
            <input className="ord-in" type="password" autoComplete="new-password" placeholder="한 번 더" value={pwB} onChange={(e) => setPwB(e.target.value)} />
          </>
        )}
        <button
          type="submit"
          className="ord-go"
          disabled={busy || !pwCur || (pwPadMode === "pattern" ? pwA.length < 4 : pwA.length < 6)}
        >
          {busy ? "저장 중…" : "바꾸기"}
        </button>
        {last === "pw" && msg && <p className="ord-ok">✅ 저장되었습니다 — {msg}</p>}
        {last === "pw" && error && <p className="ord-err">❌ 저장 안 됨 — {error}{/잠금/.test(error) ? "" : ". 위 「지금 패턴 또는 옛 비밀번호」 칸이 맞는지 확인"}</p>}
        {/* 잠금이면 풀기 카드를 **바로 여기** — 글로만 「풀기」라고 하면 어디서 푸는지 모른다 (벤티지 "지금 풀기 어떻게 하라는 거야") */}
        {last === "pw" && error && /잠금/.test(error) && <UnlockCard onDone={() => { setError(null); setMsg("잠금을 풀었습니다 — 다시 바꾸기를 누르세요"); onDone(); }} />}
        {/*
          옛 비밀번호를 모르면 — 앱 아이디·비밀번호로 새로 정한다 (2026-09-08 벤티지 "초기화 좀").
          위 칸의 새 값(글자 6자 이상 또는 패턴)을 그대로 쓴다. 옛 것 칸은 비워도 된다.
        */}
        <details className="ord-reset">
          <summary>옛 비밀번호를 모른다 — 앱 아이디·비밀번호로 새로 정하기</summary>
          <p className="ord-note">위에 새 {pwPadMode === "pattern" ? "패턴을 그린" : "비밀번호를 적은"} 채로, 여기 앱 로그인을 넣으면 옛 것 없이 그 값으로 바뀐다. 잠금·실패 횟수도 지워진다.</p>
          <div className="ord-unlock-row">
            <input className="ord-in" placeholder="아이디" autoComplete="username" value={resetU} onChange={(e) => setResetU(e.target.value)} />
            <input className="ord-in" type="password" placeholder="앱 비밀번호" autoComplete="current-password" value={resetP} onChange={(e) => setResetP(e.target.value)} />
            <button
              type="button"
              className="ord-mk"
              disabled={busy || !resetU || !resetP || (pwPadMode === "pattern" ? pwA.length < 4 : pwA.length < 6)}
              onClick={async () => {
                setLast("pw");
                setBusy(true);
                setError(null);
                setMsg(null);
                try {
                  await api.orderPasswordReset(resetU, resetP, pwA, pwPadMode);
                  if (pendingPwMode && pendingPwMode !== cfg.passwordMode) {
                    const r = await api.orderSettingsSave({ passwordMode: pendingPwMode });
                    setCfg(r.settings);
                    setPendingPwMode(null);
                  }
                  setPwA("");
                  setPwB("");
                  setPwCur("");
                  setResetP("");
                  setMsg(pwPadMode === "pattern" ? "주문 패턴을 새로 정했습니다 — 이제 주문할 때 이 패턴을 그립니다" : "주문 비밀번호를 새로 정했습니다");
                  onDone();
                } catch (e2) {
                  setError(e2 instanceof Error ? e2.message : "실패");
                } finally {
                  setBusy(false);
                }
              }}
            >
              새로 정하기
            </button>
          </div>
        </details>
      </form>

      <AccessLogSection />

      {/* 저장되면 status 를 다시 읽는다(onDone) — 위 잔고 띠의 한도 숫자도 같이 바뀌어야 한다 */}
      <GuardSection guard={status.guard} mock={status.mock} cap={status.hardCeiling} onSaved={() => onDone()} />
    </div>
  );
}

/*
 * 규칙·한도 줄 컴포넌트 — **반드시 모듈 최상위** (2차 검진 🟠C-1). GuardSection 안에서 정의하면
 * 렌더마다 새 컴포넌트라 React 가 같은 자리를 언마운트·재마운트해서 **한 글자 칠 때마다
 * 포커스가 날아갔다.** 「1000000」을 치려면 일곱 번 다시 눌러야 했다.
 */
interface GuardRowCtx {
  d: OrderGuard;
  set: (patch: Partial<OrderGuard>) => void;
  onEnter: () => void;
}
interface GuardRowProps { ctx: GuardRowCtx; k: keyof OrderGuard; label: string; hint: string; unit: string; fallback: number; min: number; max: number; step?: number }
function GuardRow({ ctx, k, label, hint, unit, fallback, min, max, step }: GuardRowProps) {
  const v = Number(ctx.d[k] ?? 0);
  /*
   * ⚠️ **고치는 중에는 칸을 잠그지 않는다** (2026-09-08 검진 10). 값이 0 이면 스위치가 꺼지고
   * 칸이 `disabled` 가 되는데, 값을 다 지우는 순간 0 이 되므로 **백스페이스 한 번에 포커스가
   * 날아갔다.** 손이 칸에 있는 동안(draft)은 0 이어도 열어 둔다 — 떠날 때 비어 있으면 그때 끈다.
   */
  const [draft, setDraft] = useState<string | null>(null);
  const editing = draft !== null;
  const usable = v > 0 || editing;
  return (
    <div className="ord-guard-row">
      <label className="ord-guard-sw">
        <input type="checkbox" checked={v > 0} onChange={(e) => ctx.set({ [k]: e.target.checked ? fallback : 0 } as Partial<OrderGuard>)} />
        <b>{label}</b>
      </label>
      <span className="ord-guard-val">
        <input
          type="number"
          value={editing ? draft : v > 0 ? v : ""}
          placeholder="안 씀"
          disabled={!usable}
          min={min}
          max={max}
          step={step ?? 1}
          onFocus={() => setDraft(v > 0 ? String(v) : "")}
          onBlur={() => setDraft(null)}
          onChange={(e) => {
            setDraft(e.target.value);
            ctx.set({ [k]: Number(e.target.value) || 0 } as Partial<OrderGuard>);
          }}
          onKeyDown={(e) => e.key === "Enter" && ctx.onEnter()}
        />
        <i>{unit}</i>
      </span>
      <small>{hint}</small>
    </div>
  );
}
interface GuardFixedProps { ctx: GuardRowCtx; k: keyof OrderGuard; label: string; hint: string; unit: string; min: number; max: number; step?: number }
function GuardFixed({ ctx, k, label, hint, unit, min, max, step }: GuardFixedProps) {
  return (
    <div className="ord-guard-row">
      <span className="ord-guard-sw fixed">
        <b>{label}</b>
      </span>
      <span className="ord-guard-val">
        <input type="number" value={Number(ctx.d[k] ?? 0)} min={min} max={max} step={step ?? 1} onChange={(e) => ctx.set({ [k]: Number(e.target.value) } as Partial<OrderGuard>)} onKeyDown={(e) => e.key === "Enter" && ctx.onEnter()} />
        <i>{unit}</i>
      </span>
      <small>{hint}</small>
    </div>
  );
}
interface GuardSwProps { ctx: GuardRowCtx; k: keyof OrderGuard; label: string; hint: string; danger?: boolean }
function GuardSw({ ctx, k, label, hint, danger }: GuardSwProps) {
  return (
    <div className="ord-guard-row">
      <label className={`ord-guard-sw${danger ? " danger" : ""}`}>
        <input type="checkbox" checked={Boolean(ctx.d[k])} onChange={(e) => ctx.set({ [k]: e.target.checked } as Partial<OrderGuard>)} />
        <b>{label}</b>
      </label>
      <span className="ord-guard-val" />
      <small>{hint}</small>
    </div>
  );
}

/**
 * **규칙·한도 편집** (2026-09-08).
 *
 * 벤티지: "이거 뭐야? 이런 규칙들 어디에 있는 거야? 이거 설정에서 ON/OFF 할 수 있게 해줘봐
 * 다 찾아가지고." — 손절 뒤 쿨다운에 걸려 삼성전자를 30분 못 산 자리에서.
 *
 * 여태는 「한도 — 여기서는 못 고칩니다」 표였고, 그마저 열셋 중 일곱만 보여줬다. 쿨다운·
 * 하루 손실 한도·비중 제한·신용·자동감시·이중 스톱은 **있는지도 화면이 말하지 않았다.**
 * 규칙에 걸린 사람이 왜 걸렸는지 찾을 수 없으면 그건 안전이 아니라 불투명이다.
 *
 * 바꾸려면 **주문 비밀번호**를 다시 넣는다 — 주문을 내는 것과 같은 무게. 바뀐 값은 기록에 남는다.
 * 켜고 끄는 것은 스위치로, 값은 숫자로. 0 이면 「안 씀」인 것들은 스위치를 끄면 0 을 보낸다.
 */
function GuardSection({ guard, mock, cap, onSaved }: { guard: OrderGuard; mock: boolean; cap?: { maxOrderKrw: number | null; maxDailyKrw: number | null }; onSaved: (g: OrderGuard) => void }) {
  const fold = useCfgFold();
  const [d, setD] = useState<OrderGuard>(guard);
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => setD(guard), [guard]);
  const dirty = JSON.stringify(d) !== JSON.stringify(guard);
  const set = (patch: Partial<OrderGuard>) => setD((p) => ({ ...p, ...patch }));

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.orderGuardSave(pw, d);
      onSaved(r.guard);
      setPw("");
      setMsg({ ok: true, text: "저장했다 — 바뀐 값은 기록 탭에 남는다" });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "저장 실패" });
    } finally {
      setBusy(false);
    }
  }

  const rowCtx: GuardRowCtx = { d, set, onEnter: () => pw && dirty && void save() };

  return (
    <section className={cfgSecClass(fold.open("guard"))}>
      <CfgH4 id="guard">규칙·한도</CfgH4>
      <p className="ord-note">
        주문을 <b>거절</b>하거나 <b>막는</b> 규칙 전부다. 넘으면 줄여서 내지 않고 거절한다. 바꾸려면 주문 비밀번호를 다시 넣는다 —
        주문을 내는 것과 같은 무게이고, 바뀐 값은 기록에 남는다. {mock ? "지금은 모의투자다." : "지금은 실전 계좌다."}
      </p>

      <h5 className="ord-guard-h">매수를 막는 규칙</h5>
      <GuardRow ctx={rowCtx} k="rebuyCooldownMin" label="손절 뒤 쿨다운" hint="손절 감시로 판 종목은 이 시간 동안 다시 안 산다. 방금 손절한 걸 홧김에 되사는 손을 막는다" unit="분" fallback={30} min={1} max={1440} />
      <GuardRow ctx={rowCtx} k="maxDailyLossKrw" label="하루 실현손실 한도" hint="오늘 자동감시 매도로 실현한 손실이 이만큼을 넘으면 그날 신규 매수를 잠근다" unit="원" fallback={500_000} min={10_000} max={10_000_000_000} step={10_000} />
      <GuardRow ctx={rowCtx} k="maxPositionPct" label="한 종목 비중 제한" hint="사고 나면 종목 하나가 계좌(예수금+평가)의 몇 %를 넘게 되는 매수는 거절" unit="%" fallback={40} min={1} max={100} />

      <h5 className="ord-guard-h">주문 한도</h5>
      <GuardFixed ctx={rowCtx} k="maxOrderKrw" label="한 건" hint={`주문 한 건의 상한. 지정가는 가격×수량, 시장가는 현재가×수량${cap?.maxOrderKrw ? ` · 천장 ${won(cap.maxOrderKrw)} (.env, 미니PC 에서만)` : ""}`} unit="원" min={10_000} max={cap?.maxOrderKrw ?? 1_000_000_000} step={100_000} />
      <GuardFixed ctx={rowCtx} k="maxDailyKrw" label="하루 합계" hint={`오늘 낸 「매수」 주문의 합 상한 — 매도(출구)는 안 센다${cap?.maxDailyKrw ? ` · 천장 ${won(cap.maxDailyKrw)} (.env, 미니PC 에서만)` : ""}`} unit="원" min={10_000} max={cap?.maxDailyKrw ?? 10_000_000_000} step={100_000} />
      <GuardFixed ctx={rowCtx} k="maxDailyCount" label="하루 건수" hint="오늘 낸 매수 주문 건수 상한 (매도·취소는 안 센다)" unit="건" min={1} max={1000} />
      <GuardFixed ctx={rowCtx} k="priceCollarPct" label="지정가 울타리" hint="현재가에서 이만큼 넘게 벗어난 지정가는 거절 — 0 을 하나 더 친 손가락을 잡는다" unit="%" min={1} max={30} step={0.5} />
      <GuardFixed ctx={rowCtx} k="stopCollarPct" label="스톱 발동가 울타리" hint="손절 발동가는 원래 멀리 두므로 따로 넓게. 그래도 오타는 잡는다" unit="%" min={1} max={90} />

      <h5 className="ord-guard-h">켜고 끄기</h5>
      <GuardSw ctx={rowCtx} k="marketHoursOnly" label="장중에만 주문" hint="거래소가 주문을 받는 시간 밖이면 거절" />
      <GuardSw ctx={rowCtx} k="allowAutoWatch" label="자동감시주문 허용" hint="끄면 새로 안 받고, 기다리던 감시도 발동하지 않는다" />
      <GuardSw ctx={rowCtx} k="dualStop" label="손절 감시에 키움 스톱도 같이" hint="「이하면 판다」 감시에 키움 서버 스톱지정가를 아침마다 같이 건다 — 우리 서버가 죽어도 키움이 판다" />
      <GuardSw ctx={rowCtx} k="allowCredit" label="신용 주문 허용" hint="신용은 빚이다. 켜는 순간부터 주문서에 신용 칸이 열린다" danger />

      <div className="ord-guard-save">
        <input
          type="password"
          className="ord-input"
          placeholder="주문 비밀번호"
          value={pw}
          autoComplete="current-password"
          onChange={(e) => setPw(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && pw && dirty && void save()}
        />
        <button type="button" className="ord-go" disabled={!dirty || !pw || busy} onClick={() => void save()}>
          {busy ? "저장 중…" : dirty ? "저장" : "바뀐 것 없음"}
        </button>
        {dirty && (
          <button type="button" className="filter-btn" onClick={() => setD(guard)}>
            되돌리기
          </button>
        )}
        {msg && <span className={msg.ok ? "ord-ok" : "ord-bad"}>{msg.text}</span>}
      </div>
      <p className="ord-note">
        허용 종목 목록(<code>allowedCodes</code>)만은 아직 파일이다 — {guard.allowedCodes?.length ? `${guard.allowedCodes.length}개만 허용 중` : "지금은 전 종목"}.
      </p>
    </section>
  );
}

/**
 * 등록된 기기 (2026-09-04) — 벤티지: "등록되어 있는 걸 삭제하고 수정할 수 있는 메뉴도."
 *
 * 지금 쓰는 기기도 지울 수 있게 둔다 — 빌린 컴퓨터에서 열었다면 지우고 싶을 것이다.
 * 대신 「지금 이 기기」라고 적어 **모르고 지우는 일**만 막는다.
 */
function DeviceSection({
  cfg,
  busy,
  onSave,
}: {
  cfg: OrderSettings;
  busy: boolean;
  onSave: (patch: Partial<OrderSettings>) => Promise<void>;
}) {
  const fold = useCfgFold();
  const [devices, setDevices] = useState<OrderDevice[]>([]);
  const [mailReady, setMailReady] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    void api
      .orderDevices()
      .then((r) => {
        setDevices(r.devices);
        setMailReady(r.mailReady);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "못 읽었다"));
  }, []);
  useEffect(load, [load]);

  return (
    <section className={cfgSecClass(fold.open("devices"))}>
      <CfgH4 id="devices">주문할 수 있는 기기</CfgH4>
      <p className="ord-note">
        아이디·비밀번호는 <b>아는 것</b>이라 새어 나가면 어디서든 쓸 수 있습니다. 기기는 <b>가진 것</b>이라
        성질이 다릅니다 — 켜 두면 둘 다 알아도 <b>등록 안 된 기기에서는 주문 메뉴가 열리지 않습니다</b>.
        새 기기는 메일로 받은 6자리로 등록합니다.
      </p>
      {!mailReady && (
        <p className="ord-err">
          메일이 설정돼 있지 않아 기기 확인을 할 수 없습니다 — 이 설정은 켜도 동작하지 않습니다.
        </p>
      )}
      <div className="ord-cfg-row">
        <label>
          <input
            type="checkbox"
            checked={cfg.requireTrustedDevice}
            disabled={busy}
            onChange={(e) => void onSave({ requireTrustedDevice: e.target.checked })}
          />
          등록된 기기에서만 주문
        </label>
        {/*
          접근 점검 알림 (2026-09-04) — 벤티지: "주문 접근 점검 텔레그램 계속 오는데."
          끄더라도 점검은 6시간마다 그대로 돌고 기록도 남는다. 안 가는 건 **알림뿐**이다 —
          이 화면이 이미 「마지막 점검 · 이상 없음」을 말하고 있어서 겹치는 통로다.
        */}
        <label title="끄더라도 점검과 기록은 그대로입니다 — 텔레그램만 안 갑니다">
          <input
            type="checkbox"
            checked={cfg.auditTelegram !== false}
            disabled={busy}
            onChange={(e) => void onSave({ auditTelegram: e.target.checked })}
          />
          접근 점검을 텔레그램으로도
        </label>
      </div>
      {error && <p className="ord-err">{error}</p>}
      {devices.length === 0 ? (
        <p className="empty">아직 등록된 기기가 없습니다</p>
      ) : (
        <div className="ord-scroll">
          <table className="ord-table stack">
            <thead>
              <tr>
                <th>이름</th>
                <th>등록</th>
                <th>마지막</th>
                <th>주소</th>
                <th className="r">주문</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {devices.map((d) => (
                <tr key={d.id}>
                  <td className="ord-name">
                    {d.name} {d.current && <span className="ord-code">지금 이 기기</span>}
                  </td>
                  <td data-l="등록">{d.addedAt.slice(0, 10)}</td>
                  <td data-l="마지막">{fmtKst(d.lastAt)}</td>
                  <td data-l="주소">{d.lastIp}</td>
                  <td className="r" data-l="주문">
                    {d.orders}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="ord-x"
                      onClick={() => {
                        const name = window.prompt("이 기기의 새 이름", d.name);
                        if (name) void api.orderDeviceRename(d.id, name).then((r) => setDevices(r.devices));
                      }}
                    >
                      이름
                    </button>{" "}
                    <button
                      type="button"
                      className="ord-x"
                      onClick={() => {
                        if (!window.confirm(`${d.name} 을 지웁니다. 그 기기는 다음에 열 때 메일 확인을 다시 거칩니다.`)) return;
                        void api.orderDeviceRemove(d.id).then((r) => setDevices(r.devices));
                      }}
                    >
                      삭제
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/**
 * 접근 점검 (2026-09-04) — **줄을 늘어놓지 않는다.**
 *
 * 벤티지: "전부를 다 보여줄 필요는 없어. 그럼 엄청 쌓일 테니깐. 「기록 중」이라고만 쓰고
 * 「이상 행위 없었음」 이렇게 표시해줘. 니가 주기적으로 체크해주고."
 *
 * 맞다. 로그를 화면에 쏟는 것은 **판정을 사람에게 미루는 일**이다. 하루 수십 줄이 쌓이면
 * 아무도 안 읽고, 안 읽는 기록은 없는 것과 같다. 서버가 6시간마다 훑고(`startOrderAudit`)
 * **다른 것만** 말한다. 여기서는 그 판정을 한 줄로 보여 주고, 걸린 것이 있을 때만 편다.
 */
function AccessLogSection() {
  const fold = useCfgFold();
  const [audit, setAudit] = useState<AccessAudit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(() => {
    void api
      .orderAudit(24)
      .then(setAudit)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "못 읽었다"));
  }, []);
  useEffect(load, [load]);

  const warns = (audit?.findings ?? []).filter((f) => f.level === "warn");

  return (
    <section className={cfgSecClass(fold.open("audit"))}>
      <CfgH4 id="audit">접근 점검</CfgH4>
      {error && <p className="ord-err">{error}</p>}
      {!audit ? (
        <p className="empty">훑는 중…</p>
      ) : (
        <>
          <div className={`ord-audit ${audit.ok ? "ok" : "bad"}`}>
            <b>{audit.ok ? "이상 행위 없었음" : `눈에 띄는 것 ${audit.findings.length}건`}</b>
            <span>
              기록 중 · 지난 {audit.hours}시간 {audit.records}줄 (통틀어 {audit.total}줄) ·{" "}
              {audit.ips.length > 0 ? `주소 ${audit.ips.length}곳` : "접근 없음"}
            </span>
            <i>
              점검{" "}
              {new Date(audit.checkedAt).toLocaleTimeString("ko-KR", { hour12: false, timeZone: "Asia/Seoul" })}
            </i>
          </div>
          <p className="ord-note">
            서버가 <b>6시간마다</b> 스스로 훑고, <b>이상이 있을 때만</b> 텔레그램으로 보냅니다 —
            조용한 것이 정상입니다. 보는 것: 주소가 둘 이상 · 비밀번호·로그인 실패 · 한도 거절 ·
            키움이 거절한 실패 · 기기 등록·삭제 · 화면 잠금. 주문 자체는 <b>기록</b> 탭에 있습니다.
          </p>
          {audit.findings.length > 0 && (
            <>
              <button type="button" className="ord-x" onClick={() => setOpen((v) => !v)}>
                {open ? "접기" : `자세히 (${audit.findings.length}건)`}
              </button>
              {open && (
                <ul className="ord-audit-list">
                  {audit.findings.map((f, i) => (
                    <li key={`${f.at}-${i}`} className={f.level}>
                      <span className="ord-audit-at">{localTs(f.at)}</span>
                      <span className="ord-audit-msg">{f.msg}</span>
                      {f.ip && <span className="ord-audit-ip">{f.ip}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          {warns.length === 0 && audit.findings.length > 0 && (
            <p className="ord-caps">전부 알아 둘 만한 것뿐이고, 위험해 보이는 것은 없습니다.</p>
          )}
        </>
      )}
    </section>
  );
}

const KIND_KO: Record<OrderLogRow["kind"], string> = {
  session: "세션",
  order: "주문",
  cancel: "취소",
  fill: "체결",
  reject: "거절",
  error: "실패",
  lock: "잠금",
  password: "비밀번호",
  raw: "원문",
  watch: "감시",
  guard: "규칙",
  modify: "정정",
};

function LogTab() {
  const [rows, setRows] = useState<OrderLogRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  /* 복기 노트 11번에 오늘 것을 박아 둔다 (2026-09-10) — 저널이 열릴 때도 자동으로 읽지만, 여기서 바로 */
  const [syncNote, setSyncNote] = useState<string | null>(null);
  const sync = async () => {
    setSyncNote("담는 중…");
    try {
      const r = await api.journalOrdersSync();
      setSyncNote(`복기 노트 ${r.date} 에 ${r.count}건 담음 — 매수 ${r.summary.buyCount} · 매도 ${r.summary.sellCount} · 체결 ${r.summary.fillCount}`);
    } catch (e) {
      setSyncNote(e instanceof Error ? e.message : "실패");
    }
  };

  useEffect(() => {
    void api
      .orderLog(200)
      .then((r) => setRows(r.rows ?? []))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "조회 실패"));
  }, []);

  if (error)
    return (
      <div className="ord-tab">
        <p className="ord-err">{error}</p>
      </div>
    );

  return (
    <div className="ord-tab">
      <p className="ord-note">
        주문 <b>시도</b>가 전부 남는다 — 거절과 실패까지. 이 목록에 없는 체결이 계좌에 있으면 우리가 낸 주문이 아니다.
        <button type="button" className="filter-btn" style={{ marginLeft: 8 }} onClick={() => void sync()}>
          📓 복기 노트에 담기
        </button>
        {syncNote && <span className="pt-n" style={{ marginLeft: 8 }}>{syncNote}</span>}
      </p>
      {rows.length === 0 ? (
        <p className="empty">아직 기록이 없다</p>
      ) : (
        <div className="ord-scroll">
          <table className="ord-table stack">
            <thead>
              <tr>
                <th>시각</th>
                <th>종류</th>
                <th>종목</th>
                <th className="r">수량</th>
                <th className="r">가격</th>
                <th>내용</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.at}-${i}`} className={r.kind === "reject" || r.kind === "error" ? "bad" : ""}>
                  <td data-l="시각">{localTs(r.at)}</td>
                  <td data-l="종류">
                    {KIND_KO[r.kind] ?? r.kind}
                    {r.mock ? <i className="ord-mock">모의</i> : null}
                  </td>
                  <td className="ord-name">
                    {r.side && <SideChip side={r.side} />} {r.name || r.code || KIND_KO[r.kind] || "-"}
                    <span className="ord-name-sub">
                      {localTs(r.at)} · {KIND_KO[r.kind] ?? r.kind}
                      {r.mock ? " · 모의" : ""}
                    </span>
                  </td>
                  <td className="r" data-l="수량">{r.qty ? `${fmtNum(r.qty)}주` : ""}</td>
                  <td className="r" data-l="가격">{r.price ? `${fmtNum(r.price)}원` : ""}</td>
                  <td className="ord-msg">{r.msg || "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
