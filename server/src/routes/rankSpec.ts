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
  /** 거래대금(억원) — 고른 거래소 기준. 못 내면 null */
  tv: number | null;
  /**
   * **KRX 몫의 거래대금(억원).** `tv` 는 통합(=KRX+NXT)이다.
   *
   * ## 왜 둘을 다 두나 (2026-08-24 실측)
   *
   * 삼성전자 하루치를 세 갈래로 재 봤다.
   *
   * | 거래소 | 거래대금 | 현재가 |
   * |---|---|---|
   * | KRX | 84,561억 | 257,000 |
   * | NXT | 52,463억 | 256,000 |
   * | **통합** | **137,023억** | 256,000 |
   *
   * 84,561 + 52,463 = 137,024 — **통합의 거래대금은 정확히 합계**다. 하루 거래는
   * NXT 프리(08~09시) + KRX 정규(09~15:30) + NXT 애프터(15:30~20시) 셋이므로 합계가 맞다.
   *
   * 그런데 **가격은 통합이 NXT 최종가**를 준다. 종목 상세는 KRX 라 목록과 상세가 갈렸다.
   *
   * 그래서 **거래대금은 통합, 가격은 KRX** 로 받는다. 둘 다 필요하므로 두 번 부른다.
   */
  tvKrx: number | null;
  /** 거래대금이 어림값인가 (거래량 × 현재가) */
  tvEst: boolean;
  /**
   * **회전율(%)** — 오늘 거래량 ÷ 상장주식수.
   *
   * 거래대금만 보면 큰 종목이 늘 위에 있다. 삼성전자 13조와 소형주 500억은 비교가
   * 안 되는데, 회전율로 보면 **그 종목 치고 얼마나 돌았나**가 나온다. 시가총액이
   * 작은 종목이 회전율 20% 면 주인이 하루에 다섯 번 바뀐 셈이다.
   *
   * 순위 TR 은 회전율을 안 주지만 상장주식수를 이미 갖고 있으므로 여기서 낸다.
   */
  turn: number | null;
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
    tvKrx: null,
    turn: shares > 0 && qty > 0 ? (qty / shares) * 100 : null,
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
        : "3"; // 기본 통합 — 거래대금이 하루 전체(KRX+NXT)라 순위가 맞다. 가격만 아래에서 KRX 로 덮는다

      /**
       * 몇 건까지 받을까 — 화면이 정한다(기본 100, 최대 300).
       *
       * 키움 순위는 한 번에 백 건쯤 주고 그다음은 **연속조회**다. 예전엔 첫 장만 받아
       * 백 건에서 잘렸는데, 「거래대금 150위가 궁금하다」에 답할 수가 없었다.
       */
      const limit = Math.min(Math.max(Number(req.query.limit) || 100, 20), 300);

      /**
       * 한 거래소에서 `limit` 만큼 모은다.
       *
       * 다음 장이 없으면 그 자리에서 멈춘다 — 코스닥 소형주처럼 목록이 짧은 조회에서
       * 빈 장을 세 번 더 부를 이유가 없다.
       */
      const ask = async (stex: string) => {
        const rows: Record<string, unknown>[] = [];
        let contYn = "N";
        let nextKey = "";
        let last: Awaited<ReturnType<typeof client.request<Record<string, unknown>>>> | null = null;
        for (let page = 0; page < 4 && rows.length < limit; page += 1) {
          const res = await client.request<Record<string, unknown>>(
            `/api/dostk/${spec.uri}`,
            spec.apiId,
            { ...COMMON_PARAMS, ...(spec.params ?? {}), mrkt_tp: market, stex_tp: stex },
            page === 0 ? {} : { contYn, nextKey },
          );
          last = res;
          const got = Array.isArray(res.data[spec.listKey])
            ? (res.data[spec.listKey] as Record<string, unknown>[])
            : [];
          if (got.length === 0) break;
          rows.push(...got);
          contYn = res.contYn;
          nextKey = res.nextKey;
          if (contYn !== "Y" || !nextKey) break;
        }
        /* 모은 줄을 첫 응답 모양에 담아 돌려준다 — 아래 코드가 그대로 쓴다 */
        return {
          ...(last ?? { data: {}, contYn: "N", nextKey: "" }),
          data: { ...(last?.data ?? {}), [spec.listKey]: rows },
        };
      };

      /*
       * **KRX 를 한 번 더 받아 가격만 덮는다.**
       *
       * 순위와 거래대금은 **통합**이 맞다 — 하루 거래는 NXT 프리·KRX 정규·NXT 애프터
       * 셋의 합이고, 통합의 거래대금이 정확히 그 합이다(2026-08-24 실측).
       * KRX 만 보면 삼성전자 137,023억이 84,561억으로 줄어 순위 자체가 틀어진다.
       *
       * 그런데 **가격은 통합이 NXT 최종가**를 준다. 종목 상세는 KRX 라 목록과 상세가 갈린다.
       * 그래서 KRX 를 한 번 더 받아 **현재가·등락률만** 그걸로 바꾼다.
       *
       * TR 이 한 번 더 나가지만 순위는 자주 부르는 조회가 아니고, 실패하면 통합 값을 그대로 쓴다.
       * 거래소를 직접 고른 경우에는 안 부른다 — 그 거래소를 보겠다는 뜻이다.
       */
      const [main, krx] = await Promise.all([
        ask(exchange),
        spec.exchange && exchange === "3" ? ask("1").catch(() => null) : Promise.resolve(null),
      ]);
      const data = main.data;

      /** KRX 몫 — 종목코드로 맞춘다 */
      const krxOf = new Map<string, { tv: number | null; price: number | null; rate: number | null }>();
      const krxRows = krx && Array.isArray(krx.data[spec.listKey])
        ? (krx.data[spec.listKey] as Record<string, unknown>[])
        : [];
      for (const r of krxRows) {
        const prica = toNum(r.trde_prica);
        krxOf.set(bare(r.stk_cd), {
          tv: prica === null ? null : Math.round(prica / 100),
          price: toNum(r.cur_prc),
          rate: toNum(r.flu_rt),
        });
      }

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
        rows: rows.slice(0, limit).map((r) => {
          const code = bare(r.stk_cd);
          const k = krxOf.get(code);
          const mapped = mapRow(r, spec);
          /*
           * 가격만 KRX 로 덮는다. 거래대금·순위는 통합 그대로다.
           * KRX 에 그 종목이 없으면(그날 KRX 에서 안 돌았으면) 통합 값을 남긴다.
           */
          if (k?.price != null) mapped.cur_prc = k.price;
          if (k?.rate != null) mapped.flu_rt = k.rate;
          return {
            ...mapped,
            ...extras(r, index.get(code)),
            tvKrx: k?.tv ?? null,
          };
        }),
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
