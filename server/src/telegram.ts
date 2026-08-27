import { recordApiCall } from "./apiUsage.js";
import { assignedChatId } from "./telegramRooms.js";

/**
 * 텔레그램 단방향 알림.
 * 키가 없으면 조용히 건너뛴다 — 발송 실패가 리포트 발행을 막으면 안 된다.
 *
 * 봇은 하나지만 대화방은 여러 개다. 텔레그램에서 방을 구분하는 건 chat_id이고
 * 토큰은 "누가 보내는가"만 정하므로, 같은 봇을 각 방에 초대해두고
 * chat_id만 바꿔 보내면 성격이 다른 알림이 섞이지 않는다.
 *
 *   report — 조간/장중/석간 정기 리포트 (하루 3건, 알림 켬)
 *   signal — 관심종목 급변·조건 충족   (하루 0~5건, 알림 켬)
 *   log    — 발행 실패, API 한도 등     (드묾, 알림 끔)
 *
 * .env에 TELEGRAM_CHAT_ID_REPORT / _SIGNAL / _LOG 를 두고,
 * 없으면 전부 기본 TELEGRAM_CHAT_ID로 떨어진다. 방을 안 나눠도 그대로 동작한다.
 */

const LIMIT = 3900; // 텔레그램 한도 4096자. 여유를 둔다.

export type TelegramChannel =
  | "report"
  | "signal"
  | "log"
  | "channel"
  | "disclosure"
  | "keyword"
  /** 슈퍼신호등 편입·이탈 (2026-08-26) — 하루 한 번 15:45 실행이 보낸다 */
  | "super"
  /** 밤사이 버즈 레이더 (2026-08-27) — 채널 언급 급증 감지가 보낸다 */
  | "buzz";

const CHANNEL_ENV: Record<TelegramChannel, string> = {
  report: "TELEGRAM_CHAT_ID_REPORT",
  signal: "TELEGRAM_CHAT_ID_SIGNAL",
  log: "TELEGRAM_CHAT_ID_LOG",
  channel: "TELEGRAM_CHAT_ID_CHANNEL",
  disclosure: "TELEGRAM_CHAT_ID_DISCLOSURE",
  keyword: "TELEGRAM_CHAT_ID_KEYWORD",
  super: "TELEGRAM_CHAT_ID_SUPER",
  // 사용자가 판 방의 .env 키 이름이 SUPERSIGNAL 이다 — 갈래 이름(buzz)과 키 이름이 다름에 주의
  buzz: "TELEGRAM_CHAT_ID_SUPERSIGNAL",
};

/**
 * 채널의 목적지 —
 *   ① 화면에서 재배정한 방(data/telegramRooms.json)
 *   ② .env 의 전용 키(TELEGRAM_CHAT_ID_*)
 *   ③ 기본 방(TELEGRAM_CHAT_ID)
 * 순서다. 화면 배정이 .env 를 이기는 이유: .env 는 재시작이 필요해서,
 * 「이 갈래만 잠깐 저 방으로」 같은 조정을 화면이 담당한다.
 */
export function chatIdFor(channel: TelegramChannel): string {
  return (
    assignedChatId(channel) ||
    process.env[CHANNEL_ENV[channel]]?.trim() ||
    process.env.TELEGRAM_CHAT_ID?.trim() ||
    ""
  );
}

export function isTelegramConfigured(channel: TelegramChannel = "report"): boolean {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim() && chatIdFor(channel));
}

/**
 * 이 갈래에 **전용 방**이 있나.
 *
 * 슈퍼신호등처럼 「전용 방이 있으면 거기로, 없으면 원래 갈래로」 나눠 보내는
 * 라우팅이 이걸 본다 — chatIdFor 는 기본 방으로 조용히 떨어지기 때문에,
 * 그걸로 판단하면 방을 안 판 사람의 알림이 기본 방에 섞여 버린다.
 */
export function hasDedicatedChannel(channel: TelegramChannel): boolean {
  return Boolean(assignedChatId(channel) || process.env[CHANNEL_ENV[channel]]?.trim());
}

/** 어느 방이 어디로 가는지 — 설정 화면에서 확인용 */
export function telegramChannelStatus(): {
  channel: TelegramChannel;
  chatId: string;
  dedicated: boolean;
  /** 화면에서 재배정된 갈래인가 (.env 대신 telegramRooms.json 이 정함) */
  overridden: boolean;
  /** .env 전용 키가 가리키는 원래 방 — 재배정을 되돌릴 때 보여줄 값 */
  envChatId: string;
}[] {
  return (Object.keys(CHANNEL_ENV) as TelegramChannel[]).map((channel) => ({
    channel,
    chatId: chatIdFor(channel),
    dedicated: hasDedicatedChannel(channel),
    overridden: Boolean(assignedChatId(channel)),
    envChatId: process.env[CHANNEL_ENV[channel]]?.trim() ?? "",
  }));
}

/** .env 가 아는 방 명단 — 재배정 드롭다운의 후보 (기본 방 포함) */
export function telegramEnvRooms(): { key: string; label: string; chatId: string }[] {
  const LABEL: Record<TelegramChannel, string> = {
    report: "리포트 방",
    signal: "시그널 방",
    log: "로그 방",
    channel: "채널수집 방",
    disclosure: "공시 방",
    keyword: "키워드 방",
    super: "슈퍼신호등 방",
    buzz: "버즈 레이더 방",
  };
  const out: { key: string; label: string; chatId: string }[] = [];
  const base = process.env.TELEGRAM_CHAT_ID?.trim();
  if (base) out.push({ key: "base", label: "기본 방", chatId: base });
  for (const ch of Object.keys(CHANNEL_ENV) as TelegramChannel[]) {
    const id = process.env[CHANNEL_ENV[ch]]?.trim();
    // 같은 chat_id 가 여러 키에 걸려 있으면 한 번만
    if (id && !out.some((r) => r.chatId === id)) out.push({ key: ch, label: LABEL[ch], chatId: id });
  }
  return out;
}

/** HTML parse_mode를 쓰므로 &, <, > 는 이스케이프해야 한다 */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * 알림 딥링크 — 폰에서 알림을 받고 「열어서 확인」까지가 세 단계였다
 * (앱 열기 → 검색 → 종목 클릭). 종목명 자체를 개별종목분석 링크로 만들면 한 번이 된다.
 *
 * `.env` 의 `HTS_WEB_URL` (예: `http://192.168.0.10:5100`) 이 바탕 주소다.
 * 미설정이면 링크 없이 굵은 이름만 — 개발 PC 처럼 알림을 안 쓰는 곳에선 없어도 된다.
 */
export function stockDeepLink(code: string, name: string): string | null {
  const base = process.env.HTS_WEB_URL?.trim().replace(/\/+$/, "");
  if (!base) return null;
  const q = new URLSearchParams({ code, name });
  return `${base}/#/stockAnalysis?${q.toString()}`;
}

/** 종목명 HTML — 주소가 있으면 링크, 없으면 굵게 */
export function stockNameHtml(code: string, name: string): string {
  const url = stockDeepLink(code, name);
  const esc = escapeHtml(name);
  return url ? `<a href="${url}">${esc}</a>` : `<b>${esc}</b>`;
}

/** 마크다운풍 AI 텍스트를 텔레그램 HTML로 */
export function toTelegramHtml(text: string): string {
  return text
    .split("\n")
    .map((raw) => {
      const line = raw.trim();
      if (!line) return "";
      if (line.startsWith("## ")) return `\n<b>${escapeHtml(line.slice(3))}</b>`;
      // **굵게** 처리 후 나머지 이스케이프
      const parts = line.split(/(\*\*[^*]+\*\*)/g).map((p) =>
        p.startsWith("**") && p.endsWith("**")
          ? `<b>${escapeHtml(p.slice(2, -2))}</b>`
          : escapeHtml(p),
      );
      return parts.join("");
    })
    .join("\n");
}

/** 길면 문단 경계에서 나눠 보낸다 */
function split(text: string): string[] {
  if (text.length <= LIMIT) return [text];
  const out: string[] = [];
  let buf = "";
  for (const para of text.split("\n")) {
    if (buf.length + para.length + 1 > LIMIT) {
      out.push(buf);
      buf = para;
    } else {
      buf = buf ? `${buf}\n${para}` : para;
    }
  }
  if (buf) out.push(buf);
  return out;
}

export async function sendTelegram(
  html: string,
  channel: TelegramChannel = "report",
): Promise<{ ok: boolean; error?: string }> {
  if (!isTelegramConfigured(channel)) return { ok: false, error: "텔레그램 키 미설정" };

  const chatId = chatIdFor(channel);
  // 로그는 조용히 — 알림음 없이 보낸다
  const silent = channel === "log";
  const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN!.trim()}/sendMessage`;
  const chunks = split(html);

  for (const [i, chunk] of chunks.entries()) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: chunk,
          parse_mode: "HTML",
          disable_web_page_preview: true,
          disable_notification: silent,
        }),
      });
      const body = (await res.json()) as { ok?: boolean; description?: string };
      if (!body.ok) {
        void recordApiCall("telegram", "sendMessage", "failed");
        return { ok: false, error: body.description ?? `HTTP ${res.status}` };
      }
      void recordApiCall("telegram", "sendMessage", "ok");
      /*
       * 발신 아카이브 (2026-08-27) — 브라우저 「받은 방」 뷰어의 재료.
       * 동적 import 로 순환을 피하고, 실패는 아카이브 쪽이 삼킨다.
       */
      void import("./telegramArchive.js")
        .then((m) => m.archiveOutgoing(channel, chunk))
        .catch(() => undefined);
      // 초당 제한이 있어 여러 건이면 잠깐 쉰다
      if (i < chunks.length - 1) await new Promise((r) => setTimeout(r, 400));
    } catch (err) {
      void recordApiCall("telegram", "sendMessage", "failed");
      return { ok: false, error: err instanceof Error ? err.message : "발송 실패" };
    }
  }
  return { ok: true };
}
