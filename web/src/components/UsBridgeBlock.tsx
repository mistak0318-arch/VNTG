import { useEffect, useState } from "react";
import { api, signClass, type ThemeBridge } from "../api";

/**
 * **미국 짝** (2026-09-15 — 벤티지: "두 개 매칭해서 엮어 볼래?" → 「지금 화면에도 붙이기」).
 *
 * 이 국내 테마와 이어진 미국 업종의 **어젯밤** 등락, 그리고 편입 사유에 이름이 나온 미국 회사.
 * 회사 언급은 글로 된 근거가 있어 「근거」, 테마 이름 낱말로만 이은 것은 「어림」이라 적는다.
 * 미국을 정말 따라가는지는 아직 모른다 — 서버가 날마다 짝별 등락을 쌓고 있다(themeBridgeLog).
 *
 * 테마 DB 상세(ThemeSheet)와 테마/업종 MAP 의 구성종목 시트(ConstituentSheet) 두 곳이 쓴다.
 */
export function UsBridgeBlock({ no, onSelectStock }: { no: number; onSelectStock: (code: string, name: string) => void }) {
  const [b, setB] = useState<ThemeBridge | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    api
      .themeBridge(no)
      .then((r) => alive && setB(r.bridge))
      .catch(() => alive && setB(null));
    return () => {
      alive = false;
    };
  }, [no]);
  if (!b) return null;
  const at = b.usAt ? new Date(new Date(b.usAt).getTime() - 12 * 3600_000) : null; // 받은 시각(한국 아침)의 전날 = 미국 거래일
  const rate = (v: number | null) =>
    v === null ? (
      <em className="num">–</em>
    ) : (
      <em className={`num ${signClass(v)}`}>
        {v > 0 ? "+" : ""}
        {v.toFixed(2)}%
      </em>
    );
  return (
    <div className="tub">
      <div className="tub-h">
        🇺🇸 미국 짝 <span className="tub-at">{at ? `${at.getMonth() + 1}/${at.getDate()} 미국 마감` : ""}</span>
      </div>
      {b.industries.length > 0 && (
        <div className="tub-inds">
          {b.industries.map((i) => (
            <span key={i.code} className={`tub-ind${i.via === "낱말" ? " guess" : ""}`} title={i.via === "낱말" ? "테마 이름 낱말로 이은 짝 — 어림" : "편입 사유에 이 업종 회사가 나온다 — 근거 있음"}>
              {i.name} {rate(i.changeRate)}
              <i>{i.via === "낱말" ? "어림" : "근거"}</i>
            </span>
          ))}
        </div>
      )}
      {b.companies.length > 0 && (
        <div className="tub-cos">
          {b.companies.slice(0, 6).map((c) => (
            <div key={c.symbol} className="tub-co">
              <span className="tub-co-h">
                <b>{c.name}</b> <span className="tub-sym">{c.symbol}</span> {rate(c.changeRate)}
              </span>
              <span className="tub-by">
                {c.by.slice(0, 4).map((s) => (
                  <button key={s.code} type="button" className="tub-by-chip" onClick={() => onSelectStock(s.code, s.name)}>
                    {s.name}
                  </button>
                ))}
                {c.by.length > 4 && <span className="tub-more">외 {c.by.length - 4}</span>}
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="tub-note">근거 = 편입 사유에 그 미국 회사가 나옴 · 어림 = 테마 이름으로 이음. 따라가는지는 기록이 쌓이면 가립니다.</div>
    </div>
  );
}

