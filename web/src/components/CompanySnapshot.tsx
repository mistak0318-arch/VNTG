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

      {/*
        **무엇이 낡았는지 정확히 적는다** (2026-10-21 전수점검).

        여태 「외부 벤더 데이터라 실적발표 시즌 기준으로만 갱신됩니다」라고만 적었다.
        틀린 말은 아닌데 **얼마나** 낡았는지가 없어서 아무도 안 쟀다. 재 보니:
        키움의 per·pbr·eps·bps 는 **직전 결산(연 1회)** 값이고, 대형주 13 개 중 7 개가
        최근 4분기 기준과 1.3 배 이상 어긋났다(하이닉스 3.8 배, 삼성전자 3.4 배).
      */}
      <div className="table-note">
        PER·PBR·EPS·BPS·ROE 는 키움이 주는 <b>직전 결산</b> 값입니다 — 연 1회만 바뀌므로
        이익이 빠르게 변하는 국면에서는 실제와 크게 어긋납니다. 최근 4분기·올해 추정 기준은
        맨 위 <b>밸류에이션 띠</b>에 나란히 있습니다. 업종PER·52주베타·외국인 지분율 추이·
        상대수익률 차트는 키움 REST API로 제공되지 않아 이 화면엔 없습니다.
      </div>
    </div>
  );
}
