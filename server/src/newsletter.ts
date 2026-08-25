import { evaluateThemes } from "./customThemes.js";
import { indexDetail } from "./indexDetail.js";
import { listScreenRuns } from "./signalScreen.js";
import type { KiwoomClient } from "./kiwoomClient.js";
import type { PublishedReport } from "./reportStore.js";

/**
 * 뉴스레터 HTML — **한 장으로 읽는 리포트.**
 *
 * ## 왜 따로 만드나
 *
 * 메일로 나가던 건 **AI 요약 글뿐**이었다. 그런데 아침에 실제로 보는 건 글이 아니라
 * 숫자다 — 지수가 얼마고 돈이 얼마나 돌았고 내 테마 중 뭐가 셌나. 그걸 보려면
 * 결국 앱을 열어야 했고, 그러면 메일이 「앱을 열라는 알림」밖에 안 된다.
 *
 * ## 조회를 새로 안 쓴다
 *
 * 지수 일봉(하루 캐싱), 내 테마(전종목 스냅샷 재사용), 신호등 찾기 지난 기록 —
 * 셋 다 이미 있는 것이다. 뉴스레터를 만든다고 키움을 더 부르지 않는다.
 *
 * ## 메일은 CSS 를 못 믿는다
 *
 * 메일 클라이언트마다 지원이 제각각이라 **인라인 스타일만** 쓴다. 표도 `<table>` 로
 * 짠다 — flex/grid 는 아웃룩에서 통째로 무너진다. 다크모드도 안 잡는다(클라이언트가
 * 알아서 뒤집는다).
 */

const A = "#c0392b"; // 오름 — 국내 관행대로 빨강
const B = "#1c6dd0"; // 내림
const INK = "#1b2430";
const MUTED = "#5b6673";
const LINE = "#d7dee7";

function esc(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function pct(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "-";
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function color(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n === 0) return MUTED;
  return n > 0 ? A : B;
}

function section(title: string, inner: string): string {
  if (!inner) return "";
  return `<h3 style="margin:22px 0 8px;padding-left:8px;border-left:3px solid ${B};font-size:15px;color:${INK};">${esc(title)}</h3>${inner}`;
}

function row(cells: string[]): string {
  return `<tr>${cells.join("")}</tr>`;
}

function td(html: string, extra = ""): string {
  return `<td style="padding:5px 8px;border-bottom:1px solid ${LINE};font-size:13px;${extra}">${html}</td>`;
}

/**
 * 지수 — **거래대금을 같이 적는다.**
 *
 * 지수 %만 적으면 「오른 날」과 「돈이 들어온 날」이 똑같이 생긴다. 거래대금이 줄면서
 * 오른 건 팔 사람이 없어서 오른 것이라 힘이 없다. 그 둘은 아침에 갈라 봐야 하는 값이다.
 */
/** 지금이 장중인가 — 진행 중인 날은 어제 하루치와 견줄 수 없다 */
function marketRunning(now = new Date()): { running: boolean; today: string } {
  const kst = new Date(now.getTime() + 9 * 3600_000);
  const today = kst.toISOString().slice(0, 10).replace(/-/g, "");
  const mins = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  const weekday = kst.getUTCDay() !== 0 && kst.getUTCDay() !== 6;
  return { running: weekday && mins >= 9 * 60 && mins < 15 * 60 + 30, today };
}

async function indexTable(client: KiwoomClient): Promise<string> {
  const rows: string[] = [];
  const now = marketRunning();
  for (const [code, name] of [
    ["001", "코스피"],
    ["101", "코스닥"],
  ] as const) {
    try {
      const d = await indexDetail(client, code, "day");
      const cs = d.candles;
      if (cs.length < 2) continue;
      const last = cs[cs.length - 1];
      const prev = cs[cs.length - 2];
      /** 마지막 봉이 오늘이고 장이 아직 안 끝났나 */
      const running = now.running && last.dt === now.today;
      const rate = prev.close > 0 ? ((last.close - prev.close) / prev.close) * 100 : 0;
      /*
       * ⚠️ **진행 중인 날은 어제와 못 견준다.**
       *
       * 10시에 재면 오늘은 한 시간치이고 어제는 하루치다. 그대로 나누면 「−62%」가
       * 뜨는데 그건 거래가 줄어든 게 아니라 **아직 안 끝난 것**이다.
       * 그럴 땐 퍼센트 대신 「진행 중」이라 적는다.
       */
      const tvRate =
        !running && prev.tradeValue > 0
          ? ((last.tradeValue - prev.tradeValue) / prev.tradeValue) * 100
          : null;
      rows.push(
        row([
          td(`<b>${name}</b>`),
          td(`<b>${last.close.toFixed(2)}</b>`, "text-align:right;"),
          td(`<b style="color:${color(rate)}">${pct(rate)}</b>`, "text-align:right;"),
          td(
            `${(last.tradeValue / 10000).toFixed(1)}조` +
              (running
                ? ` <span style="color:${MUTED};font-size:12px;">(진행 중)</span>`
                : tvRate === null
                  ? ""
                  : ` <span style="color:${color(tvRate)};font-size:12px;">(${pct(tvRate)})</span>`),
            "text-align:right;",
          ),
        ]),
      );
    } catch {
      /* 하나가 실패해도 나머지는 낸다 */
    }
  }
  if (rows.length === 0) return "";
  return `<table style="width:100%;border-collapse:collapse;">
    ${row([
      td("지수", `color:${MUTED};font-size:12px;`),
      td("종가", `color:${MUTED};font-size:12px;text-align:right;`),
      td("등락", `color:${MUTED};font-size:12px;text-align:right;`),
      td("거래대금", `color:${MUTED};font-size:12px;text-align:right;`),
    ])}
    ${rows.join("")}
  </table>
  <div style="font-size:11px;color:${MUTED};margin-top:4px;">괄호는 전일 대비 거래대금 증감입니다. 지수가 올라도 돈이 줄면 힘이 없는 상승입니다.</div>`;
}

/** 내 테마 — 위아래 셋씩. 가운데는 볼 이유가 없다 */
async function themeTable(client: KiwoomClient): Promise<string> {
  let themes: { name: string; changeRate: number | null }[] = [];
  try {
    /* 전종목 스냅샷을 그대로 쓴다(`force` 안 함) — 뉴스레터가 조회를 늘리면 안 된다 */
    themes = (await evaluateThemes(client)).themes
      .filter((t) => t.changeRate !== null)
      .sort((a, b) => (b.changeRate ?? 0) - (a.changeRate ?? 0))
      .map((t) => ({ name: t.name, changeRate: t.changeRate }));
  } catch {
    return "";
  }
  if (themes.length === 0) return "";
  const top = themes.slice(0, 3);
  const bottom = themes.slice(-3).reverse();
  const line = (t: { name: string; changeRate: number | null }) =>
    row([
      td(esc(t.name)),
      td(`<b style="color:${color(t.changeRate)}">${pct(t.changeRate)}</b>`, "text-align:right;"),
    ]);
  return `<table style="width:100%;border-collapse:collapse;">
    ${row([td("강한 쪽", `color:${MUTED};font-size:12px;`), td("", "")])}
    ${top.map(line).join("")}
    ${row([td("약한 쪽", `color:${MUTED};font-size:12px;padding-top:12px;`), td("", "")])}
    ${bottom.map(line).join("")}
  </table>`;
}

/** 신호등 찾기 — 마지막으로 돌린 결과. 새로 돌리지 않는다(몇 분 걸리는 일이다) */
async function signalBlock(): Promise<string> {
  try {
    const runs = await listScreenRuns();
    const last = runs[0];
    if (!last) return "";
    const when = new Date(last.at);
    return `<div style="font-size:13px;color:${INK};">
      마지막 검사 <b>${when.toISOString().slice(5, 10)}</b> · ${last.total}종목 중
      <b style="color:${A};">${last.hits}종목</b> 통과
    </div>
    <div style="font-size:11px;color:${MUTED};margin-top:4px;">앱에서 다시 돌리면 오늘 기준으로 갱신됩니다.</div>`;
  } catch {
    return "";
  }
}

/** AI 요약 글 — 기존 메일과 같은 모양 */
function summaryBlock(r: PublishedReport): string {
  const text = r.summary.text ?? "";
  if (!text.trim()) return "";
  return text
    .split("\n")
    .map((raw) => {
      const line = raw.trim();
      if (!line) return "";
      if (line.startsWith("## ")) {
        return `<div style="margin:14px 0 4px;font-weight:700;font-size:14px;color:${INK};">${esc(line.slice(3))}</div>`;
      }
      const html = esc(line).replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
      if (/^[-*•]\s/.test(line) || /^\d+\.\s/.test(line)) {
        return `<div style="margin:3px 0 3px 12px;color:#333;font-size:13px;line-height:1.7;">· ${html.replace(/^([-*•]|\d+\.)\s/, "")}</div>`;
      }
      return `<p style="margin:5px 0;line-height:1.7;color:#333;font-size:13px;">${html}</p>`;
    })
    .join("");
}

/**
 * 한 장짜리 뉴스레터를 만든다.
 *
 * 어느 조각이 실패해도 **나머지는 낸다** — 테마 하나 못 받았다고 빈 메일이 가면 안 된다.
 */
export async function newsletterHtml(
  client: KiwoomClient,
  r: PublishedReport,
): Promise<string> {
  const [indices, themes, signal] = await Promise.all([
    indexTable(client).catch(() => ""),
    themeTable(client).catch(() => ""),
    signalBlock().catch(() => ""),
  ]);
  const when = new Date(r.publishedAt).toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  return `<div style="max-width:680px;margin:0 auto;font-family:-apple-system,'Malgun Gothic',sans-serif;background:#fff;">
  <div style="border-bottom:2px solid ${B};padding-bottom:10px;margin-bottom:8px;">
    <div style="font-size:20px;font-weight:700;color:${INK};">VNTG 데일리 리포트</div>
    <div style="font-size:13px;color:${MUTED};margin-top:4px;">${esc(r.date)} ${esc(r.label)} · ${when} 발행</div>
  </div>
  ${section("지수", indices)}
  ${section("내 테마", themes)}
  ${section("신호등", signal)}
  ${section("요약", summaryBlock(r))}
  <div style="margin-top:24px;padding-top:12px;border-top:1px solid ${LINE};font-size:11px;color:#8b96a5;line-height:1.6;">
    조회 전용 도구입니다. <b>이 메일은 매매 판단의 근거가 아닙니다.</b><br/>
    요약은 AI 가 시장 데이터를 정리한 것입니다 — 모델 ${esc(r.summary.model)}.
  </div>
</div>`;
}
