import { Router } from "express";
import type { KiwoomClient } from "../kiwoomClient.js";
import { intradayLevels } from "../intraday.js";
import { getSectorMood } from "../sectorMood.js";
import { searchStocks } from "../stockListCache.js";
import { analystOpinion } from "../analystOpinion.js";
import { hantooReady } from "../hantooClient.js";
import { stockProfile } from "../stockProfile.js";
import { tradeSizeMix } from "../tradeSizeMix.js";
import { CHART_RANGES, yahooChart } from "../yahooChart.js";
import { futuresCandles } from "../kospiFutures.js";
import { usCandles, usDetail } from "../usDetail.js";
import { orderBook } from "../orderBook.js";
import { brokerFlow } from "../brokerFlow.js";

const MRKCOND_RESOURCE = "/api/dostk/mrkcond";
const CHART_RESOURCE = "/api/dostk/chart";
const STKINFO_RESOURCE = "/api/dostk/stkinfo";
const FRGNISTT_RESOURCE = "/api/dostk/frgnistt";
const SHSA_RESOURCE = "/api/dostk/shsa";
const SLB_RESOURCE = "/api/dostk/slb";

function todayYyyymmdd(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

function daysAgoYyyymmdd(days: number): string {
  const d = new Date(Date.now() - days * 86400_000);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}${m}${day}`;
}

export function createMarketRouter(client: KiwoomClient): Router {
  const router = Router();

  // 종목 검색 (ka10099 코스피/코스닥 전종목 리스트를 캐싱해서 이름/코드로 필터링)
  router.get("/search", async (req, res, next) => {
    try {
      const q = typeof req.query.q === "string" ? req.query.q : "";
      const results = await searchStocks(client, q);
      res.json({ results });
    } catch (err) {
      next(err);
    }
  });

  // 종목 기본정보 (ka10001) - 종목명, 현재가, 등락률 등
  router.get("/info/:code", async (req, res, next) => {
    try {
      const { data } = await client.request(STKINFO_RESOURCE, "ka10001", {
        stk_cd: req.params.code,
      });
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  // 주식호가 (ka10004)
  router.get("/quote/:code", async (req, res, next) => {
    try {
      const { data } = await client.request(MRKCOND_RESOURCE, "ka10004", {
        stk_cd: req.params.code,
      });
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  // 일봉 차트 (ka10081)
  router.get("/chart/daily/:code", async (req, res, next) => {
    try {
      const baseDt = typeof req.query.base_dt === "string" ? req.query.base_dt : todayYyyymmdd();
      const { data } = await client.request(CHART_RESOURCE, "ka10081", {
        stk_cd: req.params.code,
        base_dt: baseDt,
        upd_stkpc_tp: "1", // 수정주가 반영
      });
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  // 주봉 차트 (ka10082)
  router.get("/chart/weekly/:code", async (req, res, next) => {
    try {
      const baseDt = typeof req.query.base_dt === "string" ? req.query.base_dt : todayYyyymmdd();
      const { data } = await client.request(CHART_RESOURCE, "ka10082", {
        stk_cd: req.params.code,
        base_dt: baseDt,
        upd_stkpc_tp: "1",
      });
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  // 월봉 차트 (ka10083)
  router.get("/chart/monthly/:code", async (req, res, next) => {
    try {
      const baseDt = typeof req.query.base_dt === "string" ? req.query.base_dt : todayYyyymmdd();
      const { data } = await client.request(CHART_RESOURCE, "ka10083", {
        stk_cd: req.params.code,
        base_dt: baseDt,
        upd_stkpc_tp: "1",
      });
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  // 종목별 투자자(외인/기관) 순매매 차트 (ka10060)
  router.get("/chart/investor/:code", async (req, res, next) => {
    try {
      const dt = typeof req.query.dt === "string" ? req.query.dt : todayYyyymmdd();
      const { data } = await client.request(CHART_RESOURCE, "ka10060", {
        dt,
        stk_cd: req.params.code,
        amt_qty_tp: "1", // 1:금액(백만원)
        trde_tp: "0", // 0:순매수
        unit_tp: "1000",
      });
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  // 외국인 보유 추이 (ka10008) - 일자별 보유주식수·지분율
  router.get("/foreign/:code", async (req, res, next) => {
    try {
      const { data } = await client.request(FRGNISTT_RESOURCE, "ka10008", {
        stk_cd: req.params.code,
      });
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  // 공매도 추이 (ka10014)
  router.get("/shortsale/:code", async (req, res, next) => {
    try {
      const days = Math.min(Number(req.query.days) || 60, 365);
      const { data } = await client.request(SHSA_RESOURCE, "ka10014", {
        stk_cd: req.params.code,
        tm_tp: "1", // 1:기간
        strt_dt: daysAgoYyyymmdd(days),
        end_dt: todayYyyymmdd(),
      });
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  // 대차거래 추이 (ka20068) - 잔고주수·잔고금액
  router.get("/lending/:code", async (req, res, next) => {
    try {
      const days = Math.min(Number(req.query.days) || 60, 365);
      const { data } = await client.request(SLB_RESOURCE, "ka20068", {
        strt_dt: daysAgoYyyymmdd(days),
        end_dt: todayYyyymmdd(),
        all_tp: "0", // 입력 종목만
        stk_cd: req.params.code,
      });
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  /*
   * 업종 분류 비교 — 키움 vs 한투.
   *
   * 바꾸기 전에 **실제로 나은지 눈으로 보려고** 둔다. 업종은 신호등의 「섹터 강세」와
   * 테마/업종 MAP 이 같이 쓰는 값이라 바꿔 놓고 나빠지면 되돌리기가 번거롭다.
   */
  router.get("/sector-compare", async (req, res, next) => {
    try {
      const codes = String(req.query.codes ?? "")
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean)
        .slice(0, 20);
      const rows = [];
      for (const code of codes) {
        const [mood, profile] = await Promise.all([
          getSectorMood(client, code).catch(() => null),
          stockProfile(code).catch(() => null),
        ]);
        rows.push({
          code,
          name: profile?.name ?? "",
          kiwoom: mood?.sector?.name ?? null,
          hantooLarge: profile?.sectorLarge ?? null,
          hantooMid: profile?.sectorMid ?? null,
          hantooSmall: profile?.sectorSmall ?? null,
          hantooIndustry: profile?.industry ?? null,
        });
      }
      res.json({ rows });
    } catch (err) {
      next(err);
    }
  });

  // ---------------- 개별종목분석 화면용 ----------------

  // 거래원 (ka10002) - 매도/매수 상위 5개 증권사
  router.get("/broker/:code", async (req, res, next) => {
    try {
      const { data } = await client.request(STKINFO_RESOURCE, "ka10002", {
        stk_cd: req.params.code,
      });
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  // 시세표성정보 (ka10007) - 시/고/저/기준가/상하한가/예상체결 등 시세 한 덩어리
  router.get("/snapshot/:code", async (req, res, next) => {
    try {
      const { data } = await client.request(MRKCOND_RESOURCE, "ka10007", {
        stk_cd: req.params.code,
      });
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  /**
   * 거래소별 시세 — KRX / NXT / 통합.
   *
   * 키움은 **종목코드 접미사로 거래소를 가른다** (실측 확인):
   *   005930     → KRX      고가 275,500  거래량 11,158,647
   *   005930_NX  → NXT      고가 278,000  거래량 11,553,547
   *   005930_AL  → 통합     고가 278,000  거래량 22,712,194  (= KRX + NXT)
   *
   * 지금까지 화면의 고가·저가는 KRX만 본 값이었다. NXT에서 더 높이 찍힌 걸 놓치고 있었으므로
   * 둘을 나란히 준다. `_AL` 은 두 곳을 합친 값이라 "그날 진짜 고가"가 여기 있다.
   */
  router.get("/exchanges/:code", async (req, res, next) => {
    try {
      // 이미 접미사가 붙어 오면 떼고 다시 붙인다 (화면마다 코드 형태가 달라서)
      const bare = String(req.params.code).replace(/_(AL|NX)$/i, "");
      const targets = [
        { key: "krx", label: "KRX", code: bare },
        { key: "nxt", label: "NXT", code: `${bare}_NX` },
        { key: "all", label: "통합", code: `${bare}_AL` },
      ];

      const num = (v: unknown) => {
        const n = Number(String(v ?? "").replace(/[+,\s]/g, ""));
        return Number.isFinite(n) ? Math.abs(n) : null;
      };

      // 초당 5회 제한 안쪽이라 한 번에 보낸다
      const rows = await Promise.all(
        targets.map(async (t) => {
          try {
            /*
             * ⚠️ **`ka10001` 이 아니라 `ka10007`.**
             *
             * `ka10001`(주식기본정보)에는 **거래대금이 없다.** 거래량만 준다.
             * 그래서 요약줄의 거래대금이 일봉에서 오고 있었고, 개장 전에는 어제 값이
             * 그대로 남아 08~09시 NXT 프리마켓에 「0억」이 떴다.
             *
             * `ka10007`(시세표성정보)은 같은 값에 **`trde_prica` 까지** 준다. 접미사도
             * 그대로 먹는다 — 09:13 실측으로 KRX 19,425억 + NXT 16,736억 = 통합 36,161억,
             * 정확히 합계다.
             */
            const { data } = await client.request<Record<string, unknown>>(
              MRKCOND_RESOURCE,
              "ka10007",
              { stk_cd: t.code },
            );
            return {
              key: t.key,
              label: t.label,
              price: num(data.cur_prc),
              open: num(data.open_pric),
              high: num(data.high_pric),
              low: num(data.low_pric),
              volume: num(data.trde_qty),
              /*
               * **거래대금도 거래소별로 준다.**
               *
               * 요약줄의 거래대금은 KRX 조회 하나에서만 오고 있었다. 그래서 08~09시
               * NXT 프리마켓에는 KRX 가 장전 시간외 몇 백 주뿐이라 **「거래대금 0억」**
               * 이 떴다 — 정작 그 시간에 실제로 도는 건 NXT 쪽이다.
               *
               * 키움은 백만원 단위로 준다. 억으로 바꾸는 건 화면이 한다.
               */
              tradeValue: num(data.trde_prica),
              // 등락률은 부호가 의미를 가지므로 절댓값을 취하지 않는다
              changeRate: Number(String(data.flu_rt ?? "").replace(/[+,\s]/g, "")) || 0,
              error: null as string | null,
            };
          } catch (err) {
            return {
              key: t.key,
              label: t.label,
              price: null, open: null, high: null, low: null, volume: null, tradeValue: null, changeRate: 0,
              error: err instanceof Error ? err.message : "조회 실패",
            };
          }
        }),
      );

      res.json({ code: bare, exchanges: rows });
    } catch (err) {
      next(err);
    }
  });

  // 신용매매동향 (ka10013) - 융자 신규/상환/잔고, 잔고율
  router.get("/credit/:code", async (req, res, next) => {
    try {
      const { data } = await client.request(STKINFO_RESOURCE, "ka10013", {
        stk_cd: req.params.code,
        dt: todayYyyymmdd(),
        qry_tp: "1", // 1:융자
      });
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  // 일별 거래상세 (ka10015) - 장전/장중/장후 거래 비중, 체결강도, 수급
  // strt_dt는 "조회 시작일"이 아니라 기준일이고, 이 날짜에서 과거로 거슬러 내려온다.
  // 과거 날짜를 넣으면 최신 데이터가 안 나오므로 오늘을 넘겨야 한다.
  router.get("/daily-detail/:code", async (req, res, next) => {
    try {
      const { data } = await client.request(STKINFO_RESOURCE, "ka10015", {
        stk_cd: req.params.code,
        strt_dt: todayYyyymmdd(),
      });
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  // 체결강도 추이 (ka10046 시간별 / ka10047 일별)
  router.get("/strength/:code", async (req, res, next) => {
    try {
      const daily = req.query.mode === "daily";
      const { data } = await client.request(MRKCOND_RESOURCE, daily ? "ka10047" : "ka10046", {
        stk_cd: req.params.code,
      });
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  // 일별 투자자별 순매매 (ka10059) - 개인/외국인/기관 + 기관 세부(투신·연기금 등)
  router.get("/investor-daily/:code", async (req, res, next) => {
    try {
      // amt_qty_tp 1:금액(백만) 2:수량
      const amtQty = req.query.qty === "1" ? "2" : "1";
      const { data } = await client.request(STKINFO_RESOURCE, "ka10059", {
        dt: todayYyyymmdd(),
        stk_cd: req.params.code,
        amt_qty_tp: amtQty,
        trde_tp: "0", // 순매수
        unit_tp: "1000",
      });
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  // 종목별 프로그램매매 추이 (ka90013) - 일자별 프로그램 순매수 금액/수량
  router.get("/program/:code", async (req, res, next) => {
    try {
      const { data } = await client.request(MRKCOND_RESOURCE, "ka90013", {
        stk_cd: req.params.code,
        date: todayYyyymmdd(),
        amt_qty_tp: "1", // 1:금액(백만)
      });
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  /**
   * 업종(지수) 분봉 — ka20005. 지수의 장중 흐름을 그리는 데 쓴다.
   * inds_cd: 001 코스피 / 101 코스닥 / 201 코스피200
   */
  router.get("/index-intraday/:code", async (req, res, next) => {
    try {
      const tic = typeof req.query.tic === "string" ? req.query.tic : "5";
      const { data } = await client.request(CHART_RESOURCE, "ka20005", {
        inds_cd: req.params.code,
        tic_scope: tic,
      });
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  // 업종·테마 분위기 — 이 종목이 속한 섹터가 오늘 오르고 있는지
  router.get("/sector-mood/:code", async (req, res, next) => {
    try {
      /*
       * 업종 등락률은 **키움**이다. 한투 지수업종은 쓸 수 없다 —
       * 대분류가 「시가총액규모대/중/소」라 업종이 아니고, 중분류는 셀트리온·포스코퓨처엠을
       * 「증권」으로 넣는다(실측). 게다가 등락률을 내려면 업종**지수**가 있어야 하는데
       * 표준산업분류에는 지수가 없다.
       *
       * 대신 **표준산업분류를 같이 실어 보낸다.** 이건 키움보다 확실히 자세하다 —
       * 키움이 「전기/전자」 하나로 묶는 삼성전자·SK하이닉스·포스코퓨처엠이
       * 통신방송장비 / 반도체 / 이차전지로 갈린다.
       */
      const [mood, profile] = await Promise.all([
        getSectorMood(client, req.params.code),
        stockProfile(req.params.code).catch(() => null),
      ]);
      res.json({ ...mood, industry: profile?.industry ?? null });
    } catch (err) {
      next(err);
    }
  });

  /**
   * 체결 목록 하나만 — **체결강도를 싸게 얻는 길.**
   *
   * 호가 조회(`orderBook`)는 TR 을 셋 부른다. 시세 요약줄과 체결강도 화면은
   * 체결강도만 있으면 되는데 그때마다 셋을 부르면 **초당 5건 제한**에 금방 닿는다.
   * `ka10003` 하나만 부른다.
   *
   * 체결강도는 `100` 을 넘으면 매수 체결이 우세하다는 뜻이다.
   */
  router.get("/ticks/:code", async (req, res, next) => {
    try {
      const bare = String(req.params.code).replace(/_(AL|NX)$/i, "");
      const { data } = await client.request<Record<string, unknown>>(
        "/api/dostk/stkinfo",
        "ka10003",
        { stk_cd: bare },
      );
      const rows = Array.isArray(data.cntr_infr) ? (data.cntr_infr as Record<string, unknown>[]) : [];
      const n = (v: unknown) => Number(String(v ?? "").replace(/[+,\s]/g, "")) || 0;
      const ticks = rows
        .map((r) => ({
          t: String(r.tm ?? "").trim(),
          price: Math.abs(n(r.cur_prc)),
          // 부호가 방향이다 — 음수면 매도 체결
          qty: Number(String(r.cntr_trde_qty ?? "").replace(/[,\s]/g, "")) || 0,
          strength: n(r.cntr_str),
          rate: Number(String(r.pre_rt ?? "").replace(/[+,\s]/g, "")) || 0,
        }))
        .filter((r) => r.t.length >= 6 && r.price > 0);
      res.json({ code: bare, strength: ticks[0]?.strength ?? null, ticks });
    } catch (err) {
      next(err);
    }
  });

  /**
   * 장중 기준선 — VWAP · 시가갭 · 전일고저 · 장초반 30분.
   * 분봉 + 일봉 두 번 조회다. 개별종목 화면에서만 부른다.
   */
  router.get("/intraday/:code", async (req, res, next) => {
    try {
      res.json({ levels: await intradayLevels(client, req.params.code) });
    } catch (err) {
      next(err);
    }
  });

  // 분봉 차트 (ka10080)
  router.get("/chart/minute/:code", async (req, res, next) => {
    try {
      const tic = typeof req.query.tic_scope === "string" ? req.query.tic_scope : "1";
      const { data } = await client.request(CHART_RESOURCE, "ka10080", {
        stk_cd: req.params.code,
        tic_scope: tic,
        upd_stkpc_tp: "1",
      });
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  /*
   * 증권사 목표주가·투자의견 (한국투자증권). 키움에 없는 값이다.
   *
   * 현재가는 여기서 키움으로 받아 넘긴다 — 한투가 주는 건 의견을 낸 날의 전일종가라
   * 그걸로 괴리율을 재면 며칠 묵은 값이 나온다.
   */
  /*
   * 체결금액대별 매매비중 — 하루 거래를 체결 한 건의 금액 크기별로 쪼갠다.
   * 소액 구간이 사고 고액 구간이 팔면 개인이 받고 큰손이 던지는 중이다.
   */
  router.get("/trade-size/:code", async (req, res, next) => {
    try {
      res.json({ rows: await tradeSizeMix(client, req.params.code) });
    } catch (err) {
      next(err);
    }
  });

  router.get("/opinion/:code", async (req, res, next) => {
    try {
      if (!hantooReady()) {
        res.status(503).json({ error: "한국투자증권 API 키가 설정되지 않았습니다" });
        return;
      }
      let price: number | null = null;
      try {
        const { data } = await client.request<{ stk_prpr?: string }>(
          STKINFO_RESOURCE,
          "ka10001",
          { stk_cd: req.params.code },
        );
        const p = Math.abs(Number(data.stk_prpr));
        if (Number.isFinite(p) && p > 0) price = p;
      } catch {
        // 현재가를 못 받아도 의견은 보여 준다 — 괴리율만 묵은 값이 된다
      }
      res.json(await analystOpinion(req.params.code, price));
    } catch (err) {
      next(err);
    }
  });

  /*
   * 야후 심볼 차트 — 전광판의 미국 지수·원자재를 눌렀을 때.
   * 숫자 한 줄만 보면 「어디쯤인가」를 모른다.
   */
  router.get("/yahoo-chart", async (req, res, next) => {
    try {
      const symbol = String(req.query.symbol ?? "").trim();
      if (!symbol) {
        res.status(400).json({ error: "symbol 이 필요합니다" });
        return;
      }
      const range = CHART_RANGES.includes(String(req.query.range))
        ? String(req.query.range)
        : "6mo";
      res.json(await yahooChart(symbol, range));
    } catch (err) {
      next(err);
    }
  });

  /* 야간선물 차트 — 전광판의 그 줄을 눌렀을 때 */
  router.get("/futures-chart", async (req, res, next) => {
    try {
      const code = String(req.query.code ?? "").trim();
      if (!code) {
        res.status(400).json({ error: "code 가 필요합니다" });
        return;
      }
      const market = req.query.market === "F" ? "F" : "CM";
      const period = ["D", "W", "M"].includes(String(req.query.period))
        ? (String(req.query.period) as "D" | "W" | "M")
        : "D";
      const days = Math.min(Math.max(Number(req.query.days) || 120, 10), 800);
      res.json({ code, market, period, ...(await futuresCandles(code, market, period, days)) });
    } catch (err) {
      next(err);
    }
  });

  /*
   * 해외종목 상세 — 관심종목(해외)·전광판·미국 테마 MAP 에서 종목을 눌렀을 때.
   * 국내는 누르면 열리는데 해외는 표에서 끊겼다.
   */
  router.get("/us-detail/:symbol", async (req, res, next) => {
    try {
      res.json(await usDetail(String(req.params.symbol).trim().toUpperCase()));
    } catch (err) {
      next(err);
    }
  });

  router.get("/us-chart/:symbol", async (req, res, next) => {
    try {
      const period = ["D", "W", "M"].includes(String(req.query.period))
        ? (String(req.query.period) as "D" | "W" | "M")
        : "D";
      res.json(await usCandles(String(req.params.symbol).trim().toUpperCase(), period));
    } catch (err) {
      next(err);
    }
  });

  /*
   * 호가창 — 종목 상세와 종목분석이 **같은 것**을 쓴다.
   * 두 화면이 각자 그리면 언젠가 한쪽만 고쳐져 같은 종목이 다르게 보인다.
   */
  router.get("/orderbook/:code", async (req, res, next) => {
    try {
      res.json(await orderBook(client, String(req.params.code)));
    } catch (err) {
      next(err);
    }
  });

  /*
   * 거래원 — 창구별 매매. 시간대별은 키움이 안 줘서 **부를 때마다 한 점씩 쌓는다.**
   */
  router.get("/broker-flow/:code", async (req, res, next) => {
    try {
      res.json(await brokerFlow(client, String(req.params.code)));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
