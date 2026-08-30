import { useEffect, useState } from "react";
import { api, type ReviewResult, type ReviewableReport } from "../api";

/**
 * 리포트 복기 — 예측 → 결과 → 복기 루프의 마지막 단계.
 *
 * 이 앱을 "내 매매 논리를 찾는 훈련 도구"라고 정의했다면, 훈련의 본체는 여기다.
 * 리포트를 아무리 많이 발행해도 **그게 맞았는지 돌아보지 않으면 훈련이 아니다.**
 *
 * 채점은 기계가 한다(AI 비용 0). 화면은 그 결과를 보여주기만 한다.
 * **적중률을 자랑하려고 만든 게 아니다** — 어떤 근거가 실제로 통했는지를 보는 자리다.
 */

const VERDICT: Record<string, { label: string; cls: string }> = {
  hit: { label: "적중", cls: "positive" },
  miss: { label: "빗나감", cls: "negative" },
  partial: { label: "애매", cls: "" },
  pending: { label: "대기", cls: "" },
  unknown: { label: "확인 불가", cls: "" },
};

const DIRECTION: Record<string, string> = { up: "상승", down: "하락", flat: "중립" };
const KIND: Record<string, string> = { stock: "종목", theme: "테마", market: "시장" };

function pct(n: number | null): string {
  if (n === null) return "-";
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
}

export function ReviewPanel() {
  const [list, setList] = useState<ReviewableReport[]>([]);
  const [picked, setPicked] = useState<ReviewableReport | null>(null);
  const [result, setResult] = useState<ReviewResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .reviewableReports()
      .then((r) => {
        setList(r.reports);
        /*
         * **오늘 것을 기본으로 두면 안 된다.**
         *
         * 오늘 발행한 리포트는 정의상 채점이 불가능하다. 그게 기본 선택이라
         * 열 때마다 "아직 비교할 거래일이 없습니다" 만 보게 됐다 — 기능이 있는데도
         * 없는 것처럼 느껴진 이유다.
         *
         * 예전엔 `날짜 < 오늘` 로 어림잡았는데 그건 **오늘 것을 피할 뿐** 채점이 되는지는
         * 말해 주지 않는다. 이제 서버가 `elapsedDays` 를 같이 보내므로 그걸 그대로 쓴다 —
         * 채점 쪽과 같은 식이라 목록과 결과가 어긋나지 않는다.
         *
         * 목록은 발행 시각 내림차순이므로 **처음 걸리는 것이 곧 가장 최근**이다.
         */
        setPicked(r.reports.find((x) => x.elapsedDays >= 1) ?? r.reports[0] ?? null);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!picked) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .reviewReport(picked.date, picked.edition)
      .then((r) => !cancelled && setResult(r.result))
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [picked?.date, picked?.edition]);

  const scorable = list.filter((r) => r.elapsedDays >= 1).length;

  if (list.length === 0) {
    return (
      <div className="page-note">
        복기할 리포트가 아직 없습니다. 리포트를 발행하면 <b>체크포인트</b>가 함께 저장되고,
        며칠 뒤 여기서 실제 결과와 대조할 수 있습니다. 오늘부터 쌓여야 다음 주에 첫 복기가 나옵니다.
      </div>
    );
  }

  return (
    <>
      {/*
        칩을 열 개 깔면 두 줄 반을 먹는다. 발행일은 **고르는 값**이지 훑는 값이 아니라
        드롭다운이 맞다 — 화면은 한 줄로 줄고, 대신 30건까지 고를 수 있게 됐다.
      */}
      <div className="filter-row">
        <label htmlFor="review-pick" className="pt-n">
          발행
        </label>
        <select
          id="review-pick"
          className="pt-input"
          value={picked ? `${picked.date}|${picked.edition}` : ""}
          onChange={(e) => {
            const [d, ed] = e.target.value.split("|");
            setPicked(list.find((x) => x.date === d && x.edition === ed) ?? null);
          }}
        >
          {list.map((r) => (
            <option key={`${r.date}-${r.edition}`} value={`${r.date}|${r.edition}`}>
              {r.date.slice(5)} {r.label} · {r.count}건
              {/* 채점이 되는지 목록에서 바로 알 수 있게 — 골라 보고 나서 「대기」를 만나면 늦다 */}
              {r.elapsedDays < 1 ? " · 채점 전" : ` · ${r.elapsedDays}일 경과`}
            </option>
          ))}
        </select>
        {result && (
          /* 한 줄 요약 — 매일 필요한 건 이것뿐이다 */
          <span className="rv-line">
            {/*
              ⚠️ **어느 판의 결과인지 박아 둔다.**

              「드롭박스를 바꿔도 갱신이 안 된다」는 말이 나왔는데, 코드는 정상이었다.
              판을 바꾸면 다시 채점해서 다시 그린다. 문제는 **바뀐 게 안 보인다**는
              것이었다 — 요약이 「경과 N일 · 적중 M」뿐이라 두 판의 숫자가 비슷하면
              화면이 그대로인 것처럼 보인다.

              고른 판을 결과 안에 적으면 **바뀌었다는 게 눈에 보인다.**
            */}
            <b className="rv-which">
              {picked?.date.slice(5)} {picked?.label}
            </b>
            경과 {result.elapsedDays}일 · 적중{" "}
            <b className="positive">{result.hit}</b> · 애매 {result.partial} · 빗나감{" "}
            <b className="negative">{result.miss}</b>
          </span>
        )}
      </div>

      {/*
        **이 예측을 누가 적었나.**

        「복기의 기준은 누가 정해준 건지 모르겠다, 나는 코스피를 복기 종목으로 둔 적이
        없다」는 말이 나왔다. 맞는 지적이다 — 체크포인트는 **리포트를 발행할 때 AI 가
        그 판의 근거로 적어 둔 것**인데 화면이 그걸 한 번도 말한 적이 없다.
        내가 고른 종목으로 보이면 「왜 이게 여기 있냐」가 된다.
      */}
      <p className="page-note">
        여기 항목은 <b>그 판을 발행할 때 AI 가 적어 둔 예측</b>입니다 — 내가 고른
        종목이 아닙니다. 그래서 코스피 같은 지수도 들어갑니다. 채점은 <b>기계가</b>{" "}
        일봉으로 하고 <b>AI 비용은 0</b>입니다.
        <br />
        <b>적중률을 자랑하려고 만든 게 아닙니다</b> — 어떤 근거가 실제로 통했는지를 보는 자리입니다.
      </p>

      {error && <div className="error-banner">{error}</div>}
      {loading && !result && <div className="empty">채점 중… (종목별 일봉을 확인합니다)</div>}

      {/*
        「대기」만 보이는 이유를 **접힌 곳 밖에서** 말해 준다.
        예전엔 이 안내가 `details` 안에 있어서, 펴 보지 않으면 왜 아무것도 없는지 알 수 없었다.
      */}
      {scorable === 0 && (
        <div className="alert-note">
          아직 채점할 수 있는 리포트가 없습니다. 발행된 것이 전부 오늘 것이라 비교할 거래일이
          없습니다 — <b>다음 거래일이 지나면</b> 여기에 결과가 찹니다.
        </div>
      )}
      {scorable > 0 && result?.elapsedDays === 0 && (
        <div className="alert-note">
          고른 것이 오늘 발행분이라 아직 채점할 수 없습니다. 위 목록에서{" "}
          <b>「N일 경과」</b>가 붙은 것을 고르세요.
        </div>
      )}

      {/*
        상세는 접어 둔다. 매일 필요한 건 위의 한 줄이고, 무엇이 왜 틀렸는지는
        궁금할 때만 편다 — 화면을 많이 차지한다는 게 이 기능의 실제 문제였다.
      */}
      {result && (
        <details className="rv-detail">
          <summary>항목별로 보기 ({result.items.length}건)</summary>

          {result.elapsedDays === 0 && (
            <div className="alert-note">
              오늘 발행한 리포트라 아직 비교할 거래일이 없습니다. <b>다음 거래일 이후</b>에
              다시 보세요.
            </div>
          )}

          <div className="rv-list">
            {result.items.map((it, i) => {
              const v = VERDICT[it.verdict] ?? VERDICT.unknown;
              return (
                <div className={`rv-item ${it.verdict}`} key={`${it.kind}-${it.key}-${i}`}>
                  <div className="rv-head">
                    <span className="rv-kind">{KIND[it.kind] ?? it.kind}</span>
                    <span className="rv-label">{it.label}</span>
                    <span className="rv-pred">{DIRECTION[it.direction]} 예측</span>
                    <span className={`rv-actual ${it.actual !== null && it.actual > 0 ? "positive" : it.actual !== null && it.actual < 0 ? "negative" : ""}`}>
                      실제 {pct(it.actual)}
                    </span>
                    <span className={`rv-verdict ${v.cls}`}>{v.label}</span>
                  </div>
                  {it.reason && <div className="rv-reason">근거: {it.reason}</div>}
                  <div className="rv-note">
                    {it.note}
                    {/*
                      **무엇과 무엇을 견줬는지** 적는다 (2026-08-31). 위의 「N일 경과」는
                      달력 날수라 주말·휴장이 끼면 실제 잰 구간과 어긋난다 — 8/27 발행분을
                      「4일 경과」로 적으면서 속으로는 8/27→8/28 하루치를 재고 있었다.
                    */}
                    {it.baseDate && it.lastDate && (
                      <span className="pt-n"> · {it.baseDate.slice(5)} → {it.lastDate.slice(5)} 종가</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="table-note">
            {/*
              ⚠️ **누가 이걸 골랐나에 답한다.**

              「코스피를 복기 종목으로 둔 적이 없는데 왜 나오나」라는 말이 나왔다.
              당연한 물음이다 — 이 목록은 **내가 고른 게 아니라 리포트가 발행될 때 AI 가
              적어 둔 예측**인데, 화면에는 결과만 있고 그 사연이 없었다.
            */}
            <b>이 목록은 내가 고른 종목이 아닙니다.</b> 리포트를 발행할 때 AI 가 그날
            데이터를 보고 <b>「이건 이렇게 될 것」이라고 적어 둔 것</b>(체크포인트 3~5개)이고,
            여기서는 그게 맞았는지만 대조합니다. 그래서 <b>[시장|KOSPI]</b> 처럼 지수 예측도
            섞입니다 — 그날의 시장 판단도 예측이기 때문입니다.
            <br />
            <b>±1% 안쪽 움직임은 중립</b>으로 봅니다 — 0.2% 움직인 것을 "상승 적중"이라고 세면
            적중률이 부풀려져 복기가 무의미해집니다. 테마는 구성종목 단순평균, 시장은
            <b>업종일봉</b> 기준입니다(예전엔 ETF 를 대용으로 썼는데 지수와 따로 놀았습니다). <b>적중률을 재는 도구가 아닙니다</b> — 위의 「근거」 중 어떤 것이 실제로
            통했는지 보는 게 목적입니다.
          </div>
        </details>
      )}
    </>
  );
}
