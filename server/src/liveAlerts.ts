import { getAlertConfig } from "./alertRules.js";
import { peekRealtime } from "./realtimeHub.js";
import { sendTelegram, stockNameHtml } from "./telegram.js";
import { listWatchlist } from "./watchlist.js";

/**
 * 실시간에서 바로 꺼내는 알림 — **VI 발동**과 **체결강도 급변**.
 *
 * ## 왜 따로 뒀나
 *
 * 다른 시그널(급변·거래량·수급 전환)은 종목마다 조회를 부른다. 관심종목이 서른 개면
 * 한 번 검사에 아흔 콜이라 10분 간격을 지켜야 한다.
 *
 * 그런데 이 둘은 **이미 물고 있는 실시간 스트림에 값이 들어 있다.** 조회가 0 이다.
 * 그래서 **1분마다** 본다 — VI 는 몇 초 뒤에 알면 이미 풀려 있고, 체결강도 급변도
 * 10분 뒤에 받으면 그 자리는 지나간 뒤다.
 *
 * ## ⚠️ 관심종목만
 *
 * VI 는 하루에 483건이 걸린다(실측). 전부 보내면 **그 방을 안 보게 된다** —
 * 그건 알림 셋을 통째로 죽이는 짓이다. 그래서 **내 관심종목에 걸린 것만** 보낸다.
 *
 * ## 실시간이 끊겨 있으면
 *
 * **아무 말도 안 한다.** 「VI 없음」이라고 하면 안 걸린 것인지 못 받은 것인지 구별이
 * 안 된다. 실시간 상태는 설정 화면이 따로 보여준다.
 */

/** 체결강도 FID */
const FID_STRENGTH = "228";

/** 오늘 이미 보낸 것 — `날짜:종류:종목:키` */
const sent = new Set<string>();
/** 종목별 직전 체결강도 — 「뛰었나」를 보려면 이전 값이 있어야 한다 */
const lastStrength = new Map<string, number>();

function kstDay(now = new Date()): string {
  return new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}

function num(v: unknown): number {
  const n = Number(String(v ?? "").replace(/[+,\s]/g, ""));
  return Number.isFinite(n) ? Math.abs(n) : NaN;
}

export interface LiveAlert {
  kind: "vi" | "strength";
  code: string;
  name: string;
  detail: string;
}

/**
 * 한 번 본다.
 *
 * @param opts.send 거짓이면 찾기만 하고 안 보낸다. **상태도 안 남긴다** —
 *   미리보기가 진짜 알림을 잡아먹으면 안 된다.
 */
export async function runLiveAlerts(
  opts: { send?: boolean } = {},
): Promise<{ alerts: LiveAlert[]; sent: boolean; live: boolean }> {
  const { store } = peekRealtime();
  // 실시간이 안 붙어 있으면 아무 말도 안 한다 — 「없음」과 「못 받음」은 다르다
  if (!store) return { alerts: [], sent: false, live: false };

  const cfg = await getAlertConfig();
  if (!cfg.enabled) return { alerts: [], sent: false, live: true };
  const rules = new Map(cfg.rules.filter((r) => r.enabled).map((r) => [r.key, r]));

  const watch = await listWatchlist();
  const mine = new Map(watch.filter((w) => !w.divider).map((w) => [w.code, w.name]));
  if (mine.size === 0) return { alerts: [], sent: false, live: true };

  const day = kstDay();
  const preview = opts.send === false;
  const out: LiveAlert[] = [];

  /* ── VI 발동 ─────────────────────────────────────────────── */
  if (rules.has("viHit")) {
    for (const v of store.getVi(200)) {
      const name = mine.get(v.code);
      if (!name) continue; // 관심종목이 아니면 안 본다 (하루 483건이 걸린다)
      /*
       * 같은 종목이 하루에 여러 번 걸릴 수 있다. **발동 시각까지 키에 넣어** 같은
       * 발동을 두 번 안 보내되, 새 발동은 새로 보낸다.
       */
      const key = `${day}:vi:${v.code}:${v.at}`;
      if (sent.has(key)) continue;
      if (!preview) sent.add(key);
      out.push({
        kind: "vi",
        code: v.code,
        name,
        detail: `VI 발동${v.kind ? ` (${v.kind})` : ""}`,
      });
    }
  }

  /* ── 체결강도 급변 ───────────────────────────────────────── */
  const jump = rules.get("strengthJump");
  if (jump) {
    for (const [code, name] of mine) {
      const tick = store.getLatest("0B", code);
      const now = num(tick?.values?.[FID_STRENGTH]);
      if (!Number.isFinite(now) || now <= 0) continue;

      const before = lastStrength.get(code);
      lastStrength.set(code, now);
      if (before === undefined) continue; // 첫 값은 견줄 데가 없다

      /*
       * **뛴 폭과 자리를 같이 본다.**
       * 60 → 95 는 35 나 뛰었지만 여전히 파는 쪽이 세다. 100 을 넘겨야 「사는 쪽이
       * 이기기 시작했다」는 말이 된다 — 그게 이 알림이 말하려는 것이다.
       */
      if (now - before < jump.threshold || now < 100) continue;

      // 한 번 뛰면 그 근처에서 오르내린다. 종목당 하루 한 번이면 충분하다
      const key = `${day}:str:${code}`;
      if (sent.has(key)) continue;
      if (!preview) sent.add(key);
      out.push({
        kind: "strength",
        code,
        name,
        detail: `체결강도 ${before.toFixed(0)} → ${now.toFixed(0)} (사는 쪽이 세짐)`,
      });
    }
  }

  if (out.length === 0 || preview) return { alerts: out, sent: false, live: true };

  const res = await sendTelegram(formatLiveAlerts(out), "signal");
  return { alerts: out, sent: res.ok, live: true };
}

export function formatLiveAlerts(alerts: LiveAlert[]): string {
  const vi = alerts.filter((a) => a.kind === "vi");
  const st = alerts.filter((a) => a.kind === "strength");
  const parts: string[] = [];
  // 종목명이 딥링크다 — 알림에서 한 번 눌러 개별종목분석으로 (HTS_WEB_URL 설정 시)
  const line = (a: LiveAlert) => `• ${stockNameHtml(a.code, a.name)} — ${a.detail}`;
  if (vi.length > 0) {
    parts.push(`⚡ VI 발동 (${vi.length}건)\n` + vi.map(line).join("\n"));
  }
  if (st.length > 0) {
    parts.push(`📈 체결강도 급변 (${st.length}건)\n` + st.map(line).join("\n"));
  }
  return parts.join("\n\n");
}

/** 날짜가 바뀌면 어제 것은 잊는다 */
export function pruneLiveAlerts(now = new Date()): void {
  const day = kstDay(now);
  for (const k of sent) {
    if (!k.startsWith(`${day}:`)) sent.delete(k);
  }
}
