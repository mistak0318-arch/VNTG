import { Router } from "express";
import { clearHidden, listHidden, setHidden } from "../hiddenThemes.js";
import type { KiwoomClient } from "../kiwoomClient.js";
import { alCode } from "../alCode.js";
import { peekRealtime } from "../realtimeHub.js";
import { viDirText } from "../realtimeStore.js";
import { intradayLevels } from "../intraday.js";
import { stockSummary } from "../stockSummary.js";
import { getSectorMood } from "../sectorMood.js";
import { findStock, searchStocks } from "../stockListCache.js";
import { analystOpinion } from "../analystOpinion.js";
import { hantooReady } from "../hantooClient.js";
import { stockProfile } from "../stockProfile.js";
import { tradeSizeMix } from "../tradeSizeMix.js";
import { CHART_RANGES, yahooChart } from "../yahooChart.js";
import { usEtfHoldings } from "../usEtfHoldings.js";
import { themeStrength } from "../themeStrength.js";
import { marketThermo, themeRotation, usOvernight } from "../marketLens.js";
import { buildCloses, closesProgress, loadCloses } from "../dailyCloses.js";
import { themeLinks } from "../themeLinks.js";
import {
  fetchAllThemes,
  loadThemes,
  refreshEtfs,
  refreshUsThemes,
  themeFetchProgress,
  themeSummary,
  themesOfStock,
} from "../naverThemes.js";
import { futuresCandles } from "../kospiFutures.js";
import { usCandles, usDetail } from "../usDetail.js";
import { orderBook } from "../orderBook.js";
import { brokerFlow } from "../brokerFlow.js";
import { getEtfInfo } from "../etfInfo.js";
import { etfRowOf, etfTaxInfo } from "./etf.js";
import { futuresFlow } from "../naverFuturesFlow.js";
import { intradayFlow, type FlowMarket } from "../naverIntradayFlow.js";

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

  /** 코스피200 선물 투자자별 수급 — 네이버 (키움엔 없다). 10분 캐시 */
  router.get("/futures-flow", async (req, res, next) => {
    try {
      res.json({ days: await futuresFlow(Math.min(Number(req.query.days) || 30, 60)) });
    } catch (err) {
      next(err);
    }
  });

  /**
   * 장중 투자자별 누적 순매수 (2026-08-26) — 코스피(01)·코스닥(02)·K200선물(03).
   * 네이버 Time 표(2분 간격 누적)를 하루치로 모아 준다. 단위: 01/02 억원, 03 계약.
   * 시트를 열 때만 부른다 — 하루치가 요청 30여 개라 상시 폴링할 값이 아니다.
   */
  router.get("/intraday-flow", async (req, res, next) => {
    try {
      const m = String(req.query.market ?? "01");
      if (!["01", "02", "03"].includes(m)) {
        res.status(400).json({ error: "market 은 01·02·03 입니다" });
        return;
      }
      res.json(await intradayFlow(m as FlowMarket));
    } catch (err) {
      next(err);
    }
  });

  /*
   * ETF 구성종목 — 키움 REST 엔 없는 값이라 네이버 etfAnalysis 를 쓴다 (etfInfo.ts).
   * ETF 가 아니면 {etf:false} — 화면이 이걸 보고 탭을 숨긴다. 6시간 캐시.
   *
   * (2026-08-27) 키움 값도 병합한다 — **과세유형**(ka40002, 비과세/보유기간과세 —
   * 퇴직연금 세금 판단), **추적오차·NAV·괴리율**(ka40004 리스트 캐시). 네이버 NAV 와
   * 키움 NAV 가 둘 다 있으면 키움 것을 쓴다(장중 갱신이 더 잦다).
   */
  router.get("/etf/:code", async (req, res, next) => {
    try {
      const info = await getEtfInfo(req.params.code);
      if (!info.etf) return res.json(info);
      const [tax, row] = await Promise.all([
        etfTaxInfo(client, req.params.code).catch(() => null),
        etfRowOf(client, req.params.code).catch(() => null),
      ]);
      res.json({
        ...info,
        taxType: tax?.taxType || undefined,
        nav: row?.nav ?? info.nav,
        deviation: row?.deviation ?? info.deviation,
        traceErr: row?.traceErr ?? undefined,
        baseIndex: info.baseIndex || tax?.index || row?.index || undefined,
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * 지금 이 현재가가 **어느 시장 값인가** (2026-08-26 — 「NXT 값일 땐 NXT 라고
   * 표기해 달라」). ka10001 응답엔 없어서 시각으로 라벨을 정한다 — NXT 운영시간
   * (프리 08:00~08:50 · 정규 09:00~15:30 KRX 와 병행 · 애프터 15:30~20:00).
   */
  function venueNow(): string {
    const kst = new Date(Date.now() + 9 * 3600_000);
    const day = kst.getUTCDay();
    if (day === 0 || day === 6) return "마감";
    const m = kst.getUTCHours() * 60 + kst.getUTCMinutes();
    if (m >= 8 * 60 && m < 8 * 60 + 50) return "NXT 프리마켓";
    if (m >= 8 * 60 + 50 && m < 9 * 60) return "장전 시간외";
    if (m >= 9 * 60 && m < 15 * 60 + 30) return "정규장";
    if (m >= 15 * 60 + 30 && m < 20 * 60) return "NXT 애프터마켓";
    return "마감";
  }

  // 종목 기본정보 (ka10001) - 종목명, 현재가, 등락률 등
  router.get("/info/:code", async (req, res, next) => {
    try {
      const { data } = await client.request(STKINFO_RESOURCE, "ka10001", {
        /*
         * 통합(_AL) — 2026-08-26. KRX 단독은 NXT 프리·애프터 체결이 안 보여서
         * 「관심종목에 NXT 값이 안 들어온다」가 됐다. 키움 앱(통합)과 같은 기준.
         */
        stk_cd: alCode(req.params.code),
      });
      /*
       * 시장 구분을 얹는다 (2026-08-25) — ka10001 엔 코스피/코스닥이 없다.
       * 전종목 캐시(ka10099)에서 붙이므로 조회가 늘지 않는다. 밑줄 접두는
       * 「키움 응답이 아니라 우리가 붙인 것」이라는 표시다.
       */
      const entry = await findStock(client, req.params.code).catch(() => undefined);
      /*
       * VI 발동 표시 (2026-08-26 — 「멈춰 있으면 헷갈린다」). 실시간 저장소의 오늘
       * VI 중 이 종목 것을 찾는다: 해제 안 된 게 있으면 「발동 중」, 최근 발동은 시각만.
       */
      const bareCode = req.params.code.replace(/_(AL|NX)$/i, "");
      const viEvents = peekRealtime().store?.getVi(3000) ?? [];
      const myVi = viEvents.find((v) => v.code === bareCode);
      const _vi = myVi
        ? {
            active: !myVi.clearedAt,
            firedAt: myVi.firedAt,
            clearedAt: myVi.clearedAt || null,
            /* ▲상방/▼하방 + 몇 % (2026-08-28) — 헤더 배지가 방향까지 말한다 */
            dirText: viDirText(myVi),
          }
        : null;
      res.json({ ...data, _market: entry?.marketName ?? "", _venue: venueNow(), _vi });
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
      // noAl — 차트는 화면에 KRX/NXT/통합 셀렉터가 있어 코드 접미를 화면이 정한다
      const { data } = await client.request(CHART_RESOURCE, "ka10081", {
        stk_cd: req.params.code,
        base_dt: baseDt,
        upd_stkpc_tp: "1", // 수정주가 반영
      }, { noAl: true });
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
      }, { noAl: true });
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
      }, { noAl: true });
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  // 종목별 투자자(외인/기관) 순매매 차트 (ka10060)
  router.get("/chart/investor/:code", async (req, res, next) => {
    try {
      const dt = typeof req.query.dt === "string" ? req.query.dt : todayYyyymmdd();
      /*
       * 며칠치 (2026-08-31 요청 — 「30일밖에 안 되네, 60·120·240 정도로」).
       *
       * ⚠️ 한 번 부르면 **100줄**이 온다(실측: 삼성전자 2026-04-03~08-28).
       * 그래서 60·120 은 조회가 안 늘고, 240 만 한 쪽 더 넘긴다. 안 물어보면
       * 예전 그대로 한 번만 부른다 — 화면 열 때마다 세 번 부르면 안 된다.
       */
      const want = Math.max(1, Math.min(400, Number(req.query.days) || 0));
      const params = {
        dt,
        // 통합(_AL) — 키움 앱(통합)과 수급이 달랐던 원인 (2026-08-26 실측: NXT 미포함)
        stk_cd: alCode(req.params.code),
        amt_qty_tp: "1", // 1:금액(백만원)
        trde_tp: "0", // 0:순매수
        unit_tp: "1000",
      };
      const first = await client.request<Record<string, unknown>>(CHART_RESOURCE, "ka10060", params);
      const data = first.data;
      const rows = (data.stk_invsr_orgn_chart as Record<string, unknown>[]) ?? [];
      let contYn = first.contYn;
      let nextKey = first.nextKey;
      for (let page = 0; page < 4 && rows.length < want && contYn === "Y" && nextKey; page += 1) {
        const more = await client.request<Record<string, unknown>>(CHART_RESOURCE, "ka10060", params, {
          contYn: "Y",
          nextKey,
        });
        const add = (more.data.stk_invsr_orgn_chart as Record<string, unknown>[]) ?? [];
        if (add.length === 0) break;
        rows.push(...add);
        contYn = more.contYn;
        nextKey = more.nextKey;
      }
      data.stk_invsr_orgn_chart = rows;
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
        /*
         * 통합(_AL) — 2026-08-26 실측. KRX 단독은 매매비중 분모(거래대금)가 작아
         * 4.59% 로 나왔는데 키움 앱(통합)은 2.79% 였다. _AL 이 앱과 천원 단위까지
         * 일치(공매도 대금 302,272,068).
         */
        stk_cd: alCode(req.params.code),
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
      const bareCd = req.params.code.replace(/_(AL|NX)$/i, "");
      const { data } = await client.request<Record<string, unknown>>(STKINFO_RESOURCE, "ka10002", {
        // 통합(_AL) — NXT 물량이 많은 창구(키움 등)가 KRX 단독에선 반토막으로 보였다.
        // ?stex=krx|nxt 는 진단용 — 기준이 의심될 때 단독값과 맞대 본다
        stk_cd:
          req.query.stex === "krx"
            ? bareCd
            : req.query.stex === "nxt"
              ? `${bareCd}_NX`
              : alCode(bareCd),
      }, { noAl: true });
      /*
       * 새벽엔 통합·단독 모두 빈 값이라 _AL 미지원 여부를 아직 실측 못 했다.
       * 만약 _AL 이 빈 응답이면 단독으로 한 번 더 — 기준이 좁아지는 건 아쉽지만
       * 거래원 패널이 통째로 비는 것보단 낫다.
       */
      const empty = !String(data?.buy_trde_qty_1 ?? "").replace(/[0\s]/g, "") &&
        !String(data?.sel_trde_qty_1 ?? "").replace(/[0\s]/g, "");
      if (empty && req.query.stex !== "krx") {
        const retry = await client.request(STKINFO_RESOURCE, "ka10002", {
          stk_cd: req.params.code,
        });
        const retryHas = String(retry.data?.buy_trde_qty_1 ?? "").replace(/[0\s]/g, "");
        if (retryHas) {
          res.json(retry.data);
          return;
        }
      }
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  // 시세표성정보 (ka10007) - 시/고/저/기준가/상하한가/예상체결 등 시세 한 덩어리
  router.get("/snapshot/:code", async (req, res, next) => {
    try {
      const { data } = await client.request(MRKCOND_RESOURCE, "ka10007", {
        // 통합(_AL) — 거래대금·거래량이 키움 앱(통합)과 같아야 한다
        stk_cd: alCode(req.params.code),
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
            /*
             * ⚠️ noAl (2026-08-26) — 이 라우트는 접미를 **스스로** 관리한다(KRX=bare).
             * 중앙 _AL 래퍼가 bare 를 _AL 로 바꿔서 KRX 줄에 통합 값이 들어갔었다 —
             * 「모든 종목의 NXT 고저가 KRX 와 똑같다」의 원인.
             */
            const { data } = await client.request<Record<string, unknown>>(
              MRKCOND_RESOURCE,
              "ka10007",
              { stk_cd: t.code },
              { noAl: true },
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
              /* 상장주식수(천주) — 회전율을 내려면 있어야 한다. 거래소가 달라도 같은 값이다 */
              shares: num(data.flo_stkcnt),
              // 등락률은 부호가 의미를 가지므로 절댓값을 취하지 않는다
              changeRate: Number(String(data.flu_rt ?? "").replace(/[+,\s]/g, "")) || 0,
              error: null as string | null,
            };
          } catch (err) {
            return {
              key: t.key,
              label: t.label,
              price: null, open: null, high: null, low: null, volume: null, tradeValue: null,
              shares: null, changeRate: 0,
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
        // 통합(_AL) — 거래 비중·수급이 키움 앱(통합)과 같아야 한다
        stk_cd: alCode(req.params.code),
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
        // 통합(_AL) — 체결강도도 전체 체결 기준
        stk_cd: alCode(req.params.code),
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
      /*
       * 며칠치가 필요한가 (2026-08-31 요청 — 「30일밖에 안 되네, 240일까지」).
       *
       * ⚠️ 한 번 부르면 **100줄**이 온다(실측: 삼성전자 2026-04-03~08-28).
       * 60·120일은 그 안에서 해결되지만 240일은 **연속조회**가 있어야 한다.
       * 필요한 만큼만 넘긴다 — 넉넉히 부르면 조회 수만 버린다.
       */
      const want = Math.max(1, Math.min(400, Number(req.query.days) || 30));
      const params = {
        dt: todayYyyymmdd(),
        /*
         * 통합(_AL) — 2026-08-26 실측. KRX 단독은 하이닉스 8/25 개인 +618,857 인데
         * 키움 앱(통합)은 +802,218 이었다(NXT 몫 누락). _AL 이 앱과 자리수까지 일치.
         */
        stk_cd: alCode(req.params.code),
        amt_qty_tp: amtQty,
        trde_tp: "0", // 순매수
        unit_tp: "1000",
      };
      const first = await client.request<Record<string, unknown>>(
        STKINFO_RESOURCE,
        "ka10059",
        params,
      );
      const data = first.data;
      const rows = (data.stk_invsr_orgn as Record<string, unknown>[]) ?? [];
      let contYn = first.contYn;
      let nextKey = first.nextKey;
      /* 다섯 쪽이면 500줄 — 400일을 달라 해도 넘친다. 무한 루프 방지도 겸한다 */
      for (let page = 0; page < 5 && rows.length < want && contYn === "Y" && nextKey; page += 1) {
        const more = await client.request<Record<string, unknown>>(
          STKINFO_RESOURCE,
          "ka10059",
          params,
          { contYn: "Y", nextKey },
        );
        const add = (more.data.stk_invsr_orgn as Record<string, unknown>[]) ?? [];
        if (add.length === 0) break;
        rows.push(...add);
        contYn = more.contYn;
        nextKey = more.nextKey;
      }
      data.stk_invsr_orgn = rows;
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  // 종목별 프로그램매매 추이 (ka90013) - 일자별 프로그램 순매수 금액/수량
  router.get("/program/:code", async (req, res, next) => {
    try {
      const { data } = await client.request(MRKCOND_RESOURCE, "ka90013", {
        // 통합(_AL) — 프로그램도 NXT 몫 포함 (실측: _AL 로 값이 온다)
        stk_cd: alCode(req.params.code),
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
  /**
   * 업종(지수) 일봉 — ka20006. 손질 전 원본 그대로.
   *
   * `indexDetail` 이 이미 이 조회를 쓰지만 **캔들만 꺼내 쓴다.** 거래량·거래대금 같은
   * 필드가 실제로 오는지는 원본을 봐야 안다 — 분봉(`index-intraday`)과 같은 자리에 둔다.
   */
  router.get("/index-daily/:code", async (req, res, next) => {
    try {
      const { data } = await client.request(CHART_RESOURCE, "ka20006", {
        inds_cd: req.params.code,
        base_dt: todayYyyymmdd(),
      });
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

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
      /*
       * 네이버 테마를 **같이 실어 보낸다** (2026-08-28) — 조회가 아니라 파일이라 공짜다.
       * 키움 테마는 묶음이 거칠어서 「왜 여기 있나」가 안 풀렸는데, 네이버는 종목마다
       * 편입 사유가 한 줄씩 붙어 있다. 그 한 줄이 이 화면에서 제일 쓸모 있다.
       */
      const [mood, profile, naver] = await Promise.all([
        getSectorMood(client, req.params.code),
        stockProfile(req.params.code).catch(() => null),
        themesOfStock(req.params.code).catch(() => []),
      ]);
      res.json({ ...mood, industry: profile?.industry ?? null, naverThemes: naver });
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
   * 종목 한 장 요약 — 몸값(시총·회전율·체결강도)과 오늘 수급(개인·외국인·기관 세부·프로그램).
   * 조회 넷을 서버에서 합친다 — 화면이 따로 부르면 조각조각 뜬다.
   */
  router.get("/summary/:code", async (req, res, next) => {
    try {
      res.json(await stockSummary(client, req.params.code));
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
      }, { noAl: true });
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

  /* ---------------- 네이버 테마 DB (2026-08-28) ---------------- */

  /** 저장된 테마 — 화면이 읽는 자리. 조회가 없다(파일에서 읽는다) */
  router.get("/naver-themes", async (_req, res, next) => {
    try {
      res.json(await loadThemes());
    } catch (err) {
      next(err);
    }
  });

  /** 요약 — 「언제 받은 것인가」 */
  router.get("/naver-themes/summary", async (_req, res, next) => {
    try {
      res.json(await themeSummary());
    } catch (err) {
      next(err);
    }
  });

  /** 받는 중인지 — 10분 넘게 걸리므로 화면이 진행률을 물어본다 */
  router.get("/naver-themes/progress", (_req, res) => {
    res.json(themeFetchProgress());
  });

  /**
   * 다시 받기 — **사람이 눌러야 돈다.**
   *
   * 테마 구성은 매일 바뀌는 값이 아니라 주 1회면 충분하다. 자동 스케줄을 걸어 두면
   * 쓰지도 않는 데이터를 매일 300장씩 받게 된다.
   * `limit` 은 시험용이다(앞에서 몇 개만).
   */
  router.post("/naver-themes/fetch", async (req, res, next) => {
    try {
      const limit = Number(req.query.limit) || undefined;
      // 기다리지 않는다 — 10분짜리 작업이라 응답을 붙들면 브라우저가 먼저 끊는다
      void fetchAllThemes({ limit }).catch(() => undefined);
      res.json({ started: true, limit: limit ?? null });
    } catch (err) {
      next(err);
    }
  });

  /**
   * 테마 강도 — 분류는 파일, 숫자는 스냅샷. **조회가 0회다.**
   * 등락률·상승비율·연속성을 우리가 계산하므로 국내·ETF·미국이 같은 자로 재진다.
   */
  router.get("/theme-strength/:market", async (req, res, next) => {
    try {
      const m = req.params.market;
      const market = m === "us" ? "us" : m === "etf" ? "etf" : "kr";
      /* `?hidden=1` 은 **되살리는 화면만** 쓴다 — 평소 목록에는 숨긴 것이 안 온다 */
      const includeHidden = req.query.hidden === "1";
      const r = await themeStrength(market, { includeHidden });
      res.json({ ...r, hidden: await listHidden() });
    } catch (err) {
      next(err);
    }
  });

  /**
   * 테마 숨기기 / 되살리기 (2026-08-30).
   *
   * 네이버에서 긁어온 분류라 **지울 수는 없다** — 지워도 다음 동기화에 돌아온다.
   * 그래서 원본은 두고 가리개만 우리가 갖는다. 여기서 바꾸면 테마 DB·MAP·신호등이
   * 전부 따라온다(themeStrength 한 곳에서 거르므로).
   */
  router.put("/theme-hidden", async (req, res, next) => {
    try {
      const keys = (req.body?.keys ?? []) as string[];
      const hidden = Boolean(req.body?.hidden);
      res.json({ hidden: await setHidden(Array.isArray(keys) ? keys : [], hidden) });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/theme-hidden", async (_req, res, next) => {
    try {
      res.json({ hidden: await clearHidden() });
    } catch (err) {
      next(err);
    }
  });

  /**
   * 시장 렌즈 — 체온계(일봉 캐시로 소급 계산) + 테마 로테이션 + 미국 밤사이.
   * 장전 브리핑·마켓 브리핑·시장 흐름이 같은 판을 나눠 본다. 조회 0회.
   */
  router.get("/lens", async (_req, res, next) => {
    try {
      const [thermo, rotation, us] = await Promise.all([
        marketThermo(),
        themeRotation(),
        usOvernight(),
      ]);
      res.json({ thermo, rotation, us });
    } catch (err) {
      next(err);
    }
  });

  /** 테마 브리핑 — 국내·미국이 같은 이야기를 하는 짝과 「누가 앞서나」 */
  router.get("/theme-links", async (_req, res, next) => {
    try {
      res.json(await themeLinks());
    } catch (err) {
      next(err);
    }
  });

  /** 미국 테마만 다시 받기 — 63장 안팎이라 2분이면 끝난다 */
  router.post("/naver-themes/fetch-us", async (_req, res, next) => {
    try {
      void refreshUsThemes().catch(() => undefined);
      res.json({ started: true });
    } catch (err) {
      next(err);
    }
  });

  /**
   * 일봉 캐시 다시 받기 — 10분쯤 걸린다(3,000종목 안팎, 초당 5건 제한).
   * 평소엔 장 마감 뒤 자동으로 돈다.
   */
  router.post("/daily-closes/build", async (_req, res, next) => {
    try {
      void buildCloses(client).catch(() => undefined);
      res.json({ started: true });
    } catch (err) {
      next(err);
    }
  });

  router.get("/daily-closes/progress", (_req, res) => {
    res.json(closesProgress());
  });

  /** 언제 받았고 몇 종목이 들어 있나 — 「—」가 뜰 때 원인을 가리려면 이게 있어야 한다 */
  router.get("/daily-closes/summary", async (_req, res, next) => {
    try {
      const s = await loadCloses();
      res.json({ builtAt: s.builtAt, total: Object.keys(s.closes).length });
    } catch (err) {
      next(err);
    }
  });

  /** ETF 목록 — **요청 한 번**이라 기다렸다 결과를 준다 */
  router.post("/naver-themes/fetch-etf", async (_req, res, next) => {
    try {
      res.json(await refreshEtfs());
    } catch (err) {
      next(err);
    }
  });

  /*
   * 미국 ETF 구성종목 — 섹터 MAP 타일을 눌렀을 때 「무엇이 들었나」 (2026-08-27).
   * 「소프트웨어 +6%」만 봐서는 무엇이 밀어 올렸는지를 모른다. 하루 캐시다.
   */
  router.get("/us-etf-holdings", async (req, res, next) => {
    try {
      const symbol = String(req.query.symbol ?? "").trim();
      if (!symbol) {
        res.status(400).json({ error: "symbol 이 필요합니다" });
        return;
      }
      res.json(await usEtfHoldings(symbol));
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
