import { sendMail } from "./mailer.js";
import type { PublishedReport } from "./reportStore.js";
import { sendTelegram, toTelegramHtml } from "./telegram.js";

/**
 * 발행된 리포트를 텔레그램·메일로 내보낸다.
 * 저장(발행)과 발송을 분리해 둔 이유: 발송이 실패해도 리포트 자체는 남아야 하고,
 * 나중에 같은 저장분을 다시 보낼 수 있어야 하기 때문이다.
 */

export interface DeliveryResult {
  telegram: { ok: boolean; error?: string };
  mail: { ok: boolean; error?: string };
}

function header(r: PublishedReport): string {
  const d = new Date(r.publishedAt);
  return `${r.date} ${r.label} · ${d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false })} 발행`;
}

/** 메일 본문 — 메일 클라이언트는 CSS 지원이 제각각이라 인라인 스타일만 쓴다 */
function mailHtml(r: PublishedReport): string {
  const body = (r.summary.text ?? "요약을 생성하지 못했습니다.")
    .split("\n")
    .map((raw) => {
      const line = raw.trim();
      if (!line) return "";
      if (line.startsWith("## ")) {
        return `<h3 style="margin:18px 0 6px;padding-left:8px;border-left:3px solid #1c6dd0;font-size:15px;color:#1b2430;">${line.slice(3)}</h3>`;
      }
      const html = line
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
      if (/^[-*•]\s/.test(line) || /^\d+\.\s/.test(line)) {
        return `<div style="margin:3px 0 3px 12px;color:#333;">· ${html.replace(/^([-*•]|\d+\.)\s/, "")}</div>`;
      }
      return `<p style="margin:5px 0;line-height:1.7;color:#333;">${html}</p>`;
    })
    .join("");

  return `<div style="max-width:680px;margin:0 auto;font-family:-apple-system,'Malgun Gothic',sans-serif;">
  <div style="border-bottom:2px solid #1c6dd0;padding-bottom:10px;margin-bottom:16px;">
    <div style="font-size:20px;font-weight:700;color:#1b2430;">VNTG 데일리 리포트</div>
    <div style="font-size:13px;color:#5b6673;margin-top:4px;">${header(r)}</div>
  </div>
  ${body}
  <div style="margin-top:24px;padding-top:12px;border-top:1px solid #d7dee7;font-size:11px;color:#8b96a5;line-height:1.6;">
    AI가 시장 데이터를 요약한 것으로 매매 판단의 근거가 아닙니다.<br/>
    모델 ${r.summary.model} · 토큰 ${r.summary.inputTokens}/${r.summary.outputTokens}
  </div>
</div>`;
}

export async function deliverReport(r: PublishedReport): Promise<DeliveryResult> {
  const text = r.summary.text;
  if (!text) {
    return {
      telegram: { ok: false, error: "요약 없음" },
      mail: { ok: false, error: "요약 없음" },
    };
  }

  const tgBody = `📰 <b>VNTG 데일리 리포트</b>\n${header(r)}\n${toTelegramHtml(text)}`;

  // 한쪽이 실패해도 다른 쪽은 나가야 한다
  const [telegram, mail] = await Promise.all([
    sendTelegram(tgBody, "report").catch((e) => ({ ok: false, error: String(e) })),
    sendMail(`[VNTG] ${r.date} ${r.label} 리포트`, mailHtml(r)).catch((e) => ({
      ok: false,
      error: String(e),
    })),
  ]);

  console.log(
    `[report] 발송 — 텔레그램 ${telegram.ok ? "성공" : `실패(${telegram.error})`} / 메일 ${mail.ok ? "성공" : `실패(${mail.error})`}`,
  );
  return { telegram, mail };
}
