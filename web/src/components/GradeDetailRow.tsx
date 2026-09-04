/**
 * 채점표 한 줄을 펼친 **속** (2026-09-04).
 *
 * 벤티지: "각각의 케이스에 대해 결과별로 알 수 있게 해준 다음에, 조금 더 추가하면
 * 분석에 도움이 되는 지표들도 한번 추가해 볼 수 있겠어."
 *
 * ## 왜 칸을 안 늘리고 펼치나
 *
 * 표에 칸을 넷 더하면 폰에서 다시 옆으로 긁힌다 — 바로 앞에서 그걸 고쳤다. 그리고
 * 이 값들은 **훑을 때 보는 값이 아니다.** 표를 훑다가 「이 구간 뭐지?」 하고 멈춘
 * 한 줄에서만 필요하다. 자리를 늘 차지할 이유가 없다.
 *
 * ## 무엇을 답하나
 *
 * 「20일 지수 대비 +1.8%p, 승률 54%」라는 줄이 못 하던 말 넷:
 *   · 고르게 번 것인가, 한둘이 끌어올린 것인가 → **분포**와 **중앙값**
 *   · 시장이 오른 덕인가, 시장을 이긴 것인가   → **시장 이긴 비율**
 *   · 질 때 작게 지는가                        → **손익비**
 *   · 한 번에 얼마나 다치나                    → **최악**
 *
 * 신호등 분석과 슈퍼신호등이 **같은 조각**을 쓴다. 서버 셈도 한 곳이다(`gradeStats`) —
 * 두 원장을 견주는 표라 자가 다르면 비교가 거짓이 된다.
 */

export interface GradeDist {
  bad: number;
  down: number;
  flat: number;
  up: number;
  good: number;
}

export interface GradeDetail {
  horizon: 1 | 5 | 20 | null;
  n: number;
  dist: GradeDist;
  median: number | null;
  payoff: number | null;
  exWin: number | null;
  best: number | null;
  worst: number | null;
  bins: { near: number; far: number };
}

/**
 * 통 이름은 **경계에서 만든다** — 박아 쓰면 거짓이 된다.
 * 지평이 짧으면 서버가 통을 좁힌다(하루에 시장을 3%p 이기는 일은 드물다).
 */
function bins(near: number, far: number): { key: keyof GradeDist; label: string; cls: string; hint: string }[] {
  const n = near % 1 === 0 ? String(near) : near.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  const f = far % 1 === 0 ? String(far) : far.toFixed(1);
  return [
    { key: "bad", label: `−${f}%p↓`, cls: "bad", hint: `시장에 ${f}%p 넘게 진 것` },
    { key: "down", label: `−${f}~−${n}`, cls: "down", hint: "시장에 진 것" },
    { key: "flat", label: `±${n}`, cls: "flat", hint: "시장과 사실상 같았던 것" },
    { key: "up", label: `+${n}~+${f}`, cls: "up", hint: "시장을 이긴 것" },
    { key: "good", label: `+${f}%p↑`, cls: "good", hint: `시장을 ${f}%p 넘게 이긴 것` },
  ];
}

const pp = (v: number | null) => (v === null ? "-" : `${v > 0 ? "+" : ""}${v}%p`);

export function GradeDetailRow({
  detail,
  avgSame,
  span,
}: {
  detail: GradeDetail;
  /**
   * **같은 지평**의 지수 대비 평균 — 중앙값과 견주려고 받는다.
   * 20일 평균을 1일 중앙값과 견주면 아무 뜻이 없어서, 부르는 쪽이 지평을 맞춰 넘긴다.
   */
  avgSame: number | null;
  span: number;
}) {
  if (detail.n === 0) {
    return (
      <tr className="gd-row">
        <td colSpan={span} className="gd-empty">
          아직 성적이 찬 종목이 없는 구간입니다 — 하루만 지나도 여기에 속이 뜹니다.
        </td>
      </tr>
    );
  }

  /*
   * 평균과 중앙값이 크게 벌어지면 **소수가 끌고 있다.** 얼마나 벌어져야 「크게」인지는
   * 자의적이라, 값을 나란히 보여 주고 3%p 넘게 벌어졌을 때만 한 줄로 짚는다.
   */
  const gap = avgSame !== null && detail.median !== null ? avgSame - detail.median : null;
  const skewed = gap !== null && Math.abs(gap) >= 3;

  const BINS = bins(detail.bins.near, detail.bins.far);

  return (
    <tr className="gd-row">
      <td colSpan={span}>
        <div className="gd">
          {/*
            **몇 일짜리인지 먼저 말한다.** 원장이 어리면 20일이 지난 편입분이 없어서
            더 짧은 지평으로 잰다 — 안 적으면 20일 성적으로 읽힌다.
          */}
          <div className="gd-h">
            <b>{detail.horizon}일 뒤</b> 지수 대비로 잰 속입니다
            {detail.horizon !== 20 && (
              <span className="pt-n"> — 20일이 지난 편입분이 아직 없어 이 지평으로 잽니다</span>
            )}
          </div>
          {/* ① 결과별 몇 건 — 평균 한 숫자가 못 하는 말 */}
          <div className="gd-dist">
            <div className="gd-bar">
              {BINS.map((b) => {
                const v = detail.dist[b.key];
                if (v === 0) return null;
                return (
                  <i
                    key={b.key}
                    className={`gd-seg ${b.cls}`}
                    style={{ width: `${(v / detail.n) * 100}%` }}
                    title={`${b.hint} — ${v}건 (${Math.round((v / detail.n) * 100)}%)`}
                  />
                );
              })}
            </div>
            <div className="gd-legend">
              {BINS.map((b) => (
                <span key={b.key} className={detail.dist[b.key] === 0 ? "off" : ""}>
                  <i className={`gd-dot ${b.cls}`} />
                  {b.label} <b>{detail.dist[b.key]}</b>
                </span>
              ))}
            </div>
          </div>

          {/* ② 평균이 못 하는 말 넷 */}
          <dl className="gd-kv">
            <div title="절반은 이 값보다 좋았고 절반은 나빴다. 평균과 벌어지면 소수가 끌고 있다는 뜻">
              <dt>중앙값</dt>
              <dd>{pp(detail.median)}</dd>
            </div>
            <div title="이긴 것 평균 ÷ 진 것 평균. 2 를 넘으면 승률이 낮아도 번다 — 추세추종은 그 모양이 정상이다">
              <dt>손익비</dt>
              <dd>{detail.payoff === null ? "-" : `${detail.payoff}배`}</dd>
            </div>
            <div title="같은 기간 지수보다 나았던 비율 — 절대 승률과 다르다. 상승장에서는 아무거나 사도 오른다">
              <dt>시장 이김</dt>
              <dd>{detail.exWin === null ? "-" : `${detail.exWin}%`}</dd>
            </div>
            <div title="이 구간에서 가장 크게 이긴 한 건과 가장 크게 진 한 건">
              <dt>최고 · 최악</dt>
              <dd>
                <b className="positive">{pp(detail.best)}</b>
                <span className="pt-n"> · </span>
                <b className="negative">{pp(detail.worst)}</b>
              </dd>
            </div>
            <div title="20일이 지나 성적이 확정된 종목 수 — 표의 편입 수와 다릅니다">
              <dt>잰 표본</dt>
              <dd>{detail.n}건</dd>
            </div>
          </dl>

          {skewed && (
            <p className="gd-note">
              평균({pp(avgSame)})과 중앙값({pp(detail.median)})이 <b>{Math.abs(Math.round(gap))}%p</b>{" "}
              벌어져 있습니다 — {gap > 0 ? "소수의 큰 승리가 평균을 끌어올리고" : "소수의 큰 패배가 평균을 끌어내리고"}{" "}
              있습니다. 이 구간을 평균만 보고 판단하면 안 됩니다.
            </p>
          )}
        </div>
      </td>
    </tr>
  );
}
