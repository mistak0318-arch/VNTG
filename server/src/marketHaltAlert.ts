import { pushNotice } from "./notifyCenter.js";
import { sendTelegram } from "./telegram.js";
import { probeHaltSources } from "./haltProbe.js";

/**
 * **사이드카·서킷브레이커** (2026-10-15).
 *
 * 벤티지: "우리도 알람에 사이드카 써킷 이런거 표시했음 좋겠는데" (키움 앱의
 * 「코스피 매도 사이드카 해제」 배너).
 *
 * ## 왜 뉴스로 받나 — 실시간으로는 안 오더라
 *
 * 먼저 키움 실시간을 봤다. `0s`(장운영구분, FID 215)는 **종목과 무관한 시장 전체
 * 신호**라 유망해 보였고 코드도 스무 가지나 와서 시장조치가 섞였을 법했다. 그런데
 * 오늘 09:15 에 실제로 코스피 매도 사이드카가 발동·해제됐는데 **그 시각 줄이 아예
 * 없었다** — 오늘 온 것은 08:00 P · 08:45 o · 08:50 Q · 08:50~08:59 0(카운트다운) ·
 * 09:00 3 · 09:00:32 R 이 전부, 전부 시간대 전환이다.
 *
 * 그래서 **이미 긁고 있는 뉴스**로 받는다. 추가 조회가 한 건도 없다:
 * 뉴스 키워드 수집기가 장중 몇 분마다 네이버 속보를 긁는데, 오늘 그 창고를 열어 보니
 * **09:05:12 에 이미 들어와 있었다** — 「[속보] 코스피 매도 사이드카… 7거래일 연속
 * 하락에 5600선 추락」. 발동과 거의 같은 순간이다.
 *
 * ## ⚠️ 한 사건에 기사가 수십 개다
 *
 * 오늘 하루에만 제목에 「사이드카」가 든 기사가 159건이었다. 그대로 알리면 알림함이
 * 그 한 사건으로 덮인다. 그래서 **사건을 열쇠로 접는다** — `날짜|종류|시장|상태`.
 *
 * 열쇠를 처음엔 방향(매도·매수)까지 넣어 짰는데, 오늘 제목으로 재 보니 **32건이
 * 5건으로**밖에 안 줄었다. 같은 사건을 「코스피」와 「양 시장」으로 따로 세고, 방향을
 * 안 적은 제목이 또 따로 셌기 때문이다. 그래서
 *
 *   · **양 시장은 둘로 펼친다** — 「코스피·코스닥 동반」은 코스피 사건이자 코스닥 사건이다
 *   · **방향은 열쇠에서 뺀다** — 제목에는 그대로 싣되 세는 기준에서는 뺀다
 *
 * 다시 재니 **2건** — 실제로 오늘 일어난 사건 수와 같고, 둘 다 [속보]라 발동 직후다
 * (09:05:12 코스피, 09:13:12 코스닥).
 *
 * ⚠️ 이 접기로 못 받는 것이 하나 있다: 같은 날 같은 시장에서 **매도 사이드카 뒤에
 * 매수 사이드카**가 걸리면 둘째는 안 울린다. 하루에 양방향이 다 걸리는 날은 사실상
 * 없고, 있어도 해제 알림이 따로 울린다 — 알림함이 한 사건으로 덮이는 쪽이 더 나쁘다.
 *
 * ## ⚠️ 「해제」를 「발동」으로 읽으면 안 된다
 *
 * 제목에 둘 다 들어가는 경우가 흔하다(「…발동 후 5분 만에 해제」). 그래서 **해제를
 * 먼저 본다** — 해제 기사는 발동을 전제하므로, 발동을 못 잡았더라도 해제가 그 사실을
 * 같이 알린다. 거꾸로 하면 해제 소식이 「발동!」으로 울린다.
 *
 * ## 못 잡는 것
 *
 * 제목에 시장 이름이 없으면(「양대시장」·「동반」) 시장을 `양시장`으로 적는다.
 * 그것도 없으면 **시장을 안 적는다** — 추측해서 「코스피」라고 쓰면, 코스닥만 걸린
 * 날 틀린 알림이 된다. 몰라서 비워 둔 칸은 읽는 사람이 기사를 보면 되지만,
 * 지어낸 칸은 그 자리에서 거짓이 된다.
 */

export type HaltKind = "사이드카" | "서킷브레이커";
export type HaltState = "발동" | "해제";

interface Hit {
  kind: HaltKind;
  state: HaltState;
  /** 「양 시장」이면 둘로 펼쳐 둔다. 아무것도 못 읽으면 `시장불명` 하나 */
  markets: string[];
  /** 매도 · 매수 · null(모름) — 제목에만 쓴다. 세는 기준에는 안 넣는다 */
  side: string | null;
}

/** 오늘 이미 알린 사건 — `날짜|종류|시장|상태` */
const sent = new Set<string>();
let sentDay = "";

function kstDay(): string {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
}

function parse(title: string): Hit | null {
  const t = title.replace(/\s+/g, " ");
  const kind: HaltKind | null = /사이드카/.test(t)
    ? "사이드카"
    : /서킷브레이커|서킷 브레이커|CB 발동|거래중단/.test(t)
      ? "서킷브레이커"
      : null;
  if (!kind) return null;
  /* 해제를 먼저 — 한 제목에 둘 다 있으면 그건 해제 소식이다 */
  const state: HaltState = /해제|해지|종료/.test(t) ? "해제" : /발동|가동|걸렸|돌입/.test(t) ? "발동" : "발동";
  const bothMarkets = /양대\s*시장|양\s*시장|동반|코스피[·,\s]*코스닥|코스닥[·,\s]*코스피/.test(t);
  const markets = bothMarkets
    ? ["코스피", "코스닥"]
    : /코스피|KOSPI/i.test(t)
      ? ["코스피"]
      : /코스닥|KOSDAQ/i.test(t)
        ? ["코스닥"]
        : ["시장불명"];
  const side = /매도/.test(t) ? "매도" : /매수/.test(t) ? "매수" : null;
  return { kind, state, markets, side };
}

/**
 * 기사 한 줄을 본다. **새로 들어온 기사에만** 불린다(수집기가 이미 중복을 걸러 준다).
 * 터져도 뉴스 수집이 멈추면 안 되므로 부르는 쪽에서 감싼다.
 */
export async function noteMarketHalt(title: string, link?: string, press?: string): Promise<void> {
  const hit = parse(title);
  if (!hit) return;
  const day = kstDay();
  if (day !== sentDay) {
    sent.clear();
    sentDay = day;
  }
  /* 아직 안 알린 시장만 남긴다 — 「동반」 기사가 와도 이미 알린 쪽은 다시 안 울린다 */
  const fresh = hit.markets.filter((m) => !sent.has(`${day}|${hit.kind}|${m}|${hit.state}`));
  if (fresh.length === 0) return;
  for (const m of fresh) sent.add(`${day}|${hit.kind}|${m}|${hit.state}`);
  const key = `${day}|${hit.kind}|${fresh.join("·")}|${hit.state}`;

  const what = [fresh.join("·"), hit.side, hit.kind].filter(Boolean).join(" ");
  const head = `${what} ${hit.state}`;
  const note = await pushNotice({
    kind: "market",
    source: "halt",
    level: hit.state === "발동" ? "warn" : "info",
    title: head,
    /* 제목을 그대로 싣는다 — 우리가 요약하면 「5.74% 하락」 같은 숫자가 사라진다 */
    body: title,
    /*
     * ⚠️ 기사 주소는 `link` 에 안 넣는다 — 그 칸은 **앱 안의 해시 경로**(`#/...`)
     * 전용이라 바깥 주소를 넣으면 눌렀을 때 엉뚱한 데로 간다. 주소는 텔레그램에 싣는다.
     */
    dedupeKey: key,
    dedupeHours: 12,
  });
  /*
   * 알림함에 안 담겼으면(출처를 꺼 뒀으면) 텔레그램도 안 보낸다. 사이드카는 끄고 싶은
   * 사람이 있을 만한 소식이고, 한쪽만 막으면 왜 오는지 못 찾는다.
   */
  if (!note) return;
  /*
   * **울린 김에 잰다** (2026-10-15) — 더 빠른 길이 있나는 다음 발동 때만 답할 수 있는데,
   * 그때 사람이 깨어 있으리라 기대할 수 없다. 알림이 **나간 뒤에** 부르므로 네이버가
   * 느려도 경보는 제때 울린다. 자세한 까닭은 `haltProbe`.
   */
  void probeHaltSources(key).catch(() => undefined);
  const press2 = press ? ` · ${press}` : "";
  await sendTelegram(
    `<b>⚠️ ${head}</b>\n${title}${press2}${link ? `\n${link}` : ""}`,
    "signal",
  ).catch(() => undefined);
}

/** health.json 「시장경보」 — 오늘 무엇을 알렸나 */
export function marketHaltSnapshot(): { 오늘: string; 알림: string[] } {
  return { 오늘: sentDay, 알림: [...sent] };
}
