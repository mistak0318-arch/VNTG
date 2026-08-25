import { Router } from "express";
import { listThemes } from "../customThemes.js";
import { getFinance } from "../dartFinance.js";
import { estimatePerform } from "../estimatePerform.js";
import { quarterFinance } from "../quarterFinance.js";
import { peekSnapshot } from "../marketSnapshot.js";
import { breakingNews, getDisclosures, newsCounts, searchNews, sectorNews } from "../newsDisclosure.js";
import { mainNews } from "../naverMainNews.js";
import { listWatchlist } from "../watchlist.js";
import { getKiwoomGroupStocks, listKiwoomGroups } from "../kiwoomWatchlist.js";
import type { KiwoomClient } from "../kiwoomClient.js";

/**
 * 질의 하나가 네이버 호출 하나다. 종목을 무한정 넣으면 하루 할당량이 녹는다.
 * 관심종목이 우선이고, 남는 자리만 내 테마 종목으로 채운다.
 */
const MAX_STOCK_QUERIES = 12;

/**
 * 어느 종목으로 뉴스를 검색할까.
 *
 * **내가 실제로 보고 있는 종목**이어야 한다. 분야별 질의(「코스피 마감 시황」 등)는
 * 개별 기업 기사를 거의 못 잡아서, 그것만으로는 「쓸 만한 걸 퍼온다」는 느낌이 안 났다.
 *
 * 두 곳을 정해 두고 그 순서로 채운다.
 *   1. **관심종목 (AI_HTS)** — 내가 직접 담은 것
 *   2. **키움_HTS 첫 번째 그룹** — 키움에서 늘 맨 앞에 두는 그 묶음
 *
 * 자리가 남으면 내 테마 구성종목으로 채운다. 「위주로」이지 「만」은 아니다.
 */
async function mineQueryNames(
  client: KiwoomClient,
  watchNames: string[],
): Promise<{ names: string[]; sources: string[] }> {
  const out: string[] = [];
  const seen = new Set<string>();
  const sources: string[] = [];
  const push = (n: string) => {
    if (!n || seen.has(n)) return;
    seen.add(n);
    out.push(n);
  };

  for (const n of watchNames) push(n);
  if (out.length > 0) sources.push(`관심종목 ${out.length}`);

  // 키움 첫 번째 그룹 — 목록의 맨 앞이 늘 내가 제일 자주 보는 묶음이다
  if (out.length < MAX_STOCK_QUERIES) {
    try {
      const groups = await listKiwoomGroups(client);
      const first = groups[0];
      if (first) {
        const stocks = await getKiwoomGroupStocks(client, first.code);
        const before = out.length;
        for (const st of stocks) {
          if (out.length >= MAX_STOCK_QUERIES) break;
          push(st.name);
        }
        if (out.length > before) sources.push(`${first.name} ${out.length - before}`);
      }
    } catch {
      // 키움이 막혀도 관심종목만으로 돈다 — 뉴스가 통째로 비면 안 된다
    }
  }

  // 남는 자리만 내 테마 종목으로.
  // 코드→이름은 전종목 스냅샷에서 본다. 스냅샷이 없으면 건너뛴다
  // (뉴스 때문에 65회 조회를 유발하지 않는다).
  if (out.length < MAX_STOCK_QUERIES) {
    const snap = peekSnapshot();
    if (snap) {
      const before = out.length;
      for (const t of await listThemes().catch(() => [])) {
        for (const code of t.codes) {
          if (out.length >= MAX_STOCK_QUERIES) break;
          const name = snap.byCode.get(code)?.name;
          if (name) push(name);
        }
        if (out.length >= MAX_STOCK_QUERIES) break;
      }
      if (out.length > before) sources.push(`내 테마 ${out.length - before}`);
    }
  }

  return { names: out.slice(0, MAX_STOCK_QUERIES), sources };
}

export function createNewsRouter(client: KiwoomClient): Router {
  const router = Router();

  // 뉴스 검색 — 종목명이나 임의 키워드
  router.get("/news", async (req, res, next) => {
    try {
      const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
      if (!q) {
        res.status(400).json({ error: "검색어(q)가 필요합니다." });
        return;
      }
      const limit = Math.min(Number(req.query.display) || 30, 100);
      // scope=all 이면 전체, 기본은 주요 언론사만
      const majorOnly = req.query.scope !== "all";
      const [items, counts] = await Promise.all([
        searchNews(q, { majorOnly, limit }),
        newsCounts(q),
      ]);
      res.json({ items, counts });
    } catch (err) {
      next(err);
    }
  });

  /** 섹터별 뉴스 — 데일리 리포트용. 증시/글로벌/정책/산업/부동산으로 나눠서 준다 */
  router.get("/news/sectors", async (req, res, next) => {
    try {
      const majorOnly = req.query.scope !== "all";
      // 상한이 20이라 화면이 30을 요청해도 잘려나갔다. 읽을거리가 부족한 쪽이 더 나쁘다.
      const perSector = Math.min(Number(req.query.per) || 20, 60);
      // 관심종목이 언급된 기사를 위로 올리기 위해 종목명을 넘긴다
      const watchNames = (await listWatchlist().catch(() => [])).map((w) => w.name);

      /**
       * "내 종목" 탭에 쓸 검색어.
       * 관심종목을 먼저 넣고, 남는 자리를 내가 만든 테마의 구성종목으로 채운다.
       * 질의 하나가 네이버 호출 하나라서 상한을 둔다 (5분 캐시가 있어 반복 조회 부담은 적다).
       */
      const mine =
        req.query.mine === "0"
          ? { names: [] as string[], sources: [] as string[] }
          : await mineQueryNames(client, watchNames);
      const stockNames = mine.names;

      const sort = req.query.sort === "recent" ? "recent" : "importance";
      const out = await sectorNews({ majorOnly, perSector, watchNames, stockNames, sort });
      // 어디서 온 종목으로 검색했는지 화면에 밝힌다 — 안 밝히면 왜 이 기사가 떴는지 모른다
      res.json({ ...out, mineSources: mine.sources, mineNames: stockNames });
    } catch (err) {
      next(err);
    }
  });

  /** 속보 — [속보]·[단독]·[긴급] 머리표가 붙은 것만, 증시·기업 갈래 우선 */
  router.get("/news/breaking", async (_req, res, next) => {
    try {
      res.json(await breakingNews());
    } catch (err) {
      next(err);
    }
  });

  /** 네이버 증권 주요뉴스 — 편집자가 고른 목록, 썸네일 포함 (5분 캐시) */
  router.get("/news/main", async (req, res, next) => {
    try {
      res.json({ items: await mainNews(Math.min(Number(req.query.size) || 20, 40)) });
    } catch (err) {
      next(err);
    }
  });

  // 종목 공시 (DART)
  router.get("/disclosures/:code", async (req, res, next) => {
    try {
      const days = Math.min(Number(req.query.days) || 180, 365);
      res.json({ items: await getDisclosures(req.params.code, days) });
    } catch (err) {
      next(err);
    }
  });

  /*
   * 재무제표 3년치 + 배당 (DART) + **분기 손익 (한투)**.
   *
   * DART 는 사업보고서라 마지막 줄이 작년이다 — 8월에도 작년이 마지막이라
   * "지금 벌고 있나"를 볼 수 없었다. 한투 분기를 같이 실어 보낸다.
   * 한투 키가 없거나 실패하면 분기만 빈 채로 나가고 연간은 그대로 나온다.
   */
  router.get("/finance/:code", async (req, res, next) => {
    try {
      const [annual, quarters, estimate] = await Promise.all([
        getFinance(req.params.code),
        quarterFinance(req.params.code, Math.min(Number(req.query.limit) || 8, 24)).catch(() => []),
        // 160여 개 대형주만 있다 — 없으면 null 이고 그건 오류가 아니다
        estimatePerform(req.params.code).catch(() => null),
      ]);
      res.json({ ...annual, quarters, estimate });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
