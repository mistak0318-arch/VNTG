import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deployOutDir } from "./healthFile.js";
import { getSection, type IndexCard, type MarketFlow } from "./marketOverview.js";
import { KiwoomClient } from "./kiwoomClient.js";
import { sessionOf } from "./marketHours.js";
import { themeStrength } from "./themeStrength.js";
import { futuresFlow } from "./naverFuturesFlow.js";
import type { GlobalQuote } from "./globalMarket.js";
import type { UsMajorResult } from "./usMajor.js";
import type { RateRow } from "./rateBoard.js";

/**
 * **물어보라고 떨구는 파일** (2026-11-24 — 벤티지: "미니PC에 클로드 코드가 VNTG의 DB를
 * 참조하게 하는거야 … 별도의 저장DB 파일을 두고 클로드 코드가 그 파일을 읽어서 처리하는
 * 구조면 어때").
 *
 * ## 왜 원장을 직접 안 읽게 하나
 *
 * 미니PC 는 **운영 서버가 도는 기계**다. 거기서 클로드가 `server/data` 를 통째로 열면:
 *
 *     daily/ 97MB · dailyCloses.json 86MB · newsKeywords/ 78MB · signalSamples.json 50MB
 *
 * 2026-10-07 에 서버가 바로 이 크기 때문에 OOM 으로 죽었다(`server-oom` 기록). 같은 기계에서
 * 같은 짓을 하면 **앱이 멈춘다.** 게다가 `server/data` 에는 되살릴 수 없는 원장(신호등 표본
 * 19만 관측·항해일지)과 `.env` 가 있어 **쓰기 사고 한 번이면 끝**이다.
 *
 * 그래서 읽을 것만 **따로 떠서 공유 폴더에 둔다.** 원장은 공유 밖에 그대로 있고, 읽는 쪽은
 * 작은 파일 하나만 본다. 자리는 배포 깃발이 오가는 `vntg-deploy\ask\` 다 — **이미 뚫려 있는
 * 길**이라 새 설정도, 새 자격증명도 없다(`healthFile` 과 같은 폴더 탐지를 쓴다).
 *
 * ## 조회를 늘리지 않으려 애썼다
 *
 * 재료는 전부 **대시보드가 이미 받아 둔 섹션 캐시**다(`getSection`). 캐시가 신선하면 그대로
 * 쓰고, 만료됐으면 그때만 받는다 — 화면 하나가 더 떠 있는 정도다. 그래서 주기도 **장중 1분 ·
 * 그 밖 5분**으로 둔다. 장이 안 서는 시간에 1분마다 깨울 이유가 없다.
 *
 * ## 낡은 값을 신선한 척하지 않는다
 *
 * 칸마다 **몇 초 전 값인지**(`낡음초`)를 같이 적는다. 폰에서 「지금 시황 어때」라고 물었을 때
 * 20분 된 값을 지금 값으로 읽으면 그게 제일 나쁘다 — 2026-11-20 에 기준을 안 적어 한 화면이
 * 두 등락률을 말한 일이 있었고, 여기는 출처가 더 섞여 있어 위험이 더 크다.
 */

const FILE = "now.json";

function num(v: unknown): number | null {
  const n = Number(String(v ?? "").replace(/[+,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * **자릿수를 잘라서 적는다.** 야후가 주는 등락률은 `-1.9639659803043867` 처럼 오는데,
 * 그대로 쓰면 읽는 쪽(사람이든 AI 든)이 **없는 정밀도를 있는 것으로 읽는다.** 베이시스도
 * `-0.5799999999999272` 로 떠서 뺄셈 부스러기가 그대로 보였다.
 */
function r(v: number | null | undefined, digits = 2): number | null {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return null;
  const p = 10 ** digits;
  return Math.round(Number(v) * p) / p;
}

function ageSec(at: number | null | undefined): number | null {
  if (!at) return null;
  return Math.round((Date.now() - at) / 1000);
}

/** 한국시간 지금 — 파일에는 **사람이 읽는 꼴**로 적는다(AI 가 읽을 때도 그게 덜 헷갈린다) */
function kstNow(): { iso: string; date: string; minute: number } {
  const k = new Date(Date.now() + 9 * 3600_000);
  const date = k.toISOString().slice(0, 10);
  const hh = String(k.getUTCHours()).padStart(2, "0");
  const mm = String(k.getUTCMinutes()).padStart(2, "0");
  const ss = String(k.getUTCSeconds()).padStart(2, "0");
  return { iso: `${date} ${hh}:${mm}:${ss} KST`, date, minute: k.getUTCHours() * 60 + k.getUTCMinutes() };
}

export interface AskSnapshotState {
  dir: string | null;
  wrote: number;
  lastOk: string | null;
  lastError: string | null;
  bytes: number;
}

export const askSnapshotState: AskSnapshotState = { dir: null, wrote: 0, lastOk: null, lastError: null, bytes: 0 };

async function build(client: KiwoomClient): Promise<Record<string, unknown>> {
  const now = kstNow();
  const session = sessionOf(now.date, now.minute);

  const [idx, flow, glob, usm, rates] = await Promise.all([
    getSection("indices", client).catch(() => null),
    getSection("flow", client).catch(() => null),
    getSection("global", client).catch(() => null),
    getSection("usMajor", client).catch(() => null),
    getSection("rates", client).catch(() => null),
  ]);

  const cards = (idx?.data as IndexCard[] | null) ?? [];
  const pick = (code: string) => cards.find((c) => c.code === code) ?? null;
  const one = (c: IndexCard | null) =>
    c === null ? null : { 현재가: r(c.price), 등락률: r(c.changeRate), 상승: c.rising, 보합: c.flat, 하락: c.falling };

  const k200 = cards.find((c) => c.futures) ?? null;
  const fut = k200?.futures ?? null;

  const mf = (flow?.data as MarketFlow | null) ?? null;
  const gq = (glob?.data as GlobalQuote[] | null) ?? [];
  const g = (key: string) => {
    const q = gq.find((x) => x.key === key);
    return q ? { 값: r(q.price), 등락률: r(q.changeRate) } : null;
  };
  const um = (usm?.data as UsMajorResult | null) ?? null;
  const u = (key: string) => {
    const q = (um?.rows ?? []).find((x) => x.key === key);
    return q ? { 값: r(q.price, 3), 등락률: r(q.changeRate) } : null;
  };
  /*
   * **금리는 %p 로 적는다.** 수익률 4.908% 가 4.918% 로 오른 것을 「+0.20%」(등락률)로 적으면
   * 국고채 줄의 「+0.006」(%p)과 **같은 칸에서 다른 자를 쓰는 꼴**이다. 금리는 둘 다 %p 로 통일.
   */
  const uRate = (key: string) => {
    const q = (um?.rows ?? []).find((x) => x.key === key);
    return q ? { 값: r(q.price, 3), 전일대비: r(q.change, 3) } : null;
  };

  /* 선물 투자자 수급 — 네이버. 파일 캐시라 가볍다 */
  let futFlow: { 날짜: string; 외국인: number; 기관: number; 개인: number } | null = null;
  try {
    const days = await futuresFlow(1);
    const d = days.length > 0 ? days[days.length - 1] : null;
    if (d) futFlow = { 날짜: d.date, 외국인: d.foreign, 기관: d.institution, 개인: d.individual };
  } catch {
    /* 없으면 없는 대로 — 이 한 칸 때문에 파일 전체를 못 쓰게 하지 않는다 */
  }

  /*
   * 몰린 테마 — 화면(MAP 맨 위)과 **같은 규칙**이다: 거래대금 상위 20 중 등락률 상위 5.
   * 규칙이 갈라지면 「화면엔 이렇게 나오는데 네 답은 왜 달라」가 된다.
   */
  let hot: unknown[] = [];
  try {
    const th = await themeStrength("kr");
    hot = th.themes
      .filter((t) => !t.gone)
      .slice()
      .sort((a, b) => b.tradeValue - a.tradeValue)
      .slice(0, 20)
      .sort((a, b) => b.changeRate - a.changeRate)
      .slice(0, 5)
      .map((t) => ({
        테마: t.name,
        등락률: r(t.changeRate),
        거래대금억: Math.round(t.tradeValue),
        오른종목: `${t.up}/${t.up + t.down}`,
        연속상승일: t.streak,
      }));
  } catch {
    /* 테마 없이도 나머지는 쓸모가 있다 */
  }

  const rateRows = (rates?.data as RateRow[] | null) ?? [];
  const rate = (name: string) => {
    const q = rateRows.find((x) => x.name === name);
    return q ? { 값: r(q.rate, 3), 전일대비: r(q.change, 3) } : null;
  };

  return {
    "이 파일은": "VNTG 가 1~5분마다 떨구는 읽기 전용 시황 스냅샷입니다. 고치지 마세요 — 다음 갱신에 덮어씁니다.",
    적은시각: now.iso,
    장: session,
    낡음초: {
      지수: ageSec(idx?.updatedAt),
      수급: ageSec(flow?.updatedAt),
      해외: ageSec(glob?.updatedAt),
      미국지표: ageSec(usm?.updatedAt),
      금리: ageSec(rates?.updatedAt),
      설명: "그 칸 값이 몇 초 전 것인지. 장이 안 설 때는 크게 벌어지는 게 정상입니다",
    },
    지수: {
      코스피: one(pick("001")),
      코스닥: one(pick("101")),
      코스피200: one(pick("201")),
      코스피200선물: fut
        ? {
            월물: fut.name,
            현재가: r(fut.price),
            등락률: r(fut.changeRate),
            베이시스: r(fut.basis),
            미결제: fut.openInterest,
            설명: "베이시스가 음수면 백워데이션 — 차익거래가 현물을 파는 쪽입니다",
          }
        : null,
    },
    수급억원: mf
      ? {
          기준일: mf.asOf ?? "오늘",
          코스피: { 외국인: mf.kospi.foreign, 기관: mf.kospi.institution, 개인: mf.kospi.individual },
          코스닥: { 외국인: mf.kosdaq.foreign, 기관: mf.kosdaq.institution, 개인: mf.kosdaq.individual },
          누적: (mf.windows ?? []).map((w) => ({
            일수: w.days,
            코스피: { 외국인: w.kospi.foreign, 기관: w.kospi.institution, 개인: w.kospi.individual },
            코스닥: { 외국인: w.kosdaq.foreign, 기관: w.kosdaq.institution, 개인: w.kosdaq.individual },
          })),
          선물: futFlow,
        }
      : null,
    변동성: {
      VKOSPI: g("vkospi"),
      VIX: g("vix"),
      설명: "VKOSPI 는 코스피200 옵션에서 나옵니다 · 보통 15~20, 30 위면 공포 · 정규장에만 움직입니다",
    },
    해외: {
      나스닥100선물: g("nqF"),
      S앤드P500선물: g("esF"),
      다우선물: g("ymF"),
      러셀2000선물: g("rtyF"),
    },
    금리: {
      미국10년: uRate("tnx"),
      미국30년: uRate("tyx"),
      국고채3년: rate("국고채 3년"),
      국고채10년: rate("국고채 10년"),
      설명: "모두 %p 단위(수익률 자체와 전일 대비 변화). 미국 10·30년은 야후 실시간, 국고채는 한투. 20년물은 야후에 없어 화면에서만 FRED 전영업일 값을 씁니다",
    },
    원자재: { WTI: u("wti"), 브렌트: u("brent"), 금: u("gold") },
    몰린테마: hot,
    "몰린테마 고른 법": "거래대금 상위 20개 중 등락률 상위 5 — 앱의 MAP 맨 윗줄과 같은 규칙입니다",
  };
}

export async function writeAskSnapshot(client: KiwoomClient): Promise<void> {
  const base = await deployOutDir();
  if (!base) return; // 배포 폴더가 없는 기계(개발 PC)에서는 아무 일도 안 한다
  const dir = join(base, "ask");
  askSnapshotState.dir = dir;
  try {
    const body = JSON.stringify(await build(client), null, 1);
    await mkdir(dir, { recursive: true });
    /* 반쯤 쓰인 파일을 읽히지 않게 — 임시로 쓰고 바꿔치기(healthFile 과 같은 수법) */
    const tmp = join(dir, `${FILE}.tmp`);
    await writeFile(tmp, body, "utf-8");
    await rename(tmp, join(dir, FILE));
    askSnapshotState.wrote += 1;
    askSnapshotState.bytes = Buffer.byteLength(body);
    askSnapshotState.lastOk = new Date().toISOString();
    askSnapshotState.lastError = null;
  } catch (err) {
    askSnapshotState.lastError = err instanceof Error ? err.message.slice(0, 120) : "알 수 없는 오류";
  }
}

/**
 * **장중 1분 · 그 밖 5분.** 매 분 깨어나되 장 밖에서는 다섯 번에 한 번만 쓴다 —
 * 주기를 바꾸려고 타이머를 다시 걸면 경계에서 한 번 빠지거나 두 번 쓰는 일이 생긴다.
 */
/**
 * **같이 떨구는 안내서.** 이 폴더를 처음 보는 쪽(미니PC 의 클로드든, 메인 PC 의 나든)이
 * 맨 먼저 읽을 글이다. 규율을 사람 기억에만 두면 언젠가 깨지므로 **파일에 박아 둔다.**
 * 서버가 뜰 때 한 번 덮어쓰므로 코드와 늘 같은 말을 한다.
 */
const README = `# VNTG 물어보기 폴더

VNTG 서버(미니PC)가 **읽으라고** 떨구는 파일들입니다. 원장이 아니라 **사본**입니다.

| 파일 | 무엇 | 언제 |
|---|---|---|
| \`now.json\` | 지금 시황 — 지수·수급·선물·변동성·해외·금리·원자재·몰린 테마 | 장중 1분 · 그 밖 5분 |

## 읽는 쪽이 지킬 것

1. **쓰지 마세요.** 이 폴더의 파일은 다음 갱신에 덮어쓰입니다. 그리고 여기 말고
   \`server/data\` 쪽은 **되살릴 수 없는 원장**입니다(신호등 표본 19만 관측·항해일지).
2. **원장을 통째로 열지 마세요.** \`daily/\` 97MB · \`dailyCloses.json\` 86MB ·
   \`signalSamples.json\` 50MB 입니다. 2026-10-07 에 서버가 그 크기 때문에 OOM 으로
   죽었습니다. **운영 서버와 같은 기계**라 같은 일이 나면 앱이 멈춥니다.
3. **저장소(\`C:\\\\vntg-hts\`)에서 코드를 고치지 마세요.** 배포가 \`git reset --hard\` 로
   그 폴더를 덮습니다 — 고친 것이 1분 안에 사라집니다. 고칠 일은 메인 PC 에서 합니다.
4. **장중에 키움·한투를 직접 부르지 마세요.** 운영 서버와 같은 앱키라 조회 한도를
   나눠 쓰게 되고, 그게 곧 화면이 느려지는 원인입니다.

## 값을 읽을 때

- \`낡음초\` 를 **먼저 보세요.** 그 칸이 몇 초 전 값인지입니다. 장이 안 설 때는 크게
  벌어지는 게 정상이고, 그때 「지금 값」처럼 말하면 안 됩니다.
- 단위는 키 이름에 붙어 있습니다(\`수급억원\`·\`거래대금억\`). 안 붙은 것은 그 칸의
  \`설명\` 을 보세요.
- \`몰린테마\` 는 앱의 MAP 맨 윗줄과 **같은 규칙**입니다 — 거래대금 상위 20 중 등락률 상위 5.

## 더 필요하면

여기에 없는 값이 필요하면 **파일을 늘리는 쪽**으로 하세요(\`server/src/askSnapshot.ts\`).
원장을 직접 여는 쪽으로 가면 위 2번에 걸립니다.
`;


/**
 * **미니PC 의 클로드가 저절로 읽는 규율** (2026-11-25).
 *
 * 벤티지가 미니PC 에 클로드 코드를 깔고 폰에서 조종한다. 규율을 채팅으로 붙여 넣으면
 * 세션이 바뀔 때마다 다시 붙여야 하고, 언젠가 빠뜨린다. 클로드 코드는 **작업 폴더의
 * `CLAUDE.md` 를 저절로 읽으므로** 그 자리에 둔다 — 서버가 뜰 때 덮어쓰니 코드와 늘 같은 말을 한다.
 *
 * 작업 폴더를 `C:ntg-deploysk` 로 열라고 안내하는 까닭도 여기 있다. 저장소를 열면
 * 배포가 `git reset --hard` 로 덮는 폴더라 사고가 나고, 이 폴더에는 원장이 아예 없다.
 */
const CLAUDE_MD = `# VNTG 미니PC — 여기서 일할 때

너는 **VNTG HTS 서버가 24시간 돌고 있는 미니PC** 안에 있다. 개발 기계가 아니라 운영 기계다.

## 보는 것
- \`now.json\` — 지금 시황(장중 1분 · 그 밖 5분 갱신). **\`낡음초\` 를 먼저 봐라.**
- \`README.md\` — 이 폴더의 설명과 단위 규약.
- VNTG 앱 화면이 필요하면 크롬에서 **https://nucbox-g10.tail8ed955.ts.net/#/overview**
  (\`localhost:4000\` 은 같은 서버지만 로그인 세션이 없어 로그인 화면만 나온다)

## 하지 말 것
1. \`C:\vntg-hts\` 안의 파일을 고치지 마라. 배포가 1분마다 \`git reset --hard\` 로 덮는다.
2. \`C:\vntg-hts\server\data\` 에 쓰지 마라. 되살릴 수 없는 원장이다(신호등 표본 19만 관측·항해일지).
3. 그 안의 큰 파일을 통째로 읽지 마라 — \`daily/\` 97MB, \`dailyCloses.json\` 86MB,
   \`signalSamples.json\` 50MB. 2026-10-07 에 서버가 이 크기 때문에 OOM 으로 죽었다.
4. \`.env\` 를 열지 마라.
5. 서버를 재시작·종료하지 마라. node 프로세스를 죽이지 마라.
6. 장중(09:00~15:40)에 키움·한투 API 를 직접 부르지 마라. 운영 서버와 같은 앱키다.
7. **주문 화면에 들어가지 마라.** 매수·매도·정정·취소·자동감시주문 어느 것도 누르지 마라.
   이 앱에는 실제 주문 기능이 있다. 비밀번호를 묻는 칸이 나오면 멈추고 사람에게 말해라.
8. 설정을 바꾸거나 로그아웃하지 마라. VNTG 밖에서 로그인하거나 무언가 제출하지 마라.

## 답하는 방식
- 먼저 \`now.json\` 으로 답이 되는지 본다. 결론을 바꾸는 핵심 숫자만 화면에서 한 번 더 확인한다.
- \`now.json\` 에 없는 맥락(종목 상세·뉴스·공시·차트)은 화면에서 가져와 덧붙인다.
- **두 값이 다르면 먼저 시각 차이를 의심해라.** 스냅샷은 1~5분 전, 화면은 지금이다.
  다를 때는 둘 다 시각과 함께 말한다. 시각으로 설명이 안 되는 차이면 분명히 말해라 — 그건 결함이다.
- 단위는 키 이름에 있다(\`수급억원\`·\`거래대금억\`). 금리는 전부 %p.
- **폰에서 읽는다.** 답은 짧게 — 표보다 문장, 다섯 줄 안에.
- 없으면 없다고 해라. 지어내지 마라.
`;

export function startAskSnapshot(client: KiwoomClient): void {
  void (async () => {
    const base = await deployOutDir();
    if (!base) return;
    try {
      const dir = join(base, "ask");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "README.md"), README, "utf-8");
      /* 클로드 코드가 작업 폴더에서 저절로 읽는다 — 규율을 채팅에 붙여 넣지 않아도 된다 */
      await writeFile(join(dir, "CLAUDE.md"), CLAUDE_MD, "utf-8");
    } catch {
      /* 안내서를 못 써도 스냅샷은 돈다 */
    }
  })();
  let tick = 0;
  const run = () => {
    const now = kstNow();
    const s = sessionOf(now.date, now.minute);
    const busy = s === "정규장" || s === "프리" || s === "공백" || s === "애프터";
    tick += 1;
    if (busy || tick % 5 === 0) void writeAskSnapshot(client);
  };
  void writeAskSnapshot(client);
  setInterval(run, 60_000);
  console.log("[물어보기] vntg-deploy\\ask\\now.json — 장중 1분 · 그 밖 5분");
}
