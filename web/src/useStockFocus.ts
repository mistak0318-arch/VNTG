import { useCallback, useEffect, useState } from "react";

/**
 * 종목 전파 — **여러 창을 한 프로그램처럼 묶는다.**
 *
 * 한쪽 창에서 종목을 고르면 열려 있는 다른 창들이 같은 종목으로 따라온다.
 * 모니터를 여러 대 쓰면 한쪽은 조회, 다른 쪽은 차트·수급·공매도 보드로 두고
 * 종목만 바꿔 가며 볼 수 있다 — HTS 가 창을 연동시키는 그 모양이다.
 *
 * ## 두 갈래로 보낸다
 *
 *   · **같은 브라우저의 창끼리** — `BroadcastChannel`. 서버를 안 거치니 지연이 없다.
 *   · **다른 기기(미니PC·회사PC·폰)** — 서버에 한 칸 두고 짧은 주기로 물어본다.
 *
 * 둘 중 하나만으로는 안 된다. BroadcastChannel 은 기기를 못 넘고, 서버만 쓰면
 * 바로 옆 창을 바꾸는 데도 왕복이 생긴다.
 *
 * ## 한 창에 하나만 돈다
 *
 * 상태를 **모듈에 두고** 훅은 구독만 한다. 사이드바의 켜기 버튼과 보드 화면이
 * 각각 훅을 쓰는데, 훅마다 상태를 따로 들면 한쪽에서 켠 연동이 다른 쪽에는
 * 꺼진 것으로 보인다. 채널과 폴링도 창마다 하나면 충분하다 —
 * 훅을 쓰는 곳이 늘 때마다 서버에 묻는 횟수가 같이 늘면 안 된다.
 *
 * ## 메아리를 막는다
 *
 * 내가 보낸 것이 서버를 돌아 나에게 다시 오면, 그걸 또 받아서 보내는 고리가 생긴다.
 * 그래서 창마다 아이디를 하나 만들어 **내가 보낸 것은 무시**하고,
 * 시각이 **더 새로운 것만** 받아들인다(늦게 도착한 옛 소식이 최신을 덮으면 안 된다).
 *
 * ## 기기마다 켜고 끈다
 *
 * 설정을 서버에 두면 회사에서 켠 연동이 집에서도 켜진다. 「이 창을 보드로 쓸지」는
 * 그 자리의 사정이라 **localStorage** 에 둔다. 끈 창은 보내지도 받지도 않는다.
 */

const KEY = "vntg.focus.on";
const CHANNEL = "vntg.focus";
/** 다른 기기 것을 얼마나 자주 물어볼지 */
const POLL_MS = 1500;

export interface Focus {
  code: string;
  name: string;
  at: number;
  by: string;
}

/** 이 창의 아이디 — 새로고침하면 새로 받는다. 메아리를 가려내는 데만 쓴다 */
const ME = Math.random().toString(36).slice(2, 10);

/* ------------------------------------------------------------------ */
/* 창에 하나뿐인 상태                                                    */
/* ------------------------------------------------------------------ */

function readOn(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

let on = readOn();
let focus: Focus | null = null;
/** 지금까지 받아들인 것 중 가장 새로운 시각 */
let seen = 0;

const listeners = new Set<() => void>();
function emit(): void {
  for (const l of listeners) l();
}

let chan: BroadcastChannel | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

function accept(f: Focus | null): void {
  if (!f) return;
  // 내가 보낸 메아리이거나, 이미 지나간 소식이면 버린다
  if (f.by === ME || f.at <= seen) return;
  seen = f.at;
  focus = f;
  emit();
}

async function pull(): Promise<void> {
  try {
    const r = await fetch("/api/focus");
    const j = (await r.json()) as { focus: Focus | null };
    accept(j.focus);
  } catch {
    /* 끊겨도 같은 브라우저 창끼리는 계속 돈다 */
  }
}

/** 연동이 켜져 있을 때만 채널과 폴링을 돌린다 */
function sync(): void {
  if (on) {
    if (!chan && typeof BroadcastChannel !== "undefined") {
      chan = new BroadcastChannel(CHANNEL);
      chan.onmessage = (e) => accept(e.data as Focus);
    }
    if (!timer) {
      void pull();
      timer = setInterval(() => void pull(), POLL_MS);
    }
  } else {
    chan?.close();
    chan = null;
    if (timer) clearInterval(timer);
    timer = null;
  }
}

sync();

/* ------------------------------------------------------------------ */

export function useStockFocus() {
  const [, bump] = useState(0);

  useEffect(() => {
    const l = () => bump((n) => n + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);

  /**
   * 종목을 골랐다고 알린다.
   *
   * 시각은 **일단 내 시계로** 찍어 옆 창에 즉시 보내고, 서버에는 서버가 다시 찍게
   * 맡긴다. 기기마다 시계가 어긋나 있어도 서버 쪽 순서는 서버 기준으로 정해진다.
   */
  const publish = useCallback((code: string, name: string) => {
    if (!on || !code) return;
    const f: Focus = { code, name, at: Date.now(), by: ME };
    seen = f.at;
    focus = f;
    emit();
    chan?.postMessage(f);
    void fetch("/api/focus", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, name, by: ME }),
    }).catch(() => undefined);
  }, []);

  const toggle = useCallback((next: boolean) => {
    on = next;
    try {
      localStorage.setItem(KEY, next ? "1" : "0");
    } catch {
      /* 저장 못 해도 이번 세션에는 켜진다 */
    }
    sync();
    emit();
  }, []);

  return { on, toggle, focus, publish };
}
