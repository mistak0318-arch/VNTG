import { listNotices, pushNotice } from "./notifyCenter.js";
import { sendTelegram } from "./telegram.js";
import { probeHaltSources } from "./haltProbe.js";
import { MIN } from "./marketHours.js";
import { isTradingDay } from "./tradingDay.js";

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
 * ## ⚠️ 후속 기사를 새 사건으로 읽으면 안 된다 (2026-10-15 저녁 보강)
 *
 * 벤티지: "이게 속보로 사이드카 잡으니깐 후속기사 날때마다 사이드카라고 인식할 수
 * 있는 오류가 있더."
 *
 * 맞다. 처음 판에는 두 군데가 샜다.
 *
 * **① 열쇠가 흔들렸다.** 「코스피」로 한 번 보낸 뒤 「코스피·코스닥 동반」 기사가 오면
 * 알림함에 넘기는 열쇠가 `…|코스피|…` 에서 `…|코스피·코스닥|…` 으로 **달라져** 다시
 * 울린다. 게다가 우리 기억은 메모리에만 있어서 **서버가 뜰 때마다 비는데**, 오늘만
 * 여덟 번 재시작했다. 그래서 **시장마다 따로 알린다** — 열쇠가 `날짜|종류|한 시장|상태`
 * 로 못 박히면 알림함의 12시간 중복막이가 재시작까지 덮어 준다. 코스피와 코스닥은
 * 어차피 **별개 사건**이라 따로 울리는 편이 맞기도 하다.
 *
 * **② 회고 기사를 못 갈랐다.** 몇 시간 뒤·며칠 뒤 「당시 사이드카가…」 기사를 새
 * 발동으로 읽는다. 둘로 막는다:
 *
 *   · **장중에만** 받는다 — 사이드카·CB 는 정규장 사건이다. 장 밖 기사는 전부 회고다
 *   · 제목에 **과거를 가리키는 말**(지난·어제·당시·했던·여파…)이 있으면 거른다
 *
 * 오늘치 제목 35개로 재 보니 과거 표현에 걸린 것이 **0개**였다 — 당일 속보는 안 죽이고
 * 회고만 거른다는 뜻이다.
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

/**
 * **기억을 알림함에서 되살린다** (2026-10-15 저녁 — 벤티지: "매도 사이드카 알림이
 * 지금도 왔어. 오늘 이미 매도 사이드카는 발동이 되었는데도 말야").
 *
 * 앞선 고침에서 「열쇠를 못 박으면 알림함의 12시간 중복막이가 재시작까지 덮어 준다」고
 * 적었는데, **덮어 주지 못하는 창이 하나 있었다** — 열쇠 모양을 바꾼 그 배포다.
 * 09시에 나간 알림은 옛 열쇠(`…|코스피·코스닥|…`)로 적혀 있고 새 코드는 새 열쇠
 * (`…|코스피|…`)로 물으니, 알림함이 **같은 사건인 줄 모른다.** 그래서 후속 기사
 * 하나에 또 울렸다.
 *
 * 열쇠에 기대는 대신 **이미 알린 사건을 읽어 와서** 기억을 채운다. 옛 열쇠의 시장 칸은
 * `·` 로 묶여 있으니 풀어서 각각 넣는다 — 그러면 모양이 달라도 같은 사건으로 알아본다.
 * 서버가 뜨고 처음 한 번만 읽는다.
 *
 * 이 방식이 파일을 따로 만드는 것보다 나은 까닭: **알림함이 이미 그 기록을 들고 있다.**
 * 같은 사실을 두 곳에 적으면 언젠가 서로 어긋난다.
 */
let revived = "";
async function reviveSent(day: string): Promise<void> {
  if (revived === day) return;
  revived = day;
  try {
    const { items } = await listNotices({ limit: 300 });
    for (const n of items) {
      const k = String(n.dedupeKey ?? "");
      const m = /^(\d{4}-\d{2}-\d{2})\|(사이드카|서킷브레이커)\|(.+)\|(발동|해제)$/.exec(k);
      if (!m || m[1] !== day) continue;
      /* 옛 열쇠는 「코스피·코스닥」처럼 묶여 있다 — 풀어서 각각 */
      for (const market of m[3].split("·")) sent.add(`${day}|${m[2]}|${market}|${m[4]}`);
    }
  } catch {
    /* 못 읽어도 아래 알림함 중복막이가 한 겹 더 있다 */
  }
}

/** 기사 발행 시각 `HH:MM` (한국). 못 읽으면 빈 글자 */
function hhmm(at?: string): string {
  if (!at) return "";
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return "";
  return new Date(ms + 9 * 3600_000).toISOString().slice(11, 16);
}

function kstDay(): string {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
}

/** 지나간 일을 적은 제목인가 — 새 발동으로 읽으면 안 된다 */
const PAST = /지난|어제|전날|당시|그날|여파|했던|였던|됐던|복기|돌아보|回顧/;

/**
 * 지금이 사이드카가 걸릴 수 있는 시간인가 — **평일 정규장**(09:00~15:50).
 * 15:30 마감 직후에 오는 해제 기사까지 받으려고 20분 여유를 둔다.
 */
function inSession(): boolean {
  const now = new Date();
  const kst = new Date(now.getTime() + (9 * 60 + now.getTimezoneOffset()) * 60_000);
  if (!isTradingDay(kst)) return false;
  const m = kst.getHours() * 60 + kst.getMinutes();
  return m >= MIN.regularOpen && m <= MIN.regularClose + 20;
}

function parse(title: string): Hit | null {
  const t = title.replace(/\s+/g, " ");
  if (PAST.test(t)) return null;
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
export async function noteMarketHalt(title: string, link?: string, press?: string, at?: string): Promise<void> {
  /* 장 밖에서 온 것은 전부 회고다 — 사이드카·CB 는 정규장에만 걸린다 */
  if (!inSession()) return;
  const hit = parse(title);
  if (!hit) return;
  const day = kstDay();
  if (day !== sentDay) {
    sent.clear();
    sentDay = day;
    revived = "";
  }
  /* 서버가 방금 떴으면 오늘 이미 알린 것을 알림함에서 읽어 온다 */
  await reviveSent(day);
  /* 아직 안 알린 시장만 — 「동반」 기사가 와도 이미 알린 쪽은 다시 안 울린다 */
  const fresh = hit.markets.filter((m) => !sent.has(`${day}|${hit.kind}|${m}|${hit.state}`));
  if (fresh.length === 0) return;

  /*
   * **시장마다 따로** 알린다. 열쇠를 `날짜|종류|한 시장|상태` 로 못 박아야 알림함의
   * 12시간 중복막이가 **재시작 뒤에도** 같은 사건을 알아본다 — 우리 기억은 메모리라
   * 서버가 뜨면 비기 때문이다(위 ① 참조).
   */
  for (const market of fresh) {
    const key = `${day}|${hit.kind}|${market}|${hit.state}`;
    sent.add(key);
    const head = `${[market, hit.side, hit.kind].filter(Boolean).join(" ")} ${hit.state}`;
    const note = await pushNotice({
      kind: "market",
      source: "halt",
      level: hit.state === "발동" ? "warn" : "info",
      title: head,
      /*
       * 제목을 그대로 싣는다 — 우리가 요약하면 「5.74% 하락」 같은 숫자가 사라진다.
       * **기사 시각을 앞에 적는다**(2026-10-15 저녁): 이 알림이 늦게 울린 적이 있어서,
       * 사건 시각과 기사 시각이 다를 수 있다는 것을 읽는 사람이 바로 보게 한다.
       */
      body: `${hhmm(at)}${hhmm(at) ? " 기사 · " : ""}${title}`,
      /*
       * ⚠️ 기사 주소는 `link` 에 안 넣는다 — 그 칸은 **앱 안의 해시 경로**(`#/...`)
       * 전용이라 바깥 주소를 넣으면 눌렀을 때 엉뚱한 데로 간다. 주소는 텔레그램에 싣는다.
       */
      dedupeKey: key,
      dedupeHours: 12,
    });
    /*
     * 알림함에 안 담겼으면(출처를 꺼 뒀거나 이미 알린 사건이면) 텔레그램도 안 보낸다.
     * 한쪽만 막으면 왜 오는지 못 찾는다.
     */
    if (!note) continue;
    /*
     * **울린 김에 잰다** — 더 빠른 길이 있나는 다음 발동 때만 답할 수 있는데, 그때 사람이
     * 깨어 있으리라 기대할 수 없다. 알림이 **나간 뒤에** 부르므로 네이버가 느려도 경보는
     * 제때 울린다. 자세한 까닭은 `haltProbe`.
     */
    void probeHaltSources(key).catch(() => undefined);
    const press2 = press ? ` · ${press}` : "";
    await sendTelegram(
      `<b>⚠️ ${head}</b>\n${title}${press2}${link ? `\n${link}` : ""}`,
      "signal",
    ).catch(() => undefined);
  }
}

/** health.json 「시장경보」 — 오늘 무엇을 알렸나 */
export function marketHaltSnapshot(): { 오늘: string; 알림: string[] } {
  return { 오늘: sentDay, 알림: [...sent] };
}
