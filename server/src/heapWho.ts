import { Session } from "node:inspector";
import { noteLife } from "./lifecycle.js";
import { pressure } from "./recovery.js";

/**
 * **누가 메모리를 먹나** (2026-11-10 — 벤티지가 고른 것: "누가 먹는지 먼저 재다").
 *
 * ## 여태 쓴 자는 범인을 못 집는다
 *
 * 지금 있는 장치는 「무거운 요청」 로그다 — 요청 들어올 때와 나갈 때의 heap 을 재서
 * 차를 적는다. 그 자로 11/09 밤에 이런 줄이 찍혔다:
 *
 *   GET /series  +3448MB  564311ms
 *
 * 그런데 `/series` 는 증권사를 안 부르고 창고만 읽는 길이다. 저 숫자는 **그 요청이
 * 열려 있던 9분 동안 다른 요청들이 올린 것까지 통째로** 뒤집어쓴 것이다. 동시에 서른
 * 둘이 도는 서버에서 요청별 heap 차는 **누구 것인지 알 수 없다.**
 *
 * ## V8 에게 직접 묻는다
 *
 * V8 에는 **샘플링 힙 프로파일러**가 있다 — 일정 바이트마다 한 번씩 「지금 할당하는
 * 자가 누구인가」를 스택째로 적어 둔다. 요청 단위가 아니라 **할당하는 코드 한 줄
 * 단위**라, 동시에 뭐가 돌든 섞이지 않는다.
 *
 * `node:inspector` 세션으로 `HeapProfiler.startSampling` 을 걸어 둔다. 64KB 마다 한
 * 점이라 늘 켜 둬도 싸다(그보다 작은 할당은 확률로 섞여 들어온다).
 *
 * ## 「지금 누가 먹나」는 차분으로 본다
 *
 * 프로파일은 **뜬 뒤로 쭉 누적**이다. 그것만 보면 기동 때 한 번 크게 든 것이 영원히
 * 1위라 지금 범인이 안 보인다. 그래서 부를 때마다 찍어 두고 **지난번과의 차**를 같이
 * 낸다 — 느릴 때 두 번 누르면 그 사이에 누가 먹었는지가 나온다.
 *
 * ## ⚠️ 한계
 *
 *  · **할당한 양**이지 **들고 있는 양**이 아니다. 금방 버리는 것도 크게 찍힌다. 그래도
 *    봉우리를 만드는 건 결국 할당이라, 「GC 가 바빠지는 까닭」으로는 이 자가 맞다.
 *  · 줄번호는 `dist` 것이다(소스맵 없이 돈다). 파일 이름까지는 그대로라 어느 모듈인지는
 *    바로 갈린다.
 *  · 인스펙터를 못 열면 **조용히 안 켠다** — 이 장치 때문에 서버가 안 뜨면 안 된다.
 */

type Frame = { functionName: string; url: string; lineNumber: number; columnNumber: number };
type ProfileNode = { callFrame: Frame; selfSize: number; children?: ProfileNode[] };

let session: Session | null = null;
let on = false;
/** 64KB 마다 한 점 — 늘 켜 둬도 싼 간격 */
const SAMPLE_BYTES = 65_536;

/** 지난번에 찍은 값 — 「그 사이에 누가 먹었나」를 내려고 */
let prev: Map<string, number> | null = null;
let prevAt = 0;

/**
 * **1분마다 스스로 찍어 둔다** — `health.json` 이 그걸 싣는다 (2026-11-10).
 *
 * 미니PC 의 `:4000` 은 바깥에서 안 열려서, 길(`/api/sys/heap-who`)만 있으면 **내가
 * 못 본다.** 느릴 때 화면을 열 사람이 옆에 있어야 하는 계기판은 반쪽이다. 파일에
 * 실어 두면 나중에도, 그 자리에 없어도 읽힌다.
 *
 * 1분을 고른 이유: 재시작 **66초**에 RSS 가 1,966MB 였다 — 범인은 그 창 안에서 먹는다.
 */
const AUTO_MS = 60_000;
type Shot = { 찍은시각: string; 사이초: number; 쪼들림: number; 상위: { 곳: string; MB: number }[] };
let 최근: Shot | null = null;

/**
 * **쪼들릴 때 찍힌 것은 따로 들고 있는다** (2026-11-10).
 *
 * `health.json` 은 30초마다 **덮어쓴다.** 최근 1분만 들고 있으면 밤새 돌려도 아침에
 * 남는 건 「새벽 네 시의 한가한 1분」뿐이다 — 범인은 느릴 때 먹는데 그 장면이 안 남는다.
 *
 * 그래서 ① 가장 쪼들렸던 순간의 한 장을 **갈아타며 보관**하고, ② 문턱을 넘은 장면은
 * `lifecycle.log` 에도 적는다(덧붙이는 파일이라 지워지지 않는다).
 */
let 최악: Shot | null = null;
/** 이 위로 올라갔을 때만 남긴다 — 경계(0.65)보다 조금 낮게 잡아 올라가는 길을 잡는다 */
const NOTE_AT = 0.6;
let lastNote = 0;

/** `health.json` 이 읽어 간다 — 동기라 파일 쓰는 길을 안 막는다 */
export function heapWhoRecent(): { 최근: Shot | null; 가장쪼들릴때: Shot | null } {
  return { 최근, 가장쪼들릴때: 최악 };
}

export function startHeapWho(): void {
  if (on) return;
  try {
    session = new Session();
    session.connect();
    session.post("HeapProfiler.startSampling", { samplingInterval: SAMPLE_BYTES });
    on = true;
    noteLife("START", `할당 추적 시작 — ${Math.round(SAMPLE_BYTES / 1024)}KB 마다 한 점 (GET /api/sys/heap-who)`);
    /* 첫 점은 기준이라 상위가 안 나온다 — 두 번째부터 「그사이」가 선다 */
    setInterval(() => {
      void (async () => {
        try {
          const 이전시각 = prevAt;
          const now = await snapshot();
          const 사이 = new Map<string, number>();
          if (prev) for (const [k, v] of now) { const was = prev.get(k) ?? 0; if (v > was) 사이.set(k, v - was); }
          prev = now;
          prevAt = Date.now();
          if (이전시각 > 0) {
            const p = pressure();
            const shot: Shot = {
              찍은시각: new Date().toISOString(),
              사이초: Math.round((Date.now() - 이전시각) / 1000),
              쪼들림: Math.round(p.비율 * 100),
              상위: top(사이, 10),
            };
            최근 = shot;
            /* 가장 쪼들렸던 한 장을 갈아타며 들고 있는다 — 덮어쓰기에 안 지워진다 */
            if (!최악 || shot.쪼들림 > 최악.쪼들림) 최악 = shot;
            /*
             * 문턱을 넘었으면 로그에도 적는다. `health.json` 은 덮어쓰지만 로그는
             * 덧붙이는 파일이라 **아침에 밤새 기록이 그대로 있다.**
             */
            if (p.비율 >= NOTE_AT && Date.now() - lastNote > 5 * 60_000) {
              lastNote = Date.now();
              const 줄 = shot.상위
                .slice(0, 5)
                .map((r) => `${r.MB}MB ${r.곳}`)
                .join(" · ");
              noteLife(
                "WARN",
                `쪼들림 ${shot.쪼들림}% (${p.무엇}, 남은 램 ${p.남은램MB}MB) — 지난 ${shot.사이초}초 할당: ${줄 || "(점이 없다)"}`,
              );
            }
          }
        } catch {
          /* 한 번 못 찍어도 다음 분에 또 찍는다 */
        }
      })();
    }, AUTO_MS).unref?.();
  } catch (e) {
    /* 못 켜도 서버는 돈다 — 계기판 하나 없는 것과 서버가 안 뜨는 것은 다르다 */
    session = null;
    on = false;
    noteLife("WARN", `할당 추적을 못 켰다 — ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * 한 줄을 사람이 읽는 이름으로 — `routes/news.js:235 가져오기` 꼴.
 *
 * 내장 함수(`url` 이 빈 것)는 `null` 이다 — 아래에서 **우리 코드 조상에게 돌린다.**
 */
function label(f: Frame): string | null {
  const url = f.url || "";
  if (!url) return null;
  /* file:///C:/vntg-hts/server/dist/routes/news.js → routes/news.js */
  const m = url.match(/dist[\\/](.+?)(?:\?|$)/);
  const file = m ? m[1].replace(/\\/g, "/") : url.replace(/^.*[\\/]/, "");
  if (!file) return null;
  const fn = f.functionName || "(이름 없음)";
  /* lineNumber 는 0부터다 — 편집기와 맞추려고 1을 더한다 */
  return `${file}:${f.lineNumber + 1} ${fn}`;
}

/**
 * **내장 함수는 부른 쪽에 달아 준다** (실측에서 배웠다 — 2026-11-10).
 *
 * 처음엔 프레임마다 그대로 적었더니 1위가 `repeat`, 3위가 `push` 였다. 문자열을 늘린
 * 것도 배열에 넣은 것도 **우리 코드가 시킨 일**이라, 그 이름만 봐선 어디를 고칠지
 * 알 수 없다. `url` 이 없는 프레임의 할당은 **가장 가까운 우리 코드 조상**에게 돌린다.
 */
function flatten(node: ProfileNode, into: Map<string, number>, owner: string | null): void {
  const mine = label(node.callFrame) ?? owner;
  if (node.selfSize > 0) {
    const k = mine ?? "(내장 · 부른 곳 모름)";
    into.set(k, (into.get(k) ?? 0) + node.selfSize);
  }
  for (const c of node.children ?? []) flatten(c, into, mine);
}

function snapshot(): Promise<Map<string, number>> {
  return new Promise((resolve, reject) => {
    if (!session || !on) {
      reject(new Error("할당 추적이 꺼져 있다"));
      return;
    }
    session.post("HeapProfiler.getSamplingProfile", (err, params) => {
      if (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      const head = (params as { profile?: { head?: ProfileNode } } | undefined)?.profile?.head;
      if (!head) {
        reject(new Error("프로파일이 비었다"));
        return;
      }
      const out = new Map<string, number>();
      flatten(head, out, null);
      resolve(out);
    });
  });
}

function top(m: Map<string, number>, n: number): { 곳: string; MB: number }[] {
  return [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([곳, bytes]) => ({ 곳, MB: Math.round((bytes / 1048576) * 10) / 10 }))
    .filter((r) => r.MB > 0);
}

/**
 * 상위 할당 지점. `누적` 은 뜬 뒤로 전부, `그사이` 는 **지난번 호출 이후**다.
 *
 * 느릴 때 **두 번** 부른다 — 두 번째의 `그사이` 가 지금 먹고 있는 자다.
 */
export async function heapWho(n = 15): Promise<{
  켜짐: boolean;
  누적: { 곳: string; MB: number }[];
  누적합MB: number;
  그사이?: { 곳: string; MB: number }[];
  그사이초?: number;
  안내: string;
}> {
  if (!on) {
    return { 켜짐: false, 누적: [], 누적합MB: 0, 안내: "할당 추적이 꺼져 있습니다(인스펙터를 못 열었습니다)." };
  }
  const now = await snapshot();
  const 누적합MB = Math.round([...now.values()].reduce((a, b) => a + b, 0) / 1048576);

  let 그사이: { 곳: string; MB: number }[] | undefined;
  let 그사이초: number | undefined;
  if (prev) {
    const d = new Map<string, number>();
    for (const [k, v] of now) {
      const was = prev.get(k) ?? 0;
      if (v > was) d.set(k, v - was);
    }
    그사이 = top(d, n);
    그사이초 = Math.round((Date.now() - prevAt) / 1000);
  }
  prev = now;
  prevAt = Date.now();

  return {
    켜짐: true,
    누적: top(now, n),
    누적합MB,
    그사이,
    그사이초,
    안내:
      그사이 === undefined
        ? "누적만 있습니다 — 느릴 때 한 번 더 부르면 「그사이」가 나옵니다."
        : `지난 호출 뒤 ${그사이초}초 동안의 할당입니다. 들고 있는 양이 아니라 할당한 양입니다.`,
  };
}
