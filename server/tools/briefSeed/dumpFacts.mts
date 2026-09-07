/**
 * 재료만 뽑아 묶음 파일로 (2026-09-08).
 *
 * 실행: server/ 에서 `npx tsx tools/briefSeed/dumpFacts.mts [--size 40] [--limit N]`
 *
 * ## 왜 AI 를 안 부르나
 *
 * `fillBriefs.mts` 는 재료를 모아 **Anthropic API 로 보내** 글을 받는다. 그건 별도
 * 크레딧을 쓴다. 벤티지: "아 뭐야 너 크레딧으로 하고있는거였어??? 그냥 지금 니 모델로
 * 해야지." — 맞는 말이다. 세션에 이미 붙어 있는 모델을 두고 API 를 또 살 이유가 없다.
 *
 * 그래서 갈라 놓는다:
 *
 *   dumpFacts   재료 수집만 (DART·네이버·한투 — 전부 무료 한도 안)  ← 이 파일
 *   (시스가 읽고 글을 쓴다)
 *   applyBriefs 받아 적은 글을 companyBriefs.json 에 넣는다
 *
 * ## 형식이 JSON 이 아니라 텍스트인 이유
 *
 * 읽는 쪽이 사람이 아니라 모델이다. JSON 은 따옴표·중괄호·이스케이프에 토큰을
 * 그냥 버린다. 같은 재료를 텍스트로 두면 3할쯤 싸다.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import dotenv from "dotenv";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
dotenv.config({ path: path.join(serverRoot, ".env") });

const { companyFacts, generatedBrief } = await import("../../src/companyInfo.js");
const { themesOfStock } = await import("../../src/naverThemes.js");
const { getDisclosures, searchNews } = await import("../../src/newsDisclosure.js");
const { quarterFinance } = await import("../../src/quarterFinance.js");
const { opinionBrief } = await import("../../src/analystOpinion.js");

const argv = process.argv.slice(2);
function opt(name: string, dflt: number): number {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const n = Number(argv[i + 1]);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}
/** 한 묶음에 몇 종목 — 읽는 쪽 한 번에 삼킬 만한 크기 */
const SIZE = opt("size", 40);
const LIMIT = opt("limit", Infinity);
const CONC = opt("conc", 4);

interface SnapStock {
  code: string;
  name: string;
  marketCap: number;
  sector?: string;
  market?: string;
}

const snap = JSON.parse(await fs.readFile(path.join(serverRoot, "data", "marketSnapshot.json"), "utf-8")) as {
  stocks: SnapStock[];
};
const all = [...snap.stocks].sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0));

/* 이미 엮어 둔 것은 건너뛴다 (바닥값 seed 는 「엮은 것」으로 안 친다) */
const todo: SnapStock[] = [];
for (const s of all) {
  if (todo.length >= LIMIT) break;
  if (await generatedBrief(s.code)) continue;
  todo.push(s);
}

console.log(`재료 뽑을 종목 ${todo.length} (전체 ${all.length}) · 묶음 ${SIZE}개씩 · 동시 ${CONC}`);

const OUT_DIR = path.join(serverRoot, "data", "briefFacts");
await fs.mkdir(OUT_DIR, { recursive: true });

/** 억 단위를 사람이 읽는 단위로 — companyInfo 와 같은 규칙 */
function won(v: number | null): string {
  if (v === null) return "-";
  if (Math.abs(v) >= 10_000) return `${(v / 10_000).toFixed(1)}조원`;
  return `${Math.round(v).toLocaleString("ko-KR")}억원`;
}

async function factsOf(s: SnapStock): Promise<string | null> {
  const [facts, themes, disclosures, news, quarters, opinion] = await Promise.all([
    companyFacts(s.code).catch(() => null),
    themesOfStock(s.code).catch(() => []),
    getDisclosures(s.code, 90).catch(() => []),
    searchNews(s.name).catch(() => []),
    quarterFinance(s.code, 4).catch(() => []),
    opinionBrief(s.code, null).catch(() => null),
  ]);

  const L: string[] = [];
  L.push(`=== ${s.name}(${s.code}) · ${s.market === "kosdaq" ? "코스닥" : "코스피"} · ${s.sector ?? "-"} · 시총 ${won(s.marketCap)}`);

  if (facts) {
    const line = [
      facts.corpName ? `정식명 ${facts.corpName}` : null,
      facts.industry ? `업종 ${facts.industry}` : null,
      [facts.sectorLarge, facts.sectorMid, facts.sectorSmall].filter(Boolean).join(">") || null,
      facts.establishedAt ? `설립 ${facts.establishedAt.slice(0, 4)}` : null,
      facts.ceo ? `대표 ${facts.ceo}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    if (line) L.push(`[기본] ${line}`);
  }

  if (themes.length > 0) {
    /*
     * 편입 사유를 60자에서 끊는다. 네이버 것이 통째로는 한 종목에 700자를 넘기도 하는데
     * (SKC 의 유리기판 항목이 그렇다) **앞머리에 이미 「왜 이 테마인가」가 들어 있다.**
     * 뒤는 대개 착공 연월·공장 위치 같은 곁가지다.
     */
    L.push(
      `[테마] ${themes
        .slice(0, 5)
        .map((t) => `${t.name}${t.desc ? `(${t.desc.length > 60 ? `${t.desc.slice(0, 60)}…` : t.desc})` : ""}`)
        .join(" / ")}`,
    );
  }

  /* companyInfo 와 같은 방어 — 영업이익은 매출을 넘을 수 없다 */
  const sane = quarters.filter((q) => q.revenue !== null && q.revenue > 0 && !(q.operatingProfit !== null && Math.abs(q.operatingProfit) > q.revenue));
  if (sane.length > 0) {
    L.push(
      `[분기] ${sane
        .slice(0, 4)
        .map(
          (q) =>
            `${q.label} 매출 ${won(q.revenue)}·영익 ${won(q.operatingProfit)}` +
            `${q.margin !== null ? `(${q.margin.toFixed(1)}%)` : ""}` +
            `${q.yoy !== null ? ` YoY${q.yoy > 0 ? "+" : ""}${q.yoy.toFixed(0)}%` : ""}`,
        )
        .join(" / ")}`,
    );
  }

  if (opinion) {
    L.push(
      `[목표주가] 증권사 ${opinion.brokerCount}곳` +
        `${opinion.upside !== null ? ` 현재가 대비 ${opinion.upside > 0 ? "+" : ""}${opinion.upside}%` : ""}` +
        `${opinion.recentMove > 0 ? " 최근 상향" : opinion.recentMove < 0 ? " 최근 하향" : ""}`,
    );
  }

  if (disclosures.length > 0) {
    L.push(`[공시90일] ${disclosures.slice(0, 6).map((d) => `${d.receiptDate.slice(5)} ${d.reportName}`).join(" / ")}`);
  }

  if (news.length > 0) {
    L.push(`[뉴스] ${news.slice(0, 6).map((n) => n.title).join(" / ")}`);
  }

  /* 기본 줄 하나뿐이면 쓸 게 없다 — 빈칸이 틀린 설명보다 낫다 */
  return L.length <= 1 ? null : L.join("\n");
}

let done = 0;
let empty = 0;
const results = new Array<string | null>(todo.length);
let cursor = 0;
const started = Date.now();

async function worker(): Promise<void> {
  for (;;) {
    const i = cursor++;
    if (i >= todo.length) return;
    try {
      results[i] = await factsOf(todo[i]);
    } catch {
      results[i] = null;
    }
    if (results[i] === null) empty++;
    done++;
    if (done % 50 === 0 || done === todo.length) {
      const el = (Date.now() - started) / 1000;
      console.log(`  ${done}/${todo.length} · 재료없음 ${empty} · ${(done / el).toFixed(1)}종목/초 · 남은 ${Math.round((todo.length - done) / (done / el) / 60)}분`);
    }
  }
}
await Promise.all(Array.from({ length: CONC }, () => worker()));

/* 재료가 있는 것만 묶음으로 나눠 쓴다 */
const kept = results.map((r, i) => ({ s: todo[i], text: r })).filter((x) => x.text !== null);
let n = 0;
const index: { file: string; from: string; to: string; count: number }[] = [];
for (let i = 0; i < kept.length; i += SIZE) {
  const chunk = kept.slice(i, i + SIZE);
  n++;
  const file = `batch-${String(n).padStart(3, "0")}.txt`;
  await fs.writeFile(path.join(OUT_DIR, file), chunk.map((c) => c.text).join("\n\n"), "utf-8");
  index.push({ file, from: chunk[0].s.name, to: chunk[chunk.length - 1].s.name, count: chunk.length });
}
await fs.writeFile(path.join(OUT_DIR, "_index.json"), JSON.stringify(index, null, 1), "utf-8");

console.log(`\n끝. ${((Date.now() - started) / 60000).toFixed(1)}분 · 재료 있는 종목 ${kept.length} · 재료없음 ${empty} · 묶음 ${n}개`);
console.log(`→ ${OUT_DIR}`);
