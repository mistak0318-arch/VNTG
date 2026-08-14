/**
 * 조간 다이제스트에 내 테마·미국연동이 실제로 들어가는지 본다.
 *
 * 개장 전 상황을 만들어야 하는데 지금은 장이 끝난 뒤라 traded=true 로 나온다.
 * 그래서 다이제스트 조각을 만드는 함수들을 직접 불러서 premarket 분기만 확인한다.
 *
 *   npx tsx scripts/morning-digest-probe.ts
 */
import "dotenv/config";
import { createKiwoomClientFromEnv } from "../src/kiwoomClient.js";
import { evaluateThemes, toCustomThemeDigest } from "../src/customThemes.js";
import { evaluateLinks, toUsKrDigest } from "../src/usKrLinks.js";
import { getMarketSnapshot } from "../src/marketSnapshot.js";

const client = createKiwoomClientFromEnv();

const snap = await getMarketSnapshot(client);
console.log(
  `스냅샷: ${new Date(snap.at).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}` +
    ` · ${snap.byCode.size}종목 · traded=${snap.traded}`,
);

const custom = await evaluateThemes(client);
console.log(`\ncustom.traded = ${custom.traded}`);

console.log("\n================ 개장 전(premarket) 분기 ================");
console.log(toCustomThemeDigest(custom.themes, { previousClose: true }).split("\n").slice(0, 8).join("\n"));

const { links } = await evaluateLinks(client);
console.log(toUsKrDigest(links, { premarket: true }).split("\n").slice(0, 6).join("\n"));

console.log("\n================ 장중/마감(기존) 분기 ================");
console.log(toCustomThemeDigest(custom.themes).split("\n").slice(0, 4).join("\n"));
console.log(toUsKrDigest(links).split("\n").slice(0, 4).join("\n"));
