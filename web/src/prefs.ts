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
  /*
   * ⚠️ **메뉴 버튼의 모서리도 그 기기의 사정이다** (2026-08-27).
   *
   * 이게 전역이라 폰에서 왼쪽 아래에 둔 버튼이 회사 PC 로 내려왔고, 엑셀 모드를
   * 끌 때 CornerToggle 이 다시 마운트되며 그 값으로 「메뉴바 위치」까지 왼쪽으로
   * 덮었다 — 메뉴바 위치(vntg.appearance)가 기기별인데 그 지름길만 전역이면
   * 이렇게 뒷문으로 덮인다.
   */
  "vntg.navcorner",
  /*
   * ⚠️ **화면 잠금은 그 기기의 사정이다** (2026-09-01).
   *
   * 벤티지: "화면 잠금 설정 값 기기마다 다르게 설정하는 옵션인데 전역 설정
   * 되어있는 거 같아. 내가 회사PC에서 설정한 게 태블릿에도 설정되어 있네."
   *
   * 맞았다. `useScreenLock` 은 **읽을 때는 localStorage 를 직접** 보면서 **쓸 때는
   * `setPref`** 를 썼고, `isGlobal` 이 「vntg. 로 시작하면 전역」이라 이 값이
   * 서버로 올라갔다. 주석에는 "기기마다 따로다"라고 적혀 있었는데 동작은 반대였다 —
   * **말과 코드가 어긋나 있었다.**
   *
   * 회사 PC 는 잠그고 집·태블릿은 안 잠그는 게 자연스럽다. 전역이면 집에서도
   * 5분마다 비밀번호를 넣게 된다.
   */
  "vntg.lock.v1",
  /*
   * 「지금 잠겨 있나」는 더더욱 그 기기 것이다. 전역이면 회사에서 잠근 순간
   * 태블릿도 잠긴다.
   */
  "vntg.lock.locked",
];

function isGlobal(key: string): boolean {
  // vntg.pushApplied.* 는 「이 기기가 어느 배포까지 받았나」 도장이라 기기별이어야 한다
  if (key.startsWith("vntg.pushApplied.")) return false;
  return key.startsWith("vntg.") && !LOCAL_ONLY.includes(key);
}

/* ── 기기별 설정의 전역 배포 (2026-08-26) ─────────────────────────
 *
 * 화면설정처럼 **일부러 기기별로 둔** 설정도, 「지금 이 상태를 전 기기에 깔아라」가
 * 필요할 때가 있다. 그래서 배포 스냅샷을 둔다:
 *
 *   pushGlobalSnapshot(name, keys) — 지금 값을 vntg.push.<name> 에 담아 서버로.
 *   applyPushedPrefs()            — 앱이 뜰 때, 아직 안 받은 배포가 있으면 로컬에 적용.
 *
 * 「어느 배포까지 받았나」는 기기별 도장(vntg.pushApplied.<name>)이 기억하므로
 * 같은 배포를 두 번 덮지 않는다 — 배포 후 그 기기에서 다시 바꾼 값은 살아남는다.
 */

export function pushGlobalSnapshot(name: string, keys: string[]): void {
  const values: Record<string, string> = {};
  for (const k of keys) {
    const v = localStorage.getItem(k);
    if (v !== null) values[k] = v;
  }
  const at = new Date().toISOString();
  setPref(`vntg.push.${name}`, JSON.stringify({ at, values }));
  try {
    // 이 기기는 이미 그 값 그대로다 — 도장을 찍어 재적용을 막는다
    localStorage.setItem(`vntg.pushApplied.${name}`, at);
  } catch {
    /* 무시 */
  }
}

/** 앱이 뜰 때 loadPrefs **다음에** 한 번 — 서버가 채워 둔 배포를 로컬에 편다 */
export function applyPushedPrefs(): void {
  try {
    const pushes: { name: string; raw: string }[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith("vntg.push.")) {
        const raw = localStorage.getItem(k);
        if (raw) pushes.push({ name: k.slice("vntg.push.".length), raw });
      }
    }
    for (const p of pushes) {
      const parsed = JSON.parse(p.raw) as { at?: string; values?: Record<string, string> };
      if (!parsed.at || !parsed.values) continue;
      if (localStorage.getItem(`vntg.pushApplied.${p.name}`) === parsed.at) continue;
      for (const [key, v] of Object.entries(parsed.values)) localStorage.setItem(key, v);
      localStorage.setItem(`vntg.pushApplied.${p.name}`, parsed.at);
    }
  } catch {
    /* 배포 적용이 실패해도 앱은 떠야 한다 */
  }
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
      /*
       * ⚠️ **한때 전역이었다가 로컬로 돌린 값은 서버에 그대로 남는다.**
       *
       * `LOCAL_ONLY` 에 넣으면 앞으로는 안 올리고 안 받지만, **이미 올라간 것은 지워지지
       * 않는다.** 남아 있어도 안 읽으니 화면은 멀쩡한데, 다음에 그 키를 다시 전역으로
       * 바꾸는 날 옛 값이 되살아난다. 찌꺼기는 그때 사고가 된다.
       *
       * 받아 온 값 중 지금 기준으로 로컬인 것이 있으면 **서버에서 지운다.** 한 번만
       * 일어나는 일이고, 지운 뒤에는 아무 일도 안 한다.
       */
      const stale = Object.keys(body.values).filter((k) => !isGlobal(k));
      for (const [k, v] of Object.entries(body.values)) {
        if (isGlobal(k)) localStorage.setItem(k, v);
      }
      ready = true;
      if (stale.length > 0) void removeMany(stale);
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

/**
 * 서버에서 여러 키를 **지운다** — 한때 전역이었다가 로컬로 돌린 값 청소용.
 *
 * `save` 에 `null` 을 넣으면 지워진다(PATCH-merge 라 그 키만 빠진다).
 */
async function removeMany(keys: string[]): Promise<void> {
  const patch: Record<string, string | null> = {};
  for (const k of keys) patch[k] = null;
  await save(patch).catch(() => undefined);
}

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
