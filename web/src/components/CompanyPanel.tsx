import { fmtNum, pick, type RawRecord } from "../api";
import { CompanySnapshot, type PeriodReturns } from "./CompanySnapshot";
import { FinancePanel } from "./FinancePanel";

/**
 * 기업·재무 — **한 탭으로 합쳤다** (2026-08-25).
 *
 * 「기업분석」(ka10001 지표 16칸)과 「재무」(DART 연간 + 한투 분기·추정)가 딴 탭이라
 * 같은 질문(이 회사 벌고 있나)에 두 번 들어가야 했다. 합치고 **위에서 아래로 결론 →
 * 근거** 순서로 세운다:
 *
 *   1. 한 줄 진단   「영업이익이 좋아지고 있다 — 전년 동기 대비 +34%」 (FinancePanel 안)
 *   2. 핵심 지표 칩  PER·PBR·ROE·시총·외국인비중 — 16칸 격자에서 늘 보는 여섯 개만
 *   3. 추정 → 분기 → 연간 (기존 재무 본문 그대로)
 *   4. 전체 지표·기간 수익률 — 접어 둔다. EPS·BPS·액면가는 매번 볼 값이 아니다
 *
 * `info` 는 부르는 쪽이 이미 폴링 중인 ka10001 응답을 그대로 받는다 — 조회가 늘지 않는다.
 */

function chip(info: RawRecord, key: string, label: string, suffix = ""): { k: string; v: string } | null {
  const raw = pick(info, [key]);
  const v = fmtNum(raw);
  if (v === "-" || v === "" || v === "0") return null;
  return { k: label, v: `${v}${suffix}` };
}

function KeyChips({ info }: { info: RawRecord }) {
  const mac = Number(String(pick(info, ["mac"])).replace(/,/g, ""));
  const chips = [
    chip(info, "per", "PER", "배"),
    chip(info, "pbr", "PBR", "배"),
    chip(info, "roe", "ROE", "%"),
    // 시총은 억이 여덟 자리면 안 읽힌다 — 조로 끊는다
    Number.isFinite(mac) && mac > 0
      ? { k: "시가총액", v: mac >= 10_000 ? `${(mac / 10_000).toFixed(1)}조` : `${fmtNum(mac)}억` }
      : null,
    chip(info, "for_exh_rt", "외국인", "%"),
    chip(info, "crd_rt", "신용", "%"),
  ].filter((c): c is { k: string; v: string } => c !== null);
  if (chips.length === 0) return null;
  return (
    <div className="co-chips">
      {chips.map((c) => (
        <span className="co-chip" key={c.k}>
          <em>{c.k}</em>
          <b>{c.v}</b>
        </span>
      ))}
    </div>
  );
}

export function CompanyPanel({
  code,
  info = null,
  returns = null,
}: {
  code: string;
  /** ka10001 — 부르는 쪽이 이미 들고 있는 것. 없으면 칩·전체 지표만 빠진다 */
  info?: RawRecord | null;
  returns?: PeriodReturns | null;
}) {
  return (
    <div>
      <FinancePanel code={code} afterVerdict={info ? <KeyChips info={info} /> : undefined} />
      {info && (
        <details className="fold-note">
          <summary>전체 지표 · 기간 수익률 (EPS·BPS·52주 고저 등)</summary>
          <CompanySnapshot info={info} returns={returns} />
        </details>
      )}
    </div>
  );
}
