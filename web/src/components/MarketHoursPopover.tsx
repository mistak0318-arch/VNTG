import { useEffect } from "react";
import { createPortal } from "react-dom";

/**
 * **장 시간표 미니 창** — 머리 시계를 누르면 (2026-09-16).
 *
 * 벤티지: "오른쪽 상단 시간 누르면 국내 장 구분 시간 — KRX 는 몇 시부터 몇 시까지, 애프터는 몇 시부터 … 미국은
 * 프리장·본장·애프터장 몇 시부터 몇 시까지 … 썸머타임 적용했을 때 아닐 때, 썸머타임은 언제부터인지 보기 쉽게".
 *
 * ## 국내 — 키움 공지 시간표(2026-09-16 벤티지가 붙여 준 그림)
 *
 * 9/14 KRX 애프터마켓 개편 뒤 시간표. 15:30~16:00 은 KRX 연속매매만 쉬고 NXT 는 돈다(`marketHours.ts` 머리 주석).
 *
 * ## 미국 — 시계로 센다
 *
 * 동부시각(ET) 기준 시간은 늘 같고(프리 04:00 · 정규 09:30 · 애프터 16:00~20:00), **한국 시각만 서머타임에 따라
 * 한 시간 움직인다.** 서머타임 여부와 올해 시작·끝 날짜는 **브라우저 시간대 데이터**로 계산한다 — 날짜를 박아 두면
 * 해가 바뀔 때 틀린다(`usSession.ts` 가 같은 방식). 미국 규칙: 3월 둘째 일요일 ~ 11월 첫째 일요일.
 */

type Row = { name: string; time: string; note?: string; start: number; end: number };

/** 그 시간대의 요일·분 */
function zoneNow(now: Date, timeZone: string): { day: number; mins: number } {
  const f = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
  const p = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
  return { day: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(String(p.weekday)), mins: (Number(p.hour) % 24) * 60 + Number(p.minute) };
}

/** 그 순간 뉴욕이 서머타임(EDT)인가 — 시간대 이름으로 묻는다 */
function isEdt(d: Date): boolean {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", timeZoneName: "short" })
    .formatToParts(d)
    .find((x) => x.type === "timeZoneName")?.value;
  return name === "EDT";
}

/** 올해 서머타임 시작·끝(미국 날짜) — 하루씩 훑어 EDT 가 바뀌는 날을 찾는다 */
function dstRange(year: number): { start: Date | null; end: Date | null } {
  let start: Date | null = null;
  let end: Date | null = null;
  let prev = isEdt(new Date(Date.UTC(year, 0, 1, 17)));
  for (let i = 1; i < 366; i++) {
    const d = new Date(Date.UTC(year, 0, 1 + i, 17)); // 뉴욕 정오쯤
    const cur = isEdt(d);
    if (cur && !prev) start = d;
    if (!cur && prev) end = d;
    prev = cur;
  }
  return { start, end };
}

const mmdd = (d: Date | null) => {
  if (!d) return "-";
  const w = ["일", "월", "화", "수", "목", "금", "토"][d.getUTCDay()];
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${w})`;
};
const hm = (m: number) => `${String(Math.floor(((m % 1440) + 1440) % 1440 / 60)).padStart(2, "0")}:${String(((m % 60) + 60) % 60).padStart(2, "0")}`;

const KR_ROWS: Row[] = [
  { name: "NXT 프리마켓", time: "08:00~08:50", start: 480, end: 530 },
  { name: "KRX 장전 동시호가", time: "08:30~09:00", note: "장전 시간외 종가 08:30~08:40", start: 510, end: 540 },
  { name: "정규장", time: "09:00~15:30", note: "종가 단일가 15:20~15:30 · NXT 메인 09:00:30~15:20", start: 540, end: 930 },
  {
    name: "KRX 쉼 · NXT 애프터 시작",
    time: "15:30~16:00",
    note: "NXT 단일가 15:30~15:40 · NXT 종가매매 ~16:00 · KRX 장후 시간외 종가 15:40~16:00",
    start: 930,
    end: 960,
  },
  { name: "애프터마켓", time: "16:00~20:00", note: "KRX 16:00~ · NXT 15:40~ · 지정가·최우선·최유리만", start: 960, end: 1200 },
];

/** 미국 세션 — ET 분. 한국 시각은 서머타임이면 +13h, 아니면 +14h */
const US_ROWS: { name: string; et: [number, number] }[] = [
  { name: "프리마켓", et: [240, 570] },
  { name: "정규장(본장)", et: [570, 960] },
  { name: "애프터마켓", et: [960, 1200] },
  { name: "주간거래(국내 증권사)", et: [1200, 1680] },
];

export function MarketHoursPopover({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const now = new Date();
  const { day, mins } = zoneNow(now, "Asia/Seoul");
  const et = zoneNow(now, "America/New_York");
  const etMins = et.mins;
  const weekday = day >= 1 && day <= 5;
  const edt = isEdt(now);
  const { start, end } = dstRange(now.getUTCFullYear());
  const krActive = (r: Row) => weekday && mins >= r.start && mins < r.end;
  const shift = (summer: boolean) => (summer ? 13 * 60 : 14 * 60);
  /*
   * 지금 도는 미국 세션 — 프리·정규·애프터는 **미국 요일**(한국 토요일 새벽 05~09시는 미국 금요일 애프터다),
   * 주간거래는 국내 증권사 서비스라 **한국 요일**로 본다.
   */
  const usActive = (name: string, r: [number, number]) => {
    if (name.startsWith("주간")) {
      const from = (r[0] + shift(edt)) % 1440;
      const to = (r[1] + shift(edt)) % 1440;
      return weekday && mins >= from && mins < to;
    }
    return et.day >= 1 && et.day <= 5 && etMins >= r[0] && etMins < r[1];
  };

  return createPortal(
    <div className="mh-overlay" onClick={onClose}>
      <div className="mh-pop" role="dialog" aria-label="장 시간표" onClick={(e) => e.stopPropagation()}>
        <div className="mh-head">
          <b>장 시간표</b>
          <span className="mh-now">한국 {hm(mins)} · 미국 동부 {hm(etMins)} ({edt ? "서머타임" : "표준시"})</span>
          <button type="button" className="close-btn" onClick={onClose} aria-label="닫기">
            ✕
          </button>
        </div>

        <div className="mh-sec">🇰🇷 국내 (평일, 한국 시각)</div>
        <table className="mh-table">
          <tbody>
            {KR_ROWS.map((r) => (
              <tr key={r.name} className={krActive(r) ? "on" : ""}>
                <td className="mh-name">
                  {krActive(r) && <i className="mh-live" />}
                  {r.name}
                  {r.note && <small>{r.note}</small>}
                </td>
                <td className="mh-time">{r.time}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="mh-sec">
          🇺🇸 미국 (한국 시각) <span className="mh-badge">{edt ? "지금 서머타임" : "지금 표준시(겨울)"}</span>
        </div>
        <table className="mh-table mh-us">
          <thead>
            <tr>
              <th />
              <th className={edt ? "cur" : ""}>서머타임</th>
              <th className={!edt ? "cur" : ""}>겨울</th>
              <th>현지(ET)</th>
            </tr>
          </thead>
          <tbody>
            {US_ROWS.map((r) => {
              const on = usActive(r.name, r.et);
              return (
                <tr key={r.name} className={on ? "on" : ""}>
                  <td className="mh-name">
                    {on && <i className="mh-live" />}
                    {r.name}
                  </td>
                  <td className={`mh-time${edt ? " cur" : ""}`}>
                    {hm(r.et[0] + shift(true))}~{hm(r.et[1] + shift(true))}
                  </td>
                  <td className={`mh-time${!edt ? " cur" : ""}`}>
                    {hm(r.et[0] + shift(false))}~{hm(r.et[1] + shift(false))}
                  </td>
                  <td className="mh-time mh-et">
                    {hm(r.et[0])}~{hm(r.et[1])}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="mh-note">
          올해 서머타임: 미국 <b>{mmdd(start)} ~ {mmdd(end)}</b> — 3월 둘째 일요일에 시작, 11월 첫째 일요일에 끝.
          바뀌는 주 월요일 밤부터 한국 시각이 한 시간씩 당겨지거나(서머타임) 늦춰진다(겨울).
          <br />
          국내는 키움 공지 시간표(2026-09-14 개편) 기준. 휴장일은 따로 안 가린다.
        </div>
      </div>
    </div>,
    document.body,
  );
}
