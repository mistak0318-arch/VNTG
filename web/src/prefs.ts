/**
 * 설정을 **전역으로** — 기존 코드를 안 고치고.
 *
 * ## 왜 이 모양인가
 *
 * 설정 열네 개가 `localStorage` 에만 쌓여 있었다. 기기를 옮기면 처음부터 다시 정해야 했다.
 * 전부 서버로 옮겨야 하는데, **읽는 자리가 수십 군데고 전부 동기 코드**다
 * (`localStorage.getItem(...)`). 서버는 비동기라 그걸 다 훅으로 바꾸면 대공사이고,
 * 그런 큰 수술은 반드시 어딘가를 부순다.
 *
 * 그래서 **앱이 뜰 때 서버 값을 받아 localStorage 에 채워 넣는다.** 그러면 읽는 코드는
 * 한 줄도 안 고쳐도 되고, 쓰는 자리만 `setPref` 로 바꾸면 전역이 된다.
 * localStorage 는 이제 **저장소가 아니라 서버 값의 사본**이다.
 *
 * ## 창별로 남겨야 하는 것
 *
 * 보드에서 「지금 이 창이 뭘 띄우고 있나」는 창마다 달라야 한다(모니터 세 대).
 * 그건 여기 오면 안 된다 — `boardStore.ts` 의 창별 저장소를 쓴다.
 * **설정과 지금 상태를 한 곳에 두면 반드시 서로 덮어쓴다.**
 */

/** 서버로 안 보내는 키 — 그 기기·그 창에 딸린 것들 */
const LOCAL_ONLY = [
  // 지금 이 창이 뭘 띄우고 있나 (보드) — 창마다 달라야 한다
  "vntg.board.blocks",
  "vntg.board.sizes",
  "vntg.board.pins",
  "vntg.board.locks",
  // 잠금은 그 기기의 상태다. 폰에서 잠갔다고 PC 가 잠기면 안 된다
  "vntg.lock.locked",
  // 최근 본 종목은 그 기기의 흔적이다
  "vntg.recent.stocks.v1",
  /*
   * ⚠️ **종목 연동을 켤지는 그 창의 사정이다.**
   *
   * 이걸 전역으로 올렸다가 연동이 통째로 망가졌다 — 한 창에서 끄면 서버를 거쳐
   * 다른 창까지 꺼진 채로 뜬다. 「이 창을 보드로 쓸지」는 모니터마다 다르다.
   * (`useStockFocus.ts` 주석에 원래 그렇게 적혀 있었는데 그걸 못 보고 옮겼다)
   */
  "vntg.focus.on",
  /*
   * ⚠️ **화면 겉모습은 그 기기의 사정이다.**
   *
   * 테마(다크·라이트·엑셀), 글꼴과 글자 크기, 메뉴바 좌우, 본문 폭이 여기 한 덩어리로
   * 들어 있다(`vntg.appearance`). 이걸 서버에 두면 **27인치에서 맞춘 글자 크기가 폰까지
   * 따라오고**, 회사에서 켠 엑셀 모드가 집 PC 에서도 켜진다. 셋 다 화면이 다르면 답도
   * 다른 값이다.
   *
   * 어느 종목을 보고 있나 같은 값과는 층이 다르다 — 그건 어디서 보든 같아야 맞고,
   * 이건 어디서 보느냐가 곧 답이다.
   */
  "vntg.appearance",
];

function isGlobal(key: string): boolean {
  return key.startsWith("vntg.") && !LOCAL_ONLY.includes(key);
}

let ready = false;

/**
 * 앱이 뜰 때 한 번. **렌더 전에** 부른다 — 그려 놓고 값을 바꾸면 화면이 튄다.
 *
 * ⚠️ 서버가 **아직 저장한 적 없으면**(`saved: false`) 이 기기에 있던 설정을 올려 준다.
 * 빈 값으로 덮어쓰면 쓰던 설정이 그 자리에서 사라진다.
 */
export async function loadPrefs(): Promise<void> {
  try {
    const res = await fetch("/api/settings/ui");
    const body = (await res.json()) as { values?: Record<string, string>; saved?: boolean };

    if (body.saved && body.values && Object.keys(body.values).length > 0) {
      for (const [k, v] of Object.entries(body.values)) {
        if (isGlobal(k)) localStorage.setItem(k, v);
      }
      ready = true;
      return;
    }

    // 서버가 비어 있다 — 이 기기 것을 한 번 올린다
    const mine: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !isGlobal(k)) continue;
      const v = localStorage.getItem(k);
      if (v !== null) mine[k] = v;
    }
    ready = true;
    if (Object.keys(mine).length > 0) await save(mine);
  } catch {
    // 서버를 못 읽어도 화면은 서야 한다 — 이 기기 값으로 그대로 돈다
    ready = true;
  }
}

/* ── 서버로 보내기 — 몰아서 한 번 ────────────────────────────── */

let pending: Record<string, string | null> = {};
let timer: ReturnType<typeof setTimeout> | null = null;

async function save(patch: Record<string, string | null>): Promise<void> {
  await fetch("/api/settings/ui", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
}

function flush(): void {
  timer = null;
  const patch = pending;
  pending = {};
  if (Object.keys(patch).length === 0) return;
  void save(patch).catch(() => undefined);
}

/**
 * 설정 하나를 저장한다 — **로컬에 먼저, 서버에 이어서.**
 *
 * 로컬을 먼저 쓰는 이유는 화면이 바로 그 값을 읽기 때문이다. 서버 응답을 기다리면
 * 그동안 예전 값으로 그려진다.
 *
 * 서버 쪽은 **몰아서 보낸다.** 크기를 끌면 저장이 수십 번 일어나는데 그때마다
 * 요청을 날릴 이유가 없다.
 */
export function setPref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 못 적어도 서버에는 올라간다 */
  }
  if (!isGlobal(key) || !ready) return;
  pending[key] = value;
  if (timer) clearTimeout(timer);
  timer = setTimeout(flush, 600);
}

/** 설정을 되돌린다(지운다) */
export function removePref(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* 무시 */
  }
  if (!isGlobal(key) || !ready) return;
  pending[key] = null;
  if (timer) clearTimeout(timer);
  timer = setTimeout(flush, 600);
}
