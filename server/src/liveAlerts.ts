import { getAlertConfig } from "./alertRules.js";
import { peekRealtime } from "./realtimeHub.js";
import { viDirText } from "./realtimeStore.js";
import { getActiveSuper } from "./superSignal.js";
import { hasDedicatedChannel, sendTelegram, stockNameHtml } from "./telegram.js";
import { pushNotice, stockLink } from "./notifyCenter.js";
import { alertTargets } from "./alertScheduler.js";

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
  /** 숫자만 압축한 꼬리 — 알림 제목에 붙는다 (「▲상방 81,000 10:12」·「120→155 · 주가 +4.2%」) */
  brief: string;
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

  /* 시그널 스캔과 같은 대상 — 점수대 자동 그룹만 든 종목은 기본으로 안 본다 (2026-09-03) */
  const watch = await alertTargets();
  const mine = new Map(watch.map((w) => [w.code, w.name]));
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
      /*
       * 「VI 발동」 넉 자로는 폰에서 판단이 안 된다 — 언제·어느 가격에서 걸렸는지가
       * 있어야 지나간 것인지 지금 것인지 안다. 전부 이미 받은 이벤트에 있는 값이다.
       */
      const hhmm = v.at?.length >= 4 ? `${v.at.slice(0, 2)}:${v.at.slice(2, 4)}` : "";
      /*
       * **방향을 맨 앞에** (2026-09-03 — 벤티지: "VI 발동 알람오는데 상방인지 하방인지 표시가
       * 안되네"). 기준가·괴리율로 못 정하면 마지막 단서로 그 종목의 **지금 등락률**(0B 의 FID 12)
       * 부호를 쓴다 — 급등해서 걸렸으면 +, 급락이면 - 다. 그것도 없으면 「방향 ?」라고 적는다.
       */
      let dir = viDirText(v);
      if (!dir) {
        const rate = Number(String(store.getLatestKrx("0B", v.code)?.values?.["12"] ?? "").replace(/[,\s]/g, ""));
        if (Number.isFinite(rate) && rate !== 0) dir = `${rate > 0 ? "▲상방" : "▼하방"} (오늘 ${rate > 0 ? "+" : ""}${rate.toFixed(1)}%)`;
      }
      const bits = [
        `${dir ? dir.slice(0, 3) : "방향 ?"} VI 발동${hhmm ? ` ${hhmm}` : ""}`,
        dir ? dir.slice(4) : "",
        v.apply || v.kind || "",
        v.price > 0 ? `발동가 ${Math.round(v.price).toLocaleString("ko-KR")}` : "",
      ].filter(Boolean);
      out.push({
        kind: "vi",
        code: v.code,
        name,
        detail: bits.join(" · "),
        brief: `${dir ? dir.slice(0, 3) : "방향 ?"}${v.price > 0 ? ` ${Math.round(v.price).toLocaleString("ko-KR")}` : ""}${hhmm ? ` ${hhmm}` : ""}`,
      });
    }
  }

  /* ── 체결강도 급변 ───────────────────────────────────────── */
  const jump = rules.get("strengthJump");
  if (jump) {
    for (const [code, name] of mine) {
      /* 체결강도도 **KRX 만** — 얇은 NXT 체결이 강도를 튀게 한다 (2026-08-31) */
      const tick = store.getLatestKrx("0B", code);
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
      /* 지금 등락률도 같이 — 체결강도만으로는 오르는 중인지 모른다 */
      const rate = num(store.getLatestKrx("0B", code)?.values?.["12"]);
      const ratePart = Number.isFinite(rate) && rate !== 0 ? ` · 주가 ${rate > 0 ? "+" : ""}${rate.toFixed(1)}%` : "";
      out.push({
        kind: "strength",
        code,
        name,
        detail: `체결강도 ${before.toFixed(0)} → ${now.toFixed(0)} (사는 쪽이 세짐, 기준 +${jump.threshold})${ratePart}`,
        brief: `${before.toFixed(0)}→${now.toFixed(0)}${ratePart}`,
      });
    }
  }

  if (out.length === 0 || preview) return { alerts: out, sent: false, live: true };

  /* 슈퍼신호등 전용 방이 있으면 슈퍼 종목 건은 그 방으로 — 시그널 스캔과 같은 규칙 */
  let superCodes = new Set<string>();
  if (hasDedicatedChannel("super")) {
    const list = await getActiveSuper().catch(() => [] as { code: string }[]);
    superCodes = new Set(list.map((s) => s.code));
  }
  const superOnes = out.filter((a) => superCodes.has(a.code));
  const rest = out.filter((a) => !superCodes.has(a.code));
  /*
   * **알림함에는 종목마다** (2026-09-03 — 벤티지: "체결강도 급변 알람이 오는데 이거 바로가기
   * 누르면 각 종목 상시로 가야하는거 아닌가? 아무 반응도 없어").
   *
   * 예전엔 한 줄로 묶고 `#/watchlist` 로 보냈는데, ① 그 탭은 앱에 없다(관심종목은 `watchAi`) —
   * 그래서 눌러도 아무 일이 없었고 ② 묶으면 종목으로 갈 수가 없다. 관심종목만 보는 알림이라
   * 하루 몇 건이다 — 종목마다 남기고 **그 종목 분석 화면**으로 바로 보낸다.
   * (`#/{tab}?code=&name=` 이 이 앱의 종목 딥링크 형식 — `useHashRoute`)
   */
  for (const a of out) {
    await pushNotice({
      source: "live",
      kind: "stock",
      level: "warn",
      /* 제목에 숫자까지 — 열지 않고 판단하라고 있는 것이 알림이다 (2026-09-03 전수 점검) */
      title: `${a.name} ${a.kind === "vi" ? "VI" : "체결강도"} ${a.brief}`,
      body: a.detail,
      code: a.code,
      name: a.name,
      link: stockLink(a.code, a.name),
      dedupeKey: `live:${a.code}:${a.kind}:${a.kind === "vi" ? a.detail.slice(0, 16) : day}`,
      dedupeHours: 2,
    }).catch(() => undefined);
  }

  let ok = true;
  if (superOnes.length > 0) ok = (await sendTelegram(formatLiveAlerts(superOnes), "super")).ok && ok;
  if (rest.length > 0) ok = (await sendTelegram(formatLiveAlerts(rest), "signal")).ok && ok;
  return { alerts: out, sent: ok, live: true };
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
