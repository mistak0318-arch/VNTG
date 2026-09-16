import { hantooGet, hantooReady } from "./hantooClient.js";

/**
 * **한투 해외주식 순위·업종 TR 시험** (2026-09-16 밤 — 벤티지: "시세분석 해외는 네이버 실시간이구나. 한투에는 없어?
 * 테마나 이런 거 지원해 주는 건?").
 *
 * 시세분석(해외)은 네이버 거래소 목록(실시간·키 없음)으로 만들었고, 한투에도 순위 TR 이 있다는 건 알지만
 * `docs/한투API_참고.md` 에 적힌(= 실측한) 것이 아니다. 이름·경로·지연 여부를 **추측으로 코드에 박지 않는다** —
 * 여기서 한 번씩 찔러 보고 결과를 health.json 에 남긴 뒤, 되는 것만 두 번째 출처(네이버가 막힐 때)로 연다.
 *
 * 하루 한 번, 켠 지 2분 뒤. 후보 여섯에 각 1콜 — 키 조회 몫에 티가 안 난다. 결과에는 **건수·응답 코드·메시지**만
 * 남긴다(종목·키 없음).
 */

interface Candidate {
  label: string;
  path: string;
  trId: string;
  params: Record<string, string>;
  /** 응답에서 목록이 들어 있을 칸 이름 후보 */
  listKeys: string[];
}

const EXCD = "NAS";
const CANDIDATES: Candidate[] = [
  {
    label: "거래량순위",
    path: "/uapi/overseas-stock/v1/ranking/trade-vol",
    trId: "HHDFS76310010",
    params: { AUTH: "", EXCD, NDAY: "0", VOL_RANG: "0", KEYB: "" },
    listKeys: ["output2"],
  },
  {
    label: "거래대금순위",
    path: "/uapi/overseas-stock/v1/ranking/trade-pbmn",
    trId: "HHDFS76320010",
    params: { AUTH: "", EXCD, NDAY: "0", PRC1: "0", PRC2: "0", VOL_RANG: "0", KEYB: "" },
    listKeys: ["output2"],
  },
  {
    label: "시가총액순위",
    path: "/uapi/overseas-stock/v1/ranking/market-cap",
    trId: "HHDFS76350100",
    params: { AUTH: "", EXCD, VOL_RANG: "0", KEYB: "" },
    listKeys: ["output2"],
  },
  {
    label: "등락률순위(상승)",
    path: "/uapi/overseas-stock/v1/ranking/updown-rate",
    trId: "HHDFS76290000",
    params: { AUTH: "", EXCD, NDAY: "0", GUBN: "1", VOL_RANG: "0", KEYB: "" },
    listKeys: ["output2"],
  },
  {
    label: "업종별코드",
    path: "/uapi/overseas-price/v1/quotations/industry-theme",
    trId: "HHDFS76370000",
    params: { AUTH: "", EXCD, ICOD: "", VOL_RANG: "0", KEYB: "" },
    listKeys: ["output2", "output1"],
  },
  {
    label: "업종별시세",
    path: "/uapi/overseas-price/v1/quotations/industry-price",
    trId: "HHDFS76370100",
    params: { AUTH: "", EXCD, ICOD: "", VOL_RANG: "0", KEYB: "" },
    listKeys: ["output2", "output1"],
  },
];

let result: Record<string, unknown> = { 상태: "아직 안 봄" };
export const hantooUsRankProbeSnapshot = (): Record<string, unknown> => result;

async function probeOnce(): Promise<void> {
  if (!hantooReady()) {
    result = { 상태: "한투 키 없음" };
    return;
  }
  const out: Record<string, unknown> = { 상태: "봄", at: new Date().toISOString() };
  for (const c of CANDIDATES) {
    try {
      const r = (await hantooGet<Record<string, unknown>>(c.path, c.trId, c.params, `probe:${c.label}`)) as Record<string, unknown>;
      const listKey = c.listKeys.find((k) => Array.isArray(r[k]));
      const rows = listKey ? (r[listKey] as unknown[]) : [];
      const first = (rows[0] ?? {}) as Record<string, unknown>;
      /* 지연 여부는 필드 이름으로 짐작만 — 값은 안 싣는다 */
      out[c.label] = {
        ok: rows.length > 0,
        rt_cd: r.rt_cd ?? null,
        msg: String(r.msg1 ?? "").slice(0, 60),
        rows: rows.length,
        fields: Object.keys(first).slice(0, 12),
      };
    } catch (e) {
      out[c.label] = { ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 80) };
    }
  }
  result = out;
  console.log("[한투 해외순위 시험]", JSON.stringify(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, typeof v === "object" && v ? (v as { ok?: boolean; rows?: number }).ok ?? v : v]))));
}

/** 켠 지 2분 뒤 한 번, 그 뒤 하루 한 번 */
export function startHantooUsRankProbe(): void {
  setTimeout(() => void probeOnce().catch(() => undefined), 120_000);
  setInterval(() => void probeOnce().catch(() => undefined), 24 * 3600_000);
}
