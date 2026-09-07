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

function matchStocks(text: string): { code: string; name: string }[] {
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
    if (out.length >= 5) break;
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
      const lead = /n\.news\.naver\.com\/article\//.test(it.link) ? await fetchLead(it.link) : "";
      out[k] = { link: it.link, lead, stocks: matchStocks(`${it.title} ${lead || it.summary}`) };
    }
  };
  await Promise.all(Array.from({ length: 5 }, worker));
  return out;
}
