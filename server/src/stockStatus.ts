/**
 * 종목 **상태 플래그** — 공매도 과열·투자주의/경고/위험·단기과열·관리·거래정지… (2026-09-10).
 *
 * 벤티지: "이 종목이 오늘 투자주의인지 경고인지 투자주의 예고인지 이런 거를 표시해줘야 이제
 * 거래하기 전에 내가 참고할 수 있겠지. 증권플러스에서 하고 있는 거 보이지?"
 *
 * 세 출처를 합친다 — 하나로는 모자란다.
 * 1. **한투 주식현재가 시세2** (`FHPST01010000`): 공매도과열(`ssts_hot_yn`)·단기과열·시장경고
 *    (주의/경고/위험)·투자유의·이상급등·저유동성·불성실공시·거래정지·정리매매·관리종목을 **한 방에**,
 *    그것도 **당일 낮에** 준다(우리기술 09-10 실측 `ssts_hot_yn: Y`). 종목당 1건이라 화면에 뜬
 *    종목만 묻고 10분 캐시.
 * 2. **키움 종목목록** (`ka10099` auditInfo): 관리·경고·주의·거래정지·단기과열 — 하루 캐시라
 *    한투가 죽었을 때의 뒷받침.
 * 3. **KIND 시장조치 공시** (krxNotices): 「예고」(투자경고 지정예고·단기과열 지정예고)는 플래그가
 *    아니라 공시에만 있다. 지정 공시의 날짜·원문 링크도 여기서 붙인다.
 */
import { hantooGet, hantooReady } from "./hantooClient.js";
import type { KiwoomClient } from "./kiwoomClient.js";
import { getStockIndex } from "./stockListCache.js";
import { activeMeasures, KIND_LABEL, type NoticeKind } from "./krxNotices.js";

export type FlagKind =
  | NoticeKind
  | "runup" // 이상급등
  | "lowLiquidity" // 저유동성
  | "unfaithful" // 불성실공시
  | "liquidation" // 정리매매
  | "vi"; // VI 발동 중

export interface StatusFlag {
  kind: FlagKind;
  label: string;
  /** 한 줄 설명 — 「오늘 공매도 금지」처럼 거래에 무슨 뜻인지 */
  desc: string;
  /** 위험 정도 — 배너 색 */
  level: "danger" | "warn" | "info";
  source: ("hantoo" | "kiwoom" | "kind")[];
  /** KIND 공시가 있으면 날짜·링크 */
  since?: string;
  acptNo?: string | null;
}

const DESC: Record<FlagKind, { label: string; desc: string; level: StatusFlag["level"] }> = {
  shortOverheat: { label: "공매도 과열종목", desc: "오늘 공매도 금지 종목이에요 — 지정 다음 거래일 하루 금지", level: "warn" },
  overheat: { label: "단기과열종목", desc: "3거래일 동안 30분 단일가매매로만 체결돼요", level: "warn" },
  overheatNotice: { label: "단기과열 지정 예고", desc: "내일도 요건에 걸리면 단일가매매로 바뀌어요", level: "info" },
  warning: { label: "투자경고종목", desc: "신용거래 제한·위탁증거금 100% — 급등 뒤 지정, 해제까지 보통 10거래일", level: "danger" },
  warningNotice: { label: "투자경고 지정 예고", desc: "내일 또 오르면 투자경고로 지정돼요", level: "warn" },
  danger: { label: "투자위험종목", desc: "매매거래정지가 걸릴 수 있어요 — 가장 강한 경고", level: "danger" },
  caution: { label: "투자주의종목", desc: "소수계좌 거래집중·매수관여 과다 등 — 하루짜리 주의", level: "info" },
  managed: { label: "관리종목", desc: "상장폐지 사유 발생 — 신용 불가·단일가매매일 수 있어요", level: "danger" },
  halt: { label: "매매거래정지", desc: "지금 거래가 안 돼요", level: "danger" },
  release: { label: "해제", desc: "", level: "info" },
  market: { label: "거래소", desc: "", level: "info" },
  company: { label: "공시", desc: "", level: "info" },
  runup: { label: "이상급등종목", desc: "거래소가 이상급등으로 봐요 — 투자경고 전 단계", level: "warn" },
  lowLiquidity: { label: "저유동성종목", desc: "거래가 뜸해 호가가 벌어질 수 있어요", level: "info" },
  unfaithful: { label: "불성실공시법인", desc: "공시 위반 이력 — 관리종목 지정 사유가 될 수 있어요", level: "warn" },
  liquidation: { label: "정리매매", desc: "상장폐지 전 정리매매 중 — 가격제한폭 없음", level: "danger" },
  vi: { label: "VI 발동 중", desc: "변동성완화장치 — 2분 단일가", level: "info" },
};

interface HantooFlags {
  at: number;
  flags: Set<FlagKind>;
}
const hantooCache = new Map<string, HantooFlags>();
const HANTOO_TTL = 10 * 60_000;

async function hantooFlags(code: string): Promise<Set<FlagKind> | null> {
  if (!hantooReady()) return null;
  const hit = hantooCache.get(code);
  if (hit && Date.now() - hit.at < HANTOO_TTL) return hit.flags;
  try {
    const body = await hantooGet<{ output?: Record<string, unknown> }>(
      "/uapi/domestic-stock/v1/quotations/inquire-price-2",
      "FHPST01010000",
      { FID_COND_MRKT_DIV_CODE: "J", FID_INPUT_ISCD: code },
      "종목 상태",
    );
    const o = body.output ?? {};
    const y = (k: string) => String(o[k] ?? "").trim() === "Y";
    const flags = new Set<FlagKind>();
    if (y("ssts_hot_yn")) flags.add("shortOverheat");
    if (y("short_over_yn")) flags.add("overheat");
    const warn = String(o.mrkt_warn_cls_code ?? "").trim();
    if (warn === "01") flags.add("caution");
    if (warn === "02") flags.add("warning");
    if (warn === "03") flags.add("danger");
    if (y("invt_caful_yn")) flags.add("caution");
    if (y("stange_runup_yn")) flags.add("runup");
    if (y("low_current_yn")) flags.add("lowLiquidity");
    if (y("insn_pbnt_yn")) flags.add("unfaithful");
    if (y("trht_yn")) flags.add("halt");
    if (y("sltr_yn")) flags.add("liquidation");
    if (y("mang_issu_yn")) flags.add("managed");
    if (y("vi_cls_code")) flags.add("vi");
    hantooCache.set(code, { at: Date.now(), flags });
    if (hantooCache.size > 2000) hantooCache.clear();
    return flags;
  } catch {
    return null;
  }
}

/** 키움 auditInfo 글자 → 플래그 */
function kiwoomFlags(audit: string | undefined): Set<FlagKind> {
  const s = new Set<FlagKind>();
  const a = String(audit ?? "");
  if (/관리/.test(a)) s.add("managed");
  if (/투자경고/.test(a)) s.add("warning");
  if (/투자위험/.test(a)) s.add("danger");
  if (/투자주의/.test(a)) s.add("caution");
  if (/거래정지/.test(a)) s.add("halt");
  if (/단기과열/.test(a)) s.add("overheat");
  return s;
}

/** 종목의 지금 상태 — 위험한 것부터 */
export async function stockStatus(client: KiwoomClient, code: string): Promise<StatusFlag[]> {
  const [ht, index, kind] = await Promise.all([
    hantooFlags(code),
    getStockIndex(client).catch(() => new Map()),
    activeMeasures(code).catch(() => []),
  ]);
  const entry = index.get(code) as { auditInfo?: string } | undefined;
  const kw = kiwoomFlags(entry?.auditInfo);
  const out = new Map<FlagKind, StatusFlag>();
  const add = (k: FlagKind, src: "hantoo" | "kiwoom" | "kind") => {
    const meta = DESC[k];
    if (!meta || !meta.desc) return;
    const cur = out.get(k);
    if (cur) {
      if (!cur.source.includes(src)) cur.source.push(src);
      return;
    }
    out.set(k, { kind: k, label: meta.label, desc: meta.desc, level: meta.level, source: [src] });
  };
  for (const k of ht ?? []) add(k, "hantoo");
  for (const k of kw) add(k, "kiwoom");
  for (const n of kind) {
    /* 예고는 공시에만 있다. 지정은 플래그가 이미 있으면 날짜·링크만 붙인다 */
    add(n.kind, "kind");
    const cur = out.get(n.kind);
    if (cur) {
      cur.since = n.date;
      cur.acptNo = n.acptNo;
    }
  }
  /* 예고가 있는데 본지정이 있으면 예고는 뺀다 — 이미 지정됐다 */
  if (out.has("warning")) out.delete("warningNotice");
  if (out.has("overheat")) out.delete("overheatNotice");
  const order: StatusFlag["level"][] = ["danger", "warn", "info"];
  return [...out.values()].sort((a, b) => order.indexOf(a.level) - order.indexOf(b.level));
}

export { KIND_LABEL };
