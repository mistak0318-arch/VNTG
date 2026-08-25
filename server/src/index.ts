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
import { createUsKiwoomRouter } from "./routes/usKiwoom.js";
import { createNewsRouter } from "./routes/news.js";
import { createNotesRouter } from "./routes/notes.js";
import { createOverviewRouter } from "./routes/overview.js";
import { createRankingRouter } from "./routes/ranking.js";
import { createReportRouter } from "./routes/report.js";
import { startReportScheduler } from "./reportScheduler.js";
import { startSnapshotRefresher } from "./marketSnapshot.js";
import { startTrackingRefresher } from "./watchTracking.js";
import { createSettingsRouter } from "./routes/settings.js";
import { startAlertScheduler } from "./alertScheduler.js";
import { startChannelScheduler } from "./channelScheduler.js";
import { createAiRouter } from "./routes/ai.js";
import { createAskRouter } from "./routes/ask.js";
import { createTradeRouter } from "./routes/trade.js";
import { createCustomThemeRouter } from "./routes/customThemes.js";
import { createRankSpecRouter } from "./routes/rankSpec.js";
import { createSectorFlowRouter } from "./routes/sectorFlow.js";
import { createPulseRouter } from "./routes/pulse.js";
import { createUsKrRouter } from "./routes/usKr.js";
import { createAlertRouter } from "./routes/alert.js";
import { createBacktestRouter } from "./routes/backtest.js";
import { createWidgetRouter } from "./routes/widget.js";
import { createBriefingRouter } from "./routes/briefing.js";
import { createBreadthRouter } from "./routes/breadth.js";
import { createChannelsRouter } from "./routes/channels.js";
import { createCalendarVisionRouter } from "./routes/calendarVision.js";
import { createFocusRouter } from "./routes/focus.js";
import { createRealtimeRouter } from "./routes/realtime.js";
import { startRealtimeScheduler } from "./realtimeHub.js";
import { createSignalRouter } from "./routes/signal.js";
import { createPaperRouter } from "./routes/paper.js";
import { createJournalRouter } from "./routes/journal.js";
import { createDartRouter } from "./routes/dart.js";
import { createUsWatchRouter } from "./routes/usWatch.js";
import { createKeywordRouter } from "./routes/keyword.js";
import { createDisclosureRouter } from "./routes/disclosure.js";
import { startDisclosureScheduler } from "./disclosureAlert.js";
import { startKeywordScheduler } from "./keywordAlert.js";
import { startSignalTrackScheduler } from "./signalTrack.js";
import { startLeaderScanScheduler } from "./leaderScan.js";
import { createEventPlayRouter } from "./routes/eventPlay.js";
import { startCloseBetScheduler } from "./closeBetLog.js";
import { createWatchlistRouter } from "./routes/watchlist.js";

const app = express();

/*
 * CORS 를 좁힌다.
 *
 * 예전엔 `cors()` 전면 허용이었다. 집 안에서만 쓸 때는 문제가 없었지만,
 * **서버가 인터넷에 닿는 순간** 내가 방문한 아무 웹사이트나 이 API 를 부를 수 있게 된다 —
 * 그 페이지의 자바스크립트가 내 계좌 잔고와 관심종목을 읽어 갈 수 있다는 뜻이다.
 *
 * `ALLOWED_ORIGINS` 를 콤마로 적으면 그 출처만 허용한다.
 * **안 적으면 예전처럼 전면 허용**이라 지금 개발·집 안 사용은 그대로 돌아간다.
 * 밖으로 열 때 반드시 채울 것.
 */
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors(
    allowedOrigins.length === 0
      ? undefined
      : {
          origin(origin, cb) {
            // 같은 출처(브라우저가 Origin 을 안 보냄)와 목록에 있는 것만
            if (!origin || allowedOrigins.includes(origin)) cb(null, true);
            else cb(new Error("허용되지 않은 출처입니다"));
          },
          credentials: true,
        },
  ),
);
app.use(express.json({ limit: "12mb" })); // 캘린더 이미지가 base64로 온다

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
app.use("/api/us-kiwoom", createUsKiwoomRouter(client));
app.use("/api/ranking", createRankingRouter(client));
app.use("/api/algo", createAlgoRouter(client));
app.use("/api/overview", createOverviewRouter(client));
app.use("/api/watchlist", createWatchlistRouter(client));
app.use("/api/feed", createNewsRouter(client));
app.use("/api/settings", createSettingsRouter());
app.use("/api/calendar", createCalendarRouter());
app.use("/api/notes", createNotesRouter(client));
app.use("/api/signal", createSignalRouter(client));
app.use("/api/paper", createPaperRouter(client));
app.use("/api/journal", createJournalRouter(client));
app.use("/api/dart", createDartRouter());
app.use("/api/us-watch", createUsWatchRouter());
app.use("/api/keyword", createKeywordRouter());
app.use("/api/disclosure-alert", createDisclosureRouter());
app.use("/api/breadth", createBreadthRouter(client));
app.use("/api/alert", createAlertRouter(client));
app.use("/api/backtest", createBacktestRouter(client));
app.use("/api/widget", createWidgetRouter(client));
app.use("/api/briefing", createBriefingRouter(client));
app.use("/api/ai", createAiRouter());
app.use("/api/ask", createAskRouter(client));
app.use("/api/trade", createTradeRouter(client));
app.use("/api/custom-themes", createCustomThemeRouter(client));
app.use("/api/sector-flow", createSectorFlowRouter(client));
app.use("/api/rank", createRankSpecRouter(client));
app.use("/api/pulse", createPulseRouter(client));
app.use("/api/event-plays", createEventPlayRouter(client));
app.use("/api/us-kr", createUsKrRouter(client));
app.use("/api/channels", createChannelsRouter());
app.use("/api/calendar-vision", createCalendarVisionRouter());
/* 창들을 한 프로그램처럼 묶는 자리 — 지금 보고 있는 종목 */
app.use("/api/focus", createFocusRouter());
/* 실시간 웹소켓 — 접속 규약 확인 단계 */
app.use("/api/realtime", createRealtimeRouter(client));
app.use("/api/report", createReportRouter(client));

// 07/12/18시에 리포트를 발행한다 (AI 요약은 이때만 생성)
startReportScheduler(client);
startSnapshotRefresher(client);
startTrackingRefresher(client);
startAlertScheduler(client);
startChannelScheduler();
  startKeywordScheduler();
startSignalTrackScheduler(client);
startLeaderScanScheduler(client);
startCloseBetScheduler(client);
/* 장 시간에 알아서 붙어 거래원·프로그램매매를 쌓는다 — 화면을 안 봐도 */
startRealtimeScheduler(client);
  startDisclosureScheduler();

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
/*
 * 어디에 귀를 열까.
 *
 * 기본은 `0.0.0.0` — 같은 Wi-Fi 의 휴대폰에서 이 PC 의 IP 로 들어와야 하기 때문이다.
 *
 * **터널을 쓸 때는 `BIND_HOST=127.0.0.1` 로 좁힌다.** 터널(cloudflared)은 같은 기계
 * 안에서 로컬로 붙으므로 밖에 귀를 열 이유가 없다 — 좁혀 두면 공유기 안의 다른 기기에도
 * 안 보인다. 열린 문은 적을수록 좋다.
 */
const host = process.env.BIND_HOST ?? "0.0.0.0";
app.listen(port, host, () => {
  console.log(`VNTG HTS server listening on ${host}:${port}`);
  if (host === "0.0.0.0") for (const ip of localIPv4()) console.log(`  http://${ip}:${port}`);
  if (allowedOrigins.length > 0) console.log(`  CORS 허용: ${allowedOrigins.join(", ")}`);
});
