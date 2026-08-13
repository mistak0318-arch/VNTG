/**
 * 텔레그램 사용자 계정 로그인 (MTProto).
 *
 * 봇 API로는 내가 구독 중인 채널을 읽을 수 없다 — 봇은 자기가 초대된 방만 본다.
 * 구독 채널을 읽으려면 "텔레그램 클라이언트를 하나 더 만드는" 방식이어야 하고,
 * 그게 MTProto다. 이 스크립트는 그 로그인 한 번을 처리한다.
 *
 * ────────────────────────────────────────────────────────────
 * 미리 준비할 것
 *   1. https://my.telegram.org → API development tools
 *   2. 아무 앱 이름으로 등록하면 api_id(숫자)와 api_hash(문자열)가 나온다
 *   3. server/.env 에 넣는다:
 *        TELEGRAM_API_ID=12345678
 *        TELEGRAM_API_HASH=abcdef...
 *
 * 실행
 *   cd server
 *   node scripts/telegram-login.mjs
 *
 * 전화번호(+8210...) → 텔레그램 앱으로 오는 인증코드 → (2FA 쓰면) 비밀번호 순으로 물어본다.
 * 성공하면 세션 문자열이 출력되고 .env 의 TELEGRAM_SESSION 에 넣으라고 안내한다.
 *
 * ⚠ 세션 문자열은 계정 전체 권한이다.
 *   - 채팅창이나 커밋에 절대 올리지 말 것 (.env 는 .gitignore 에 있다)
 *   - 유출되면 https://my.telegram.org → 활성 세션에서 즉시 종료할 것
 * ────────────────────────────────────────────────────────────
 */
import { config } from "dotenv";
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stdin, stdout } from "node:process";

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(serverRoot, ".env");
config({ path: envPath });

/**
 * 세션을 .env 에 직접 써넣는다.
 * 화면에 찍어놓고 사람이 복사하게 하면 (1) 창을 닫아서 날리거나
 * (2) 계정 전체 권한인 문자열을 엉뚱한 데 붙여넣기 십상이다.
 */
async function writeSessionToEnv(session) {
  const raw = await readFile(envPath, "utf-8");
  const line = `TELEGRAM_SESSION=${session}`;
  const next = /^TELEGRAM_SESSION=.*$/m.test(raw)
    ? raw.replace(/^TELEGRAM_SESSION=.*$/m, line)
    : `${raw.trimEnd()}\n${line}\n`;
  await writeFile(envPath, next, "utf-8");
}

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH?.trim();

if (!apiId || !apiHash) {
  console.error("TELEGRAM_API_ID / TELEGRAM_API_HASH 가 .env 에 없습니다.");
  console.error("https://my.telegram.org → API development tools 에서 발급하세요.");
  process.exit(1);
}

const { TelegramClient } = await import("telegram");
const { StringSession } = await import("telegram/sessions/index.js");

const rl = createInterface({ input: stdin, output: stdout });
const ask = (q) => rl.question(q);

const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
  connectionRetries: 3,
});

console.log("\n텔레그램 로그인을 시작합니다. 입력값은 이 터미널에만 남습니다.\n");

await client.start({
  phoneNumber: () => ask("전화번호 (예: +821012345678): "),
  phoneCode: () => ask("텔레그램 앱으로 받은 인증코드: "),
  password: () => ask("2단계 인증 비밀번호 (없으면 그냥 Enter): "),
  onError: (err) => console.error("오류:", err.message ?? err),
});

const me = await client.getMe();
const session = client.session.save();

console.log("\n로그인 성공:", me.username ? "@" + me.username : me.firstName);

try {
  await writeSessionToEnv(session);
  console.log("\n✅ 세션을 server/.env 의 TELEGRAM_SESSION 에 저장했습니다.");
  console.log("   (복사할 필요 없습니다. 이 창은 그냥 닫으셔도 됩니다.)");
  console.log("\n다음: 서버를 재시작해야 .env 를 다시 읽습니다.");
  console.log("   PowerShell 관리자 권한으로");
  console.log("   Stop-ScheduledTask -TaskName 'VNTG HTS'; Start-ScheduledTask -TaskName 'VNTG HTS'");
} catch (err) {
  // 자동 저장이 실패하면 그때만 화면에 보여준다
  console.error("\n.env 자동 저장 실패:", err.message);
  console.log("아래 한 줄을 server/.env 에 직접 추가하세요:\n");
  console.log("TELEGRAM_SESSION=" + session);
}

console.log("\n⚠ 세션은 계정 전체 권한입니다. 채팅창·커밋에 올리지 마세요.");
console.log("   유출 시 my.telegram.org 의 활성 세션에서 즉시 종료할 수 있습니다.\n");

await client.disconnect();
rl.close();
process.exit(0);
