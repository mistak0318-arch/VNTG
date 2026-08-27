import { useEffect, useState } from "react";
import { api } from "../api";

/**
 * 경제 캘린더 설치.
 *
 * 무료 경제 캘린더 API가 없어서(Investing.com 등은 크롤링 금지) 서버에 내장한
 * 시드를 캘린더로 옮긴다. FOMC·미국 CPI·한국은행 금통위·옵션 만기일.
 *
 * **날짜는 전부 공식 출처에서 확인한 값이다** — 확인일을 화면에 띄워서
 * 언제 기준인지 알 수 있게 한다. 연초에 다시 눌러 갱신하면 된다.
 */

export function EconomicCalendarCard({ onInstalled }: { onInstalled?: () => void }) {
  const [verifiedAt, setVerifiedAt] = useState("");
  const [upcoming, setUpcoming] = useState<{ date: string; title: string }[]>([]);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    api
      .calendarEconomic()
      .then((r) => {
        setVerifiedAt(r.verifiedAt);
        setTotal(r.events.length);
        /* ⚠️ 한국 날짜다 — UTC 로 재면 새벽에 오늘 일정이 통째로 빠진다 (+9시간) */
        const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
        setUpcoming(r.events.filter((e) => e.date >= today).slice(0, 6));
      })
      .catch(() => undefined);
  }, []);

  async function install() {
    setBusy(true);
    setNote(null);
    try {
      const r = await api.calendarEconomicInstall();
      setNote(
        r.replaced > 0
          ? `${r.added}건으로 갱신했습니다 (기존 ${r.replaced}건 교체)`
          : `${r.added}건을 캘린더에 넣었습니다`,
      );
      onInstalled?.();
    } catch (err) {
      setNote(err instanceof Error ? err.message : "설치 실패");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p className="page-note">
        FOMC · 미국 CPI · 한국은행 금통위 · 옵션 만기일 <b>{total}건</b>을 캘린더에 넣습니다.
        무료 경제 캘린더 API가 없어 내장 시드를 쓰며, 날짜는 연준·BLS·한국은행 공식 일정에서
        확인한 값입니다 (확인일 <b>{verifiedAt || "…"}</b>).
      </p>

      {upcoming.length > 0 && (
        <div className="econ-preview">
          {upcoming.map((e) => (
            <div className="econ-row" key={`${e.date}-${e.title}`}>
              <span className="econ-date">{e.date.slice(5)}</span>
              <span>{e.title}</span>
            </div>
          ))}
        </div>
      )}

      <div className="sig-config-actions">
        <button className="primary-btn" onClick={install} disabled={busy}>
          {busy ? "넣는 중…" : "캘린더에 넣기"}
        </button>
        {note && <span className="sig-saved">{note}</span>}
      </div>

      <div className="table-note">
        여러 번 눌러도 중복이 쌓이지 않습니다 — 기존 경제 일정만 교체하고, 직접 입력한 일정과
        이미지에서 가져온 일정은 건드리지 않습니다. FOMC는 이틀 회의라 <b>결과가 나오는 둘째 날</b>로
        넣었고, 한국 시각으로는 다음 날 새벽에 발표됩니다. 옵션 만기일은 매월 두 번째 목요일 규칙으로
        계산하므로, 공휴일이 겹치면 실제 만기가 앞당겨질 수 있습니다.
      </div>
    </div>
  );
}
