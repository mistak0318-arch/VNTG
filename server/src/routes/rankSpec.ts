import { Router } from "express";
import { cumulativeRank } from "../cumulativeRank.js";
import type { KiwoomClient } from "../kiwoomClient.js";
import { COMMON_PARAMS, findSpec, specGroups, type RankSpec } from "../rankSpecs.js";

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

/** 종목코드의 `_AL`(NXT 통합) 접미사를 뗀다 — 우리 기준은 6자리다 */
function bare(code: unknown): string {
  return String(code ?? "").replace(/_AL$/, "").trim();
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
        rows: rows.slice(0, 100).map((r) => mapRow(r, spec)),
      });
    } catch (err) {
      next(err);
    }
  });

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

  return router;
}
