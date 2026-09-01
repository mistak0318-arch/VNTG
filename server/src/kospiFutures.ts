import { hantooGet, hantooReady } from "./hantooClient.js";

/**
 * KOSPI200 선물 — 키움에 없어서 한국투자증권에서 받는다.
 *
 * **코스피200 옆에 선물이 있어야 뜻이 생긴다.** 둘의 차이가 베이시스인데,
 * 선물이 현물보다 더 빠지면(백워데이션) 프로그램 매도가 붙는다. 키움 HTS 가 두 칸을
 * 나란히 붙여 놓은 이유가 그것이다.
 *
 * **월물코드를 박아 두면 안 된다.** 3개월마다 바뀐다. 전광판에서 목록을 받아
 * 최근월물(맨 앞)을 쓴다 — 거래가 몰리는 건 늘 최근월물이다.
 */

const BOARD = "/uapi/domestic-futureoption/v1/quotations/display-board-futures";
const BOARD_TR = "FHPIF05030200";
const CHART = "/uapi/domestic-futureoption/v1/quotations/inquire-time-fuopchartprice";
const CHART_TR = "FHKIF03020200";

export interface FuturesQuote {
  /** 종목코드 (예: A01609) — 월물마다 바뀐다 */
  code: string;
  /** 예: "F 202609" */
  name: string;
  price: number | null;
  change: number | null;
  changeRate: number | null;
  /** 이론가 — 현재가와 벌어지면 차익거래가 낄 자리다 */
  theoretical: number | null;
  /** 미결제약정. 지수 방향과 같이 봐야 뜻이 생긴다 */
  openInterest: number | null;
  volume: number | null;
  /** 선물 − 현물. 음수면 백워데이션이고 프로그램 매도가 붙기 쉽다 */
  basis: number | null;
  /** 장중 흐름 — 코스피·코스닥 카드와 같은 모양으로 그리려면 이게 있어야 한다 */
  sparkline: number[];
}

/**
 * 장중 흐름.
 *
 * 선물을 코스피200 밑에 한 줄로 붙였더니 **차트도 수급도 볼 수가 없었다.** 선물을 보는
 * 이유가 장중에 현물보다 먼저 움직이는 걸 보려는 것인데, 숫자만 있으면 그 흐름이 안 보인다.
 * 그래서 코스피·코스닥과 **같은 카드**로 만들고 스파크라인을 붙인다.
 *
 * 분봉은 날짜를 반드시 줘야 한다 — 비워 두면 `INVALID FID_INPUT_DATE_1` 이 난다.
 */
async function futuresSparkline(code: string): Promise<number[]> {
  try {
    const d = fmtDay(new Date());
    const body = await hantooGet<{ output2?: Record<string, unknown>[] }>(
      CHART,
      CHART_TR,
      {
        FID_COND_MRKT_DIV_CODE: "F",
        FID_INPUT_ISCD: code,
        FID_HOUR_CLS_CODE: "60", // 60초봉
        FID_PW_DATA_INCU_YN: "Y",
        FID_FAKE_TICK_INCU_YN: "N",
        FID_INPUT_DATE_1: d,
        FID_INPUT_HOUR_1: "160000",
      },
      "코스피200 선물",
    );
    // 최신순으로 오므로 뒤집어 시간순으로 만든다
    return (body.output2 ?? [])
      .map((r) => Number(r.futs_prpr))
      .filter((n) => Number.isFinite(n) && n > 0)
      .reverse();
  } catch {
    return [];
  }
}

function num(v: unknown): number | null {
  const n = Number(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/*
 * 전광판 하나로 끝난다.
 *
 * 처음엔 「전광판으로 월물코드를 받고 → 시세를 따로 조회」로 짰는데, 응답을 열어 보니
 * **전광판이 현재가·등락률·이론가·미결제까지 다 주고 있었다.** 호출이 반으로 줄고
 * 실패할 자리도 하나 없어진다.
 *
 * 그리고 배열 키가 `output1` 이 아니라 **`output`** 이다 — 문서에 적힌 것과 달랐다.
 * 다른 선물옵션 TR 은 output1 을 쓰므로 둘 다 본다.
 */
export async function kospi200Futures(spot?: number | null): Promise<FuturesQuote | null> {
  if (!hantooReady()) return null;
  try {
    const body = await hantooGet<{
      output?: Record<string, unknown>[];
      output1?: Record<string, unknown>[];
    }>(
      BOARD,
      BOARD_TR,
      {
        FID_COND_MRKT_DIV_CODE: "F",
        FID_COND_SCR_DIV_CODE: "20503",
        FID_COND_MRKT_CLS_CODE: "", // 공백 = KOSPI200 (MKI 미니, KQI 코스닥150)
      },
      "코스피200 선물",
    );
    // 맨 앞이 최근월물이다 — 거래가 몰리는 건 늘 최근월물이라 이것만 본다
    const o = (body.output ?? body.output1 ?? [])[0];
    if (!o) return null;

    const code = String(o.futs_shrn_iscd ?? "").trim();
    const price = num(o.futs_prpr);
    if (!code || price === null) return null;

    return {
      code,
      name: String(o.hts_kor_isnm ?? "").trim(),
      price,
      change: num(o.futs_prdy_vrss),
      changeRate: num(o.futs_prdy_ctrt),
      theoretical: num(o.hts_thpr),
      openInterest: num(o.hts_otst_stpl_qty),
      volume: num(o.acml_vol),
      basis: spot != null && spot > 0 ? price - spot : null,
      sparkline: await futuresSparkline(code),
    };
  } catch {
    // 선물 하나 때문에 대시보드가 멈추면 안 된다
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 일봉                                                                */
/* ------------------------------------------------------------------ */

const DAILY = "/uapi/domestic-futureoption/v1/quotations/inquire-daily-fuopchartprice";
const DAILY_TR = "FHKIF03020100";

export interface FuturesCandle {
  t: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const fmtDay = (d: Date) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;

/**
 * **당일 분봉** (2026-09-01) — 벤티지: "코스피 야간선물 그래프도 당일 그래프
 * 좀 그려줘 일봉 주봉 월봉 이렇게 하고."
 *
 * 일·주·월봉은 있었는데 **당일이 없었다.** 그런데 야간선물은 「오늘 개장가의
 * 예고편」이라, 정작 보고 싶은 건 밤사이 어떻게 흘렀나다 — 일봉 한 칸으로는
 * 그게 안 보인다.
 *
 * 분봉 TR 은 **이미 쓰고 있던 것**이다(`futuresSparkline`). 전광판 카드의
 * 스파크라인이 이걸로 그려진다 — 다만 낮 선물(`F`)에만 쓰고 있었다. 시장만
 * `CM` 으로 갈아 끼우면 야간이 나온다.
 *
 * ⚠️ **날짜를 반드시 준다.** 비워 두면 `INVALID FID_INPUT_DATE_1` 이 난다 —
 * 스파크라인에서 겪고 적어 둔 것이다.
 *
 * ⚠️ **야간 세션은 날짜를 넘어간다.** 18:00 에 시작해 다음 날 새벽에 끝나므로,
 * 새벽에 열면 「오늘」에는 앞부분이 없다. 자정 전이면 오늘로, 자정 넘어서면
 * 어제로 묻는다 — 그래야 세션 한 판이 통째로 나온다.
 */
async function intradayCandles(
  code: string,
  market: "F" | "CM",
): Promise<{ candles: FuturesCandle[]; error: string | null }> {
  const now = new Date();
  /* 야간은 전날 저녁에 시작한다 — 새벽이면 어제 날짜로 물어야 세션이 안 잘린다 */
  const base =
    market === "CM" && now.getHours() < 9
      ? new Date(now.getTime() - 24 * 3600_000)
      : now;

  const n = (v: unknown) => {
    const x = Number(String(v ?? "").replace(/[+,\s]/g, ""));
    return Number.isFinite(x) ? x : 0;
  };

  /**
   * ## 한투는 야간 시각을 **24시를 넘겨서** 준다 (2026-09-01 실측)
   *
   *   `stck_bsop_date` `20260831` · `stck_cntg_hour` `244200`
   *
   * 이건 「8/31 24:42」, 곧 **9/1 00:42** 다. 날짜는 **세션이 시작한 날**이고
   * 시각은 그 날 18:00 부터 이어 센다. 그대로 화면에 내면 `24:42` 라는 없는
   * 시각이 찍힌다.
   *
   * 덕분에 얻는 게 하나 있다 — `stck_bsop_date` 가 곧 **세션 번호**다.
   * 자정을 넘어도 한 세션은 같은 날짜를 달고 있으므로, 이걸로 「지금 도는
   * 세션만」을 정확히 가를 수 있다.
   */
  const label = (d: string, hm: string): string => {
    let hh = Number(hm.slice(0, 2));
    const mm = hm.slice(2, 4);
    let day = d;
    if (hh >= 24) {
      hh -= 24;
      const next = new Date(
        Number(d.slice(0, 4)),
        Number(d.slice(4, 6)) - 1,
        Number(d.slice(6, 8)) + 1,
      );
      day = fmtDay(next);
    }
    return `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)} ${String(hh).padStart(2, "0")}:${mm}`;
  };

  /**
   * 한 번 부른다 — `endAt` **까지의** 봉을 최신순으로 준다.
   * 실측으로 **한 번에 102봉**이 왔다(2026-09-01 23:05, A01609).
   */
  const page = async (
    day: string,
    endAt: string,
  ): Promise<{ d: string; hm: string; c: FuturesCandle }[]> => {
    const body = await hantooGet<{ output2?: Record<string, unknown>[] }>(
      CHART,
      CHART_TR,
      {
        FID_COND_MRKT_DIV_CODE: market,
        FID_INPUT_ISCD: code,
        FID_HOUR_CLS_CODE: "60", // 60초봉
        FID_PW_DATA_INCU_YN: "Y",
        FID_FAKE_TICK_INCU_YN: "N",
        FID_INPUT_DATE_1: day,
        FID_INPUT_HOUR_1: endAt,
      },
      market === "CM" ? "야간선물 당일" : "선물 당일",
    );
    return (body.output2 ?? [])
      .map((r) => {
        /* 분봉은 날짜와 시각이 따로 온다 — 둘을 합쳐야 순서가 맞는다 */
        const d = String(r.stck_bsop_date ?? "");
        const hm = String(r.stck_cntg_hour ?? "").padStart(6, "0");
        const close = n(r.futs_prpr);
        return {
          d,
          hm,
          c: {
            t: d.length === 8 ? label(d, hm) : hm,
            open: n(r.futs_oprc) || close,
            high: n(r.futs_hgpr) || close,
            low: n(r.futs_lwpr) || close,
            close,
            volume: n(r.cntg_vol),
          },
        };
      })
      .filter((x) => x.c.close > 0 && x.d.length === 8);
  };

  /*
   * ## **뒤로 거슬러 이어붙인다** (2026-09-01)
   *
   * 한투 분봉은 「이 시각까지의 최근 102봉」을 준다. 그래서 한 번만 부르면
   * **최근 한 시간 반뿐**이다 — 실측에서 23:05 에 물었더니 21:24~23:05 만 왔다.
   *
   * 야간 세션은 18:00 에 시작해 다음 날 새벽까지 도니까 그 한 판이 열두 시간이다.
   * 「당일 그래프」라고 해 놓고 끝자락만 보여 주면 밤사이 어디서 꺾였는지가
   * 그대로 안 보인다 — 그게 야간선물을 보는 이유인데.
   *
   * 그래서 **받은 것 중 가장 이른 봉의 1분 전**을 끝으로 다시 묻는다. 날짜도
   * 그 봉에서 가져오므로 자정을 넘는 경계가 저절로 처리된다.
   *
   * ⚠️ **여섯 번까지만.** 102×6 ≈ 열 시간이라 세션 대부분을 덮으면서, 한투에
   * 한 번에 여섯 번 이상 두드리지 않는다. 새 봉이 안 늘면 그 전에 멈춘다.
   */
  /** 한 세션(= `stck_bsop_date` 하나)을 통째로 긁는다 */
  const session = async (want: string): Promise<FuturesCandle[]> => {
    const seen = new Map<string, FuturesCandle>();
    let day = want;
    let endAt = market === "CM" ? "235959" : "160000";

    for (let i = 0; i < 6; i++) {
      const rows = await page(day, endAt);
      /*
       * **이 세션 것만 담는다.** 6판을 거슬러 올라가면 어제 세션까지 딸려 오는데,
       * 그러면 「당일 그래프」에 이틀이 겹쳐 그려진다 — 실제로 610봉 중 앞쪽이
       * 전날 것이었다.
       */
      const mine = rows.filter((r) => r.d === want);
      if (mine.length === 0) break;
      const before = seen.size;
      for (const r of mine) seen.set(r.hm, r.c);
      /* 한 톨도 안 늘면 같은 자리를 다시 받은 것이다 — 더 물어도 소용없다 */
      if (seen.size === before) break;
      /* 응답에 남의 세션이 섞였으면 이 세션의 처음까지 온 것이다 */
      if (mine.length < rows.length) break;

      /* 가장 이른 봉 — 응답은 최신순이지만 믿지 않고 직접 고른다 */
      let firstHm = mine[0].hm;
      for (const r of mine) if (r.hm < firstHm) firstHm = r.hm;

      /* 그 1분 전까지를 다음 판으로. 시각은 24시를 넘어갈 수 있다(야간) */
      const mins = Number(firstHm.slice(0, 2)) * 60 + Number(firstHm.slice(2, 4)) - 1;
      if (mins < 0) break;
      day = want;
      endAt = `${String(Math.floor(mins / 60)).padStart(2, "0")}${String(mins % 60).padStart(2, "0")}59`;
    }
    return [...seen.values()].sort((a, b) => a.t.localeCompare(b.t));
  };

  try {
    let candles = await session(fmtDay(base));
    /*
     * **아직 안 열렸으면 직전 세션을 보여 준다** — 낮(09:00~18:00)에는 오늘
     * 야간이 시작 전이라 빈 화면이 된다. 「밤사이 어떻게 흘렀나」를 보려고 여는
     * 창이니 빈 화면보다 간밤 것이 낫다. 봉의 날짜가 찍히므로 언제 것인지는 보인다.
     */
    if (candles.length === 0 && market === "CM") {
      candles = await session(fmtDay(new Date(base.getTime() - 24 * 3600_000)));
    }
    return {
      candles,
      error:
        candles.length === 0
          ? market === "CM"
            ? "야간 세션 봉이 없습니다 (야간은 18:00 부터입니다)"
            : "봉이 하나도 없습니다"
          : null,
    };
  } catch (err) {
    return { candles: [], error: err instanceof Error ? err.message : "차트 조회 실패" };
  }
}

/**
 * 선물 당일·일·주·월봉.
 *
 * 전광판의 야간선물은 숫자 한 줄뿐이라 **「어디쯤인가」를 모른다.** 눌러서 이걸 연다.
 *
 * `FID_COND_MRKT_DIV_CODE` 에 `CM`(야간선물)을 넣는다 — 참고 문서에 적힌 조합이다.
 * 낮 선물은 `F` 다. 같은 TR 로 시장만 갈아 끼운다.
 *
 * `"I"`(당일)만 **다른 TR** 을 쓴다 — 기간별시세에는 분 단위가 없다.
 */
/*
 * ## 짧은 캐시 (2026-09-01)
 *
 * 벤티지: "일봉에 당일로 간 다음에 좀 딜레이가 걸린다."
 *
 * 맞다. 특히 당일이 한투를 **여섯 번 차례로** 두드린다(102봉씩 뒤로 이어붙이기 —
 * 앞 응답을 봐야 다음을 물으므로 병렬이 안 된다). 탭을 오가면 그걸 매번 다시 한다.
 *
 * 봉은 1분에 한 칸씩 늘고 일·주·월봉은 하루에 한 번 바뀐다. 그래서 **당일은
 * 30초, 나머지는 10분**을 묶어 둔다 — 그 안에서는 탭을 오가도 즉답이다.
 * 실시간성을 해치지 않으면서 왕복을 없앤다.
 */
const chartCache = new Map<string, { at: number; v: { candles: FuturesCandle[]; error: string | null } }>();
const CHART_TTL = { intraday: 30_000, daily: 600_000 };

export async function futuresCandles(
  code: string,
  market: "F" | "CM" = "CM",
  period: "I" | "D" | "W" | "M" = "D",
  days = 120,
): Promise<{ candles: FuturesCandle[]; error: string | null }> {
  if (!hantooReady()) return { candles: [], error: "한투 API 미설정" };

  const key = `${code}|${market}|${period}|${days}`;
  const ttl = period === "I" ? CHART_TTL.intraday : CHART_TTL.daily;
  const hit = chartCache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.v;

  /** 성공한 것만 담는다 — 빈 응답을 굳히면 그 시간 동안 계속 비어 보인다 */
  const keep = (v: { candles: FuturesCandle[]; error: string | null }) => {
    if (v.candles.length > 0) chartCache.set(key, { at: Date.now(), v });
    return v;
  };

  if (period === "I") return keep(await intradayCandles(code, market));
  const fmt = fmtDay;
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 3600_000);

  try {
    const body = await hantooGet<{ output2?: Record<string, unknown>[] }>(
      DAILY,
      DAILY_TR,
      {
        FID_COND_MRKT_DIV_CODE: market,
        FID_INPUT_ISCD: code,
        FID_INPUT_DATE_1: fmt(from),
        FID_INPUT_DATE_2: fmt(to),
        FID_PERIOD_DIV_CODE: period,
      },
      "야간선물 차트",
    );
    const rows = Array.isArray(body.output2) ? body.output2 : [];
    const n = (v: unknown) => {
      const x = Number(String(v ?? "").replace(/[+,\s]/g, ""));
      return Number.isFinite(x) ? x : 0;
    };
    const candles = rows
      .map((r) => {
        const d = String(r.stck_bsop_date ?? "");
        const close = n(r.futs_prpr);
        return {
          t: d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d,
          open: n(r.futs_oprc) || close,
          high: n(r.futs_hgpr) || close,
          low: n(r.futs_lwpr) || close,
          close,
          volume: n(r.acml_vol),
        };
      })
      // 종가가 0 인 칸은 버린다 — 0 으로 두면 차트가 바닥까지 떨어진다
      .filter((c) => c.close > 0 && c.t)
      // 한투는 최신순으로 준다. 차트는 오래된 것부터다
      .sort((a, b) => a.t.localeCompare(b.t));
    return keep({ candles, error: candles.length === 0 ? "봉이 하나도 없습니다" : null });
  } catch (err) {
    return { candles: [], error: err instanceof Error ? err.message : "차트 조회 실패" };
  }
}
