import type { KiwoomClient } from "./kiwoomClient.js";

/**
 * 업종 PER 계산.
 *
 * 키움 REST API에는 "업종 평균 PER"을 바로 주는 TR이 없다.
 * (ka10026은 고/저 PER 상위 종목만 준다)
 * 그래서 업종 구성종목을 가져와 종목별 PER(ka10001)을 모아 중앙값을 낸다.
 *
 * 종목 수만큼 호출이 필요해 비싸므로,
 *  - 업종 단위로 하루 1회만 계산하고 캐싱
 *  - 표본은 상위 N개로 제한
 *  - 평균 대신 중앙값 (PER은 이상치가 극단적이라 평균이 왜곡됨)
 */

type Row = Record<string, unknown>;

const STKINFO_RESOURCE = "/api/dostk/stkinfo";
const SECT_RESOURCE = "/api/dostk/sect";

const SAMPLE_LIMIT = 40; // 업종당 표본 종목 수
const TTL_MS = 24 * 3600 * 1000;

interface SectorPerEntry {
  per: number | null;
  sampleSize: number;
  at: number;
}

const perCache = new Map<string, SectorPerEntry>();
const inFlight = new Map<string, Promise<SectorPerEntry>>();

/** 업종명 -> {code, market} 매핑 (하루 캐싱) */
let sectorIndex: { map: Map<string, { code: string; market: "0" | "1" }>; at: number } | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

async function buildSectorIndex(client: KiwoomClient): Promise<Map<string, { code: string; market: "0" | "1" }>> {
  if (sectorIndex && Date.now() - sectorIndex.at < TTL_MS) return sectorIndex.map;

  const map = new Map<string, { code: string; market: "0" | "1" }>();
  for (const market of ["0", "1"] as const) {
    const { data } = await client.request<Row>(STKINFO_RESOURCE, "ka10101", { mrkt_tp: market });
    const list = Array.isArray(data.list) ? (data.list as Row[]) : [];
    for (const item of list) {
      const name = String(item.name ?? "").trim();
      const code = String(item.code ?? "");
      if (name && code && !map.has(name)) map.set(name, { code, market });
    }
    await sleep(220);
  }
  sectorIndex = { map, at: Date.now() };
  return map;
}

async function computeSectorPer(
  client: KiwoomClient,
  sectorCode: string,
  market: "0" | "1",
): Promise<SectorPerEntry> {
  // 업종 구성종목
  const { data } = await client.request<Row>(SECT_RESOURCE, "ka20002", {
    mrkt_tp: market,
    inds_cd: sectorCode,
    stex_tp: "3",
  });
  const rows = Array.isArray(data.inds_stkpc) ? (data.inds_stkpc as Row[]) : [];
  const codes = rows
    .map((r) => String(r.stk_cd ?? "").replace(/_(AL|NX)$/, ""))
    .filter(Boolean)
    .slice(0, SAMPLE_LIMIT);

  const pers: number[] = [];
  for (const code of codes) {
    try {
      const info = await client.request<Row>(STKINFO_RESOURCE, "ka10001", { stk_cd: code });
      const per = Number(info.data.per);
      // 적자 기업 등 음수/0 PER은 업종 대표값에서 제외
      if (Number.isFinite(per) && per > 0) pers.push(per);
    } catch {
      // 개별 종목 실패는 건너뛴다
    }
    await sleep(220);
  }

  return { per: median(pers), sampleSize: pers.length, at: Date.now() };
}

export interface SectorPerResult {
  sectorName: string;
  sectorPer: number | null;
  sampleSize: number;
}

/** 종목의 업종명을 받아 그 업종의 PER 중앙값을 돌려준다 */
export async function getSectorPer(
  client: KiwoomClient,
  sectorName: string,
): Promise<SectorPerResult | null> {
  const name = sectorName.trim();
  if (!name) return null;

  const index = await buildSectorIndex(client);
  const entry = index.get(name);
  if (!entry) return null;

  const key = `${entry.market}:${entry.code}`;
  const cached = perCache.get(key);
  if (cached && Date.now() - cached.at < TTL_MS) {
    return { sectorName: name, sectorPer: cached.per, sampleSize: cached.sampleSize };
  }

  // 같은 업종을 동시에 여러 번 계산하지 않도록 진행 중인 작업을 공유
  let pending = inFlight.get(key);
  if (!pending) {
    pending = computeSectorPer(client, entry.code, entry.market).then((result) => {
      perCache.set(key, result);
      inFlight.delete(key);
      return result;
    });
    inFlight.set(key, pending);
  }

  const result = await pending;
  return { sectorName: name, sectorPer: result.per, sampleSize: result.sampleSize };
}
