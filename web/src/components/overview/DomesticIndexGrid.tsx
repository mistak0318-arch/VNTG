import { useEffect, useState } from "react";
import { MarketTrendSheet } from "../MarketTrendSheet";
import { api, fmtNum, type IndexCard, type MarketFlow } from "../../api";
import type { FuturesDetailTarget } from "./FuturesDetailSheet";
import { Sparkline } from "./Sparkline";

/**
 * 국내 지수 타일 + 종목등락현황 표 — **시황 대시보드와 보드 지수판이 같은 것을 쓴다.**
 *
 * 원래 시황(OverviewPage) 안에 인라인으로 있었는데, 보드의 지수판을 「시황의
 * 저 세 카드를 합친 것」으로 바꾸면서(2026-08-26) 여기로 빼냈다 —
 * 같은 값을 두 번 그리면 언젠가 반드시 갈라진다(해외 관심종목 표에서 실제로 겪었다).
 */

function signCls(v: number): string {
  return v > 0 ? "up" : v < 0 ? "down" : "flat";
}

function fmtPct(v: number): string {
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function fmtSigned(v: number): string {
  return `${v > 0 ? "▲ " : v < 0 ? "▼ " : ""}${fmtNum(Math.abs(v))}`;
}

export interface FutFlowDay {
  date: string;
  individual: number;
  foreign: number;
  institution: number;
}

/**
 * 선물 투자자별 수급 (네이버, 계약 단위) — 선물 타일의 「받을 데가 없다」 자리.
 * 서버가 10분 캐시라 5분마다 물으면 충분하다. 마지막 날(장중이면 오늘 누적)만 쓴다.
 */
export function useFutFlow(): FutFlowDay | null {
  const [futFlow, setFutFlow] = useState<FutFlowDay | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .futuresFlow(1)
        .then((r) => alive && r.days.length > 0 && setFutFlow(r.days[r.days.length - 1]))
        .catch(() => undefined);
    void load();
    const t = setInterval(load, 5 * 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return futFlow;
}

export function DomesticIndexGrid({
  idx,
  flow,
  futFlow,
  onOpenIndex,
  onOpenFutures,
}: {
  idx: IndexCard[];
  flow: MarketFlow | null | undefined;
  futFlow: FutFlowDay | null;
  /** 코스피(001)·코스닥(101) 타일을 눌렀을 때 — 일·주·월봉 시트 */
  onOpenIndex: (code: string) => void;
  /** 선물 타일을 눌렀을 때 — 선물 상세 시트 */
  onOpenFutures: (target: FuturesDetailTarget) => void;
}) {
  return (
    <div className="ov-idx-grid">
      {idx.map((c) => {
        /*
         * **선물·코스피200 에는 수급을 붙이지 않는다.**
         *
         * 여기 수급은 `ka10051` 주식시장 투자자 순매수다. 선물은 완전히 다른
         * 시장이라 그 값을 갖다 붙이면 **틀린 값을 보여주는 것**이 된다.
         * 코스피200 도 마찬가지였다 — 「부분집합이니 참고」라며 코스피 수급을
         * 그대로 붙여 뒀더니 키움 앱(코스피200 외인 769 / 기관 6,608)과 달라
         * 혼란만 줬다(2026-08-27 사용자 지적). ka10051 은 코스피200 행을 안
         * 주고(mrkt_tp 2·3 빈 응답 실측), 네이버에도 없다 — 소스가 없으면
         * 안 붙이는 게 맞다. 없는 것보다 틀린 게 나쁘다.
         *
         * 선물 수급은 네이버(investorDealTrendDay, sosok=03)에서 찾아 futFlow 로
         * 붙였다. 단위는 계약이다.
         */
        const f =
          c.code === "F" || c.code === "201"
            ? null
            : c.code === "101"
              ? flow?.kosdaq
              : flow?.kospi;
        /*
          코스피·코스닥은 눌러서 상세로 간다. 선물도 같은 구조로 —
          차트 + 베이시스·미결제 + 장중 수급 + 일별 수급 시트가 열린다.
          코스피200 은 아직 상세가 없어 그대로 둔다.
        */
        const openable = c.code === "001" || c.code === "101" || (c.code === "F" && !!c.futures);
        const open =
          c.code === "F"
            ? () =>
                c.futures &&
                onOpenFutures({
                  code: c.futures.code,
                  name: c.futures.name,
                  price: c.price,
                  changeRate: c.changeRate,
                  basis: c.futures.basis,
                  openInterest: c.futures.openInterest,
                })
            : () => onOpenIndex(c.code);
        return (
          <div
            className={`ov-idx${openable ? " clickable" : ""}`}
            key={c.code}
            onClick={openable ? open : undefined}
            title={openable ? "눌러서 추이·수급 보기" : undefined}
          >
            <div className="ov-idx-name">{c.name}</div>
            <div className={`ov-idx-val num ${signCls(c.changeRate)}`}>{fmtNum(c.price)}</div>
            <div className={`ov-idx-chg num ${signCls(c.changeRate)}`}>
              {fmtSigned(c.change)} {fmtPct(c.changeRate)}
            </div>
            <Sparkline values={c.sparkline} up={c.changeRate >= 0} />
            {/* 베이시스·미결제는 시트에 있다 — 타일엔 월물 이름만 */}
            {c.futures && (
              <div className="ov-fut">
                <span className="pt-n" title="눌러서 차트·베이시스·수급 시트">
                  {c.futures.name}
                </span>
              </div>
            )}
            {/*
              선물 수급 — 계약 → ≈억원 환산. 키움 앱은 선물 수급을 억원으로 보여줘서
              「값이 다르다」 소리가 나왔다 — 같은 데이터, 단위 차이.
              K200 선물 승수 25만원/pt: 억원 = 계약 × 지수 / 400 (현재가 기준 ≈).
              **금액이 위(크게), 계약이 아래(작게)** — 지수 수급(억원)과 같은 눈으로.
            */}
            {c.code === "F" &&
              futFlow &&
              (() => {
                // 「억」 글자는 뺀다 — 이 카드의 수급은 다 억원이라 접미가 소음이다
                const eok = (n: number) =>
                  `${n > 0 ? "+" : ""}${fmtNum(Math.round((n * c.price) / 400))}`;
                const row = (lbl: string, n: number) => (
                  <div>
                    <span className="lbl">{lbl}</span>
                    <span className={`ff-two ${signCls(n)}`}>
                      {c.price > 0 ? eok(n) : `${n > 0 ? "+" : ""}${fmtNum(n)}`}
                      <em className="ff-eok">
                        {n > 0 ? "+" : ""}
                        {fmtNum(n)}계약
                      </em>
                    </span>
                  </div>
                );
                return (
                  <div className="ov-idx-flow num">
                    {row("외국인", futFlow.foreign)}
                    {row("기관", futFlow.institution)}
                    {row("개인", futFlow.individual)}
                  </div>
                );
              })()}
            {c.code === "F" && (
              <div
                className="ov-idx-note ov-idx-note-1"
                title="큰 값은 ≈억원 환산(계약 × 지수 × 25만원), 아래 작은 값이 원본 계약 수 · 네이버 투자자별 매매동향(±10분 지연)"
              >
                {futFlow
                  ? `${futFlow.date.slice(5).replace("-", "/")} 순매수 · 네이버 ±10분`
                  : "선물 수급 불러오는 중…"}
              </div>
            )}
            {f && (
              <div className="ov-idx-flow num">
                <div>
                  <span className="lbl">외국인</span>
                  <span className={signCls(f.foreign)}>
                    {f.foreign > 0 ? "+" : ""}
                    {fmtNum(f.foreign)}
                  </span>
                </div>
                <div>
                  <span className="lbl">기관</span>
                  <span className={signCls(f.institution)}>
                    {f.institution > 0 ? "+" : ""}
                    {fmtNum(f.institution)}
                  </span>
                </div>
                <div>
                  <span className="lbl">개인</span>
                  <span className={signCls(f.individual)}>
                    {f.individual > 0 ? "+" : ""}
                    {fmtNum(f.individual)}
                  </span>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** 종목등락현황 — 상한·상승·보합·하락·하한 표. 재료는 지수 카드에 이미 실려 온다 */
export function UpDownTable({ cards }: { cards: (IndexCard | undefined)[] }) {
  /* 줄을 누르면 60일 흐름 — 브리핑과 **같은 시트**다 (2026-08-29) */
  const [trend, setTrend] = useState<{ code: string; name: string } | null>(null);
  return (
    <div className="ov-card-b">
      <table className="ov-table num">
        <thead>
          <tr>
            <th>구분</th>
            <th className="up">상한</th>
            <th className="up">상승</th>
            <th>보합</th>
            <th className="down">하락</th>
            <th className="down">하한</th>
          </tr>
        </thead>
        <tbody>
          {cards.map(
            (c) =>
              c && (
                <tr
                  key={c.code}
                  className="clickable-row"
                  onClick={() => setTrend({ code: c.code, name: c.name })}
                  title={`${c.name} 60일 흐름 보기`}
                >
                  <td>{c.name}</td>
                  <td className="up">{c.upperLimit}</td>
                  <td className="up">{fmtNum(c.rising)}</td>
                  <td className="flat">{c.flat}</td>
                  <td className="down">{fmtNum(c.falling)}</td>
                  <td className="down">{c.lowerLimit}</td>
                </tr>
              ),
          )}
        </tbody>
      </table>
      {trend && (
        <MarketTrendSheet code={trend.code} name={trend.name} onClose={() => setTrend(null)} />
      )}
    </div>
  );
}
