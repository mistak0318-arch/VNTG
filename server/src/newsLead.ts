/**
 * 뉴스 카드 채우기 — 본문 앞머리(리드)와 관련 종목 (2026-09-08).
 *
 * 벤티지: "PC에서 뉴스는 이제 한 줄로 잘 나오는데 안에 내용이 좀 덜 채워져 있네?"
 * 네이버 목록이 주는 요약은 120자가 전부라 줄 수를 늘려도 카드가 빈다(styles.css 의 09-07 주석).
 * 그래서 **기사 본문의 앞 400자**를 받아 요약 대신 싣고, 제목·본문에 나온 **상장사 이름**을 종목 칩으로 단다.
 *
 * 본문: n.news.naver.com 기사 페이지의 `#dic_area`. 링크별 6시간 캐시, 한 쪽(20건)에 동시 5개씩.
 * 종목: 전종목 스냅샷 이름을 그대로 찾는다(조회 0회). 두 글자 이름·흔한 낱말은 뺀다 — 「한국」「대한」이 종목으로 잡히면 안 된다.
 */
import { peekSnapshot } from "./marketSnapshot.js";

export interface NewsLead {
  link: string;
  /** 본문 앞머리 — 못 받으면 "" (화면은 목록 요약을 그대로 쓴다) */
  lead: string;
  stocks: { code: string; name: string }[];
}

const cache = new Map<string, { at: number; lead: string }>();
const TTL = 6 * 3600_000;
const MAX = 600;

/* 종목명으로 쓰기엔 너무 흔한 이름 — 기사에 자주 나오는 낱말과 겹친다 */
const SKIP = new Set(["한국", "대한", "동양", "삼성", "현대", "국제", "대성", "대원", "한일", "동아", "한화", "신한", "우리", "하나", "동부", "서울", "부산", "경남", "미래", "세계", "지주", "코리아", "글로벌", "한솔", "한진", "동국", "삼양", "대림", "제일", "성장", "금호", "대우", "SK", "LG", "GS", "CJ", "KT", "DB", "HD", "DL", "HL", "OCI", "SG", "KB", "NH"]);

function unescapeHtml(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

/**
 * **기사 전문** (2026-09-09 — 벤티지: "클릭하면 그 창 안에서 볼 수 있는 게 더 빠르게
 * 확인할 수 있는 방법인 것 같아").
 *
 * 리드(앞 420자)와 같은 자리(`#dic_area`)를 읽되 자르지 않는다. 시세분석 조회순위에서
 * 뉴스를 누르면 팝업 안에서 읽는 용도다 — 저장하지 않고(짧은 캐시뿐) 원문 링크를
 * 늘 같이 단다. 문단은 `<br>`·`</p>` 자리에서 줄을 바꿔 둔다 — 한 덩어리면 못 읽는다.
 */
const fullCache = new Map<string, { at: number; text: string }>();

export async function newsBody(link: string): Promise<string> {
  /* 검색 API 는 `/mnews/article/` 링크를 준다 — 둘 다 같은 `#dic_area` 다 (2026-09-09 실측) */
  if (!/n\.news\.naver\.com\/(mnews\/)?article\//.test(link)) return "";
  const hit = fullCache.get(link);
  if (hit && Date.now() - hit.at < TTL) return hit.text;
  let text = "";
  try {
    const res = await fetch(link, { headers: { "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const html = await res.text();
      const m = html.match(/id="dic_area"[^>]*>([\s\S]*?)<\/article>/);
      if (m) {
        let t = m[1]
          .replace(/<script[\s\S]*?<\/script>/g, " ")
          .replace(/<style[\s\S]*?<\/style>/g, " ")
          .replace(/<br\s*\/?>/g, "\n")
          .replace(/<\/p>|<\/div>/g, "\n")
          .replace(/<[^>]+>/g, " ");
        t = unescapeHtml(t)
          .split("\n")
          .map((l) => l.replace(/\s+/g, " ").trim())
          .filter(Boolean)
          .join("\n");
        text = t;
      }
    }
  } catch {
    /* 못 받으면 빈 채로 — 화면이 원문 링크를 안내한다 */
  }
  fullCache.set(link, { at: Date.now(), text });
  if (fullCache.size > 200) {
    const first = fullCache.keys().next().value;
    if (first) fullCache.delete(first);
  }
  return text;
}

async function fetchLead(link: string): Promise<string> {
  const hit = cache.get(link);
  if (hit && Date.now() - hit.at < TTL) return hit.lead;
  let lead = "";
  try {
    const res = await fetch(link, { headers: { "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(6000) });
    if (res.ok) {
      const html = await res.text();
      const m = html.match(/id="dic_area"[^>]*>([\s\S]*?)<\/article>/);
      if (m) {
        let t = m[1]
          .replace(/<script[\s\S]*?<\/script>/g, " ")
          .replace(/<style[\s\S]*?<\/style>/g, " ")
          .replace(/<br\s*\/?>/g, " ")
          .replace(/<[^>]+>/g, " ");
        t = unescapeHtml(t).replace(/\s+/g, " ").trim();
        /* 「[서울=뉴시스] 아무개 기자 =」 같은 머리는 뗀다 — 카드 첫 줄이 기자 이름이면 안 된다 */
        t = t.replace(/^\[[^\]]{1,30}\]\s*/, "").replace(/^[^=]{0,25}기자\s*=\s*/, "");
        lead = t.length > 420 ? `${t.slice(0, 420).replace(/\s+\S*$/, "")}…` : t;
      }
    }
  } catch {
    /* 못 받으면 빈 채로 — 목록 요약이 있다 */
  }
  cache.set(link, { at: Date.now(), lead });
  if (cache.size > MAX) {
    const first = cache.keys().next().value;
    if (first) cache.delete(first);
  }
  return lead;
}

/*
 * 이름 뒤 글자가 **조사·문장부호·비한글**이어야 종목이다. 「아스트」가 「아스트라」에, 「한미」가 「한미반도체」에 걸리면 안 된다.
 * 한국어는 이름 뒤에 조사가 바로 붙으니 띄어쓰기로는 못 가른다.
 */
const PARTICLE = new Set([..."은는이가을를의와과에도로만이나부터까지에서께서보다처럼같이랑"]);
function wordHit(text: string, name: string): boolean {
  let i = text.indexOf(name);
  while (i >= 0) {
    const next = text[i + name.length];
    const prev = i > 0 ? text[i - 1] : "";
    const nextOk = next === undefined || !/[가-힣A-Za-z0-9]/.test(next) || PARTICLE.has(next);
    const prevOk = prev === "" || !/[가-힣A-Za-z0-9]/.test(prev);
    if (nextOk && prevOk) return true;
    i = text.indexOf(name, i + 1);
  }
  return false;
}

/**
 * 기사·채널 글의 별칭 → 정식 종목명 (2026-09-10). 「SK하닉 ADR 7% 폭등」이 SK하이닉스로
 * 안 잡혔다. sysAssist 의 ALIAS_PUBLIC 과 같은 결 — 긴 것부터 바꿔야 「두산에너」가 「두산」에
 * 먼저 안 걸린다.
 */
const ALIASES: [RegExp, string][] = [
  /* 「SK하닉ADR」처럼 붙어 오면 뒤에 공백을 두어 낱말 경계를 만든다. 이미 「SK하이닉스」인 건 건드리지 않는다 */
  [/SK\s*하닉(?!스)/g, "SK하이닉스 "],
  [/(?<!SK)하이닉스(?!스)/g, "SK하이닉스"],
  [/삼전(?=[^자])|삼전$/g, "삼성전자"],
  [/현차/g, "현대차"],
  [/두산에너(?!빌)/g, "두산에너빌리티"],
  [/한화에어로(?!스)/g, "한화에어로스페이스"],
  [/셀트(?=[^리])/g, "셀트리온"],
  [/카뱅/g, "카카오뱅크"],
  [/네이버/g, "NAVER"],
  [/엔씨(?!소)/g, "엔씨소프트"],
  [/포스코(?=\s|$|[^홀케퓨인])/g, "POSCO홀딩스"],
];
function expandAliases(text: string): string {
  let t = text;
  for (const [re, name] of ALIASES) t = t.replace(re, name);
  return t;
}

export function matchStocks(raw: string, max = 5): { code: string; name: string }[] {
  const text = expandAliases(raw);
  const snap = peekSnapshot();
  if (!snap) return [];
  const out: { code: string; name: string }[] = [];
  const seen = new Set<string>();
  for (const s of snap.byCode.values()) {
    const name = s.name;
    if (!name || name.length < 3 || SKIP.has(name) || /우$|우B$|스팩\d*호/.test(name)) continue;
    if (!wordHit(text, name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ code: s.code, name });
    if (out.length >= max) break;
  }
  /* 긴 이름이 짧은 이름을 품는 경우(「삼성전자우」는 위에서 뺐고, 「현대차」와 「현대차증권」) — 긴 쪽만 남긴다 */
  return out.filter((a) => !out.some((b) => b !== a && b.name.includes(a.name)));
}

export async function newsLeads(items: { link: string; title: string; summary: string }[]): Promise<NewsLead[]> {
  const rows = items.slice(0, 30);
  const out: NewsLead[] = new Array(rows.length);
  let i = 0;
  const worker = async () => {
    while (i < rows.length) {
      const k = i++;
      const it = rows[k];
      const lead = /n\.news\.naver\.com\/(mnews\/)?article\//.test(it.link) ? await fetchLead(it.link) : "";
      out[k] = { link: it.link, lead, stocks: matchStocks(`${it.title} ${lead || it.summary}`) };
    }
  };
  await Promise.all(Array.from({ length: 5 }, worker));
  return out;
}
