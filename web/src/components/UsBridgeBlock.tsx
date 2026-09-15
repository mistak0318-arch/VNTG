import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api, signClass, type ThemeBridge, type UsIndustryTop } from "../api";
import { YahooChartSheet, type ChartTarget } from "./overview/YahooChartSheet";

/**
 * **미국 짝** (2026-09-15 — 벤티지: "두 개 매칭해서 엮어 볼래?" → 「지금 화면에도 붙이기」).
 *
 * 이 국내 테마와 이어진 미국 업종의 **어젯밤** 등락, 그리고 편입 사유에 이름이 나온 미국 회사.
 * 회사 언급은 글로 된 근거가 있어 「근거」, 테마 이름 낱말로만 이은 것은 「어림」이라 적는다.
 * 미국을 정말 따라가는지는 아직 모른다 — 서버가 날마다 짝별 등락을 쌓고 있다(themeBridgeLog).
 *
 * **업종을 누르면 그 업종의 미국 종목이 펼쳐진다** (벤티지: "여기서 미국 종목도 나와 줘야 하는 거 아녀?
 * 누르면?"). 시총 큰 차례로 열두 개, 어젯밤 등락과 함께. 종목을 누르면 해외종목 시트(`YahooChartSheet`
 * usStock — 한투 시세·차트)가 열린다. 편입 사유에 나온 회사 이름도 같은 시트로 열린다.
 * 시트는 `document.body` 로 띄운다 — 구성종목 시트 안에서 열리면 그 시트의 층에 갇힌다.
 *
 * 테마 DB 상세(ThemeSheet)와 테마/업종 MAP 의 구성종목 시트(ConstituentSheet) 두 곳이 쓴다.
 */
export function UsBridgeBlock({ no, onSelectStock }: { no: number; onSelectStock: (code: string, name: string) => void }) {
  const [b, setB] = useState<ThemeBridge | null | undefined>(undefined);
  const [openInd, setOpenInd] = useState<string | null>(null);
  const [indData, setIndData] = useState<Record<string, UsIndustryTop | null>>({});
  const [chart, setChart] = useState<ChartTarget | null>(null);

  useEffect(() => {
    let alive = true;
    setOpenInd(null);
    api
      .themeBridge(no)
      .then((r) => alive && setB(r.bridge))
      .catch(() => alive && setB(null));
    return () => {
      alive = false;
    };
  }, [no]);

  /* 펼친 업종의 종목 — 한 번 받은 업종은 다시 안 묻는다 */
  useEffect(() => {
    if (!openInd || openInd in indData) return;
    let alive = true;
    api
      .themeBridgeUsIndustry(openInd)
      .then((r) => alive && setIndData((m) => ({ ...m, [openInd]: r.industry })))
      .catch(() => alive && setIndData((m) => ({ ...m, [openInd]: null })));
    return () => {
      alive = false;
    };
  }, [openInd, indData]);

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
  const openUs = (symbol: string, name: string, r: number | null) =>
    setChart({ kind: "usStock", symbol, label: name, hintRate: r });
  const shown = openInd ? indData[openInd] : undefined;

  return (
    <div className="tub">
      <div className="tub-h">
        🇺🇸 미국 짝 <span className="tub-at">{at ? `${at.getMonth() + 1}/${at.getDate()} 미국 마감 · 업종을 누르면 종목` : ""}</span>
      </div>
      {b.industries.length > 0 && (
        <div className="tub-inds">
          {b.industries.map((i) => (
            <button
              type="button"
              key={i.code}
              className={`tub-ind${i.via === "낱말" ? " guess" : ""}${openInd === i.code ? " on" : ""}`}
              title={i.via === "낱말" ? "테마 이름 낱말로 이은 짝 — 어림. 누르면 이 업종의 미국 종목" : "편입 사유에 이 업종 회사가 나온다 — 근거 있음. 누르면 이 업종의 미국 종목"}
              onClick={() => setOpenInd((cur) => (cur === i.code ? null : i.code))}
            >
              {i.name} {rate(i.changeRate)}
              <i>{i.via === "낱말" ? "어림" : "근거"}</i>
              <span className="tub-caret">{openInd === i.code ? "▴" : "▾"}</span>
            </button>
          ))}
        </div>
      )}
      {openInd && (
        <div className="tub-us">
          {shown === undefined && <div className="tub-note">불러오는 중…</div>}
          {shown === null && <div className="tub-note">이 업종의 종목을 못 받았습니다.</div>}
          {shown && (
            <>
              <div className="tub-us-list">
                {shown.stocks.map((st) => (
                  <button key={st.symbol} type="button" className="tub-us-row" onClick={() => openUs(st.symbol, st.name, st.changeRate)}>
                    <b>{st.name}</b>
                    <span className="tub-sym">{st.symbol}</span>
                    {rate(st.changeRate)}
                  </button>
                ))}
              </div>
              <div className="tub-note">
                {shown.name} {shown.total}종목 중 시총 큰 {shown.stocks.length}개 · 누르면 해외종목 상세
              </div>
            </>
          )}
        </div>
      )}
      {b.companies.length > 0 && (
        <div className="tub-cos">
          {b.companies.slice(0, 6).map((c) => (
            <div key={c.symbol} className="tub-co">
              <button type="button" className="tub-co-h" onClick={() => openUs(c.symbol, c.name, c.changeRate)} title="해외종목 상세">
                <b>{c.name}</b> <span className="tub-sym">{c.symbol}</span> {rate(c.changeRate)}
              </button>
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
      {chart && createPortal(<YahooChartSheet target={chart} onClose={() => setChart(null)} />, document.body)}
    </div>
  );
}
