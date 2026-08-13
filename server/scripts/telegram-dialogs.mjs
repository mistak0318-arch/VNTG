/**
 * 구독 중인 채널 목록을 뽑는다.
 *
 * 180개를 전부 수집 대상으로 삼으면 안 된다 — 광고 채널, 잡담방, 오래 죽은 채널이 섞여 있고
 * 그런 걸 AI에 넣으면 비용만 늘고 요약 품질은 떨어진다.
 * 그래서 먼저 목록을 눈으로 보고 쓸 것만 고른다.
 *
 * 실행: cd server && node scripts/telegram-dialogs.mjs
 * 결과는 화면 출력 + server/data/telegramChannels.json 에 저장된다.
 * 저장된 파일에서 enabled 를 false 로 바꾸면 그 채널은 수집하지 않는다.
 */
import { config } from "dotenv";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
config({ path: join(serverRoot, ".env") });

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH?.trim();
const session = process.env.TELEGRAM_SESSION?.trim();

if (!apiId || !apiHash || !session) {
  console.error("TELEGRAM_API_ID / TELEGRAM_API_HASH / TELEGRAM_SESSION 이 필요합니다.");
  console.error("먼저 node scripts/telegram-login.mjs 를 실행하세요.");
  process.exit(1);
}

const { TelegramClient } = await import("telegram");
const { StringSession } = await import("telegram/sessions/index.js");

const client = new TelegramClient(new StringSession(session), apiId, apiHash, {
  connectionRetries: 3,
});
await client.connect();

const dialogs = await client.getDialogs({ limit: 500 });

// 채널·그룹만. 1:1 대화는 시황 정보원이 아니다.
const rows = dialogs
  .filter((d) => d.isChannel || d.isGroup)
  .map((d) => ({
    id: String(d.id),
    name: d.title ?? d.name ?? "(이름 없음)",
    username: d.entity?.username ?? null,
    broadcast: Boolean(d.entity?.broadcast), // true=채널(일방향), false=그룹
    participants: d.entity?.participantsCount ?? null,
    lastAt: d.message?.date ? new Date(d.message.date * 1000).toISOString() : null,
  }))
  .sort((a, b) => (b.lastAt ?? "").localeCompare(a.lastAt ?? ""));

console.log(`\n채널·그룹 ${rows.length}개 (최근 활동순)\n`);
for (const [i, r] of rows.entries()) {
  const when = r.lastAt ? r.lastAt.slice(0, 16).replace("T", " ") : "활동 없음";
  const kind = r.broadcast ? "채널" : "그룹";
  console.log(
    `${String(i + 1).padStart(3)}. ${kind}  ${when}  ${r.name}${r.username ? " (@" + r.username + ")" : ""}`,
  );
}

// 기존 선택을 덮어쓰지 않는다 — 새로 보이는 채널만 추가한다
const outPath = join(serverRoot, "data", "telegramChannels.json");
let prev = [];
try {
  prev = JSON.parse(await readFile(outPath, "utf-8"));
} catch {
  /* 첫 실행 */
}
const prevById = new Map(prev.map((p) => [p.id, p]));

const merged = rows.map((r) => ({
  ...r,
  // 처음 보는 채널은 기본 비활성 — 180개가 한꺼번에 켜지면 감당이 안 된다
  enabled: prevById.get(r.id)?.enabled ?? false,
}));

await mkdir(join(serverRoot, "data"), { recursive: true });
await writeFile(outPath, JSON.stringify(merged, null, 2), "utf-8");

const on = merged.filter((m) => m.enabled).length;
console.log(`\n저장: data/telegramChannels.json`);
console.log(`수집 대상으로 켜진 채널: ${on}개 / 전체 ${merged.length}개`);
console.log(`→ 웹 '설정 > 텔레그램 채널 수집' 에서 켜고 끌 수 있습니다.\n`);

await client.disconnect();
process.exit(0);
