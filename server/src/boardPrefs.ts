import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = resolve(__dirname, "..", "data", "boardPrefs.json");

/**
 * 보드 화면 구성 — **서버에 둔다.**
 *
 * ## 왜 옮겼나 (2026-08-22)
 *
 * `localStorage` 에 두고 있었는데, 보드는 **창을 여러 개 띄우는 화면**이다.
 * 그런데 localStorage 는 **창끼리 공유**된다 — 창 A 에서 K1 을 불러오면 그 배치가 저장되고,
 * 창 B 에서 K2 를 불러오면 그걸 덮어쓴다. 서로 리셋시키고 있었다.
 * 모니터 세 대에 각각 다른 구성을 띄우려고 만든 기능인데 **그 쓰임 자체가 깨져 있었다.**
 *
 * 게다가 기기마다 따로라 미니PC 에서 짜 둔 구성이 폰에는 없었다. 메뉴 설정에서
 * 이미 겪고 서버로 옮긴 일이다(`menuPrefs.ts`) — 같은 이유, 같은 답.
 *
 * ## 무엇을 서버에 두고 무엇을 창에 두나
 *
 *   **서버(여기)** — 구성 목록. 「K1 은 무슨 칸들로 이루어졌나」
 *   **창(sessionStorage)** — 지금 이 창이 어느 구성을 보고 있나
 *
 * 이렇게 갈라야 창마다 다른 구성을 띄울 수 있다. 구성을 고치면 모든 창·기기에 반영되고,
 * 지금 보고 있는 것은 창마다 따로 논다. **둘을 한 곳에 두면 반드시 서로 덮어쓴다.**
 */

export interface BoardPreset {
  id: string;
  name: string;
  /** 켜 둔 칸들 — 순서가 곧 배치 순서 */
  pick: string[];
  /** 칸별 크기 */
  sizes: Record<string, { w: number; h: number }>;
  /** 맨 앞에 고정한 칸 */
  pins: string[];
  /** 칸마다 붙들어 둔 종목 */
  locks: Record<string, { code: string; name: string }>;
  /**
   * 잠갔나 — 이름·순서·삭제·덮어쓰기가 막힌다.
   *
   * 배치를 헤집다가 **돌아올 자리**가 필요해서 있는 것이다. 무엇을 잠글지는 쓰는 사람이
   * 정한다 — 예전엔 우리가 지은 구성 셋을 코드에 박아 뒀는데 정작 안 쓰였다.
   */
  locked?: boolean;
}

export interface BoardPrefs {
  presets: BoardPreset[];
}

export const EMPTY_BOARD_PREFS: BoardPrefs = { presets: [] };

/** 화면이 보낸 것을 그대로 믿지 않는다 — 모양만 맞춰 받는다 */
function clean(raw: unknown): BoardPrefs {
  const r = (raw ?? {}) as Partial<BoardPrefs>;
  const list = Array.isArray(r.presets) ? r.presets : [];
  const presets: BoardPreset[] = [];
  for (const p of list) {
    const o = (p ?? {}) as Partial<BoardPreset>;
    if (typeof o.id !== "string" || !o.id) continue;

    const sizes: BoardPreset["sizes"] = {};
    if (o.sizes && typeof o.sizes === "object") {
      for (const [k, v] of Object.entries(o.sizes as Record<string, unknown>)) {
        const s = v as { w?: unknown; h?: unknown };
        const w = Number(s?.w);
        const h = Number(s?.h);
        if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) sizes[k] = { w, h };
      }
    }

    const locks: BoardPreset["locks"] = {};
    if (o.locks && typeof o.locks === "object") {
      for (const [k, v] of Object.entries(o.locks as Record<string, unknown>)) {
        const l = v as { code?: unknown; name?: unknown };
        if (typeof l?.code === "string" && l.code) {
          locks[k] = { code: l.code, name: typeof l.name === "string" ? l.name : l.code };
        }
      }
    }

    presets.push({
      id: o.id,
      locked: o.locked === true,
      name: typeof o.name === "string" && o.name ? o.name : o.id,
      pick: Array.isArray(o.pick) ? o.pick.filter((x): x is string => typeof x === "string") : [],
      sizes,
      pins: Array.isArray(o.pins) ? o.pins.filter((x): x is string => typeof x === "string") : [],
      locks,
    });
  }
  return { presets };
}

/**
 * `saved` 를 같이 준다.
 *
 * 예전 구성은 기기의 localStorage 에만 있었다. 서버가 비어 있는 채로 화면이 그걸 받아
 * 덮어쓰면 **짜 두었던 구성이 그 자리에서 사라진다.** 「아직 저장된 적 없음」과
 * 「저장했는데 비어 있음」은 다른 상태라, 화면이 그 둘을 갈라 볼 수 있어야 한다.
 */
export async function getBoardPrefs(): Promise<BoardPrefs & { saved: boolean }> {
  try {
    return { ...clean(JSON.parse(await readFile(FILE, "utf-8"))), saved: true };
  } catch {
    return { ...EMPTY_BOARD_PREFS, saved: false };
  }
}

export async function saveBoardPrefs(input: unknown): Promise<BoardPrefs> {
  const next = clean(input);
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(next, null, 2), "utf-8");
  return next;
}
