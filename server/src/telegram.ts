import { recordApiCall } from "./apiUsage.js";

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

export type TelegramChannel = "report" | "signal" | "log" | "channel";

const CHANNEL_ENV: Record<TelegramChannel, string> = {
  report: "TELEGRAM_CHAT_ID_REPORT",
  signal: "TELEGRAM_CHAT_ID_SIGNAL",
  log: "TELEGRAM_CHAT_ID_LOG",
  channel: "TELEGRAM_CHAT_ID_CHANNEL",
};

/** 채널 전용 방이 있으면 그쪽으로, 없으면 기본 방으로 */
export function chatIdFor(channel: TelegramChannel): string {
  return (
    process.env[CHANNEL_ENV[channel]]?.trim() || process.env.TELEGRAM_CHAT_ID?.trim() || ""
  );
}

export function isTelegramConfigured(channel: TelegramChannel = "report"): boolean {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim() && chatIdFor(channel));
}

/** 어느 방이 어디로 가는지 — 설정 화면에서 확인용 */
export function telegramChannelStatus(): {
  channel: TelegramChannel;
  chatId: string;
  dedicated: boolean;
}[] {
  return (Object.keys(CHANNEL_ENV) as TelegramChannel[]).map((channel) => ({
    channel,
    chatId: chatIdFor(channel),
    dedicated: Boolean(process.env[CHANNEL_ENV[channel]]?.trim()),
  }));
}

/** HTML parse_mode를 쓰므로 &, <, > 는 이스케이프해야 한다 */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
      // 초당 제한이 있어 여러 건이면 잠깐 쉰다
      if (i < chunks.length - 1) await new Promise((r) => setTimeout(r, 400));
    } catch (err) {
      void recordApiCall("telegram", "sendMessage", "failed");
      return { ok: false, error: err instanceof Error ? err.message : "발송 실패" };
    }
  }
  return { ok: true };
}
