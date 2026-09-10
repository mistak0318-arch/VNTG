import { useEffect, useState } from "react";
import { api, krxViewerUrl, type StatusFlag, type StockEvent } from "../api";

/**
 * 종목 **상태 배너 + 이벤트 칩** — 종목을 보는 화면 전부에 같은 것 (2026-09-10).
 *
 * 벤티지: "투자주의 관리 종목, 이런 종류의 것들 종목을 봤을 때 표시해달라고 얘기했는데, 표시가 안 되어
 * 있네. 삼미금속이 오늘 투자주의 일일간 지정됐는데". 서버는 답을 주고 있었다(한투 시세2 01 = 투자주의,
 * KIND 지정예고) — 배너가 **종목 상세 시트에만** 있었고 개별종목분석·보드·종목발굴 머리에는 없었다.
 * 그래서 하나로 빼서 넷이 같은 것을 그린다.
 *
 * 한투 시세2(당일 낮 반영) + 키움 auditInfo + KIND 공시를 서버가 합친다(stockStatus.ts). 예탁원 일정
 * (주총·합병분할·신주 상장·배당)은 그 밑 작은 칩.
 */
export function useStockStatus(code: string): { flags: StatusFlag[]; events: StockEvent[] } {
  const [flags, setFlags] = useState<StatusFlag[]>([]);
  const [events, setEvents] = useState<StockEvent[]>([]);
  useEffect(() => {
    let alive = true;
    setFlags([]);
    setEvents([]);
    if (!/^\d{6}$/.test(code)) return;
    api
      .krxMeasures(code)
      .then((r) => {
        if (!alive) return;
        setFlags(r.flags ?? []);
        setEvents(r.events ?? []);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [code]);
  return { flags, events };
}

const SRC_LABEL: Record<string, string> = { hantoo: "한투 시세", kiwoom: "키움 종목정보", kind: "KIND 공시" };

export function StockStatusBanner({ code, compact = false }: { code: string; compact?: boolean }) {
  const { flags, events } = useStockStatus(code);
  if (flags.length === 0 && events.length === 0) return null;
  return (
    <>
      {flags.length > 0 && (
        <div className={`sd-flags${compact ? " compact" : ""}`}>
          {flags.map((f) => (
            <a
              key={f.kind}
              className={`sd-flag ${f.level}`}
              href={f.acptNo ? krxViewerUrl(f.acptNo) : undefined}
              target={f.acptNo ? "_blank" : undefined}
              rel="noreferrer noopener"
              title={`출처: ${f.source.map((s) => SRC_LABEL[s] ?? s).join(" · ")}${f.since ? ` · 공시 ${f.since}` : ""}`}
            >
              <b>{f.label}</b>
              <span>{f.desc}</span>
              {f.since && <i>{f.since.slice(5).replace("-", "/")} 공시</i>}
            </a>
          ))}
        </div>
      )}
      {events.length > 0 && (
        <div className="sd-events">
          {events.map((e) => (
            <span className={`sd-event ${e.kind}`} key={`${e.kind}${e.date}${e.label}`} title={e.desc}>
              <b>{e.label}</b>
              <span>{e.desc}</span>
            </span>
          ))}
        </div>
      )}
    </>
  );
}

/**
 * 이름 옆 **한 글자 표** — 목록·머리줄용. 「주의」「경고」「위험」「관리」「정지」「공매도」 중 가장 센 것 하나.
 * 배너를 놓을 자리가 없는 곳(시트 머리의 이름 옆)에 붙인다.
 */
export function StatusMark({ flags }: { flags: StatusFlag[] }) {
  if (flags.length === 0) return null;
  const top = flags[0];
  const short: Record<string, string> = {
    halt: "정지",
    liquidation: "정리",
    managed: "관리",
    danger: "위험",
    warning: "경고",
    shortOverheat: "공매도",
    overheat: "과열",
    runup: "급등",
    caution: "주의",
    warningNotice: "경고예고",
    overheatNotice: "과열예고",
    unfaithful: "불성실",
    lowLiquidity: "저유동",
    vi: "VI",
  };
  return (
    <i className={`sd-mark ${top.level}`} title={`${top.label} — ${top.desc}`}>
      {short[top.kind] ?? top.label}
      {flags.length > 1 && <b>+{flags.length - 1}</b>}
    </i>
  );
}
