import { Router } from "express";
import { CATS, compressOldLogs, dataReport, pruneData, setKeepDays } from "../dataRetention.js";
import { ledgerStatus, loadCollectHistory } from "../dailyStore.js";
import { collectProgress, startCollectDaily } from "../collectDaily.js";

/** 데이터 보관 — 현황 보기 · 기간 정하기 · 지금 정리 (2026-08-31) */
export function createDataRouter(client: import("../kiwoomClient.js").KiwoomClient): Router {
  const router = Router();

  router.get("/", async (_req, res, next) => {
    try {
      res.json(await dataReport());
    } catch (err) {
      next(err);
    }
  });

  router.post("/:key/keep", async (req, res, next) => {
    try {
      const key = req.params.key;
      if (!CATS.some((c) => c.key === key)) return res.status(404).json({ error: "없는 항목" });
      const raw = req.body?.days;
      await setKeepDays(key, raw === null || raw === undefined || raw === "" ? null : Number(raw));
      res.json(await dataReport());
    } catch (err) {
      next(err);
    }
  });

  router.post("/prune", async (_req, res, next) => {
    try {
      const r = await pruneData();
      res.json({ ...r, report: await dataReport() });
    } catch (err) {
      next(err);
    }
  });

  /**
   * **지난 로그 압축** (2026-09-01) — 지우기 전에 줄인다.
   *
   * 실시간 로그는 같은 JSON 키가 하루 40만 번 반복돼 압축이 4.2:1 로 듣는다.
   * 5년치가 88GB → 21GB 라, 「작게 오래 두기」가 「크게 짧게 두기」보다 낫다 —
   * 이 데이터는 키움이 지나간 것을 안 줘서 지우면 영영 못 받는다.
   */
  router.post("/compress", async (_req, res, next) => {
    try {
      const z = await compressOldLogs();
      res.json({ ...z, report: await dataReport() });
    } catch (err) {
      next(err);
    }
  });

  /**
   * **일별 원장 현황** (2026-09-01) — 며칠치가 쌓였나 · 한도까지 얼마나.
   *
   * 벤티지: "2년 되는날 나한테 알려줘 리셋할건지 백업할건지 말야."
   * 알림은 텔레그램으로 가지만, **눈으로 볼 데도 있어야** 한다.
   */
  router.get("/ledger", async (_req, res, next) => {
    try {
      res.json({
        ledger: await ledgerStatus(),
        collect: collectProgress(),
        /* 언제 성공했고 언제 실패했나 — 죽은 회차는 `status: "error"` 로 남는다 */
        history: (await loadCollectHistory()).slice(0, 30),
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * **다시 수집** (2026-09-01) — 실패한 날을 손으로 돌린다.
   *
   * 벤티지: "실패한 날에 대해서는 수동 버튼 하나 만들어서 재수집하게 하는 거야."
   *
   * ⚠️ **그날 값을 다시 받는 게 아니다.** 키움은 과거 시점의 수급을 안 준다 —
   * 지금 받으면 지금까지의 최신 100일이 온다. 그래서 이 버튼은 「그날을 복구」가
   * 아니라 **「지금 다시 받아 빈 곳을 메운다」**이다. 최근 며칠이 빠졌으면
   * 대부분 메워지고, 100일보다 오래 빠진 구간은 못 메운다.
   */
  router.post("/ledger/collect", (_req, res) => {
    void startCollectDaily(client, undefined, 120, undefined, true);
    res.json({ started: true, progress: collectProgress() });
  });

  return router;
}
