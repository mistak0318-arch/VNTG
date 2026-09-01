import { useEffect, useState } from "react";
import { api, type SignalVerdict } from "../api";

/**
 * 이 점수가 무슨 뜻인가 — **한 줄짜리 근거.**
 *
 * 벤티지: "신호등 점수가 55점일 때 점수가 가장 좋았다 이런 것도 느낌표로 딱 해서
 * 어떤 신호등을 돌렸을 때 임팩트가 있게."
 *
 * 지금까지 신호등을 돌리면 **점수만 나오고 그 점수가 무슨 뜻인지는 안 보였다.**
 * 몇 점부터 값을 하는지, 이 종목이 어느 자리인지, 그 자리가 실측에서 어땠는지.
 *
 * ## ⚠️ 하드코딩하지 않는다
 *
 * 값을 코드에 적으면 표본이 바뀌어도 그대로 남아 **곧 거짓말이 된다.** 오늘 그
 * 일을 한 번 겪었다 — 「초과 +5.63%p」가 표본이 8% 바뀌자 +0.19%p 로 무너졌다.
 * 서버가 시뮬레이터로 낸 값을 파일에 남기고, 여기서는 그걸 읽기만 한다.
 *
 * ## 낡음을 숨기지 않는다
 *
 * 잰 날짜와 표본을 같이 적는다. 기준을 바꿨는데 판정이 옛날 것이면 **그 사실을
 * 말해야** 한다 — 틀린 근거는 없는 것보다 나쁘다.
 */

const f2 = (v: number | null | undefined): string =>
  v === null || v === undefined ? "-" : `${v > 0 ? "+" : ""}${v.toFixed(2)}`;

export function VerdictBar({
  /** 이 종목의 점수 — 주면 「지금 여기」를 짚어 준다 */
  score,
  /** 표를 처음부터 펼칠까 */
  open: openInit = false,
}: {
  score?: number | null;
  open?: boolean;
}) {
  const [v, setV] = useState<SignalVerdict | null>(null);
  const [open, setOpen] = useState(openInit);

  useEffect(() => {
    void api
      .signalVerdict()
      .then((r) => setV(r.verdict))
      .catch(() => undefined);
  }, []);

  if (!v || v.splits.length === 0) return null;

  /*
   * 이 점수가 **어느 구간**에 드나. 예전엔 누적 문턱(`splits`)에서 찾았는데,
   * 이제 전 구간이 통과라 그 방식으로는 「그 구간 안」이 늘 참이 돼 뜻이 없다.
   * 구간표(`bands`)에서 찾는다 — 85~89 처럼 **가운데가 함몰된 자리**를 짚어야 한다.
   */
  const here =
    score === null || score === undefined
      ? null
      : v.bands.find((b) => score >= b.lo && score <= b.hi) ?? null;

  const days = Math.floor((Date.now() - new Date(v.at).getTime()) / 86_400_000);
  const stale = days >= 7;

  /*
   * ## 한 줄을 어떻게 쓰나 (2026-09-01)
   *
   * 처음엔 `bestCut`(앞뒤 모두 통하는 **가장 높은** 문턱) 하나만 적었다. 그런데
   * 커버리지 문턱을 넣고 나니 **40점부터 90점까지 전부 통과**해 버렸고, 그 상태에서
   * 「90점 이상이 이겼습니다」라고 적으면 **90점이 필요한 것처럼 읽힌다.** 거짓이다.
   *
   * 그래서 둘을 같이 말한다:
   *   floorCut  통하기 시작하는 **가장 낮은** 문턱 — 「어디부터 봐도 되나」
   *   bestBand  뒤쪽 중앙값이 가장 높은 **구간** — 「어디가 제일 좋았나」
   */
  const floorCut = v.splits.find((s) => s.good)?.cut ?? null;
  const bestBand =
    v.bands.filter((b) => b.good).sort((a, b) => (b.back.med ?? -99) - (a.back.med ?? -99))[0] ??
    null;

  return (
    <div className={`verdict${stale ? " stale" : ""}`}>
      <button className="verdict-head" onClick={() => setOpen((o) => !o)}>
        <span className="verdict-caret">{open ? "▾" : "▸"}</span>
        {floorCut === null ? (
          <b className="verdict-bad">
            ⚠️ 지금 기준으로는 <u>앞뒤 모두 통하는 점수대가 없습니다</u>
          </b>
        ) : (
          <b>
            💡 <u>{floorCut}점부터</u> 앞·뒤 표본 <b>모두</b> 시장을 이겼습니다
            {bestBand && (
              <>
                {" · "}
                가장 좋은 구간은{" "}
                <u>
                  {bestBand.lo}~{bestBand.hi}점
                </u>{" "}
                (뒤쪽 중앙 {f2(bestBand.back.med)}%p)
              </>
            )}
          </b>
        )}
        {here && (
          <span className={`verdict-here ${here.good ? "ok" : "no"}`}>
            이 종목 {score}점 ({here.lo}~{here.hi}) —{" "}
            {here.good ? "앞뒤 모두 이긴 구간" : "근거가 약한 구간"}
          </span>
        )}
        <span className="verdict-when">
          {v.obs.toLocaleString("ko-KR")}관측 · {days === 0 ? "오늘" : `${days}일 전`} 잼
          {stale && " ⚠️"}
        </span>
      </button>

      {open && (
        <>
          <div className="table-wrap">
            <table className="sim-table verdict-table">
              <thead>
                <tr>
                  <th>점수</th>
                  <th className="num" colSpan={3}>
                    앞쪽 (~{v.splitAt.slice(4, 6)}/{v.splitAt.slice(6)})
                  </th>
                  <th className="num" colSpan={3}>
                    뒤쪽 (진짜 채점)
                  </th>
                  <th className="num">표본</th>
                </tr>
                <tr className="verdict-sub">
                  <th />
                  <th className="num">중앙</th>
                  <th className="num">절사</th>
                  <th className="num">승률</th>
                  <th className="num">중앙</th>
                  <th className="num">절사</th>
                  <th className="num">승률</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {v.splits.map((s) => (
                  <tr
                    key={s.cut}
                    className={`${s.good ? "verdict-ok" : ""}${
                      /* 누적 표에서는 「이 점수가 넘긴 가장 높은 문턱」을 짚는다 */
                      score !== null && score !== undefined && score >= s.cut &&
                      !v.splits.some((o) => o.cut > s.cut && score >= o.cut)
                        ? " verdict-row-here"
                        : ""
                    }`}
                  >
                    <td>
                      <b>{s.cut}점+</b>
                      {s.cut === v.greenAt && <i className="verdict-green">초록</i>}
                    </td>
                    <td className="num">{f2(s.front.med)}</td>
                    <td className="num">{f2(s.front.trim)}</td>
                    <td className="num">{f2(s.front.win)}</td>
                    <td className="num">{f2(s.back.med)}</td>
                    <td className="num">{f2(s.back.trim)}</td>
                    <td className="num">{f2(s.back.win)}</td>
                    <td className="num pt-n">{s.back.n.toLocaleString("ko-KR")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/*
            **점수 「구간」별** (2026-09-01) — 「이상」으로는 못 답하는 물음이 있다.

            벤티지: "너무 과한 점수는 고점신호가 되고 약한 건 아무도 안 보는 거고."

            위의 누적 표로는 그 물음에 답할 수 없다 — 90점 이상이 좋아 보여도 그건
            70~89 가 만든 값일 수 있다. 구간을 잘라야 위아래가 각각 보인다.
          */}
          {v.bands.length > 0 && (
            <div className="table-wrap">
              <table className="sim-table verdict-table">
                <thead>
                  <tr>
                    <th>구간</th>
                    <th className="num" colSpan={3}>
                      앞쪽
                    </th>
                    <th className="num" colSpan={3}>
                      뒤쪽
                    </th>
                    <th className="num">표본</th>
                  </tr>
                  <tr className="verdict-sub">
                    <th />
                    <th className="num">중앙</th>
                    <th className="num">절사</th>
                    <th className="num">승률</th>
                    <th className="num">중앙</th>
                    <th className="num">절사</th>
                    <th className="num">승률</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {v.bands.map((b) => (
                    <tr
                      key={b.lo}
                      className={`${b.good ? "verdict-ok" : ""}${
                        score !== null && score !== undefined && score >= b.lo && score <= b.hi
                          ? " verdict-row-here"
                          : ""
                      }`}
                    >
                      <td>
                        {b.lo}~{b.hi}
                      </td>
                      <td className="num">{f2(b.front.med)}</td>
                      <td className="num">{f2(b.front.trim)}</td>
                      <td className="num">{f2(b.front.win)}</td>
                      <td className="num">{f2(b.back.med)}</td>
                      <td className="num">{f2(b.back.trim)}</td>
                      <td className="num">{f2(b.back.win)}</td>
                      <td className="num pt-n">{b.back.n.toLocaleString("ko-KR")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="table-note">
            시장 대비 <b>초과분</b>입니다(20일 뒤 기준, %p·승률은 %p). 표본을 날짜로 반
            갈라 <b>앞쪽에서 고르고 뒤쪽에서 채점</b>합니다 — 뒤쪽이 진짜입니다.
            <br />
            {/*
              커버리지는 이 도구에서 가장 크게 틀렸던 자리다. 그 사실을 화면에 남긴다 —
              같은 함정에 다시 빠지지 않으려면 왜 이 규칙이 있는지 보여야 한다.
            */}
            <b>{Math.round(v.minCoverage * 100)}% 이상 잰 관측만</b> 씁니다
            {v.thin > 0 && <> (덜 잰 {v.thin.toLocaleString("ko-KR")}개는 뺐습니다)</>}. 렌즈가
            없는 기준은 채점에서 빠지고 남은 것으로 평균이 나기 때문에, <b>덜 잰 종목이 더
            쉽게 높은 점수를 받습니다</b> — 실측에서 그 구간의 70점 통과가 중앙 <b>-1.92</b>·
            승률 <b>-5.04</b> 였습니다.
            <br />
            <b>중앙값·절사평균·승률 셋이 다 양수</b>일 때만 굵게 칠합니다. 평균만 보면
            20일 +444% 짜리 몇 개가 만든 값에 속습니다 — 실제로 그 함정에 한 번
            빠졌습니다.
            {v.skipped.length > 0 && (
              <>
                <br />
                ⚠️ 채점에서 빠진 기준: <b>{v.skipped.join(" · ")}</b> — 표본에 없어
                이 판정은 그만큼 반쪽입니다.
              </>
            )}
            {stale && (
              <>
                <br />
                ⚠️ <b>{days}일 전에 잰 값</b>입니다. 그 뒤로 기준을 바꿨다면 설정을
                저장할 때 다시 재집니다.
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
