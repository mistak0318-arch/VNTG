import type { PublishJob } from "../api";

/**
 * 단계별 진행 표시.
 *
 * 리포트 발행과 텔레그램 정리가 같은 모양을 쓴다. 오래 걸리는 일에 아무 표시가 없으면
 * **멈춘 건지 도는 건지 알 수가 없다** — 오래 걸리는 것 자체보다 그게 문제다.
 *
 * 단계를 처음부터 전부 깔아 두고 상태만 바꾼다. 하나씩 나타나면 몇 개가 남았는지 모른다.
 */
export function ProgressSteps({ job }: { job: PublishJob }) {
  const done = job.steps.filter((s) => s.state === "done" || s.state === "skipped").length;
  return (
    <div className="pub-progress">
      <div className="pub-progress-head">
        <b>{job.label}</b>
        <span className="pub-progress-count">
          {done}/{job.steps.length}
        </span>
        {job.status === "running" && <span className="pub-spinner" aria-hidden="true" />}
      </div>
      <ol className="pub-steps">
        {job.steps.map((s) => (
          <li key={s.key} className={`pub-step ${s.state}`}>
            <span className="pub-step-mark" aria-hidden="true">
              {s.state === "done"
                ? "✓"
                : s.state === "running"
                  ? "●"
                  : s.state === "failed"
                    ? "✕"
                    : s.state === "skipped"
                      ? "–"
                      : "○"}
            </span>
            <span className="pub-step-label">{s.label}</span>
            {s.note && <span className="pub-step-note">{s.note}</span>}
            {s.ms !== undefined && s.ms > 900 && (
              <span className="pub-step-ms">{(s.ms / 1000).toFixed(1)}s</span>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
