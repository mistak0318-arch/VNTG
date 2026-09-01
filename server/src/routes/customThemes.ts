import { Router } from "express";
import {
  createTheme,
  evaluateThemes,
  listThemes,
  removeTheme,
  toggleStock,
  updateTheme,
  addTag,
  removeTag,
  suggestTags,
  tagsOf,
} from "../customThemes.js";
import type { KiwoomClient } from "../kiwoomClient.js";
import { getThemeStocks } from "../marketOverview.js";
import { listWatchlist } from "../watchlist.js";

export function createCustomThemeRouter(client: KiwoomClient): Router {
  const router = Router();

  /**
   * **이 종목의 태그** (2026-09-01) — 종목 상세 메모 위에 붙는다.
   *
   * 벤티지: "각 종목 상세에 메모 적잖아. 그 위에 #태그 칸 하나 두어서 태그를
   * 적는 거지. 그 태그가 자동으로 그룹이 돼서 태그 그룹으로 들어가고."
   * "태그 있는 애들은 그 태그 집단의 등락률을 옆에 표시해주고."
   *
   * 등락률을 같이 준다 — 「이 종목에 로봇 태그가 붙었고, 오늘 로봇은 −3.14%」가
   * 한 줄로 읽혀야 태그가 쓸모를 갖는다. 스냅샷에서 내므로 조회가 안 는다.
   */
  router.get("/tags/:code", async (req, res, next) => {
    try {
      const code = String(req.params.code);
      const mine = new Set(await tagsOf(code));
      const { themes } = await evaluateThemes(client);
      res.json({
        tags: themes
          .filter((t) => mine.has(t.name))
          .map((t) => ({
            name: t.name,
            /* 시총 가중평균 — 소형주 하나가 태그 전체를 흔들지 않게 */
            rate: t.changeRate,
            count: t.codes.length,
            color: t.color,
            /*
             * **구성종목까지 같이 준다** (2026-09-01) — 칩을 누르면 펴진다.
             *
             * 벤티지: "각 태그 클릭하면 담겨진 종목하고 나와줘야지. 테마 클릭하는
             * 것처럼."
             *
             * 태그당 5~15종목이라 응답이 무겁지 않다. 따로 부르게 하면 누를 때마다
             * 왕복이 생기고, 그 사이 빈 목록이 잠깐 보인다.
             */
            stocks: t.stocks.map((x) => ({
              code: x.code,
              name: x.name,
              changeRate: x.changeRate,
            })),
          })),
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * 태그 이름 후보 — `#반도` 를 치면 「반도체」·「반도체 소부장」.
   *
   * ⚠️ 이게 없으면 「반도체」·「반도체장비」·「반도체_소부장」이 따로 생겨
   * 같은 뜻의 그룹이 셋이 된다. 자동완성은 곁다리가 아니라 본체다.
   */
  router.get("/tags", async (req, res, next) => {
    try {
      res.json({ tags: await suggestTags(String(req.query.q ?? ""), 8) });
    } catch (err) {
      next(err);
    }
  });

  /** 태그 붙이기 — 없는 이름이면 만든다 */
  router.post("/tags/:code", async (req, res, next) => {
    try {
      const name = String((req.body as { name?: string })?.name ?? "");
      await addTag(String(req.params.code), name);
      res.json({ tags: await tagsOf(String(req.params.code)) });
    } catch (err) {
      next(err);
    }
  });

  /** 태그 떼기 — 그 태그가 비어도 이름은 남긴다 */
  router.delete("/tags/:code/:name", async (req, res, next) => {
    try {
      await removeTag(String(req.params.code), decodeURIComponent(String(req.params.name)));
      res.json({ tags: await tagsOf(String(req.params.code)) });
    } catch (err) {
      next(err);
    }
  });

  /** 등락률까지 계산해서 준다 */
  router.get("/", async (req, res, next) => {
    try {
      res.json(await evaluateThemes(client, req.query.force === "1"));
    } catch (err) {
      next(err);
    }
  });

  /** 편집용 원본 (계산 없이 빠르게) */
  router.get("/raw", async (_req, res, next) => {
    try {
      res.json({ themes: await listThemes() });
    } catch (err) {
      next(err);
    }
  });

  router.post("/", async (req, res, next) => {
    try {
      const body = req.body ?? {};
      res.json({
        themes: await createTheme({
          name: body.name,
          memo: body.memo,
          codes: body.codes,
          color: body.color,
          source: body.source === "infostock" ? "infostock" : "manual",
        }),
      });
    } catch (err) {
      next(err);
    }
  });

  router.patch("/:id", async (req, res, next) => {
    try {
      res.json({ themes: await updateTheme(req.params.id, req.body ?? {}) });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/:id", async (req, res, next) => {
    try {
      res.json({ themes: await removeTheme(req.params.id) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/:id/stocks/:code", async (req, res, next) => {
    try {
      res.json({ themes: await toggleStock(req.params.id, req.params.code) });
    } catch (err) {
      next(err);
    }
  });

  /**
   * 키움 테마에서 복사해서 시작.
   * 빈 화면에서 종목을 하나씩 찾는 것보다, 기존 테마를 불러와 빼고 더하는 게 빠르다.
   */
  router.post("/from-theme/:themeCode", async (req, res, next) => {
    try {
      const rows = await getThemeStocks(client, req.params.themeCode);
      const name = String(req.body?.name ?? "").trim();
      if (!name) throw new Error("테마 이름을 입력하세요.");
      res.json({
        themes: await createTheme({
          name,
          memo: String(req.body?.memo ?? ""),
          codes: rows.map((r) => r.code),
        }),
      });
    } catch (err) {
      next(err);
    }
  });

  /** 관심종목에서 한 번에 만들기 */
  router.post("/from-watchlist", async (req, res, next) => {
    try {
      const group = req.body?.group ? String(req.body.group) : null;
      const items = await listWatchlist();
      const picked = group ? items.filter((w) => (w.group ?? "기본") === group) : items;
      const name = String(req.body?.name ?? "").trim();
      if (!name) throw new Error("테마 이름을 입력하세요.");
      if (picked.length === 0) throw new Error("담을 관심종목이 없습니다.");
      res.json({
        themes: await createTheme({
          name,
          memo: String(req.body?.memo ?? ""),
          codes: picked.map((w) => w.code),
        }),
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
