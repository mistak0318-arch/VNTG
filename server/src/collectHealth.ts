/**
 * **수집 결과 기록** — 「지금 어느 값이 비어 있고, 왜 비었나」 (2026-10-19).
 *
 * ## 왜 또 만드나 — `apiUsage` 로는 안 보인다
 *
 * 야간선물이 사흘 빈칸이었다. 그 사흘 동안 `apiUsage.json` 의 한투는 **`ok 68,346` ·
 * `failed 3`** 이었다. API 는 멀쩡했다 — 끊긴 것은 **우리 쪽 경로**였고(전광판 한 번
 * 막히면 그 뒤 10분을 쉬는 구조), 그건 공급자 단위 집계에 **한 건도 안 잡힌다.**
 * `server.log` 에도 한 줄이 없었다. `catch { return null }` 이 까닭을 삼켰기 때문이다.
 *
 * 그래서 공급자가 아니라 **값 단위**로 적는다. 「환율」·「코스피200 선물」·「증시자금동향」
 * 처럼 화면에 뜨는 이름으로, 마지막 성공과 마지막 실패와 **연속 실패 수**를 들고 있는다.
 * health.json 에 한 칸으로 나가므로, 다음에 무엇이 비면 **하루가 아니라 한 줄**로 보인다.
 *
 * ## 무엇을 안 적나
 *
 * 종목코드·계좌·키는 안 적는다. 까닭은 **짧은 글자**다(에러 코드나 한 줄 요약).
 * 값 자체도 안 적는다 — 여기 쌓는 것은 「되고 있나」지 「얼마인가」가 아니다.
 *
 * ⚠️ **메모리에만 둔다.** 서버가 재시작하면 비는 게 맞다 — 「재시작 뒤로 한 번도 못
 * 받았다」와 「어제부터 못 받는다」는 다른 이야기이고, 그 둘이 섞이면 이 칸을 못 믿는다.
 */

interface Mark {
  /** 마지막으로 값을 받은 때 */
  ok: number | null;
  /** 마지막으로 못 받은 때 */
  fail: number | null;
  /** 그때의 까닭 — 짧게 */
  why: string;
  /** 마지막 성공 뒤로 연속 몇 번 못 받았나. 0 이면 지금 멀쩡하다 */
  streak: number;
  /** 성공·실패를 합친 횟수 — 「아예 안 불린다」와 「불리는데 실패한다」를 가른다 */
  tries: number;
}

const marks = new Map<string, Mark>();

function get(name: string): Mark {
  let m = marks.get(name);
  if (!m) {
    m = { ok: null, fail: null, why: "", streak: 0, tries: 0 };
    marks.set(name, m);
  }
  return m;
}

/** 값을 받았다 */
export function collectOk(name: string): void {
  const m = get(name);
  m.ok = Date.now();
  m.streak = 0;
  m.why = "";
  m.tries += 1;
}

/**
 * 값을 못 받았다. `why` 는 **짧은 까닭** — 에러 코드(`QUEUE_FULL`)나 한 줄 요약
 * (`전광판빈줄`). 길면 잘린다. 종목코드·키는 넣지 말 것.
 */
export function collectFail(name: string, why: string): void {
  const m = get(name);
  m.fail = Date.now();
  m.why = String(why).slice(0, 80);
  m.streak += 1;
  m.tries += 1;
}

/** 함수 하나를 감싸 성공·실패를 저절로 적는다 — 호출처가 한 줄로 끝난다 */
export async function collect<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    const v = await fn();
    /*
     * ⚠️ **`null` 은 실패로 센다.** 여태 빈칸을 만든 것이 바로 「예외 없이 null 을
     * 돌려주는」 경로였다 — 예외만 세면 그 경로가 또 안 보인다.
     */
    if (v === null || v === undefined) {
      collectFail(name, "값없음");
      return null;
    }
    collectOk(name);
    return v;
  } catch (e) {
    const code = (e as { code?: unknown })?.code;
    collectFail(name, typeof code === "string" ? code : e instanceof Error ? e.message : "예외");
    return null;
  }
}

const hhmm = (ms: number | null): string | null => {
  if (!ms) return null;
  const d = new Date(ms + 9 * 3600_000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
};

/**
 * health.json 「수집」 칸.
 *
 * **못 받고 있는 것을 앞에** 세운다(연속 실패 많은 순) — 멀쩡한 줄이 스무 개 있어도
 * 고장난 하나가 맨 위에 있어야 눈에 걸린다. 멀쩡한 것은 마지막 성공 시각만 적는다.
 */
export function collectHealthSnapshot(): Record<string, string> | null {
  if (marks.size === 0) return null;
  const rows = [...marks.entries()].sort((a, b) => {
    if (a[1].streak !== b[1].streak) return b[1].streak - a[1].streak;
    return a[0].localeCompare(b[0]);
  });
  const out: Record<string, string> = {};
  for (const [name, m] of rows) {
    out[name] =
      m.streak === 0
        ? `정상 (${hhmm(m.ok) ?? "-"})`
        : `${m.streak}회 연속 못 받음 · ${m.why || "까닭없음"} · 마지막 성공 ${hhmm(m.ok) ?? "없음"} (${hhmm(m.fail)})`;
  }
  return out;
}
