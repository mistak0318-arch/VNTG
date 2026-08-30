import { Router } from "express";
import type { KiwoomClient } from "../kiwoomClient.js";
import {
  NAVER_JOBS,
  markRun,
  readConfig,
  setEnabled,
  setPeriodMin,
  type NaverJobKey,
} from "../naverSyncConfig.js";
import { collectNewsKeywords } from "../newsKeywords.js";
import { fetchAllThemes, refreshEtfs, refreshUsThemes } from "../naverThemes.js";
import { buildEtfHolders } from "../etfHolders.js";

/**
 * 네이버 동기화 조작 길 (2026-08-30).
 *
 * 설정 파일(naverSyncConfig)과 실제로 긁는 모듈 **양쪽을 아는 유일한 자리**다.
 * 긁는 모듈들은 설정 파일만 알고 이쪽을 모른다 — 그래야 참조가 한 방향으로 흐른다.
 *
 * ⚠️ 「지금 실행」은 꺼 둔 것도 돌린다. 끈다는 건 「알아서 하지 마라」이지
 * 「쓰지 마라」가 아니다.
 */
export function createNaverSyncRouter(client: KiwoomClient): Router {
  const router = Router();

  /** 두 번 눌러도 두 번 돌지 않게 — 테마 전체 수집은 몇 분씩 걸린다 */
  const busy = new Set<NaverJobKey>();

  router.get("/", async (_req, res) => {
    res.json(await readConfig());
  });

  router.post("/:key/enabled", async (req, res) => {
    const key = req.params.key as NaverJobKey;
    if (!NAVER_JOBS.some((j) => j.key === key)) return res.status(404).json({ error: "없는 항목" });
    await setEnabled(key, Boolean(req.body?.on));
    res.json(await readConfig());
  });

  router.post("/:key/period", async (req, res) => {
    const key = req.params.key as NaverJobKey;
    const job = NAVER_JOBS.find((j) => j.key === key);
    if (!job) return res.status(404).json({ error: "없는 항목" });
    if (!job.periodic) return res.status(400).json({ error: "주기를 정할 수 있는 항목이 아닙니다" });
    const raw = req.body?.min;
    await setPeriodMin(key, raw === null || raw === undefined || raw === "" ? null : Number(raw));
    res.json(await readConfig());
  });

  router.post("/:key/run", async (req, res) => {
    const key = req.params.key as NaverJobKey;
    if (!NAVER_JOBS.some((j) => j.key === key)) return res.status(404).json({ error: "없는 항목" });
    if (busy.has(key)) return res.status(409).json({ error: "이미 돌고 있습니다" });
    busy.add(key);
    try {
      let msg = "";
      if (key === "newsKeywords") {
        const r = await collectNewsKeywords();
        msg = `기사 ${r.articles}건 · 낱말 ${r.terms}개`;
      } else if (key === "themesKr") {
        const r = await fetchAllThemes();
        msg = `테마 ${r.themes.length}개`;
      } else if (key === "themesUs") {
        const r = await refreshUsThemes();
        msg = `테마 ${r.themes}개 · 종목 ${r.stocks}개`;
      } else if (key === "themesEtf") {
        const r = await refreshEtfs();
        msg = `${r.count}개`;
      } else {
        const r = await buildEtfHolders(client);
        msg = `ETF ${r.scanned}곳 · 종목 ${r.stocks}개`;
      }
      await markRun(key, true, msg);
      res.json({ ok: true, msg, config: await readConfig() });
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      await markRun(key, false, m);
      res.status(500).json({ error: m, config: await readConfig() });
    } finally {
      busy.delete(key);
    }
  });

  return router;
}
