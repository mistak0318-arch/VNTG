/**
 * 발행 진행 상황.
 *
 * 「지금 발행」은 웹 리서치와 AI 정리를 포함해 1~3분이 걸린다. 그런데 지금까지는
 * POST 하나가 그 시간을 통째로 물고 있어서, 화면은 아무것도 못 보여줬다 —
 * **멈춘 건지 도는 건지 알 수가 없다.** 오래 걸리는 것 자체는 문제가 아닌데,
 * 아무 말도 안 하는 건 문제다.
 *
 * 그래서 스크리너·알고리즘 스캔과 같은 방식으로 바꾼다: 요청은 곧바로 jobId 를
 * 돌려주고 뒤에서 돈다. 화면은 폴링하면서 어느 단계인지 보여준다.
 *
 * 단계 이름을 미리 박아 두는 이유는, 시작하자마자 **앞으로 무엇을 할지 전부**
 * 보여주기 위해서다. 하나씩 나타나면 몇 개가 남았는지 알 수 없다.
 */

export type StepState = "pending" | "running" | "done" | "failed" | "skipped";

export interface ProgressStep {
  key: string;
  label: string;
  state: StepState;
  /** 이 단계에서 알아낸 것 한 줄 — "검색 5회", "선별 23건" 같은 것 */
  note?: string;
  /** 걸린 시간(ms). 다음에 어디가 오래 걸리는지 알려면 남겨야 한다 */
  ms?: number;
}

export interface PublishJob {
  status: "running" | "done" | "error";
  label: string;
  steps: ProgressStep[];
  startedAt: string;
  /** 끝났으면 결과 리포트 */
  report?: unknown;
  error?: string;
}

/** 발행이 거치는 단계. 순서가 곧 화면 순서다 */
export const PUBLISH_STEPS: { key: string; label: string }[] = [
  { key: "market", label: "지수·수급·급등락 수집" },
  { key: "sector", label: "업종 자금 흐름" },
  { key: "signal", label: "시장 신호등" },
  { key: "usKr", label: "미국↔국내 테마 연동" },
  { key: "theme", label: "내 테마 평가" },
  { key: "news", label: "뉴스·공시" },
  { key: "research", label: "웹 리서치 (검색)" },
  { key: "ai", label: "AI 정리 생성" },
  { key: "save", label: "저장·발송" },
];

/**
 * 텔레그램 채널 정리·발송이 거치는 단계.
 *
 * 채널 200개를 읽는 데 시간이 걸리는데 「발송 중…」 한 마디만 떠 있어서 얼마나
 * 기다려야 하는지 알 수 없었다. 리포트와 같은 방식으로 어느 단계인지 보여준다.
 */
export const CHANNEL_STEPS: { key: string; label: string }[] = [
  { key: "read", label: "채널 읽기" },
  { key: "pick", label: "선별·점수화" },
  { key: "tag", label: "종목·테마 태그" },
  { key: "ai", label: "AI 정리" },
  { key: "send", label: "텔레그램 발송" },
];

const jobs = new Map<string, PublishJob>();

function prune(): void {
  if (jobs.size < 12) return;
  const old = [...jobs.entries()]
    .sort((a, b) => a[1].startedAt.localeCompare(b[1].startedAt))
    .slice(0, 6);
  for (const [id] of old) jobs.delete(id);
}

export function createJob(
  label: string,
  steps: { key: string; label: string }[] = PUBLISH_STEPS,
): { id: string; job: PublishJob } {
  const id = `pub_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const job: PublishJob = {
    status: "running",
    label,
    steps: steps.map((s) => ({ ...s, state: "pending" })),
    startedAt: new Date().toISOString(),
  };
  jobs.set(id, job);
  prune();
  return { id, job };
}

export function getJob(id: string): PublishJob | undefined {
  return jobs.get(id);
}

/**
 * 진행 상황을 알리는 손잡이. 다이제스트를 만드는 쪽에 이것만 넘긴다.
 *
 * 진행 보고가 본 기능을 망가뜨리면 안 되므로 **아무것도 던지지 않는다.**
 * job 이 없어도(정기 발행처럼 진행 표시가 필요 없는 경우) 조용히 넘어간다.
 */
export interface ProgressReporter {
  start(key: string): void;
  done(key: string, note?: string): void;
  fail(key: string, note?: string): void;
  skip(key: string, note?: string): void;
}

/** 아무것도 하지 않는 손잡이 — 정기 발행처럼 화면이 없는 경로에서 쓴다 */
export const noopProgress: ProgressReporter = {
  start: () => undefined,
  done: () => undefined,
  fail: () => undefined,
  skip: () => undefined,
};

export function reporterFor(job: PublishJob): ProgressReporter {
  const startedAt = new Map<string, number>();
  const set = (key: string, state: StepState, note?: string) => {
    const step = job.steps.find((s) => s.key === key);
    if (!step) return;
    step.state = state;
    if (note) step.note = note;
    if (state === "running") startedAt.set(key, Date.now());
    else {
      const t = startedAt.get(key);
      if (t) step.ms = Date.now() - t;
    }
  };
  return {
    start: (key) => set(key, "running"),
    done: (key, note) => set(key, "done", note),
    fail: (key, note) => set(key, "failed", note),
    skip: (key, note) => set(key, "skipped", note),
  };
}
