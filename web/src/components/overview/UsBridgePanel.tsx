import { useEffect, useState } from "react";
import { api, signClass, type OvernightBridgeRow } from "../../api";

/**
 * **어젯밤 미국 → 오늘 볼 국내 테마** (2026-09-15 — 벤티지: "두 개 매칭해서 엮어 볼래?" → 「지금 화면에도 붙이기」).
 *
 * 미국 업종이 어젯밤 크게 움직인 차례로, 그 업종과 이어진 국내 테마의 **오늘** 등락을 옆에 둔다.
 * 「미국 반도체 −4% 였는데 국내 HBM 은?」을 한눈에 보려는 카드다.
 *
 * ⚠️ 짝이 미국을 **따라간다는 뜻이 아니다.** 9/15 하루치로는 상관이 무작위와 구별이 안 됐다 — 서버가
 * 날마다 짝별 등락을 쌓고 있고(themeBridgeLog), 30거래일쯤 뒤에 따라가는 짝만 추린다. 그때까지는 참고다.
 * 근거(편입 사유에 미국 회사가 나옴) 짝을 앞에, 어림(테마 이름으로 이음) 짝을 뒤에 둔다.
 *
 * 값은 하루 한 번(07시대) 바뀐다 — 10분마다 다시 묻는다(국내 쪽 등락이 장중에 움직여서).
 */
const THEMES_SHOWN = 4;

export function UsBridgePanel() {
  const [data, setData] = useState<{ usAt: string; rows: OvernightBridgeRow[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const pull = () =>
      api
        .themeBridgeOvernight()
        .then((r) => alive && (setData(r), setError(null)))
        .catch((e: Error) => alive && setError(e.message));
    void pull();
    const t = window.setInterval(pull, 10 * 60_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);

  if (error) return <div className="ov-card-b empty">{error}</div>;
  if (!data) return <div className="ov-card-b empty">불러오는 중…</div>;
  if (data.rows.length === 0) return <div className="ov-card-b empty">미국 업종 시세를 아직 못 받았습니다.</div>;

  const d = data.usAt ? new Date(new Date(data.usAt).getTime() - 12 * 3600_000) : null;
  const pct = (v: number | null) => (v === null ? "–" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`);

  return (
    <div className="ov-card-b ubp">
      <div className="ubp-at">{d ? `미국 ${d.getMonth() + 1}/${d.getDate()} 마감 · 업종은 시총 가중 · 국내는 오늘 테마 평균` : ""}</div>
      {data.rows.map((r) => {
        const all = open === r.code;
        const shown = all ? r.themes : r.themes.slice(0, THEMES_SHOWN);
        return (
          <div key={r.code} className="ubp-row">
            <div className="ubp-us">
              <span className="ubp-flag">🇺🇸</span>
              <b className="ubp-ind">{r.name}</b>
              <em className={`num ${signClass(r.changeRate)}`}>{pct(r.changeRate)}</em>
            </div>
            <div className="ubp-kr">
              {shown.map((t) => (
                <span key={t.no} className={`ubp-chip${t.via === "낱말" ? " guess" : ""}`} title={t.via === "낱말" ? "테마 이름으로 이은 짝 — 어림" : "편입 사유에 이 업종 미국 회사가 나온다"}>
                  {t.name.replace(/\(.*?\)/g, "").trim()} <em className={`num ${signClass(t.changeRate ?? 0)}`}>{pct(t.changeRate)}</em>
                </span>
              ))}
              {r.themes.length > THEMES_SHOWN && (
                <button type="button" className="ubp-more" onClick={() => setOpen(all ? null : r.code)}>
                  {all ? "접기" : `외 ${r.themes.length - THEMES_SHOWN}`}
                </button>
              )}
            </div>
          </div>
        );
      })}
      <div className="ubp-note">흐린 칩은 테마 이름으로만 이은 짝(어림). 미국을 따라가는지는 기록이 쌓이면 가립니다.</div>
    </div>
  );
}
