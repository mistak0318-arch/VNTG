import { mkdir, readFile, readdir, stat, unlink, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChannelMessage } from "./telegramReader.js";

/**
 * 채널 글 **창고** — 한 달치를 계속 쌓아 둔다 (2026-09-05).
 *
 * 벤티지: "3일치에 대해서는 미리 수집하고 있으면 어때? 백그라운드에서 계속 수집하고
 * 있으면? 어차피 검색도 3일치가 맥스인데. 텍스트라 용량도 괜찮지 않겠어?" →
 * "계속 스크리닝하다가 막히는 것보다도 계속 수집을 하면 한 번에 여러 개 안 훑어도 되잖아" →
 * "한 달치로 하자."
 *
 * ## 매듭이 어디였나
 *
 * 검색이 얕았던 이유는 **그때그때 텔레그램을 훑었기** 때문이다. 채널이 일흔 곳이라 한 번
 * 도는 데 한참 걸리고, FLOOD_WAIT 이 무서워 채널당 가져오는 수에 상한을 둘 수밖에 없다.
 * 그 상한이 곧 **볼 수 있는 구간의 한계**가 됐다 — 「3일」을 골라도 몇 시간치만 봤다.
 *
 * 벤티지 말이 맞다. **한 번에 크게 훑지 말고 조금씩 늘 훑으면** 상한이 걸릴 일이 없다.
 * 10분마다 최근 것만 받아 창고에 붙이면, 창고는 저절로 한 달치가 되고 검색은 파일만 읽는다.
 *
 *   · 검색은 **텔레그램 호출이 0** 이다. 구간을 한 달로 넓혀도 공짜다
 *   · 한 번에 훑는 양이 작아 FLOOD_WAIT 을 안 부른다
 *   · 이미 훑던 것을 **버리지 않는 것**이라 조회가 크게 늘지 않는다
 *
 * ## 부피 — 한 달이면
 *
 * 채널 71곳 × 하루 4천 건 안팎 × 30일 ≈ **12만 건**, 메타 포함 한 건 900바이트면
 * **108MB**. 같은 서버의 일봉 창고가 86MB 라 디스크는 문제가 아니다.
 *
 * ## 그런데 **속도**는 문제다 — 그래서 파싱 전에 거른다
 *
 * 12만 줄을 매번 `JSON.parse` 하면 몇 초씩 걸린다. 그러면 창고를 둔 뜻이 없다.
 * 그래서 검색은 **날것 줄에서 낱말을 먼저 찾고**, 걸린 줄만 파싱한다.
 * 문자열 훑기는 12만 줄이라도 수십 밀리초고, 파싱은 대개 수십 건에만 든다.
 *
 * ⚠️ 한글은 JSON 에서 이스케이프되지 않으므로(따옴표·역슬래시·제어문자만 바뀐다)
 * 날것 줄에 「로보티즈」가 그대로 들어 있다. 다만 **자모가 풀린 형태(NFD)로 저장된 글**도
 * 있을 수 있어, 거를 때는 완성형과 풀린 형태를 **둘 다** 본다. 최종 판정은 파싱 뒤에
 * 정규화해서 한다 — 거르개는 놓치지만 않으면 되고, 정확도는 뒤에서 잡는다.
 *
 * ## 모양
 *
 * 날짜별 JSONL. 붙이기만 하면 되고, 지울 때는 파일째 지운다 — 큰 JSON 하나로 두면
 * 쓸 때마다 통째로 다시 써야 하고 그러다 죽으면 그날 것을 다 잃는다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DIR = join(here, "..", "data", "channelStore");

/** 며칠치를 들고 있나 — 검색의 최대 구간이 한 달이라 하루를 더 얹는다 */
export const KEEP_DAYS = 31;

/**
 * 창고 전체 상한(바이트). 넘으면 **오래된 날부터** 지운다.
 *
 * 날 수로만 자르면 채널이 늘거나 어느 채널이 폭주한 달에 디스크가 조용히 커진다.
 * 250MB 는 예상(108MB)의 두 배 남짓이라, 평소엔 안 걸리고 이상할 때만 걸린다.
 */
const MAX_TOTAL_BYTES = 250 * 1024 * 1024;

/**
 * **이번 프로세스에서 이미 넣은 것** — 같은 글을 두 번 안 적는다.
 *
 * 여러 곳이 겹쳐 훑으므로 중복이 많이 들어온다. 파일을 읽어 견주면 비싸니 기억에 둔다.
 * 재시작하면 비지만, 그때 몇 건 겹쳐 적히는 것은 **읽을 때** 걸러진다.
 */
const seen = new Set<string>();
const SEEN_MAX = 300_000;

const dayOf = (iso: string) => iso.slice(0, 10);
const fileOf = (day: string) => join(DIR, `${day}.jsonl`);

function recentDays(days: number): string[] {
  const out: string[] = [];
  const now = Date.now();
  for (let i = 0; i < days; i += 1) out.push(new Date(now - i * 86400_000).toISOString().slice(0, 10));
  return out;
}

/**
 * 받은 글을 창고에 넣는다. **실패해도 조용히 넘어간다** — 수집이 본업을 막으면 안 된다.
 *
 * 부르는 쪽이 창을 거르기 **전에** 넘겨야 한다. 창에 걸려 버려질 글도 창고에는 있어야
 * 나중에 더 넓은 구간으로 찾을 수 있다.
 */
export async function record(rows: ChannelMessage[]): Promise<number> {
  if (rows.length === 0) return 0;
  const byDay = new Map<string, string[]>();
  let added = 0;

  for (const r of rows) {
    const key = `${r.channelId}:${r.messageId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const day = dayOf(r.at);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    added += 1;
    const arr = byDay.get(day) ?? [];
    arr.push(JSON.stringify(r));
    byDay.set(day, arr);
  }
  if (added === 0) return 0;
  if (seen.size > SEEN_MAX) seen.clear();

  try {
    await mkdir(DIR, { recursive: true });
    for (const [day, lines] of byDay) {
      await appendFile(fileOf(day), lines.join("\n") + "\n", "utf8");
    }
  } catch {
    /* 못 적어도 이번 조회는 그대로 쓰인다 */
  }
  return added;
}

/** 날것 줄에서 걸러 낼 때 쓸 조각들 — 완성형과 풀린 형태 둘 다 */
function needles(words: string[]): string[][] {
  return words.map((w) => {
    const a = w.normalize("NFC").toLowerCase();
    const b = w.normalize("NFD").toLowerCase();
    return a === b ? [a] : [a, b];
  });
}

export interface StoreHit extends ChannelMessage {
  matched: string[];
}

export interface StoreSearch {
  hits: StoreHit[];
  /** 훑은 줄 수 — 「원문 몇 건 중」의 그 수 */
  scanned: number;
  /** 창고가 닿는 가장 오래된 글 · 가장 최근 글 */
  oldest: string | null;
  newest: string | null;
}

/**
 * 창고에서 **최근 `minutes` 분** 안의 글 중 낱말이 걸린 것을 찾는다.
 *
 * 하나라도 들어 있으면 걸린다(OR) — 종목은 이름 하나로 안 잡힌다.
 */
export async function search(words: string[], minutes: number): Promise<StoreSearch> {
  const cutoff = Date.now() - minutes * 60_000;
  const cutDay = new Date(cutoff).toISOString().slice(0, 10);
  const forms = needles(words);
  const byKey = new Map<string, StoreHit>();
  let scanned = 0;
  let oldest: string | null = null;
  let newest: string | null = null;

  for (const day of recentDays(KEEP_DAYS)) {
    /* 구간 밖의 날은 파일을 열지도 않는다 — 하루 검색이 한 달 창고를 다 읽으면 안 된다 */
    if (day < cutDay) break;
    let raw: string;
    try {
      raw = await readFile(fileOf(day), "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (!line) continue;
      scanned += 1;
      const low = line.toLowerCase();
      /* ① 날것에서 먼저 거른다 — 여기서 대부분이 떨어지고 파싱까지 안 간다 */
      if (!forms.some((fs) => fs.some((f) => low.includes(f)))) continue;

      let m: ChannelMessage;
      try {
        m = JSON.parse(line) as ChannelMessage;
      } catch {
        continue; // 쓰다 만 줄 하나가 그날치를 못 버리게 한다
      }
      if (!m || !m.at || typeof m.text !== "string") continue;
      if (new Date(m.at).getTime() < cutoff) continue;

      /* ② 진짜 판정은 정규화한 본문으로 — 거르개는 「채널 이름에 걸린 것」도 통과시킨다 */
      const text = m.text.normalize("NFC").toLowerCase();
      const matched = words.filter((w) => text.includes(w.normalize("NFC").toLowerCase()));
      if (matched.length === 0) continue;

      byKey.set(`${m.channelId}:${m.messageId}`, { ...m, matched });
      if (!oldest || m.at < oldest) oldest = m.at;
      if (!newest || m.at > newest) newest = m.at;
    }
  }

  const hits = [...byKey.values()].sort((a, b) => b.at.localeCompare(a.at));
  return { hits, scanned, oldest, newest };
}

/** 창고가 실제로 어디까지 닿나 — 검색이 「이만큼 봤다」를 말할 때 쓴다 */
export async function coverage(): Promise<{ oldest: string | null; newest: string | null; lines: number }> {
  let oldest: string | null = null;
  let newest: string | null = null;
  let lines = 0;
  for (const day of recentDays(KEEP_DAYS)) {
    let raw: string;
    try {
      raw = await readFile(fileOf(day), "utf8");
    } catch {
      continue;
    }
    /*
     * 전부 파싱하지 않는다 — `at` 만 정규식으로 뽑는다. 한 달치를 파싱하면 몇 초다.
     * 첫 줄과 끝 줄만 봐도 되지만, 파일 안이 시간순이라는 보장이 없어 다 훑되 싸게 훑는다.
     */
    for (const line of raw.split("\n")) {
      if (!line) continue;
      lines += 1;
      const at = /"at":"([^"]+)"/.exec(line)?.[1];
      if (!at) continue;
      if (!oldest || at < oldest) oldest = at;
      if (!newest || at > newest) newest = at;
    }
  }
  return { oldest, newest, lines };
}

/**
 * 오래된 날 파일을 지운다 — 날 수로 한 번, **전체 크기**로 한 번 더.
 * 크기로도 자르는 이유는 위 `MAX_TOTAL_BYTES` 주석에.
 */
export async function prune(): Promise<{ byDays: number; bySize: number }> {
  const keep = new Set(recentDays(KEEP_DAYS));
  let byDays = 0;
  let bySize = 0;
  let files: string[] = [];
  try {
    files = await readdir(DIR);
  } catch {
    return { byDays, bySize };
  }

  const alive: { day: string; path: string; bytes: number }[] = [];
  for (const fn of files) {
    const m = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(fn);
    if (!m) continue;
    const path = join(DIR, fn);
    if (!keep.has(m[1])) {
      await unlink(path).catch(() => undefined);
      byDays += 1;
      continue;
    }
    const bytes = await stat(path).then((st) => st.size).catch(() => 0);
    alive.push({ day: m[1], path, bytes });
  }

  let total = alive.reduce((s, f) => s + f.bytes, 0);
  alive.sort((a, b) => a.day.localeCompare(b.day)); // 오래된 것부터
  for (const f of alive) {
    if (total <= MAX_TOTAL_BYTES) break;
    await unlink(f.path).catch(() => undefined);
    total -= f.bytes;
    bySize += 1;
  }
  return { byDays, bySize };
}

/** 화면·점검용 */
export async function status(): Promise<{
  days: { day: string; bytes: number; lines: number }[];
  totalLines: number;
  totalBytes: number;
  oldest: string | null;
  newest: string | null;
  keepDays: number;
}> {
  const days: { day: string; bytes: number; lines: number }[] = [];
  let oldest: string | null = null;
  let newest: string | null = null;
  for (const day of recentDays(KEEP_DAYS)) {
    try {
      const raw = await readFile(fileOf(day), "utf8");
      const lines = raw.split("\n").filter(Boolean);
      days.push({ day, bytes: Buffer.byteLength(raw, "utf8"), lines: lines.length });
      for (const l of lines) {
        const at = /"at":"([^"]+)"/.exec(l)?.[1];
        if (!at) continue;
        if (!oldest || at < oldest) oldest = at;
        if (!newest || at > newest) newest = at;
      }
    } catch {
      /* 없는 날 */
    }
  }
  return {
    days,
    totalLines: days.reduce((s, d) => s + d.lines, 0),
    totalBytes: days.reduce((s, d) => s + d.bytes, 0),
    oldest,
    newest,
    keepDays: KEEP_DAYS,
  };
}
