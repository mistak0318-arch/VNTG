import { hantooGet, hantooReady } from "./hantooClient.js";

/**
 * 금리 종합 (한투 `FHPST07020000`).
 *
 * **야후는 미국 금리만 준다.** `^TNX`·`^TYX`·`^FVX`·`^IRX` 넷뿐이고 일본·한국·독일은
 * 심볼 자체가 없다(실측으로 전부 404). 그런데 요즘 시장을 흔드는 건 **일본 금리**다 —
 * 엔 캐리가 풀리면 전 세계 위험자산에서 돈이 빠진다.
 *
 * 한투가 이걸 준다. 국내 국고채·통안·CD·콜부터 미국 T-Bond·연방기금금리,
 * 그리고 **일본 10년 국채수익률**까지 한 번의 호출로 온다.
 *
 * 금리는 **변화폭(%p)** 으로 읽어야 한다. 4.71% 가 4.72% 로 가는 건 등락률로는 0.2% 지만
 * 시장이 반응하는 건 **0.01%p** 라는 폭 자체다. 그래서 `prdy_vrss`(전일대비)를 그대로 쓴다.
 */

const PATH = "/uapi/domestic-stock/v1/quotations/comp-interest";
const TR = "FHPST07020000";

export interface RateRow {
  code: string;
  name: string;
  /** 금리 (%) */
  rate: number | null;
  /** 전일대비 (%p) — 등락률이 아니다 */
  change: number | null;
  group: "국내" | "해외";
}

interface Raw {
  bcdt_code?: string;
  hts_kor_isnm?: string;
  bond_mnrt_prpr?: string;
  bond_mnrt_prdy_vrss?: string;
}

function num(v: unknown): number | null {
  const n = Number(String(v ?? "").replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * 화면에 올릴 것만 고른다.
 *
 * 응답이 국내 14 + 해외 7 로 스물한 줄인데, 다 보여주면 **어디를 볼지 모른다.**
 * 판단에 실제로 쓰이는 것만 남긴다 —
 *   · 국고채 3년·10년 — 한국 금리의 기준
 *   · CD 91일 — 단기 자금 사정
 *   · 미국 10년·연방기금 — 글로벌 할인율
 *   · **일본 10년** — 엔 캐리
 */
const KEEP: Record<string, { label: string; group: "국내" | "해외" }> = {
  Y0104: { label: "국고채 3년", group: "국내" },
  Y0106: { label: "국고채 10년", group: "국내" },
  Y0112: { label: "CD 91일", group: "국내" },
  Y0114: { label: "콜 1일", group: "국내" },
  Y0202: { label: "미국 10년", group: "해외" },
  Y0201: { label: "미국 30년", group: "해외" },
  Y0204: { label: "미국 기준금리", group: "해외" },
  Y0207: { label: "일본 10년", group: "해외" },
};

/** 60초면 충분하다 — 금리는 하루에 몇 번 안 바뀐다 */
const TTL_MS = 60_000;
let cache: { at: number; rows: RateRow[] } | null = null;

export async function rateBoard(force = false): Promise<RateRow[]> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.rows;
  if (!hantooReady()) return [];

  try {
    const body = await hantooGet<{ output1?: Raw[]; output2?: Raw[] }>(
      PATH,
      TR,
      {
        FID_COND_MRKT_DIV_CODE: "I",
        FID_COND_SCR_DIV_CODE: "20702",
        FID_DIV_CLS_CODE: "0",
        FID_DIV_CLS_CODE1: "1",
      },
      "금리 종합",
    );

    const rows: RateRow[] = [];
    for (const r of [...(body.output1 ?? []), ...(body.output2 ?? [])]) {
      const code = String(r.bcdt_code ?? "").trim();
      const keep = KEEP[code];
      if (!keep) continue;
      rows.push({
        code,
        // 한투 이름은 "미국 10년T-NOTE 수익률" 처럼 길다. 짧은 이름을 쓴다
        name: keep.label,
        rate: num(r.bond_mnrt_prpr),
        change: num(r.bond_mnrt_prdy_vrss),
        group: keep.group,
      });
    }
    // KEEP 에 적은 순서대로 — 국내 먼저, 그 안에서 짧은 만기부터
    const order = Object.keys(KEEP);
    rows.sort((a, b) => order.indexOf(a.code) - order.indexOf(b.code));

    cache = { at: Date.now(), rows };
    return rows;
  } catch {
    // 금리 한 줄 때문에 대시보드가 멈추면 안 된다
    return cache?.rows ?? [];
  }
}
