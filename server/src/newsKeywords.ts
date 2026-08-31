import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { naverNews, type NaverCat } from "./naverMainNews.js";
import { buzzDictionary, type BuzzTerm } from "./buzzRadar.js";
import { peekSnapshot } from "./marketSnapshot.js";
import { buzzPoints, getBuzzConfig } from "./buzzScore.js";
import { isEnabled, markRun, periodOverrideMs } from "./naverSyncConfig.js";

/**
 * 뉴스 키워드 흐름 (2026-08-30 요청).
 *
 * ## 무엇을 재나 — **빈도가 아니라 가속도**
 *
 * 「증시 뉴스에 제일 많이 나온 낱말」을 세면 답은 늘 같다. 삼성전자, 코스피, 금리.
 * 매일 1등이라 아무것도 알려 주지 않는다. 그리고 종목명 빈도 1위는 대개 **이미
 * 오른 종목**이라, 그걸 보고 들어가면 늦는다. 벤티지가 「증시쪽만 잡으면 편향적일
 * 것 같다」고 한 게 정확히 이 지점이다.
 *
 * 그래서 여기서 세는 것은 **평소 대비 얼마나 갑자기 커졌나**다. 평소 하루 2번
 * 나오던 「전력기기」가 한 시간에 9번 나오면 그게 사건이다.
 *
 * ## 두 귀를 나란히 — 버즈 레이더와 중복이 아닌 이유
 *
 * [buzzRadar](./buzzRadar.ts) 는 **텔레그램 채널**에 같은 계산을 한다. 둘은 편향
 * 방향이 **반대**다:
 *
 *   뉴스   — 공식적이고 느리다. 이미 벌어진 뒤에 쓴다. 대신 헛소문이 적다.
 *   채널   — 빠르고 투기적이다. 먼저 말한다. 대신 아무 말이나 한다.
 *
 * 한쪽만 보면 각자의 편향을 그대로 먹는다. **둘 다 급증한 키워드**는 「빠른 쪽이
 * 먼저 말했고 느린 쪽이 확인해 준」 것이라 질이 다르다. 그래서 사전을 공유하고,
 * 화면에서 둘을 나란히 보여 준다.
 *
 * ## 아는 낱말만 세면 아는 것만 보인다
 *
 * 사전 매칭만 하면 **내가 이미 등록한 테마와 종목명**만 잡힌다. 정작 값진 것은
 * 「어제까지 아무도 안 쓰던 말이 오늘 갑자기」인데 그건 사전에 없다. 그래서
 * 사전 매칭 옆에 **신규어 발굴**을 같이 돌린다(아래 `harvest`).
 *
 * ## 시각은 **발행 시각**을 쓴다
 *
 * 수집은 몇 분에 한 번 하지만, 기사마다 발행 시각(`at`)이 붙어 온다. 그래서
 * **1분 단위 버킷**이 수집 주기와 무관하게 정확하다 — 3분마다 긁어도 「10:31에
 * 3건, 10:32에 1건」이 그대로 남는다.
 *
 * 저장: data/newsKeywords/YYYY-MM-DD.json
 */

const here = dirname(fileURLToPath(import.meta.url));
const DIR = join(here, "..", "data", "newsKeywords");

/** 긁는 갈래 — 네이버 증권 뉴스의 전부 */
const CATS: NaverCat[] = ["main", "flash", "market", "company", "world", "estate"];

/** 며칠치를 남기나. 기준선은 7일이면 충분하고, 그 이상은 디스크만 먹는다 */
const KEEP_DAYS = 14;

export type TermKind = BuzzTerm["kind"] | "new";

interface DayFile {
  /** term → 분(YYYY-MM-DDTHH:mm) → 건수 */
  byMinute: Record<string, Record<string, number>>;
  /**
   * 분 → **기사 수**.
   *
   * ⚠️ byMinute 를 다 더하면 기사 수가 아니라 **낱말 매칭 수**다. 기사 하나가
   * 스무 낱말에 걸리면 스물로 세진다. 실측에서 「창 안 기사 166건」이라고 떴는데
   * 실제 기사는 그 몇 분의 일이었다. 화면이 거짓말을 하면 표본이 적은지 많은지를
   * 판단할 수 없으므로 따로 센다.
   */
  articlesByMinute: Record<string, number>;
  /** term → 종류 */
  kinds: Record<string, TermKind>;
  /** term → 관련 종목코드 (테마·종목만) */
  codes: Record<string, string[]>;
  /**
   * term → 언론사 → 건수 (2026-08-30).
   *
   * 같은 기사가 열 매체로 퍼지면 건수만 열 배가 된다 — 그건 열 개의 사건이 아니라
   * **한 사건이 열 번 복사된 것**이다. 매체 수를 같이 세면 그 둘이 갈린다.
   */
  presses?: Record<string, Record<string, number>>;
  /** term → 최근 기사 표본 (제목·링크·매체·시각) */
  samples: Record<
    string,
    {
      title: string;
      link: string;
      press: string;
      at: string;
      /**
       * 제목에서 걸렸나 (2026-08-31).
       *
       * 사전 매칭은 **제목 + 요약**을 본다(요약에만 나오는 이름이 꽤 있다). 그런데
       * 화면은 제목만 보여 주므로, 요약에서 걸린 기사는 **왜 여기 있는지 알 수가
       * 없다** — 「증권」을 눌렀더니 「정은보 이사장 뉴욕 출국」이 나오는 식이었다.
       *
       * 어디서 걸렸는지 남겨 두면 화면이 그렇게 말할 수 있고, 제목에서 걸린 것을
       * 앞에 세울 수도 있다.
       */
      inTitle?: boolean;
    }[]
  >;
  /**
   * 이미 센 기사 — 같은 기사를 두 번 세지 않는다.
   *
   * ⚠️ 예전엔 **링크만** 봤다. 그런데 같은 기사가 여러 갈래(주요뉴스·시황·기업)에
   * 실리면서 **링크가 다르게** 오는 일이 있다. 그러면 한 기사가 여섯 번 세어져
   * 배율이 통째로 부푼다 — 실제로 「원·달러, 올 들어 최저 수준」이 같은 시각에
   * 여섯 번 잡혔다. 그래서 **제목+매체**도 열쇠로 같이 쓴다.
   */
  seen: string[];
}

function emptyDay(): DayFile {
  return { byMinute: {}, articlesByMinute: {}, kinds: {}, codes: {}, presses: {}, samples: {}, seen: [] };
}

function dayOf(iso: string): string {
  return iso.slice(0, 10);
}
/** 「2026-08-30T10:31」 — 초는 버린다. 분이 우리가 보는 제일 작은 단위다 */
function minuteOf(iso: string): string {
  return iso.slice(0, 16);
}

async function readDay(day: string): Promise<DayFile> {
  try {
    const j = JSON.parse(await readFile(join(DIR, `${day}.json`), "utf-8")) as Partial<DayFile>;
    return { ...emptyDay(), ...j };
  } catch {
    return emptyDay();
  }
}

async function writeDay(day: string, f: DayFile): Promise<void> {
  await mkdir(DIR, { recursive: true });
  await writeFile(join(DIR, `${day}.json`), JSON.stringify(f), "utf-8");
}

/* ── 신규어 발굴 ─────────────────────────────────────────────────────────── */

/**
 * 조사·접미사만 붙은 흔한 말은 세 봐야 의미가 없다.
 *
 * 「관련·기자·종목·시장」 같은 것이 매일 1등을 하면 화면이 그 낱말로 덮인다.
 * 이건 「자주 나오는 말」이 아니라 **뉴스라는 글의 문법**이라 빼야 한다.
 */
const STOP = new Set([
  "기자", "특징주", "관련", "종목", "시장", "증시", "코스피", "코스닥", "주가", "상승",
  "하락", "강세", "약세", "전망", "분석", "발표", "공시", "오늘", "내일", "어제", "올해",
  "지난해", "사진", "영상", "속보", "단독", "종합", "그래픽", "뉴스", "보도", "이슈",
  "투자", "거래", "매수", "매도", "외국인", "기관", "개인", "장중", "마감", "개장",
  "억원", "조원", "만원", "포인트", "퍼센트", "대비", "기록", "예상", "가능", "확대",
  "감소", "증가", "영향", "효과", "계획", "추진", "검토", "논의", "회의", "정부",
  "한국", "국내", "해외", "세계", "글로벌", "기업", "회사", "그룹", "산업", "업계",
  /* 2차 실측(2026-08-30)에서 걸러낸 것들 — 뜻은 있으나 아무 기사에나 붙는 말 */
  "이유", "기회", "주식", "오른", "내린", "이번", "최근", "당분간", "여전히",
  "목표주", "수익률", "실적", "매출", "영업익", "순이익", "공모", "청약",
  /* 3차 실측(2026-08-30, 미니PC 화면) — 「올 들어」「다시」처럼 문장을 잇는 말 */
  "들어", "다시", "수준", "가운데", "이후", "통해", "위해", "대해", "따라", "관해",
  /*
   * 4차 실측(2026-08-31 요청 — 「증시 출발 뭐 이런것들」).
   *
   * 장 상황을 적는 **시황 기사의 어휘**다. 「강보합 출발」·「급락 마감」처럼 매일
   * 아침저녁으로 붙는다. 뜻이 없는 말은 아니지만 **어느 종목·어느 테마 이야기인지를
   * 하나도 말해 주지 않아** 눌러 봐도 볼 것이 없다.
   */
  "출발", "급등", "급락", "반등", "조정", "회복", "우려", "기대", "부담", "목표",
  "상승세", "하락세", "강보합", "약보합", "혼조", "보합", "상승폭", "하락폭",
  "장초반", "초반", "막판", "장마감", "전거래일", "휴장", "개인투자자",
]);

/**
 * 붙어 온 조사를 뗀다.
 *
 * 「발언에」「발언은」「발언이」를 따로 세면 셋 다 잔챙이가 되어 아무것도 안 걸린다.
 * 떼어 놓으면 「발언」 하나로 모여 신호가 선다. 긴 조사부터 봐야 한다 —
 * 「에서」를 「서」로 먼저 자르면 엉뚱한 말이 남는다.
 */
const JOSA = [
  "으로부터", "에서는", "에게서", "이라도", "에서도", "으로는", "라고는",
  "에서", "에게", "부터", "까지", "보다", "으로", "이라", "라고", "처럼", "만큼",
  "은", "는", "이", "가", "을", "를", "에", "의", "와", "과", "도", "로", "만", "야",
];

function stripJosa(w: string): string {
  for (const j of JOSA) {
    if (w.length - j.length >= 2 && w.endsWith(j)) return w.slice(0, -j.length);
  }
  return w;
}

/**
 * 제목에서 낱말 후보를 뽑는다.
 *
 * 형태소 분석기를 넣지 않는다 — 의존성이 무겁고, 우리가 필요한 건 「같은 글자
 * 뭉치가 갑자기 많아졌나」뿐이라 **정확한 품사는 필요 없다.** 대신 조사를 떼고
 * 서술어를 걸러 내는 정도만 한다.
 *
 * ⚠️ 첫 수집 실측에서 「있다·없다·발언에·달간」 같은 **문법 조각**이 상위에 올랐다.
 * 이런 건 기준선도 같이 높아져 급증 판정에는 안 걸리지만, 화면을 덮어 정작 볼
 * 것을 가린다. 그래서 뽑는 단계에서 떨어뜨린다.
 */
function harvest(title: string): string[] {
  const out: string[] = [];
  /*
   * 머리 대괄호를 뗀다 — 「[특징주]」「[표]」「[게시판]」「[속보]」.
   * 기사 제목의 관례라 **내용이 아니라 갈래 표시**다. 채널 서명을 걷어낸 것과
   * 같은 이유다(buzzRadar 의 stripSignature 참고).
   */
  title = title.replace(/^\s*(?:[[［【].{0,20}?[\]］】]\s*){1,2}/u, "");
  for (const m of title.matchAll(/[가-힣]{2,8}/g)) {
    const w = stripJosa(m[0]);
    if (w.length < 2 || w.length > 7) continue;
    if (STOP.has(w)) continue;
    /* 서술어 — 「있다·없다·한다·했다·된다·됐다」. 낱말이 아니라 문장의 끝이다 */
    if (/(다|요|죠|까|네|음|함|됨)$/.test(w)) continue;
    /* 숫자만 남은 것, 한 글자 + 단위 */
    if (/^[0-9]+$/.test(w)) continue;
    out.push(w);
  }
  /*
   * 영문 약어 — 2~6자 대문자. 신기술·규제 이름이 여기로 온다 (HBM·ESS·FDA).
   *
   * ⚠️ **뒤에 한글이 바로 붙으면 뽑지 않는다** (2026-08-31 요청 — 「SK 가 최상단」).
   *
   * 「SK하이닉스」는 K 와 하 사이에 낱말 경계가 잡혀 **「SK」가 뽑힌다.** 그러면
   * SK이노·SK온·SK하이닉스·삼성SK그룹이 전부 「SK」 하나로 세어져 **서로 다른
   * 회사가 한 낱말이 된다.** LS(LS증권·LS ELECTRIC)·DB(DB손보)도 같았다.
   *
   * 기준선이 쌓여도 이건 안 낫는다 — z 만 내려갈 뿐 **뭉치는 것 자체가 틀렸다.**
   * 한글이 이어지면 그건 독립된 약어가 아니라 **회사 이름의 앞 조각**이므로 버린다.
   * 한글 쪽에서 「하이닉스」·「손보」가 따로 잡히므로 정보를 잃지도 않는다.
   *
   * 「美ESS 수주」처럼 뒤가 공백이면 그대로 뽑힌다 — 그건 진짜 약어다.
   * 한자도 막는다 — 「LS證」 같은 언론 표기가 있다.
   */
  for (const m of title.matchAll(/\b[A-Z]{2,6}\b(?![가-힣])/g)) out.push(m[0]);
  return out;
}

/* ── 수집 ────────────────────────────────────────────────────────────────── */

let collecting = false;

/**
 * 한 바퀴 긁어서 센다.
 *
 * `naverNews` 는 5분 캐시가 있어 화면이 보던 것과 같은 응답을 나눠 쓴다 — 화면을
 * 보고 있는 동안에는 조회가 늘지 않는다.
 *
 * 실패는 삼킨다. 수집이 안 됐다고 서버가 시끄러워질 이유가 없다 — 다음 바퀴에
 * 다시 긁으면 되고, 놓친 기사는 발행 시각으로 뒤늦게 들어와도 제자리에 꽂힌다.
 */
export async function collectNewsKeywords(): Promise<{ articles: number; terms: number }> {
  if (collecting) return { articles: 0, terms: 0 };
  collecting = true;
  try {
    const dict = await buzzDictionary().catch(() => [] as BuzzTerm[]);
    const byTerm = new Map(dict.map((t) => [t.term, t] as const));

    /* 날짜별로 모았다가 한 번에 쓴다 — 자정을 넘겨 수집하면 이틀치가 섞인다 */
    const days = new Map<string, DayFile>();
    const seenSets = new Map<string, Set<string>>();
    let articles = 0;
    const touched = new Set<string>();

    for (const cat of CATS) {
      const got = await naverNews(cat, 1).catch(() => ({ items: [] }));
      for (const it of got.items) {
        if (!it.at || !it.title) continue;
        const day = dayOf(it.at);
        if (!days.has(day)) {
          const f = await readDay(day);
          days.set(day, f);
          seenSets.set(day, new Set(f.seen));
        }
        const f = days.get(day)!;
        const seen = seenSets.get(day)!;
        /*
         * 링크와 「제목+매체」 둘 다로 거른다. 제목만 쓰면 연재물(「[표] 코스피」)이
         * 매일 하나로 뭉개지므로 **날짜 파일 안에서만** 견준다 — 지금 구조가 그렇다.
         */
        const titleKey = `T|${it.press}|${it.title.replace(/s+/g, "")}`;
        if (seen.has(it.link) || seen.has(titleKey)) continue;
        seen.add(it.link);
        seen.add(titleKey);
        f.seen.push(it.link, titleKey);
        articles += 1;

        const minute = minuteOf(it.at);
        f.articlesByMinute[minute] = (f.articlesByMinute[minute] ?? 0) + 1;
        /* 제목 + 요약을 같이 본다. 요약에만 나오는 이름이 꽤 있다 */
        const text = `${it.title} ${it.summary ?? ""}`;

        const hits = new Set<string>();
        /* ① 사전 매칭 — 테마·종목·이벤트·개체 */
        for (const [term] of byTerm) if (text.includes(term)) hits.add(term);
        /* ② 신규어 — 제목에서만 뽑는다(요약까지 뽑으면 잡음이 너무 는다) */
        for (const w of harvest(it.title)) hits.add(w);

        for (const term of hits) {
          const known = byTerm.get(term);
          f.kinds[term] = known?.kind ?? "new";
          if (known?.codes?.length) f.codes[term] = known.codes;
          const pr = ((f.presses ??= {})[term] ??= {});
          if (it.press) pr[it.press] = (pr[it.press] ?? 0) + 1;
          (f.byMinute[term] ??= {});
          f.byMinute[term][minute] = (f.byMinute[term][minute] ?? 0) + 1;

          /* 표본은 낱말당 최근 6건만 — 「왜 떴는지」를 보려는 것이지 목록이 아니다 */
          const arr = (f.samples[term] ??= []);
          const inTitle = it.title.includes(term);
          arr.unshift({ title: it.title, link: it.link, press: it.press, at: it.at, inTitle });
          /*
           * **제목에서 걸린 것을 앞에 세운다.** 요약에서만 걸린 기사가 여섯 자리를
           * 다 차지하면, 눌러 봤을 때 그 낱말이 하나도 안 보이는 목록이 나온다.
           */
          arr.sort((a, b) => Number(b.inTitle ?? false) - Number(a.inTitle ?? false));
          if (arr.length > 6) arr.length = 6;
          touched.add(term);
        }
      }
    }

    for (const [day, f] of days) {
      /* 링크 목록이 끝없이 자라지 않게 — 하루 3000건이면 충분히 넉넉하다 */
      if (f.seen.length > 3000) f.seen = f.seen.slice(-3000);
      await writeDay(day, f);
    }
    await prune();
    return { articles, terms: touched.size };
  } finally {
    collecting = false;
  }
}

async function prune(): Promise<void> {
  try {
    const files = (await readdir(DIR)).filter((f) => f.endsWith(".json")).sort();
    for (const f of files.slice(0, Math.max(0, files.length - KEEP_DAYS))) {
      await unlink(join(DIR, f)).catch(() => undefined);
    }
  } catch {
    /* 정리 실패는 조용히 — 다음에 또 한다 */
  }
}

/* ── 점수 ────────────────────────────────────────────────────────────────── */

export interface KeywordHit {
  term: string;
  kind: TermKind;
  /** 선택한 창 안의 언급 수 */
  recent: number;
  /** 같은 길이의 평소 언급 수 (지난 며칠 평균) */
  baseline: number;
  /** recent / baseline. 기준선이 0이면 「신규」로 따로 표시한다 */
  ratio: number;
  /** 기준선이 0이었나 — 처음 나온 말. 이게 제일 값지다 */
  fresh: boolean;
  codes: string[];
  /** `inTitle` — 제목에서 걸렸나. 요약에서만 걸린 것은 화면이 그렇게 적는다 */
  samples: { title: string; link: string; press: string; at: string; inTitle?: boolean }[];
  /** 종목 낱말이면 지금 등락률 — 이미 오른 뒤인지 판단하려고 */
  changeRate?: number;
  /** 몇 개 매체가 썼나 — 한 매체가 열 번 쓴 것과 열 매체가 한 번씩은 다르다 */
  presses: number;
  /** 뜻밖의 정도 */
  z: number;
}

export interface KeywordFlow {
  /** 창 길이 (분) */
  windowMin: number;
  /** 창 안에서 실제로 집계된 기사 수 */
  articles: number;
  hits: KeywordHit[];
  /** 기준선으로 쓴 지난 날 수. 3 미만이면 급증 판정을 신뢰하지 말라고 알린다 */
  baselineDays: number;
  /** 분 단위 언급량 — 화면 위쪽의 흐름 띠 */
  timeline: { minute: string; count: number }[];
  updatedAt: string;
}

/*
 * ⚠️ **시각은 전부 KST 벽시계**로 맞춘다.
 *
 * 기사 시각은 `2026-08-30T08:33:00+09:00` 로 오고, 우리는 `slice(0,16)` 해서
 * 「2026-08-30T08:33」을 열쇠로 쓴다 — 즉 **KST 벽시계 분**이다.
 *
 * 그런데 창을 만들 때 `new Date(ms).toISOString()` 을 쓰면 그건 **UTC** 라
 * 아홉 시간이 어긋난다. 실측에서 모든 배율이 1.0 으로 나왔는데, 창이 엉뚱한
 * 구간을 짚어 최근치와 기준선이 같은 숫자를 보고 있었기 때문이다.
 * 오프셋을 더한 뒤 `toISOString` 하면 그 문자열이 곧 KST 벽시계가 된다.
 */
const KST = 9 * 3600_000;

function kstMinute(ms: number): string {
  return new Date(ms + KST).toISOString().slice(0, 16);
}
function kstDay(ms: number): string {
  return new Date(ms + KST).toISOString().slice(0, 10);
}

/** 「지금」에서 windowMin 만큼 거슬러 올라간 분 키들 (KST) */
function minuteKeys(endMs: number, windowMin: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < windowMin; i += 1) out.push(kstMinute(endMs - i * 60_000));
  return out;
}

/**
 * 지금 무엇이 갑자기 커졌나.
 *
 * ## 기준선을 어떻게 잡나
 *
 * 지난 N일의 **같은 길이 창** 평균이 아니라 **하루 전체를 분으로 나눈 값**에
 * 창 길이를 곱한다. 이유: 30분 창을 쓰면 「어제 같은 30분」은 표본이 1~2건뿐이라
 * 0 이 되기 일쑤고, 그러면 전부 「신규」로 뜬다. 하루 평균을 쓰면 기준선이 안정된다.
 *
 * 대신 이건 **시간대 차이를 뭉갠다** — 장중과 새벽의 뉴스량이 다른데 같은 잣대를
 * 댄다. 그 대가로 「새벽에는 뭐든 급증으로 보인다」가 생기므로, 창 안 기사 수가
 * 너무 적으면(5건 미만) 화면에서 「표본 적음」이라고 말한다.
 */
export async function keywordFlow(windowMin = 60): Promise<KeywordFlow> {
  const now = Date.now();
  const win = Math.min(1440, Math.max(1, Math.round(windowMin)));

  /* 창이 자정을 넘으면 이틀치가 필요하다 */
  const need = new Set<string>();
  for (const m of minuteKeys(now, win)) need.add(m.slice(0, 10));
  const cur = new Map<string, DayFile>();
  for (const d of need) cur.set(d, await readDay(d));

  const keys = new Set(minuteKeys(now, win));

  /* 최근 창의 낱말별 건수 */
  const recent = new Map<string, number>();
  const timeline = new Map<string, number>();
  for (const f of cur.values()) {
    for (const [term, mins] of Object.entries(f.byMinute)) {
      let n = 0;
      for (const [minute, c] of Object.entries(mins)) {
        if (!keys.has(minute)) continue;
        n += c;
      }
      if (n > 0) recent.set(term, (recent.get(term) ?? 0) + n);
    }
    /* 타임라인·표본 수는 **기사 수**로 센다 — 낱말 매칭을 더하면 몇 배로 부푼다 */
    for (const [minute, c] of Object.entries(f.articlesByMinute)) {
      if (keys.has(minute)) timeline.set(minute, (timeline.get(minute) ?? 0) + c);
    }
  }

  /*
   * 기준선 — **창이 닿지 않는 날들**만.
   *
   * 처음엔 「오늘을 뺀 지난 날」로 잡았는데, 24시간 창을 쓰면 창이 어제까지
   * 거슬러 올라가므로 **어제가 최근치와 기준선 양쪽에** 들어갔다. 자기 자신과
   * 비교하니 배율이 1.0 으로 눌렸다. 창이 시작하는 날보다 **이전** 날만 쓴다.
   */
  const windowStartDay = kstDay(now - win * 60_000);
  let files: string[] = [];
  try {
    files = (await readdir(DIR)).filter((f) => f.endsWith(".json")).sort();
  } catch {
    /* 아직 하루도 안 쌓였다 */
  }
  /*
   * ⚠️ **주말은 기준선에서 뺀다** (2026-08-31).
   *
   * 뉴스 흐름은 평일과 주말이 완전히 다르다. 주말에는 개장·마감 관련 기사가 아예
   * 없어서, 토·일을 기준선으로 쓰면 월요일 아침에 **「출발」·「급락」 같은 개장
   * 상용어가 전부 「처음 보는 말」로 잡힌다.** 실측에서 그게 상위를 채웠다.
   *
   * 평일이 하나도 없으면(수집 초기) 있는 대로 쓴다 — 기준선이 아예 없는 것보다는
   * 낫고, 아래 바닥값이 잔챙이를 막는다.
   */
  const all = files.map((f) => f.replace(".json", "")).filter((d) => d < windowStartDay);
  const weekdays = all.filter((d) => {
    const w = new Date(`${d}T00:00:00Z`).getUTCDay();
    return w >= 1 && w <= 5;
  });
  const pastDays = (weekdays.length > 0 ? weekdays : all).slice(-7);

  const dayTotals = new Map<string, number>(); // term → 지난 날들 총 건수
  /* 시간대 보정을 하려면 「지난 날 이 시각들에 기사가 몇 건이었나」가 필요하다 */
  const clock = new Set([...keys].map((k) => k.slice(11))); // HH:mm 만
  let pastArticlesAll = 0;
  let pastArticlesInClock = 0;
  for (const d of pastDays) {
    const f = await readDay(d);
    for (const [term, mins] of Object.entries(f.byMinute)) {
      let n = 0;
      for (const c of Object.values(mins)) n += c;
      dayTotals.set(term, (dayTotals.get(term) ?? 0) + n);
    }
    for (const [minute, c] of Object.entries(f.articlesByMinute)) {
      pastArticlesAll += c;
      if (clock.has(minute.slice(11))) pastArticlesInClock += c;
    }
  }
  const baselineDays = pastDays.length;

  /*
   * 창 길이를 「하루 중 얼마쯤」으로 환산한다.
   *
   * ⚠️ 처음엔 그냥 `win / 1440` 을 썼다. 그건 **뉴스가 하루 내내 고르게 나온다**는
   * 가정인데 전혀 그렇지 않다 — 장중에 몰리고 새벽엔 거의 없다. 그 결과:
   *
   *   · 새벽 30분 창 — 실제 기사는 거의 없는데 기준선은 하루의 1/48 을 요구하니
   *     한 건만 나와도 배율이 치솟는다
   *   · 장중 30분 창 — 실제 기사가 많은데 기준선은 여전히 1/48 이라 **평범한 시간이
   *     급증으로 보인다**
   *
   * 그래서 **지난 날들의 같은 시각대에 기사가 몇 %였나**로 환산한다. 이 값은
   * 이미 세고 있는 `articlesByMinute` 에서 그대로 나온다.
   *
   * 표본이 모자라면(기사 30건 미만) 옛 방식으로 돌아간다 — 몇 건으로 낸 비율은
   * 균등 가정보다 오히려 더 튄다.
   */
  const flat = win / 1440;
  /*
   * ⚠️ 시간대 비율만 쓰면 **역방향으로 망가진다.** 과거에 그 시각 기사가 한 건도
   * 없었으면 비율이 0 이 되고, 기준선이 0 이니 뭐가 나오든 전부 「신규·무한배」가
   * 된다. 실측에서 저녁 7시 창이 그렇게 됐다(과거 표본이 장중에만 있었다).
   *
   * 그래서 **7 대 3 으로 섞는다** — 시간대 차이는 살리되 균등 가정을 바닥으로 깐다.
   * 통계에서 관측이 없는 칸에 최소값을 얹는 것과 같은 이유다.
   */
  const scale =
    pastArticlesAll >= 30
      ? 0.7 * (pastArticlesInClock / pastArticlesAll) + 0.3 * flat
      : flat;

  const snap = peekSnapshot();
  const kinds = new Map<string, TermKind>();
  const codes = new Map<string, string[]>();
  const samples = new Map<string, KeywordHit["samples"]>();
  for (const f of cur.values()) {
    for (const [t, k] of Object.entries(f.kinds)) kinds.set(t, k);
    for (const [t, c] of Object.entries(f.codes)) codes.set(t, c);
    for (const [t, s] of Object.entries(f.samples)) samples.set(t, s);
  }

  const cfg = await getBuzzConfig();
  const presses = new Map<string, number>();
  for (const f of cur.values()) {
    for (const [t, ps] of Object.entries(f.presses ?? {})) {
      presses.set(t, Math.max(presses.get(t) ?? 0, Object.keys(ps).length));
    }
  }

  /*
   * 창 안의 기사 수 — **기준선을 여기에 맞춘다** (아래 주석 참고).
   */
  let articles = 0;
  for (const c of timeline.values()) articles += c;

  const hits: KeywordHit[] = [];
  for (const [term, n] of recent) {
    if (n < 2) continue; // 한 번 나온 것은 아직 흐름이 아니다
    /*
     * ⚠️ **읽을 때도 거른다.** `STOP` 은 수집 단계에서 쓰지만, 목록을 늘려도
     * **이미 쌓인 날들에는 그대로 남아 있다.** 그러면 새 규칙이 며칠 뒤에야
     * 효과를 내고, 그동안 화면은 예전 그대로다 — 고쳤는데 안 고쳐진 것처럼 보인다.
     */
    if (STOP.has(term)) continue;
    /*
     * **회사 이름의 앞 조각으로 뽑힌 영문 약어**도 읽을 때 거른다 (2026-08-31).
     *
     * `harvest` 를 고쳤지만 **이미 쌓인 날들에는 그대로 남아 있다.** 그러면 새 규칙이
     * 며칠 뒤에야 효과를 내고 그동안 화면은 예전 그대로다.
     *
     * 사전에 있는 약어(HBM·ESS 같은 진짜 이름)는 남긴다 — 그건 뽑기 규칙이 아니라
     * 우리가 등록한 낱말이다.
     */
    /*
     * **회사 이름의 앞 조각으로 뽑힌 영문 약어**를 읽을 때도 거른다 (2026-08-31).
     *
     * `harvest` 를 고쳤지만 **이미 쌓인 날들에는 그대로 남아 있다.** 그러면 새 규칙이
     * 며칠 뒤에야 효과를 내고 그동안 화면은 예전 그대로다.
     *
     * ⚠️ 「제목에 있나」로는 못 가른다 — 「SK이노」도 제목에 SK 가 있다. **뒤에
     * 한글·한자가 붙는지**를 봐야 한다. 표본 제목 전부에서 뒤에 한글이 이어지면
     * 그건 독립된 약어가 아니라 이름의 조각이다.
     *
     * 사전에 등록된 낱말(kind 가 new 가 아닌 것)은 건드리지 않는다 — 그건 뽑기
     * 규칙이 아니라 우리가 정한 이름이다.
     */
    if (/^[A-Z]{2,6}$/.test(term) && (kinds.get(term) ?? "new") === "new") {
      const ss = samples.get(term) ?? [];
      const standalone = ss.some((x) =>
        new RegExp(`\b${term}\b(?![가-힣一-龥])`).test(x.title),
      );
      if (ss.length > 0 && !standalone) continue;
    }
    /*
     * ⚠️ **기준선은 「건수」가 아니라 「기사당 비율」이다** (2026-08-31 요청 —
     * 「증시가 1위고 출발이 2위고 그래. 의미없는 것들」).
     *
     * 예전엔 `지난 날들의 하루 평균 건수 × 창 몫` 이었다. 그러면 **기사량이 다른
     * 날끼리 견주게 된다.** 실측:
     *
     *   8/29  기사  12건 · 증권  0회   ← 수집 시작일
     *   8/30  기사  77건 · 증권  8회   ← 일요일
     *   8/31  기사 311건 · 증권 77회   ← 오늘
     *
     * 기준선이 (0+8)/2 × 창몫 = **0.66** 이 나왔다. 그런데 오늘 창 안에 73회다.
     * z 가 56 까지 뛰고, 기준선이 0 인 낱말은 `z = 건수` 가 되어 **흔한 말이 그대로
     * 1등**이 된다. 「증시」·「출발」이 상위에 오던 이유가 이것이다.
     *
     * 기사량으로 정규화하면 사라진다 — 증권은 8/30 에 기사의 10.4%(8/77)에 나왔고
     * 오늘 창에서는 29.7%(73/246)다. 기대치가 0.66 이 아니라 **25.6** 이 되어
     * z 가 56 에서 9 로 내려간다. 흔한 말일수록 비율이 일정해 저절로 가라앉는다.
     *
     * 기사가 적은 날도 **비율은 멀쩡하므로** 수집 초기의 왜곡도 같이 없어진다.
     */
    const rate = pastArticlesAll > 0 ? (dayTotals.get(term) ?? 0) / pastArticlesAll : 0;
    const base = rate > 0 ? rate * articles : 0;
    const fresh = baselineDays >= 2 && base < 0.35; // 사실상 처음 보는 말
    const ratio = base > 0 ? n / base : n; // 기준선이 없으면 건수 자체가 세기다
    const pressCount = presses.get(term) ?? 0;

    /*
     * ⚠️ **정말 처음 보는 말에는 바닥을 깐다** (2026-08-31).
     *
     * 기준선이 0 이면 `z = (n - 0) / sqrt(1) = n` 이 되어 **z 가 그대로 건수**가
     * 된다. 그러면 흔한 말이 「기준선 없음」으로 빠져나가 1등을 한다 — 「출발」이
     * 19건으로 상위에 오던 통로가 이것이었다.
     *
     * 그래서 처음 보는 말은 **창 안 기사의 0.5% 만큼은 나올 수 있었다**고 가정한다.
     * 246건짜리 창이면 1.2 다. 진짜 새 낱말은 그래도 z 가 충분히 크고(12건이면
     * z≈7), 아무 데나 붙는 말은 건수만큼 곧바로 오르지 못한다.
     *
     * 첫날에도 깐다 — 비교할 과거가 없을수록 흔한 말이 그대로 1등을 하므로,
     * 오히려 그때 바닥이 더 필요하다.
     */
    const floor = Math.max(0.5, articles * 0.005);
    const { z } = buzzPoints(n, Math.max(base, floor), pressCount, cfg);

    const cs = codes.get(term) ?? [];
    let changeRate: number | undefined;
    if (snap && cs.length === 1) changeRate = snap.byCode.get(cs[0])?.changeRate;

    hits.push({
      term,
      kind: kinds.get(term) ?? "new",
      recent: n,
      baseline: Number(base.toFixed(2)),
      ratio: Number(ratio.toFixed(2)),
      fresh,
      codes: cs,
      samples: samples.get(term) ?? [],
      changeRate,
      presses: pressCount,
      z: Math.round(z * 100) / 100,
    });
  }

  /*
   * 정렬 — **급증 배율이 먼저**다.
   *
   * 건수로 줄 세우면 매일 같은 낱말이 1등이라 아무것도 안 알려 준다.
   * 다만 배율만 보면 2→6건 같은 잔챙이가 위로 오므로 건수를 약하게 섞는다.
   */
  /*
   * **뜻밖의 정도(z)로 줄 세운다.** 배수로 세우면 「평소 0.3건이 2건」 같은 잔챙이가
   * 위로 오고, 건수로 세우면 매일 같은 낱말이 1등이다. z 는 둘을 한 값으로 푼다.
   * 기준선이 없으면 z 도 의미가 없어 건수로 돌아간다.
   */
  hits.sort((a, b) => (baselineDays >= 1 ? b.z - a.z : b.recent - a.recent));

  return {
    windowMin: win,
    articles,
    hits: hits.slice(0, 80),
    baselineDays,
    timeline: [...timeline.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(
      ([minute, count]) => ({ minute, count }),
    ),
    updatedAt: new Date(now).toISOString(),
  };
}

/* ── 스케줄 ──────────────────────────────────────────────────────────────── */

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * 얼마나 자주 긁나.
 *
 * 발행 시각으로 버킷을 나누므로 **수집 주기가 해상도를 정하지 않는다** — 3분마다
 * 긁어도 분 단위 흐름이 정확히 남는다. 주기는 「놓치지 않을 만큼」이면 되고,
 * 네이버에 부담을 주지 않는 선에서 정한다.
 *
 * 장중에는 기사가 몰리므로 3분, 그 밖에는 10분. 새 기사가 목록 첫 쪽을 넘겨
 * 밀려나기 전에만 들르면 된다.
 */
function periodMs(): number {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 3600_000);
  const h = kst.getUTCHours();
  const day = kst.getUTCDay();
  const weekday = day >= 1 && day <= 5;
  if (weekday && h >= 8 && h < 17) return 3 * 60_000;
  if (h >= 6 && h < 24) return 10 * 60_000;
  return 30 * 60_000;
}

export function startNewsKeywordScheduler(): void {
  if (timer) return;
  let last = 0;
  const tick = async () => {
    /* 설정에서 끌 수 있다 (2026-08-30) — 「지금 실행」은 꺼도 되니 여기서만 막는다 */
    if (!(await isEnabled("newsKeywords"))) return;
    const period = (await periodOverrideMs("newsKeywords")) ?? periodMs();
    if (Date.now() - last < period) return;
    last = Date.now();
    const r = await collectNewsKeywords().catch((e) => {
      void markRun("newsKeywords", false, e instanceof Error ? e.message : "실패");
      return null;
    });
    if (r) await markRun("newsKeywords", true, `기사 ${r.articles}건 · 낱말 ${r.terms}개`);
  };
  void tick();
  /* 1분마다 깨어나 「지금 긁을 때인가」만 본다 — 시간대별 주기를 갈아 끼우지 않아도 된다 */
  timer = setInterval(() => void tick(), 60_000);
}
