import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { summarize } from "./summarize.js";
import { sendTelegram } from "./telegram.js";
import { fetchNewMessages, isReaderConfigured } from "./telegramReader.js";
import {
  buildTagIndex,
  hhmmKst,
  scoreMessages,
  toDigestText,
  type ScoredChannelItem,
} from "./telegramDigest.js";
import { listWatchlist } from "./watchlist.js";
import { listThemes } from "./customThemes.js";
import { noopProgress, type ProgressReporter } from "./reportProgress.js";
import { peekSnapshot } from "./marketSnapshot.js";

/**
 * 구독 채널 요약 리포트.
 *
 * 채널 180개를 사람이 다 읽는 건 불가능하다. 그래서 기계가 대신 읽고
 * **"여러 채널이 동시에 말하고 있는 것"** 을 뽑아 올린다.
 * 채널 하나가 떠드는 건 노이즈지만, 열 개가 같은 종목을 말하면 그건 신호다.
 *
 * AI에게 시키는 일은 "요약"이 아니라 "분류와 정리"에 가깝다.
 * 원문을 그대로 옮기면 저작권 문제가 되고, 무엇보다 사용자가 원하는 건
 * 180개를 읽는 게 아니라 **오늘 뭐가 돌고 있는지** 이므로.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "data");
const FILE = join(DATA_DIR, "channelReports.json");

const SYSTEM_RULES = `당신은 한국 주식시장 정보를 정리하는 애널리스트입니다.

입력은 사용자가 구독 중인 텔레그램 채널들에서 수집한 메시지 묶음입니다.
[N개 채널] 표시는 그 내용을 N개 채널이 동시에 다뤘다는 뜻이고, 숫자가 클수록 시장의 관심이 큽니다.
[관심:종목명] 은 사용자가 보유·관찰 중인 종목입니다.

규칙:
- 매수/매도 추천을 하지 마십시오. 목표주가를 제시하지 마십시오.
- 원문을 그대로 옮기지 말고 사실만 재구성해 정리하십시오.
- 채널에서 나온 주장과 확인된 사실을 구분해서 쓰십시오.
  확인이 안 된 것은 "~라는 언급이 있음" 처럼 출처가 드러나게 쓰십시오.
- 근거 없이 단정하지 말고, 정보가 부족하면 부족하다고 쓰십시오.
- 한글 800~1,200자.

형식:
## 오늘 돌고 있는 이야기
여러 채널이 동시에 다룬 주제를 3~5개. 각각 몇 개 채널이 다뤘는지 함께.

## 관심종목 관련
사용자 관심종목이 언급된 내용만. 없으면 "언급 없음".

## 눈에 띄는 단발 정보
채널 하나에만 나왔지만 사실이라면 중요한 것. 반드시 미확인임을 밝힐 것.`;

/** 60분 → "1시간", 90분 → "1시간 30분". 프롬프트와 화면이 같은 말을 쓰게 한다 */
export function describeWindow(minutes: number): string {
  if (minutes < 60) return `${minutes}분`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}시간` : `${h}시간 ${m}분`;
}

export interface ChannelReport {
  /** YYYY-MM-DD */
  date: string;
  generatedAt: string;
  /** 수집 대상 채널 수 */
  channels: number;
  /** 필터 전 원본 메시지 수 */
  rawCount: number;
  /** 필터 후 AI에 넣은 건수 */
  usedCount: number;
  items: ScoredChannelItem[];
  summary: string | null;
  /** 어떤 모델로 정리했는지 */
  model?: string | null;
  inputTokens: number;
  outputTokens: number;
  error?: string;
  /** 읽지 못한 채널 (FLOOD_WAIT 등) */
  skipped: string[];
  /** 몇 분치를 훑었는지 */
  windowMinutes?: number;
  /** 실제로 잡힌 메시지의 시각 범위 — "언제 것을 정리한 건가"를 화면에서 바로 알 수 있게 */
  oldestAt?: string | null;
  newestAt?: string | null;
}

async function readAll(): Promise<ChannelReport[]> {
  try {
    const parsed = JSON.parse(await readFile(FILE, "utf-8")) as ChannelReport[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** 최근 30건만 남긴다 — 원문을 오래 쌓아둘 이유가 없다 */
async function append(report: ChannelReport): Promise<void> {
  const rows = await readAll();
  rows.push(report);
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(FILE, JSON.stringify(rows.slice(-30), null, 2), "utf-8");
}

export async function listChannelReports(limit = 10): Promise<ChannelReport[]> {
  const rows = await readAll();
  return rows.slice(-limit).reverse();
}

/**
 * 채널을 읽고 정리해 리포트를 만든다.
 *
 * @param send 텔레그램으로 보낼지. 미리보기일 땐 false.
 * @param useAi false면 수집·점수화까지만 하고 AI를 호출하지 않는다 (비용 없이 필터 확인용)
 */
export async function buildChannelReport(
  opts: {
    send?: boolean;
    useAi?: boolean;
    sinceMinutes?: number;
    limit?: number;
    /**
     * 채널별 "읽은 위치"를 쓸지.
     * 정기 발행(스케줄러)은 true — 같은 메시지를 두 번 요약하지 않기 위해서.
     * 수동 실행은 false — 버튼을 누른 시점의 최근 sinceMinutes 전체를 다시 본다.
     */
    useOffsets?: boolean;
    /** 진행 상황 알림. 화면이 없는 경로(정기 발행)는 안 넘기면 된다 */
    progress?: ProgressReporter;
  } = {},
): Promise<ChannelReport> {
  /*
   * 선별 상한을 60 → 40 으로 줄였다.
   *
   * 이게 곧 프롬프트 길이다. 그런데 61번째로 중요한 소식이 리포트를 바꾸는 일은 없다 —
   * 점수 순으로 자르는 것이라 뒤쪽은 이미 "채널 하나가 한 번 말한 것"이다.
   * 40건이면 하루 세 판에서 놓치는 게 없고 입력 토큰은 3분의 1이 준다.
   */
  const {
    send = false,
    useAi = true,
    sinceMinutes = 60,
    limit = 40,
    useOffsets = true,
    progress = noopProgress,
  } = opts;
  const now = new Date();
  const date = new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 10);

  const base: ChannelReport = {
    date,
    generatedAt: now.toISOString(),
    channels: 0,
    rawCount: 0,
    usedCount: 0,
    items: [],
    summary: null,
    inputTokens: 0,
    outputTokens: 0,
    skipped: [],
    windowMinutes: sinceMinutes,
    oldestAt: null,
    newestAt: null,
  };

  if (!isReaderConfigured()) {
    // 단계를 pending 으로 두고 끝내면 화면이 "아직 도는 중"처럼 보인다. 이유를 남긴다
    for (const k of ["read", "pick", "tag", "ai", "send"]) progress.skip(k, "세션 미설정");
    return { ...base, error: "텔레그램 세션 미설정 — scripts/telegram-login.mjs 를 먼저 실행하세요" };
  }

  progress.start("read");
  const { messages, channels, skipped } = await fetchNewMessages({ sinceMinutes, useOffsets });
  progress.done("read", `채널 ${channels}개 · 원본 ${messages.length}건`);
  progress.start("tag");
  const watchNames = (await listWatchlist().catch(() => [])).map((w) => w.name);

  /*
   * 종목·테마 사전을 만든다.
   *
   * 스냅샷은 **있으면 쓰고 없으면 넘어간다** — peekSnapshot 은 캐시만 본다.
   * 여기서 getMarketSnapshot 을 부르면 65회 조회가 걸리는데, 이 경로는 5분마다
   * 도는 자동 발송이 함께 쓴다. 태그 하나 붙이자고 그걸 물릴 수는 없다.
   */
  const snap = peekSnapshot();
  const nameOfCode = new Map<string, string>();
  if (snap) for (const s of snap.byCode.values()) nameOfCode.set(s.code, s.name);
  const myThemes = await listThemes().catch(() => []);
  const tags = buildTagIndex(
    myThemes.map((t) => ({ name: t.name, codes: t.codes })),
    nameOfCode,
  );

  progress.done("tag", `내 테마 종목 ${tags.names.length}개 사전`);
  progress.start("pick");
  const items = scoreMessages(messages, watchNames, limit, tags);
  progress.done("pick", `선별 ${items.length}건`);

  const times = messages.map((m) => m.at).sort();

  const report: ChannelReport = {
    ...base,
    channels,
    rawCount: messages.length,
    usedCount: items.length,
    items,
    skipped,
    oldestAt: times[0] ?? null,
    newestAt: times[times.length - 1] ?? null,
  };

  if (items.length === 0) {
    progress.skip("ai", "선별 0건");
    progress.skip("send", "보낼 것 없음");
    report.error = "정리할 만한 메시지가 없습니다 (필터 통과 0건)";
    return report;
  }

  /*
   * AI를 안 쓰는 경로도 발송이 되어야 한다.
   * 예전엔 요약이 있어야만 보냈기 때문에 "선별만 보기"는 화면에서만 볼 수 있었다.
   * 원문 그대로가 더 나을 때가 있고, AI 비용을 안 쓰고 싶을 때도 있다.
   */
  if (!useAi) {
    progress.skip("ai", "선별만 보기 (비용 0)");
    // 텔레그램은 건별로 — 한 덩어리로 붙이면 읽히지 않고 원문 링크도 못 단다
    if (send) {
      progress.start("send");
      const msgs = toPickedMessages(report, 15);
      await sendTelegram(toPickedHeader(report), "channel").catch(() => undefined);
      let sent = 0;
      for (const msg of msgs) {
        await sendTelegram(msg, "channel").catch(() => undefined);
        sent += 1;
        // 건마다 알린다 — 15건을 0.4초 간격으로 보내므로 진행이 보여야 한다
        progress.start("send");
        progress.done("send", `${sent}/${msgs.length}건 발송`);
        await new Promise((r) => setTimeout(r, 400));
      }
      progress.done("send", `${msgs.length}건 발송 완료`);
    } else {
      progress.skip("send", "화면에서만 보기");
    }
    return report;
  }

  /*
   * 건수가 적으면 AI를 부르지 않는다.
   *
   * 선별이 8건이면 그건 이미 사람이 훑을 분량이다. 거기에 요약을 붙여 봐야
   * 같은 말을 짧게 옮겨 적는 것뿐이고, **원문 링크가 붙은 선별 목록이 오히려 낫다.**
   * 조용한 새벽 판에서 매번 호출되던 것을 여기서 끊는다.
   */
  const AI_MIN_ITEMS = 8;
  if (items.length < AI_MIN_ITEMS) {
    if (send) {
      await sendTelegram(toPickedHeader(report), "channel").catch(() => undefined);
      for (const msg of toPickedMessages(report, 15)) {
        await sendTelegram(msg, "channel").catch(() => undefined);
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    report.error = `선별 ${items.length}건 — ${AI_MIN_ITEMS}건 미만이라 AI 정리 없이 원문만 보냅니다`;
    await append(report);
    return report;
  }

  const span =
    report.oldestAt && report.newestAt
      ? `${new Date(report.oldestAt).toLocaleString("ko-KR")} ~ ${new Date(report.newestAt).toLocaleString("ko-KR")}`
      : "(범위 불명)";
  const prompt = `${SYSTEM_RULES}\n\n---\n지금 시각: ${now.toLocaleString("ko-KR")}\n수집 구간: 최근 ${describeWindow(sinceMinutes)} (${span})\n대상 채널 ${channels}개 · 원본 ${messages.length}건 중 ${items.length}건 선별\n\n${toDigestText(items)}`;

  progress.start("ai");
  const res = await summarize(prompt, 2500, "channel");
  if (res.error) progress.fail("ai", res.error);
  else progress.done("ai", `${res.outputTokens.toLocaleString("ko-KR")} 토큰`);
  report.summary = res.text;
  report.model = res.usedModel ?? null;
  report.inputTokens = res.inputTokens;
  report.outputTokens = res.outputTokens;
  if (res.error) report.error = res.error;

  await append(report);

  if (send && report.summary) {
    progress.start("send");
    const html = toChannelHtml(report);
    await sendTelegram(html, "channel").catch(() => undefined);
    progress.done("send", "정리본 발송 완료");
  } else {
    progress.skip("send", send ? "요약이 없어 못 보냄" : "화면에서만 보기");
  }

  return report;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * AI를 거치지 않고 **선별 결과만** 보내는 형태.
 *
 * AI 정리는 편하지만 두 가지가 아쉽다 — 비용이 들고, 요약 과정에서 원문의 뉘앙스가 날아간다.
 * 필터가 걸러낸 것만 그대로 보고 싶을 때가 있어서 이 경로를 따로 둔다.
 * 여러 채널이 동시에 다룬 것과 관심종목이 걸린 것이 먼저 오도록 표시만 손본다.
 */
/**
 * 선별 결과를 **메시지 하나씩** 만든다.
 *
 * 예전엔 25건을 한 덩어리로 붙여 보냈는데, 텔레그램에서 그건 벽이다 —
 * 스크롤하며 어디서 끊기는지 찾아야 하고, 원문으로 갈 방법도 없었다.
 *
 * 그래서 건마다 따로 보낸다:
 *   머리글에 **채널명 · 시각** — 누가 언제 한 말인지가 먼저 보여야 판단이 된다
 *   본문
 *   끝에 **원문 보기** 링크 — 관심 있으면 바로 그 대화방으로 간다
 */
/**
 * 건별 메시지의 머리글.
 *
 * **텔레그램은 글자색을 못 준다.** Bot API 가 허용하는 서식은 b/i/u/s/code/pre/
 * blockquote/a 뿐이라 CSS 색상이 통하지 않는다. 그래서 색 대신
 *   - 줄머리 아이콘으로 정보 종류를 구분하고 (누가 / 무엇을 / 어느 판)
 *   - 가로줄로 머리글과 본문을 갈라
 * 훑을 때 눈이 걸리게 만든다. 아이콘은 종류마다 고정이라 위치를 외우게 된다.
 *
 * 종목·테마는 **알 때만** 쓴다. 못 찾았으면 "알 수 없음"이라고 적는다 —
 * 빈칸으로 두면 태그가 없는 건지 붙이다 만 건지 구분이 안 된다.
 */
function pickedHead(it: ScoredChannelItem): string {
  const lines = [`📡 <b>${esc(it.channelName)}</b> · ${hhmmKst(it.at)}`];

  const stock = it.stocks.length > 0 ? it.stocks.join(", ") : "알 수 없음";
  lines.push(`🏷 종목 <b>${esc(stock)}</b>`);

  const theme = it.themes.length > 0 ? it.themes.join(", ") : "미정";
  lines.push(`🎯 테마 <b>${esc(theme)}</b>`);

  const marks = [
    it.coverage > 1 ? `🔥 ${it.coverage}개 채널` : "",
    it.mentions.length > 0 ? `⭐ 관심종목 ${it.mentions.join(", ")}` : "",
  ].filter(Boolean);
  if (marks.length > 0) lines.push(`<i>${esc(marks.join(" · "))}</i>`);

  return lines.join("\n");
}

export function toPickedMessages(r: ChannelReport, limit = 15): string[] {
  return r.items.slice(0, limit).map((it) => {
    /*
     * **원문 전체** (2026-08-27 — "줄이지 말고"). 넘치면 sendTelegram 이 문단
     * 경계로 나눈다.
     *
     * ⚠️ `it.text` 가 아니라 `it.fullText` 다 (2026-08-31 — "주요채널 처럼
     * 안잘리게"). `text` 는 AI 토큰을 아끼려고 400자로 자른 값이라, 그걸 보내면
     * 「원문 전체」라고 적어 놓고 발췌를 보내게 된다. 실제로 그러고 있었다 —
     * 자르는 이유(AI 토큰)와 쓰는 곳(사람이 읽는 알림)이 다른데 값이 하나였다.
     */
    const body = esc((it.fullText ?? it.text).replace(/\n{3,}/g, "\n\n"));
    const link = it.link ? `\n\n🔗 <a href="${it.link}">원문 보기 →</a>` : "";
    return `${pickedHead(it)}\n━━━━━━━━━━━━\n${body}${link}`;
  });
}

/** 발송 묶음의 머리말 — 몇 건이 왜 왔는지 한 줄로 */
export function toPickedHeader(r: ChannelReport): string {
  const span =
    r.oldestAt && r.newestAt ? ` · ${hhmmKst(r.oldestAt)}~${hhmmKst(r.newestAt)}` : "";
  return `<b>채널 선별 ${r.usedCount}건</b> (원본 ${r.rawCount} · 채널 ${r.channels}개${span})`;
}

/**
 * 한 덩어리로 보는 형태 — 메일과 화면 미리보기용.
 * 텔레그램은 위의 `toPickedMessages` 로 건별 발송한다.
 */
export function toPickedHtml(r: ChannelReport): string {
  if (r.items.length === 0) return `${toPickedHeader(r)}\n\n선별된 내용이 없습니다.`;
  return [toPickedHeader(r), ...toPickedMessages(r, 25)].join("\n\n———\n\n");
}

export function toChannelHtml(r: ChannelReport): string {
  const head = `<b>구독 채널 정리</b>\n채널 ${r.channels}개 · 원본 ${r.rawCount}건 → 선별 ${r.usedCount}건\n`;
  const body = (r.summary ?? "")
    .split("\n")
    .map((raw) => {
      const line = raw.trim();
      if (!line) return "";
      if (line.startsWith("## ")) return `\n<b>${esc(line.slice(3))}</b>`;
      return esc(line);
    })
    .join("\n");
  return `${head}${body}`;
}
