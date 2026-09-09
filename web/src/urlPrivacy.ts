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

/* ── 주소를 통째로 비운다 (2026-09-09) ──────────────────────────────────────
 *
 * 벤티지: "가릴수있다면 다 가려줘."
 *
 * 종목 신원을 걷어내고 나니 `#/screener`·`#/order` 같은 **화면 이름**이 남았다. 영어라
 * 종목명만큼 티가 나지는 않지만 「order」 하나로도 짐작할 사람은 짐작한다. 주소창에는
 * `vntgts.com/#/` 만 남긴다.
 *
 * ## 그런데 주소는 세 가지 일을 하고 있었다
 *
 *   ① **새로고침해도 그 화면** — 세션에 적어 두고 그리기 전에 되돌린다
 *   ② **뒤로/앞으로** — 히스토리 **상태**에 실어 둔다. 주소가 같아도 칸은 쌓인다
 *   ③ **링크**(`#/order?stk=…`) — 그대로 둔다. 읽힌 뒤에 비운다
 *
 * 셋 다 주소 없이 된다. 화면들(주문·보드 단독창)은 여전히 첫 렌더에서 해시를 읽으므로,
 * **그리기 전에 되돌리고**(`restoreHash`) 다 읽은 뒤에 비운다(`blankHash`).
 *
 * ⚠️ 새로고침 순간에는 되돌린 주소가 **아주 잠깐** 보인다(첫 그림 전까지). 그 한 순간을
 * 없애려면 화면들이 해시를 안 읽게 다 뜯어야 해서, 거기까지는 안 갔다.
 */

const HASH_KEY = "vntg.route.hash";

/** 지금 주소를 창 세션에 적어 둔다 — 비운 뒤에도 새로고침에서 되살릴 수 있게 */
export function saveHash(): void {
  try {
    const h = window.location.hash;
    if (h && h !== "#/" && h !== "#") sessionStorage.setItem(HASH_KEY, h);
  } catch {
    /* 세션이 막혀 있으면 새로고침에서 기본 화면으로 — 동작은 그대로다 */
  }
}

/**
 * **그리기 전에** 부른다 — 적어 둔 주소를 되돌려 놓는다.
 *
 * 주문 화면은 모듈이 불러올 때, 보드 단독창은 첫 렌더에 해시를 읽는다. 그 둘이 읽을
 * 것이 있어야 새로고침에서 보던 자리가 살아난다. 되돌리기는 `replaceState` 라
 * 뒤로가기 기록을 안 늘린다.
 */
export function restoreHash(): void {
  try {
    const now = window.location.hash;
    if (now && now !== "#/" && now !== "#") return; // 주소가 이미 뭔가 들고 있다(링크로 들어옴)
    const saved = sessionStorage.getItem(HASH_KEY);
    if (saved) window.history.replaceState(window.history.state, "", saved);
  } catch {
    /* 못 되돌리면 기본 화면으로 뜬다 */
  }
}

/** 주소를 `#/` 로 비운다. 지금 칸의 히스토리 상태는 그대로 둔다(뒤로가기가 그걸 본다) */
export function blankHash(): void {
  if (window.location.hash === "#/" ) return;
  window.history.replaceState(window.history.state, "", "#/");
}
