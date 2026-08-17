/**
 * 텔레그램 방의 chat_id 를 찾는다.
 *
 * 봇은 **자기가 들어가 있고 메시지를 본 적 있는 방**만 알 수 있다. 그래서 순서가 있다.
 *
 *   1) 그 그룹에 봇을 초대한다 (그룹 → 멤버 추가 → 봇 이름 검색)
 *   2) 그룹에 아무 메시지나 하나 쓴다 (예: "hi")
 *   3) 이 스크립트를 돌린다
 *
 * getUpdates 는 **최근 것만** 준다. 2)를 건너뛰면 방이 안 보인다 — 그때는 메시지를
 * 하나 쓰고 다시 돌리면 된다.
 *
 * 봇이 그룹에서 일반 메시지를 못 읽는 설정(privacy mode)이어도, **봇을 초대한 순간의
 * 이벤트**는 잡히므로 대개 한 번은 보인다. 안 보이면 @BotFather 에서
 * /setprivacy → Disable 로 바꾸고 다시 메시지를 써 보라.
 *
 *   node scripts/telegram-chatid.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(here, "..", ".env"), "utf-8").split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}

const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
if (!token) {
  console.log("TELEGRAM_BOT_TOKEN 이 .env 에 없습니다.");
  process.exit(1);
}

const me = await (await fetch(`https://api.telegram.org/bot${token}/getMe`)).json();
if (!me.ok) {
  console.log("봇 토큰이 잘못됐습니다:", me.description);
  process.exit(1);
}
console.log(`봇: @${me.result.username} (${me.result.first_name})\n`);

const r = await (await fetch(`https://api.telegram.org/bot${token}/getUpdates?limit=100`)).json();
if (!r.ok) {
  console.log("getUpdates 실패:", r.description);
  process.exit(1);
}

const seen = new Map();
for (const u of r.result ?? []) {
  const msg = u.message ?? u.channel_post ?? u.my_chat_member ?? u.edited_message;
  const chat = msg?.chat;
  if (!chat) continue;
  seen.set(String(chat.id), {
    id: chat.id,
    type: chat.type,
    title: chat.title ?? chat.username ?? `${chat.first_name ?? ""} ${chat.last_name ?? ""}`.trim(),
  });
}

if (seen.size === 0) {
  console.log("보이는 방이 없습니다.\n");
  console.log("  1) 그룹에 봇(@" + me.result.username + ")을 초대했는지 확인");
  console.log("  2) 그룹에 아무 메시지나 하나 쓰기");
  console.log("  3) 이 스크립트를 다시 실행");
  console.log("\n그래도 안 보이면 @BotFather → /setprivacy → Disable 후 메시지를 다시 써 보세요.");
  process.exit(0);
}

console.log("찾은 방:\n");
for (const c of seen.values()) {
  const mark = /VNTG/i.test(c.title) ? "  ← 이것 같습니다" : "";
  console.log(`  ${String(c.id).padStart(16)}  [${c.type}]  ${c.title}${mark}`);
}

console.log("\n.env 에 아래 줄을 넣으세요 (공시 알림 전용 방):");
console.log("  TELEGRAM_CHAT_ID_DISCLOSURE=<위 id>");
console.log("\n넣은 뒤 서버를 재시작하면 적용됩니다.");
