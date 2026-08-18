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
    const now = new Date();
    const d = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
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
