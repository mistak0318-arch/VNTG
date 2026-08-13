import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// dotenv 기본값은 실행 위치(cwd)의 .env라서, 작업 스케줄러처럼 다른 폴더에서
// 띄우면 키를 못 읽는다. 이 파일 기준으로 server/.env를 직접 지정한다.
const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, ".."); // dist/ 또는 src/ 의 상위 = server/
dotenv.config({ path: path.join(serverRoot, ".env") });
import { createKiwoomClientFromEnv, KiwoomApiError } from "./kiwoomClient.js";
import { createAccountRouter } from "./routes/account.js";
import { createAlgoRouter } from "./routes/algo.js";
import { createCalendarRouter } from "./routes/calendar.js";
import { createMarketRouter } from "./routes/market.js";
import { createNewsRouter } from "./routes/news.js";
import { createNotesRouter } from "./routes/notes.js";
import { createOverviewRouter } from "./routes/overview.js";
import { createRankingRouter } from "./routes/ranking.js";
import { createReportRouter } from "./routes/report.js";
import { startReportScheduler } from "./reportScheduler.js";
import { createSettingsRouter } from "./routes/settings.js";
import { createBreadthRouter } from "./routes/breadth.js";
import { createSignalRouter } from "./routes/signal.js";
import { createWatchlistRouter } from "./routes/watchlist.js";

const app = express();
app.use(cors());
app.use(express.json());

const startedAt = Date.now();

/** 이 PC의 사설 IPv4 목록. 공유기가 IP를 바꿔도 헬스체크로 새 주소를 알 수 있다. */
function localIPv4(): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) out.push(a.address);
    }
  }
  return out;
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    startedAt: new Date(startedAt).toISOString(),
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    addresses: localIPv4(),
    keysConfigured: {
      kiwoom: Boolean(process.env.KIWOOM_APP_KEY && process.env.KIWOOM_APP_SECRET),
      dart: Boolean(process.env.DART_API_KEY),
      naver: Boolean(process.env.NAVER_CLIENT_ID && process.env.NAVER_CLIENT_SECRET),
    },
  });
});

const client = createKiwoomClientFromEnv();
app.use("/api/account", createAccountRouter(client));
app.use("/api/market", createMarketRouter(client));
app.use("/api/ranking", createRankingRouter(client));
app.use("/api/algo", createAlgoRouter(client));
app.use("/api/overview", createOverviewRouter(client));
app.use("/api/watchlist", createWatchlistRouter(client));
app.use("/api/feed", createNewsRouter());
app.use("/api/settings", createSettingsRouter());
app.use("/api/calendar", createCalendarRouter());
app.use("/api/notes", createNotesRouter(client));
app.use("/api/signal", createSignalRouter(client));
app.use("/api/breadth", createBreadthRouter(client));
app.use("/api/report", createReportRouter(client));

// 07/12/18시에 리포트를 발행한다 (AI 요약은 이때만 생성)
startReportScheduler(client);

/**
 * 프로덕션(미니PC)에서는 web을 빌드한 결과(web/dist)를 이 서버가 같이 서빙한다.
 * 프로세스 하나·포트 하나로 끝나서 pm2 등록과 방화벽 설정이 단순해진다.
 * dist가 없으면(개발 중) 그냥 건너뛰고 Vite dev 서버를 쓰면 된다.
 */
const webDist = path.resolve(serverRoot, "../web/dist");
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  // 해시 라우팅이라 SPA fallback은 index.html 하나면 충분하다
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/")) return next();
    res.sendFile(path.join(webDist, "index.html"));
  });
  console.log(`web/dist 서빙: ${webDist}`);
} else {
  console.log("web/dist 없음 — 개발 모드 (Vite dev 서버를 따로 실행하세요)");
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  if (err instanceof KiwoomApiError) {
    res.status(502).json({ error: err.message, returnCode: err.returnCode, raw: err.raw });
    return;
  }
  const message = err instanceof Error ? err.message : "알 수 없는 서버 오류";
  res.status(500).json({ error: message });
});

const port = Number(process.env.PORT ?? 4000);
// 0.0.0.0으로 열어야 같은 Wi-Fi의 휴대폰에서 이 PC의 IP로 접속 가능
app.listen(port, "0.0.0.0", () => {
  console.log(`VNTG HTS server listening on port ${port}`);
  for (const ip of localIPv4()) console.log(`  http://${ip}:${port}`);
});
