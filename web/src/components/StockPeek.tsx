import { useEffect, useRef, useState } from "react";
import { api, fmtNum, type SignalResult, type StockSummaryData } from "../api";

/**
 * **종목 살짝 보기** — 이름을 누르면 그 자리에 뜨는 작은 카드 (2026-09-07).
 *
 * 벤티지: "굳이 클릭해서 다른 페이지로 넘어가야 하는 이유가 있는 건가? 그냥 누르면 뭐
 * 알려주고 싶으면 미니 팝업이나 플로팅으로도 충분한 기능일 거 같은데."
 *
 * 맞다. 주문 화면에서 종목명을 누르면 **새 탭으로 개별종목분석**이 열렸다 — 값을 적기
 * 전에 한 번 더 보라는 뜻이었는데, 그러려고 앱 하나를 통째로 더 띄우는 건 과했다.
 * 미니창(560px) 안에서는 더 이상했다 — 거기서 새 탭이 뜨면 작은 창이 하나 더 생긴다.
 *
 * 여기서 답할 물음은 「지금 어디쯤인가」 하나다: 현재가와 오늘의 시·고·저, 거래대금,
 * 체결강도, 오늘 외국인·기관·개인, 그리고 신호등 점수. 그 이상이 필요하면 카드 안의
 * 「종목 상세」로 간다 — 길은 남기되 기본은 그 자리다.
 *
 * `LiveDot` 과 같은 방식이다 — 열었을 때만 두드리고, 밖을 누르면 닫힌다.
 */

const sign = (v: number | null | undefined) => (v === null || v === undefined || v === 0 ? "" : v > 0 ? "positive" : "negative");
const 억 = (v: number) => {
  const a = Math.abs(v);
  const s = a >= 10_000 ? `${(v / 10_000).toFixed(1)}조` : `${Math.round(v).toLocaleString("ko-KR")}억`;
  return v > 0 ? `+${s}` : s;
};
const LEVEL: Record<string, { dot: string; word: string }> = {
  green: { dot: "🟢", word: "초록" },
  yellow: { dot: "🟡", word: "노랑" },
  red: { dot: "🔴", word: "빨강" },
  unknown: { dot: "⚪", word: "모름" },
};

export function StockPeek({
  code,
  name,
  className,
  onOpenDetail,
}: {
  code: string;
  name: string;
  className?: string;
  /** 카드 안의 「종목 상세」 — 화면마다 여는 법이 달라 밖에서 준다. 없으면 단추도 없다 */
  onOpenDetail?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [sum, setSum] = useState<StockSummaryData | null>(null);
  const [sig, setSig] = useState<SignalResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  /* 오른쪽으로 넘치면 왼쪽으로 붙인다 — 이름이 줄 오른쪽에 있을 때 카드가 화면 밖으로 나갔다 */
  const [flip, setFlip] = useState(false);
  useEffect(() => {
    if (!open) return;
    const r = popRef.current?.getBoundingClientRect();
    if (r) setFlip(r.right > window.innerWidth - 4);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setErr(null);
    /* 둘을 따로 받는다 — 신호등이 늦거나 실패해도 시세는 먼저 뜬다 */
    api
      .stockSummary(code)
      .then((s) => alive && setSum(s))
      .catch((e: Error) => alive && setErr(e.message));
    api
      .signal(code)
      .then((s) => alive && setSig(s))
      .catch(() => undefined);
    const t = setInterval(() => {
      api.stockSummary(code).then((s) => alive && setSum(s)).catch(() => undefined);
    }, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [open, code]);

  useEffect(() => {
    setSum(null);
    setSig(null);
  }, [code]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const f = sum?.facts;
  const flow = (k: string) => sum?.main.find((m) => m.key === k)?.amount;
  const lv = LEVEL[sig?.level ?? "unknown"];

  return (
    <div className="peek-wrap" ref={boxRef}>
      <button
        type="button"
        className={className ?? "peek-btn"}
        onClick={() => setOpen((v) => !v)}
        title="눌러서 지금 어디쯤인지 — 그 자리에서"
      >
        {name || code}
      </button>

      {open && (
        <div className={`peek-pop${flip ? " flip" : ""}`} ref={popRef}>
          <div className="peek-h">
            <b>{name || code}</b>
            <span className="pt-n">{code}</span>
            {f && (
              <span className={`peek-price ${sign(f.changeRate)}`}>
                {fmtNum(f.price)}
                <i>
                  {f.changeRate > 0 ? "+" : ""}
                  {f.changeRate.toFixed(2)}%
                </i>
              </span>
            )}
          </div>

          {err && <p className="peek-err">{err}</p>}
          {!f && !err && <p className="pt-n">받는 중…</p>}

          {f && (
            <dl className="peek-kv">
              <div><dt>시가</dt><dd className={sign(f.open - f.prevClose)}>{fmtNum(f.open)}</dd></div>
              <div><dt>고가</dt><dd className="positive">{fmtNum(f.high)}</dd></div>
              <div><dt>저가</dt><dd className="negative">{fmtNum(f.low)}</dd></div>
              <div><dt>전일</dt><dd>{fmtNum(f.prevClose)}</dd></div>
              <div><dt>거래대금</dt><dd>{f.tradeValue === null ? "-" : `${Math.round(f.tradeValue).toLocaleString("ko-KR")}억`}</dd></div>
              <div title="100 보다 크면 사는 쪽이 세다"><dt>체결강도</dt><dd className={f.strength === null ? "" : f.strength >= 100 ? "positive" : "negative"}>{f.strength === null ? "-" : f.strength.toFixed(0)}</dd></div>
              {f.marketCap !== null && <div><dt>시총</dt><dd>{f.marketCap >= 10_000 ? `${(f.marketCap / 10_000).toFixed(1)}조` : `${Math.round(f.marketCap).toLocaleString("ko-KR")}억`}</dd></div>}
            </dl>
          )}

          {sum && sum.main.length > 0 && (
            <div className="peek-flow">
              <span className="pt-n">오늘</span>
              {(["frgnr_invsr", "orgn", "ind_invsr"] as const).map((k) => {
                const v = flow(k);
                if (v === undefined) return null;
                return (
                  <span key={k} className={sign(v)}>
                    {k === "frgnr_invsr" ? "외인" : k === "orgn" ? "기관" : "개인"} {억(v / 100)}
                  </span>
                );
              })}
            </div>
          )}

          <div className="peek-sig">
            {sig ? (
              <>
                <span>
                  {lv.dot} 신호등 <b>{sig.score.toFixed(0)}점</b> <span className="pt-n">{lv.word}</span>
                </span>
                <span className="pt-n peek-axes">
                  {sig.axes
                    .filter((a) => a.score !== null)
                    .map((a) => `${a.label} ${Math.round(a.score as number)}`)
                    .join(" · ")}
                </span>
              </>
            ) : (
              <span className="pt-n">신호등 받는 중…</span>
            )}
          </div>

          {onOpenDetail && (
            <button type="button" className="filter-btn peek-more" onClick={onOpenDetail}>
              📈 종목 상세 (새 탭)
            </button>
          )}
        </div>
      )}
    </div>
  );
}
