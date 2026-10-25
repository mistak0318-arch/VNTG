import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { KiwoomClient } from "./kiwoomClient.js";
import { runAutoPresets } from "./condAuto.js";
import { loadStockMarks } from "./stockMarks.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * **조건식 자동 실행 설정** (2026-10-26 — 벤티지: "조건검색식에 이거 걸어놓은거 정규장
 * 끝나면 한바퀴 돌아서 나한테 한번 오게 하자 … 이거 설정창에 설정할 수 있게 좀 해주고
 * 어느방에 보내는 지 언제 돌릴지 이런것들").
 *
 * 돌리는 일 자체는 `condAuto.ts` 가 2026-09-16 부터 하고 있었다. 없던 것은 **켜고 끄는
 * 손잡이와 시각**이다 — 지금까지는 마감 정리 파이프라인에 박혀 있어 끌 수가 없었다.
 *
 * ## 언제 돌리나
 *
 *   pipeline  마감 정리가 **마크를 만든 바로 다음**(기본). 실제로는 16시 조금 넘는다.
 *   fixed     정한 시각에 **따로** 돈다.
 *
 * ⚠️ **15:40 은 안 된다.** 조건식은 전종목 마크를 쓰고, 마크는 오늘 일봉·원장이 채워진
 * 뒤에야 나온다. 일봉 수집을 15:40 에 시작하는 것은 9월에 이미 해 보고 물린 길이다 —
 * 꼬리가 16:00 을 넘어 **앞쪽 종목은 정규장 종가, 뒤쪽은 애프터 섞인 값**이 된다
 * (`afterClose.ts` 머리말). 그래서 `fixed` 를 골라도 마크가 오늘 것이 아니면 돌지 않고,
 * 「마크가 오늘 것이 아니라 안 돌림」이라고 적는다. 조용히 건너뛰지 않는다.
 *
 * ## 어느 방으로 보내나
 *
 * 여기서 정하지 않는다. `sendTelegram(…, "signal")` 이고 **「signal」 채널에 어느 방을
 * 붙일지는 텔레그램 동향 화면이 이미 맡고 있다**(`telegramRooms.assignedChatId`).
 * 같은 것을 두 군데서 고르게 하면 어느 쪽이 이기는지 매번 헷갈린다 — 설정 화면은 그
 * 자리를 **가리키기만** 한다.
 */

const FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "condAutoConfig.json");

export interface CondAutoConfig {
  /** 꺼 두면 파이프라인에서도 안 돈다 */
  enabled: boolean;
  /** pipeline = 마감 정리 안에서 · fixed = 정한 시각에 따로 */
  mode: "pipeline" | "fixed";
  /** mode 가 fixed 일 때만 쓴다 (KST) */
  hour: number;
  minute: number;
}

const DEFAULT: CondAutoConfig = { enabled: true, mode: "pipeline", hour: 16, minute: 30 };

let cache: CondAutoConfig | null = null;

export async function getCondAutoConfig(): Promise<CondAutoConfig> {
  if (cache) return cache;
  try {
    const raw = JSON.parse(await readFile(FILE, "utf-8")) as Partial<CondAutoConfig>;
    cache = {
      enabled: raw.enabled !== false,
      mode: raw.mode === "fixed" ? "fixed" : "pipeline",
      /* 바깥에서 온 값은 범위를 믿지 않는다 — 25시에 깨우면 영영 안 깨어난다 */
      hour: Number.isInteger(raw.hour) && raw.hour! >= 0 && raw.hour! <= 23 ? raw.hour! : DEFAULT.hour,
      minute: Number.isInteger(raw.minute) && raw.minute! >= 0 && raw.minute! <= 59 ? raw.minute! : DEFAULT.minute,
    };
  } catch {
    cache = { ...DEFAULT };
  }
  return cache;
}

export async function saveCondAutoConfig(next: Partial<CondAutoConfig>): Promise<CondAutoConfig> {
  const cur = await getCondAutoConfig();
  const merged: CondAutoConfig = {
    enabled: typeof next.enabled === "boolean" ? next.enabled : cur.enabled,
    mode: next.mode === "fixed" || next.mode === "pipeline" ? next.mode : cur.mode,
    hour: Number.isInteger(next.hour) && next.hour! >= 0 && next.hour! <= 23 ? next.hour! : cur.hour,
    minute: Number.isInteger(next.minute) && next.minute! >= 0 && next.minute! <= 59 ? next.minute! : cur.minute,
  };
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(merged, null, 1), "utf-8");
  cache = merged;
  return merged;
}

/**
 * **`fixed` 모드 스케줄러** — 정한 시각에 따로 돌린다.
 *
 * 1분마다 깨어나 「지금이 그 시각인가 · 오늘 아직 안 돌렸나」만 본다. 설정을 바꾸면
 * 다음 분에 바로 반영된다 — 서버를 다시 띄우지 않아도 된다.
 *
 * ⚠️ **주말·공휴일에는 안 돈다.** 마크가 어제 것이라 어차피 건너뛰지만, 그러면 「오늘
 * 안 돌렸다」 표시가 안 서서 **1분마다 다시 시도한다.** 날짜로 한 번 막는다.
 */
let lastRunDay = "";

export function startCondAutoScheduler(client: KiwoomClient): void {
  const tick = async () => {
    try {
      const cfg = await getCondAutoConfig();
      if (!cfg.enabled || cfg.mode !== "fixed") return;
      const now = new Date(Date.now() + 9 * 3600_000); // KST
      const day = now.toISOString().slice(0, 10);
      if (lastRunDay === day) return;
      const dow = now.getUTCDay();
      if (dow === 0 || dow === 6) return; // 주말
      if (now.getUTCHours() !== cfg.hour || now.getUTCMinutes() < cfg.minute) return;
      /* 시각을 지나쳐도 그날 안 돌았으면 돈다 — 서버가 그 1분에 바빠 놓쳤을 수 있다 */
      lastRunDay = day;
      const f = await loadStockMarks();
      const r = await runAutoPresets(client, f?.day ?? "");
      console.log(
        `[condAuto] ${cfg.hour}:${String(cfg.minute).padStart(2, "0")} 따로 실행 — ${r.ran}식` +
          (r.skipped.length > 0 ? ` · 건너뜀 ${r.skipped[0]}` : ""),
      );
    } catch (e) {
      console.error("[condAuto] 스케줄 실패 —", e instanceof Error ? e.message : e);
    }
  };
  setInterval(() => void tick(), 60_000);
}
