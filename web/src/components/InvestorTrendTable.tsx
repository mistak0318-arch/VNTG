import { useEffect, useState } from "react";
import { removePref, setPref } from "../prefs";
import { fmtAbsNum, fmtNum, signClass, type RawRecord } from "../api";

/**
 * 투자자별 매매동향 표 — **종목 상세와 보드가 같이 쓴다.**
 *
 * ## 왜 다시 짰나
 *
 * 열세 칸을 한 줄로 늘어놓으니 **개인·외국인·기관을 눈으로 못 갈랐다.**
 * 등락률·종가까지 같은 줄에 섞여 있어서 어디부터가 수급인지도 안 보였다.
 * 「보험」과 「외국인」이 같은 굵기로 나란히 있으면, 읽는 사람이 매번 머리로
 * 골라내야 한다 — 표가 할 일을 사람에게 미룬 것이다.
 *
 * 그래서 세 가지를 했다.
 *
 *   1. **묶는다.** 시세 / 큰손 셋 / 기관 속살 / 나머지 — 사이에 굵은 선을 넣는다
 *   2. **크기를 나눈다.** 외국인·기관계가 제일 굵고, 기관 속살이 중간, 나머지는 흐리게
 *   3. **끌 수 있게 한다.** 안 보는 칸을 끄면 표가 좁아진다 — 보드 칸에 넣으면 특히 크다
 *
 * ## 무엇을 기본으로 켜 두나
 *
 * 개인·외국인·기관계에 **금융투자·투신·연기금·사모펀드**까지. 이게 실제로 보는 것들이다.
 * 보험·은행·기타금융·국가·기타법인·내외국인은 꺼 둔다 — 필요하면 톱니바퀴에서 켠다.
 * 고른 것은 **이 기기에** 남고, 상세와 보드가 같은 설정을 쓴다(같은 표니까).
 */

const PERIOD_OPTIONS = [5, 10, 20, 30];

/** ka10060(종목별투자자기관별차트요청) 확인된 필드명. 단위: 백만원 */
interface Col {
  key: string;
  label: string;
  /** 어느 묶음인가 */
  group: "big" | "orgn" | "etc";
  /** 얼마나 굵게 볼 것인가 */
  weight: "strong" | "mid" | "dim";
  /** 처음에 켜 둘 것인가 */
  on: boolean;
}

const COLUMNS: Col[] = [
  { key: "ind_invsr", label: "개인", group: "big", weight: "mid", on: true },
  { key: "frgnr_invsr", label: "외국인", group: "big", weight: "strong", on: true },
  { key: "orgn", label: "기관계", group: "big", weight: "strong", on: true },

  { key: "fnnc_invt", label: "금융투자", group: "orgn", weight: "mid", on: true },
  { key: "invtrt", label: "투신", group: "orgn", weight: "mid", on: true },
  { key: "penfnd_etc", label: "연기금등", group: "orgn", weight: "mid", on: true },
  { key: "samo_fund", label: "사모펀드", group: "orgn", weight: "mid", on: true },
  { key: "insrnc", label: "보험", group: "orgn", weight: "dim", on: false },
  { key: "bank", label: "은행", group: "orgn", weight: "dim", on: false },
  { key: "etc_fnnc", label: "기타금융", group: "orgn", weight: "dim", on: false },

  { key: "natn", label: "국가", group: "etc", weight: "dim", on: false },
  { key: "etc_corp", label: "기타법인", group: "etc", weight: "dim", on: false },
  { key: "natfor", label: "내외국인", group: "etc", weight: "dim", on: false },
];

const GROUP_LABEL: Record<Col["group"], string> = {
  big: "큰손",
  orgn: "기관 속살",
  etc: "나머지",
};

const PICK_KEY = "vntg.investor.cols";

function readPick(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(PICK_KEY) ?? "null") as unknown;
    if (!Array.isArray(raw)) return COLUMNS.filter((c) => c.on).map((c) => c.key);
    const keys = new Set(COLUMNS.map((c) => c.key));
    const out = raw.filter((k): k is string => typeof k === "string" && keys.has(k));
    return out.length > 0 ? out : COLUMNS.filter((c) => c.on).map((c) => c.key);
  } catch {
    return COLUMNS.filter((c) => c.on).map((c) => c.key);
  }
}

function fmtDt(dt: string): string {
  if (!/^\d{8}$/.test(dt)) return dt || "-";
  return `${dt.slice(2, 4)}/${dt.slice(4, 6)}/${dt.slice(6, 8)}`;
}

/**
 * 그날 등락률. 응답의 flu_rt는 TR마다 배율이 달라서(예: 5.54%가 "554"로 오기도 함)
 * 현재가와 전일대비로 직접 계산한다. 전일종가 = |현재가| - 전일대비.
 */
function changeRate(row: RawRecord): number | null {
  const cur = Math.abs(Number(row.cur_prc));
  const diff = Number(row.pred_pre);
  if (!Number.isFinite(cur) || !Number.isFinite(diff)) return null;
  const base = cur - diff;
  if (base <= 0) return null;
  return (diff / base) * 100;
}

export function InvestorTrendTable({ rows }: { rows: RawRecord[] }) {
  /** 일별 목록을 몇 줄까지 볼지. 합계는 아래에서 네 기간을 한꺼번에 보여준다 */
  const [period, setPeriod] = useState(20);
  const [picked, setPicked] = useState<string[]>(readPick);
  const [gear, setGear] = useState(false);
  const visible = rows.slice(0, period);

  useEffect(() => {
    try {
      setPref(PICK_KEY, JSON.stringify(picked));
    } catch {
      /* 저장 못 해도 이번 세션에는 쓴다 */
    }
  }, [picked]);

  const cols = COLUMNS.filter((c) => picked.includes(c.key));

  if (rows.length === 0) {
    return <div className="empty">투자자별 매매동향 데이터 없음</div>;
  }

  /*
   * 5·10·20·60일 합계를 **한 번에** 보여준다.
   *
   * 수급은 **기간을 견주는 게 본체**다. "5일은 사는데 20일은 파는" 상태가 그 반대와
   * 완전히 다른 뜻이라, 하나씩 바꿔 가며 보게 하면 머릿속에서 이어 붙여야 한다.
   *
   * 데이터가 모자란 기간은 실제 일수를 적는다 — 60일을 요구했는데 40일뿐이면
   * "60일 합계"라고 부르면 안 된다.
   */
  const SUM_PERIODS = [5, 10, 20, 60];
  const summaries = SUM_PERIODS.map((p) => {
    const slice = rows.slice(0, p);
    const t: Record<string, number> = {};
    for (const col of cols) {
      t[col.key] = slice.reduce((sum, r) => sum + (Number(r[col.key]) || 0), 0);
    }
    return { label: p, days: slice.length, totals: t };
  }).filter((x) => x.days > 0);

  /** 묶음이 바뀌는 첫 칸에 굵은 선을 준다 — 그게 구분자다 */
  const isFirstOfGroup = (i: number) => i === 0 || cols[i - 1].group !== cols[i].group;
  const cls = (c: Col, i: number) =>
    `itr-${c.weight}${isFirstOfGroup(i) ? " itr-sep" : ""}`;

  return (
    <div>
      <div className="table-toolbar">
        <label htmlFor="investor-period">일별 표시</label>
        <select
          id="investor-period"
          value={period}
          onChange={(e) => setPeriod(Number(e.target.value))}
        >
          {PERIOD_OPTIONS.map((p) => (
            <option key={p} value={p}>
              {p}일
            </option>
          ))}
        </select>
        <button
          className={`filter-btn ${gear ? "active" : ""}`}
          onClick={() => setGear((v) => !v)}
          title="보여줄 투자자 고르기"
        >
          ⚙ 칸 {cols.length}
        </button>
      </div>

      {gear && (
        <div className="itr-gear">
          {(["big", "orgn", "etc"] as const).map((g) => (
            <div className="itr-gear-row" key={g}>
              <span className="itr-gear-t">{GROUP_LABEL[g]}</span>
              {COLUMNS.filter((c) => c.group === g).map((c) => (
                <button
                  key={c.key}
                  className={`filter-btn ${picked.includes(c.key) ? "active" : ""}`}
                  onClick={() =>
                    setPicked((p) =>
                      p.includes(c.key) ? p.filter((x) => x !== c.key) : [...p, c.key],
                    )
                  }
                >
                  {c.label}
                </button>
              ))}
            </div>
          ))}
          <div className="table-note">
            끄면 표가 좁아집니다 — 보드 칸에 넣었을 때 특히 큽니다. 고른 것은 이 기기에
            남고 <b>종목 상세와 보드가 같은 설정</b>을 씁니다.
          </div>
        </div>
      )}

      <div className="data-table-wrap">
        <table className="data-table itr">
          <thead>
            {/* 묶음 이름을 한 줄 위에 — 어디부터가 수급인지 보이게 */}
            <tr className="itr-groups">
              <th className="sticky-col" />
              <th colSpan={2}>시세</th>
              {(["big", "orgn", "etc"] as const).map((g) => {
                const n = cols.filter((c) => c.group === g).length;
                return n === 0 ? null : (
                  <th key={g} colSpan={n} className="itr-sep">
                    {GROUP_LABEL[g]}
                  </th>
                );
              })}
            </tr>
            <tr>
              <th className="sticky-col">일자</th>
              <th>등락률</th>
              <th>종가</th>
              {cols.map((c, i) => (
                <th key={c.key} className={cls(c, i)}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {summaries.map((sm) => (
              <tr className="totals-row" key={sm.label}>
                <td className="sticky-col">
                  최근 {sm.label}일
                  {sm.days < sm.label && <span className="pt-n"> (실제 {sm.days}일)</span>}
                </td>
                <td>-</td>
                <td>-</td>
                {cols.map((c, i) => (
                  <td key={c.key} className={`${signClass(sm.totals[c.key])} ${cls(c, i)}`}>
                    {fmtNum(sm.totals[c.key])}
                  </td>
                ))}
              </tr>
            ))}
            {visible.map((r, i) => {
              const rate = changeRate(r);
              return (
                <tr key={i}>
                  <td className="sticky-col">{fmtDt(String(r.dt ?? ""))}</td>
                  <td className={signClass(rate)}>
                    {rate === null ? "-" : `${rate > 0 ? "+" : ""}${rate.toFixed(2)}%`}
                  </td>
                  <td className={signClass(r.pred_pre)}>{fmtAbsNum(r.cur_prc)}</td>
                  {cols.map((c, j) => (
                    <td key={c.key} className={`${signClass(r[c.key])} ${cls(c, j)}`}>
                      {fmtNum(r[c.key])}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="table-note">
          단위: 백만원 · 순매수(+, 빨강) · 순매도(−, 파랑) · <b>외국인·기관계</b>가 가장 굵고
          기관 속살(금융투자·투신·연기금·사모펀드)이 그다음입니다.
        </div>
      </div>
    </div>
  );
}
