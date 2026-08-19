import { hantooGet, hantooReady } from "./hantooClient.js";

/**
 * 주식기본조회 (한투 `CTPF1002R`).
 *
 * 키움 업종 분류가 안 맞는다는 지적에서 시작했다. 한투는 **네 단계**를 준다 —
 * 지수업종 대/중/소분류와 표준산업분류. 키움은 한 단계뿐이다.
 *
 * 다만 **바로 갈아끼우지는 않는다.** 업종은 신호등의 「섹터 강세」와 테마/업종 MAP 이
 * 같이 쓰는 값이라, 바꿔 놓고 더 나빠지면 되돌리기가 번거롭다.
 * 먼저 나란히 놓고 볼 수 있게 이 모듈만 두고, 어느 쪽을 쓸지는 그다음에 정한다.
 */

const PATH = "/uapi/domestic-stock/v1/quotations/search-stock-info";
const TR = "CTPF1002R";

export interface StockProfile {
  code: string;
  name: string;
  /** 지수업종 대분류 (예: 제조업) */
  sectorLarge: string | null;
  /** 지수업종 중분류 */
  sectorMid: string | null;
  /** 지수업종 소분류 */
  sectorSmall: string | null;
  /** 표준산업분류 (가장 자세하다 — 예: 반도체 제조업) */
  industry: string | null;
  industryCode: string | null;
}

function text(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return s && s !== "0" ? s : null;
}

const TTL_MS = 24 * 60 * 60_000; // 업종은 하루에 바뀌는 값이 아니다
const cache = new Map<string, { at: number; data: StockProfile | null }>();

export async function stockProfile(code: string): Promise<StockProfile | null> {
  const hit = cache.get(code);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
  if (!hantooReady()) return null;

  try {
    const body = await hantooGet<{
      output?: {
        prdt_abrv_name?: string;
        idx_bztp_lcls_cd_name?: string;
        idx_bztp_mcls_cd_name?: string;
        idx_bztp_scls_cd_name?: string;
        std_idst_clsf_cd?: string;
        std_idst_clsf_cd_name?: string;
      };
    }>(
      PATH,
      TR,
      {
        // 300: 주식(국내). 문서 기준
        PRDT_TYPE_CD: "300",
        PDNO: code,
      },
      "종목 기본정보",
    );

    const o = body.output;
    if (!o) {
      cache.set(code, { at: Date.now(), data: null });
      return null;
    }
    const data: StockProfile = {
      code,
      name: text(o.prdt_abrv_name) ?? "",
      sectorLarge: text(o.idx_bztp_lcls_cd_name),
      sectorMid: text(o.idx_bztp_mcls_cd_name),
      sectorSmall: text(o.idx_bztp_scls_cd_name),
      industry: text(o.std_idst_clsf_cd_name),
      industryCode: text(o.std_idst_clsf_cd),
    };
    cache.set(code, { at: Date.now(), data });
    return data;
  } catch {
    cache.set(code, { at: Date.now(), data: null });
    return null;
  }
}
