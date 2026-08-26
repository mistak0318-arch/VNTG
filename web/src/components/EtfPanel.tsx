import { useEffect, useState } from "react";
import { api, normalizeStockCode } from "../api";
import { StockDetail } from "./StockDetail";

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
  /** 지금은 안 쓴다 — 구성종목은 팝업으로 연다(아래 popup). 시그니처만 남겨 둔다 */
  onSelectStock?: (code: string, name: string) => void;
}) {
  const [info, setInfo] = useState<Info | null>(null);
  /*
   * 구성종목 클릭 → **팝업**(종목 상세 시트) (2026-08-25 — 사용자 요청).
   * 개별종목분석으로 페이지를 옮기면 ETF 화면으로 돌아오는 데 뒤로가기가 필요했다.
   * 팝업이면 닫는 순간 보던 ETF 가 그대로 있다. 팝업 안에서 또 다른 종목으로
   * 갈아타는 것도 팝업 안에서 돈다.
   */
  const [popup, setPopup] = useState<{ code: string; name: string } | null>(null);
  void onSelectStock;

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
  const dev = info.deviation ?? null;

  return (
    <div className="etf-panel">
      <div className="etf-head">
        <b>ETF 정보</b>
        {/*
          과세유형 (2026-08-27 — "세금 이슈를 고려할 수 있게"). 키움 ka40002 가
          한글로 준다: 비과세(국내 주식형) / 보유기간과세(해외·채권·파생형 —
          매매차익 15.4% 원천징수, 퇴직연금 계좌면 과세이연). 뱃지로 크게.
        */}
        {info.taxType && (
          <span className={`etf-tax${info.taxType.includes("비과세") ? " free" : ""}`}
            title={
              info.taxType.includes("비과세")
                ? "국내 주식형 — 매매차익 비과세 (분배금은 과세)"
                : "매매차익 배당소득세 15.4% 원천징수 — 연금계좌에서는 과세이연"
            }
          >
            {info.taxType}
          </span>
        )}
        <span className="pt-n">
          {info.issuer}
          {info.baseIndex && ` · 기초지수 ${info.baseIndex}`}
          {info.fee !== null && info.fee !== undefined && ` · 총보수 ${info.fee}%`}
        </span>
      </div>
      {/* ETF 에서만 봐야 하는 숫자들 — NAV·괴리율·추적오차 (키움 실측값) */}
      <div className="etf-facts num">
        {info.nav !== null && info.nav !== undefined && (
          <span>
            NAV <b>{Math.round(info.nav).toLocaleString("ko-KR")}</b>
          </span>
        )}
        {dev !== null && (
          <span title="(현재가 − NAV) ÷ NAV — 양수면 순자산보다 비싸게 거래 중">
            괴리율{" "}
            <b className={Math.abs(dev) >= 0.5 ? (dev > 0 ? "positive" : "negative") : ""}>
              {dev > 0 ? "+" : ""}
              {dev.toFixed(2)}%
            </b>
          </span>
        )}
        {info.traceErr !== null && info.traceErr !== undefined && (
          <span title="추적오차율 — 클수록 기초지수를 못 따라갑니다">
            추적오차 <b>{info.traceErr.toFixed(2)}%</b>
          </span>
        )}
      </div>
      <div className="etf-list">
        {info.constituents.map((c) => (
          <button
            key={c.code || c.name}
            className="etf-row"
            disabled={!c.code}
            onClick={() => c.code && setPopup({ code: normalizeStockCode(c.code), name: c.name })}
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
        종목을 누르면 팝업으로 열립니다 — 닫으면 이 화면이 그대로 있습니다.
      </div>

      {popup && (
        <StockDetail
          code={popup.code}
          name={popup.name}
          onClose={() => setPopup(null)}
          onSelectStock={(c, n) => setPopup({ code: c, name: n })}
        />
      )}
    </div>
  );
}
