import nodemailer from "nodemailer";
import { recordApiCall } from "./apiUsage.js";

/**
 * 네이버 SMTP 메일 발송.
 * 2단계 인증을 쓰면 일반 비밀번호가 아니라 애플리케이션 비밀번호가 필요하다.
 */

export function isMailConfigured(): boolean {
  return Boolean(
    process.env.NAVER_MAIL_USER?.trim() &&
      process.env.NAVER_MAIL_PASS?.trim() &&
      process.env.MAIL_TO?.trim(),
  );
}

/** 아이디만 넣었든 전체 주소를 넣었든 동작하게 */
function fromAddress(): string {
  const raw = (process.env.NAVER_MAIL_USER ?? "").trim();
  return raw.includes("@") ? raw : `${raw}@naver.com`;
}

export async function sendMail(
  subject: string,
  html: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!isMailConfigured()) return { ok: false, error: "메일 설정 미완료" };

  try {
    const transporter = nodemailer.createTransport({
      host: "smtp.naver.com",
      port: 465,
      secure: true,
      auth: {
        user: (process.env.NAVER_MAIL_USER ?? "").trim(),
        pass: (process.env.NAVER_MAIL_PASS ?? "").trim(),
      },
    });
    await transporter.sendMail({
      from: `"VNTG HTS" <${fromAddress()}>`,
      to: (process.env.MAIL_TO ?? "").trim(),
      subject,
      html,
    });
    void recordApiCall("mail", "sendMail", "ok");
    return { ok: true };
  } catch (err) {
    void recordApiCall("mail", "sendMail", "failed");
    return { ok: false, error: err instanceof Error ? err.message : "발송 실패" };
  }
}
