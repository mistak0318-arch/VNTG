import { Router } from "express";
import {
  addAccount,
  BROKERS,
  evaluateAccounts,
  listAccounts,
  removeAccount,
  removeHolding,
  setCash,
  depositCash,
  upsertHolding,
  reorderAccounts,
} from "../manualAccounts.js";
import { allHistory, dropHistory, recordSnapshot } from "../manualHistory.js";
import type { KiwoomClient } from "../kiwoomClient.js";
import { MIN, krxAfterMarket } from "../marketHours.js";
import { isTradingDay } from "../tradingDay.js";
import { peekSnapshot } from "../marketSnapshot.js";
import { listThemes } from "../customThemes.js";

const ACNT_RESOURCE = "/api/dostk/acnt";

function toWon(v: unknown): number {
  const n = Number(String(v ?? "").replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? Math.abs(n) : 0;
}

function signedNum(v: unknown): number {
  const n = Number(String(v ?? "").replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/**
 * **NXT 만 열린 시간엔 NXT 현재가로 다시 잰다** (2026-09-18 — 벤티지 08:48 캡처: 키움 앱 +214,694(+6.31%) vs 우리 +76,990(+2.26%)).
 *
 * kt00018 을 `dmst_stex_tp: KRX` 로 부르니 08:00~09:00·15:30~20:00 엔 **KRX 마지막 체결(어제 종가)** 로 평가가 나온다.
 * 키움 앱은 그 시간에 NXT 체결가로 보여 준다. 여기서 보유 종목의 통합(_AL) 현재가(ka10095)를 받아 **차이만큼 더한다** —
 * 평가손익·수익률은 키움 값(비용 포함)에 (새 값−옛 값)×수량을 얹는 식이라 비용을 두 번 빼지 않는다.
 * 정규장엔 손대지 않는다(KRX 값 그대로). 조회가 실패한 종목은 그대로 둔다.
 */
/**
 * **KRX 에 체결이 도는 시간인가** — 정규장 09:00~15:30 · 애프터마켓 16:00~20:00(9/14~).
 *
 * ⚠️ 처음엔 `venueOpen("KRX")` 로 물었는데 **그건 「주문을 받아 주나」이지 「체결이 도나」가 아니다.**
 * KRX 는 08:30 부터 개장 동시호가 주문을 받지만 체결은 09:00 이라, 08:30~09:00 에는 잔고의 KRX 현재가가
 * 여전히 **어제 종가**다. 그 사이 덮기가 꺼져 버려 키움 앱보다 손익이 과하게 나왔다
 * (2026-09-21 08:50 실측 — 우리 −1.86% vs 키움 −0.58%. 통합가로 다시 재니 −0.57% 로 맞았다).
 */
function krxTrading(now = new Date()): boolean {
  const d = new Date(now.getTime() + 9 * 3600_000);
  const date = d.toISOString().slice(0, 10);
  const minute = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (!isTradingDay(new Date(`${date}T12:00:00+09:00`))) return false;
  if (minute >= MIN.regularOpen && minute <= MIN.regularClose) return true;
  return krxAfterMarket(date, minute);
}

async function overlayNxtPrices(client: KiwoomClient, data: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (krxTrading()) return data;
  const list = Array.isArray(data.acnt_evlt_remn_indv_tot) ? (data.acnt_evlt_remn_indv_tot as Record<string, unknown>[]) : [];
  if (list.length === 0) return data;
  /*
   * **한 번에 받는다** (2026-09-21). 처음엔 보유 종목마다 ka10095 를 따로 불렀다 — 계좌 화면이 20초마다
   * 물으니 보유 열 종목이면 분당 서른 번이다. ka10095 는 `|` 로 여러 종목을 한 번에 준다(다른 곳과 같은 길).
   */
  const codes = [...new Set(list.map((r) => String(r.stk_cd ?? "").replace(/^A/, "").replace(/_.*$/, "")).filter((c) => /^\d{6}$/.test(c)))];
  const priced = new Map<string, number>();
  for (let i = 0; i < codes.length; i += 50) {
    try {
      const { data: q } = await client.request<Record<string, unknown>>("/api/dostk/stkinfo", "ka10095", {
        stk_cd: codes.slice(i, i + 50).map((c) => `${c}_AL`).join("|"),
      });
      const rows = Array.isArray(q.atn_stk_infr) ? (q.atn_stk_infr as Record<string, unknown>[]) : [];
      for (const row of rows) {
        const c = String(row.stk_cd ?? "").replace(/_(AL|NX)$/i, "");
        const p = toWon(row.cur_prc);
        if (c && p > 0) priced.set(c, p);
      }
    } catch {
      /* 이 묶음은 KRX 값 그대로 */
    }
  }
  let dEval = 0;
  const out: Record<string, unknown>[] = [];
  for (const r of list) {
    const code = String(r.stk_cd ?? "").replace(/^A/, "").replace(/_.*$/, "");
    const qty = toWon(r.rmnd_qty);
    const oldCur = toWon(r.cur_prc);
    const cur = priced.get(code) ?? oldCur;
    if (cur === oldCur || qty <= 0) {
      out.push(r);
      continue;
    }
    const delta = (cur - oldCur) * qty;
    const pnl = signedNum(r.evltv_prft) + delta;
    const pur = toWon(r.pur_amt) || toWon(r.pur_pric) * qty;
    out.push({
      ...r,
      cur_prc: String(cur),
      evlt_amt: String(toWon(r.evlt_amt) + delta),
      evltv_prft: String(pnl),
      prft_rt: pur > 0 ? ((pnl / pur) * 100).toFixed(2) : r.prft_rt,
      _basis: "통합",
    });
    dEval += delta;
  }
  if (dEval === 0) return { ...data, acnt_evlt_remn_indv_tot: out };
  const totPnl = signedNum(data.tot_evlt_pl) + dEval;
  const totPur = toWon(data.tot_pur_amt);
  return {
    ...data,
    acnt_evlt_remn_indv_tot: out,
    tot_evlt_amt: String(toWon(data.tot_evlt_amt) + dEval),
    tot_evlt_pl: String(totPnl),
    tot_prft_rt: totPur > 0 ? ((totPnl / totPur) * 100).toFixed(2) : data.tot_prft_rt,
    prsm_dpst_aset_amt: String(toWon(data.prsm_dpst_aset_amt) + dEval),
    _priceBasis: "통합",
  };
}

export function createAccountRouter(client: KiwoomClient): Router {
  const router = Router();

  // 예수금상세현황 (kt00001) - qry_tp 3:추정조회
  router.get("/deposit", async (_req, res, next) => {
    try {
      const { data } = await client.request(ACNT_RESOURCE, "kt00001", { qry_tp: "3" });
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  // 계좌평가현황 (kt00004) - qry_tp 0:전체
  router.get("/summary", async (_req, res, next) => {
    try {
      const { data } = await client.request(ACNT_RESOURCE, "kt00004", {
        qry_tp: "0",
        dmst_stex_tp: "KRX",
      });
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  // 계좌평가잔고내역 (kt00018) - 보유종목 리스트 + 총평가/총손익
  router.get("/holdings", async (req, res, next) => {
    try {
      const contYn = typeof req.query.cont_yn === "string" ? req.query.cont_yn : undefined;
      const nextKey = typeof req.query.next_key === "string" ? req.query.next_key : undefined;
      const { data, contYn: respContYn, nextKey: respNextKey } = await client.request<Record<string, unknown>>(
        ACNT_RESOURCE,
        "kt00018",
        { qry_tp: "1", dmst_stex_tp: "KRX" },
        { contYn, nextKey },
      );
      const shown = await overlayNxtPrices(client, data);
      res.json({ ...shown, cont_yn: respContYn, next_key: respNextKey });
    } catch (err) {
      next(err);
    }
  });

  /**
   * 보유 집중도 (2026-08-27 전수 점검에서 제안) — 「지금 어디에 몰려 있나」.
   *
   * 잔고(kt00018)를 업종·내 테마로 묶어 비중을 낸다. 업종은 시장 스냅샷의 배정을
   * 그대로 쓴다(peek — 배지 폴링처럼 여기서 스캔을 유발하지 않는다. 캐시가 아직
   * 없으면 「미분류」로 나올 뿐이다). 테마 비중은 한 종목이 여러 테마에 속할 수
   * 있어 합이 100%를 넘을 수 있다 — 화면이 그 사실을 같이 말한다.
   */
  router.get("/concentration", async (_req, res, next) => {
    try {
      const { data } = await client.request<Record<string, unknown>>(ACNT_RESOURCE, "kt00018", {
        qry_tp: "1",
        dmst_stex_tp: "KRX",
      });
      const raw = (data.acnt_evlt_remn_indv_tot ?? []) as Record<string, unknown>[];
      const snap = peekSnapshot();
      const themes = await listThemes().catch(() => []);

      const stocks = raw
        .map((r) => {
          const code = String(r.stk_cd ?? "")
            .replace(/^A/, "")
            .replace(/_AL$/, "");
          const value = toWon(r.evlt_amt);
          return {
            code,
            name: String(r.stk_nm ?? ""),
            value,
            sector: snap?.byCode.get(code)?.sector ?? "미분류",
            themes: themes.filter((t) => t.codes.includes(code)).map((t) => t.name),
          };
        })
        .filter((s) => s.value > 0)
        .sort((a, b) => b.value - a.value);
      const total = stocks.reduce((a, b) => a + b.value, 0);

      const group = (keysOf: (s: (typeof stocks)[number]) => string[]) => {
        const m = new Map<string, { value: number; count: number }>();
        for (const s of stocks) {
          for (const k of keysOf(s)) {
            const cur = m.get(k) ?? { value: 0, count: 0 };
            cur.value += s.value;
            cur.count += 1;
            m.set(k, cur);
          }
        }
        return [...m.entries()]
          .map(([name, v]) => ({
            name,
            value: v.value,
            count: v.count,
            weight: total > 0 ? (v.value / total) * 100 : 0,
          }))
          .sort((a, b) => b.value - a.value);
      };

      res.json({
        total,
        stocks: stocks.map((s) => ({
          ...s,
          weight: total > 0 ? (s.value / total) * 100 : 0,
        })),
        bySector: group((s) => [s.sector]),
        byTheme: group((s) => s.themes),
      });
    } catch (err) {
      next(err);
    }
  });

  // ---------------- 수동 계좌 (키움 외 증권사, 직접 입력) ----------------

  router.get("/manual/brokers", (_req, res) => {
    res.json({ brokers: BROKERS });
  });

  /*
   * **볼 때마다 오늘 한 점을 남긴다** (2026-09-14). 수동 계좌는 잔액 흐름을 줄 사람이 없어서
   * 우리가 쌓는 수밖에 없다 — 따로 스케줄러를 두는 대신 화면을 열 때 남긴다. 계좌를 안 보는
   * 날은 점이 빈다. 그날 값을 지어내느니 비는 편이 낫다.
   *
   * 기록 실패가 화면을 막지 않게 기다리지 않는다.
   */
  const evaluate = async () => {
    const accounts = await evaluateAccounts(client);
    void recordSnapshot(accounts).catch(() => undefined);
    return accounts;
  };

  /** 계좌별 총 잔액 흐름 — 그래프와 일·주·월 표가 이걸 본다 */
  router.get("/manual/history", async (_req, res, next) => {
    try {
      res.json({ history: await allHistory() });
    } catch (err) {
      next(err);
    }
  });

  /** 평가금액·수익률은 저장값이 아니라 조회 시점에 계산한다 */
  router.get("/manual", async (_req, res, next) => {
    try {
      res.json({ accounts: await evaluate() });
    } catch (err) {
      next(err);
    }
  });

  router.post("/manual", async (req, res, next) => {
    try {
      const { broker, name } = req.body ?? {};
      await addAccount(String(broker ?? ""), String(name ?? ""));
      res.json({ accounts: await evaluate() });
    } catch (err) {
      next(err);
    }
  });

  /* 계좌 차례 (2026-09-16). ⚠️ `/manual/:id` 류보다 앞 — 뒤에 두면 "order" 를 id 로 먹는다 */
  router.put("/manual/order", async (req, res, next) => {
    try {
      const ids = Array.isArray((req.body as { ids?: unknown }).ids) ? ((req.body as { ids: unknown[] }).ids as unknown[]).map(String) : [];
      await reorderAccounts(ids);
      res.json({ accounts: await evaluate() });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/manual/:id", async (req, res, next) => {
    try {
      await removeAccount(req.params.id);
      await dropHistory(req.params.id);
      res.json({ accounts: await evaluate() });
    } catch (err) {
      next(err);
    }
  });

  /** 예수금 입력 — 수동 계좌는 현금을 받아올 방법이 없어 직접 적는다 */
  router.put("/manual/:id/cash", async (req, res, next) => {
    try {
      /* anchor: "total" 이면 총자산을 붙박이로 — 예수금은 주식평가액을 빼서 낸다 (2026-09-08) */
      const anchor = req.body?.anchor === "total" ? "total" : "cash";
      await setCash(req.params.id, Number(req.body?.cash), anchor);
      res.json({ accounts: await evaluate() });
    } catch (err) {
      next(err);
    }
  });

  /** 입금·출금 — 계좌 밖에서 돈이 드나든 것만. 종목을 담고 빼는 것은 여기가 아니다 */
  router.post("/manual/:id/deposit", async (req, res, next) => {
    try {
      await depositCash(req.params.id, Number(req.body?.delta));
      res.json({ accounts: await evaluate() });
    } catch (err) {
      next(err);
    }
  });

  router.post("/manual/:id/holdings", async (req, res, next) => {
    try {
      const { code, name, avgPrice, qty, boughtAt } = req.body ?? {};
      await upsertHolding(req.params.id, {
        code: String(code ?? ""),
        name: String(name ?? code ?? ""),
        avgPrice: Number(avgPrice) || 0,
        qty: Number(qty) || 0,
        /* 「YYYY-MM-DD」만 받는다 — 빈 값이면 안 보낸 것으로 본다 */
        boughtAt: /^\d{4}-\d{2}-\d{2}$/.test(String(boughtAt ?? "")) ? String(boughtAt) : undefined,
      });
      res.json({ accounts: await evaluate() });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/manual/:id/holdings/:code", async (req, res, next) => {
    try {
      await removeHolding(req.params.id, req.params.code);
      res.json({ accounts: await evaluate() });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
