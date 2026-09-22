/**
 * **Cloudflare 엣지 관측** (2026-09-22 — 벤티지: "왜 갑자기 홍콩으로 붙이는거야?", "내일도 그러는지
 * 아닌지는 봐야겠다").
 *
 * 그날 「갑자기 느려졌다」를 조사하다 찾은 것: 우리 도메인은 **홍콩(HKG)** 엣지로, 같은 PC 에서
 * `cloudflare.com` 은 **서울(ICN)** 로 붙었다. TCP 연결 시간 44ms 대 6ms. traceroute 는 1~11홉이
 * 똑같고 마지막만 갈렸다 — 집 인터넷이 아니라 **Cloudflare 가 그 대역을 서울에서 안 받는다**는 뜻이다.
 *
 * 문제는 **어제 값이 없어서 「갑자기」인지 원래 그랬는지 모른다**는 것이었다. 그래서 날마다 찍는다.
 *
 *   npx tsx server/tools/cfEdge.ts          한 번 재고 한 줄 덧붙인다
 *   npx tsx server/tools/cfEdge.ts --show   쌓인 기록을 표로 본다
 *
 * ⚠️ **이 PC(메인 PC)에서 도는 도구다.** 미니PC·키움과 무관하고 조회도 안 쓴다 — 장중에 돌려도 된다.
 * 다만 잰 값은 **이 PC 에서 본 것**이라 폰(5G)은 다른 엣지일 수 있다.
 */
import net from "node:net";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const LOG = join(here, "..", "data", "cfEdge.log");

/** 우리 도메인 · 대조군(유료 대역이라 늘 ICN 으로 붙던 곳) */
const TARGETS = [
  { name: "vntgts", host: "vntgts.com" },
  { name: "cf", host: "cloudflare.com" },
] as const;

/** TCP 연결까지 걸린 시간 — TLS·HTTP 를 빼야 순수 네트워크 거리가 나온다 */
function tcpMs(host: string, port = 443): Promise<number | null> {
  return new Promise((res) => {
    const t0 = Date.now();
    const s = net.connect({ host, port });
    s.setTimeout(5000, () => {
      s.destroy();
      res(null);
    });
    s.on("connect", () => {
      const ms = Date.now() - t0;
      s.destroy();
      res(ms);
    });
    s.on("error", () => res(null));
  });
}

/** `/cdn-cgi/trace` 는 엣지가 직접 답한다 — 터널·서버를 안 타므로 엣지만 잰다 */
async function colo(host: string): Promise<{ colo: string; ms: number } | null> {
  const t0 = Date.now();
  try {
    const r = await fetch(`https://${host}/cdn-cgi/trace`, { signal: AbortSignal.timeout(15000) });
    const txt = await r.text();
    const kv = Object.fromEntries(txt.trim().split("\n").map((l) => l.split("=")));
    return kv.colo ? { colo: kv.colo, ms: Date.now() - t0 } : null;
  } catch {
    return null;
  }
}

/** 중앙값 — 한 번 튄 값에 끌려가지 않게 */
function mid(xs: number[]): number | null {
  const v = xs.filter((x): x is number => x !== null && Number.isFinite(x)).sort((a, b) => a - b);
  return v.length === 0 ? null : v[Math.floor(v.length / 2)];
}

async function measure(): Promise<string> {
  const now = new Date(Date.now() + 9 * 3600_000).toISOString().replace("T", " ").slice(0, 16);
  const parts: string[] = [now];
  for (const t of TARGETS) {
    const c = await colo(t.host);
    const runs: number[] = [];
    for (let i = 0; i < 5; i++) {
      const v = await tcpMs(t.host);
      if (v !== null) runs.push(v);
    }
    parts.push(`${t.name}=${c?.colo ?? "?"}/${mid(runs) ?? "?"}ms`);
  }
  return parts.join("\t");
}

async function show(): Promise<void> {
  let txt = "";
  try {
    txt = await readFile(LOG, "utf8");
  } catch {
    console.log("아직 기록이 없다 — 인자 없이 한 번 돌려라");
    return;
  }
  const lines = txt.trim().split("\n").filter(Boolean);
  console.log(`기록 ${lines.length}줄 (가장 오래된 것부터)\n`);
  console.log("시각                우리(colo/지연)      대조군(colo/지연)");
  for (const l of lines.slice(-40)) {
    const [t, a, b] = l.split("\t");
    console.log(`${t}   ${(a ?? "").padEnd(22)} ${b ?? ""}`);
  }
  /* 우리 colo 가 몇 가지로 갈렸나 — 하나뿐이면 「원래 그렇다」, 바뀌었으면 그날이 분기점이다 */
  const colos = new Map<string, number>();
  for (const l of lines) {
    const m = l.split("\t")[1]?.match(/vntgts=([A-Z?]+)/);
    if (m) colos.set(m[1], (colos.get(m[1]) ?? 0) + 1);
  }
  console.log(`\n우리 도메인이 붙은 엣지: ${[...colos].map(([k, v]) => `${k} ${v}회`).join(" · ")}`);
}

if (process.argv.includes("--show")) {
  await show();
} else {
  const line = await measure();
  await mkdir(dirname(LOG), { recursive: true });
  await appendFile(LOG, line + "\n", "utf8");
  console.log(line);
}
