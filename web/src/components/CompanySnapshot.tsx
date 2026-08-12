import { fmtAbsNum, fmtNum, pick, signClass, type RawRecord } from "../api";

// ka10001(주식기본정보요청) 공식 문서 기준 확인된 필드명
const FIELDS: { key: string; label: string; abs?: boolean; suffix?: string }[] = [
  { key: "per", label: "PER" },
  { key: "pbr", label: "PBR" },
  { key: "eps", label: "EPS" },
  { key: "bps", label: "BPS" },
  { key: "roe", label: "ROE", suffix: "%" },
  { key: "mac", label: "시가총액(억원)" },
  { key: "sale_amt", label: "매출액(억원)" },
  { key: "bus_pro", label: "영업이익(억원)" },
  { key: "cup_nga", label: "당기순이익(억원)" },
  { key: "for_exh_rt", label: "외국인비중", suffix: "%" },
  { key: "crd_rt", label: "신용비율", suffix: "%" },
  { key: "fav", label: "액면가(원)" },
  { key: "oyr_hgst", label: "연중최고", abs: true },
  { key: "oyr_lwst", label: "연중최저", abs: true },
  { key: "250hgst", label: "52주최고", abs: true },
  { key: "250lwst", label: "52주최저", abs: true },
];

export interface PeriodReturns {
  m1: number | null;
  m3: number | null;
  m6: number | null;
  y1: number | null;
}

export function CompanySnapshot({ info, returns }: { info: RawRecord | null; returns: PeriodReturns | null }) {
  if (!info) return <div className="empty">기업분석 데이터 없음</div>;

  return (
    <div>
      <div className="summary-grid">
        {FIELDS.map((f) => {
          const raw = pick(info, [f.key]);
          const display = f.abs ? fmtAbsNum(raw) : fmtNum(raw);
          return (
            <div className="summary-item" key={f.key}>
              <div className="label">{f.label}</div>
              <div className="value">
                {display}
                {f.suffix ?? ""}
              </div>
            </div>
          );
        })}
      </div>

      {returns && (
        <>
          <div className="table-note" style={{ paddingTop: 10 }}>
            수익률 (일봉 종가 기준, 거래일수 근사)
          </div>
          <div className="summary-grid">
            {[
              { label: "1개월", v: returns.m1 },
              { label: "3개월", v: returns.m3 },
              { label: "6개월", v: returns.m6 },
              { label: "1년", v: returns.y1 },
            ].map((r) => (
              <div className="summary-item" key={r.label}>
                <div className="label">{r.label}</div>
                <div className={`value ${signClass(r.v)}`}>
                  {r.v === null ? "-" : `${r.v > 0 ? "+" : ""}${r.v.toFixed(2)}%`}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="table-note">
        PER/ROE 등은 외부 벤더 데이터라 실적발표 시즌 기준으로만 갱신됩니다. Fwd PER·업종PER·배당수익률·52주베타·외국인
        지분율 추이·상대수익률 차트는 키움 REST API로 제공되지 않아 이 화면엔 없습니다.
      </div>
    </div>
  );
}
