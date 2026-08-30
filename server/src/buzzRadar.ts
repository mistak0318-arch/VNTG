import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { KiwoomClient } from "./kiwoomClient.js";
import {
  fetchNewMessages,
  isReaderConfigured,
  type ChannelMessage,
} from "./telegramReader.js";
import { peekSnapshot } from "./marketSnapshot.js";
import { listThemes } from "./customThemes.js";
import { buzzPoints, getBuzzConfig } from "./buzzScore.js";

/**
 * 밤사이 버즈 레이더 (2026-08-27) — **등록 없이도 「갑자기 커진 주제」를 잡는다.**
 *
 * ## 왜 만들었나
 *
 * 트럼프의 對중국 에너지 제재 발표가 밤사이 채널들을 뒤덮었고 다음날 2차전지·ESS 가
 * 급등했는데, 이 시스템은 조용했다. 키워드 알림은 **등록된 낱말만** 보고, AI 선별은
 * 요약이지 「평소보다 얼마나 큰 소리인가」를 재지 않기 때문이다.
 *
 * ## 어떻게 잡나
 *
 * 1) 이미 받아오는 채널 메시지 스트림(fetchNewMessages)에 **카운터만 얹는다** — 조회 0 증가.
 *    사전(내 테마·키움 테마명·전 종목명·이벤트어·개체어)에 매칭해 시간별로 센다.
 * 2) 최근 12시간 언급량을 **지난 7일 하루 평균의 절반(12시간 상당)** 과 비교한다.
 *    평소 4건이던 「ESS」가 밤새 34건이면 그게 버즈다.
 * 3) 강한 버즈는 시그널 방으로 쏘고, 장전 브리핑룸의 「밤사이 버즈」 카드가 전체를 보여 준다.
 *
 * 기준선이 없으면 판정도 없다 — **사흘치가 쌓이기 전에는 발송하지 않는다**
 * (카드에는 「기준선 수집 중」으로 카운트만 보여 준다).
 *
 * 저장: data/buzz/YYYY-MM-DD.json (일별 카운트·시각별·샘플), sent.json (발송 기록).
 */

const here = dirname(fileURLToPath(import.meta.url));
const DIR = join(here, "..", "data", "buzz");
const SENT_FILE = join(DIR, "sent.json");

/*
 * 수집 훅(fetchNewMessages)은 키움 클라이언트를 모른다 — 스케줄러가 시작할 때
 * 여기 묶어 두고, 사전(키움 테마명)만 이걸 쓴다. 없으면 테마명 없이 돈다.
 */
let boundClient: KiwoomClient | null = null;

/** 이벤트 어휘 — 시장을 움직이는 사건의 낱말들. 계속 보태 나간다 */
const EVENT_TERMS = [
  "제재", "관세", "수출통제", "수출규제", "금수", "무역전쟁",
  "규제", "완화", "부양책", "보조금", "감산", "증산",
  "수주", "계약", "공급계약", "증설", "착공", "인수", "합병", "분할", "상장폐지",
  "화재", "폭발", "파업", "리콜", "결함", "해킹", "유출",
  "승인", "허가", "FDA", "임상", "특허",
  "금리인하", "금리인상", "양적완화", "디폴트", "부도", "구조조정",
  "전쟁", "휴전", "미사일", "파병",
];

/** 개체 어휘 — 누가/어디가 움직였나. 이벤트어와 조합돼 맥락이 된다 */
const ENTITY_TERMS = [
  "트럼프", "바이든", "파월", "연준", "백악관",
  "중국", "미국", "일본", "대만", "러시아", "우크라이나", "이란", "인도", "유럽",
  "엔비디아", "테슬라", "애플", "TSMC", "오픈AI",
];

export interface BuzzTerm {
  term: string;
  kind: "theme" | "myTheme" | "stock" | "event" | "entity";
  /** 종목이면 코드, 테마면 대표(첫) 종목 코드들 */
  codes?: string[];
}

interface DayFile {
  /** term → 총 건수 */
  total: Record<string, number>;
  /** term → 시각(0~23, KST) → 건수 */
  byHour: Record<string, Record<string, number>>;
  /** term → 최근 샘플 (트리거 문구로 보여 준다) */
  samples: Record<string, { at: string; channel: string; text: string; link: string }[]>;
  /**
   * term → 갈래. **셀 때 같이 적어 둔다** (2026-08-30).
   *
   * ⚠️ 예전엔 판정할 때마다 **그 순간의 사전**에서 갈래를 찾았고, 못 찾으면 그
   * 낱말을 통째로 버렸다. 그런데 사전의 종목명은 `peekSnapshot()` 에서 오고
   * 키움 테마명은 하루 한 번 받아 온다 — **재시작 직후나 그 호출이 실패한 날에는
   * 사전이 홀쭉해진다.** 그러면 기록은 멀쩡히 쌓이는데 판정에서 전부 탈락해
   * 「한 건도 안 오는」 상태가 된다. 셀 때 적어 두면 나중 사전이 어떻든 살아남는다.
   *
   * 옛 파일에는 이 칸이 없다 — 그때는 예전처럼 사전에서 찾는다.
   */
  kinds?: Record<string, BuzzTerm["kind"]>;
  /** term → 관련 종목코드. 갈래와 같은 이유로 같이 적어 둔다 */
  codes?: Record<string, string[]>;
  /**
   * term → 방 이름 → 건수 (2026-08-30).
   *
   * 「어느 방에서 나온 얘기냐」가 버즈에서 제일 중요한 맥락인데 저장을 안 하고
   * 있었다. 한 방이 같은 말을 열 번 한 것과 열 방이 한 번씩 한 것은 **완전히
   * 다른 사건**이다 — 앞은 그 방의 버릇이고 뒤는 시장의 화제다.
   */
  channels?: Record<string, Record<string, number>>;
  /**
   * 방 이름 → 그 방의 **전체 메시지 수** (2026-08-30).
   *
   * 상투어를 스스로 찾아내려고 둔다. 「투자콤」 방이 글마다 「DS투자증권 투자전략
   * 양형모」라고 적으면, 그 방 글의 90%에 「증권」이 들어간다 — 그건 뉴스가 아니라
   * **그 방의 서명**이다. 분모가 있어야 그 비율을 낼 수 있다.
   */
  channelMsgs?: Record<string, number>;
}

const EMPTY_DAY: DayFile = { total: {}, byHour: {}, samples: {}, kinds: {}, codes: {}, channels: {}, channelMsgs: {} };

function kstNow(): Date {
  return new Date(Date.now() + 9 * 3600_000);
}

function dayStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- 사전

let dict: BuzzTerm[] | null = null;
let dictAt = 0;
let kiwoomThemes: { name: string; codes: string[] }[] = [];
let kiwoomThemesAt = 0;

/** 키움 테마명 — 하루 한 번이면 충분하다 (ka90001 상·하위 등락 목록으로 이름을 모은다) */
async function refreshKiwoomThemes(client: KiwoomClient | null): Promise<void> {
  if (!client) return;
  if (Date.now() - kiwoomThemesAt < 24 * 3600_000) return;
  kiwoomThemesAt = Date.now(); // 실패해도 하루 뒤에 다시 — 매 틱 재시도로 조회를 낭비하지 않는다
  try {
    const common = { qry_tp: "0", stk_cd: "", date_tp: "1", thema_nm: "", stex_tp: "3" };
    const [top, bottom] = await Promise.all([
      client.request<Record<string, unknown>>("/api/dostk/thme", "ka90001", { ...common, flu_pl_amt_tp: "3" }),
      client.request<Record<string, unknown>>("/api/dostk/thme", "ka90001", { ...common, flu_pl_amt_tp: "4" }),
    ]);
    const rows = [
      ...((top.data.thema_grp ?? []) as Record<string, unknown>[]),
      ...((bottom.data.thema_grp ?? []) as Record<string, unknown>[]),
    ];
    const seen = new Map<string, { name: string; codes: string[] }>();
    for (const r of rows) {
      const name = String(r.thema_nm ?? "").trim();
      if (name.length >= 2 && !seen.has(name)) seen.set(name, { name, codes: [] });
    }
    if (seen.size > 0) kiwoomThemes = [...seen.values()];
  } catch {
    /* 테마명 없이도 종목명·이벤트어로 돈다 */
  }
}

/** 사전 구성 — 10분 캐시. 종목명은 스냅샷(캐시)에서, 짧은 이름(2자 이하)은 오탐이라 뺀다 */
/**
 * 사전을 밖에도 내준다 (2026-08-30).
 *
 * [newsKeywords](./newsKeywords.ts) 가 **같은 낱말로** 뉴스를 센다. 사전이 갈리면
 * 「채널에서는 잡혔는데 뉴스에서는 안 잡힌」 것이 진짜 차이인지 사전 차이인지
 * 알 수 없게 된다 — 두 귀를 견주려면 자가 같아야 한다.
 */
export function buzzDictionary(): Promise<BuzzTerm[]> {
  return buildDict();
}

async function buildDict(): Promise<BuzzTerm[]> {
  if (dict && Date.now() - dictAt < 10 * 60_000) return dict;
  await refreshKiwoomThemes(boundClient);
  const out: BuzzTerm[] = [];
  const seen = new Set<string>();
  const add = (t: BuzzTerm) => {
    if (t.term.length < 2 || seen.has(t.term)) return;
    seen.add(t.term);
    out.push(t);
  };

  for (const t of await listThemes().catch(() => []))
    add({ term: t.name, kind: "myTheme", codes: t.codes.slice(0, 5) });
  for (const t of kiwoomThemes) add({ term: t.name, kind: "theme" });
  const snap = peekSnapshot();
  if (snap) {
    for (const [code, row] of snap.byCode) {
      const name = row.name?.trim() ?? "";
      if (name.length >= 3) add({ term: name, kind: "stock", codes: [code] });
    }
  }
  for (const t of EVENT_TERMS) add({ term: t, kind: "event" });
  for (const t of ENTITY_TERMS) add({ term: t, kind: "entity" });

  dict = out;
  dictAt = Date.now();
  return out;
}

// ---------------------------------------------------------------- 서명 걷어내기

/**
 * 채널이 **자기 소속을 밝히는 부분**을 지운다 (2026-08-30).
 *
 * ## 무엇이 문제였나
 *
 * 「증권」이 버즈 상위에 늘 올라왔는데, 실제 문장을 보니 전부 이런 것이었다:
 *
 *     [하나증권 철강금속 박성봉] 철강금속 Weekly…
 *     DS투자증권 투자전략 양형모
 *     [신영증권 자산전략팀] 모닝 브리프
 *
 * **시장이 증권 얘기를 한 게 아니라 채널이 자기 이름을 쓴 것**이다. 이런 게 섞이면
 * 「지금 무슨 얘기가 도나」의 답이 통째로 오염된다.
 *
 * ## 어떻게 지우나
 *
 * 1) **맨 앞 대괄호 묶음** — 「[하나증권 철강금속 박성봉]」. 리서치 글의 관례라
 *    거의 항상 소속·부서·작성자다. 본문이 아니다.
 * 2) **채널 이름에 들어 있는 낱말** — 「하나증권 리서치」 방의 글에서 「하나증권」과
 *    「리서치」를 뺀다. 그 방이 자기 이름을 반복하는 것은 뉴스가 아니다.
 *
 * ⚠️ **다른 회사 이름은 안 지운다.** 하나증권 방이 「삼성증권」을 말하면 그건 진짜
 * 얘깃거리다. 그래서 채널 이름에 든 낱말만 지운다.
 */
export function stripSignature(text: string, channelName: string): string {
  /* ① 맨 앞 대괄호 — 여러 개 붙어 있는 경우도 있다 */
  let out = text.replace(/^\s*(?:[[［【(].{0,40}?[\]］】)]\s*){1,3}/u, "");

  /* ② 채널 이름의 낱말들 — 2자 이상만(한 글자는 아무 데나 걸린다) */
  for (const w of channelName.split(/[\s·・_\-|/[\]()]+/u)) {
    if (w.length < 2) continue;
    out = out.split(w).join(" ");
  }
  return out;
}

// ---------------------------------------------------------------- 카운팅

/** 같은 메시지를 두 번 세지 않기 — 스캔이 20분씩 겹쳐 읽는다. 날짜별 메모리 셋 */
const seenIds = new Map<string, Set<string>>();

async function readDay(day: string): Promise<DayFile> {
  try {
    const j = JSON.parse(await readFile(join(DIR, `${day}.json`), "utf-8")) as DayFile;
    return {
      total: j.total ?? {},
      byHour: j.byHour ?? {},
      samples: j.samples ?? {},
      kinds: j.kinds ?? {},
      codes: j.codes ?? {},
      channels: j.channels ?? {},
      channelMsgs: j.channelMsgs ?? {},
    };
  } catch {
    return { total: {}, byHour: {}, samples: {}, kinds: {}, codes: {}, channels: {}, channelMsgs: {} };
  }
}

let recording = false;

/**
 * 메시지 묶음을 센다 — fetchNewMessages 가 부른다. 실패는 삼킨다(수집이 본업을 막으면 안 된다).
 * 파일은 일별 하나. 동시 호출이 겹치면 한쪽을 버리는 대신 순차화한다(recording).
 */
/**
 * 아직 못 센 메시지들.
 *
 * ⚠️ 예전엔 세는 중이면 `return` 으로 **그 묶음을 통째로 버렸다.** 수집기가 둘이라
 * (majorFeed 5분 · channelScheduler) 겹치는 일이 생기고, 세는 데는 30건마다 이벤트
 * 루프를 양보하느라 시간이 걸린다 — 즉 **셀 것이 많을 때 하필 더 잘 버려졌다.**
 * 버즈가 안 뜨는 이유 중 하나가 이것이다. 버리지 말고 쌓아 뒀다가 이어서 센다.
 */
const queued: ChannelMessage[] = [];

export async function recordBuzz(messages: ChannelMessage[]): Promise<void> {
  if (messages.length > 0) queued.push(...messages);
  if (queued.length === 0 || recording) return;
  recording = true;
  try {
    /* 쌓인 것을 통째로 가져가고 큐를 비운다 — 세는 동안 들어온 것은 다음 판에 */
    messages = queued.splice(0, queued.length);
    const d = await buildDict();
    const today = dayStr(kstNow());
    let ids = seenIds.get(today);
    if (!ids) {
      ids = new Set();
      seenIds.set(today, ids);
      // 어제 셋은 버린다 — 메모리를 하루치만 쓴다
      for (const k of seenIds.keys()) if (k !== today) seenIds.delete(k);
    }

    const fresh = messages.filter((m) => {
      const id = `${m.channelId}_${m.messageId}`;
      if (ids.has(id)) return false;
      ids.add(id);
      return true;
    });
    if (fresh.length === 0) return;

    /*
     * ⚠️ **메시지는 자기 날짜의 파일에 넣는다.**
     *
     * 예전엔 무조건 「오늘」 파일에 넣으면서 시각 버킷만 메시지 시각으로 잡았다.
     * 그래서 어제 23:50 글을 00:05 에 수집하면 **오늘 파일의 23시 칸**에 들어갔고,
     * 창을 되짚는 쪽은 그 시각이면 어제 파일을 보므로 **못 찾았다.** 그리고 그
     * 숫자는 23시간 뒤에 엉뚱하게 세어졌다.
     *
     * 실측(2026-08-30): 40시간에 걸친 40건을 심고 12시간 창을 재니 **24건**이 나왔다.
     * 하필 이 기능의 본 무대가 **자정을 걸치는 밤**이라 그냥 둘 수 없다.
     */
    const files = new Map<string, DayFile>();
    const dayOfMsg = (iso: string) => dayStr(new Date(new Date(iso).getTime() + 9 * 3600_000));
    for (const m of fresh) {
      const day = dayOfMsg(m.at);
      if (!files.has(day)) files.set(day, await readDay(day));
    }
    /*
     * 매칭 비용 통제 — 실측 150건×사전 3,200개 ≈ 84ms (2026-08-27).
     * 평상시 스캔(수십 건)은 한 번에 끝나지만, 첫 소급 수집처럼 수백~수천 건이
     * 몰리면 초 단위로 이벤트 루프를 막아 **다른 API 응답까지 세운다.**
     * 30건마다 루프를 양보하고, 본문은 앞 600자만 본다(핵심은 앞에 있다).
     */
    let processed = 0;
    for (const m of fresh) {
      processed += 1;
      if (processed % 30 === 0) await new Promise((r) => setImmediate(r));
      /* 서명·머리말을 걷어낸 뒤 센다 — 「[하나증권 …]」의 「증권」이 시장 얘기로 잡히면 안 된다 */
      const text = stripSignature(m.text, m.channelName).slice(0, 600);
      const kst = new Date(new Date(m.at).getTime() + 9 * 3600_000);
      const hour = String(kst.getUTCHours());
      /* 그 메시지가 속한 날 파일 — 자정을 걸친 수집에서 이게 갈린다 */
      const file = files.get(dayStr(kst));
      if (!file) continue;
      /* 상투어 판정의 분모 — 낱말이 걸리든 말든 그 방의 글 수는 센다 */
      (file.channelMsgs ??= {})[m.channelName] = (file.channelMsgs?.[m.channelName] ?? 0) + 1;
      for (const t of d) {
        if (!text.includes(t.term)) continue;
        file.total[t.term] = (file.total[t.term] ?? 0) + 1;
        /* 갈래·코드를 **셀 때** 적어 둔다 — 나중 사전이 홀쭉해져도 살아남게 */
        (file.kinds ??= {})[t.term] = t.kind;
        if (t.codes?.length) (file.codes ??= {})[t.term] = t.codes;
        const bh = (file.byHour[t.term] = file.byHour[t.term] ?? {});
        bh[hour] = (bh[hour] ?? 0) + 1;
        /* 어느 방이 말했나 — 「한 방이 열 번」과 「열 방이 한 번씩」은 다른 사건이다 */
        const bc = ((file.channels ??= {})[t.term] ??= {});
        bc[m.channelName] = (bc[m.channelName] ?? 0) + 1;

        const samples = (file.samples[t.term] = file.samples[t.term] ?? []);
        samples.unshift({
          at: m.at,
          channel: m.channelName,
          /*
           * **원문을 거의 그대로 남긴다** (2026-08-31 요청 — 「원문보기하면 미니창에
           * 원문만으로도 볼 수 있고, 텔레그램 막혀 있는 회사에서는 좋은 구조」).
           *
           * 240자였을 때는 두세 줄에서 잘려 「원문」이라 부를 수 없었다. 텔레그램에서
           * 가져오는 것은 **글자뿐**이라 늘려도 부담이 작다 — 실측으로 버즈 30일치가
           * 0.05MB 였다. 수집 단계에서 이미 600자로 자르므로 여기서는 그대로 담는다.
           */
          text: text.replace(/\s+/g, " "),
          link: m.link,
        });
        /*
         * 한 낱말에 남기는 글 수. 알림 카드는 2개면 되지만 **원문 보기**는 「그 방들이
         * 무슨 이야기를 했나」를 읽는 자리라 훨씬 많이 남긴다. 낱말 하나가 하루에
         * 40번 언급됐는데 12개만 보이면 그날의 절반을 못 본다.
         */
        if (samples.length > 40) samples.length = 40;
      }
    }
    await mkdir(DIR, { recursive: true });
    for (const [day, f] of files) {
      await writeFile(join(DIR, `${day}.json`), JSON.stringify(f), "utf-8");
    }
  } catch {
    /* 버즈 기록 실패가 수집을 막으면 안 된다 */
  } finally {
    recording = false;
    /* 세는 동안 새로 들어온 것이 있으면 이어서 — 큐에 남겨 두면 영영 안 세진다 */
    if (queued.length > 0) void recordBuzz([]);
  }
}

// ---------------------------------------------------------------- 판정

export interface BuzzHit {
  term: string;
  kind: BuzzTerm["kind"];
  /** 최근 12시간 건수 */
  recent: number;
  /** 지난 7일 12시간 상당 평균 */
  baseline: number;
  /** recent / baseline — 몇 배로 커졌나 */
  ratio: number;
  codes: string[];
  /** `full` 은 주요 채널 아카이브에서 전문을 찾아 바꿔 넣었다는 표시 (2026-08-31) */
  samples: { at: string; channel: string; text: string; link: string; full?: boolean }[];
}

export interface BuzzResult {
  hits: BuzzHit[];
  /**
   * 지금 살아 있나 (2026-08-27) — 「아무것도 안 온다」가 **고장인지 조용한 것인지**를
   * 가르는 값들. 화면이 그대로 보여 준다.
   */
  health: {
    /** 텔레그램 사용자 세션이 있나 (없으면 수집 자체가 불가) */
    reader: boolean;
    /** 오늘 센 메시지 매칭 수 */
    todayCount: number;
    /** 카운트가 있는 날 수(오늘 포함) */
    days: number;
    /** 마지막으로 스스로 훑은 시각 */
    lastCollect: string | null;
    /** 발송 문턱을 넘으려면 며칠 더 필요한가 */
    needDays: number;
  };
  /** 기준선으로 쓴 지난 날 수 — 3 미만이면 아직 판정하지 않는다 */
  baselineDays: number;
  /** 기준선이 모자랄 때도 「지금 많이 말해지는 것」은 보여 준다 */
  topToday: { term: string; kind: BuzzTerm["kind"]; recent: number }[];
  /**
   * 문턱에 못 미친 것들 (2026-08-30).
   *
   * 「한 건도 안 온다」가 **조용한 것인지 문턱이 안 닿는 것인지**를 가른다.
   * 아깝게 놓친 것이 줄줄이 있으면 문턱이 높은 것이고, 여기도 비어 있으면
   * 정말로 조용한 것이다. 화면이 이걸 그대로 보여 준다.
   */
  nearMiss: BuzzHit[];
  /** 지금 걸려 있는 문턱 — 화면이 「몇 건 넘어야 하는지」를 말할 수 있게 */
  threshold: { minCount: number; minRatio: number; sharpCount: number; sharpRatio: number };
  windowHours: number;
  at: string;
}

/** 최근 windowHours 시간의 건수 — 오늘·어제 파일의 시각 버킷에서 모은다 */
/*
 * 발송 문턱. 화면이 이 값을 그대로 보여 주므로 여기 한 곳만 고치면 된다 —
 * 「왜 안 오나」를 묻는 사람에게 「6건 넘어야 하는데 지금 제일 큰 게 4건」이라고
 * 답할 수 있어야 한다.
 */
const MIN_COUNT = 6;
const MIN_RATIO = 3;
/** 적지만 아주 날카롭게 뛴 것 */
const SHARP_COUNT = 3;
const SHARP_RATIO = 8;

/**
 * 창 안의 언급 수.
 *
 * ⚠️ 예전엔 `today`·`yesterday` 둘만 받고 「오늘이 아니면 어제」로 갈랐다. 창이
 * 24시간을 넘으면 그저께 시각까지 **어제 파일에서** 찾아 같은 숫자를 두 번 셌다.
 * 날짜→파일 지도를 받아 몇 시간짜리 창이든 제 날 파일에서 찾는다.
 */
function recentCount(term: string, files: Map<string, DayFile>, windowHours: number): number {
  const now = kstNow();
  let sum = 0;
  for (let i = 0; i < windowHours; i += 1) {
    const t = new Date(now.getTime() - i * 3600_000);
    sum += files.get(dayStr(t))?.byHour[term]?.[String(t.getUTCHours())] ?? 0;
  }
  return sum;
}

/**
 * 시간대 보정 — 창이 걸친 시각들이 하루의 몇 %인가.
 *
 * 채널도 하루 내내 고르게 떠들지 않는다. 새벽 3시는 조용하고 아침 8시는 시끄럽다.
 * 그런데 기준선을 `하루평균 × (창/24)` 로 잡으면 **새벽에는 뭐든 급증으로 보이고
 * 아침에는 평범한 것이 급증으로 보인다.**
 *
 * 지난 날들의 **시각별 매칭 분포**로 환산한다. 관측이 없는 시각에서 0 이 되지
 * 않도록 균등 가정과 7:3 으로 섞는다(뉴스 쪽과 같은 이유).
 */
function hourShare(pastDays: DayFile[], windowHours: number, useTimeOfDay: boolean): number {
  const flat = windowHours / 24;
  if (!useTimeOfDay) return flat;

  const perHour = new Array(24).fill(0);
  let all = 0;
  for (const f of pastDays) {
    for (const mins of Object.values(f.byHour)) {
      for (const [h, c] of Object.entries(mins)) {
        const hi = Number(h);
        if (hi >= 0 && hi < 24) {
          perHour[hi] += c;
          all += c;
        }
      }
    }
  }
  if (all < 50) return flat; // 표본이 모자라면 균등 가정이 낫다

  const now = kstNow();
  let inWindow = 0;
  for (let i = 0; i < windowHours; i += 1) {
    inWindow += perHour[new Date(now.getTime() - i * 3600_000).getUTCHours()];
  }
  return 0.7 * (inWindow / all) + 0.3 * flat;
}

/**
 * 그 방의 **상투어**인가 — 스스로 찾아낸다 (2026-08-30).
 *
 * 「[하나증권 …]」 같은 머리말은 `stripSignature` 가 걷어 내지만, 문장 **중간**에
 * 박힌 서명은 못 잡는다(「9월 증시 전망 코멘트 DS투자증권 투자전략 양형모 …」 —
 * 방 이름이 「투자콤」이라 채널명 규칙에도 안 걸린다).
 *
 * 그래서 규칙 대신 **빈도로 판별한다**: 어떤 낱말이 그 방 글의 절반을 넘게 나오면,
 * 그건 화제가 아니라 그 방의 버릇이다. 사람이 목록을 관리할 필요가 없고, 새 방이
 * 늘어도 저절로 맞는다.
 *
 * ⚠️ 글이 적은 방은 판단하지 않는다 — 세 글 중 두 글에 나왔다고 상투어라 할 수 없다.
 *
 * 돌려주는 값은 **버릴 몫**(0~1)이다. 그 방들이 차지한 비율만큼 건수를 깎는다.
 * 방별 시각 기록까지 두면 정확히 뺄 수 있지만 저장이 몇 배로 커진다 — 비율로
 * 깎는 것이 어림이지만 충분하고, 어림이라는 것을 여기 적어 둔다.
 */
const BOILER_SHARE = 0.5;
const BOILER_MIN_MSGS = 8;

function boilerplateDiscount(
  term: string,
  files: Map<string, DayFile>,
): { drop: number; realChannels: Set<string> } {
  const said = new Map<string, number>(); // 방 → 이 낱말을 쓴 글 수
  const wrote = new Map<string, number>(); // 방 → 전체 글 수
  for (const f of files.values()) {
    for (const [ch, n] of Object.entries(f.channels?.[term] ?? {})) {
      said.set(ch, (said.get(ch) ?? 0) + n);
    }
    for (const [ch, n] of Object.entries(f.channelMsgs ?? {})) {
      wrote.set(ch, (wrote.get(ch) ?? 0) + n);
    }
  }

  let total = 0;
  let boiler = 0;
  const realChannels = new Set<string>();
  for (const [ch, n] of said) {
    total += n;
    const all = wrote.get(ch) ?? 0;
    if (all >= BOILER_MIN_MSGS && n / all >= BOILER_SHARE) boiler += n;
    else realChannels.add(ch);
  }
  return { drop: total > 0 ? boiler / total : 0, realChannels };
}

/** 창이 닿는 날들을 한 번에 읽어 둔다 */
async function windowFiles(windowHours: number): Promise<Map<string, DayFile>> {
  const now = kstNow();
  const out = new Map<string, DayFile>();
  for (let i = 0; i <= Math.ceil(windowHours / 24); i += 1) {
    const day = dayStr(new Date(now.getTime() - i * 86400_000));
    if (!out.has(day)) out.set(day, await readDay(day));
  }
  return out;
}

export async function evaluateBuzz(windowHours = 12): Promise<BuzzResult> {
  const d = await buildDict();
  const kindOf = new Map(d.map((t) => [t.term, t]));
  const now = kstNow();
  const winFiles = await windowFiles(windowHours);
  const today = winFiles.get(dayStr(now)) ?? EMPTY_DAY;
  const yesterday = winFiles.get(dayStr(new Date(now.getTime() - 86400_000))) ?? EMPTY_DAY;

  /* 기준선 — 지난 7일(오늘 제외) 총 건수의 하루 평균 ÷ 2 (12시간 상당) */
  const pastDays: DayFile[] = [];
  for (let i = 1; i <= 7; i += 1) {
    const day = dayStr(new Date(now.getTime() - i * 86400_000));
    const f = await readDay(day);
    if (Object.keys(f.total).length > 0) pastDays.push(f);
  }
  const baselineDays = pastDays.length;

  /* 지금 창에서 한 번이라도 언급된 항목만 후보로 — 사전 전체를 돌 필요가 없다 */
  const candidates = new Set<string>([...Object.keys(today.total), ...Object.keys(yesterday.total)]);
  const hits: BuzzHit[] = [];
  const topToday: { term: string; kind: BuzzTerm["kind"]; recent: number }[] = [];

  /** 문턱에 못 미친 것들 — 「왜 안 오나」를 답하려면 이게 있어야 한다 */
  const nearMiss: BuzzHit[] = [];

  for (const term of candidates) {
    /*
     * 갈래는 **기록해 둔 것을 먼저** 본다. 사전은 그때그때 홀쭉해질 수 있고,
     * 예전에는 그때 이 줄에서 낱말이 통째로 사라졌다(위 DayFile.kinds 주석 참고).
     */
    const storedKind = today.kinds?.[term] ?? yesterday.kinds?.[term];
    const info = kindOf.get(term);
    const kind = storedKind ?? info?.kind;
    if (!kind) continue;
    const codes = info?.codes ?? today.codes?.[term] ?? yesterday.codes?.[term] ?? [];

    const recent = recentCount(term, winFiles, windowHours);
    if (recent === 0) continue;
    topToday.push({ term, kind, recent });
    if (baselineDays < 3) continue; // 기준선이 서기 전에는 판정하지 않는다

    const avgDaily = pastDays.reduce((a, f) => a + (f.total[term] ?? 0), 0) / baselineDays;
    const baseline = Math.max(avgDaily * (windowHours / 24), 0.5);
    const ratio = recent / baseline;
    const hit: BuzzHit = {
      term,
      kind,
      recent,
      baseline: Math.round(baseline * 10) / 10,
      ratio: Math.round(ratio * 10) / 10,
      codes,
      samples: (today.samples[term] ?? yesterday.samples[term] ?? []).slice(0, 2),
    };

    /*
     * 문턱 — 절대량과 배수를 같이 본다. 평소 0건이던 게 2건 온 것까지 울리면 소음이 된다.
     *
     * 두 갈래를 둔다 (2026-08-30):
     *   ① 넉넉히 많고 꽤 커진 것       6건 이상 · 3배 이상
     *   ② 적지만 **아주 날카롭게** 뛴 것 3건 이상 · 8배 이상
     *
     * ②를 더한 이유: 따라 보는 채널이 적으면 12시간에 6건을 넘기는 낱말 자체가
     * 드물다. 평소 0.4건이던 게 3건이면 그건 분명한 사건인데 ①만으로는 영영 안 걸린다.
     * 배수를 높게 잡아 소음은 막는다.
     */
    if ((recent >= MIN_COUNT && ratio >= MIN_RATIO) || (recent >= SHARP_COUNT && ratio >= SHARP_RATIO)) {
      hits.push(hit);
    } else if (recent >= 2) {
      nearMiss.push(hit);
    }
  }
  nearMiss.sort((a, b) => b.ratio - a.ratio);

  hits.sort((a, b) => b.ratio - a.ratio);
  topToday.sort((a, b) => b.recent - a.recent);
  const todayCount = Object.values(today.total).reduce((a, b) => a + b, 0);
  return {
    health: {
      reader: isReaderConfigured(),
      todayCount,
      days: baselineDays + (todayCount > 0 ? 1 : 0),
      lastCollect: lastCollectAt > 0 ? new Date(lastCollectAt).toISOString() : null,
      needDays: Math.max(0, 3 - baselineDays),
    },
    hits: hits.slice(0, 12),
    baselineDays,
    topToday: topToday.slice(0, 10),
    nearMiss: nearMiss.slice(0, 8),
    threshold: {
      minCount: MIN_COUNT,
      minRatio: MIN_RATIO,
      sharpCount: SHARP_COUNT,
      sharpRatio: SHARP_RATIO,
    },
    windowHours,
    at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------- 발송 스케줄러

async function readSent(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(SENT_FILE, "utf-8")) as Record<string, string>;
  } catch {
    return {};
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

/**
 * ⚠️ **스스로도 모은다** (2026-08-27 수리).
 *
 * 처음엔 카운터를 다른 수집(키워드 알림·채널 정리·주요 채널)에 얹기만 했다. 그런데
 * 그것들은 **저마다 꺼질 수 있다** — 키워드 알림을 안 켰고 주요 채널도 안 골랐으면
 * 하루 세 번(07/12/18시 정리) 말고는 아무것도 안 쌓인다. 그래서 「버즈가 안 온다」가
 * 된다. 기준선은 며칠 치 카운트인데 그 카운트가 안 생기니 영영 판정이 안 선다.
 *
 * 45분 넘게 아무것도 안 쌓였으면 **직접 훑는다**. 다른 수집이 돌고 있으면 그대로
 * 얹혀 가고(중복은 메시지 id 로 걸린다), 아무도 안 돌면 이쪽이 채운다.
 * 오프셋은 안 건드린다(useOffsets:false) — 정기 발행이 빈 채로 나가면 안 된다.
 */
let lastCollectAt = 0;

async function collectIfStale(): Promise<void> {
  if (!isReaderConfigured()) return;
  if (Date.now() - lastCollectAt < 45 * 60_000) return;
  lastCollectAt = Date.now();
  try {
    /* 카운트는 fetchNewMessages 안의 훅(recordBuzz)이 알아서 한다 */
    await fetchNewMessages({ sinceMinutes: 60, useOffsets: false, maxPerChannel: 30 });
  } catch (err) {
    console.error("[buzz] 수집 실패:", err instanceof Error ? err.message : err);
  }
}

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    await collectIfStale();
    const result = await evaluateBuzz();
    if (result.hits.length === 0) return;

    const sent = await readSent();
    const today = dayStr(kstNow());
    /* 아주 강한 것만 쏜다 — 카드는 12개를 보여 주지만 방을 울리는 건 하루 몇 번이어야 한다 */
    const strong = result.hits.filter((h) => h.recent >= 10 && h.ratio >= 4);
    const fresh = strong.filter((h) => !sent[`${today}|${h.term}`]);
    if (fresh.length === 0) return;

    const { sendTelegram } = await import("./telegram.js");
    for (const h of fresh.slice(0, 3)) {
      const codeNote =
        h.codes.length > 0 && h.kind === "myTheme" ? `\n관련: 내 테마 구성 ${h.codes.length}종목` : "";
      const sample = h.samples[0]
        ? `\n트리거: ${h.samples[0].text.slice(0, 80)} (${h.samples[0].channel})`
        : "";
      const msg =
        `🌋 <b>버즈 감지 — ${h.term}</b>\n` +
        `최근 ${result.windowHours}시간 <b>${h.recent}건</b> (평소 ${h.baseline}건 · ${h.ratio}배)` +
        codeNote +
        sample +
        `\n\n장전 브리핑룸의 「밤사이 버즈」에서 전체를 보세요.`;
      await sendTelegram(msg, "buzz").catch(() => undefined);
      sent[`${today}|${h.term}`] = new Date().toISOString();
    }
    /* 발송 기록은 30일만 */
    const cutoff = dayStr(new Date(Date.now() - 30 * 86400_000 + 9 * 3600_000));
    for (const k of Object.keys(sent)) if (k.slice(0, 10) < cutoff) delete sent[k];
    await mkdir(DIR, { recursive: true });
    await writeFile(SENT_FILE, JSON.stringify(sent, null, 2), "utf-8");

    /* 버즈 일별 파일도 30일 지나면 정리 */
    for (const f of await readdir(DIR).catch(() => [] as string[])) {
      if (/^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f.slice(0, 10) < cutoff) {
        await unlink(join(DIR, f)).catch(() => undefined);
      }
    }
  } catch (err) {
    console.error("[buzz] 판정 실패:", err instanceof Error ? err.message : err);
  } finally {
    ticking = false;
  }
}

/* ── 대시보드 (2026-08-30) ───────────────────────────────────────────────
 *
 * 「데이터는 들어오는데 자세한 걸 볼 데가 없다」 — 맞는 지적이었다. 텔레그램
 * 알림은 「장전 브리핑룸에서 보세요」라고 하고, 그 카드는 요약 세 줄이 전부라
 * **서로를 가리키기만 하고 아무도 자세히 보여 주지 않았다.**
 *
 * 두 가지를 새로 낸다:
 *
 *   buzzBoard  — 문턱과 **무관하게** 창 안에서 언급된 것을 전부. 알림 문턱은
 *                「울릴 것」을 고르는 값이지 「볼 것」을 고르는 값이 아니다.
 *                문턱 아래도 봐야 「지금 조용한 게 맞나」를 사람이 판단한다.
 *   buzzTerm   — 낱말 하나의 속사정. 시간대별·날짜별 흐름, 어느 방이 말했나,
 *                실제 문장들.
 */

export interface BuzzBoardRow {
  term: string;
  kind: BuzzTerm["kind"];
  recent: number;
  baseline: number;
  ratio: number;
  /** 몇 개의 방에서 나왔나 — 한 방이 떠드는 것과 여러 방이 말하는 것은 다르다 */
  channels: number;
  /** 뜻밖의 정도 — (지금-평소)/√(평소+1). 정렬과 판정의 기준 */
  z: number;
  /** 채널 서명으로 판정해 깎은 몫(0~1). 0.8 이면 언급의 80%가 그 방들의 버릇이었다 */
  boilerplate: number;
  /** 알림 문턱을 넘었나 */
  alerted: boolean;
  codes: string[];
}

export interface BuzzBoard {
  windowHours: number;
  baselineDays: number;
  rows: BuzzBoardRow[];
  /** 창 안 총 매칭 수 — 「지금 시끄러운가」 */
  total: number;
  /** 시각별 총 매칭 (0~23시) — 흐름 띠 */
  byHour: { hour: number; count: number }[];
  threshold: { minCount: number; minRatio: number; sharpCount: number; sharpRatio: number };
  reader: boolean;
  at: string;
}

export async function buzzBoard(windowHours = 12): Promise<BuzzBoard> {
  const win = Math.min(48, Math.max(1, Math.round(windowHours)));
  const now = kstNow();
  const winFiles = await windowFiles(win);
  const today = winFiles.get(dayStr(now)) ?? EMPTY_DAY;
  const yesterday = winFiles.get(dayStr(new Date(now.getTime() - 86400_000))) ?? EMPTY_DAY;

  const cfg = await getBuzzConfig();
  const pastDays: DayFile[] = [];
  for (let i = 1; i <= cfg.baselineDays; i += 1) {
    const f = await readDay(dayStr(new Date(now.getTime() - i * 86400_000)));
    if (Object.keys(f.total).length > 0) pastDays.push(f);
  }
  const baselineDays = pastDays.length;
  /* 하루평균을 이 창 몫으로 환산 — 시간대 쏠림을 반영한다 */
  const share = hourShare(pastDays, win, cfg.timeOfDay);

  const candidates = new Set<string>([...Object.keys(today.total), ...Object.keys(yesterday.total)]);
  const d = await buildDict();
  const kindOf = new Map(d.map((t) => [t.term, t]));

  const rows: BuzzBoardRow[] = [];
  let total = 0;
  const hourly = new Map<number, number>();

  for (const term of candidates) {
    const kind = today.kinds?.[term] ?? yesterday.kinds?.[term] ?? kindOf.get(term)?.kind;
    if (!kind) continue;
    const recent = recentCount(term, winFiles, win);
    if (recent === 0) continue;
    total += recent;

    /* 시각별 합 — 창 안의 시각만 */
    for (let i = 0; i < win; i += 1) {
      const t = new Date(now.getTime() - i * 3600_000);
      const file = dayStr(t) === dayStr(now) ? today : yesterday;
      const h = t.getUTCHours();
      const c = file.byHour[term]?.[String(h)] ?? 0;
      if (c > 0) hourly.set(h, (hourly.get(h) ?? 0) + c);
    }

    const avgDaily =
      baselineDays > 0 ? pastDays.reduce((a, f) => a + (f.total[term] ?? 0), 0) / baselineDays : 0;
    const baseline = Math.max(avgDaily * share, 0.5);
    /*
     * 그 방들의 서명이면 깎는다 — 「증권」이 상위에 오던 이유가 이것이었다.
     * 방 개수도 서명 아닌 방만 센다(서명 방이 셋이라고 화제가 세 곳에서 난 게 아니다).
     */
    const { drop, realChannels } = boilerplateDiscount(term, winFiles);
    const adjusted = Math.round(recent * (1 - drop));
    const ratio = adjusted / baseline;
    const { z, alert } = buzzPoints(adjusted, baseline, realChannels.size, cfg);

    rows.push({
      term,
      kind,
      recent: adjusted,
      baseline: Math.round(baseline * 10) / 10,
      ratio: Math.round(ratio * 10) / 10,
      z: Math.round(z * 100) / 100,
      channels: realChannels.size,
      /* 서명으로 판정해 버린 몫 — 화면이 「왜 줄었나」를 말할 수 있게 */
      boilerplate: Math.round(drop * 100) / 100,
      alerted: baselineDays >= 3 && alert,
      codes: kindOf.get(term)?.codes ?? today.codes?.[term] ?? yesterday.codes?.[term] ?? [],
    });
  }

  /* 기준선이 없으면 배율이 무의미하므로 건수로, 있으면 배율로 줄 세운다 */
  /* 기준선이 서기 전엔 배율이 무의미하므로 건수로, 서면 **뜻밖의 정도**로 */
  rows.sort((a, b) => (baselineDays >= 2 ? b.z - a.z : b.recent - a.recent));

  return {
    windowHours: win,
    baselineDays,
    rows: rows.slice(0, 120),
    total,
    byHour: [...hourly.entries()].sort((a, b) => a[0] - b[0]).map(([hour, count]) => ({ hour, count })),
    threshold: {
      minCount: MIN_COUNT,
      minRatio: MIN_RATIO,
      sharpCount: SHARP_COUNT,
      sharpRatio: SHARP_RATIO,
    },
    reader: isReaderConfigured(),
    at: new Date().toISOString(),
  };
}

export interface BuzzTermDetail {
  term: string;
  kind: BuzzTerm["kind"] | null;
  codes: string[];
  /** 48시간 시간대별 — 언제 터졌나 */
  hourly: { at: string; count: number }[];
  /** 날짜별 총합(최근 14일) — 평소가 어땠나 */
  daily: { day: string; count: number }[];
  /** 어느 방이 얼마나 */
  channels: { name: string; count: number }[];
  /** 실제 문장들 */
  samples: { at: string; channel: string; text: string; link: string }[];
}

export async function buzzTerm(term: string): Promise<BuzzTermDetail> {
  const now = kstNow();
  const days: { day: string; file: DayFile }[] = [];
  for (let i = 0; i < 14; i += 1) {
    const day = dayStr(new Date(now.getTime() - i * 86400_000));
    days.push({ day, file: await readDay(day) });
  }
  const byDay = new Map(days.map((x) => [x.day, x.file]));

  /* 48시간을 한 시간씩 되짚는다 — 「언제부터 커졌나」가 이 그림의 요점이다 */
  const hourly: { at: string; count: number }[] = [];
  for (let i = 47; i >= 0; i -= 1) {
    const t = new Date(now.getTime() - i * 3600_000);
    const f = byDay.get(dayStr(t));
    hourly.push({
      at: `${dayStr(t)}T${String(t.getUTCHours()).padStart(2, "0")}`,
      count: f?.byHour[term]?.[String(t.getUTCHours())] ?? 0,
    });
  }

  const daily = days
    .map((x) => ({ day: x.day, count: x.file.total[term] ?? 0 }))
    .reverse();

  /* 방 목록·표본은 오늘과 어제를 합친다 — 밤사이 버즈는 자정을 걸치는 일이 잦다 */
  const chMap = new Map<string, number>();
  for (const d of days.slice(0, 2)) {
    for (const [name, c] of Object.entries(d.file.channels?.[term] ?? {})) {
      chMap.set(name, (chMap.get(name) ?? 0) + c);
    }
  }
  const samples = [...(days[0].file.samples[term] ?? []), ...(days[1]?.file.samples[term] ?? [])]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 16);

  return {
    term,
    kind: days[0].file.kinds?.[term] ?? days[1]?.file.kinds?.[term] ?? null,
    codes: days[0].file.codes?.[term] ?? days[1]?.file.codes?.[term] ?? [],
    hourly,
    daily,
    channels: [...chMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count })),
    samples,
  };
}

export function startBuzzScheduler(client: KiwoomClient): void {
  if (timer) return;
  boundClient = client;
  setTimeout(() => void tick(), 3 * 60_000); // 수집이 한 바퀴 돈 뒤에
  timer = setInterval(() => void tick(), 30 * 60_000);
  console.log("[buzz] 버즈 레이더 시작 (30분 주기 판정 · 기준선 3일 후 발송)");
}
