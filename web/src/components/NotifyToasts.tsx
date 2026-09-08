import { useEffect, useRef, useState } from "react";
import { api, type Notice } from "../api";
import { playSound, readNotifyPrefs, onNotifyPrefs, vibrate, type NotifyPrefs } from "../notifySound";

/**
 * **체결됐다는 걸 화면이 말해 준다** (2026-09-08).
 *
 * 벤티지: "체결되었을 때에는 토스트 메시지 보여주든지 해야겠다. 지금 되었는지 안 되었는지
 * 모르겠네."
 *
 * 알림함(종)에는 이미 쌓이고 있었다. 그런데 종은 **찾아가서 눌러야** 보이고 30초마다
 * 조용히 도는 것이라, 주문을 내고 화면을 보고 있는 사람에게는 아무 일도 안 일어난 것처럼
 * 보였다. 체결은 「놓치지 않게」가 아니라 **「지금 당장」**에 속하는 소식이다.
 *
 * ## 어떻게 아나
 *
 * 알림함과 같은 곳(`/api/notify`)을 본다. 새 알림 API 를 만들지 않은 이유는, 체결 알림을
 * 만드는 자리가 이미 서버에 있고 거기가 유일한 진실이기 때문이다. 두 갈래로 만들면
 * 「종에는 있는데 토스트는 안 떴다」가 반드시 생긴다.
 *
 * 12초에 한 번 — 종(30초)보다 빠르다. 체결은 30초 뒤에 알면 늦다.
 *
 * ## 처음 켤 때 쏟아지지 않게
 *
 * 첫 조회는 **알리지 않고 id 만 기억한다.** 안 그러면 앱을 열 때마다 아침에 쌓인 알림이
 * 한꺼번에 튀어나온다. 새로고침도 마찬가지다.
 */

const POLL_MS = 12_000;
/** 한 번에 이만큼까지만 — 서버가 밀린 걸 한꺼번에 뱉어도 화면이 안 막힌다 */
const MAX_AT_ONCE = 3;
const LIVE_MS = 7000;

interface ToastItem {
  id: string;
  title: string;
  body?: string;
  link?: string;
  level: Notice["level"];
  /** 사라지는 중 — 나가는 동안 자리를 지킨다 */
  out?: boolean;
}

/** 이 알림이 지금 설정에 걸리는가 */
function wanted(n: Notice, p: NotifyPrefs): boolean {
  const text = `${n.title} ${n.body ?? ""}`;
  const isFill = /체결/.test(text);
  const isOrder = isFill || /주문|감시|발동|손절|접수|취소/.test(text);
  if (p.scope === "fill") return isFill;
  if (p.scope === "order") return isOrder;
  return true;
}

export function NotifyToasts() {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seen = useRef<Set<string> | null>(null);
  const prefs = useRef<NotifyPrefs>(readNotifyPrefs());

  useEffect(() => onNotifyPrefs((p) => (prefs.current = p)), []);

  useEffect(() => {
    let alive = true;
    const pull = async () => {
      /* 탭이 뒤에 있으면 굳이 묻지 않는다 — 돌아오면 그때 한 번에 본다 */
      if (document.visibilityState === "hidden") return;
      try {
        const r = await api.notices({ limit: 30 });
        if (!alive) return;
        const p = prefs.current;
        /* 첫 바퀴는 기억만 — 열 때마다 쌓인 걸 쏟으면 안 된다 */
        if (seen.current === null) {
          seen.current = new Set(r.items.map((n) => n.id));
          return;
        }
        const fresh: Notice[] = [];
        for (const n of r.items) {
          if (seen.current.has(n.id)) continue;
          seen.current.add(n.id);
          if (!n.read && wanted(n, p)) fresh.push(n);
        }
        if (fresh.length === 0) return;
        /* 서버는 최신이 위다 — 오래된 것부터 쌓아야 새 것이 맨 위에 온다 */
        const take = fresh.slice(0, MAX_AT_ONCE).reverse();
        if (p.toast) {
          setItems((cur) => [...take.map((n) => ({ id: n.id, title: n.title, body: n.body, link: n.link, level: n.level })), ...cur].slice(0, 5));
        }
        /* 소리·진동은 **몇 건이 와도 한 번** — 세 번 울리면 그게 더 놀랍다 */
        if (p.sound) playSound(p.soundKey, p.volume);
        if (p.vibrate) vibrate(fresh.some((n) => n.level === "urgent") ? [120, 70, 120, 70, 120] : [90, 60, 90]);
      } catch {
        /* 못 받으면 조용히 — 종이 대신 쌓고 있다 */
      }
    };
    void pull();
    const t = window.setInterval(() => void pull(), POLL_MS);
    const onShow = () => {
      if (document.visibilityState === "visible") void pull();
    };
    document.addEventListener("visibilitychange", onShow);
    return () => {
      alive = false;
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", onShow);
    };
  }, []);

  const close = (id: string) => {
    setItems((cur) => cur.map((t) => (t.id === id ? { ...t, out: true } : t)));
    window.setTimeout(() => setItems((cur) => cur.filter((t) => t.id !== id)), 220);
  };

  /* 스스로 사라진다 — 새로 뜬 것만 시계를 건다 */
  useEffect(() => {
    const live = items.filter((t) => !t.out);
    if (live.length === 0) return;
    const timers = live.map((t) => window.setTimeout(() => close(t.id), LIVE_MS));
    return () => timers.forEach((x) => window.clearTimeout(x));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.map((t) => `${t.id}${t.out ? "x" : ""}`).join(",")]);

  if (items.length === 0) return null;
  return (
    <div className="nt-host" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`nt-toast ${t.level}${t.out ? " out" : ""}`}>
          <button
            type="button"
            className="nt-main"
            onClick={() => {
              if (t.link) window.location.hash = t.link;
              void api.noticesRead([t.id]).catch(() => undefined);
              close(t.id);
            }}
          >
            <b className="nt-title">{t.title}</b>
            {t.body && <span className="nt-body">{t.body}</span>}
            {t.link && <span className="nt-go">눌러서 보기 ›</span>}
          </button>
          <button type="button" className="nt-x" onClick={() => close(t.id)} aria-label="닫기">
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
