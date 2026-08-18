import { useEffect, useState } from "react";
import { api, type PublishJob } from "../api";

/**
 * 돌고 있는 작업 띠.
 *
 * 리포트 발행이나 텔레그램 발송은 1~2분 걸린다. 그동안 다른 메뉴로 가면 **진행 상황을
 * 볼 방법이 없었다.** 서버는 계속 돌고 있는데 화면이 jobId 를 잃어버려서, 돌아와도
 * "끝났나?" 를 알 수가 없어 결국 발행 버튼을 또 누르게 된다 — 그게 비용이다.
 *
 * 그래서 이 띠는 **어느 화면에 있든** 뜬다. 작업이 없으면 아무것도 그리지 않는다.
 *
 * 폴링은 3초. 작업이 하나도 없으면 20초로 늦춘다 — 대부분의 시간은 아무 작업도 없다.
 */

interface Active {
  id: string;
  job: PublishJob;
}

export function RunningJobsBar() {
  const [jobs, setJobs] = useState<Active[]>([]);
  const [hidden, setHidden] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;
    let timer: number | undefined;

    const tick = async () => {
      try {
        const r = await api.activeJobs();
        if (!alive) return;
        setJobs(r.jobs);
        // 끝난 작업은 숨김 목록에서도 지운다 — 다음에 같은 id 가 다시 날 일은 없지만
        // 목록이 계속 자라는 걸 막는다
        setHidden((h) => h.filter((id) => r.jobs.some((j) => j.id === id)));
        timer = window.setTimeout(tick, r.jobs.length > 0 ? 3000 : 20000);
      } catch {
        timer = window.setTimeout(tick, 20000);
      }
    };
    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const shown = jobs.filter((j) => !hidden.includes(j.id));
  if (shown.length === 0) return null;

  return (
    <div className="rj-bar">
      {shown.map(({ id, job }) => {
        const done = job.steps.filter((s) => s.state === "done" || s.state === "skipped").length;
        const running = job.steps.find((s) => s.state === "running");
        const pct = job.steps.length > 0 ? (done / job.steps.length) * 100 : 0;
        return (
          <div className="rj-item" key={id}>
            <div className="rj-head">
              <span className="rj-spin" />
              <b>{job.label}</b>
              <span className="pt-n">
                {done}/{job.steps.length}
                {running ? ` · ${running.label}` : ""}
              </span>
              {/* 닫아도 작업은 계속 돈다 — 화면에서만 치운다 */}
              <button className="rj-x" onClick={() => setHidden((h) => [...h, id])} title="숨기기">
                ✕
              </button>
            </div>
            <div className="rj-track">
              <i style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
