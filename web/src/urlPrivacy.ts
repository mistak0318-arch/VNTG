/**
 * **주소창에 종목을 안 남긴다** (2026-09-09).
 *
 * 벤티지: "데스크탑 모드의 URL에서는 URL에 파라미터가 붙지 않아서 이 사이트가 뭔지 잘
 * 구분이 안되거든? 근데 미니창 모드에서는 URL 파라미터로 종목명하고... 아 얘가 주식하는구나
 * 유추할 수 있어."
 *
 * 맞는 지적이다. 주소가 `#/mini?code=005930&name=삼성전자` 였다 — **한글 종목명**이 곧
 * 답이다. 엑셀·메모 모드로 화면을 아무리 무채색으로 만들어도 주소창 한 줄이 다 말한다.
 *
 * ## 무엇을 지우나 — **신원만**
 *
 * `code`·`name`·`stk` 셋이다. 이것들이 「무슨 종목을 보고 있나」를 말한다. 나머지
 * (`screen`·`side`·`qty`·`win`…)는 그대로 둔다 — 지우면 미니창이 어느 화면으로 열릴지,
 * 주문이 매수인지 매도인지 같은 **동작**이 깨지고, 그 값만으로는 주식인 줄 모른다.
 *
 * ## 어떻게 살아남나
 *
 * 지우기만 하면 새로고침에서 보던 종목이 사라진다. 그래서 **창별 세션에 담아 둔다**
 * (`sessionStorage`). 창마다 따로라 미니창과 본창이 서로의 종목을 안 건드리고, 창을 닫으면
 * 같이 사라진다 — 남겨 둘 이유가 없는 값이다.
 *
 * ⚠️ **지우는 시점**은 값을 다 읽은 뒤여야 한다. 주문 화면은 주소로 들어온 쪽지를
 * 모듈이 불러오는 순간(리액트보다 먼저) 집어 두므로, 이 청소는 `useEffect` 에서 돈다.
 */

/** 「무슨 종목인가」를 말하는 열쇠들 — 이것만 지운다 */
const IDENTITY_KEYS = ["code", "name", "stk"];

const STOCK_KEY = "vntg.route.stock";

export interface SavedStock {
  code: string;
  name: string;
}

export function saveStock(stock: SavedStock | null): void {
  try {
    if (stock) sessionStorage.setItem(STOCK_KEY, JSON.stringify(stock));
    else sessionStorage.removeItem(STOCK_KEY);
  } catch {
    /* 세션 저장이 막힌 브라우저(사생활 모드 등)여도 이번 화면은 그대로 돈다 */
  }
}

export function readStock(): SavedStock | null {
  try {
    const raw = sessionStorage.getItem(STOCK_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<SavedStock>;
    return v?.code ? { code: String(v.code), name: String(v.name ?? v.code) } : null;
  } catch {
    return null;
  }
}

/**
 * 지금 주소에서 신원 열쇠를 걷어낸다. 지운 것이 있으면 `true`.
 *
 * `replaceState` 라 **뒤로가기 기록을 안 늘린다** — 청소가 한 칸을 차지하면 뒤로가기가
 * 같은 자리를 맴돈다.
 */
export function scrubHash(): boolean {
  if (typeof window === "undefined") return false;
  const raw = window.location.hash.replace(/^#\/?/, "");
  const [path, qs] = raw.split("?");
  if (!qs) return false;

  const params = new URLSearchParams(qs);
  let touched = false;
  for (const k of IDENTITY_KEYS) {
    if (params.has(k)) {
      params.delete(k);
      touched = true;
    }
  }
  if (!touched) return false;

  const rest = params.toString();
  const next = `#/${path}${rest ? `?${rest}` : ""}`;
  if (next !== window.location.hash) window.history.replaceState(null, "", next);
  return true;
}
