import { Router } from "express";
import type { KiwoomClient } from "../kiwoomClient.js";
import { act, askSys, getTopicExamples, interpret, isSysAiReady, recapToday, saveTopicExamples, type SysStockRef } from "../sysAssist.js";
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

  /** 해석만 (수 ms) — 화면이 「종목 두산에너빌리티 긁는 중」을 먼저 띄운다 */
  router.post("/interpret", async (req, res, next) => {
    try {
      const question = String(req.body?.question ?? "").trim();
      const f = req.body?.focus as { code?: string; name?: string } | undefined;
      const focus: SysStockRef | null =
        f && typeof f.code === "string" && /^\d{6}$/.test(f.code) ? { code: f.code, name: String(f.name ?? f.code) } : null;
      const { intent, hit } = await interpret(client, question, focus);
      res.json({ intent, titles: hit.map((t) => t.title) });
    } catch (err) {
      next(err);
    }
  });

  /** ① 오늘 되짚기 — 물어본 종목이 그 뒤로 어떻게 됐나 */
  router.get("/recap", async (_req, res, next) => {
    try {
      res.json(await recapToday(client));
    } catch (err) {
      next(err);
    }
  });

  /** ④ 주제별 예시 질문 — 기본 + 벤티지가 보탠 것 */
  router.get("/topics", async (_req, res, next) => {
    try {
      res.json({ topics: await getTopicExamples() });
    } catch (err) {
      next(err);
    }
  });
  router.put("/topics", async (req, res, next) => {
    try {
      await saveTopicExamples((req.body?.custom ?? {}) as Record<string, string[]>);
      res.json({ topics: await getTopicExamples() });
    } catch (err) {
      next(err);
    }
  });

  /** 제안을 실행 — 화면에서 「넣기」를 눌렀을 때만 온다 */
  router.post("/act", async (req, res, next) => {
    try {
      const kind = String(req.body?.kind ?? "");
      const payload = (req.body?.payload ?? {}) as Record<string, unknown>;
      res.json(await act(kind, payload, client));
    } catch (err) {
      next(err);
    }
  });

  /*
   * ## AI 모드는 **작업으로** (2026-09-03 — 벤티지: "AI 모드에서 긁어서 물어보기가 동작을 안 하는 듯,
   * 3분 넘게 기다렸는데 응답이 없음").
   *
   * 밖에서는 Cloudflare 터널로 들어오는데 터널은 한 요청을 **100초**까지만 기다린다. AI 모드는 웹 검색이
   * 붙으면 1~3분이라 응답이 오기 전에 끊겼고, 화면은 「긁는 중」에서 멈춘 것처럼 보였다.
   * 그래서 AI 모드는 바로 답하지 않고 **작업 번호**를 주고, 화면이 2초마다 묻는다. 서버가 다 하면
   * 그때 결과를 준다. 일반 모드는 몇 초라 예전처럼 바로.
   */
  const jobs = new Map<string, { at: number; status: "running" | "done" | "error"; result?: unknown; error?: string }>();
  const JOB_TTL = 30 * 60_000;
  const prune = () => {
    const now = Date.now();
    for (const [k, v] of jobs) if (now - v.at > JOB_TTL) jobs.delete(k);
  };

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
      const opts = {
        ai,
        history,
        focus,
        useSearch: req.body?.useSearch !== false,
        noClarify: req.body?.noClarify === true,
      };
      const run = async () => {
        const r = await askSys(client, question, opts);
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
        return r;
      };
      if (!ai) {
        res.json(await run());
        return;
      }
      prune();
      const jobId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const job = { at: Date.now(), status: "running" as const } as (typeof jobs) extends Map<string, infer V> ? V : never;
      jobs.set(jobId, job);
      void run()
        .then((r) => {
          job.status = "done";
          job.result = r;
        })
        .catch((err) => {
          job.status = "error";
          job.error = err instanceof Error ? err.message : String(err);
        });
      res.json({ jobId });
    } catch (err) {
      next(err);
    }
  });

  /** AI 작업 상태 — 화면이 2초마다 묻는다 */
  router.get("/job/:id", (req, res) => {
    const j = jobs.get(req.params.id);
    if (!j) {
      res.status(404).json({ error: "그 작업은 없다 (30분이 지났거나 서버가 다시 켜졌다)" });
      return;
    }
    res.json({ status: j.status, result: j.status === "done" ? j.result : undefined, error: j.error, elapsedMs: Date.now() - j.at });
  });

  return router;
}
