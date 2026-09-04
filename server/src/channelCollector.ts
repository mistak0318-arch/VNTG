import { fetchNewMessages, isReaderConfigured } from "./telegramReader.js";
import { coverage, prune, record, status } from "./channelStore.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 채널 글 **수집기** — 조금씩, 자주 (2026-09-05).
 *
 * 벤티지: "계속 스크리닝하다가 막히는 것보다도 계속 수집을 하면 한 번에 여러 개 안 훑어도
 * 되잖아." 정확히 그 말이 이 파일이다.
 *
 * ## 왜 이게 한 번에 크게 훑는 것보다 나은가
 *
 * 한 번에 크게 훑으면 **채널당 가져오는 수의 상한**에 걸린다. 상한을 올리면 FLOOD_WAIT 이
 * 오고, 그게 오면 검색만 막히는 게 아니라 **정기 수집까지 같이 막힌다.** 즉 크게 훑을수록
 * 더 못 보게 되는 구조였다.
 *
 * 10분마다 최근 30분치만 받으면 그 상한에 닿을 일이 없다. 그러고도 창고는 **하루 24시간
 * 빠짐없이** 찬다. 검색은 창고만 읽으므로 구간을 한 달로 넓혀도 텔레그램을 안 부른다.
 *
 * ## 왜 30분치를 10분마다 받나 — 겹쳐서 받는다
 *
 * 정확히 10분치만 받으면 한 번 실패하거나 서버가 잠깐 죽는 순간 **그 사이가 영영 빈다.**
 * 세 배로 겹쳐 받으면 두 번 연속 실패해도 다음 회차가 메운다. 겹친 것은 창고가
 * `channelId:messageId` 로 걸러 내므로 같은 글이 두 번 쌓이지 않는다.
 *
 * ## 오프셋을 안 쓴다
 *
 * `useOffsets: true` 는 「마지막으로 읽은 id 다음부터」인데, 그 오프셋은 **정기 발행이
 * 쓰는 것**이다. 수집기가 그걸 올려 버리면 다음 정기 발행이 빈 채로 나간다.
 * 창고는 중복을 스스로 거르므로 오프셋이 필요 없다.
 */

/** 얼마나 자주 도나 */
const EVERY_MS = 10 * 60_000;
/** 한 번에 얼마를 받나 — 주기의 세 배로 겹친다 */
const WINDOW_MIN = 30;
/**
 * 채널당 상한. 30분에 60건을 넘기는 채널은 거의 없다 —
 * 넘겨도 다음 회차가 겹쳐 받으므로 통째로 잃지는 않는다.
 */
const PER_CHANNEL = 60;

let timer: NodeJS.Timeout | null = null;
let last: { at: string; got: number; added: number; error: string | null } | null = null;

export function collectorState(): typeof last {
  return last;
}

/** 한 바퀴 — 실패해도 다음 회차가 있다 */
export async function collectOnce(): Promise<number> {
  if (!isReaderConfigured()) return 0;
  try {
    const { messages } = await fetchNewMessages({
      sinceMinutes: WINDOW_MIN,
      useOffsets: false,
      maxPerChannel: PER_CHANNEL,
    });
    const added = await record(messages);
    last = { at: new Date().toISOString(), got: messages.length, added, error: null };
    return added;
  } catch (e) {
    last = {
      at: new Date().toISOString(),
      got: 0,
      added: 0,
      error: e instanceof Error ? e.message : "수집 실패",
    };
    return 0;
  }
}


/* ── 첫 채우기 ──────────────────────────────────────────────────────── */

const here = dirname(fileURLToPath(import.meta.url));
const SEED_FILE = join(here, "..", "data", "channelSeed.json");

/**
 * 한 번에 채널당 몇 건까지 긁어 올까 (첫 채우기).
 *
 * 평소 수집은 60건이면 되지만 **첫날은 창고가 비어 있다.** 앞으로만 쌓으면 한 달치가
 * 되는 데 한 달이 걸린다 — 벤티지: "지금 첫 배포 시에는 일단 수집하는 로직 넣어놨어?"
 *
 * ⚠️ **이 값이 곧 뒤로 닿는 깊이다.** 그리고 채널마다 다르다 — 글이 잦은 채널은
 * 400건이 며칠치고, 뜸한 채널은 몇 주치다. 한 달을 다 못 채울 수 있고, **못 채운다는
 * 사실을 숨기지 않는다**(`/api/channels/store` 가 실제로 닿은 날짜를 보여 준다).
 * 더 깊이 긁으려면 이 값을 올리면 되는데, 그만큼 FLOOD_WAIT 에 가까워진다.
 */
const SEED_PER_CHANNEL = 400;

/** 창고가 이만큼도 안 차 있으면 「비었다」로 본다 */
const SEED_MIN_LINES = 500;

async function seedDone(): Promise<string | null> {
  try {
    const j = JSON.parse(await readFile(SEED_FILE, "utf8")) as { at?: string };
    return typeof j.at === "string" ? j.at : null;
  } catch {
    return null;
  }
}

/**
 * **첫 채우기** — 창고가 비어 있을 때 한 번만 깊게 긁는다.
 *
 * 배포가 잦아서 재시작마다 돌면 안 된다(그때마다 채널 일흔 곳을 400건씩 긁는다).
 * 그래서 **한 번 했다는 표시를 파일에 남긴다.** 다만 창고가 정말 비어 있으면
 * 표시가 있어도 다시 한다 — 표시만 남고 자료가 없는 상태가 더 나쁘다.
 */
export async function seedOnce(force = false): Promise<{ ran: boolean; added: number; why: string }> {
  if (!isReaderConfigured()) return { ran: false, added: 0, why: "텔레그램 세션이 없다" };

  const cov = await coverage().catch(() => ({ oldest: null, newest: null, lines: 0 }));
  const done = await seedDone();
  if (!force && done && cov.lines >= SEED_MIN_LINES) {
    return { ran: false, added: 0, why: `이미 채웠다 (${done.slice(0, 16)}, ${cov.lines}건)` };
  }

  try {
    const { messages } = await fetchNewMessages({
      sinceMinutes: 44_640, // 31일
      useOffsets: false,
      maxPerChannel: SEED_PER_CHANNEL,
    });
    const added = await record(messages);
    try {
      await mkdir(dirname(SEED_FILE), { recursive: true });
      await writeFile(SEED_FILE, JSON.stringify({ at: new Date().toISOString(), added }), "utf8");
    } catch {
      /* 표시를 못 남기면 다음 재시작에 한 번 더 돈다 — 아프지만 안 망가진다 */
    }
    const after = await coverage().catch(() => cov);
    console.log(
      `[channels] 첫 채우기 — ${messages.length}건 받아 ${added}건 저장 · 뒤로 ${after.oldest?.slice(0, 10) ?? "?"} 까지`,
    );
    return { ran: true, added, why: "채웠다" };
  } catch (e) {
    return { ran: false, added: 0, why: e instanceof Error ? e.message : "실패" };
  }
}

export function startChannelCollector(): void {
  if (timer) return;
  if (!isReaderConfigured()) {
    console.log("[channels] 텔레그램 세션이 없어 창고 수집을 안 켭니다");
    return;
  }
  /*
   * 뜨자마자 돌리지 않는다 — 배포 직후엔 다른 것도 같이 깨어난다.
   *
   * 순서가 있다: **첫 채우기 → 평소 수집.** 창고가 비어 있으면 깊게 한 번 긁고,
   * 이미 차 있으면 그 자리에서 넘어간다(`seedOnce` 가 스스로 판단한다).
   */
  setTimeout(() => {
    void seedOnce()
      .then((r) => {
        if (!r.ran) console.log(`[channels] 첫 채우기 건너뜀 — ${r.why}`);
      })
      .catch(() => undefined)
      .finally(() => void collectOnce());
  }, 60_000);
  timer = setInterval(() => void collectOnce(), EVERY_MS);

  /* 하루 한 번 오래된 날을 지운다 — 한 달을 넘기면 오래된 것부터 */
  const sweep = () =>
    void prune()
      .then(async (r) => {
        if (r.byDays > 0 || r.bySize > 0) {
          const st = await status();
          console.log(
            `[channels] 창고 정리 — 날짜 ${r.byDays}일 · 크기 ${r.bySize}일 지움 · 남은 ${st.totalLines}건 ${(st.totalBytes / 1024 / 1024).toFixed(1)}MB`,
          );
        }
      })
      .catch(() => undefined);
  setTimeout(sweep, 5 * 60_000);
  setInterval(sweep, 24 * 3600_000);

  console.log(`[channels] 창고 수집 — ${EVERY_MS / 60_000}분마다 최근 ${WINDOW_MIN}분치`);
}
