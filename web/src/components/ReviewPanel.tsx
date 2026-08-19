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
         * 오늘 발행한 리포트는 정의상 채점이 불가능하다. 그런데 그게 기본 선택이라
         * 열 때마다 "아직 비교할 거래일이 없습니다" 만 보게 됐다 — 기능이 있는데도
         * 없는 것처럼 느껴진 이유다.
         *
         * **채점이 가능한 가장 최근 것**을 고른다. 어제 것이 있으면 어제 것을.
         */
        const today = new Date().toISOString().slice(0, 10);
        setPicked(r.reports.find((x) => x.date < today) ?? r.reports[0] ?? null);
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
            </option>
          ))}
        </select>
        {result && (
          /* 한 줄 요약 — 매일 필요한 건 이것뿐이다 */
          <span className="rv-line">
            경과 {result.elapsedDays}일 · 적중{" "}
            <b className="positive">{result.hit}</b> · 애매 {result.partial} · 빗나감{" "}
            <b className="negative">{result.miss}</b>
          </span>
        )}
      </div>

      {error && <div className="error-banner">{error}</div>}
      {loading && !result && <div className="empty">채점 중… (종목별 일봉을 확인합니다)</div>}

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
                  <div className="rv-note">{it.note}</div>
                </div>
              );
            })}
          </div>

          <div className="table-note">
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
