import { Router } from "express";
import { cumulativeRank } from "../cumulativeRank.js";
import type { KiwoomClient } from "../kiwoomClient.js";
import { COMMON_PARAMS, findSpec, specGroups, type RankSpec } from "../rankSpecs.js";
import { getStockIndex } from "../stockListCache.js";

/**
 * 시세분석 — 레지스트리에 등록된 순위 조회를 하나의 라우트로 처리한다.
 *
 * 순위마다 라우트를 만들면 같은 코드를 계속 복사하게 된다.
 * 명세(rankSpecs.ts)만 늘리면 화면까지 자동으로 붙는 구조로 뒀다.
 */

/**
 * 키움 숫자 정리.
 *
 * 응답에 `+1234`, `-1,234` 같은 부호·쉼표가 섞여 오고, 드물게 `--1431665` 처럼
 * **부호가 두 번** 붙어 온다(외국계 창구 순매수에서 실제로 나온다).
 * 그냥 Number()에 넣으면 NaN이 되므로 부호를 하나로 접어서 판다.
 */
function toNum(v: unknown): number | null {
  const raw = String(v ?? "").replace(/[,\s]/g, "");
  if (!raw) return null;
  const m = /^([+-]*)(\d*\.?\d+)$/.exec(raw);
  if (!m) return null;
  // 부호가 여러 개면 개수로 판단한다 (`--` 는 음수 표기의 중복이지 양수가 아니다)
  const negative = (m[1].match(/-/g) ?? []).length > 0;
  const n = Number(m[2]);
  return Number.isFinite(n) ? (negative ? -n : n) : null;
}

/**
 * 종목코드의 접미사를 뗀다 — 우리 기준은 6자리다.
 *
 * ⚠️ `_AL`(통합)만 떼고 있었는데 **NXT 조회는 `_NX` 로 온다.** 그러면 종목을 눌러도
 * `005930_NX` 라는 없는 코드로 열리고, 시가총액을 붙이는 맵도 못 찾는다.
 */
function bare(code: unknown): string {
  return String(code ?? "").replace(/_(AL|NX)$/, "").trim();
}

/**
 * 순위 한 줄에 **거를 재료**를 얹는다.
 *
 * ## 왜 서버가 붙이나
 *
 * 화면에서 「거래대금 500억 이상, 시가총액 1조 이하」로 좁히려면 그 값이 줄마다
 * 있어야 하는데, **키움 순위 TR 은 시가총액을 안 준다.** 종목마다 `ka10001` 을
 * 부르면 100줄에 20초다.
 *
 * 대신 `ka10099`(종목 목록)를 이미 **하루 캐싱**하고 있고 거기 상장주식수가 있다.
 * 시가총액 = 상장주식수 × 현재가 — 한 번 만든 맵으로 100줄을 즉시 채운다.
 *
 * ## 거래대금은 「있으면 쓰고 없으면 어림」
 *
 * 거래대금 상위(`ka10032`)는 거래대금을 직접 준다(백만원). 다른 순위는 안 준다 —
 * 그때는 **거래량 × 현재가**로 어림하고 `tvEst: true` 로 표시한다. 평균단가가 아니라
 * 현재가로 곱한 값이라 정확하지 않다. **어림값을 정확한 값인 척하면 안 된다.**
 */
interface RowExtras {
  /** 시가총액(억원). 상장주식수를 못 찾으면 null */
  cap: number | null;
  /** 거래대금(억원). 못 내면 null */
  tv: number | null;
  /** 거래대금이 어림값인가 (거래량 × 현재가) */
  tvEst: boolean;
  /** 코스피 / 코스닥 */
  mkt: string;
  sector: string;
  /** ETF·ETN·리츠·우선주가 아닌 보통주인가 */
  common: boolean;
}

function extras(
  row: Record<string, unknown>,
  entry: { marketName: string; sectorName: string; shares: number; code: string } | undefined,
): RowExtras {
  const price = Math.abs(toNum(row.cur_prc) ?? 0);
  const qty = toNum(row.now_trde_qty) ?? toNum(row.trde_qty) ?? 0;
  const prica = toNum(row.trde_prica);
  const shares = entry?.shares ?? 0;
  const listed = entry?.marketName === "거래소" || entry?.marketName === "코스닥";
  return {
    cap: shares > 0 && price > 0 ? Math.round((shares * price) / 1e8) : null,
    // 키움이 주는 거래대금은 백만원 단위다 (100 백만원 = 1억원)
    tv: prica !== null ? Math.round(prica / 100) : qty > 0 && price > 0 ? Math.round((qty * price) / 1e8) : null,
    tvEst: prica === null,
    mkt: entry?.marketName === "거래소" ? "코스피" : entry?.marketName === "코스닥" ? "코스닥" : "",
    sector: entry?.sectorName ?? "",
    // 끝자리가 0 이 아니면 우선주다 (stockListCache 의 판별과 같은 근거)
    common: listed && String(entry?.code ?? "").replace(/_(AL|NX)$/, "").endsWith("0"),
  };
}

function mapRow(row: Record<string, unknown>, spec: RankSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {
    code: bare(row.stk_cd),
    name: String(row.stk_nm ?? "").trim(),
  };
  for (const c of spec.columns) {
    // 이름은 위에서 이미 넣었고, 나머지는 형에 맞춰 변환한다
    if (c.key === "stk_nm") continue;
    out[c.key] = c.type === "text" ? String(row[c.key] ?? "") : toNum(row[c.key]);
  }
  return out;
}

export function createRankSpecRouter(client: KiwoomClient): Router {
  const router = Router();

  /** 트리에 그릴 목록 */
  router.get("/specs", (_req, res) => {
    res.json({ groups: specGroups() });
  });

  /**
   * 순위 조회.
   * `market` 은 000 전체 / 001 코스피 / 101 코스닥,
   * `exchange` 는 1 KRX / 2 NXT / 3 통합 (명세가 허용한 조회에서만).
   */
  /**
   * 누적등락률 상위 — **키움에 없어서 우리가 계산한다.**
   *
   * 100종목 일봉을 받아야 해서 처음 한 번은 30초쯤 걸린다. 그 뒤 10분은 캐시다.
   */
  router.get("/cumulative", async (req, res, next) => {
    try {
      const market = typeof req.query.market === "string" ? req.query.market : "000";
      const days = Math.min(Math.max(Number(req.query.days) || 5, 2), 60);
      const universe = Math.min(Math.max(Number(req.query.universe) || 100, 20), 200);
      res.json(await cumulativeRank(client, market, days, universe));
    } catch (err) {
      next(err);
    }
  });

  /*
   * ⚠️ **`/:key` 는 반드시 맨 아래.**
   * 무엇이든 받으므로 위에 두면 `/cumulative` 같은 이름난 경로를 **스펙 이름으로 먹는다** —
   * 실제로 그래서 「없는 조회입니다」가 나왔다. 새 경로를 더할 때도 이 위에 둘 것.
   */
  router.get("/:key", async (req, res, next) => {
    try {
      const spec = findSpec(req.params.key);
      if (!spec) {
        res.status(404).json({ error: "없는 조회입니다." });
        return;
      }

      const market = ["000", "001", "101"].includes(String(req.query.market))
        ? String(req.query.market)
        : "000";
      const exchange = spec.exchange && ["1", "2", "3"].includes(String(req.query.exchange))
        ? String(req.query.exchange)
        : "3";

      const { data } = await client.request<Record<string, unknown>>(
        `/api/dostk/${spec.uri}`,
        spec.apiId,
        { ...COMMON_PARAMS, ...(spec.params ?? {}), mrkt_tp: market, stex_tp: exchange },
      );

      const rows = Array.isArray(data[spec.listKey]) ? (data[spec.listKey] as Record<string, unknown>[]) : [];
      /*
       * 시가총액·시장은 하루 캐싱된 종목 목록에서 붙인다.
       * 목록을 못 받아도 순위 자체는 나와야 하므로 실패하면 빈 맵으로 간다.
       */
      const index = await getStockIndex(client).catch(() => new Map());
      res.json({
        spec: {
          key: spec.key,
          label: spec.label,
          columns: spec.columns,
          exchange: Boolean(spec.exchange),
          note: spec.note ?? "",
        },
        market,
        exchange,
        rows: rows.slice(0, 100).map((r) => ({
          ...mapRow(r, spec),
          ...extras(r, index.get(bare(r.stk_cd))),
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
