import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { recordApiCall } from "./apiUsage.js";
import { evaluateThemes } from "./customThemes.js";
import { loadCorrelations } from "./usKrCorrelation.js";
import type { KiwoomClient } from "./kiwoomClient.js";

/**
 * 미국 ↔ 한국 테마 연동.
 *
 * 국내 장은 밤사이 미국을 보고 출발한다. 그런데 우리 조간은 "나스닥 +0.8%"까지만 말해주고
 * **그게 어느 국내 테마로 이어지는지**는 사람이 머릿속으로 잇고 있었다.
 *
 * 1단계(여기)는 수동 매핑 + 나란히 보기다. 상관계수 검증(2단계)과 시차 분석(3단계)은
 * 이 매핑이 있어야 시작할 수 있다.
 *
 * **주의해서 다룬 것:**
 * 상관관계는 변한다. 그래서 이 매핑을 "고정된 진리"로 표시하지 않는다 — 지금은 사람이 적은
 * 가설이고, 2단계에서 상관계수를 붙여 낡은 매핑을 걷어내는 게 목적이다.
 * 참고 지표일 뿐 매매 신호가 아니다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "data");
const FILE = join(DATA_DIR, "usKrLinks.json");
const YAHOO_BASE = "https://query1.finance.yahoo.com/v8/finance/chart";

export interface UsKrLink {
  /** 이 연결의 이름 (예: 반도체) */
  label: string;
  /** 미국 티커 — 지수도 개별종목도 된다 (^SOX, NVDA) */
  us: string[];
  /** 대응하는 내 테마 이름. customThemes 의 name 과 정확히 같아야 한다 */
  kr: string[];
  /** 왜 이렇게 이었는지. 나중에 이 매핑을 의심할 때 근거가 된다 */
  memo?: string;
}

/**
 * 기본 매핑.
 *
 * 티커는 실측으로 확인한 것만 넣는다(scripts/yahoo-probe.mjs). 국내 테마 이름은
 * customThemes 에 있는 것과 **글자까지 같아야** 매칭된다 — 다르면 화면에서 조용히 빠진다.
 */
export const DEFAULT_LINKS: UsKrLink[] = [
  {
    label: "반도체",
    us: ["^SOX", "NVDA", "MU", "AMAT"],
    kr: ["반도체 대표주(생산)", "HBM(고대역폭메모리)", "반도체 장비", "HBM 밸류체인"],
    memo: "국내 반도체와 상관성이 가장 높은 축. ^SOX 를 기준으로 본다",
  },
  {
    label: "AI 서버·기판",
    us: ["SMCI", "DELL", "AVGO"],
    kr: ["AI 서버 기판·패키징", "반도체 기판(FC-BGA/PCB/MLB 등)", "소캠(SOCAMM)", "CXL(컴퓨트익스프레스링크)"],
    memo: "AI 서버 출하가 기판·패키징 수요로 이어진다",
  },
  {
    label: "전기차·2차전지",
    us: ["TSLA", "LIT", "ALB"],
    kr: ["2차전지", "2차전지(생산)", "2차전지(소재/부품)", "2차전지(장비)", "리튬"],
    memo: "테슬라 출하와 리튬 가격이 국내 셀·소재로 전달된다",
  },
  {
    label: "전력·데이터센터",
    us: ["GEV", "VRT", "ETN"],
    kr: ["AI 전력인프라", "전력저장장치(ESS)"],
    memo: "데이터센터 전력 수요 — 변압기·전력기기 수주로 이어진다",
  },
  {
    label: "원자력·SMR",
    us: ["SMR", "OKLO", "CEG", "URA"],
    kr: ["SMR·차세대 원전"],
    memo: "무탄소 전원 수요. 미국 SMR 종목이 국내 원전주를 끌 때가 많다",
  },
  {
    label: "우주·위성",
    us: ["RKLB", "ASTS", "ARKX"],
    kr: ["우주항공·위성", "우주항공산업(누리호/인공위성 등)", "스페이스X(SpaceX)"],
  },
  {
    label: "로봇",
    us: ["ARKQ", "ISRG"],
    kr: ["휴머노이드 로봇"],
    memo: "국내 휴머노이드는 테슬라 옵티머스 뉴스에 더 민감하다 — TSLA도 같이 볼 것",
  },
  {
    label: "태양광·신재생",
    us: ["TAN", "ICLN", "FSLR"],
    kr: ["태양광에너지", "풍력에너지"],
  },
  {
    label: "수소·연료전지",
    us: ["PLUG", "BE"],
    kr: ["수소에너지(수소차/연료전지 등)", "고체산화물 연료전지(SOFC)"],
  },
  {
    label: "방산·조선",
    us: ["ITA", "LMT", "RTX"],
    kr: ["조선·해양방산"],
    memo: "미국 방산은 예산 사이클이라 국내 조선·방산과 시차가 클 수 있다",
  },
];

// ---------------------------------------------------------------- 저장소

function normalize(input: unknown): UsKrLink[] {
  if (!Array.isArray(input)) return DEFAULT_LINKS;
  const out: UsKrLink[] = [];
  for (const raw of input) {
    const label = String((raw as UsKrLink)?.label ?? "").trim();
    const us = Array.isArray((raw as UsKrLink)?.us)
      ? (raw as UsKrLink).us.map((x) => String(x).trim().toUpperCase()).filter(Boolean)
      : [];
    const kr = Array.isArray((raw as UsKrLink)?.kr)
      ? (raw as UsKrLink).kr.map((x) => String(x).trim()).filter(Boolean)
      : [];
    if (!label || us.length === 0) continue;
    out.push({ label, us, kr, memo: String((raw as UsKrLink)?.memo ?? "").trim() || undefined });
  }
  return out.length > 0 ? out : DEFAULT_LINKS;
}

export async function listLinks(): Promise<UsKrLink[]> {
  try {
    return normalize(JSON.parse(await readFile(FILE, "utf-8")));
  } catch {
    return DEFAULT_LINKS;
  }
}

export async function saveLinks(input: unknown): Promise<UsKrLink[]> {
  const next = normalize(input);
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(FILE, JSON.stringify(next, null, 2), "utf-8");
  return next;
}

// ---------------------------------------------------------------- 미국 시세

export interface UsQuote {
  symbol: string;
  name: string;
  price: number | null;
  changeRate: number | null;
  error: string | null;
}

/** 매핑에 쓰인 티커만 받아온다. 1분 캐시 — 매핑을 여러 번 열어도 호출이 늘지 않게 */
let quoteCache: { at: number; map: Map<string, UsQuote> } | null = null;
const QUOTE_TTL_MS = 60_000;

async function fetchQuote(symbol: string): Promise<UsQuote> {
  const base: UsQuote = { symbol, name: symbol, price: null, changeRate: null, error: null };
  try {
    const url = `${YAHOO_BASE}/${encodeURIComponent(symbol)}?range=1d&interval=1d`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) {
      void recordApiCall("yahoo", symbol, res.status === 429 ? "rateLimited" : "failed");
      base.error = `HTTP ${res.status}`;
      return base;
    }
    void recordApiCall("yahoo", symbol, "ok");
    const body = (await res.json()) as {
      chart?: { result?: Array<{ meta?: Record<string, unknown> }> };
    };
    const meta = body.chart?.result?.[0]?.meta;
    if (!meta) {
      base.error = "응답 형식 오류";
      return base;
    }
    const price = Number(meta.regularMarketPrice);
    const prev = Number(meta.chartPreviousClose ?? meta.previousClose);
    if (Number.isFinite(price)) base.price = price;
    if (Number.isFinite(price) && Number.isFinite(prev) && prev !== 0) {
      base.changeRate = ((price - prev) / prev) * 100;
    }
    base.name = String(meta.shortName ?? meta.symbol ?? symbol);
  } catch (err) {
    base.error = err instanceof Error ? err.message : "조회 실패";
  }
  return base;
}

async function quotesFor(symbols: string[]): Promise<Map<string, UsQuote>> {
  if (quoteCache && Date.now() - quoteCache.at < QUOTE_TTL_MS) {
    const missing = symbols.filter((s) => !quoteCache!.map.has(s));
    if (missing.length === 0) return quoteCache.map;
  }
  const map = new Map<string, UsQuote>();
  // 야후는 몰아치면 429가 온다. 5개씩 끊고 사이에 간격을 둔다
  for (let i = 0; i < symbols.length; i += 5) {
    const chunk = symbols.slice(i, i + 5);
    const got = await Promise.all(chunk.map(fetchQuote));
    for (const q of got) map.set(q.symbol, q);
    if (i + 5 < symbols.length) await new Promise((r) => setTimeout(r, 300));
  }
  quoteCache = { at: Date.now(), map };
  return map;
}

// ---------------------------------------------------------------- 나란히 보기

export interface LinkStat {
  /** 이 연결에서 가장 연동이 강한 미국 티커 */
  us: string;
  kr: string;
  /** 미국 D일 → 국내 D+1일 상관계수 */
  corr: number;
  /** 미국이 1% 움직이면 국내는 평균 몇 % */
  beta: number;
  samples: number;
}

export interface EvaluatedLink extends UsKrLink {
  usQuotes: UsQuote[];
  /** 미국 쪽 단순평균 등락률 (지수와 개별종목을 섞어 쓰므로 가중은 의미가 없다) */
  usAvg: number | null;
  krThemes: { name: string; changeRate: number | null; found: boolean }[];
  /** 국내 쪽 평균 등락률 — 각 테마는 이미 시총 가중이라 여기선 단순평균 */
  krAvg: number | null;
  /** 미국 대비 국내가 얼마나 따라왔는가(%p). 음수면 덜 반영된 것 */
  gap: number | null;
  /** 검증된 연동 강도 (2단계). 아직 계산 전이면 null */
  stat: LinkStat | null;
  /**
   * 평소 연동을 감안한 오늘의 기대 등락률.
   * 미국 평균 × 기울기 — "평소대로면 국내가 이만큼은 갔어야 한다"
   */
  expected: number | null;
  /** 기대 대비 실제(%p). 음수면 아직 덜 반영된 것 */
  surprise: number | null;
}

export async function evaluateLinks(client: KiwoomClient): Promise<{
  links: EvaluatedLink[];
  /** 국내 테마 이름 목록 — 화면에서 매핑을 고칠 때 고르게 하려고 같이 준다 */
  themeNames: string[];
  at: string;
}> {
  const links = await listLinks();
  const symbols = [...new Set(links.flatMap((l) => l.us))];

  const [quotes, themes, corr] = await Promise.all([
    quotesFor(symbols),
    evaluateThemes(client).then((r) => r.themes).catch(() => []),
    loadCorrelations().catch(() => null),
  ]);

  /**
   * 연결마다 **가장 강하게 연동되는 쌍 하나**만 대표로 쓴다.
   * 쌍을 전부 보여주면 표가 넘치고, 판단에 쓰이는 건 "가장 잘 따라가는 축" 하나다.
   * 표본이 적으면(20일 미만) 우연일 수 있어 버린다.
   */
  const statOf = (label: string): LinkStat | null => {
    const rows = (corr?.pairs ?? []).filter(
      (p) => p.label === label && p.nextDay !== null && p.beta !== null && p.samples >= 20,
    );
    if (rows.length === 0) return null;
    const best = rows.reduce((a, b) => (Math.abs(b.nextDay!) > Math.abs(a.nextDay!) ? b : a));
    return { us: best.us, kr: best.kr, corr: best.nextDay!, beta: best.beta!, samples: best.samples };
  };

  const byName = new Map(themes.map((t) => [t.name, t]));
  const avg = (xs: (number | null)[]) => {
    const ok = xs.filter((x): x is number => x !== null);
    return ok.length > 0 ? ok.reduce((a, b) => a + b, 0) / ok.length : null;
  };

  const evaluated: EvaluatedLink[] = links.map((l) => {
    const usQuotes = l.us.map((s) => quotes.get(s) ?? { symbol: s, name: s, price: null, changeRate: null, error: "미조회" });
    const krThemes = l.kr.map((name) => {
      const t = byName.get(name);
      return { name, changeRate: t?.changeRate ?? null, found: Boolean(t) };
    });
    const usAvg = avg(usQuotes.map((q) => q.changeRate));
    const krAvg = avg(krThemes.map((t) => t.changeRate));
    const stat = statOf(l.label);
    // 대표 쌍의 미국 등락률을 기준으로 기대치를 낸다 (평균이 아니라 그 티커여야 맞다)
    const leadRate = stat ? (quotes.get(stat.us)?.changeRate ?? null) : null;
    const expected = stat && leadRate !== null ? leadRate * stat.beta : null;
    return {
      ...l,
      usQuotes,
      usAvg,
      krThemes,
      krAvg,
      gap: usAvg !== null && krAvg !== null ? krAvg - usAvg : null,
      stat,
      expected,
      surprise: expected !== null && krAvg !== null ? krAvg - expected : null,
    };
  });

  return { links: evaluated, themeNames: themes.map((t) => t.name), at: new Date().toISOString() };
}

/**
 * 조간 리포트에 넣을 형태.
 * "나스닥 +0.8%"만 있으면 사람이 머릿속으로 국내 테마와 이어야 한다. 그걸 붙여서 준다.
 */
export function toUsKrDigest(
  links: EvaluatedLink[],
  opts: { premarket?: boolean } = {},
): string {
  const usable = links.filter((l) => l.usAvg !== null && l.krThemes.some((t) => t.found));
  if (usable.length === 0) return "";

  const fmt = (n: number | null) => (n === null ? "-" : `${n > 0 ? "+" : ""}${n.toFixed(2)}%`);
  const lines = usable
    // 미국 쪽이 크게 움직인 것부터 — 그게 오늘 국내에 영향이 클 후보다
    .sort((a, b) => Math.abs(b.usAvg ?? 0) - Math.abs(a.usAvg ?? 0))
    .slice(0, 6)
    .map((l) => {
      const kr = l.krThemes
        .filter((t) => t.found)
        .map((t) => `${t.name} ${fmt(t.changeRate)}`)
        .join(", ");

      /*
       * 검증된 연동이 있으면 **기대치와 비교**해서 준다.
       * "SOX +3.2% → 반도체 (연동 0.72, 기대 +1.8%, 실제 +0.4% → 덜 반영)"
       * 이렇게 줘야 AI가 "미국이 올랐으니 국내도 오를 것"이라는 빈말 대신
       * 평소 대비 오늘이 어땠는지를 말할 수 있다.
       */
      if (l.stat && l.expected !== null) {
        const lead = l.usQuotes.find((q) => q.symbol === l.stat!.us);
        const head =
          `${l.label}: ${l.stat.us} ${fmt(lead?.changeRate ?? null)} ` +
          `(연동 ${l.stat.corr.toFixed(2)}, ${l.stat.samples}일 표본) → 기대 ${fmt(l.expected)}`;

        /*
         * 개장 전에는 "실제"가 없다.
         *
         * 이 연동은 **간밤 미국 → 오늘 국내**(nextDay 상관)라서, 개장 전에 손에 있는
         * 국내 등락률은 간밤보다 **먼저 끝난** 직전 거래일 값이다. 그걸 "실제"라고 붙이면
         * 하루 어긋난 비교가 되고, 모델은 그걸 근거로 "덜 반영됐으니 오늘 오른다"는
         * 결론까지 써낸다. 그래서 조간에는 기대치만 주고 판정을 붙이지 않는다.
         */
        if (opts.premarket) return `${head} (오늘 개장 후 확인)  [${kr} — 전일 종가 기준]`;

        const verdict =
          l.surprise === null
            ? ""
            : l.surprise < -0.5
              ? " → 덜 반영됨"
              : l.surprise > 0.5
                ? " → 더 반영됨"
                : " → 대체로 예상대로";
        return `${head} / 실제 ${fmt(l.krAvg)}${verdict}  [${kr}]`;
      }

      // 아직 상관계수를 안 냈으면 나란히만
      const us = l.usQuotes
        .filter((q) => q.changeRate !== null)
        .map((q) => `${q.symbol} ${fmt(q.changeRate)}`)
        .join(", ");
      if (opts.premarket) return `${l.label}: 미국 ${us} → 국내 ${kr} (전일 종가 기준, 연동 미검증)`;
      return `${l.label}: 미국 ${us} → 국내 ${kr} (연동 미검증)`;
    });

  const verified = usable.some((l) => l.stat);
  const premarketNote = opts.premarket
    ? " **아직 개장 전이라 국내 '실제'는 존재하지 않는다** — 대괄호 안 국내 등락률은 직전 거래일 값이니 오늘 결과인 것처럼 쓰지 마라."
    : "";
  const head = verified
    ? `[밤사이 미국 → 오늘 볼 것 — 연동 계수는 최근 60일 실측이다. 상관관계는 변하므로 참고 지표로만 쓰고 매매 신호로 단정하지 말 것.${premarketNote}]`
    : `[미국↔국내 테마 연동 — 사람이 적은 가설이며 상관계수 검증 전이다. 참고용으로만 쓰고 단정하지 말 것.${premarketNote}]`;

  return `\n${head}\n${lines.join("\n")}`;
}
