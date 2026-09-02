import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ENTRY_LABEL, type BuyPlan, type Candidate, type EntryMode, type ExitCall, type MarketGate } from "./cisTrader.js";
import { today } from "./cisAccount.js";
import type { AccountId } from "./cisAccounts.js";

/**
 * CIS 일지 — 시스가 하루 세 번 쓰는 글.
 *
 * ## 왜 세 번인가 (2026-08-31 요청)
 *
 * 하루를 한 번에 적으면 **결과를 알고 나서 쓴 글**이 된다. 저녁에 앉아 「오늘은
 * 이래서 이랬다」를 적으면, 사실은 아침에 없던 이유가 슬그머니 들어간다. 그게
 * 복기를 못 쓰게 만드는 가장 흔한 방식이다.
 *
 *   - **아침** — 아직 아무것도 모를 때 쓴다. 계획과 후보. 이게 나중에 채점표가 된다.
 *   - **점심** — 보유만 본다. 계획대로 가고 있나, 어긋났으면 어떻게 대응했나.
 *   - **저녁** — 결과. 아침의 계획과 대조한다. **아침 글을 고치지 않는다.**
 *
 * 아침 글을 못 고치게 하는 것이 이 구조의 핵심이다. 고칠 수 있으면 아침 글은
 * 저녁의 변명으로 바뀐다.
 *
 * ## 저장
 *
 * 하루 한 파일(`cis/journal/YYYY-MM-DD.json`)이다. 한 파일에 다 넣으면 몇 달 뒤
 * 수 MB 를 매번 읽고 쓰게 되고, 한 번 깨지면 전부 잃는다. 날짜로 쪼개면 그날치만
 * 잃는다.
 */

const here = dirname(fileURLToPath(import.meta.url));
/**
 * **계좌마다 폴더가 따로다** (2026-08-31 — "매매일지나 이런것도 일반 계좌
 * 개인연금 퇴직금 이렇게 나눠서 써야겠지?").
 *
 * 한 파일에 셋을 섞으면 「개인연금은 요즘 어땠나」를 읽을 때마다 나머지 둘을
 * 걸러내야 한다. 성격이 다른 돈은 장부도 글도 나눈다.
 *
 * 시장 판단은 세 계좌가 같은 것을 보지만 **글은 각자 쓴다** — 같은 시황이라도
 * 트레이딩 계좌에 뜻하는 바와 연금 계좌에 뜻하는 바가 다르다.
 */
const ROOT = join(here, "..", "data", "cis", "journal");
function dirOf(account: AccountId): string {
  return join(ROOT, account);
}

export type Slot = "morning" | "noon" | "evening";

export const SLOT_LABEL: Record<Slot, string> = {
  morning: "아침",
  noon: "점심",
  evening: "저녁",
};

/** 그날 실제로 일어난 매매 한 줄 — 일지가 계좌를 다시 적는 게 아니라 가리킨다 */
export interface JournalAction {
  side: "buy" | "sell";
  code: string;
  name: string;
  qty: number;
  price: number;
  funding: string;
  why: string;
  used: string[];
  pnl?: number;
}

/** 한 시간대의 글 */
export interface SlotEntry {
  slot: Slot;
  /** 언제 썼나 (ISO) */
  at: string;
  /** 사람이 읽는 본문 — 규칙이 만든 문장. AI 가 붙으면 여기를 다듬는다 */
  text: string;
  /** 시장 판단 */
  market: MarketGate | null;
  /** 그때 본 후보 (아침·저녁만) */
  candidates: Candidate[];
  /** 그때 세운 계획 (아침만) */
  plans: {
    name: string;
    code: string;
    qty: number;
    price: number;
    funding: string;
    stop: number;
    target: number | null;
    why: string;
  }[];
  /** 실제로 한 것 */
  actions: JournalAction[];
  /** 팔아야 한다고 본 것 */
  exits: { name: string; code: string; kind: string; reason: string }[];
  /**
   * **미국장 분위기** — 종배 계좌의 저녁에만 (2026-09-02). 선물 몸통·유가·환율·금리의
   * 판정을 그대로 남긴다. 나중에 「미국장이 나빴던 날의 종배는 어땠나」를 물으려면
   * 그날의 판정이 글이 아니라 값으로 있어야 한다.
   */
  macro?: {
    ok: boolean;
    summary: string;
    verdicts: { key: string; label: string; level: string; value: string; price: string; why: string }[];
  };
  /**
   * **이 시간대에 어떤 화면·지표를 봤나.** 벤티지가 보고 싶어 한 「HTS 활용법」이
   * 이 배열을 세어서 만들어진다. 판단에 실제로 쓴 것만 넣는다 —
   * 열어만 본 화면을 넣으면 활용도가 부풀려진다.
   */
  used: string[];
  /** 계좌 스냅샷 — 그때 얼마였나 */
  equity: number;
  cash: number;
  debt: number;
}

export interface CisDay {
  date: string;
  account: AccountId;
  morning: SlotEntry | null;
  noon: SlotEntry | null;
  evening: SlotEntry | null;
  /**
   * 하루 총평 — 저녁에 만든다. **아침 계획과 대조한 결과**라
   * 세 시간대가 다 있어야 뜻이 있다.
   */
  review: {
    /** 계획한 것 중 몇 개를 실제로 샀나 */
    planned: number;
    executed: number;
    /** 오늘 실현손익 */
    realized: number;
    /** 오늘 평가액 변화 */
    equityChange: number;
    /** 규칙을 어긴 것이 있나 — 있으면 그게 제일 중요한 기록이다 */
    violations: string[];
    text: string;
  } | null;
}

const empty = (date: string, account: AccountId): CisDay => ({
  date,
  account,
  morning: null,
  noon: null,
  evening: null,
  review: null,
});

function fileOf(account: AccountId, date: string): string {
  return join(dirOf(account), `${date}.json`);
}

export async function loadDay(date: string, account: AccountId = "trade"): Promise<CisDay> {
  try {
    const raw = await readFile(fileOf(account, date), "utf8");
    return { ...empty(date, account), ...(JSON.parse(raw) as Partial<CisDay>), account };
  } catch {
    return empty(date, account);
  }
}

export async function saveDay(day: CisDay): Promise<void> {
  await mkdir(dirOf(day.account), { recursive: true });
  await writeFile(fileOf(day.account, day.date), JSON.stringify(day, null, 2), "utf8");
}

/**
 * 한 시간대를 적는다.
 *
 * ⚠️ **이미 쓴 시간대는 덮지 않는다.** 아침 글이 저녁에 바뀌면 이 일지의 뜻이
 * 사라진다(파일 머리 주석 참고). 다시 돌리고 싶으면 `force` 를 줘야 하고,
 * 그건 사람이 화면에서 「다시 쓰기」를 눌렀을 때만이다.
 */
export async function writeSlot(
  entry: SlotEntry,
  account: AccountId = "trade",
  date = today(),
  force = false,
): Promise<CisDay> {
  const day = await loadDay(date, account);
  if (day[entry.slot] && !force) return day;
  day[entry.slot] = entry;
  await saveDay(day);
  return day;
}

/** 최근 며칠 — 목록 화면이 읽는다 */
export async function listDays(limit = 60, account: AccountId = "trade"): Promise<CisDay[]> {
  try {
    const files = await readdir(dirOf(account));
    const dates = files
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""))
      .sort((a, b) => b.localeCompare(a))
      .slice(0, limit);
    return await Promise.all(dates.map((d) => loadDay(d, account)));
  } catch {
    return [];
  }
}

/** 그 계좌의 일지를 통째로 지운다 — 계좌 초기화와 짝이다 */
export async function clearJournal(account: AccountId): Promise<number> {
  try {
    const files = await readdir(dirOf(account));
    const targets = files.filter((f) => f.endsWith(".json"));
    await Promise.all(targets.map((f) => rm(join(dirOf(account), f))));
    return targets.length;
  } catch {
    return 0;
  }
}

/* ------------------------------------------------------------------ 문장 */

const won = (n: number) => `${Math.round(n).toLocaleString("ko-KR")}원`;
const pct = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(1)}%`;

/**
 * 규칙이 만든 판단을 **사람이 읽는 글**로 옮긴다.
 *
 * AI 없이 도는 것이 기본이라 여기가 본문이다. 나중에 AI 를 붙이면 이 글을 재료로
 * 문장을 다듬게 되지, 이 글이 없어지지 않는다 — API 가 죽어도 일지는 남아야 한다.
 *
 * 글투는 **관찰 기록**이다. 「~할 것 같다」 같은 예측이 아니라 「~여서 ~했다」로
 * 적는다. 예측은 틀리면 변명이 되지만 기록은 틀릴 수가 없다.
 */
export function narrate(
  slot: Slot,
  d: {
    /** 이 시간대의 진입 모드 — 시가/장중/종가배팅 */
    mode: EntryMode;
    /** 매수를 15분 루프가 맡고 있나 — 그러면 이 글은 「그사이 복기」가 본체다 */
    loopBuys: boolean;
    /**
     * **직전 시간대 이후에 루프가 사고판 것.**
     *
     * 하루 세 번이 각각 「그사이에 무슨 일이 있었나」를 적어야 이 일지가
     * 이어 읽힌다 — 아침에 계획만 적고 점심에 결과만 적으면 그 사이가 빈다.
     */
    interval: { side: "buy" | "sell"; name: string; qty: number; price: number; pnl?: number; why: string; at: string }[];
    /** 후보마다 이 자리로 들어갈 만했나. **안 산 이유가 산 이유만큼 중요하다** */
    gateNotes: { name: string; ok: boolean; reason: string }[];
    /**
     * 신조 ① 의 체에 걸려 **점수를 매기기도 전에** 빠진 것 (2026-09-02 밤).
     * 벤티지: "내가 보고 항상 되새김할 수 있게" — 매일 무엇을 왜 안 봤는지가
     * 글에 있어야 「먼저 거른다」가 말이 아니라 기록이 된다.
     */
    sieved?: { name: string; reason: string }[];
    /**
     * 종배 계좌 (2026-09-02). 아침·점심엔 「저녁에만 산다」를, 저녁엔 미국장 분위기를
     * 적는다. `macro` 가 있으면 저녁이다.
     */
    closeBet?: { macro: { ok: boolean; summary: string; lines: string[] } | null };
    market: MarketGate | null;
    candidates: Candidate[];
    plans: BuyPlan[];
    exits: ExitCall[];
    actions: JournalAction[];
    equity: number;
    prevEquity: number | null;
    positions: number;
    cash: number;
    debt: number;
  },
): string {
  const L: string[] = [];

  const modeName = ENTRY_LABEL[d.mode];

  if (slot === "morning") {
    L.push("## 오늘 어떻게 볼 것인가");
  } else if (slot === "noon") {
    L.push("## 장중 점검");
  } else {
    L.push("## 마감");
  }

  if (d.market) {
    L.push(
      d.market.ok
        ? `시장 ${d.market.score}점(${d.market.label}). ${d.market.reason}.`
        : `**오늘은 사지 않는다.** ${d.market.reason}.`,
    );
  }

  /*
   * **종배 계좌** — 이 계좌는 저녁 한 번만 산다. 아침·점심 글이 「왜 아무것도 안 샀나」로
   * 읽히지 않게 그 사실을 먼저 적고, 저녁엔 미국장 분위기 판정을 그대로 남긴다.
   */
  if (d.closeBet) {
    if (slot !== "evening") {
      L.push(
        slot === "morning"
          ? "종배 계좌다 — 어제 담은 것은 09:00 시가 근처에 판다. 매수는 저녁(원장 쌓인 뒤)에만."
          : "종배 계좌다 — 오전에 청산이 끝났어야 한다. 매수는 저녁에만.",
      );
    } else if (d.closeBet.macro) {
      const m = d.closeBet.macro;
      L.push("");
      L.push("### 미국장 분위기");
      L.push(m.ok ? m.summary : `**${m.summary}**`);
      for (const line of m.lines) L.push(`- ${line}`);
    } else if (d.market?.ok) {
      L.push("미국장 분위기를 못 읽었다 — 오늘은 안 산다.");
    }
  }

  if (slot === "evening") {
    const chg = d.prevEquity !== null ? d.equity - d.prevEquity : 0;
    const chgPct = d.prevEquity ? (chg / d.prevEquity) * 100 : 0;
    L.push(
      `평가액 ${won(d.equity)}` +
        (d.prevEquity !== null ? ` (${chg >= 0 ? "+" : ""}${won(chg)}, ${pct(chgPct)})` : "") +
        ` · 예수금 ${won(d.cash)}` +
        (d.debt > 0 ? ` · 빌린 돈 ${won(d.debt)}` : ""),
    );
  }
  if (slot === "noon") {
    L.push(`보유 ${d.positions}종목. 평가액 ${won(d.equity)}.`);
  }

  /*
   * **그사이에 무슨 일이 있었나.** 루프가 장중에 사고판 것을 먼저 적는다 —
   * 이 시간대의 글에서 제일 중요한 대목이다. 계획과 결과 사이가 비면
   * 나중에 읽을 때 「왜 그렇게 됐는지」를 알 수가 없다.
   */
  if (d.interval.length > 0) {
    L.push("");
    L.push(slot === "evening" ? "### 오후에 있었던 일" : "### 그사이에 있었던 일");
    for (const f of d.interval) {
      const t = f.at ? new Date(f.at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }) : "";
      const tail = f.side === "sell" && typeof f.pnl === "number" ? ` → ${f.pnl >= 0 ? "+" : ""}${won(f.pnl)}` : "";
      L.push(
        `- ${t} **${f.name}** ${f.side === "buy" ? "매수" : "매도"} ` +
          `${f.qty.toLocaleString()}주 ${won(f.price)}${tail}`,
      );
      if (f.why) L.push(`  - ${f.why}`);
    }
  } else if (d.loopBuys && slot !== "morning") {
    L.push("");
    L.push("그사이에 손댈 자리는 없었다. 규칙에 걸린 것이 없으면 아무것도 안 한다.");
  }

  /*
   * **이 자리로 들어갈 만했나.** 통과한 것과 못 한 것을 같이 적는다 —
   * 「왜 안 샀나」가 「왜 샀나」만큼 중요하다. 안 산 이유가 없으면 나중에
   * 「그때 왜 놓쳤지」에 답할 수가 없다.
   */
  /* 종배 계좌의 아침·점심엔 매수 자리 자체가 없다 — 빈 「자리」 절을 만들지 않는다 */
  const buyable = d.closeBet ? slot === "evening" && d.closeBet.macro?.ok === true : true;
  if (d.market?.ok && !d.loopBuys && buyable) {
    const passed = d.gateNotes.filter((g) => g.ok);
    const failed = d.gateNotes.filter((g) => !g.ok);
    L.push("");
    L.push(`### ${modeName} 자리`);
    if (passed.length === 0 && failed.length === 0) {
      L.push("후보 자체가 없었다. 억지로 만들지 않는다.");
    } else if (passed.length === 0) {
      L.push(`${failed.length}개를 봤지만 들어갈 자리가 없었다.`);
    }
    for (const g of passed) L.push(`- **${g.name}** — ${g.reason}`);
    if (failed.length > 0) {
      L.push("");
      L.push("안 들어간 것:");
      for (const g of failed.slice(0, 6)) L.push(`- ${g.name} — ${g.reason}`);
    }
  }

  /*
   * **체에 걸린 것** — 신조 ① 「나쁜 자리를 먼저 지운다」의 기록.
   * 경보·탈락·잡주가 각각 몇 개였는지가 남아야, 나중에 「체가 너무 촘촘했나」를
   * 성적과 나란히 놓고 물을 수 있다.
   */
  if (d.market?.ok && !d.loopBuys && buyable && d.sieved && d.sieved.length > 0) {
    L.push("");
    L.push("### 체에 걸린 것 — 먼저 거르고, 남은 것 중에서 추세를 탄다");
    const shown = d.sieved.slice(0, 8);
    for (const s of shown) L.push(`- ${s.name} — ${s.reason}`);
    if (d.sieved.length > shown.length) L.push(`- 그 밖에 ${d.sieved.length - shown.length}개`);
  }

  if (d.candidates.length > 0) {
    L.push("");
    L.push("### 후보의 근거");
    for (const c of d.candidates.slice(0, 8)) {
      L.push(
        `- **${c.name}** ${pct(c.changeRate)} · 대금 ${c.tradeValue.toLocaleString()}억 — ${c.why}` +
          (c.signalLevel ? ` (신호등 ${c.signalLevel} ${c.signalScore}점)` : ""),
      );
    }
  }

  if (d.plans.length > 0) {
    L.push("");
    L.push("### 계획");
    for (const p of d.plans) {
      L.push(
        `- ${p.candidate.name} ${p.qty.toLocaleString()}주 · ${won(p.price)} (${p.funding}) ` +
          `— 손절 ${won(p.stop)} / ${p.target !== null ? `목표 ${won(p.target)}` : "목표 없음 · 고점 되돌림에 판다"}`,
      );
    }
  }

  if (slot === "noon" && d.exits.length === 0 && !d.closeBet) {
    L.push("");
    L.push("손절·익절에 닿은 자리는 없다. **흔들린다고 팔지 않는다** — 손절선까지는 버틴다.");
  }

  if (d.exits.length > 0) {
    L.push("");
    L.push("### 정리한 자리");
    for (const e of d.exits) {
      L.push(`- **${e.position.name}** — ${e.reason}`);
    }
  }

  if (d.actions.length > 0) {
    L.push("");
    L.push("### 체결");
    for (const a of d.actions) {
      const tail =
        a.side === "sell" && typeof a.pnl === "number"
          ? ` → ${a.pnl >= 0 ? "+" : ""}${won(a.pnl)}`
          : "";
      L.push(
        `- ${a.side === "buy" ? "매수" : "매도"} **${a.name}** ${a.qty.toLocaleString()}주 ` +
          `${won(a.price)} (${a.funding})${tail}`,
      );
      if (a.why) L.push(`  - ${a.why}`);
    }
  } else if (slot !== "noon") {
    L.push("");
    L.push("체결 없음.");
  }

  return L.join("\n");
}

/**
 * 저녁의 총평 — **아침 계획과 대조한다.**
 *
 * 규칙을 어긴 것을 따로 세는 게 핵심이다. 벌었는지가 아니라 **규칙대로 했는지**를
 * 본다. 규칙을 어겼는데 번 날이 제일 위험하다 — 그날 배운 게 다음에 크게 잃게 만든다.
 * (`tradeJournal.ts` 가 사람의 복기에서 쓰는 것과 같은 원칙이다.)
 */
export function review(day: CisDay, prevEquity: number | null): CisDay["review"] {
  const planned = day.morning?.plans.length ?? 0;
  const bought = new Set(
    [day.morning, day.noon, day.evening]
      .flatMap((s) => s?.actions ?? [])
      .filter((a) => a.side === "buy")
      .map((a) => a.code),
  );
  const realized = [day.morning, day.noon, day.evening]
    .flatMap((s) => s?.actions ?? [])
    .reduce((sum, a) => sum + (a.pnl ?? 0), 0);
  const equity = day.evening?.equity ?? day.noon?.equity ?? day.morning?.equity ?? 0;

  const violations: string[] = [];
  /* 장중 매수는 규칙 위반이다 — 규칙이 막고 있지만, 뚫렸다면 그게 제일 중요한 기록이다 */
  const noonBuys = (day.noon?.actions ?? []).filter((a) => a.side === "buy");
  if (noonBuys.length > 0) {
    violations.push(`장중 매수 ${noonBuys.length}건 — 규칙상 금지`);
  }
  /* 계획에 없던 종목을 샀나 */
  const plannedCodes = new Set((day.morning?.plans ?? []).map((p) => p.code));
  for (const code of bought) {
    if (plannedCodes.size > 0 && !plannedCodes.has(code)) {
      const nm =
        [day.morning, day.noon, day.evening]
          .flatMap((s) => s?.actions ?? [])
          .find((a) => a.code === code)?.name ?? code;
      violations.push(`계획에 없던 ${nm} 매수`);
    }
  }

  const L: string[] = [];
  L.push(
    planned === 0
      ? "아침에 세운 계획이 없었다."
      : `아침에 ${planned}종목을 계획해 ${bought.size}종목을 샀다.`,
  );
  if (realized !== 0) L.push(`실현손익 ${realized >= 0 ? "+" : ""}${won(realized)}.`);
  if (violations.length > 0) {
    L.push("");
    L.push("**규칙을 어긴 것**");
    for (const v of violations) L.push(`- ${v}`);
    L.push("");
    L.push("어기고 벌었어도 어긴 것이다 — 그날 배운 게 다음에 크게 잃게 만든다.");
  } else {
    L.push("규칙을 벗어난 매매는 없었다.");
  }

  return {
    planned,
    executed: bought.size,
    realized: Math.round(realized),
    equityChange: prevEquity !== null ? Math.round(equity - prevEquity) : 0,
    violations,
    text: L.join("\n"),
  };
}
