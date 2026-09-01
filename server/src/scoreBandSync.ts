import {
  BAND_GROUPS,
  bandGroupOf,
  ensureInGroup,
  listWatchlist,
  removeFromGroup,
} from "./watchlist.js";
import { listScreenRuns, getScreenRun } from "./signalScreen.js";
import { activeSuperEntries } from "./superSignal.js";

/**
 * **점수대 그룹 동기화** (2026-09-01) — 90/80/70/60점대.
 *
 * 벤티지: "관심종목에 90점대,80점대,70점대,60점대 그룹 추가해서 신호등 분석이랑
 * 슈퍼신호등 메뉴에 있는 것들 여기에 동기화 되게 하자."
 *
 * ## 무엇을 담나
 *
 * 두 곳에서 모은다:
 *
 *   ① **신호등 찾기**의 가장 최근 회차 — 점수가 붙어 있는 목록이다
 *   ② **슈퍼신호등** 원장의 살아 있는 편입 — 여러 목록에 동시에 걸린 것들
 *
 * 같은 종목이 둘 다에 있으면 **높은 점수를 쓴다.** 슈퍼신호등은 편입 시점 점수라
 * 오늘 찾기 점수와 다를 수 있는데, 낮은 쪽으로 담으면 「어제보다 좋아졌는데 아래
 * 그룹으로 내려갔다」가 된다.
 *
 * ## 한 종목은 한 그룹에만
 *
 * 87점이면 **80점대에만** 있다. 「90점대 = 90점 이상 전부」로 하면 90점대가
 * 나머지를 다 삼켜서 갈라 본 뜻이 없어진다.
 *
 * ## 점수가 바뀌면 옮긴다 — 쌓이게 두지 않는다
 *
 * 슈퍼신호등 그룹에서 겪은 문제다: "이탈 로직이 슈퍼신호등 메뉴에서만 적용되니깐
 * 내 관심종목 리스트는 계속 쌓이고만 있네."
 *
 * 그래서 **먼저 빼고 나중에 담는다.** 오늘 목록에 없는 종목은 점수대 그룹에서
 * 빠지고, 87 → 92 로 오른 종목은 80점대에서 빠져 90점대로 간다.
 *
 * ## ⚠️ 손으로 담은 종목도 뺀다 — 그리고 그건 의도한 것이다
 *
 * 슈퍼신호등 동기화는 「원장에 없는 종목은 안 건드린다」였다. 사람이 손으로 담았을
 * 수 있으니까. 여기는 **반대로 간다.** 「90점대」는 사람이 정하는 이름이 아니라
 * **오늘 점수가 90점대라는 사실**이다. 손으로 넣어 둔 60점짜리가 90점대에 남아
 * 있으면 그 그룹은 거짓말이 된다.
 *
 * 화면이 이 그룹을 **자물쇠로 표시**하는 것이 그래서 중요하다 — 여기 손대 봐야
 * 다음 동기화가 덮는다는 걸 알아야 한다.
 */

export interface BandSyncResult {
  /** 그룹별로 몇 종목이 담겼나 */
  counts: Record<string, number>;
  added: number;
  removed: number;
  /** 어느 회차를 바탕으로 했나 — 「언제 것인가」를 화면이 말할 수 있게 */
  runAt?: string;
  /** 슈퍼신호등에서 몇 개를 보탰나 */
  fromSuper: number;
  at: string;
}

let last: BandSyncResult | null = null;

export function lastBandSync(): BandSyncResult | null {
  return last;
}

/**
 * 한 번 맞춘다. **조회 0회** — 이미 저장된 회차와 원장만 읽는다.
 */
export async function syncScoreBands(): Promise<BandSyncResult> {
  const counts: Record<string, number> = Object.fromEntries(BAND_GROUPS.map((g) => [g, 0]));
  let added = 0;
  let removed = 0;
  let fromSuper = 0;
  let runAt: string | undefined;

  /** 종목 → { 점수, 이름, 가격 } — 높은 점수가 이긴다 */
  const best = new Map<string, { score: number; name: string; price: number }>();
  const put = (code: string, name: string, price: number, score: number) => {
    const had = best.get(code);
    if (had && had.score >= score) return;
    best.set(code, { score, name, price });
  };

  /* ① 신호등 찾기 — 가장 최근 회차 */
  try {
    const runs = await listScreenRuns();
    const latest = runs[0];
    if (latest) {
      runAt = latest.at;
      const run = await getScreenRun(latest.id);
      for (const h of run?.results ?? []) {
        if (typeof h.score !== "number") continue;
        put(h.code, h.name, h.price ?? 0, h.score);
      }
    }
  } catch {
    /* 회차를 못 읽어도 슈퍼신호등 쪽은 담는다 */
  }

  /* ② 슈퍼신호등 원장의 살아 있는 편입 */
  try {
    for (const e of await activeSuperEntries()) {
      if (!Number.isFinite(e.score)) continue;
      const had = best.get(e.code);
      if (!had || had.score < e.score) fromSuper += 1;
      put(e.code, e.name, e.addedPrice ?? 0, e.score);
    }
  } catch {
    /* 원장을 못 읽어도 찾기 쪽은 담는다 */
  }

  /** 종목 → 있어야 할 그룹 */
  const want = new Map<string, string>();
  for (const [code, v] of best) {
    const g = bandGroupOf(v.score);
    if (g) want.set(code, g);
  }

  /*
   * **먼저 뺀다.** 오늘 목록에 없거나 다른 점수대로 옮겨 갈 종목을 정리한다.
   * 담기부터 하면 87→92 인 종목이 두 그룹에 동시에 있는 순간이 생긴다.
   */
  for (const w of await listWatchlist()) {
    for (const g of w.groups) {
      if (!BAND_GROUPS.includes(g)) continue;
      if (want.get(w.code) === g) continue;
      if (await removeFromGroup(w.code, g)) removed += 1;
    }
  }

  /* 그다음 담는다 */
  for (const [code, g] of want) {
    const v = best.get(code)!;
    await ensureInGroup({ code, name: v.name, addedPrice: v.price }, g).catch(() => undefined);
    counts[g] = (counts[g] ?? 0) + 1;
    added += 1;
  }

  last = { counts, added, removed, runAt, fromSuper, at: new Date().toISOString() };
  return last;
}
