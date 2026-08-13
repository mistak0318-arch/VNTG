import { recordApiCall } from "./apiUsage.js";

/**
 * 텔레그램 단방향 알림.
 * 키가 없으면 조용히 건너뛴다 — 발송 실패가 리포트 발행을 막으면 안 된다.
 */

const LIMIT = 3900; // 텔레그램 한도 4096자. 여유를 둔다.

export function isTelegramConfigured(): boolean {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim() && process.env.TELEGRAM_CHAT_ID?.trim());
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

export async function sendTelegram(html: string): Promise<{ ok: boolean; error?: string }> {
  if (!isTelegramConfigured()) return { ok: false, error: "텔레그램 키 미설정" };

  const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN!.trim()}/sendMessage`;
  const chunks = split(html);

  for (const [i, chunk] of chunks.entries()) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: process.env.TELEGRAM_CHAT_ID!.trim(),
          text: chunk,
          parse_mode: "HTML",
          disable_web_page_preview: true,
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
