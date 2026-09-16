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

/**
 * **며칠 안을 셀까** — 전역 (2026-09-10 — 벤티지: "필터에 뉴스랑 텔레 기준 넣어서 시간별 일자별
 * 쌓인 거 볼 수 있게 해줘. 1일 3일 5일 10일 20일 이런 식이거나 아니면 내가 설정할 수 있거나").
 *
 * 시세분석의 표 다섯이 같은 훅을 쓰므로 값도 하나다 — 한 표에서 바꾸면 전부 따라온다.
 * 이 기기에 남는다(localStorage). 기본 1일: 「왜 지금 조회되나」엔 오늘 것이 답이다.
 */
const DAYS_KEY = "vntg.buzz.days";
export const BUZZ_DAY_CHOICES = [1, 3, 5, 10, 20];
let buzzDays = (() => {
  try {
    const n = Number(localStorage.getItem(DAYS_KEY));
    return Number.isFinite(n) && n > 0 ? Math.min(30, n) : 1;
  } catch {
    return 1;
  }
})();
const listeners = new Set<() => void>();
export function setBuzzDays(n: number): void {
  const v = Number.isFinite(n) && n > 0 ? Math.min(30, Math.round(n * 4) / 4) : 1;
  if (v === buzzDays) return;
  buzzDays = v;
  try {
    localStorage.setItem(DAYS_KEY, String(v));
  } catch {
    /* 못 남겨도 이번 세션엔 산다 */
  }
  for (const l of listeners) l();
}
export function useBuzzDays(): number {
  const [d, setD] = useState(buzzDays);
  useEffect(() => {
    const l = () => setD(buzzDays);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return d;
}
const daysLabel = (d: number) => (d === 1 ? "24시간" : Number.isInteger(d) ? `${d}일` : `${d}일`);

/** 「뉴스·텔레 1일 3일 5일 10일 20일 [n]」 — 표 머리에 놓는 단추 줄 */
export function BuzzDaysButtons() {
  const days = useBuzzDays();
  const [text, setText] = useState("");
  const custom = !BUZZ_DAY_CHOICES.includes(days);
  const commit = () => {
    const n = Number(text);
    if (Number.isFinite(n) && n > 0) setBuzzDays(n);
    setText("");
  };
  return (
    <span className="buzz-days" title="뉴스·텔레그램 언급 수를 며칠 안에서 셀지 — 시세분석·현미경 표 전부에 한 값">
      <span className="pt-n">📰✈</span>
      {BUZZ_DAY_CHOICES.map((d) => (
        <button key={d} type="button" className={`filter-btn${days === d ? " active" : ""}`} onClick={() => setBuzzDays(d)}>
          {d}일
        </button>
      ))}
      <input
        className={`buzz-days-in${custom ? " active" : ""}`}
        inputMode="decimal"
        placeholder={custom ? `${days}일` : "n일"}
        value={text}
        onChange={(e) => setText(e.target.value.replace(/[^\d.]/g, ""))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        title="직접 입력 — 0.25(6시간)~30일"
      />
    </span>
  );
}

export function useBuzz(codes: string[], enabled = true) {
  const days = useBuzzDays();
  const [counts, setCounts] = useState<Record<string, Count>>({});
  const [open, setOpen] = useState<{ code: string; name: string } | null>(null);
  /* 언제 물었나 — 5분 안이면 다시 안 묻는다 (표가 10초마다 새로 그려도). 기간을 바꾸면 전부 다시 */
  const askedAt = useRef<Record<string, number>>({});
  const daysRef = useRef(days);
  if (daysRef.current !== days) {
    daysRef.current = days;
    askedAt.current = {};
  }
  /*
   * **순서를 지운 열쇠** (2026-09-16 — 벤티지: "뉴스랑 텔레그램 카드 붙다가 안 붙다가 하는데 이유가 뭐야").
   *
   * 예전엔 보이는 순서 그대로 이어 붙였다. 표는 10초마다 새로 받아 순위가 조금씩 바뀌므로 **같은
   * 종목들인데 열쇠가 매번 달랐다** — 그때마다 아래 효과가 다시 돌면서 진행 중이던 응답을 버렸다
   * (옛 `alive` 깃발). 그런데 「물었다」는 도장(`askedAt`)은 이미 찍혀 있어서 그 종목들은 **5분 동안
   * 다시 안 묻는다** → 배지가 빈 채로 5분. 처음 묻는 100종목은 네이버 뉴스 검색 100번이라 5~15초가
   * 걸리니 10초 폴링 한 바퀴 안에 끝나기 어려웠고, 캐시가 데워진 뒤에야 붙었다. 그래서 붙다가 안 붙다가.
   *
   * 정렬해 잇는다 — 순서가 바뀌어도 같은 집합이면 같은 열쇠다. 그리고 **응답은 절대 버리지 않는다**
   * (종목별 값이라 늦게 와도 그대로 맞다). 화면을 떠났을 때만 안 그린다(`mounted`).
   */
  const key = enabled ? [...new Set(codes.filter((c) => /^\d{6}$/.test(c)))].sort().join(",") : "";
  const mounted = useRef(true);
  useEffect(() => {
    /* ⚠️ 본문에서 다시 켠다 — 개발 모드(StrictMode)는 효과를 붙였다 뗐다 다시 붙이므로, 정리만 두면 첫 정리에서 영영 꺼진다 */
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  /* 지금 묻는 중인 것 — 「아직 세는 중」과 「없음」을 화면에서 가르기 위해 */
  const [pending, setPending] = useState<Record<string, true>>({});

  useEffect(() => {
    if (!key) return;
    const now = Date.now();
    const want = key.split(",").filter((c) => now - (askedAt.current[c] ?? 0) > FRESH_MS);
    if (want.length === 0) return;
    for (const c of want) askedAt.current[c] = now;
    setPending((prev) => {
      const next = { ...prev };
      for (const c of want) next[c] = true;
      return next;
    });
    const settle = (chunk: string[]) => {
      if (!mounted.current) return;
      setPending((prev) => {
        const next = { ...prev };
        for (const c of chunk) delete next[c];
        return next;
      });
    };
    /* 100 개씩 — 서버가 한 번에 받는 상한 */
    const chunks: string[][] = [];
    for (let i = 0; i < want.length; i += 100) chunks.push(want.slice(i, i + 100));
    for (const chunk of chunks) {
      api
        .rankBuzz(chunk, days)
        .then((r) => {
          if (!mounted.current) return;
          setCounts((prev) => {
            const next = { ...prev };
            for (const it of r.items) next[it.code] = { news: it.news, tg: it.tg };
            return next;
          });
          settle(chunk);
        })
        .catch(() => {
          /* 곁가지 — 못 받아도 표는 그대로. 도장을 지워 다음 그리기 때 바로 다시 묻는다 */
          for (const c of chunk) delete askedAt.current[c];
          settle(chunk);
        });
    }
  }, [key, days]);

  const badge = (code: string, name: string): ReactNode => {
    const b = counts[code];
    if (!b) {
      /* 세는 중이면 흐리게 자리만 — 안 보이면 「없다」로 읽힌다 */
      if (pending[code]) return <span className="scr-buzz scr-buzz-wait" title="뉴스·텔레그램 세는 중…">📰… ✈…</span>;
      return null;
    }
    return (
      <button
        className="scr-buzz"
        onClick={(e) => {
          e.stopPropagation();
          setOpen({ code, name });
        }}
        title={`${daysLabel(days)} 안 뉴스·텔레그램 — 눌러서 읽기`}
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

  return { counts, badge, sheet, days };
}
