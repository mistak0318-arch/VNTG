import { indexDetail } from "./indexDetail.js";
import { getMarketSnapshot } from "./marketSnapshot.js";
import { openPositions } from "./tradeJournal.js";
import { listWatchlist } from "./watchlist.js";
import type { KiwoomClient } from "./kiwoomClient.js";

/**
 * 위젯·워치가 쓸 **한 줄 요약** — 한 번 부르면 화면 하나가 채워진다.
 *
 * ## 왜 따로 만드나
 *
 * 바탕화면 위젯(Glance)이나 워치 타일은 **화면이 아주 작고 갱신이 아주 잦다.**
 * 그런 데서 앱처럼 조회를 여럿 부르면 배터리가 먼저 죽는다. 한 번 불러 한 덩어리를
 * 받고 그걸 그대로 그리는 게 맞다.
 *
 * 그리고 이 엔드포인트가 있어야 **나중에 안드로이드를 붙일 때 서버를 안 건드린다.**
 * 위젯을 만들 시점에 서버부터 고치기 시작하면 그때 또 시간이 든다.
 *
 * ## 무엇을 담나 — **작은 화면에 들어가는 만큼만**
 *
 *   지수 둘        코스피·코스닥. 지금 값과 등락률
 *   내 자리        들고 있는 종목 수와 그중 손절선이 깨진 것
 *   관심종목 몇 개  많이 움직인 순
 *
 * 위젯에 표를 통째로 넣으려 하면 아무것도 안 읽힌다. **한눈에 들어오는 것만** 남긴다.
 *
 * ## 조회를 새로 안 쓴다
 *
 * 지수 일봉(캐싱), 전종목 스냅샷(캐싱), 관심종목·복기 노트(파일)뿐이다.
 * 위젯이 15분마다 불러도 키움 한도를 안 먹는다.
 */

export interface WidgetIndex {
  code: string;
  name: string;
  close: number;
  changeRate: number;
  /** 그날 거래대금(억원) */
  tradeValue: number;
}

export interface WidgetStock {
  code: string;
  name: string;
  price: number;
  changeRate: number;
}

export interface WidgetSummary {
  /** 언제 만든 값인가 — 위젯이 「몇 분 전」을 적을 수 있게 */
  at: string;
  /** 장이 돌고 있나 — 꺼져 있으면 위젯이 갱신을 늦춘다 */
  marketOpen: boolean;
  indices: WidgetIndex[];
  /** 많이 움직인 순 관심종목 */
  watch: WidgetStock[];
  /** 관심종목 전체 수 (위에 몇 개만 보내므로) */
  watchTotal: number;
  positions: {
    /** 들고 있는 자리 수 */
    open: number;
    /** 손절선을 적어 둔 자리 */
    watched: number;
    /** 지금 손절선 아래인 자리 — **위젯에서 제일 중요한 숫자** */
    broken: number;
  };
}

function kstOpen(now = new Date()): boolean {
  const kst = new Date(now.getTime() + 9 * 3600_000);
  if (kst.getUTCDay() === 0 || kst.getUTCDay() === 6) return false;
  const m = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  return m >= 9 * 60 && m <= 15 * 60 + 30;
}

export async function widgetSummary(
  client: KiwoomClient,
  limit = 5,
): Promise<WidgetSummary> {
  const indices: WidgetIndex[] = [];
  for (const [code, name] of [
    ["001", "코스피"],
    ["101", "코스닥"],
  ] as const) {
    try {
      const d = await indexDetail(client, code, "day");
      const cs = d.candles;
      if (cs.length < 2) continue;
      const last = cs[cs.length - 1];
      const prev = cs[cs.length - 2];
      indices.push({
        code,
        name,
        close: last.close,
        changeRate: prev.close > 0 ? ((last.close - prev.close) / prev.close) * 100 : 0,
        tradeValue: last.tradeValue,
      });
    } catch {
      /* 하나가 실패해도 나머지는 낸다 — 위젯이 통째로 비면 안 쓰게 된다 */
    }
  }

  /* 관심종목 — 전종목 스냅샷에서 값을 붙인다(조회가 안 는다) */
  const snap = await getMarketSnapshot(client).catch(() => null);
  const items = (await listWatchlist().catch(() => [])).filter((w) => !w.divider);
  const watch: WidgetStock[] = items
    .map((w) => {
      const s = snap?.byCode.get(w.code);
      return s
        ? { code: w.code, name: w.name, price: s.price, changeRate: s.changeRate }
        : null;
    })
    .filter((x): x is WidgetStock => x !== null)
    /*
     * **많이 움직인 순**이다. 오른 순도 내린 순도 아니다 — 작은 화면에 다섯 줄이면
     * 「오늘 무슨 일이 났나」를 봐야지 「뭐가 올랐나」만 보면 반쪽이다.
     */
    .sort((a, b) => Math.abs(b.changeRate) - Math.abs(a.changeRate))
    .slice(0, Math.min(Math.max(limit, 1), 20));

  /* 내 자리 — 복기 노트에서 선입선출로 계산한 것 */
  let open = 0;
  let watched = 0;
  let broken = 0;
  try {
    const pos = await openPositions();
    open = pos.length;
    for (const p of pos) {
      if (p.stop === null) continue;
      watched += 1;
      const now = snap?.byCode.get(p.code)?.price ?? 0;
      if (now > 0 && now <= p.stop) broken += 1;
    }
  } catch {
    /* 노트를 못 읽어도 지수·관심종목은 낸다 */
  }

  return {
    at: new Date().toISOString(),
    marketOpen: kstOpen(),
    indices,
    watch,
    watchTotal: items.length,
    positions: { open, watched, broken },
  };
}
