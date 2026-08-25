import { useEffect, useState } from "react";
import { api, normalizeStockCode } from "../api";

/**
 * ETF 구성종목 (2026-08-25) — 종목이 ETF 일 때만 종합 화면에 끼어드는 블록.
 *
 * 「이 ETF 를 사면 사실상 무엇을 사는 건가」에 답한다 — KODEX 200 은 삼성전자
 * 33.6% + SK하이닉스 26.6%, 즉 **3분의 2가 반도체 두 종목**이다. 그걸 모르고
 * 지수 분산이라 생각하면 판단이 어긋난다.
 *
 * 출처는 네이버(키움 REST 의 ETF 묶음엔 구성종목이 없다 — 문서로 확인).
 * Top10 + 비중이면 충분하다. 종목을 누르면 그 종목으로 갈아탄다.
 */

type Info = Awaited<ReturnType<typeof api.etfInfo>>;

export function EtfPanel({
  code,
  onSelectStock,
}: {
  code: string;
  onSelectStock?: (code: string, name: string) => void;
}) {
  const [info, setInfo] = useState<Info | null>(null);

  useEffect(() => {
    let alive = true;
    setInfo(null);
    api
      .etfInfo(code)
      .then((r) => alive && setInfo(r))
      .catch(() => alive && setInfo({ etf: false }));
    return () => {
      alive = false;
    };
  }, [code]);

  if (!info?.etf || !info.constituents?.length) return null;
  const max = Math.max(...info.constituents.map((c) => c.weight ?? 0), 1);
  const top2 = info.constituents.slice(0, 2).reduce((a, c) => a + (c.weight ?? 0), 0);

  return (
    <div className="etf-panel">
      <div className="etf-head">
        <b>ETF 구성종목</b>
        <span className="pt-n">
          {info.issuer}
          {info.baseIndex && ` · 기초지수 ${info.baseIndex}`}
          {info.fee !== null && info.fee !== undefined && ` · 총보수 ${info.fee}%`}
          {info.deviation !== null && info.deviation !== undefined && ` · 괴리율 ${info.deviation}%`}
        </span>
      </div>
      <div className="etf-list">
        {info.constituents.map((c) => (
          <button
            key={c.code || c.name}
            className="etf-row"
            disabled={!c.code}
            onClick={() => c.code && onSelectStock?.(normalizeStockCode(c.code), c.name)}
          >
            <span className="etf-name">{c.name}</span>
            <span className="etf-bar">
              <i style={{ width: `${((c.weight ?? 0) / max) * 100}%` }} />
            </span>
            <span className="num etf-w">{c.weight === null ? "-" : `${c.weight.toFixed(1)}%`}</span>
          </button>
        ))}
      </div>
      <div className="table-note">
        상위 10개 · 비중은 네이버 기준(하루 몇 번 갱신).
        {top2 >= 40 && (
          <>
            {" "}
            상위 두 종목이 <b>{top2.toFixed(0)}%</b> — 지수 이름이어도 사실상 이 두 종목을 사는
            것에 가깝습니다.
          </>
        )}{" "}
        종목을 누르면 그 종목으로 이동합니다.
      </div>
    </div>
  );
}
