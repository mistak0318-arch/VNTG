import { useEffect, useState } from "react";
import { api, fmtNum, type OpinionSummary } from "../api";

/**
 * 증권사 목표주가·투자의견.
 *
 * **목표가 숫자만 크게 띄우지 않는다.** 늘 현재가보다 위에 있고 틀려도 아무도 책임지지
 * 않는다. 삼성전자만 봐도 한 날에 35만·40만·65만이 같이 나온다.
 *
 * 그래서 화면 순서를 이렇게 잡았다.
 *
 *   ① **의견 변경**을 맨 위에 — "40만"보다 "30만에서 40만으로 올렸다"가 훨씬 강하다
 *   ② **컨센서스와 그 폭** — 중앙값 하나만 보면 의견이 갈린 종목을 못 알아본다
 *   ③ **증권사별 목록** — 어느 곳이 언제 무엇을 냈는지
 *
 * 평균 대신 중앙값을 쓴다. 한 곳이 65만을 부르면 평균이 끌려간다.
 */

function pct(v: number | null): string {
  if (v == null) return "-";
  return `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;
}

function cls(v: number | null): string {
  if (v == null) return "";
  return v > 0 ? "positive" : v < 0 ? "negative" : "";
}

/** 이 사건이 위로 간 것인가 — 등급 변경이 먼저, 없으면 목표가 방향 */
function dirOf(c: { move: number; goalChange: number | null }): number {
  return c.move !== 0 ? c.move : Math.sign(c.goalChange ?? 0);
}

function fmtDate(s: string): string {
  return s.length === 8 ? `${s.slice(2, 4)}/${s.slice(4, 6)}/${s.slice(6, 8)}` : s;
}

export function OpinionPanel({ code }: { code: string }) {
  const [data, setData] = useState<OpinionSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    api
      .opinion(code)
      .then((d) => alive && setData(d))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [code]);

  if (error) {
    return (
      <div className="alert-note">
        <b>불러오지 못했습니다.</b> {error}
        <br />이 값은 한국투자증권 API 에서 옵니다 — <code>.env</code> 의{" "}
        <code>HANTOO_APP_KEY</code> / <code>HANTOO_APP_SECRET</code> 을 확인하세요.
      </div>
    );
  }
  if (!data) return <div className="page-note">불러오는 중…</div>;
  if (data.brokerCount === 0) {
    return (
      <div className="empty">
        최근 반년간 발표된 투자의견이 없습니다. 커버하는 증권사가 없는 종목입니다.
      </div>
    );
  }

  const changed = [...data.upgrades, ...data.downgrades].sort((a, b) =>
    b.date.localeCompare(a.date),
  );

  return (
    <>
      {/* ① 의견이 바뀐 순간 — 목표가 숫자보다 이게 신호다 */}
      {changed.length > 0 && (
        <div className="op-changes">
          {changed.map((c, i) => (
            <div
              className={`op-change ${dirOf(c) > 0 ? "up" : "down"}`}
              key={`${c.broker}${c.date}${i}`}
            >
              <span className="op-arrow">{dirOf(c) > 0 ? "▲ 상향" : "▼ 하향"}</span>
              <b>{c.broker}</b>
              {/* 등급이 바뀌었으면 등급을, 아니면 목표가가 얼마에서 얼마로 갔는지 */}
              {c.move !== 0 ? (
                <span className="pt-n">
                  {c.prevStance} → {c.stance}
                </span>
              ) : (
                <span className="op-goal">
                  {c.prevGoalPrice != null ? `${fmtNum(c.prevGoalPrice)} → ` : ""}
                  {c.goalPrice != null ? `${fmtNum(c.goalPrice)}원` : ""}
                  {c.goalChange != null && (
                    <em className="pt-n"> ({pct(c.goalChange)})</em>
                  )}
                </span>
              )}
              <span className="pt-n">{fmtDate(c.date)}</span>
            </div>
          ))}
        </div>
      )}

      {/* ② 컨센서스 — 폭을 같이 보여 줘야 의견이 갈린 종목을 알아본다 */}
      <div className="op-consensus">
        <div className="op-box">
          <span className="op-label">목표가 중앙값</span>
          <b className="op-big">{data.goalMedian == null ? "-" : `${fmtNum(data.goalMedian)}원`}</b>
          <span className="pt-n">
            {data.goalMin != null && data.goalMax != null
              ? `${fmtNum(data.goalMin)} ~ ${fmtNum(data.goalMax)}`
              : ""}
          </span>
        </div>
        <div className="op-box">
          <span className="op-label">현재가 대비</span>
          <b className={`op-big ${cls(data.upside)}`}>{pct(data.upside)}</b>
          <span className="pt-n">{data.price != null ? `${fmtNum(data.price)}원 기준` : ""}</span>
        </div>
        <div className="op-box">
          <span className="op-label">눈높이 추세</span>
          <b className={`op-big ${cls(data.goalTrend)}`}>{pct(data.goalTrend)}</b>
          <span className="pt-n">
            {data.truncated ? "표본 100건 상한 — 내지 않음" : "최근 3개월 vs 그 이전"}
          </span>
        </div>
        <div className="op-box">
          <span className="op-label">커버 증권사</span>
          <b className="op-big">{data.brokerCount}곳</b>
          <span className="pt-n">
            매수 {data.stanceCount.매수} · 중립 {data.stanceCount.중립} · 매도{" "}
            {data.stanceCount.매도}
          </span>
        </div>
      </div>

      {data.brokerCount === 1 && (
        <div className="alert-note">
          커버하는 증권사가 <b>한 곳뿐</b>입니다. 이 목표가는 컨센서스가 아니라 한 사람의
          의견입니다.
        </div>
      )}

      {/* ③ 원본 목록 */}
      <div className="data-table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th className="sticky-col">발표일</th>
              <th>증권사</th>
              <th>의견</th>
              <th>직전</th>
              <th>목표가</th>
              <th title="같은 증권사의 직전 목표가 대비">변동</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((it, i) => (
              <tr key={`${it.broker}${it.date}${i}`}>
                <td className="sticky-col">{fmtDate(it.date)}</td>
                <td>{it.broker}</td>
                <td className={it.move > 0 ? "positive" : it.move < 0 ? "negative" : ""}>
                  {it.opinionRaw || it.stance}
                  {it.move > 0 ? " ▲" : it.move < 0 ? " ▼" : ""}
                </td>
                <td className="pt-n">{it.prevStance}</td>
                <td>{it.goalPrice == null ? "-" : fmtNum(it.goalPrice)}</td>
                <td className={cls(it.goalChange)}>{it.goalChange == null ? "-" : pct(it.goalChange)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="table-note">
        한국투자증권 OpenAPI · 최근 <b>반년</b>치입니다. 컨센서스는 증권사마다 <b>가장 최근
        의견 하나씩</b>만 세어 평균이 아닌 <b>중앙값</b>으로 냅니다 — 한 곳이 크게 부르면
        평균은 그쪽으로 끌려갑니다. 의견 문구는 증권사마다 "BUY"와 "매수"가 섞여 오므로
        원문을 그대로 두고 갈래만 따로 판정합니다. <b>상향·하향</b>은 등급 변경뿐 아니라
        <b>목표가를 3% 넘게 움직인 것</b>도 셉니다 — 다들 BUY 를 유지한 채 목표가만 올리기
        때문에, 등급만 보면 아무 일도 없는 것처럼 보입니다.
      </div>
    </>
  );
}
