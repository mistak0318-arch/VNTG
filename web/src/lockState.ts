/**
 * **잠그는 건 한 번에, 푸는 건 창마다** (2026-11-17).
 *
 * 벤티지: "PC에서 말야 VNTG 창 여러개 열어 놓고 컨트롤 + q 하면 모든 창이 잠기는 구조잖아?
 * 근데 이거 풀때에는 각 창마다 별도로 풀게할 수는 없어? 잠그는 건 한번에, 푸는건 개별 창에서"
 *
 * ## 전에는 왜 같이 풀렸나
 *
 * 잠금 표식이 **켜짐/꺼짐 한 칸**(`vntg.lock.locked = "1"`)이었다. 창들은 그 칸을 `storage`
 * 이벤트로 같이 보고 있었으니, 켜면 다 잠기고 **지우면 다 풀렸다.** 한 칸으로는 「누가
 * 풀었나」를 담을 자리가 없다.
 *
 * ## 자리를 나눈다 — 명령 하나, 자물쇠는 창마다
 *
 *   `vntg.lock.locked`        **잠금 명령**. 이제 "1" 이 아니라 **그 번의 id** 다
 *   `vntg.lock.held.<창id>`   그 창이 **아직 잠겨 있다**는 자물쇠. 창이 자기 것만 쓴다
 *
 * 잠글 때: 새 id 를 명령 칸에 적는다 → 모든 창이 `storage` 로 보고 **각자** 자물쇠를 건다.
 * 풀 때: **자기 자물쇠만** 뗀다. 명령 칸은 그대로니 다른 창은 잠긴 채다.
 * 마지막 창이 풀면 자물쇠가 하나도 안 남으므로 그때 명령 칸까지 지운다 — 안 지우면
 * 그 뒤에 새로 띄우는 창이 영영 잠긴 채로 뜬다.
 *
 * ⚠️ **칸을 나눠 쓰지 않는 게 요점이다.** 「잠긴 창 목록」을 한 칸에 배열로 뒀다면 창들이
 * 동시에 읽고-고쳐-쓰다가 서로의 글을 덮는다(localStorage 에는 그걸 막을 장치가 없다).
 * 창마다 **자기 키**를 쓰면 쓰는 사람이 늘 하나다.
 *
 * ## 새로고침으로는 못 넘는다
 *
 * 창 id 는 `sessionStorage` 에 둔다 — 새로고침하면 그대로고, 새 창이면 새 id 다. 그래서
 * 잠긴 창을 새로고침해도 자기 자물쇠를 다시 알아보고 잠긴 채로 뜨고, **새로 띄운 창은**
 * 명령이 살아 있는 동안(=아직 잠긴 창이 있는 동안) 같이 잠긴다. 누가 자리에 앉아
 * 창을 띄웠다면 PIN 을 한 번 치는 게 맞다.
 *
 * ## 닫혀 버린 창의 자물쇠는 삭는다
 *
 * 자물쇠 값은 `<id>|<마지막 숨>` 이고, 잠긴 창이 30초마다 숨을 쉰다. 5분 넘게 조용한
 * 자물쇠는 **없는 것으로 본다** — 잠긴 채 닫아 버린 창의 자물쇠가 영원히 남으면,
 * 그 뒤로 띄우는 창이 전부 잠긴 채 뜨고 **풀어도 그 다음 창이 또 잠긴다**(명령 칸을
 * 치울 수 있는 때가 영영 오지 않으니까).
 *
 * 닫을 때 떼는 쪽(`pagehide`)으로는 안 된다 — **새로고침도 같은 신호를 준다.** 그러면
 * 새로고침 한 번으로 잠금이 풀린다. 그래서 「떼기」가 아니라 「삭기」다.
 *
 * ## 이건 보안 경계가 아니다
 *
 * `useScreenLock` 머리말에 적힌 그대로다 — 지나가는 사람 눈에서 가리는 것이 전부다.
 * 여기서 창을 가른 것도 편하려고 가른 것이고, 자물쇠의 세기와는 상관이 없다.
 */

/** 잠금 명령 — 값은 그 번의 id. (옛 버전의 "1" 도 id 로 읽힌다) */
const CMD_KEY = "vntg.lock.locked";
/** 창별 자물쇠 접두사 */
const HELD_PREFIX = "vntg.lock.held.";
/** 이 창의 id — 새로고침을 넘기고, 새 창에는 안 따라간다 */
const WIN_KEY = "vntg.lock.win";
/**
 * **이 창이 풀어 둔 번** — `sessionStorage` 라 새로고침을 넘고 새 창에는 안 따라간다.
 *
 * 이게 없으면 「푼 창을 새로고침하면 다시 잠긴다」가 된다 — 자물쇠를 뗐으니 명령만
 * 남아서 **새로 뜬 창과 구별이 안 되기** 때문이다. 자물쇠는 「아직 잠겨 있다」를 곁창에
 * 알리는 표식이고, 이건 「그 번은 내가 풀었다」는 이 창의 기억이다. 둘은 다른 물음이다.
 */
const CLEARED_KEY = "vntg.lock.cleared";

function ses(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function setSes(key: string, v: string): void {
  try {
    sessionStorage.setItem(key, v);
  } catch {
    /* 막혀 있으면 새로고침을 못 넘는다 — 잠기는 쪽으로 틀린다 */
  }
}

function winId(): string {
  try {
    const got = sessionStorage.getItem(WIN_KEY);
    if (got) return got;
    const made = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    sessionStorage.setItem(WIN_KEY, made);
    return made;
  } catch {
    /* sessionStorage 가 막혀 있으면 이 창은 새로고침을 못 넘긴다 — 잠금이 풀리는 쪽이 아니라 잠기는 쪽으로 */
    return "no-session";
  }
}

const ME = typeof window === "undefined" ? "ssr" : winId();
const MY_HELD = `${HELD_PREFIX}${ME}`;

function get(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function set(key: string, v: string): void {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* 못 적어도 이번 세션에는 잠긴다 */
  }
}

function del(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* 무시 */
  }
}

/** 자물쇠가 삭는 시간 — 이보다 오래 조용하면 닫힌 창으로 본다 */
const STALE_MS = 5 * 60_000;
/** 숨 쉬는 간격 */
const BEAT_MS = 30_000;

/** 지금 살아 있는 잠금 명령의 id (없으면 null) */
export function commandId(): string | null {
  const v = get(CMD_KEY);
  return v ? v : null;
}

/** 자물쇠 값은 `<id>|<마지막 숨>`. 옛 값("1" 같은 id 만)도 id 로 읽힌다 */
function heldId(v: string | null): string | null {
  return v ? v.split("|")[0] : null;
}

function heldAt(v: string | null): number {
  const n = Number(v?.split("|")[1] ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function holdMine(cmd: string): void {
  set(MY_HELD, `${cmd}|${Date.now()}`);
}

/**
 * 나 말고 **아직 살아서** 자물쇠를 걸어 둔 창이 있나 — 명령 칸을 지워도 되는지 가른다.
 *
 * 삭은 자물쇠(5분 넘게 숨이 없는 것)는 지우면서 지나간다. 닫힌 창의 흔적이 쌓이면
 * 명령 칸을 치울 때가 영영 안 온다.
 */
function othersHeld(): boolean {
  let alive = false;
  try {
    const dead: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(HELD_PREFIX) || k === MY_HELD) continue;
      if (Date.now() - heldAt(get(k)) > STALE_MS) dead.push(k);
      else alive = true;
    }
    for (const k of dead) del(k);
  } catch {
    /* 못 훑으면 남아 있다고 본다 — 명령을 섣불리 지우면 잠긴 창이 풀려 버린다 */
    return true;
  }
  return alive;
}

/* 잠긴 동안만 숨을 쉰다 — 내 자물쇠가 살아 있다고 곁창에 알리는 유일한 수단이다 */
let beat: ReturnType<typeof setInterval> | null = null;

function startBeat(): void {
  if (beat !== null) return;
  beat = setInterval(() => {
    const cmd = commandId();
    if (cmd && heldId(get(MY_HELD)) === cmd) holdMine(cmd);
  }, BEAT_MS);
}

function stopBeat(): void {
  if (beat === null) return;
  clearInterval(beat);
  beat = null;
}

/**
 * **이 창이 잠겨 있나** — 화면을 그리기 전에도 답해야 한다(`lockPause` 의 첫 값).
 *
 * 자물쇠가 지금 명령과 같으면 잠김. 자물쇠가 없는데 명령이 살아 있으면 **새로 뜬 창**이니
 * 같이 잠그고 자물쇠를 건다. 자물쇠가 옛 명령 것이면(=그 번은 내가 풀었다) 안 잠긴다.
 */
export function lockedForThisWindow(): boolean {
  const cmd = commandId();
  if (!cmd) return false;
  /* 그 번은 내가 이미 풀었다 — 곁창이 아직 잠겨 있어 명령만 남은 것이다 */
  if (ses(CLEARED_KEY) === cmd) return false;
  /* 내 자물쇠든 새로 뜬 창이든 결론은 「잠김」이다 — 숨을 새로 쉬어 두고 잠근다 */
  holdMine(cmd);
  startBeat();
  return true;
}

let locked = typeof window === "undefined" ? false : lockedForThisWindow();
const listeners = new Set<(v: boolean) => void>();

function emit(): void {
  for (const fn of listeners) fn(locked);
}

export function subscribeLock(fn: (v: boolean) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function isLocked(): boolean {
  return locked;
}

/** 모든 창을 잠근다 — 명령 칸에 새 id, 내 자물쇠도 함께 */
export function lockAll(): void {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  set(CMD_KEY, id);
  holdMine(id);
  startBeat();
  locked = true;
  emit();
}

/**
 * **이 창만 푼다.** 명령 칸은 손대지 않는다 — 다른 창은 잠긴 채여야 한다.
 * 다만 잠긴 창이 더 없으면 명령도 지운다(안 지우면 다음에 띄우는 창이 잠긴 채로 뜬다).
 */
export function unlockThisWindow(): void {
  const cmd = commandId();
  if (cmd) setSes(CLEARED_KEY, cmd); // 새로고침해도 이 창은 풀린 채다
  del(MY_HELD);
  stopBeat();
  if (!othersHeld()) del(CMD_KEY);
  locked = false;
  emit();
}

/* ── 다른 창의 변화를 듣는다 ─────────────────────────────────────────────
 *
 * 명령 칸이 **새 id 로 바뀌면** 잠근다(그게 「한 번에 잠근다」다). 명령 칸이 **지워지면**
 * 아무 일도 안 한다 — 마지막 창이 풀면서 치운 것이고, 내 자물쇠가 내 상태를 쥔다.
 * 자물쇠는 창마다 자기 것만 쓰므로 남의 자물쇠 변화는 볼 일이 없다.
 */
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== CMD_KEY) return;
    const cmd = e.newValue ? e.newValue : null;
    if (!cmd) return;
    if (heldId(get(MY_HELD)) === cmd) return; // 내가 잠근 그 번이다
    holdMine(cmd);
    startBeat();
    if (!locked) {
      locked = true;
      emit();
    }
  });
}
