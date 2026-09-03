import { useEffect, useState } from "react";

/**
 * **새 번들이 올라왔나** (2026-09-03).
 *
 * 벤티지: "모바일에서 시스 위치 변경이 안 돼 / 진행 상황도 안 보인다 긁는 중이라고만 나오고." 둘 다
 * 그날 오후에 넣은 기능인데 폰의 PWA 탭은 아침에 연 채라 **옛 번들**을 붙들고 있었다. 서비스워커는
 * 네트워크 우선이라 새로고침만 하면 되는데, 열어 둔 탭은 스스로 새로고침하지 않는다.
 *
 * 그래서 앱이 스스로 묻는다 — 지금 `index.html` 이 가리키는 메인 스크립트가 내가 실행 중인 것과 같은가.
 * 다르면 띠 하나 띄우고 새로고침을 권한다(강제로 하지 않는다 — 입력 중일 수 있다).
 * 3분마다, 그리고 탭이 다시 보일 때. 개발 서버(vite)는 해시 파일이 없어 아무 일도 안 한다.
 */
function currentMain(): string | null {
  const s = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]');
  if (!s) return null;
  const m = s.src.match(/\/assets\/([^/?#]+\.js)/);
  return m ? m[1] : null;
}

async function remoteMain(): Promise<string | null> {
  try {
    const res = await fetch(`${window.location.pathname}?_=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(/\/assets\/(index-[^"'/?#]+\.js)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export function useBuildWatch(): { stale: boolean; dismiss: () => void } {
  const [stale, setStale] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    const mine = currentMain();
    if (!mine) return; // 개발 서버
    let alive = true;
    const check = async () => {
      if (document.visibilityState !== "visible") return;
      const theirs = await remoteMain();
      if (alive && theirs && theirs !== mine) setStale(true);
    };
    const t = setInterval(() => void check(), 3 * 60_000);
    const onVis = () => void check();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      alive = false;
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);
  return { stale: stale && !dismissed, dismiss: () => setDismissed(true) };
}
