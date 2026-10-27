import { useEffect, useState } from "react";
import { api, type CisRaceRow, type CisRaceStore } from "../api";

/**
 * **시나리오 레이스** (2026-10-27 — 벤티지: "각각의 계좌별로 … 최적의 시나리오를 네가
 * 세팅해서 … AI가 이렇게 해서 얘는 이렇게 해서 길이 나오네? 이걸 보고 싶은 거야.
 * 이렇게 못하는 걸 보고 싶은 게 아니야" → "완전 자동화라 가자. 내가 안 고를게").
 *
 * 계좌마다 축을 달리한 설정 몇 개를 **같은 표본**으로 돌려 나란히 세운다. 마감 정리가
 * 매일 돌리고, 세 겹을 넘은 줄이 있으면 **파는 법만** 자동으로 갈아끼운다.
 *
 * ## 왜 「초과」로 줄을 세우나
 *
 * 처음엔 수익률로 세웠고 **모든 줄이 마이너스에 모든 줄이 탈락**이었다. 기준을 같이
 * 찍어 보니 까닭이 나왔다 — 같은 자리를 그냥 20일 들고 있었으면 **-5.14%** 였다.
 * 표본 구간(4/07~9/23)이 하락장이라 **어떤 롱 전략도 절대 양수가 될 수 없었다.**
 * 「양수인가」를 물으면 규칙이 아니라 **장이 올랐는지**를 묻는 셈이다.
 *
 * 그래서 묻는 것을 바꿨다: **아무것도 안 하는 것보다 나았나.** 그러자 답이 나왔다.
 *
 * ⚠️ 「초과」는 **같은 계좌 안에서만** 견준다. 기준은 늘 20일 홀드인데 종가배팅은
 * 하룻밤짜리라, 계좌끼리 초과분을 맞대면 짧게 든 쪽이 거저 이긴다.
 */

const n2 = (v: number | null, sign = true) =>
  v === null ? "–" : `${sign && v > 0 ? "+" : ""}${v.toFixed(2)}`;

function Row({ r, lead }: { r: CisRaceRow; lead: boolean }) {
  return (
    <tr className={lead ? "crp-cur" : undefined} title={r.why}>
      <td className="sticky-col">
        {r.label}
        {lead && <i className="crp-tag">지금</i>}
      </td>
      <td className={`num crp-lead ${(r.excess ?? 0) > 0 ? "positive" : (r.excess ?? 0) < 0 ? "negative" : ""}`}>
        {n2(r.excess)}
      </td>
      <td className="num">{n2(r.avg)}</td>
      <td className="num crp-dim">{n2(r.hold)}</td>
      <td className="num">{r.winRate === null ? "–" : `${r.winRate.toFixed(0)}%`}</td>
      <td className={`num ${(r.payoff ?? 0) >= 2 ? "positive" : ""}`}>{n2(r.payoff, false)}</td>
      <td className="num crp-dim">{r.trades.toLocaleString("ko-KR")}</td>
      <td className="num">
        {r.bothBeatHold ? (
          <span className="crp-ok" title="앞구간에서도 뒷구간에서도 홀드보다 나았다">
            ✓
          </span>
        ) : (
          <span className="crp-no" title={r.why_not}>
            ✗
          </span>
        )}
      </td>
    </tr>
  );
}

export function CisRacePanel() {
  const [data, setData] = useState<CisRaceStore | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open || data) return;
    let dead = false;
    api
      .cisRaces()
      .then((d) => !dead && setData(d))
      .catch(() => undefined);
    return () => {
      dead = true;
    };
  }, [open, data]);

  const races = Object.values(data?.races ?? {}).filter(Boolean);

  return (
    <details className="crp" open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>
        <b>시나리오 레이스</b>
        <span className="crp-sum">
          계좌마다 설정 몇 개를 같은 표본으로 돌려 본다 — 세 겹을 넘으면 파는 법만 자동으로 바뀝니다
        </span>
      </summary>

      {!data ? (
        <div className="empty">불러오는 중…</div>
      ) : races.length === 0 ? (
        <div className="page-note">아직 안 돌았습니다 — 마감 정리(표본 다음)에서 하루 한 번 돕니다.</div>
      ) : (
        <>
          {races.map((r) => (
            <section className="crp-acc" key={r!.account}>
              <h4>
                {r!.accountName}
                {data.adopted[r!.account] && (
                  <i className="crp-adopted" title={data.adopted[r!.account]!.why}>
                    자동 채택 · {data.adopted[r!.account]!.label}
                  </i>
                )}
              </h4>
              {r!.rows.length === 0 ? (
                <div className="page-note">{r!.verdict}</div>
              ) : (
                <>
                  <div className="data-table-wrap">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th className="sticky-col">줄</th>
                          <th className="num" title="규칙 − 홀드. 아무것도 안 하는 것보다 얼마나 나았나">
                            초과
                          </th>
                          <th className="num" title="규칙대로 사고팔았을 때 관측당 평균">
                            규칙
                          </th>
                          <th className="num" title="같은 자리를 규칙 없이 20일 들고 있었으면">
                            홀드
                          </th>
                          <th className="num">승률</th>
                          <th className="num" title="이긴 거래의 평균 이익 ÷ 진 거래의 평균 손실. 추세추종은 2 를 넘어야 성립합니다">
                            손익비
                          </th>
                          <th className="num">거래</th>
                          <th className="num" title="표본 앞뒤 둘 다에서 홀드를 이겼나 — 이게 ✗ 면 1등이어도 안 씁니다">
                            앞뒤
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {r!.current && <Row r={r!.current} lead />}
                        {r!.rows.map((x) => (
                          <Row key={x.id} r={x} lead={false} />
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="table-note">{r!.verdict}</div>
                </>
              )}
            </section>
          ))}
          <div className="table-note">
            <b>초과</b>는 같은 계좌 안에서만 견줍니다 — 기준이 늘 20일 홀드라, 하룻밤짜리인
            종가배팅과 열이틀짜리인 단기 추세의 초과분을 맞대면 짧게 든 쪽이 거저 이깁니다.
            <br />
            자동으로 바뀌는 것은 <b>파는 법</b>(손절·익절·되돌림)뿐입니다. 비중·종목 수는
            벤티지가 9/4 에 손수 정한 값이고, 신호등 문턱은 12월 말까지 동결이라 레이스가
            보여 주기만 합니다.
            {data.at && <> · 마지막 {new Date(data.at).toLocaleString("ko-KR")}</>}
          </div>
        </>
      )}
    </details>
  );
}
