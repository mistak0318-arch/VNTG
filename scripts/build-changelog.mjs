#!/usr/bin/env node
/**
 * 변경 이력을 화면에 넣는다 (2026-09-04) — 벤티지: "설정메뉴에 정보 라는 탭 하나 만들어서
 * 버전별로 기록 좀 해줘. 뭘 발행했고 했는지."
 *
 * ## 왜 생성해서 파일로 굽나
 *
 * 서버가 실행 중에 `git log` 를 부르는 방법도 있다. 그런데 **미니PC 에 저장소가 그대로
 * 있으리라는 보장이 없고**(빌드 결과만 올라갈 수도 있다), 없으면 정보 탭이 빈칸이 된다.
 * 커밋할 때 한 번 구워서 번들에 넣으면 어디서 열든 같은 것이 보인다.
 *
 * ## 쓰는 법
 *
 *   node scripts/build-changelog.mjs
 *
 * `push-deploy.ps1` 이 커밋 전에 부른다 — 그래서 **방금 쓴 커밋 메시지는 다음 배포에
 * 들어간다.** 한 박자 늦는 것이 맞다: 지금 굽는 시점에는 이번 커밋이 아직 없다.
 *
 * 커밋 제목만 쓴다. 본문은 길고(이 저장소는 본문에 사연을 길게 적는다) 화면에서 읽을
 * 것이 아니다 — 제목 한 줄이 곧 「무엇을 했나」다.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(root, "web", "src", "changelog.ts");

/** 너무 많으면 번들만 무거워진다 — 최근 것부터 이만큼 */
const MAX = 400;

const SEP = "";
const raw = execFileSync(
  "git",
  ["log", `-${MAX}`, "--date=format:%Y-%m-%d", `--pretty=%ad${SEP}%h${SEP}%s`],
  { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
);

/** 자동 커밋·되돌림처럼 읽을 값이 없는 줄은 뺀다 */
function skip(subject) {
  return /^(Merge |WIP\b|wip\b|typo\b)/.test(subject);
}

const byDate = new Map();
for (const line of raw.split("\n")) {
  if (!line.trim()) continue;
  const [date, hash, ...rest] = line.split(SEP);
  const subject = rest.join(SEP).trim();
  if (!date || !subject || skip(subject)) continue;
  if (!byDate.has(date)) byDate.set(date, []);
  byDate.get(date).push({ hash, subject });
}

const days = [...byDate.entries()].map(([date, items]) => ({ date, items }));

const body = `/* 이 파일은 scripts/build-changelog.mjs 가 굽는다. 손으로 고치지 말 것 — 다음 배포에 덮인다. */

export interface ChangeDay {
  /** YYYY-MM-DD */
  date: string;
  items: { hash: string; subject: string }[];
}

/** 최근 ${MAX} 개 커밋을 날짜로 묶은 것. 구운 시각: ${new Date().toISOString()} */
export const CHANGELOG: ChangeDay[] = ${JSON.stringify(days, null, 2)};

export const CHANGELOG_COMMITS = ${days.reduce((n, d) => n + d.items.length, 0)};
`;

writeFileSync(OUT, body, "utf8");
console.log(`changelog: ${days.length}일 · ${days.reduce((n, d) => n + d.items.length, 0)}건 → web/src/changelog.ts`);
