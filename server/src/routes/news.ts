import { Router } from "express";
import { listThemes } from "../customThemes.js";
import { getFinance } from "../dartFinance.js";
import { peekSnapshot } from "../marketSnapshot.js";
import { getDisclosures, newsCounts, searchNews, sectorNews } from "../newsDisclosure.js";
import { listWatchlist } from "../watchlist.js";

/**
 * 질의 하나가 네이버 호출 하나다. 종목을 무한정 넣으면 하루 할당량이 녹는다.
 * 관심종목이 우선이고, 남는 자리만 내 테마 종목으로 채운다.
 */
const MAX_STOCK_QUERIES = 12;

async function mineQueryNames(watchNames: string[]): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const n of watchNames) {
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  if (out.length >= MAX_STOCK_QUERIES) return out.slice(0, MAX_STOCK_QUERIES);

  // 내 테마 구성종목 — 코드→이름은 전종목 스냅샷에서 본다.
  // 스냅샷이 아직 없으면 이 단계는 그냥 건너뛴다 (뉴스 때문에 65회 조회를 유발하지 않는다).
  const snap = peekSnapshot();
  if (!snap) return out;

  for (const t of await listThemes().catch(() => [])) {
    for (const code of t.codes) {
      const name = snap.byCode.get(code)?.name;
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push(name);
      if (out.length >= MAX_STOCK_QUERIES) return out;
    }
  }
  return out;
}

export function createNewsRouter(): Router {
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
      const stockNames = req.query.mine === "0" ? [] : await mineQueryNames(watchNames);

      const sort = req.query.sort === "recent" ? "recent" : "importance";
      res.json(await sectorNews({ majorOnly, perSector, watchNames, stockNames, sort }));
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

  // 재무제표 3년치 + 배당 (DART)
  router.get("/finance/:code", async (req, res, next) => {
    try {
      res.json(await getFinance(req.params.code));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
