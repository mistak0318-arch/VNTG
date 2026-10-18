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
 * 선물 투자자별 수급 (네이버 새 API, **억원**) — 선물 타일의 「받을 데가 없다」 자리.
 * 서버가 10분 캐시라 5분마다 물으면 충분하다. 마지막 날(장중이면 오늘 누적)만 쓴다.
 */
export function useFutFlow(): { futFlow: FutFlowDay | null; futEmpty: boolean } {
  const [futFlow, setFutFlow] = useState<FutFlowDay | null>(null);
  /* 응답은 왔는데 빈 것 — 「불러오는 중」이 아니라 「없음」이다 (2026-09-18 네이버가 주소를 닫음, HTTP 410) */
  const [futEmpty, setFutEmpty] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .futuresFlow(1)
        .then((r) => {
          if (!alive) return;
          if (r.days.length > 0) setFutFlow(r.days[r.days.length - 1]);
          else setFutEmpty(true);
        })
        .catch(() => undefined);
    void load();
    const t = setInterval(load, 5 * 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return { futFlow, futEmpty };
}

export function DomesticIndexGrid({
  idx,
  flow,
  futFlow,
  futEmpty = false,
  onOpenIndex,
  onOpenFutures,
}: {
  idx: IndexCard[];
  flow: MarketFlow | null | undefined;
  futFlow: FutFlowDay | null;
  futEmpty?: boolean;
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
            {/*
              **월물코드 줄을 지웠다** (2026-10-18 — 벤티지: "선물에서는 F로 시작하는
              종목번호랑 밑에 네이버 10분 그거 지워도 돼").

              「F 202612」는 **읽어서 할 일이 없는 글자**다. 이 타일에서 알고 싶은 건
              지수와 등락이고, 월물·베이시스·미결제는 눌러서 여는 시트에 다 있다.
              점선 한 줄과 그 위아래 여백까지 12px 를 차지하고 있었다.
            */}
            {/*
              선물 수급 — 네이버 새 API 값이 **억원 그대로**다 (2026-09-18 벤티지가 키움 앱과 나란히 찍음:
              키움 외국인 15,789 · 기관 15,706 vs 우리 15,451 · 15,423). 옛 표(계약)에 붙어 있던
              「계약 × 지수 / 400」 환산이 새 값에 걸려 4만 2천억으로 부풀었었다 — 환산 없이 지수 수급과 같은 눈으로.
            */}
            {c.code === "F" &&
              futFlow &&
              (() => {
                // 「억」 글자는 뺀다 — 이 카드의 수급은 다 억원이라 접미가 소음이다
                const row = (lbl: string, n: number) => (
                  <div>
                    <span className="lbl">{lbl}</span>
                    <span className={signCls(n)}>
                      {n > 0 ? "+" : ""}
                      {fmtNum(n)}
                    </span>
                  </div>
                );
                return (
                  <div
                    className="ov-idx-flow num"
                    title={`${futFlow.date} 억원 순매수 · 네이버 투자자별 매매동향(±10분 지연) — 키움 앱 선물 수급과 같은 단위`}
                  >
                    {row("외국인", futFlow.foreign)}
                    {row("기관", futFlow.institution)}
                    {row("개인", futFlow.individual)}
                  </div>
                );
              })()}
            {/*
              **출처 줄은 값이 없을 때만** (2026-10-18).

              「10/16 순매수 · 네이버 ±10분」은 늘 같은 글자라 한 번 읽으면 그 뒤로는
              자리만 먹는다. 날짜와 출처는 **수급 줄의 풍선말**로 옮겼다 — 궁금할 때만
              들여다보면 된다. 못 받았을 때의 알림은 남긴다: 그건 매번 다른 소식이다.
            */}
            {c.code === "F" && !futFlow && (
              <div className="ov-idx-note ov-idx-note-1">
                {futEmpty ? "선물 수급 없음 — 네이버 응답이 비었다" : "선물 수급 불러오는 중…"}
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
