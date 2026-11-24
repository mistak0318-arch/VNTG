import { collectFail, collectOk } from "./collectHealth.js";
import { recordApiCall } from "./apiUsage.js";

/**
 * 미국 장기금리 **10년·20년·30년** — FRED(세인트루이스 연준).
 *
 * ## 왜 야후가 아니라 여기인가
 *
 * 야후는 `^TNX`(10년)·`^TYX`(30년)를 **지금 값**으로 주는데 **20년물이 없다**(실측).
 * 벤티지가 레이더에 넣기로 한 것은 10년·20년이므로 20년을 어디선가 받아야 한다.
 * FRED 는 키 없이 CSV 한 줄로 셋을 다 주고(`DGS10,DGS20,DGS30`), 공식 확정치다.
 *
 * ## 대신 **하루 늦다**
 *
 * FRED 는 전 영업일 확정치를 올린다. 그래서 화면은 **그 날짜를 같이 적는다** —
 * 야후 10년(지금)과 나란히 놓고 날짜를 안 적으면 「왜 안 맞아」가 된다(2026-11-20 에
 * 정규장 등락률로 똑같이 당했다). 레이더의 10년·30년은 야후 실시간을 쓰고,
 * **20년만** 이 값으로 채우되 날짜를 달아 둔다.
 *
 * 하루 한 번 바뀌는 값이라 6시간 들고 있는다. 조회는 하루 네 번이다.
 */

const CSV = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10,DGS20,DGS30";
const TTL_MS = 6 * 3600_000;

export interface UsLongRates {
  /** 확정치 날짜 YYYY-MM-DD — **언제 값인지 모르면 쓰지 않는다** */
  date: string | null;
  y10: number | null;
  y20: number | null;
  y30: number | null;
  why: string;
}

let cache: { at: number; data: UsLongRates } | null = null;

function parse(csv: string): UsLongRates {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) return { date: null, y10: null, y20: null, y30: null, why: "빈CSV" };
  const head = lines[0].split(",").map((s) => s.trim());
  const col = (name: string): number => head.indexOf(name);
  const i10 = col("DGS10");
  const i20 = col("DGS20");
  const i30 = col("DGS30");
  if (i10 < 0 || i20 < 0) return { date: null, y10: null, y20: null, y30: null, why: "칸이름바뀜" };
  /*
   * **뒤에서부터 올라오며 값이 있는 첫 줄**을 쓴다. 휴일·결측은 빈 칸(`.`)으로 오는데,
   * 맨 끝 줄만 보면 연휴 다음 날 통째로 비어 「금리가 사라졌다」가 된다.
   */
  for (let i = lines.length - 1; i >= 1; i -= 1) {
    const c = lines[i].split(",");
    const n = (idx: number): number | null => {
      if (idx < 0) return null;
      const v = Number(String(c[idx] ?? "").trim());
      return Number.isFinite(v) && v > 0 ? v : null;
    };
    const y10 = n(i10);
    const y20 = n(i20);
    if (y10 === null && y20 === null) continue;
    return { date: String(c[0] ?? "").trim() || null, y10, y20, y30: n(i30), why: "" };
  }
  return { date: null, y10: null, y20: null, y30: null, why: "값이있는줄없음" };
}

export async function usLongRates(force = false): Promise<UsLongRates> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.data;
  try {
    const res = await fetch(CSV, {
      /* 우리를 밝히되 **사람 정보는 안 싣는다** — 공개 CSV 라 그걸로 충분하다 */
      headers: { "User-Agent": "vntg-hts/1.0" },
      signal: AbortSignal.timeout(15_000),
    });
    void recordApiCall("fred", "longRates", res.ok ? "ok" : "failed");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = parse(await res.text());
    if (data.y20 === null && data.y10 === null) {
      collectFail("미국장기금리", data.why || "값없음");
      /* 옛 값이라도 있으면 그걸 들고 간다 — 빈 칸보다 「언제 값」이 낫다 */
      if (cache) return cache.data;
      return data;
    }
    cache = { at: Date.now(), data };
    collectOk("미국장기금리");
    return data;
  } catch (err) {
    const why = err instanceof Error ? err.message.slice(0, 60) : "알수없음";
    /* 시간초과면 위의 `recordApiCall` 까지 못 가므로 여기서 한 번 더 — 실패도 세야 한다 */
    void recordApiCall("fred", "longRates", "failed", undefined, why);
    collectFail("미국장기금리", why);
    if (cache) return cache.data;
    return { date: null, y10: null, y20: null, y30: null, why };
  }
}
