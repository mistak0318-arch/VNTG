import { hantooGet, hantooReady, HantooError } from "./hantooClient.js";

/**
 * 증권사 목표주가·투자의견 (한국투자증권 FHKST663300C0).
 *
 * 키움에 없는 값이다. 그런데 **목표가 숫자 자체는 별로 쓸모가 없다** — 늘 현재가보다
 * 위에 있고, 틀려도 아무도 책임지지 않는다. 삼성전자만 봐도 한 날에 35만·40만·65만이
 * 같이 나온다.
 *
 * 쓸모 있는 건 세 가지다.
 *
 *   1) **의견이 바뀐 순간** — 응답에 직전 의견(rgbf_invt_opnn)이 같이 오므로 상향·하향을
 *      바로 집어낼 수 있다. 목표가 40만이라는 사실보다 "어제 30만에서 40만으로 올렸다"가
 *      훨씬 강한 신호다.
 *   2) **컨센서스가 움직이는 방향** — 최근 3개월 목표가 중앙값이 그 이전 3개월보다
 *      높으면 시장의 눈높이가 올라가는 중이다.
 *   3) **얼마나 많은 곳이 보고 있나** — 커버하는 증권사가 하나뿐인 종목의 목표가는
 *      컨센서스가 아니라 한 사람의 의견이다.
 *
 * 평균이 아니라 **중앙값**을 쓴다. 위 예처럼 한 곳이 65만을 부르면 평균이 끌려간다.
 */

const PATH = "/uapi/domestic-stock/v1/quotations/invest-opinion";
const TR = "FHKST663300C0";

/** 한 번에 100건이 한도라, 반년이면 대개 안 넘는다 */
const LOOKBACK_DAYS = 183;
/** 의견은 하루에 한 번 나올까 말까다. 장중에 다시 부를 이유가 없다 */
const TTL_MS = 6 * 3600_000;

export type Stance = "매수" | "중립" | "매도" | "기타";

export interface OpinionItem {
  date: string;
  broker: string;
  /** 원문 그대로 — "BUY" 와 "매수" 가 섞여 온다 */
  opinionRaw: string;
  stance: Stance;
  prevStance: Stance;
  /** 직전 의견 대비 상향(+1)·하향(-1)·유지(0) */
  move: number;
  goalPrice: number | null;
  /** 같은 증권사의 직전 목표가 */
  prevGoalPrice: number | null;
  /** 목표가를 몇 % 올렸나·내렸나 */
  goalChange: number | null;
}

export interface OpinionSummary {
  code: string;
  /** 최근 것부터 */
  items: OpinionItem[];
  /** 증권사마다 가장 최근 것 하나씩만 남긴 컨센서스 */
  brokerCount: number;
  goalMedian: number | null;
  goalMin: number | null;
  goalMax: number | null;
  /** 현재가 기준 목표가까지 남은 폭 (%) */
  upside: number | null;
  /** 기준으로 삼은 현재가 */
  price: number | null;
  stanceCount: { 매수: number; 중립: number; 매도: number; 기타: number };
  /** 최근 3개월 컨센서스 − 그 이전 3개월 (%). 눈높이가 오르는 중인가 */
  goalTrend: number | null;
  /** 100건 상한에 걸렸나 — 걸리면 오래된 쪽이 잘려서 추세를 믿을 수 없다 */
  truncated: boolean;
  /** 최근 60일 안의 의견 변경 */
  upgrades: OpinionItem[];
  downgrades: OpinionItem[];
  fetchedAt: string;
}

interface Row {
  stck_bsop_date?: string;
  invt_opnn?: string;
  invt_opnn_cls_code?: string;
  rgbf_invt_opnn?: string;
  rgbf_invt_opnn_cls_code?: string;
  mbcr_name?: string;
  hts_goal_prc?: string;
  stck_prdy_clpr?: string;
}

function ymd(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}${m}${day}`;
}

/**
 * 의견 문구를 세 갈래로 모은다.
 *
 * 구분코드(invt_opnn_cls_code)가 같이 오지만 **매핑표가 문서에 없다.** 표본에서는 매수가
 * 2로 나오는데 중립·매도가 뭔지 확인할 길이 없어서, 코드는 변경 감지에만 쓰고 갈래는
 * 문구에서 읽는다.
 */
function toStance(raw: string): Stance {
  const s = raw.trim().toUpperCase();
  if (!s) return "기타";
  if (/매수|BUY|OVERWEIGHT|OUTPERFORM|STRONG/.test(s)) return "매수";
  if (/중립|HOLD|NEUTRAL|MARKETPERFORM|MARKET PERFORM|EQUAL/.test(s)) return "중립";
  if (/매도|SELL|UNDERWEIGHT|UNDERPERFORM|REDUCE/.test(s)) return "매도";
  return "기타";
}

const RANK: Record<Stance, number> = { 매도: 0, 중립: 1, 매수: 2, 기타: -1 };

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** 증권사마다 가장 최근 의견 하나씩 */
function latestPerBroker(items: OpinionItem[]): OpinionItem[] {
  const seen = new Map<string, OpinionItem>();
  for (const it of items) {
    // items 는 최신순이므로 처음 만난 것이 그 증권사의 최신이다
    if (!seen.has(it.broker)) seen.set(it.broker, it);
  }
  return [...seen.values()];
}

const cache = new Map<string, { at: number; data: OpinionSummary }>();

export async function analystOpinion(
  code: string,
  currentPrice?: number | null,
): Promise<OpinionSummary> {
  const hit = cache.get(code);
  if (hit && Date.now() - hit.at < TTL_MS) {
    // 현재가만 바뀌었을 수 있으니 괴리율은 다시 계산한다
    return withPrice(hit.data, currentPrice);
  }

  const to = new Date();
  const from = new Date(to.getTime() - LOOKBACK_DAYS * 86400_000);
  const body = await hantooGet<{ output?: Row[] }>(
    PATH,
    TR,
    {
      FID_COND_MRKT_DIV_CODE: "J",
      FID_COND_SCR_DIV_CODE: "16633",
      FID_INPUT_ISCD: code,
      FID_INPUT_DATE_1: ymd(from),
      FID_INPUT_DATE_2: ymd(to),
    },
    "목표주가",
  );

  const rows = body.output ?? [];
  const items: OpinionItem[] = rows
    .map((r) => {
      const stance = toStance(String(r.invt_opnn ?? ""));
      const prevStance = toStance(String(r.rgbf_invt_opnn ?? ""));
      const goal = Number(r.hts_goal_prc);
      return {
        date: String(r.stck_bsop_date ?? ""),
        broker: String(r.mbcr_name ?? "").trim() || "미상",
        opinionRaw: String(r.invt_opnn ?? "").trim(),
        stance,
        prevStance,
        move:
          RANK[stance] < 0 || RANK[prevStance] < 0 ? 0 : Math.sign(RANK[stance] - RANK[prevStance]),
        goalPrice: Number.isFinite(goal) && goal > 0 ? goal : null,
        prevGoalPrice: null,
        goalChange: null,
      };
    })
    .filter((x) => x.date)
    .sort((a, b) => b.date.localeCompare(a.date));

  /*
   * **목표가를 올렸나 내렸나**를 증권사별로 이어 붙인다.
   *
   * 처음엔 의견 등급 변경(매수↔중립)만 잡았는데, 여덟 종목을 훑어 보니 60일 안에 **한 건도
   * 없었다.** 다들 BUY 를 유지한 채 목표가만 올린다 — 삼성전자는 눈높이가 석 달 새 67%
   * 올랐는데 등급 변경은 0건이었다. 등급만 보면 아무 일도 없는 것처럼 보인다.
   *
   * 응답의 rgbf_invt_opnn 은 직전 "의견"이지 직전 "목표가"가 아니라서, 같은 증권사의
   * 바로 이전 발표를 찾아 직접 견준다.
   */
  const byBroker = new Map<string, OpinionItem[]>();
  for (const it of items) {
    const arr = byBroker.get(it.broker);
    if (arr) arr.push(it);
    else byBroker.set(it.broker, [it]);
  }
  for (const arr of byBroker.values()) {
    for (let i = 0; i < arr.length - 1; i += 1) {
      const prev = arr[i + 1].goalPrice;
      arr[i].prevGoalPrice = prev;
      if (arr[i].goalPrice !== null && prev !== null && prev > 0) {
        arr[i].goalChange = ((arr[i].goalPrice! - prev) / prev) * 100;
      }
    }
  }

  const latest = latestPerBroker(items);
  const goals = latest.map((x) => x.goalPrice).filter((x): x is number => x !== null);

  const stanceCount = { 매수: 0, 중립: 0, 매도: 0, 기타: 0 };
  for (const it of latest) stanceCount[it.stance] += 1;

  // 눈높이가 오르는 중인가 — 최근 3개월과 그 이전 3개월의 중앙값을 견준다
  const cut = ymd(new Date(Date.now() - 91 * 86400_000));
  const recent = median(
    items.filter((x) => x.date >= cut && x.goalPrice !== null).map((x) => x.goalPrice!),
  );
  const older = median(
    items.filter((x) => x.date < cut && x.goalPrice !== null).map((x) => x.goalPrice!),
  );
  /*
   * 한 번에 100건이 상한이다. 상한에 닿으면 **오래된 쪽이 잘려 나간다** — 그러면
   * "그 이전 3개월" 표본이 실제보다 적거나 아예 비어서 추세가 부풀려진다.
   * 삼성전자가 반년에 93건이라 여유가 거의 없다. 걸리면 추세를 아예 내지 않는다.
   */
  const truncated = rows.length >= 100;
  const goalTrend =
    !truncated && recent !== null && older !== null && older > 0
      ? ((recent - older) / older) * 100
      : null;

  /*
   * 최근 60일의 "사건". 등급이 바뀌었거나, **목표가를 3% 넘게 움직였거나**.
   * 3% 미만은 반올림·주가 흐름에 따라붙는 수준이라 사건으로 치지 않는다.
   */
  const since = ymd(new Date(Date.now() - 60 * 86400_000));
  const moved = (x: OpinionItem) =>
    x.move !== 0 || (x.goalChange !== null && Math.abs(x.goalChange) >= 3);
  const changed = items.filter((x) => x.date >= since && moved(x));
  const dir = (x: OpinionItem) => (x.move !== 0 ? x.move : Math.sign(x.goalChange ?? 0));

  const data: OpinionSummary = {
    code,
    items,
    brokerCount: latest.length,
    goalMedian: median(goals),
    goalMin: goals.length > 0 ? Math.min(...goals) : null,
    goalMax: goals.length > 0 ? Math.max(...goals) : null,
    upside: null,
    price: null,
    stanceCount,
    goalTrend,
    truncated,
    upgrades: changed.filter((x) => dir(x) > 0),
    downgrades: changed.filter((x) => dir(x) < 0),
    fetchedAt: new Date().toISOString(),
  };

  /*
   * **가격이 붙은 것을 캐시한다.** 처음엔 가격 없는 원본을 넣었는데, 그러면 다음 호출에서
   * 현재가 조회가 실패했을 때 되돌릴 값이 없어 괴리율이 영영 null 로 남았다.
   * 마지막으로 알던 가격이라도 들고 있는 편이 낫다.
   */
  const priced = withPrice(data, currentPrice ?? fallbackPrice(rows));
  cache.set(code, { at: Date.now(), data: priced });
  return priced;
}

/** 현재가를 못 받았을 때는 가장 최근 의견이 적어 둔 전일종가라도 쓴다 */
function fallbackPrice(rows: Row[]): number | null {
  for (const r of rows) {
    const p = Number(r.stck_prdy_clpr);
    if (Number.isFinite(p) && p > 0) return p;
  }
  return null;
}

function withPrice(s: OpinionSummary, price?: number | null): OpinionSummary {
  const p = price != null && Number.isFinite(price) && price > 0 ? price : s.price;
  const upside = p != null && s.goalMedian !== null ? ((s.goalMedian - p) / p) * 100 : null;
  return { ...s, price: p ?? null, upside };
}

/**
 * 관심종목 표에 넣을 최소 정보. 종목 수만큼 부르므로 **실패해도 조용히 넘어간다** —
 * 목표주가 하나 때문에 전체 조회가 멈추면 안 된다.
 */
export interface OpinionBrief {
  upside: number | null;
  brokerCount: number;
  /** 최근 60일 의견 변경: +1 상향, -1 하향, 0 없음 */
  recentMove: number;
}

export async function opinionBrief(
  code: string,
  price: number | null,
): Promise<OpinionBrief | null> {
  if (!hantooReady()) return null;
  try {
    const s = await analystOpinion(code, price);
    if (s.brokerCount === 0) return null;
    return {
      upside: s.upside,
      brokerCount: s.brokerCount,
      recentMove: s.upgrades.length > s.downgrades.length ? 1 : s.downgrades.length > 0 ? -1 : 0,
    };
  } catch (err) {
    if (!(err instanceof HantooError)) console.error("[opinion] 실패:", err);
    return null;
  }
}
