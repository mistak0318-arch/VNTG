import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../api";
import { BuzzSheet } from "./BuzzSheet";

/**
 * 시세분석 **모든 표**의 「📰N ✈N」 (2026-09-09 밤 — 벤티지 "텔레랑 뉴스 엮어서
 * 시세분석에 표시한거 시세분석 전 메뉴에 적용해줘").
 *
 * 처음엔 조회순위 스무 줄에만 붙였다. 표가 넷(순위 표·동일순매매·연속매매·수익률 상위)
 * 이라 각자 붙이면 네 벌이 되므로 훅 하나로 묶는다 — 표는 **지금 보이는 쪽의 코드**만
 * 넘기고, 이름 칸에 `badge(code, name)` 을 찍고, 끝에 `sheet` 를 그리면 된다.
 *
 * ## 부하
 *
 * 보이는 쪽(≤100줄)만 묻고, 이미 아는 종목은 다시 안 묻는다(5분). 서버는 뉴스 수를
 * 15분, 텔레그램 수를 5분 캐시한다 — 쪽을 넘기거나 표를 옮겨도 같은 종목은 공짜다.
 */
type Count = { news: number | null; tg: number | null };

const FRESH_MS = 5 * 60_000;

export function useBuzz(codes: string[], enabled = true) {
  const [counts, setCounts] = useState<Record<string, Count>>({});
  const [open, setOpen] = useState<{ code: string; name: string } | null>(null);
  /* 언제 물었나 — 5분 안이면 다시 안 묻는다 (표가 10초마다 새로 그려도) */
  const askedAt = useRef<Record<string, number>>({});
  const key = enabled ? codes.filter((c) => /^\d{6}$/.test(c)).join(",") : "";

  useEffect(() => {
    if (!key) return;
    const now = Date.now();
    const want = key.split(",").filter((c) => now - (askedAt.current[c] ?? 0) > FRESH_MS);
    if (want.length === 0) return;
    for (const c of want) askedAt.current[c] = now;
    let alive = true;
    /* 100 개씩 — 서버가 한 번에 받는 상한 */
    const chunks: string[][] = [];
    for (let i = 0; i < want.length; i += 100) chunks.push(want.slice(i, i + 100));
    for (const chunk of chunks) {
      api
        .rankBuzz(chunk)
        .then((r) => {
          if (!alive) return;
          setCounts((prev) => {
            const next = { ...prev };
            for (const it of r.items) next[it.code] = { news: it.news, tg: it.tg };
            return next;
          });
        })
        .catch(() => {
          /* 곁가지 — 못 받아도 표는 그대로. 다음 5분에 다시 묻는다 */
          for (const c of chunk) delete askedAt.current[c];
        });
    }
    return () => {
      alive = false;
    };
  }, [key]);

  const badge = (code: string, name: string): ReactNode => {
    const b = counts[code];
    if (!b) return null;
    return (
      <button
        className="scr-buzz"
        onClick={(e) => {
          e.stopPropagation();
          setOpen({ code, name });
        }}
        title="24시간 안 뉴스·텔레그램 — 눌러서 읽기"
      >
        📰{b.news === null ? "?" : b.news >= 100 ? "99+" : b.news} ✈{b.tg === null ? "?" : b.tg}
      </button>
    );
  };

  const sheet = (onSelectStock?: (code: string, name: string) => void): ReactNode =>
    open ? (
      <BuzzSheet
        code={open.code}
        name={open.name}
        onClose={() => setOpen(null)}
        onSelectStock={
          onSelectStock
            ? (c, n) => {
                setOpen(null);
                onSelectStock(c, n);
              }
            : undefined
        }
      />
    ) : null;

  return { counts, badge, sheet };
}
