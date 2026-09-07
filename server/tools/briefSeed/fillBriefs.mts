/**
 * 전 종목 회사 설명 **바닥값** 채우기 (2026-09-08, 벤티지 "알아서 전체 리스트 다 진행하고 업데이트까지").
 *
 * 실행: server/ 에서
 *   npx tsx tools/briefSeed/fillBriefs.mts            — 남은 것만 이어서
 *   npx tsx tools/briefSeed/fillBriefs.mts --limit 5  — 맛보기
 *   npx tsx tools/briefSeed/fillBriefs.mts --conc 4   — 동시 4개 (기본 3)
 *
 * ## companyInfo.ts 는 「미리 채우지 마라」고 적혀 있는데
 *
 * 그 판단은 지금도 맞다. 다만 거기서 걱정한 것은 **낡은 정보**이지 미리 채우는 것
 * 자체가 아니었다. 이 도구가 만드는 것은 **바닥값**이고, 화면의 「이 회사가 무슨 일을
 * 하나」 버튼은 그대로 살아 있다:
 *
 *   · 종목을 열자마자 보이는 것 = 여기서 만든 바닥값 (하루치 낡음을 감수)
 *   · 버튼을 누른 것              = 그날 재료로 다시 엮은 것 (덮어쓴다)
 *
 * 즉 **버튼을 없애는 게 아니라 버튼을 안 눌러도 뭔가는 보이게** 하는 것이다.
 *
 * ## 왜 외부 AI 의 학습 지식을 안 쓰나
 *
 * 벤티지가 GPT 로 3,900 종목을 한 번 채워 왔다(2026-09-07). 열어 보니
 * **한미반도체가 "산업용 기계", 에이피알이 "화학 원료"** 였다 — 업종 코드만 보고
 * 뭉갠 것이다. 심층 조사라고 붙은 열도 3,900 중 25개만 차 있었다.
 * 모델의 학습 지식은 대형주에서만 버티고 중소형주에서 무너진다.
 *
 * 그래서 여기서는 **앱이 이미 긁어 둔 재료만** 쓴다 — DART 기업개황·공시 90일,
 * 네이버 테마 편입 사유, 분기 재무, 증권사 컨센서스, 뉴스 제목.
 * 재료를 하나도 못 모으면 **아무것도 안 만든다**(companyBrief 가 그렇게 되어 있다).
 * 빈칸이 틀린 설명보다 낫다.
 *
 * ## ETF 는 여기서 안 한다
 *
 * ETF 는 DART 공시도 분기 재무도 없어서 재료가 안 모인다. 대신 이름과 추적지수에
 * 답이 다 들어 있으므로 `etfBriefs.mts` 가 규칙으로 만든다.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import dotenv from "dotenv";

/* 도구는 index.ts 를 거치지 않으므로 .env 를 직접 물린다 (cwd 가 어디든 되게) */
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
dotenv.config({ path: path.join(serverRoot, ".env") });

const { companyBrief, generatedBrief } = await import("../../src/companyInfo.js");

/* ------------------------------------------------------------------ */

const argv = process.argv.slice(2);
function opt(name: string, dflt: number): number {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const n = Number(argv[i + 1]);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}
const LIMIT = opt("limit", Infinity);
/** 동시성. DART·네이버를 종목당 대여섯 번 때리므로 낮게 잡는다 */
const CONC = opt("conc", 3);
const FORCE = argv.includes("--force");

interface SnapStock {
  code: string;
  name: string;
  marketCap: number;
  market: string;
}

const snapPath = path.join(serverRoot, "data", "marketSnapshot.json");
const snap = JSON.parse(await fs.readFile(snapPath, "utf-8")) as { stocks: SnapStock[] };

/*
 * 시총 큰 순으로 돈다. 중간에 끊겨도 **볼 확률이 높은 종목부터** 차 있게 하려는 것이다.
 * 어차피 한 번에 다 못 끝내면 뒤쪽이 남는데, 남을 거면 안 보는 쪽이 남아야 한다.
 */
const all = [...snap.stocks].sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0));

/*
 * 이미 엮은 것은 건너뛴다 — 끊고 다시 돌려도 이어서 간다.
 * `cachedBrief` 가 아니라 `generatedBrief` 를 쓰는 게 중요하다: 전자는 바닥값도
 * 「있다」고 하므로, 배포된 seed 가 깔린 뒤에는 **한 종목도 새로 안 만들게 된다.**
 */
const todo: SnapStock[] = [];
for (const s of all) {
  if (todo.length >= LIMIT) break;
  if (!FORCE && (await generatedBrief(s.code))) continue;
  todo.push(s);
}

const model = process.env.CLAUDE_MODEL?.trim() || "(기본 claude-sonnet-5)";
console.log(`대상 ${todo.length}종목 (전체 ${all.length}, 이미 있는 것 제외) · 동시 ${CONC} · 모델 ${model}`);
if (todo.length === 0) {
  console.log("할 일 없음.");
  process.exit(0);
}

let done = 0;
let ok = 0;
let skip = 0;
let fail = 0;
/**
 * 연속 실패. **API 가 죽으면 즉시 멈추려고 센다.**
 *
 * 2026-09-08 새벽에 Anthropic 크레딧이 318 종목에서 떨어졌는데, 남은 2,400 종목을
 * 그대로 두드리며 「재료없음」만 쌓았다. 사유를 안 찍은 탓에 한참 뒤에 알았다.
 */
let streak = 0;
let lastWhy = "";
let aborted = false;
const failures: { code: string; name: string; why: string }[] = [];
const started = Date.now();
/** 이만큼 내리 실패하면 뭔가 근본이 고장 난 것이다 — 종목 문제가 아니다 */
const ABORT_AFTER = 20;

async function work(s: SnapStock): Promise<void> {
  try {
    const r = await companyBrief(s.code, s.name, { run: true, force: FORCE });
    if (r.brief && r.ran) {
      ok++;
      streak = 0;
    } else {
      skip++;
      streak++;
      if (r.error) {
        lastWhy = r.error;
        failures.push({ code: s.code, name: s.name, why: r.error });
      }
    }
  } catch (e) {
    fail++;
    streak++;
    lastWhy = String(e).slice(0, 160);
    failures.push({ code: s.code, name: s.name, why: lastWhy });
  } finally {
    done++;
    if (streak >= ABORT_AFTER && !aborted) {
      aborted = true;
      console.error(`\n⚠ ${ABORT_AFTER}종목 내리 실패해 멈춥니다. 마지막 사유:\n  ${lastWhy}\n`);
    }
    if (done % 10 === 0 || done === todo.length) {
      const el = (Date.now() - started) / 1000;
      const rate = done / el;
      const left = (todo.length - done) / rate;
      console.log(
        `  ${done}/${todo.length} (${((done / todo.length) * 100).toFixed(1)}%) ` +
          `· 성공 ${ok} 못만듦 ${skip} 오류 ${fail} ` +
          `· ${rate.toFixed(2)}종목/초 · 남은 시간 약 ${Math.round(left / 60)}분` +
          /* 사유를 여기서 같이 보여 준다. 끝나고 나서 알면 이미 다 헛돈 뒤다 */
          (streak > 0 && lastWhy ? `\n     ↳ 최근 실패(${streak}연속): ${lastWhy.slice(0, 100)}` : ""),
      );
    }
  }
}

/* 단순 워커 풀. 큐에서 하나씩 꺼내 돌린다 */
let cursor = 0;
async function worker(): Promise<void> {
  for (;;) {
    if (aborted) return;
    const i = cursor++;
    if (i >= todo.length) return;
    await work(todo[i]);
  }
}
await Promise.all(Array.from({ length: CONC }, () => worker()));

const mins = ((Date.now() - started) / 60000).toFixed(1);
console.log(`\n${aborted ? "중단" : "끝"}. ${mins}분 · 성공 ${ok} · 못만듦 ${skip} · 오류 ${fail}`);
if (aborted) console.log(`남은 ${todo.length - done}종목은 원인을 고치고 같은 명령을 다시 주면 이어서 간다.`);

if (failures.length > 0) {
  /* 왜 못 만들었는지를 사유별로 묶어 준다. 하나씩 보면 3천 줄이라 안 읽힌다 */
  const byWhy = new Map<string, number>();
  for (const f of failures) byWhy.set(f.why, (byWhy.get(f.why) ?? 0) + 1);
  console.log("\n못 만든 사유:");
  for (const [why, n] of [...byWhy.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  ${n}건  ${why}`);
  }
  const logPath = path.join(serverRoot, "data", "briefSeed.failures.json");
  await fs.writeFile(logPath, JSON.stringify(failures, null, 1), "utf-8");
  console.log(`\n전체 목록: ${logPath}`);
}
