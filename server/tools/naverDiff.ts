/**
 * **네이버와 우리 값 맞대기** (2026-09-24 — 벤티지: "네이버에서 확인할 수 있는 모든 값과 우리 값의 괴리를 찾아서").
 *
 * 키움·한투는 안 부른다. 우리 값은 (a) 바깥 소스로 계산하는 모듈을 그대로 돌리거나(글로벌·미국 지수·해외 종목)
 * (b) 서버가 남긴 파일(정규장 종가·일봉·수급 원장)에서 읽는다. 네이버는 모바일 증권 JSON.
 *
 *   npx tsx tools/naverDiff.ts            # 전부
 *   npx tsx tools/naverDiff.ts global     # 한 갈래만: global | usidx | kr | flow | us
 */
import "dotenv/config";
import { readFile, readdir } from "node:fs/promises";
import { fetchQuotes } from "../src/globalMarket.js";
import { usMajorIndices } from "../src/usMajor.js";
import { loadCloses } from "../src/dailyCloses.js";

const UA = { "User-Agent": "Mozilla/5.0", Referer: "https://m.stock.naver.com/" };
const only = process.argv[2] ?? "";
const num = (v: unknown): number | null => {
  const n = Number(String(v ?? "").replace(/[,+%\s]/g, ""));
  return Number.isFinite(n) && String(v ?? "") !== "" ? n : null;
};
async function nj<T = Record<string, unknown>>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}
type Row = { what: string; ours: string; naver: string; verdict: "OK" | "≠" | "?"; note?: string };
const rows: Row[] = [];
const say = (r: Row) => {
  rows.push(r);
  console.log(`${r.verdict.padEnd(2)} ${r.what.padEnd(28)} 우리 ${r.ours.padEnd(24)} 네이버 ${r.naver.padEnd(24)} ${r.note ?? ""}`);
};
const close = (a: number | null, b: number | null, tol: number) => a !== null && b !== null && Math.abs(a - b) <= tol;
const fmt = (p: number | null, r: number | null, d = 2) => `${p === null ? "-" : p.toLocaleString("en-US", { maximumFractionDigits: d })} (${r === null ? "-" : `${r > 0 ? "+" : ""}${r.toFixed(2)}%`})`;

/* ── ① 글로벌: 환율·원자재·VIX·아시아 지수 ── */
async function global() {
  console.log("\n## ① 글로벌 카드 (globalMarket ← 야후)  vs  네이버");
  const map: { key: string; symbol: string; naver: string; tol: number }[] = [
    { key: "usdkrw", symbol: "KRW=X", naver: "mi:exchange:FX_USDKRW", tol: 3 },
    { key: "usdjpy", symbol: "JPY=X", naver: "mi:exchange:FX_USDJPY", tol: 0.5 },
    { key: "jpykrw", symbol: "JPYKRW=X", naver: "mi:exchange:FX_JPYKRW", tol: 3 },
    { key: "vix", symbol: "^VIX", naver: "idx:.VIX", tol: 0.05 },
    { key: "n225", symbol: "^N225", naver: "idx:.N225", tol: 1 },
    { key: "hsi", symbol: "^HSI", naver: "idx:.HSI", tol: 1 },
    { key: "hsce", symbol: "^HSCE", naver: "idx:.HSCE", tol: 1 },
    { key: "wti", symbol: "CL=F", naver: "mi:energy:CLcv1", tol: 0.5 },
    { key: "brent", symbol: "BZ=F", naver: "mi:energy:LCOcv1", tol: 0.5 },
    { key: "gold", symbol: "GC=F", naver: "mi:metals:GCcv1", tol: 5 },
    { key: "silver", symbol: "SI=F", naver: "mi:metals:SIcv1", tol: 0.2 },
    { key: "copper", symbol: "HG=F", naver: "mi:metals:HGcv1", tol: 0.05 },
    { key: "natgas", symbol: "NG=F", naver: "mi:energy:NGcv1", tol: 0.05 },
  ];
  const ours = await fetchQuotes(map.map((m) => m.symbol));
  for (const m of map) {
    const o = ours.get(m.symbol);
    let np: number | null = null;
    let nr: number | null = null;
    let nnote = "";
    if (m.naver.startsWith("idx:")) {
      const j = await nj(`https://api.stock.naver.com/index/${m.naver.slice(4)}/basic`);
      np = num(j?.closePrice);
      nr = num(j?.fluctuationsRatio);
      nnote = String(j?.localTradedAt ?? "").slice(0, 16);
    } else {
      const [, cat, code] = m.naver.split(":");
      const j = await nj<{ isSuccess?: boolean; result?: Record<string, unknown> }>(
        `https://m.stock.naver.com/front-api/marketIndex/productDetail?category=${cat}&reutersCode=${encodeURIComponent(code)}`,
      );
      const r = j?.result;
      np = num(r?.closePrice);
      nr = num(r?.fluctuationsRatio);
      nnote = String(r?.localTradedAt ?? "").slice(0, 16);
      if (!j?.isSuccess) nnote = `네이버 코드 없음(${code})`;
    }
    const op = o?.price ?? null;
    const or = o?.changeRate ?? null;
    const okP = close(op, np, m.tol);
    const okR = close(or, nr, 0.06);
    say({
      what: `${m.key} ${m.symbol}`,
      ours: fmt(op, or),
      naver: fmt(np, nr),
      verdict: np === null ? "?" : okP && okR ? "OK" : "≠",
      note: `${nnote}${o?.error ? ` 우리오류:${o.error}` : ""}`,
    });
  }
}

/* ── ② 미국 지수·금리·원자재 카드 (usMajor) ── */
async function usidx() {
  console.log("\n## ② 미국 지수·원자재 카드 (usMajor ← 야후)  vs  네이버");
  const res = await usMajorIndices(true);
  const map: Record<string, { naver: string; tol: number }> = {
    gspc: { naver: "idx:.INX", tol: 0.5 },
    ndx: { naver: "idx:.NDX", tol: 0.5 },
    sox: { naver: "idx:.SOX", tol: 0.5 },
    vix: { naver: "idx:.VIX", tol: 0.05 },
    tnx: { naver: "mi:bond:US10YT=RR", tol: 0.02 },
    wti: { naver: "mi:energy:CLcv1", tol: 0.5 },
    brent: { naver: "mi:energy:LCOcv1", tol: 0.5 },
    gold: { naver: "mi:metals:GCcv1", tol: 5 },
  };
  for (const r of res.rows as { key: string; label: string; price: number | null; changeRate: number | null }[]) {
    const m = map[r.key];
    if (!m) continue;
    let np: number | null = null;
    let nr: number | null = null;
    if (m.naver.startsWith("idx:")) {
      const j = await nj(`https://api.stock.naver.com/index/${m.naver.slice(4)}/basic`);
      np = num(j?.closePrice);
      nr = num(j?.fluctuationsRatio);
    } else {
      const [, cat, code] = m.naver.split(":");
      const j = await nj<{ result?: Record<string, unknown> }>(
        `https://m.stock.naver.com/front-api/marketIndex/productDetail?category=${cat}&reutersCode=${encodeURIComponent(code)}`,
      );
      np = num(j?.result?.closePrice);
      nr = num(j?.result?.fluctuationsRatio);
    }
    say({
      what: `${r.key} ${r.label}`,
      ours: fmt(r.price, r.changeRate, 3),
      naver: fmt(np, nr, 3),
      verdict: np === null ? "?" : close(r.price, np, m.tol) && close(r.changeRate, nr, 0.06) ? "OK" : "≠",
    });
  }
  const nf = res.nightFutures as { price: number | null; changeRate: number | null } | null;
  const fut = await nj("https://m.stock.naver.com/api/index/FUT/basic");
  say({ what: "야간선물 vs 네이버 FUT(주간)", ours: fmt(nf?.price ?? null, nf?.changeRate ?? null), naver: fmt(num(fut?.closePrice), num(fut?.fluctuationsRatio)), verdict: "?", note: "기준이 다르다(야간 vs 주간) — 참고만" });
}

/* ── ③ 국내 종가·시고저: 우리 일봉(dailyCloses)·정규장 종가 파일  vs  네이버 일별 시세 ── */
async function kr() {
  console.log("\n## ③ 국내 일봉·정규장 종가  vs  네이버 일별 시세");
  const store = await loadCloses();
  const bars = store.bars ?? {};
  const codes = Object.keys(bars);
  /* 표본: 거래대금 상위 파일에서 앞 20 + 무작위 20 */
  let sample: string[] = [];
  try {
    const rl = JSON.parse(await readFile("data/rankLast/trade-value.000.3.500..json", "utf8")) as { rows: { code: string }[] };
    sample = rl.rows.slice(0, 20).map((r) => r.code);
  } catch {
    /* 없으면 아래 무작위만 */
  }
  for (let i = 0; i < 20 && codes.length > 0; i++) sample.push(codes[Math.floor(Math.random() * codes.length)]);
  sample = [...new Set(sample)].filter((c) => bars[c]?.length);
  let ok = 0;
  let bad = 0;
  const closesDir = await readdir("data/regularCloses").catch(() => [] as string[]);
  const lastRc = closesDir.filter((f) => f.endsWith(".json")).sort().pop();
  const rc = lastRc ? (JSON.parse(await readFile(`data/regularCloses/${lastRc}`, "utf8")) as { closes: Record<string, number> }) : null;
  const rcDay = lastRc?.slice(0, 10).replace(/-/g, "") ?? "";
  for (const code of sample) {
    const mine = bars[code];
    const last = mine[mine.length - 1];
    const nv = await nj<{ localTradedAt: string; closePrice: string; openPrice: string; highPrice: string; lowPrice: string; accumulatedTradingVolume: string }[]>(
      `https://m.stock.naver.com/api/stock/${code}/price?pageSize=6`,
    );
    const day = last.d;
    const n = nv?.find((x) => x.localTradedAt.replace(/-/g, "") === day);
    if (!n) {
      say({ what: `${code} ${day}`, ours: `c ${last.c}`, naver: "그 날 없음", verdict: "?" });
      continue;
    }
    const b = last as { o: number; h: number; l: number; c: number; v?: number };
    const diffs: string[] = [];
    if (!close(b.c, num(n.closePrice), 0)) diffs.push(`종가 ${b.c}≠${n.closePrice}`);
    if (!close(b.o, num(n.openPrice), 0)) diffs.push(`시가 ${b.o}≠${n.openPrice}`);
    if (!close(b.h, num(n.highPrice), 0)) diffs.push(`고가 ${b.h}≠${n.highPrice}`);
    if (!close(b.l, num(n.lowPrice), 0)) diffs.push(`저가 ${b.l}≠${n.lowPrice}`);
    /* 정규장 종가 파일도 그 날이 있으면 */
    if (rc && rcDay === day && rc.closes[code] !== undefined && !close(rc.closes[code], num(n.closePrice), 0)) diffs.push(`정규장파일 ${rc.closes[code]}≠${n.closePrice}`);
    if (diffs.length === 0) ok += 1;
    else {
      bad += 1;
      say({ what: `${code} ${day}`, ours: `o${b.o} h${b.h} l${b.l} c${b.c}`, naver: `o${n.openPrice} h${n.highPrice} l${n.lowPrice} c${n.closePrice}`, verdict: "≠", note: diffs.join(" · ") });
    }
  }
  console.log(`   일봉 표본 ${sample.length}종목: 시·고·저·종 전부 일치 ${ok} · 어긋남 ${bad}  (마지막 날 기준, 정규장 종가 파일 ${lastRc ?? "없음"})`);
}

/* ── ④ 국내 수급·외국인 보유율: 우리 원장(data/daily)  vs  네이버 trend ── */
async function flow() {
  console.log("\n## ④ 국내 수급(외국인·기관·개인 순매수 주)·외국인 보유율  vs  네이버");
  let files = (await readdir("data/daily").catch(() => [] as string[])).filter((f) => /^\d{6}\.json$/.test(f));
  const pick = ["005930", "000660", "373220", "207940", "035420", "005380", "068270", "051910"];
  for (let i = 0; i < 12 && files.length; i++) pick.push(files[Math.floor(Math.random() * files.length)].slice(0, 6));
  const codes = [...new Set(pick)].filter((c) => files.includes(`${c}.json`));
  let ok = 0;
  let bad = 0;
  for (const code of codes) {
    const led = JSON.parse(await readFile(`data/daily/${code}.json`, "utf8")) as {
      flow: { d: string; ind: number; fgn: number; org: number }[];
      fgnRatio: { d: string; ratio: number }[];
    };
    const nv = await nj<{ bizdate: string; foreignerPureBuyQuant: string; organPureBuyQuant: string; individualPureBuyQuant: string; foreignerHoldRatio: string }[]>(
      `https://m.stock.naver.com/api/stock/${code}/trend?pageSize=8`,
    );
    if (!nv) continue;
    for (const f of led.flow.slice(-3)) {
      const n = nv.find((x) => x.bizdate === f.d);
      if (!n) continue;
      const diffs: string[] = [];
      if (!close(f.fgn, num(n.foreignerPureBuyQuant), 0)) diffs.push(`외국인 ${f.fgn}≠${n.foreignerPureBuyQuant}`);
      if (!close(f.org, num(n.organPureBuyQuant), 0)) diffs.push(`기관 ${f.org}≠${n.organPureBuyQuant}`);
      if (!close(f.ind, num(n.individualPureBuyQuant), 0)) diffs.push(`개인 ${f.ind}≠${n.individualPureBuyQuant}`);
      const fr = led.fgnRatio.find((x) => x.d === f.d);
      if (fr && !close(fr.ratio, num(n.foreignerHoldRatio), 0.011)) diffs.push(`보유율 ${fr.ratio}≠${n.foreignerHoldRatio}`);
      if (diffs.length === 0) ok += 1;
      else {
        bad += 1;
        say({ what: `${code} ${f.d}`, ours: `외 ${f.fgn} 기 ${f.org} 개 ${f.ind}`, naver: `외 ${n.foreignerPureBuyQuant} 기 ${n.organPureBuyQuant} 개 ${n.individualPureBuyQuant}`, verdict: "≠", note: diffs.join(" · ") });
      }
    }
  }
  console.log(`   수급 표본 ${codes.length}종목 × 최근 3일: 일치 ${ok} · 어긋남 ${bad}`);
}

/* ── ⑤ 해외 관심종목: 야후 quote(우리 대체 경로)  vs  네이버 basic ── */
async function us() {
  console.log("\n## ⑤ 해외 관심종목 — 야후(우리 폴백 경로)  vs  네이버 basic   ※ 본 시세(한투)는 오늘 안 부른다");
  const groups = JSON.parse(await readFile("data/usWatchlist.json", "utf8")) as { stocks: { symbol: string; name: string }[] }[];
  const syms = [...new Set(groups.flatMap((g) => g.stocks.map((s) => s.symbol)))].slice(0, 25);
  const { usFastQuotes } = await import("../src/usFastQuotes.js");
  const fast = await usFastQuotes(syms);
  let ok = 0;
  let bad = 0;
  for (const s of syms) {
    const q = fast.get(s);
    const cand = [`${s}.O`, `${s}.K`, `${s}.N`, `${s}.A`];
    let j: Record<string, unknown> | null = null;
    for (const c of cand) {
      j = await nj(`https://api.stock.naver.com/stock/${c}/basic`);
      if (j?.closePrice) break;
    }
    const np = num(j?.closePrice);
    const nr = num(j?.fluctuationsRatio);
    if (!q || np === null) {
      say({ what: s, ours: q ? fmt(q.price, q.changeRate) : "-", naver: np === null ? "네이버 없음" : fmt(np, nr), verdict: "?" });
      continue;
    }
    const good = close(q.price, np, Math.max(0.02, np * 0.0015)) && close(q.changeRate, nr, 0.06);
    if (good) ok += 1;
    else {
      bad += 1;
      say({ what: s, ours: fmt(q.price, q.changeRate), naver: fmt(np, nr), verdict: "≠", note: String(j?.marketStatus ?? "") });
    }
  }
  console.log(`   해외 ${syms.length}종목: 일치 ${ok} · 어긋남 ${bad}`);
}

const run: Record<string, () => Promise<void>> = { global, usidx, kr, flow, us };
for (const [k, fn] of Object.entries(run)) {
  if (only && only !== k) continue;
  await fn();
}
console.log(`\n합계: OK ${rows.filter((r) => r.verdict === "OK").length} · ≠ ${rows.filter((r) => r.verdict === "≠").length} · ? ${rows.filter((r) => r.verdict === "?").length}`);
process.exit(0);
