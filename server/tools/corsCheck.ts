/**
 * **CORS 문지기 점검** (2026-09-23).
 *
 * tailnet 우회로(`http://100.88.182.35:4000`)로 들어가니 화면이 하얗게만 떴다 — 브라우저가
 * Vite 의 `<script crossorigin>` 때문에 **같은 출처인데도 Origin 을 싣고**, `ALLOWED_ORIGINS` 에
 * 없는 출처라 **자기 자신의 JS·CSS 가 500 으로 거절**됐다.
 *
 * 고친 뒤 「같은 출처는 통과, 남의 사이트는 거절」이 둘 다 지켜지는지 확인한다.
 * 서버 전체를 띄우지 않고 **문지기 미들웨어만** 세워 본다 — 키움·미니PC 와 무관하다.
 *
 *   npx tsx tools/corsCheck.ts
 */
import express from "express";
import cors from "cors";
import type { AddressInfo } from "node:net";

const ALLOWED = ["https://vntgts.com"];

/* ── index.ts 와 같은 판정 ─────────────────────────────────────────── */
function isSameOrigin(headers: Record<string, unknown>): boolean {
  const origin = typeof headers.origin === "string" ? headers.origin : "";
  const host = typeof headers.host === "string" ? headers.host : "";
  if (!origin) return true;
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

const app = express();
app.use(
  cors((req, cb) => {
    const headers = req.headers as unknown as Record<string, unknown>;
    const origin = typeof headers.origin === "string" ? headers.origin : "";
    if (!origin || ALLOWED.includes(origin) || isSameOrigin(headers)) {
      cb(null, { origin: true, credentials: true });
    } else {
      cb(new Error("허용되지 않은 출처입니다"));
    }
  }),
);
app.get("/assets/app.js", (_req, res) => res.type("application/javascript").send("// ok"));
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(500).json({ error: "CORS 거절" });
});

const server = app.listen(0, "127.0.0.1", async () => {
  const { port } = server.address() as AddressInfo;
  const host = `127.0.0.1:${port}`;

  const cases: { 이름: string; origin?: string; 기대: number }[] = [
    { 이름: "Origin 없음 (curl·서버끼리)", 기대: 200 },
    { 이름: "목록에 있는 출처 (도메인)", origin: "https://vntgts.com", 기대: 200 },
    { 이름: "같은 출처 (tailnet 우회로) ★", origin: `http://${host}`, 기대: 200 },
    { 이름: "남의 사이트", origin: "https://evil.example.com", 기대: 500 },
    { 이름: "비슷하게 생긴 남의 사이트", origin: "https://vntgts.com.evil.io", 기대: 500 },
  ];

  let bad = 0;
  for (const c of cases) {
    const r = await fetch(`http://${host}/assets/app.js`, {
      headers: c.origin ? { Origin: c.origin, Host: host } : { Host: host },
    });
    const ok = r.status === c.기대;
    if (!ok) bad++;
    console.log(
      `${ok ? "✔" : "✘"} ${c.이름.padEnd(30)} → ${r.status} (기대 ${c.기대})` +
        (r.headers.get("access-control-allow-origin") ? `  ACAO=${r.headers.get("access-control-allow-origin")}` : ""),
    );
  }
  server.close();
  console.log(bad === 0 ? "\n전부 통과" : `\n⚠️ ${bad}건 어긋남`);
  process.exit(bad === 0 ? 0 : 1);
});
