import { useEffect, useState } from "react";
import { api, type ScoreCard, type ScoreCut, type ScoreStat } from "../api";

/**
 * **실전 성적표** — 원장을 무엇으로 갈라도 보는 자리 (2026-10-07).
 *
 * 벤티지: "그간 누적된 데이터와 검증 값들 그리고 활용도에서 개선하거나 추가하거나 했음 기능 잇니."
 *
 * 바로 위 「편입 후 성적」은 **목록별**로 센다. 시뮬레이터는 점수대별로 세는데 그건
 * *표본*(일봉으로 되짚어 만든 관측)이다. 이 표가 답하는 것은 그 사이에 빠져 있던 물음이다 —
 *
 *   **매일 실제로 돌린 원장에서, 70·80·90 이 정말 갈렸나.**
 *
 * ## 이 화면이 지키는 규칙 둘
 *
 * 1. **n 과 「잰 것」을 늘 같이 적는다.** 편입 400건에 잰 것이 30건이면 그 평균은
 *    평균이 아니다. 숫자만 크게 띄우면 사람이 속는다 — 여기서 여러 번 데였다.
 * 2. **20일이 얇으면 5일을 먼저 보여 준다.** 원장이 어리면 20일은 아직 낼 수가 없다.
 *    「고쳐라」가 아니라 「지금은 5일로 읽어라」가 맞는 말이라, 칸을 고를 수 있게 둔다.
 */

const n2 = (v: number | null): string => (v === null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)}`);
const cls = (v: number | null): string => (v === null ? "" : v > 0 ? "positive" : v < 0 ? "negative" : "");

/** 잰 비율이 낮으면 줄 전체를 흐리게 — 「믿지 말라」를 색으로 말한다 */
function thin(s: ScoreStat): boolean {
  return s.graded < 8 || (s.n > 0 && s.graded / s.n < 0.3);
}

function CutTable({ cut, h }: { cut: ScoreCut; h: "d5" | "d20" }) {
  const rows = cut.rows.filter((r) => r[h].n > 0);
  if (rows.length === 0) return null;
  /*
   * 평균이 가장 높은 줄 — 잰 것이 여덟 건 이상인 줄에서만 고른다(두 건으로 1등을 주면 거짓말).
   *
   * 라벨은 「제일 나음」이 아니라 **「평균 1등」**이다. 실측에서 90점+ 가 평균 1등인데
   * 승률 28%·중앙값 −4.01 이었다 — 한둘이 끌어올린 평균이다. 「제일 나음」이라 적으면
   * 표가 거짓말을 하게 된다. 라벨은 **잰 것 그대로**를 말해야 한다.
   */
  const best = rows
    .filter((r) => !thin(r[h]) && r[h].avg !== null)
    .sort((a, b) => (b[h].avg ?? -1e9) - (a[h].avg ?? -1e9))[0];
  return (
    <div className="sc-cut">
      <div className="sc-cut-h">
        <b>{cut.title}</b>
        {/* ⚠️ 가 붙은 갈래는 「고르는 기준으로 못 쓴다」는 뜻 — 흐리게 두면 안 읽는다 */}
        <i className={cut.asks.includes("⚠️") ? "sc-asks-warn" : "pt-n"}>{cut.asks}</i>
      </div>
      <div className="table-wrap">
        <table className="sim-table sc-table">
          <thead>
            <tr>
              <th>갈래</th>
              <th>편입</th>
              <th>잰 것</th>
              <th>평균</th>
              <th>중앙</th>
              <th>승률</th>
              <th>최악</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const s = r[h];
              const isBest = best && best.label === r.label;
              return (
                <tr key={r.label} className={`${thin(s) ? "sc-thin" : ""} ${isBest ? "sc-best" : ""}`}>
                  <td>
                    {r.label}
                    {isBest && <em className="sc-tag"> 평균 1등</em>}
                  </td>
                  <td>{s.n}</td>
                  <td>
                    {s.graded}
                    {thin(s) && <em className="sc-warn" title="잰 것이 적어 평균을 믿기 어렵습니다">얇음</em>}
                  </td>
                  <td className={cls(s.avg)}>{n2(s.avg)}</td>
                  <td className={cls(s.med)}>{n2(s.med)}</td>
                  <td>{s.win === null ? "—" : `${s.win}%`}</td>
                  <td className={cls(s.worst)}>{n2(s.worst)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Card({ card, unit }: { card: ScoreCard; unit: string }) {
  /*
   * **기본은 더 고르게 잰 칸.**
   *
   * 「30건만 넘으면 20일」로 뒀더니 경고는 "5일로 읽으세요"인데 화면은 20일을 펴고
   * 있었다. 그게 그냥 어긋난 정도가 아니다 — 20일은 **오래된 편입에만 쏠려** 있어서
   * 장세별 부호가 5일과 **반대로** 나왔다(5일: 약한 장이 나쁨 / 20일: 약한 장이 좋음).
   * 먼저 보이는 칸이 덜 쟀으면 사람은 그 쪽을 믿는다. 그래서 20일은 **5일만큼 고르게
   * 쟀을 때만** 기본으로 둔다.
   */
  const [h, setH] = useState<"d5" | "d20">(
    card.graded >= 30 && card.graded >= card.graded5 * 0.6 ? "d20" : "d5",
  );
  return (
    <div className="sc-card">
      <div className="sc-top">
        <span className="sc-count">
          편입 <b>{card.total}</b>건 · 20일 잰 것 <b>{card.graded}</b> · 5일 잰 것{" "}
          <b>{card.graded5}</b>
        </span>
        <span className="sc-h">
          {(["d5", "d20"] as const).map((k) => (
            <button
              key={k}
              type="button"
              className={`filter-btn ${h === k ? "active" : ""}`}
              onClick={() => setH(k)}
            >
              {k === "d5" ? "5일 뒤" : "20일 뒤"}
            </button>
          ))}
        </span>
      </div>
      <div className="pt-n sc-unit">{unit}</div>
      {card.warn && <div className="alert-note sc-note">{card.warn}</div>}
      {card.byHash.length > 1 && (
        <details className="sc-hash">
          <summary>
            기준이 바뀐 전후 채점률 — 쏠렸으면 아래 차이가 기준·시기 차이일 수 있습니다
          </summary>
          <ul>
            {card.byHash.map((b) => (
              <li key={b.hash}>
                <code>{b.hash}</code> — 편입 {b.n}건 중 {b.graded}건 잼 (
                {b.n > 0 ? Math.round((b.graded / b.n) * 100) : 0}%)
              </li>
            ))}
          </ul>
        </details>
      )}
      {card.cuts.map((c) => (
        <CutTable key={c.title} cut={c} h={h} />
      ))}
    </div>
  );
}

export function ScoreCardPanel() {
  const [data, setData] = useState<{ list: ScoreCard; super: ScoreCard } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [which, setWhich] = useState<"list" | "super">("list");

  useEffect(() => {
    if (!open || data) return;
    let dead = false;
    api
      .scoreCard()
      .then((r) => {
        if (!dead) setData(r);
      })
      .catch((e) => {
        if (!dead) setErr(e instanceof Error ? e.message : "못 읽었습니다");
      });
    return () => {
      dead = true;
    };
  }, [open, data]);

  const card = data ? data[which] : null;

  return (
    <section className="card sc">
      <button className="gb-head" onClick={() => setOpen((v) => !v)}>
        <span className="gb-caret">{open ? "▾" : "▸"}</span>
        <b>성적표 — 무엇으로 갈라도</b>
        <span className="pt-n">점수대·장세·연속일·순위·경보로 가로지른다</span>
        {!open && data && (
          <span className="gb-peek">
            편입 {data.list.total}건
            <span className="pt-n"> · 20일 잰 것 {data.list.graded}</span>
          </span>
        )}
      </button>
      {open && (
        <>
          <p className="pt-n">
            위 표는 <b>목록별</b>로 셉니다. 시뮬레이터는 점수대별로 세지만 그건{" "}
            <b>표본</b>(일봉으로 되짚은 관측)입니다. 이 표는 <b>매일 실제로 돌린 원장</b>을
            가로지릅니다 — 문턱을 손볼 때 근거가 되는 쪽이 이쪽입니다.
          </p>
          {err && <div className="error-banner">{err}</div>}
          {!data && !err && <div className="page-note">세는 중…</div>}
          {data && (
            <>
              <div className="sc-pick">
                {(
                  [
                    ["list", `신호등 원장 (${data.list.total}건)`],
                    ["super", `슈퍼신호등 (${data.super.total}건)`],
                  ] as const
                ).map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    className={`filter-btn ${which === k ? "active" : ""}`}
                    onClick={() => setWhich(k)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {card && (
                <Card
                  card={card}
                  unit={
                    which === "list"
                      ? "값은 모두 지수 대비(%p)입니다 — 상승장에서는 아무거나 사도 오르므로 절대수익률로는 갈리지 않습니다."
                      : "값은 편입가 대비(%)입니다 — 위 원장의 지수 대비와 뜻이 달라 숫자를 직접 견주면 안 됩니다."
                  }
                />
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
