import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { peekRealtime } from "./realtimeHub.js";

/**
 * **경보가 울리는 그 순간을 찍어 둔다** (2026-10-15).
 *
 * 사이드카·서킷브레이커는 결국 **뉴스 속보**로 받기로 했다 — 오늘 09:15 발동 때
 * `0s`(장운영구분)에는 줄이 하나도 안 왔기 때문이다(`marketHaltAlert` 머리글).
 * 뉴스는 발동과 거의 같은 순간에 들어왔지만(09:05:12), 그래도 **1~3분 늦을 수 있는
 * 길**이다. 더 빠른 길이 있나는 아직 열린 질문이다.
 *
 * 그 질문은 **다음 발동 때만** 답할 수 있다. 사람이 그 순간에 깨어 있어야 한다면
 * 영영 못 잰다 — 오늘도 09:15 에 벤티지가 폰을 보고 있었기에 알았다.
 *
 * 그래서 **뉴스 경보 자체를 방아쇠로 쓴다.** 알림이 나가는 그 순간,
 *
 *   ① `0g`(시장조치) 프레임이 와 있나 — 어느 FID 가 와 있는지 번호만
 *   ② 네이버 지수 페이지에 「사이드카」·「서킷」 글자가 떠 있나 — 그 자리 둘레 글자만
 *
 * 둘을 파일 한 줄로 남긴다. 다음 발동 뒤에 이 줄을 읽으면 **추측 없이** 알 수 있다 —
 * 어느 쪽이 떠 있었으면 그게 더 빠른 길이고, 둘 다 비었으면 뉴스가 최선이다.
 *
 * ## ⚠️ 재는 일이 알림을 막으면 안 된다
 *
 * 알림은 이미 나간 **뒤에** 부른다. 네이버가 느리거나 막혀도 경보는 제때 울린다.
 * 여기서 던지는 것은 전부 삼킨다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const FILE = join(here, "..", "data", "haltProbe.jsonl");
const NAVER = "https://finance.naver.com/sise/sise_index.naver?code=KOSPI";

let last: Record<string, unknown> | null = null;

export async function probeHaltSources(event: string): Promise<void> {
  const row: Record<string, unknown> = {
    at: new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 19),
    event,
  };
  /* ① 0g — 걸어 둔 다섯 종목 중 프레임이 온 것이 있나 (번호만, 종목은 안 적는다) */
  try {
    const { store } = peekRealtime();
    row["0g"] = store ? store.surveyFids("0g") : null;
  } catch {
    row["0g"] = "못읽음";
  }
  /* ② 네이버 지수 페이지에 글자가 떠 있나 */
  try {
    const res = await fetch(NAVER, { headers: { "User-Agent": "Mozilla/5.0" } });
    const html = await res.text();
    const hits: string[] = [];
    for (const m of html.matchAll(/(사이드카|서킷\s*브레이커|매매거래\s*중단)/g)) {
      const i = m.index ?? 0;
      hits.push(html.slice(Math.max(0, i - 40), i + 60).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
      if (hits.length >= 3) break;
    }
    row["네이버"] = { 글자수: html.length, 걸림: hits.length, 둘레: hits };
  } catch (e) {
    row["네이버"] = `못읽음: ${e instanceof Error ? e.message.slice(0, 60) : ""}`;
  }
  last = row;
  try {
    await mkdir(dirname(FILE), { recursive: true });
    await appendFile(FILE, JSON.stringify(row) + "\n", "utf8");
  } catch {
    /* 못 적어도 아래 메모리 한 줄은 남는다 */
  }
}

/** health.json 「경보관측」 — 마지막으로 찍은 한 줄. 없으면 파일의 마지막 줄 */
export async function haltProbeSnapshot(): Promise<unknown> {
  if (last) return last;
  try {
    const lines = (await readFile(FILE, "utf8")).split("\n").filter(Boolean);
    return lines.length > 0 ? JSON.parse(lines[lines.length - 1]) : null;
  } catch {
    return null;
  }
}
