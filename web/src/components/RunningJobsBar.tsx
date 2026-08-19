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
 * 폴링은 작업이 있으면 2초, 없으면 5초다.
 *
 * 처음엔 놀 때 20초로 뒀는데 그게 틀렸다. 작업이 20초 안에 끝나면 **띠가 한 번도
 * 안 뜬다** — 실제로 발행이 그렇게 끝나서 "안 보인다"는 말이 나왔다.
 * 게다가 07:00 정기 발행은 **서버가 시작하므로 알려 줄 쪽이 없다.** 폴링이 유일한
 * 눈이라 촘촘해야 한다. 목록을 훑는 것뿐이라 값도 거의 안 든다.
 */

interface Active {
  id: string;
  job: PublishJob;
}

/*
 * 작업이 막 시작됐다고 알린다.
 *
 * 폴링만으로는 **최대 20초 늦게** 뜬다. 발행이 30~60초에 끝나니 띠가 늦게 떴다가
 * 금방 사라지거나, 아예 못 보고 지나간다 — "안 보인다"는 게 그거였다.
 * 발행 버튼을 누른 쪽이 이걸 부르면 바로 뜬다.
 */
const listeners = new Set<() => void>();

export function notifyJobStarted(): void {
  for (const fn of listeners) fn();
}

export function RunningJobsBar() {
  const [jobs, setJobs] = useState<Active[]>([]);
  const [hidden, setHidden] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;
    let timer: number | undefined;

    const tick = async () => {
      // 탭이 뒤에 있으면 물어보지 않는다 — 안 보는 화면 때문에 계속 부를 이유가 없다
      if (document.visibilityState !== "visible") {
        timer = window.setTimeout(tick, 5000);
        return;
      }
      try {
        const r = await api.activeJobs();
        if (!alive) return;
        setJobs(r.jobs);
        // 끝난 작업은 숨김 목록에서도 지운다 — 다음에 같은 id 가 다시 날 일은 없지만
        // 목록이 계속 자라는 걸 막는다
        setHidden((h) => h.filter((id) => r.jobs.some((j) => j.id === id)));
        timer = window.setTimeout(tick, r.jobs.length > 0 ? 2000 : 5000);
      } catch {
        timer = window.setTimeout(tick, 10000);
      }
    };
    void tick();

    // 작업이 시작됐다는 신호를 받으면 기다리지 않고 바로 물어본다
    const wake = () => {
      if (timer) clearTimeout(timer);
      void tick();
    };
    listeners.add(wake);

    return () => {
      alive = false;
      listeners.delete(wake);
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
