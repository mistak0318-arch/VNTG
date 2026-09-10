import { useEffect, useState } from "react";
import { api, fmtKstHm, type MarketLeaders, type PulseStock } from "../../api";

/**
 * 주도주·급소 — 상한가(연속)·거래량 급증·250일 거래량 갱신·프로그램 순매수 (2026-09-10).
 *
 * 종목등락현황이 「상한가 12개」라는 수를 주면 여기는 **얼굴**을 준다. 넷을 한 카드에 두는
 * 이유: 상한가 얼굴(테마) → 거래가 붙는 곳(급증·갱신) → 큰돈의 방향(프로그램) 순으로 읽으면
 * 「오늘 시장이 어디로 힘을 쓰는가」가 한 번에 잡힌다. 60초마다 갱신.
 */
export function PulsePanel({ onSelectStock }: { onSelectStock: (code: string, name: string) => void }) {
  const [data, setData] = useState<MarketLeaders | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .marketLeaders()
        .then((d) => {
          if (!alive) return;
          setData(d);
          setErr(null);
        })
        .catch((e: Error) => alive && setErr(e.message));
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  if (err && !data) return <div className="error-banner">{err}</div>;
  if (!data) return <div className="empty">불러오는 중…</div>;

  const man = (n: number) => (n >= 1e8 ? `${(n / 1e8).toFixed(1)}억` : n >= 1e4 ? `${Math.round(n / 1e4).toLocaleString("ko-KR")}만` : n.toLocaleString("ko-KR"));
  const eok = (mil: number) => `${mil >= 0 ? "+" : "−"}${(Math.abs(mil) / 100).toFixed(mil >= 10000 ? 0 : 1)}억`;
  const chip = (s: PulseStock, tail: string, cls = "") => (
    <button type="button" key={s.code} className={`pulse-chip ${cls}`} onClick={() => onSelectStock(s.code, s.name)} title={`${s.name} ${s.price.toLocaleString("ko-KR")} (${s.rate > 0 ? "+" : ""}${s.rate}%)`}>
      <b>{s.name}</b>
      <span className={s.rate > 0 ? "positive" : s.rate < 0 ? "negative" : ""}>{s.rate > 0 ? "+" : ""}{s.rate}%</span>
      <i>{tail}</i>
    </button>
  );
  const empty = data.upper.length + data.lower.length + data.surge.length + data.renew.length + data.program.kospi.length + data.program.kosdaq.length === 0;

  return (
    <div className="pulse">
      {empty && <div className="empty">장이 열리면 채워집니다 — 상한가·거래 급증·프로그램은 장중 값입니다.</div>}
      {data.upper.length > 0 && (
        <div className="pulse-row">
          <span className="pulse-k positive">상한가 {data.upper.length}</span>
          <div className="pulse-chips">{data.upper.slice(0, 14).map((s) => chip(s, s.v >= 2 ? `${s.v}일째` : "", s.v >= 2 ? "streak" : ""))}</div>
          {data.upper.length > 14 && <span className="pt-n">+{data.upper.length - 14}</span>}
        </div>
      )}
      {data.lower.length > 0 && (
        <div className="pulse-row">
          <span className="pulse-k negative">하한가 {data.lower.length}</span>
          <div className="pulse-chips">{data.lower.slice(0, 8).map((s) => chip(s, s.v >= 2 ? `${s.v}일째` : ""))}</div>
        </div>
      )}
      {data.surge.length > 0 && (
        <div className="pulse-row">
          <span className="pulse-k" title="전일 하루치 대비 오늘 거래량 급증률 — 5만주 이상">거래 급증</span>
          <div className="pulse-chips">{data.surge.map((s) => chip(s, `×${(s.v / 100 + 1).toFixed(1)}`))}</div>
        </div>
      )}
      {data.renew.length > 0 && (
        <div className="pulse-row">
          <span className="pulse-k" title="오늘 거래량이 250일 최대를 넘어선 종목 — 1년 만의 손바뀜">1년 최대 거래</span>
          <div className="pulse-chips">{data.renew.map((s) => chip(s, man(s.v)))}</div>
        </div>
      )}
      {(data.program.kospi.length > 0 || data.program.kosdaq.length > 0) && (
        <div className="pulse-row">
          <span className="pulse-k" title="프로그램(차익·비차익) 순매수 상위 — 외국인·기관 바스켓의 방향">프로그램 매수</span>
          <div className="pulse-chips">
            {data.program.kospi.slice(0, 4).map((s) => chip(s, eok(s.v)))}
            {data.program.kosdaq.slice(0, 3).map((s) => chip(s, eok(s.v), "kq"))}
          </div>
        </div>
      )}
      {(data.program.kospiSell.length > 0 || data.program.kosdaqSell.length > 0) && (
        <div className="pulse-row">
          <span className="pulse-k">프로그램 매도</span>
          <div className="pulse-chips">
            {data.program.kospiSell.slice(0, 4).map((s) => chip(s, eok(s.v)))}
            {data.program.kosdaqSell.slice(0, 3).map((s) => chip(s, eok(s.v), "kq"))}
          </div>
        </div>
      )}
      <div className="pulse-foot pt-n">
        {fmtKstHm(data.at)} 기준 · 60초마다 · 코스닥은 <i className="pulse-kq">닥</i> 표시 · 누르면 종목 상세
        {data.errors.length > 0 && <span className="negative"> · 일부 실패: {data.errors.map((e) => e.split(":")[0]).join(", ")}</span>}
      </div>
    </div>
  );
}
