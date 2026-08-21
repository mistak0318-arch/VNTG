import { useEffect, useState } from "react";
import { liveQuote } from "./usSession";
import { api, type StockRow } from "./api";

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

export function useWatchGroupTiles(source: GroupSource | null) {
  const [tiles, setTiles] = useState<GroupTile[]>([]);
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
              return {
                code: s.symbol,
                name: s.name,
                price: q.price ?? 0,
                change: 0,
                changeRate: q.changeRate ?? 0,
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

    run()
      .then((t) => {
        if (!alive) return;
        // 빈 그룹은 타일로 만들 수 없다 — 회색 칸만 늘어난다
        setTiles(t.filter((x) => x.stocks.length > 0).sort((a, b) => b.changeRate - a.changeRate));
      })
      .catch((e: Error) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));

    return () => {
      alive = false;
    };
  }, [source]);

  return { tiles, loading, error };
}
