/**
 * 봇이 최근에 본 대화방 목록을 뽑는다.
 *
 * 쓰는 법:
 *   1. 텔레그램에서 그룹을 만들고 @VNTG_HTS_bot 을 초대한다
 *   2. 그 방에 아무 메시지나 한 줄 보낸다 (봇은 초대만으로는 방을 모른다)
 *   3. server 폴더에서  node scripts/telegram-chats.mjs
 *   4. 나온 chat_id 를 .env 의 TELEGRAM_CHAT_ID_REPORT/_SIGNAL/_LOG 에 넣는다
 *
 * 주의: getUpdates 는 최근 24시간 것만 준다. 오래됐으면 방에 메시지를 다시 보낼 것.
 */
import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
config({ path: join(serverRoot, ".env") });

const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
if (!token) {
  console.error("TELEGRAM_BOT_TOKEN 이 .env 에 없습니다.");
  process.exit(1);
}

const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
const body = await res.json();
if (!body.ok) {
  console.error("조회 실패:", body.description);
  process.exit(1);
}

const seen = new Map();
for (const u of body.result) {
  const chat = (u.message ?? u.channel_post ?? u.my_chat_member)?.chat;
  if (chat) seen.set(chat.id, chat);
}

if (seen.size === 0) {
  console.log("보이는 대화방이 없습니다.");
  console.log("→ 각 그룹에 봇을 초대한 뒤 아무 메시지나 한 줄 보내고 다시 실행하세요.");
  process.exit(0);
}

console.log(`대화방 ${seen.size}개\n`);
for (const c of seen.values()) {
  const name = c.title ?? [c.first_name, c.last_name].filter(Boolean).join(" ");
  console.log(`  ${String(c.id).padEnd(16)}  ${c.type.padEnd(10)}  ${name}`);
}
console.log("\n이 값을 .env 의 TELEGRAM_CHAT_ID_REPORT / _SIGNAL / _LOG 에 넣으세요.");
