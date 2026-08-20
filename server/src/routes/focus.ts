import { Router } from "express";

/**
 * 지금 보고 있는 종목 — **여러 창을 한 프로그램처럼 묶는 자리.**
 *
 * ## 무엇을 푸는가
 *
 * 모니터가 여럿이면 한쪽에서 종목을 고르고 다른 쪽에 차트·수급·공매도를 띄워 두고
 * 싶어진다. HTS 가 창을 여러 개 띄우고 종목을 연동시키는 게 딱 그 모양이다.
 * 브라우저 창은 서로 남남이라 그게 저절로 되지 않으므로, **가운데에 한 칸**을 둔다.
 *
 * ## 서버까지 오는 이유
 *
 * 같은 브라우저의 창끼리는 `BroadcastChannel` 로 즉시 주고받는다 — 서버를 거칠
 * 이유가 없고 지연도 없다. 하지만 그것만으로는 **미니PC 와 회사 PC**, 혹은 폰이
 * 서로 못 본다. 그 경우를 위해 여기 한 칸을 두고 각 화면이 짧은 주기로 물어본다.
 *
 * ## 저장하지 않는다
 *
 * 「지금 보고 있는 종목」은 그 순간에만 뜻이 있는 값이다. 파일로 남기면 다음날
 * 앱을 켰을 때 어제 보던 종목이 되살아나 **고르지도 않은 종목**이 보드에 뜬다.
 * 서버가 다시 뜨면 비는 게 맞다.
 */

export interface Focus {
  code: string;
  name: string;
  /** 언제 정해졌나 — 늦게 온 소식이 최신을 덮지 않게 하는 기준 */
  at: number;
  /** 누가 정했나. 자기가 보낸 걸 자기가 다시 받지 않으려고 쓴다 */
  by: string;
}

let current: Focus | null = null;

export function createFocusRouter(): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    res.json({ focus: current });
  });

  router.post("/", (req, res) => {
    const { code, name, by } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof code !== "string" || !code) {
      res.status(400).json({ error: "code 가 필요합니다" });
      return;
    }
    /*
     * 시각은 **서버가 찍는다.**
     * 기기마다 시계가 몇 초씩 다른데 그걸 그대로 믿으면, 시계가 빠른 기기가 한 번
     * 보낸 뒤로 다른 기기의 선택이 계속 「낡은 것」으로 밀려 무시된다.
     */
    current = {
      code,
      name: typeof name === "string" && name ? name : code,
      at: Date.now(),
      by: typeof by === "string" ? by : "",
    };
    res.json({ focus: current });
  });

  /** 연동 끄기 — 보드가 빈 화면으로 돌아간다 */
  router.delete("/", (_req, res) => {
    current = null;
    res.json({ focus: null });
  });

  return router;
}
