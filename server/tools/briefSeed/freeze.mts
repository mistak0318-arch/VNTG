/**
 * 만들어 둔 brief 를 **배포용 바닥값으로 굳힌다** (2026-09-08).
 *
 * 실행: server/ 에서 `npx tsx tools/briefSeed/freeze.mts`
 *
 * `server/data/*` 는 .gitignore 라서 `companyBriefs.json` 은 미니PC 로 안 간다.
 * `.seed.json` 만 예외로 추적하므로, 여기서 한 번 복사해 커밋에 태운다.
 *
 * 미니PC 는 이 파일을 **빈자리에만** 깐다(companyInfo.ts `loadSeed`). 미니PC 에서
 * 버튼을 눌러 만든 글이 있으면 그게 이긴다 — 배포가 남의 작업을 덮지 않는다.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const src = path.join(serverRoot, "data", "companyBriefs.json");
const dst = path.join(serverRoot, "data", "companyBriefs.seed.json");

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

const store = JSON.parse(await fs.readFile(src, "utf-8")) as Record<string, Brief>;

/*
 * 토큰 수는 0 으로 눕힌다. 그건 **여기서 만들 때 얼마나 썼나**의 기록이라
 * 미니PC 가 물려받을 값이 아니다. 필드를 빼 버리면 화면이 undefined 를 만나므로
 * 지우지는 않는다.
 */
const out: Record<string, Brief> = {};
let empty = 0;
for (const [code, b] of Object.entries(store)) {
  if (!b.text || b.text.trim().length < 20) {
    empty++;
    continue;
  }
  out[code] = { ...b, inputTokens: 0, outputTokens: 0 };
}

await fs.writeFile(dst, JSON.stringify(out, null, 0), "utf-8");

const size = (await fs.stat(dst)).size;
const byModel = new Map<string, number>();
for (const b of Object.values(out)) byModel.set(b.model ?? "규칙(AI 없음)", (byModel.get(b.model ?? "규칙(AI 없음)") ?? 0) + 1);

console.log(`바닥값 ${Object.keys(out).length}종목 · ${(size / 1024 / 1024).toFixed(2)}MB`);
if (empty > 0) console.log(`(내용이 없어 뺀 것 ${empty}건)`);
for (const [m, n] of byModel) console.log(`  ${m}: ${n}`);
