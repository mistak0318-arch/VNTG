import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * **애프터마켓 관측창** (2026-09-14 — KRX 애프터마켓 첫날).
 *
 * 벤티지와 16:00 에 같이 보기로 했는데 **밖에서는 들여다볼 길이 없었다.** 미니PC 서버는
 * 127.0.0.1 에만 붙어 있고 바깥 주소는 Cloudflare 로그인 뒤다. 공유 폴더의 `health.json`
 * 하나가 유일한 창이다 — 그래서 **거기에 숫자를 찍는다.**
 *
 * 답해야 하는 것 넷 (docs/다음작업_TODO.md 맨 위):
 *   ① 애프터 체결이 `0B` 로 오나                → 16:00 뒤 0B 프레임 수
 *   ② `9081` 이 애프터 체결에 무엇을 뱉나        → 거래소 값별 프레임 수 (KRX/NXT/그 밖)
 *      같이 FID 290(장구분)에 무슨 값이 오나      → 값 종류와 개수
 *   ③ VI(`1h`)가 애프터에도 오나                  → 16:00 뒤 1h 프레임 수
 *   ④ `0s` 장운영구분의 새 코드                   → FID 215 값 종류와 처음 본 시각
 * 그리고 오늘 밤 20:10 일봉이 기대는 것:
 *   ⑤ 15:40 정규장 종가 파일이 생겼나            → 있음/없음과 크기
 *
 * ## 이 파일에 싣지 않는 것
 *
 * `health.json` 에는 **계좌·잔고·종목·키가 실리면 안 된다**(벤티지와 한 약속). 그래서 여기엔
 * **종목코드를 한 글자도 안 남긴다** — 거래소 이름·장구분 코드 같은 **분류 값과 개수**만 센다.
 *
 * 프레임마다 불리는 자리라 셈은 O(1) 이고, 값 종류는 열 개에서 끊는다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const RC_DIR = join(here, "..", "data", "regularCloses");

type Window = "15:30~16:00" | "16:00~20:00" | "그 밖";

interface Counts {
  frames0B: number;
  byVenue: Record<string, number>;
  fid290: Record<string, number>;
  vi: number;
}

function empty(): Counts {
  return { frames0B: 0, byVenue: {}, fid290: {}, vi: 0 };
}

let day = "";
let win: Record<Window, Counts> = { "15:30~16:00": empty(), "16:00~20:00": empty(), "그 밖": empty() };
/** 0s 장운영구분 — 값마다 처음 본 시각(KST HH:MM) */
let phases: Record<string, string> = {};
let lastAt = "";

function kst(): { date: string; min: number; hhmm: string } {
  const d = new Date(Date.now() + 9 * 3600_000);
  const iso = d.toISOString();
  return { date: iso.slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes(), hhmm: iso.slice(11, 16) };
}

function bump(map: Record<string, number>, key: string): void {
  if (key in map) map[key] += 1;
  else if (Object.keys(map).length < 10) map[key] = 1;
  else map["(그 밖)"] = (map["(그 밖)"] ?? 0) + 1;
}

/** 실시간 프레임 하나. 종목코드는 받지 않는다 — 받을 이유가 없게 인자에서 뺐다 */
export function noteFrame(type: string, values: Record<string, string>): void {
  const t = kst();
  if (t.date !== day) {
    day = t.date;
    win = { "15:30~16:00": empty(), "16:00~20:00": empty(), "그 밖": empty() };
    phases = {};
  }
  lastAt = t.hhmm;
  const w: Window = t.min >= 930 && t.min < 960 ? "15:30~16:00" : t.min >= 960 && t.min < 1200 ? "16:00~20:00" : "그 밖";

  if (type === "0B") {
    const c = win[w];
    c.frames0B += 1;
    bump(c.byVenue, String(values["9081"] ?? "").trim().toUpperCase() || "(빈 값)");
    bump(c.fid290, String(values["290"] ?? "").trim() || "(빈 값)");
  } else if (type === "1h") {
    win[w].vi += 1;
  } else if (type === "0s") {
    const code = String(values["215"] ?? "").trim() || "(빈 값)";
    if (!(code in phases) && Object.keys(phases).length < 12) phases[code] = t.hhmm;
  }
}

/** health.json 에 실을 한 덩어리 */
export async function afterProbeSnapshot(): Promise<Record<string, unknown>> {
  const today = kst().date;
  let rc: { 있음: boolean; 크기?: number; 시각?: string } = { 있음: false };
  try {
    const st = await stat(join(RC_DIR, `${today}.json`));
    rc = { 있음: true, 크기: st.size, 시각: new Date(st.mtimeMs + 9 * 3600_000).toISOString().slice(11, 16) };
  } catch {
    /* 없으면 없는 것이다 */
  }
  return {
    day,
    마지막프레임: lastAt,
    "15:30~16:00": win["15:30~16:00"],
    "16:00~20:00": win["16:00~20:00"],
    장운영구분_처음본시각: phases,
    정규장종가파일: rc,
  };
}
