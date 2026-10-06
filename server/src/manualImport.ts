import { addAccount, listAccounts, removeHolding, setCash, upsertHolding, type ManualAccount } from "./manualAccounts.js";

/**
 * **수동계좌를 CSV 로 들여온다** (2026-10-07 — 벤티지: "내가 증권사 캡쳐해서 AI로 해당 양식에 맞춰서
 * csv 만들어달라 하고 업로드 할게").
 *
 * 수동계좌는 한 종목씩 손으로 넣는 자리였다. 증권사 앱을 캡처해 AI 에게 「이 양식대로」라고 시키면 열 종목도
 * 한 번에 들어온다 — 캘린더가 이미 쓰는 길(양식 내려받기 → 채워서 올리기)을 그대로 가져온다.
 *
 * ## 양식
 *
 *   증권사,계좌이름,종목코드,종목명,수량,평단가,예수금
 *
 * · **계좌는 「증권사+계좌이름」으로 가른다.** 없으면 만든다 — 사람이 미리 계좌를 만들어 둘 필요가 없다.
 * · 종목코드는 여섯 자리. 숫자가 앞의 0 을 잃고 와도(엑셀이 흔히 그런다) 여섯 자리로 채운다.
 * · 수량·평단가·예수금은 쉼표·원·주 같은 글자가 섞여도 읽는다 — AI 가 만든 CSV 는 꼭 깨끗하지 않다.
 * · **예수금은 계좌당 한 번만** 적으면 된다. 여러 줄에 적혀 있으면 마지막 값을 쓴다.
 * · 종목 줄 없이 예수금만 적은 줄도 받는다(예수금만 고치고 싶을 때).
 *
 * ## 먼저 보여 주고 나서 적용한다
 *
 * 올리자마자 덮으면 **잘못 만든 CSV 하나로 계좌가 통째로 뒤집힌다.** `dryRun` 으로 「무엇이 바뀌는지」를 먼저
 * 돌려주고, 사람이 보고 나서 적용한다. `mode: "replace"` 는 그 계좌의 보유를 **파일과 똑같이** 맞추므로
 * (파일에 없는 종목은 뺀다) 증권사 화면을 그대로 옮길 때 쓰고, `"merge"` 는 적힌 것만 더하거나 고친다.
 */

export type ImportMode = "merge" | "replace";

export interface ImportRow {
  broker: string;
  account: string;
  code: string;
  name: string;
  qty: number;
  avgPrice: number;
  cash: number | null;
}

export interface ImportPlan {
  mode: ImportMode;
  /** 계좌별로 무엇이 바뀌나 */
  accounts: {
    broker: string;
    name: string;
    /** 이 계좌를 새로 만드나 */
    isNew: boolean;
    add: { code: string; name: string; qty: number; avgPrice: number }[];
    update: { code: string; name: string; qty: number; avgPrice: number; wasQty: number; wasAvg: number }[];
    /** replace 에서만 — 파일에 없어 빠지는 종목 */
    remove: { code: string; name: string; qty: number }[];
    cash: number | null;
  }[];
  /** 읽다가 건너뛴 줄 — 번호와 까닭 */
  skipped: { line: number; why: string; text: string }[];
  rows: number;
}

/** 쉼표·통화·단위를 걷어내고 숫자만 — AI 가 만든 CSV 는 「1,234주」 「70,000원」처럼 온다 */
function num(v: string | undefined): number | null {
  if (v === undefined) return null;
  const s = v.replace(/[^\d.-]/g, "");
  if (s === "" || s === "-") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** 따옴표를 아는 아주 작은 CSV 쪼개기 — 종목명에 쉼표가 들어갈 수 있다 */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

const HEAD_ALIAS: Record<string, keyof ImportRow> = {
  증권사: "broker",
  broker: "broker",
  계좌이름: "account",
  계좌명: "account",
  계좌: "account",
  account: "account",
  종목코드: "code",
  코드: "code",
  code: "code",
  종목명: "name",
  종목: "name",
  name: "name",
  수량: "qty",
  보유수량: "qty",
  qty: "qty",
  평단가: "avgPrice",
  평균단가: "avgPrice",
  매입단가: "avgPrice",
  avgprice: "avgPrice",
  예수금: "cash",
  현금: "cash",
  cash: "cash",
};

/** CSV 글자 → 줄 목록. 머리글이 없으면 양식 순서대로 읽는다 */
export function parseCsv(text: string): { rows: ImportRow[]; skipped: ImportPlan["skipped"] } {
  const rows: ImportRow[] = [];
  const skipped: ImportPlan["skipped"] = [];
  /* 엑셀이 붙이는 BOM 과 윈도 줄바꿈을 먼저 걷는다 */
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  let map: (keyof ImportRow | null)[] | null = null;

  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return; // 빈 줄과 설명 줄
    const cells = splitCsvLine(line);
    /* 머리글 찾기 — 「증권사」나 「종목코드」가 보이면 그 줄이 머리글이다 */
    if (!map) {
      const lower = cells.map((c) => c.replace(/\s/g, "").toLowerCase());
      if (lower.some((c) => HEAD_ALIAS[c] === "code" || HEAD_ALIAS[c] === "broker")) {
        map = lower.map((c) => HEAD_ALIAS[c] ?? null);
        return;
      }
      /* 머리글이 없는 파일 — 양식 순서로 본다 */
      map = ["broker", "account", "code", "name", "qty", "avgPrice", "cash"];
    }
    const get = (k: keyof ImportRow): string | undefined => {
      const at = map!.indexOf(k);
      return at >= 0 ? cells[at] : undefined;
    };
    const broker = (get("broker") ?? "").trim();
    const account = (get("account") ?? "").trim();
    if (!broker && !account) {
      skipped.push({ line: i + 1, why: "증권사·계좌이름이 비었습니다", text: line.slice(0, 60) });
      return;
    }
    const rawCode = (get("code") ?? "").replace(/[^0-9A-Za-z]/g, "");
    const cash = num(get("cash"));
    if (!rawCode) {
      /* **이름과 수량이 있으면 보유 줄이다** — 코드는 뒤에서 이름으로 찾는다(증권사 화면엔 코드가 없는 때가 많다) */
      const nm0 = (get("name") ?? "").trim();
      const q0 = num(get("qty"));
      if (nm0 && q0 !== null && q0 > 0) {
        rows.push({ broker, account, code: "", name: nm0, qty: q0, avgPrice: num(get("avgPrice")) ?? 0, cash });
        return;
      }
      /* 종목이 없고 예수금만 있는 줄 — 예수금만 고치려는 것이다 */
      if (cash === null) {
        skipped.push({ line: i + 1, why: "종목코드도 종목명도 예수금도 없습니다", text: line.slice(0, 60) });
        return;
      }
      rows.push({ broker, account, code: "", name: "", qty: 0, avgPrice: 0, cash });
      return;
    }
    const code = /^\d+$/.test(rawCode) ? rawCode.padStart(6, "0") : rawCode.toUpperCase();
    const qty = num(get("qty"));
    const avg = num(get("avgPrice"));
    if (qty === null || qty <= 0) {
      skipped.push({ line: i + 1, why: "수량이 없거나 0 입니다", text: line.slice(0, 60) });
      return;
    }
    rows.push({
      broker,
      account,
      code,
      name: (get("name") ?? "").trim() || code,
      qty,
      avgPrice: avg ?? 0,
      cash,
    });
  });

  return { rows, skipped };
}

/**
 * **종목코드가 없으면 이름으로 찾는다** (2026-10-07).
 *
 * 증권사 잔고 화면에는 **종목명만 있고 코드가 없는 경우가 흔하다.** 그걸 AI 에게 「코드도 채워 줘」라고 시키면
 * 삼성전자(005930) 같은 대형주는 맞히지만 중소형주에서 **지어낸다** — 계좌는 돈이 걸린 자리라 환각이 섞이면 안 된다.
 * 그래서 코드 칸은 비워도 되게 하고, 우리가 가진 전 종목 목록에서 **이름으로** 찾는다.
 *
 * 띄어쓰기·괄호 안 설명(「삼성전자(우)」의 (우) 는 **다른 종목**이므로 지우지 않는다)을 빼고 정확히 맞는 것만 쓴다.
 * 둘 이상이 걸리거나 하나도 없으면 **그 줄을 건너뛰고 까닭을 돌려준다** — 비슷한 이름으로 넘겨짚지 않는다.
 */
const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();

export function fillCodesByName(
  rows: ImportRow[],
  index: Map<string, { name: string }>,
  skipped: ImportPlan["skipped"],
): ImportRow[] {
  const byName = new Map<string, string[]>();
  for (const [code, e] of index) {
    const k = norm(e.name);
    if (!k) continue;
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k)!.push(code);
  }
  const out: ImportRow[] = [];
  for (const r of rows) {
    if (r.code || !r.name) {
      out.push(r);
      continue;
    }
    const hit = byName.get(norm(r.name)) ?? [];
    if (hit.length === 1) out.push({ ...r, code: hit[0] });
    else {
      skipped.push({
        line: 0,
        why: hit.length === 0 ? `「${r.name}」을 종목 목록에서 못 찾았습니다 — 종목코드를 적어 주세요` : `「${r.name}」이 ${hit.length}개 있습니다 — 종목코드를 적어 주세요`,
        text: `${r.broker} ${r.account} ${r.name}`,
      });
    }
  }
  return out;
}

/** 계좌를 가르는 열쇠 — 증권사+이름 */
const keyOf = (broker: string, name: string) => `${broker.trim()}|${name.trim()}`;

/** 무엇이 바뀌는지 먼저 그려 본다 (적용하지 않는다) */
export function planImport(rows: ImportRow[], skipped: ImportPlan["skipped"], have: ManualAccount[], mode: ImportMode): ImportPlan {
  const byKey = new Map<string, ImportRow[]>();
  for (const r of rows) {
    const k = keyOf(r.broker, r.account);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(r);
  }

  const accounts: ImportPlan["accounts"] = [];
  for (const [k, list] of byKey) {
    const [broker, name] = k.split("|");
    const old = have.find((a) => keyOf(a.broker, a.name) === k) ?? null;
    const holdings = list.filter((r) => r.code);
    const cashRow = [...list].reverse().find((r) => r.cash !== null);
    const add: ImportPlan["accounts"][number]["add"] = [];
    const update: ImportPlan["accounts"][number]["update"] = [];
    for (const h of holdings) {
      const was = old?.holdings.find((x) => x.code === h.code);
      if (!was) add.push({ code: h.code, name: h.name, qty: h.qty, avgPrice: h.avgPrice });
      else if (was.qty !== h.qty || was.avgPrice !== h.avgPrice)
        update.push({ code: h.code, name: h.name, qty: h.qty, avgPrice: h.avgPrice, wasQty: was.qty, wasAvg: was.avgPrice });
    }
    const remove =
      mode === "replace" && old
        ? old.holdings
            .filter((x) => !holdings.some((h) => h.code === x.code))
            .map((x) => ({ code: x.code, name: x.name, qty: x.qty }))
        : [];
    accounts.push({ broker, name, isNew: !old, add, update, remove, cash: cashRow?.cash ?? null });
  }

  return { mode, accounts, skipped, rows: rows.length };
}

/** 실제로 적용한다 — `planImport` 가 그린 그대로 */
export async function applyImport(rows: ImportRow[], mode: ImportMode): Promise<{ plan: ImportPlan; accounts: ManualAccount[] }> {
  let have = await listAccounts();
  const plan = planImport(rows, [], have, mode);

  for (const a of plan.accounts) {
    let acc = have.find((x) => keyOf(x.broker, x.name) === keyOf(a.broker, a.name));
    if (!acc) {
      have = await addAccount(a.broker, a.name);
      acc = have.find((x) => keyOf(x.broker, x.name) === keyOf(a.broker, a.name));
      if (!acc) continue; // 이름이 비었거나 같은 계좌가 있어 안 만들어진 경우
    }
    /* 빼는 것부터 — 예수금 되돌림이 섞이지 않게 (manualAccounts 가 종목을 빼면 그 값을 예수금으로 옮긴다) */
    for (const r of a.remove) have = await removeHolding(acc.id, r.code);
    for (const h of [...a.add, ...a.update]) {
      have = await upsertHolding(acc.id, { code: h.code, name: h.name, qty: h.qty, avgPrice: h.avgPrice });
    }
    /* 예수금은 맨 끝 — 위에서 종목을 넣고 빼며 예수금이 저절로 움직였을 수 있는데, 파일에 적힌 값이 사람의 뜻이다 */
    if (a.cash !== null) have = await setCash(acc.id, a.cash);
  }

  return { plan, accounts: have };
}
