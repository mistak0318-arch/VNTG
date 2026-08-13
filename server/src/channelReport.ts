import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { summarize } from "./summarize.js";
import { sendTelegram } from "./telegram.js";
import { fetchNewMessages, isReaderConfigured } from "./telegramReader.js";
import { scoreMessages, toDigestText, type ScoredChannelItem } from "./telegramDigest.js";
import { listWatchlist } from "./watchlist.js";

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
  inputTokens: number;
  outputTokens: number;
  error?: string;
  /** 읽지 못한 채널 (FLOOD_WAIT 등) */
  skipped: string[];
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
  opts: { send?: boolean; useAi?: boolean; sinceHours?: number; limit?: number } = {},
): Promise<ChannelReport> {
  const { send = false, useAi = true, sinceHours = 12, limit = 60 } = opts;
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
  };

  if (!isReaderConfigured()) {
    return { ...base, error: "텔레그램 세션 미설정 — scripts/telegram-login.mjs 를 먼저 실행하세요" };
  }

  const { messages, channels, skipped } = await fetchNewMessages({ sinceHours });
  const watchNames = (await listWatchlist().catch(() => [])).map((w) => w.name);
  const items = scoreMessages(messages, watchNames, limit);

  const report: ChannelReport = {
    ...base,
    channels,
    rawCount: messages.length,
    usedCount: items.length,
    items,
    skipped,
  };

  if (items.length === 0) {
    report.error = "정리할 만한 메시지가 없습니다 (필터 통과 0건)";
    return report;
  }
  if (!useAi) return report;

  const prompt = `${SYSTEM_RULES}\n\n---\n수집 시각: ${now.toLocaleString("ko-KR")}\n대상 채널 ${channels}개 · 원본 ${messages.length}건 중 ${items.length}건 선별\n\n${toDigestText(items)}`;

  const res = await summarize(prompt, 2500);
  report.summary = res.text;
  report.inputTokens = res.inputTokens;
  report.outputTokens = res.outputTokens;
  if (res.error) report.error = res.error;

  await append(report);

  if (send && report.summary) {
    const html = toChannelHtml(report);
    await sendTelegram(html, "channel").catch(() => undefined);
  }

  return report;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
