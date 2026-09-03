import { Router } from "express";
import type { KiwoomClient } from "../kiwoomClient.js";
import { askSys, isSysAiReady, type SysStockRef } from "../sysAssist.js";
import type { AskTurn } from "../askMarket.js";
import { addAsk } from "../askHistory.js";

/**
 * 시스 도우미 (2026-09-03). 켜고 끄는 건 화면 설정(`vntg.sys.enabled`)이라 서버는 늘 받는다.
 *
 *   GET  /status  — AI 모드를 쓸 수 있나(ANTHROPIC_API_KEY)
 *   POST /ask     — { question, mode: "plain" | "ai", history?, focus?, useSearch? }
 */
export function createSysRouter(client: KiwoomClient): Router {
  const router = Router();

  router.get("/status", (_req, res) => {
    res.json({ aiReady: isSysAiReady() });
  });

  router.post("/ask", async (req, res, next) => {
    try {
      const question = String(req.body?.question ?? "").trim();
      if (!question) {
        res.status(400).json({ error: "질문이 비어 있습니다" });
        return;
      }
      const ai = req.body?.mode === "ai";
      const history = Array.isArray(req.body?.history) ? (req.body.history as AskTurn[]) : [];
      const f = req.body?.focus as { code?: string; name?: string } | undefined;
      const focus: SysStockRef | null =
        f && typeof f.code === "string" && /^\d{6}$/.test(f.code) ? { code: f.code, name: String(f.name ?? f.code) } : null;
      const r = await askSys(client, question, {
        ai,
        history,
        focus,
        useSearch: req.body?.useSearch !== false,
      });
      /* AI 로 물은 것은 「시황 질문하기」 기록에 같이 남긴다 — 무엇을 몰랐는지가 답보다 값어치 있다 */
      if (r.ai) {
        await addAsk({
          question: `[시스] ${question}`,
          answer: r.ai.text,
          model: r.ai.model,
          inputTokens: r.ai.inputTokens,
          outputTokens: r.ai.outputTokens,
          searches: r.ai.searches,
          sources: r.ai.sources,
          error: r.ai.error,
        }).catch(() => undefined);
      }
      res.json(r);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
