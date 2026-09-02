import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AUTO_GROUPS, ETF_GROUP, listWatchlist, removeFromGroup } from "./watchlist.js";
import { configFingerprint } from "./signalLight.js";
import { pushNotice } from "./notifyCenter.js";

/**
 * **원장에 선을 긋는다** (2026-09-01) — 지우는 게 아니라 옮긴다.
 *
 * ## 왜
 *
 * 벤티지: "지금 신호등 체계가 바뀌다 못해 아주 새거다. 지표들도 다 그렇고.
 * 그럼 지금까지 신호등에 들어왔던거 싹 지우고 오늘부터 재수집해서 보는게
 * 의미 있을거 같은데."
 *
 * 실측이 그 말을 그대로 받쳤다. 지금 지문이 `c1lrlc0b` 인데:
 *
 *   슈퍼신호등   29건 — **지금 기준으로 걸린 것 0** (지문 자체가 없는 옛것)
 *   추적기       28건 — 지문 4종이 섞여 있고 지금 것은 0
 *   신호등 분석  15건 — 지문 1종, 지금 것은 0
 *
 * **72건 전부가 다른 규칙으로 걸렸다.** 12일 사이에 기준이 최소 네 번 바뀌었다.
 * 한 표에 섞이면 평균이 뜻을 잃는다 — 그건 `configFingerprint` 를 만든 이유이기도 하다.
 *
 * ## 왜 지우지 않고 옮기나
 *
 * 편입 원장은 **소급이 안 된다.** 오늘 지우면 「옛 기준이 실제로 얼마나 나빴나」를
 * 영영 못 본다 — 새 기준이 낫다는 것을 보일 대조군이 사라진다.
 *
 * 그리고 **또 긋고 싶어질 것이다.** 문턱은 12월까지 안 건드리기로 했지만 버그
 * 수정이나 기준 추가로 지문은 바뀔 수 있다. 지우는 게 습관이 되면 안 되고,
 * 선 긋기는 몇 번이든 그을 수 있어야 한다.
 *
 * 되돌릴 수 있으면 **부담 없이 지금 실행할 수 있다.** 그게 이 방식의 요점이다.
 *
 * ## ⚠️ 건드리지 않는 것
 *
 *   `signalSamples.json`  검증 표본 — **과거 시세로 만든 것이라 기준과 무관하다.**
 *                          기준이 바뀌면 다시 채점하면 그만이고, 지울 이유가 없다
 *   `dailyCloses.json`    일봉 — 소급 불가
 *   `data/daily/*.json`   일별 원장 — 소급 불가. 표본의 재료이고 매일 자라야 한다
 *   복기 노트 · 메모 · 태그 — 사람이 쓴 것이다
 *   **각 원장 파일 안의 `config`** — 무지개 2일·모집단 500 처럼 사람이 맞춰 둔 값이다
 *
 * 소급이 안 되는 데이터를 지우는 것과 다시 만들 수 있는 것을 지우는 것은 전혀
 * 다른 일이다. 이 함수는 **다시 쌓이는 것만** 건드린다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DATA = join(here, "..", "data");

/** 비울 원장 — 파일 하나에 `entries` 배열 하나인 것들 */
const LEDGERS = [
  { file: "superSignal.json", label: "슈퍼신호등" },
  { file: "signalTrack.json", label: "신호등 추적기" },
  { file: "listTrack.json", label: "신호등 분석" },
] as const;

export interface ResetReport {
  at: string;
  /** 그을 때의 기준 지문 — 「여기서부터는 이 기준」 */
  fingerprint: string | null;
  ledgers: { label: string; file: string; moved: number; archive?: string; error?: string }[];
  /** 자동 그룹에서 뺀 종목 수 (그룹별) */
  groups: Record<string, number>;
  totalMoved: number;
}

function stamp(d = new Date()): string {
  const k = new Date(d.getTime() + (9 * 60 + d.getTimezoneOffset()) * 60_000);
  return (
    `${k.getFullYear()}${String(k.getMonth() + 1).padStart(2, "0")}${String(k.getDate()).padStart(2, "0")}` +
    `-${String(k.getHours()).padStart(2, "0")}${String(k.getMinutes()).padStart(2, "0")}`
  );
}

/**
 * 원장 셋과 자동 그룹을 비운다. 옛 내용은 `<이름>.archive-<날짜시각>.json` 으로 남는다.
 *
 * @param dryRun 세어만 보고 손대지 않는다 — 화면이 「무엇이 얼마나 지워지나」를
 *               먼저 보여 줄 수 있어야 사람이 누를지 정한다
 */
export async function resetSignalLedgers(dryRun = false): Promise<ResetReport> {
  const at = new Date().toISOString();
  const tag = stamp();
  const fingerprint = await configFingerprint().catch(() => null);
  const report: ResetReport = { at, fingerprint, ledgers: [], groups: {}, totalMoved: 0 };

  for (const l of LEDGERS) {
    const path = join(DATA, l.file);
    try {
      const raw = await readFile(path, "utf-8");
      const j = JSON.parse(raw) as Record<string, unknown>;
      const entries = Array.isArray(j.entries) ? j.entries : [];
      report.totalMoved += entries.length;

      if (dryRun) {
        report.ledgers.push({ label: l.label, file: l.file, moved: entries.length });
        continue;
      }

      /*
       * ## ⚠️ **설정은 남긴다** — 원장만 비운다
       *
       * 처음엔 파일을 통째로 옮기고 빈 것을 새로 둘 생각이었다. 그런데 이
       * 파일들 안에 **설정이 같이 들어 있다:**
       *
       *   superSignal.json   minLists · rainbowDays · universeSize · maxEval
       *   signalTrack.json   tiers · universe · minTradeValue …
       *
       * 통째로 갈면 벤티지가 방금 손으로 맞춘 무지개 2일·모집단 500 이 날아간다.
       * 그건 「옛 기준의 산물」이 아니라 **지금 쓰려고 정한 값**이다.
       *
       * 그래서 보관본은 **통째로**(그때 상태를 재현할 수 있게), 현재 파일은
       * `entries` 와 `lastRunDate` 만 비운다.
       */
      const archive = `${l.file.replace(/\.json$/, "")}.archive-${tag}.json`;
      await writeFile(join(DATA, archive), raw, "utf-8");
      const kept: Record<string, unknown> = { ...j, entries: [], lastRunDate: null };
      /* 목록별 마지막 집계도 옛 기준 것이다 — 있으면 지운다 */
      delete kept.lastCounts;
      await writeFile(path, JSON.stringify(kept), "utf-8");
      report.ledgers.push({ label: l.label, file: l.file, moved: entries.length, archive });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      /* 아직 없는 원장은 실패가 아니다 — 한 번도 안 돈 것뿐이다 */
      if (code === "ENOENT") {
        report.ledgers.push({ label: l.label, file: l.file, moved: 0 });
        continue;
      }
      report.ledgers.push({
        label: l.label,
        file: l.file,
        moved: 0,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /*
   * ## 자동 그룹도 비운다
   *
   * 원장만 비우고 그룹을 두면 **옛 기준으로 담긴 종목이 관심종목에 그대로 남는다.**
   * 그리고 자동 그룹은 다음 동기화가 「오늘 목록에 없는 종목을 뺀다」로 돌기 때문에,
   * 다음 신호등 분석이 돌 때까지는 아무도 안 치운다.
   *
   * ⚠️ **그룹 이름은 지우지 않는다** — 종목만 뺀다. 이름을 지우면 동기화가
   * 새로 만들면서 화면 순서가 뒤바뀐다(그룹 목록이 `AUTO_GROUPS` 순서를 따르는데
   * 없던 그룹이 뒤에 붙는다).
   */
  try {
    const items = await listWatchlist();
    /*
     * ⚠️ **ETF 그룹은 빼고 돈다** (2026-09-01). 자물쇠가 걸린 그룹이라는 점은
     * 같지만 성격이 반대다 — 점수대·슈퍼신호등은 **신호등이 담은** 것이고,
     * ETF 는 **사람이 담기 단추로 담은** 것이다. 신호등 원장에 선을 긋는다고
     * 사람이 모아 둔 ETF 가 같이 사라지면 안 된다.
     */
    for (const g of AUTO_GROUPS.filter((x) => x !== ETF_GROUP)) {
      const inG = items.filter((i) => i.groups?.includes(g));
      report.groups[g] = inG.length;
      if (dryRun) continue;
      for (const i of inG) await removeFromGroup(i.code, g).catch(() => undefined);
    }
  } catch (e) {
    report.groups["(읽기 실패)"] = 0;
    console.error("[ledgerReset] 관심종목 자동 그룹 정리 실패:", e);
  }

  if (!dryRun) {
    console.log(
      `[ledgerReset] 원장 ${report.totalMoved}건을 보관하고 비웠습니다 (지문 ${fingerprint ?? "?"})`,
    );
    await pushNotice({
      source: "ledger",
      kind: "system",
      level: "info",
      title: `신호등 원장을 새로 시작했습니다 — ${report.totalMoved}건 보관`,
      body:
        report.ledgers
          .map((l) => `${l.label} ${l.moved}건${l.error ? ` — ⚠️ ${l.error}` : ""}`)
          .join("\n") +
        `\n자동 그룹에서 뺀 종목 ${Object.values(report.groups).reduce((a, b) => a + b, 0)}개` +
        `\n기준 지문 ${fingerprint ?? "?"} — 여기서부터 쌓이는 것은 모두 이 기준입니다.` +
        `\n옛 기록은 server/data 의 .archive-${tag}.json 에 남아 있습니다.`,
      link: "#/settings",
      dedupeKey: `ledgerReset:${tag}`,
      dedupeHours: 1,
    }).catch(() => undefined);
  }

  return report;
}
