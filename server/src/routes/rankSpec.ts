import { Router } from "express";
import { cumulativeRank } from "../cumulativeRank.js";
import type { KiwoomClient } from "../kiwoomClient.js";
import { COMMON_PARAMS, findSpec, specGroups, type RankSpec } from "../rankSpecs.js";
import { getMarketSnapshot } from "../marketSnapshot.js";
import { bare, extras, toNum } from "../rankExtras.js";
import { getStockIndex } from "../stockListCache.js";

/**
 * 시세분석 — 레지스트리에 등록된 순위 조회를 하나의 라우트로 처리한다.
 *
 * 순위마다 라우트를 만들면 같은 코드를 계속 복사하게 된다.
 * 명세(rankSpecs.ts)만 늘리면 화면까지 자동으로 붙는 구조로 뒀다.
 */

/**
 * KRX 정규장이 이미 시작했나 (평일 09:00 KST 이후).
 *
 * 마감 뒤에도 참이다 — 「오늘 KRX 값이 만들어졌나」를 묻는 것이지 지금 열려 있는지를
 * 묻는 게 아니다. 09시 전이면 KRX 자리에 있는 건 **장전 시간외종가**뿐이다.
 */
function krxSessionStarted(at = Date.now()): boolean {
  const d = new Date(at);
  const kst = new Date(d.getTime() + (9 * 60 + d.getTimezoneOffset()) * 60_000);
  if (kst.getDay() === 0 || kst.getDay() === 6) return false;
  return kst.getHours() * 60 + kst.getMinutes() >= 9 * 60;
}

function mapRow(row: Record<string, unknown>, spec: RankSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {
    code: bare(row.stk_cd),
    name: String(row.stk_nm ?? "").trim(),
  };
  for (const c of spec.columns) {
    // 이름은 위에서 이미 넣었고, 나머지는 형에 맞춰 변환한다
    if (c.key === "stk_nm") continue;
    const n = toNum(row[c.key]);
    /*
     * ⚠️ **가격은 부호를 떼서 내보낸다.**
     *
     * 키움은 하락 종목의 현재가를 `-52500` 처럼 **음수로** 준다(하락 표시 관행이다).
     * 그걸 그대로 흘리고 있었다 — 거래대금 상위 100줄 중 **50줄이 음수 가격**이었다.
     * 시세분석 화면은 그리면서 `Math.abs` 를 해 눈에 안 띄었지만, 이 응답을 쓰는
     * 다른 코드는 −52,500원을 그대로 받는다. **화면에서 가려서 없는 척하면 안 된다.**
     *
     * 여기서 부호를 떼도 잃는 게 없다 — 오르내림은 `flu_rt` 가 말한다.
     */
    out[c.key] = c.type === "text" ? String(row[c.key] ?? "") : c.type === "price" && n !== null ? Math.abs(n) : n;
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

  /**
   * **시가총액 상위** — 키움에 없어서 우리가 세운다.
   *
   * 순위 TR 에는 시가총액 순위가 없다. 그런데 「그 종목이 얼마짜리 회사인가」로 줄을 세워
   * 보는 일은 실제로 잦다 — 같은 +5% 라도 3천억과 30조는 다른 사건이다.
   *
   * 재료는 이미 있다. 시황 스냅샷이 업종 구성종목을 모아 두면서 **시가총액을 같이** 들고
   * 있다. 새로 조회하지 않고 그걸 세운다.
   *
   * ⚠️ **스냅샷에 없는 종목은 못 센다.** 스냅샷은 업종 구성종목으로 만드는데 키움이
   * 일부 업종의 구성종목을 안 주고 ETF·리츠는 업종에 안 잡힌다. 시총 상위는 대형주라
   * 거의 다 들어오지만, 「전 종목을 다 본 순위」는 아니라는 걸 화면에 적어 둔다.
   */
  router.get("/market-cap", async (req, res, next) => {
    try {
      const market = ["000", "001", "101"].includes(String(req.query.market))
        ? String(req.query.market)
        : "000";
      const limit = Math.min(Math.max(Number(req.query.limit) || 100, 20), 500);
      const snap = await getMarketSnapshot(client);
      const index = await getStockIndex(client).catch(() => new Map());

      const want = market === "001" ? "kospi" : market === "101" ? "kosdaq" : null;
      const rows = [...snap.byCode.values()]
        .filter((s) => s.marketCap !== null && s.marketCap > 0)
        .filter((s) => (want ? s.market === want : true))
        .sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0))
        .slice(0, limit)
        .map((s, i) => {
          const e = index.get(s.code);
          const ex = extras({ cur_prc: String(s.price), now_trde_qty: "0", stk_cd: s.code }, e);
          return {
            code: s.code,
            name: s.name,
            rank: i + 1,
            cur_prc: s.price,
            flu_rt: s.changeRate,
            ...ex,
            /* 스냅샷 쪽 시총이 더 믿을 만하다 — 키움이 직접 준 값이다 */
            cap: s.marketCap,
          };
        });

      res.json({
        spec: {
          key: "market-cap",
          label: "시가총액 상위",
          columns: [
            { key: "rank", label: "순위", type: "num" },
            { key: "cur_prc", label: "현재가", type: "num" },
            { key: "flu_rt", label: "등락률", type: "num" },
          ],
          exchange: false,
          note:
            "시황 스냅샷에서 세운 순위입니다 — 키움 순위 조회에는 시가총액 순위가 없습니다. " +
            "스냅샷은 업종 구성종목으로 만들어서 ETF·리츠와 일부 업종 종목이 빠집니다.",
        },
        market,
        exchange: "3",
        rows,
      });
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
      const limit = Math.min(Math.max(Number(req.query.limit) || 100, 20), 500);

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
        for (let page = 0; page < 6 && rows.length < limit; page += 1) {
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
       *
       * ## ⚠️ 09시 전에는 KRX 를 아예 안 본다 (2026-08-25)
       *
       * 장전(07:30~08:30)의 KRX 는 **시간외종가**다 — 전일 종가로만 체결되므로 등락률이
       * 구조적으로 0 이고 거래대금도 몇십억뿐이다. 그런데 그걸 「가격 기준」으로 삼아
       * 덮고 있었다. 08:32 에 재 보니 통합 상위 100줄 중 **9줄**(삼성전자·SK하이닉스·
       * 현대차·삼성전기·신풍제약·NAVER·심텍·한화에어로스페이스·삼천당제약)이 장전
       * KRX 목록에 걸려 **등락률이 0.00% 로 죽었다.** 나머지 91줄은 KRX 목록에 없어
       * 통합(=오늘 NXT 프리마켓) 값을 그대로 들고 있었다 — **한 표에 두 시점**이 섞였다.
       *
       * 09시 전에 오늘 값을 말할 수 있는 건 NXT 프리마켓뿐이고, 그건 통합이 이미 준다.
       */
      const [main, krx] = await Promise.all([
        ask(exchange),
        spec.exchange && exchange === "3" && krxSessionStarted()
          ? ask("1").catch(() => null)
          : Promise.resolve(null),
      ]);
      const data = main.data;

      /** KRX 몫 — 종목코드로 맞춘다 */
      const krxOf = new Map<string, { tv: number | null; price: number | null; rate: number | null }>();
      const krxRows = krx && Array.isArray(krx.data[spec.listKey])
        ? (krx.data[spec.listKey] as Record<string, unknown>[])
        : [];
      for (const r of krxRows) {
        /*
         * **KRX 에서 실제로 안 돈 종목은 없는 셈 친다.**
         * 거래가 0 이면 등락률도 0 으로 오는데, 그 0 은 「안 움직였다」가 아니라
         * 「여기서는 안 팔렸다」는 뜻이다. 그걸 통합 값 위에 덮으면 거짓말이 된다.
         */
        const qty = toNum(r.now_trde_qty) ?? toNum(r.trde_qty) ?? 0;
        if (qty <= 0) continue;
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
           *
           * ## 덮기 전 값을 버리지 않는다 (2026-08-25)
           *
           * 통합의 가격은 NXT 최종가다 — 저녁에 보면 애프터장에서 +2.33% 간 종목이
           * KRX 마감 +0.42% 로만 보여서 「통합인데 왜 KRX 만 나오나」가 됐다.
           * 그래서 KRX 로 덮되, **KRX 와 다르면 원래(NXT) 값을 nxtPrice·nxtRate 로**
           * 같이 내린다. 화면이 괄호로 붙인다 — 해외 관심종목의 시간외 괄호와 같은 문법.
           */
          let nxtPrice: number | null = null;
          let nxtRate: number | null = null;
          if (k?.price != null) {
            const orig = toNum(mapped.cur_prc);
            if (orig !== null && Math.abs(orig) !== Math.abs(k.price)) {
              nxtPrice = Math.abs(orig);
              nxtRate = toNum(mapped.flu_rt);
            }
            // 부호는 여기서도 뗀다 — KRX 응답도 하락이면 음수로 온다
            mapped.cur_prc = Math.abs(k.price);
          }
          if (k?.rate != null) mapped.flu_rt = k.rate;
          return {
            ...mapped,
            ...extras(r, index.get(code)),
            tvKrx: k?.tv ?? null,
            nxtPrice,
            nxtRate,
          };
        }),
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
