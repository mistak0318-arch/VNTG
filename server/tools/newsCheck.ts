/**
 * 뉴스 갈래 점검 — 서버를 띄우지 않고 `naverNews()` 만 불러 본다 (2026-09-22).
 *
 * 네이버가 또 개편하면 이 파일 하나로 어느 갈래가 죽었는지 30초에 안다.
 * 키움을 안 건드리므로 **장중에 돌려도 된다.**
 *
 *   npx tsx tools/newsCheck.ts
 */
import { naverNews, type NaverCat } from "../src/naverMainNews.js";

const CATS: { cat: NaverCat; label: string }[] = [
  { cat: "main", label: "주요뉴스" },
  { cat: "flash", label: "속보" },
  { cat: "market", label: "증권" },
  { cat: "company", label: "산업·재계" },
  { cat: "world", label: "글로벌 경제" },
  { cat: "estate", label: "부동산" },
  { cat: "money", label: "금융" },
];

let bad = 0;
for (const { cat, label } of CATS) {
  try {
    const r = await naverNews(cat, 1);
    const withTime = r.items.filter((x) => x.at).length;
    const withThumb = r.items.filter((x) => x.thumb).length;
    const withSum = r.items.filter((x) => x.summary).length;
    const ok = r.items.length > 0;
    if (!ok) bad++;
    console.log(
      `${ok ? "✔" : "✘"} ${label.padEnd(7)} ${String(r.items.length).padStart(3)}건 · 시각 ${withTime} · 요약 ${withSum} · 썸네일 ${withThumb} · 더있음 ${r.hasMore}`,
    );
    if (ok) console.log(`    ${r.items[0].press} | ${r.items[0].title.slice(0, 46)} | ${r.items[0].at.slice(0, 16)}`);
  } catch (e) {
    bad++;
    console.log(`✘ ${label.padEnd(7)} 터짐: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/* 2쪽이 1쪽과 겹치면 커서 페이징이 깨진 것이다 — 옛 PC 파서가 그렇게 조용히 죽었다 */
const p1 = await naverNews("estate", 1);
const p2 = await naverNews("estate", 2);
const dup = p2.items.filter((x) => p1.items.some((y) => y.link === x.link)).length;
console.log(`\n부동산 쪽넘김: 1쪽 ${p1.items.length}건 · 2쪽 ${p2.items.length}건 · 겹침 ${dup}건 ${dup === 0 && p2.items.length > 0 ? "✔" : "✘"}`);
if (dup > 0 || p2.items.length === 0) bad++;

console.log(bad === 0 ? "\n전부 정상" : `\n⚠️ ${bad}군데 이상`);
process.exit(bad === 0 ? 0 : 1);
