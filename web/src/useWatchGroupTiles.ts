import { useEffect, useState } from "react";
import { liveQuote } from "./usSession";
import { api, type StockRow } from "./api";
import { useUsAllFast } from "./useUsAllFast";

/**
 * 관심종목 그룹을 MAP 타일로.
 *
 * 테마/업종 MAP 이 하던 일은 **"어느 묶음이 오늘 도는가"** 를 한 눈에 보는 것이다.
 * 그 묶음이 꼭 테마일 이유가 없다 — 내가 짜 둔 관심종목 그룹이야말로 내가 실제로
 * 보고 있는 묶음이다. 그런데 그건 표로만 볼 수 있었다.
 *
 * 세 곳에서 가져온다. 셋 다 이미 있는 API 라 새로 만든 게 없다.
 *   · AI_HTS  — 관심종목 추적(그룹이 종목마다 여러 개일 수 있어 펼쳐서 센다)
 *   · 키움_HTS — 키움 그룹은 목록과 구성종목이 따로라 그룹 수만큼 부른다
 *   · 미국     — 이미 그룹별 등락률까지 계산해서 준다
 */

export type GroupSource = "watchAi" | "watchKiwoom" | "watchUs";

export interface GroupTile {
  id: string;
  name: string;
  /** 구성종목 단순평균 등락률(%) */
  changeRate: number;
  risingCount: number;
  fallingCount: number;
  stocks: StockRow[];
}

/** 구성종목에서 타일 하나를 만든다 — 세 출처가 같은 방식으로 계산돼야 견줄 수 있다 */
function toTile(id: string, name: string, stocks: StockRow[]): GroupTile {
  const rates = stocks.map((s) => s.changeRate).filter((n) => Number.isFinite(n));
  return {
    id,
    name,
    // 시총 가중이 아니라 단순평균이다. "몇 개가 함께 도는가"를 보려는 그림이라
    // 대형주 하나가 묶음 전체를 대표하면 안 된다
    changeRate: rates.length > 0 ? rates.reduce((a, b) => a + b, 0) / rates.length : 0,
    risingCount: rates.filter((r) => r > 0).length,
    fallingCount: rates.filter((r) => r < 0).length,
    stocks,
  };
}

/**
 * 몇 초마다 다시 받을지.
 *
 * ## 왜 이게 필요했나
 *
 * **한 번만 받고 끝이었다.** 그래서 미국 정규장이 도는 동안 MAP 은 페이지를 연 시각에
 * 멈춰 있고, 같은 화면 아래 관심종목 카드는 20초마다 갱신됐다 — 같은 종목이 위에서는
 * +0.50%, 아래에서는 +1.63% 로 보였다. **한 화면 안에서 숫자가 갈리면 둘 다 못 믿는다.**
 *
 * 저녁에 열어 두고 아침에 보면 전날 값이 그대로 남아 있는 것도 같은 이유였다.
 *
 * 주기는 **호출 비용에 맞춘다.** 미국은 한 번이면 전 그룹이 오므로 아래 관심종목 카드와
 * 같은 20초로 맞춘다(그래야 두 숫자가 안 갈린다). 키움 그룹은 그룹 수만큼 부르므로 넉넉히.
 */
const REFRESH_MS: Record<GroupSource, number> = {
  watchUs: 20_000,
  watchAi: 60_000,
  watchKiwoom: 120_000,
};

export function useWatchGroupTiles(source: GroupSource | null) {
  const [base, setTiles] = useState<GroupTile[]>([]);
  /*
   * 해외 타일은 **빠른 시세로 덮는다** (2026-09-09 밤). `usWatch()` 는 서버 1분 캐시라
   * 타일이 표보다 한참 늦었다. 정규장(「실시간」 상태)일 때만 — 프리·애프터의 값은
   * `liveQuote` 가 세션에 맞게 이미 골라 두었고 spark 는 정규장 값이다.
   */
  const [usOpen, setUsOpen] = useState(false);
  /*
   * ⚠️ **정규장일 때만 덮던 것을 늘 덮는 것으로** (2026-09-11 밤 — 벤티지: "시황대시보드의 해외
   * 관심그룹 박스들이 대부분 지연이 있는듯 그룹내 속한 종목들의 합과 다르네").
   *
   * 가두리가 `usOpen` 이었다 — 그 값은 **1분 캐시된 `usWatch()` 의 `state` 글자**로 정해진다.
   * 그래서 미국 개장 직후에는 아직 「프리장」이라 덮개가 안 열렸고, `liveQuote` 는 `ext` 칸이
   * 비면 정규장 값으로 떨어지는데 그 정규장 값이 **어제 것**이라 타일이 어제 등락률에 멈췄다.
   * 실측 09-11 22:36(개장 6분 뒤): 타일 「반도체 −4.37%」인데 그 안의 NVDA +0.52 · SKHY +0.45 ·
   * MU +0.14 였다 — 어제 정규장이 그만큼 빠진 날이었다.
   *
   * `fast` 는 아래 관심종목 표가 쓰는 바로 그 값이다. 늘 덮으면 **한 화면의 두 숫자가 같은
   * 기준**이 된다 — 그게 이 파일이 처음부터 지키려던 규칙이다(아래 REFRESH_MS 주석).
   * 조회 주기는 그대로 `usOpen` 을 따른다(장중 15초·그 밖 60초).
   */
  const fast = useUsAllFast(
    source === "watchUs" ? base.flatMap((g) => g.stocks.map((s) => s.code)) : [],
    usOpen,
  );
  const tiles =
    source === "watchUs"
      ? base
          .map((g) =>
            toTile(
              g.id,
              g.name,
              g.stocks.map((s) => {
                const f = fast[s.code];
                if (!f || f.changeRate === null) return s;
                const rate = f.changeRate;
                const b = 1 + rate / 100;
                return { ...s, price: f.price, changeRate: rate, change: b !== 0 ? f.price - f.price / b : 0 };
              }),
            ),
          )
          .sort((a, b) => b.changeRate - a.changeRate)
      : base;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!source) return;
    let alive = true;
    setLoading(true);
    setError(null);

    const run = async (): Promise<GroupTile[]> => {
      if (source === "watchUs") {
        const r = await api.usWatch();
        setUsOpen(r.groups.some((g) => g.stocks.some((s) => (s.state ?? "").includes("실시간"))));
        return r.groups.map((g) =>
          toTile(
            g.id,
            g.name,
            /*
             * **지금 살아 있는 세션의 값**을 쓴다.
             *
             * 정규장 종가만 그리면 애프터장에 3% 오른 종목이 「−0.3%」로 남는다.
             * 타일과 구성종목 표는 숫자를 하나만 보여주므로, 그 하나가 지금 값이어야 한다.
             */
            g.stocks.map((s) => {
              const q = liveQuote(s);
              const price = q.price ?? 0;
              const rate = q.changeRate ?? 0;
              /*
               * ⚠️ 대비를 **0으로 박아** 넘기고 있었다. 타일은 등락률만 쓰므로 아무도 몰랐는데,
               * 타일을 누르면 열리는 구성종목 표에는 「대비」 칸이 있다 —
               * 거기에 전 종목 0 이 찍혔다. 등락률과 현재가가 있으면 대비는 낼 수 있다.
               */
              const base = 1 + rate / 100;
              return {
                code: s.symbol,
                name: s.name,
                price,
                change: base !== 0 ? price - price / base : 0,
                changeRate: rate,
                marketCap: 0,
              };
            }),
          ),
        );
      }

      if (source === "watchAi") {
        const r = await api.watchlistTracking();
        /*
         * 한 종목이 여러 그룹에 담길 수 있다. 그룹마다 따로 세야 하므로 펼쳐서 넣는다 —
         * 종목 기준으로 세면 여러 그룹에 든 종목이 한 번만 잡힌다.
         */
        const byGroup = new Map<string, StockRow[]>();
        for (const s of r.items) {
          for (const g of s.groups ?? ["기본"]) {
            const arr = byGroup.get(g) ?? [];
            arr.push({
              code: s.code,
              name: s.name,
              price: s.price,
              change: 0,
              changeRate: s.changeRate,
              marketCap: 0,
            });
            byGroup.set(g, arr);
          }
        }
        return [...byGroup.entries()].map(([g, stocks]) => toTile(g, g, stocks));
      }

      // 키움: 그룹 목록과 구성종목이 따로다. 그룹 수만큼 부르되 넷씩 묶어 돈다
      const { groups } = await api.kiwoomGroups();
      const out: GroupTile[] = [];
      for (let i = 0; i < groups.length; i += 4) {
        const chunk = groups.slice(i, i + 4);
        const got = await Promise.all(
          chunk.map(async (g) => {
            try {
              const { items } = await api.kiwoomGroupStocks(g.code);
              return toTile(
                g.code,
                g.name,
                items.map((s) => ({
                  code: s.code,
                  name: s.name,
                  price: s.price,
                  change: s.change,
                  changeRate: s.changeRate,
                  marketCap: 0,
                })),
              );
            } catch {
              // 한 그룹이 실패해도 나머지는 보여 준다
              return null;
            }
          }),
        );
        out.push(...got.filter((x): x is GroupTile => x !== null));
      }
      return out;
    };

    const load = () =>
      run()
        .then((t) => {
          if (!alive) return;
          // 빈 그룹은 타일로 만들 수 없다 — 회색 칸만 늘어난다
          setTiles(t.filter((x) => x.stocks.length > 0).sort((a, b) => b.changeRate - a.changeRate));
          setError(null);
        })
        .catch((e: Error) => alive && setError(e.message))
        .finally(() => alive && setLoading(false));

    void load();
    const timer = setInterval(() => void load(), REFRESH_MS[source]);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [source]);

  return { tiles, loading, error };
}
