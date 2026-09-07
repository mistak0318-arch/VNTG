/**
 * 받아 적은 글을 `companyBriefs.json` 에 넣는다 (2026-09-08).
 *
 * 실행: server/ 에서
 *   npx tsx tools/briefSeed/applyBriefs.mts data/briefWrite/batch-001.txt [--model claude-opus-5]
 *   npx tsx tools/briefSeed/applyBriefs.mts data/briefWrite            ← 폴더째
 *
 * ## 입력 형식
 *
 * `=== 종목코드` 로 끊는다. 그 아래가 그 종목의 글 전체다.
 *
 *     === 049430
 *     1. 무슨 회사인가
 *     …
 *     3. 이익은 어느 쪽으로 가고 있나
 *     …
 *
 *     === 000100
 *     …
 *
 * ## 출처는 재료 파일에서 되짚는다
 *
 * 글을 쓴 쪽이 무엇을 보고 썼는지는 `data/briefFacts/` 의 같은 종목 항목에
 * `[테마] [분기] [공시90일] …` 로 남아 있다. 그걸 읽어 `sources` 를 채운다 —
 * 화면이 「무엇을 근거로 썼나」를 보여 주는 자리라 비워 둘 수 없다.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BRIEF_FILE = path.join(serverRoot, "data", "companyBriefs.json");
const FACTS_DIR = path.join(serverRoot, "data", "briefFacts");

const argv = process.argv.slice(2);
const target = argv.find((a) => !a.startsWith("--"));
if (!target) {
  console.error("쓸 파일이나 폴더를 주세요. 예: npx tsx tools/briefSeed/applyBriefs.mts data/briefWrite");
  process.exit(1);
}
const mi = argv.indexOf("--model");
/** 누가 썼는지. 화면 아래에 그대로 뜬다 */
const MODEL = mi >= 0 && argv[mi + 1] ? argv[mi + 1] : "claude-opus-5";

interface Brief {
  code: string;
  name: string;
  day: string;
  at: string;
  text: string;
  model: string | null;
  sources: string[];
  inputTokens: number;
  outputTokens: number;
}

/* ── 재료 파일에서 종목별 출처·이름을 훑어 둔다 ─────────────────── */

const SOURCE_LABEL: [string, string][] = [
  ["[기본]", "DART 기업개황"],
  ["[테마]", "네이버 테마 편입 사유"],
  ["[분기]", "분기 재무"],
  ["[목표주가]", "증권사 컨센서스"],
  ["[공시90일]", "DART 공시 90일"],
  ["[뉴스]", "뉴스"],
];

const meta = new Map<string, { name: string; sources: string[] }>();
try {
  for (const f of await fs.readdir(FACTS_DIR)) {
    if (!f.endsWith(".txt")) continue;
    const body = await fs.readFile(path.join(FACTS_DIR, f), "utf-8");
    for (const block of body.split(/\n(?==== )/)) {
      const head = block.match(/^=== (.+?)\((\d{6}|[0-9A-Z]{6})\)/);
      if (!head) continue;
      meta.set(head[2], {
        name: head[1],
        sources: SOURCE_LABEL.filter(([tag]) => block.includes(tag)).map(([, label]) => label),
      });
    }
  }
} catch {
  console.warn("⚠ 재료 폴더를 못 읽었습니다 — 출처 없이 넣습니다.");
}

/* ── 받아 적은 글을 읽는다 ──────────────────────────────────── */

const stat = await fs.stat(target);
const files = stat.isDirectory()
  ? (await fs.readdir(target)).filter((f) => f.endsWith(".txt")).map((f) => path.join(target, f))
  : [target];

const store = JSON.parse(await fs.readFile(BRIEF_FILE, "utf-8")) as Record<string, Brief>;

const now = new Date();
const kst = new Date(now.getTime() + (9 * 60 + now.getTimezoneOffset()) * 60_000);
const day = kst.toISOString().slice(0, 10);

let added = 0;
let replaced = 0;
let skipped = 0;
const unknown: string[] = [];

for (const file of files) {
  const body = await fs.readFile(file, "utf-8");
  for (const block of body.split(/\n(?==== )/)) {
    const m = block.match(/^=== *([0-9A-Za-z]{6})\s*\n([\s\S]+)$/);
    if (!m) continue;
    const code = m[1];
    /* 마크다운 기호는 화면이 안 그린다 — 들어오는 자리에서 턴다 */
    const text = m[2].replace(/\*\*/g, "").replace(/^#{1,6}\s*/gm, "").trim();

    if (text.length < 40) {
      skipped++;
      continue;
    }
    const info = meta.get(code);
    if (!info) unknown.push(code);

    if (store[code]) replaced++;
    else added++;

    store[code] = {
      code,
      name: info?.name ?? store[code]?.name ?? code,
      day,
      at: now.toISOString(),
      text,
      model: MODEL,
      sources: info?.sources ?? [],
      /* 세션이 쓴 글이라 API 토큰이 안 나갔다. 0 이 사실이다 */
      inputTokens: 0,
      outputTokens: 0,
    };
  }
}

await fs.writeFile(BRIEF_FILE, JSON.stringify(store, null, 1), "utf-8");

console.log(`넣음 ${added} · 덮어씀 ${replaced} · 너무 짧아 건너뜀 ${skipped} · 파일 전체 ${Object.keys(store).length}종목`);
if (unknown.length > 0) console.log(`⚠ 재료에 없던 코드 ${unknown.length}건: ${unknown.slice(0, 10).join(", ")}${unknown.length > 10 ? " …" : ""}`);
