import type { KiwoomClient } from "./kiwoomClient.js";
import { noteLife } from "./lifecycle.js";

/**
 * **VKOSPI 가 키움 업종 목록에 있나** — 한 번 쓰고 지울 진단 (2026-11-12).
 *
 * 벤티지: "VKOSPI 라고 알아 너? 그 지표도 볼 수 있음 좋겠는데 코스피 야간선물 밑에다가"
 *
 * ## 받아올 데를 전수로 찾았고 전부 없었다
 *
 *   야후    `^VKOSPI`·`VKOSPI`·`^VKS`·`^KSVKOSPI` 넷 다 404
 *   네이버  index API 는 `StockConflict`(KOSPI·KPI200 은 정상), 검색도 결과 0,
 *           옛 지수 페이지(`sise_index.naver?code=VKOSPI`)는 302 로 사라졌다
 *   KRX     공개 JSON 이 세션 쿠키를 요구하고(`LOGOUT`), 쿠키를 붙여도 응답이 안 끝난다
 *
 * 남은 후보가 **키움 업종**이다. 그런데 확인하려면 키움을 불러야 하는데, 로컬에서
 * 토큰을 새로 받으면 **미니PC 것이 끊길 위험**이 있다(한투에서 그렇게 당했다).
 *
 * ## 그래서 서버가 스스로 묻고 로그에 적는다
 *
 * `:4000` 은 바깥에서 안 열려서 길(`/api/sys/sector-index-dump`)만 내면 **내가 답을
 * 못 본다.** `lifecycle.log` 는 공유 폴더에 있으니 거기 적으면 읽힌다.
 *
 * 뜨고 **한 번만** 돈다. 조회 네 건이고, 답이 나오면 이 파일을 지운다.
 */

const SECT = "/api/dostk/sect";
/** 001 코스피 · 101 코스닥 · 201 코스피200 · 301 은 혹시 몰라 — 없으면 빈칸이 온다 */
const MARKETS = ["001", "101", "201", "301"];
const HIT = /변동성|VKOSPI|VKPI/i;

export interface SectorDump {
  변동성찾음: string[];
  시장별: Record<string, { 개수: number; 줄: string[]; 오류?: string }>;
}

export async function probeSectorIndexes(client: KiwoomClient): Promise<SectorDump> {
  const 시장별: SectorDump["시장별"] = {};
  for (const c of MARKETS) {
    try {
      const { data } = await client.request<Record<string, unknown>>(SECT, "ka20003", { inds_cd: c });
      const rows = Array.isArray(data.all_inds_idex) ? (data.all_inds_idex as Record<string, unknown>[]) : [];
      시장별[c] = {
        개수: rows.length,
        /* 이름에 「변동성」이 든 줄을 앞으로 뺀다 — 백 줄 중에서 눈으로 찾지 않게 */
        줄: rows
          .map((r) => `${String(r.inds_cd ?? r.stk_cd ?? "?")} ${String(r.inds_nm ?? r.stk_nm ?? "?")}`)
          .sort((a, b) => Number(HIT.test(b)) - Number(HIT.test(a))),
      };
    } catch (e) {
      /* 한 시장이 막혀도 나머지는 본다 — 「전부 실패」와 「이 시장만 없음」은 다른 답이다 */
      시장별[c] = { 개수: 0, 줄: [], 오류: e instanceof Error ? e.message : String(e) };
    }
  }
  const 변동성찾음 = Object.values(시장별)
    .flatMap((v) => v.줄)
    .filter((s) => HIT.test(s));
  return { 변동성찾음, 시장별 };
}

/** 뜨고 한 번. 실패해도 서버는 돈다 — 진단 하나 때문에 기동이 흔들리면 안 된다 */
export function probeVkospiOnce(client: KiwoomClient, delayMs = 90_000): void {
  setTimeout(() => {
    void (async () => {
      try {
        const r = await probeSectorIndexes(client);
        const 개수 = Object.entries(r.시장별)
          .map(([k, v]) => `${k}:${v.오류 ? `실패(${v.오류})` : v.개수}`)
          .join(" · ");
        if (r.변동성찾음.length > 0) {
          noteLife("START", `VKOSPI 찾음 — ${r.변동성찾음.join(" / ")} (업종수 ${개수})`);
        } else {
          /* 못 찾은 것도 **답이다.** 「없다」를 기록해 둬야 다음에 또 안 찾는다 */
          const 맛보기 = (r.시장별["001"]?.줄 ?? []).slice(0, 6).join(" / ");
          noteLife("START", `VKOSPI 없음 — 키움 업종 목록에 변동성지수가 없다 (업종수 ${개수}). 001 앞부분: ${맛보기}`);
        }
      } catch (e) {
        noteLife("WARN", `VKOSPI 진단 실패 — ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
  }, delayMs).unref?.();
}
