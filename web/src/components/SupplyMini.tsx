import { useEffect, useState } from "react";
import { api, pickList, signClass, type RawRecord } from "../api";

/**
 * 당일 수급 **미니** — 보드에 한 칸으로 놓는 그것.
 *
 * ## 왜 미니가 따로 있나
 *
 * 투자자 수급표(`InvestorTrendTable`)는 열세 칸에 며칠치를 쌓아 보여준다. 파고들 때는
 * 그게 맞지만 **보드에 놓으면 칸을 크게 먹는다** — 곁눈으로 보려고 띄우는 자리인데
 * 표를 읽어야 하면 곁눈으로 못 본다.
 *
 * 그래서 **개인·외국인·기관** 셋만 남긴다 — 이 셋이 방향을 만든다.
 *
 * ## 구간을 버튼에서 열로
 *
 * 처음엔 당일·5·10·20·60 을 버튼으로 두고 눌러서 바꾸게 했다. 그런데 이 칸을 보는
 * 이유가 **「오늘 판 게 며칠째인가」**인데, 그걸 알려면 당일을 보고 5일을 누르고
 * 다시 20일을 눌러 머릿속에서 견줘야 했다. 곁눈으로 보라고 만든 칸에서 그걸 하고
 * 있으면 미니일 이유가 없다.
 *
 * 구간을 **열로 펴서 한눈에** 놓는다. 왼쪽에서 오른쪽으로 읽으면 그게 곧 흐름이다 —
 * 당일만 파랗고 나머지가 빨가면 오늘만 판 것이고, 쭉 파랗면 며칠째 파는 중이다.
 *
 * ## 기관을 괄호로 쪼개는 이유
 *
 * 「기관 +37만주」는 사실 한 덩어리가 아니다. **금융투자**는 대개 프로그램·헤지라
 * 방향성이 약하고, **연기금**은 길게 담고, **투신·사모**는 짧게 친다.
 * 같은 플러스라도 금융투자가 만든 것과 연기금이 만든 것은 뜻이 정반대일 때가 있다.
 * 그래서 합계 옆에 넷을 작게 붙인다 — 자리는 한 줄인데 읽히는 건 네 배다.
 */

function n(v: unknown): number {
  const x = Number(String(v ?? "").replace(/[+,\s]/g, ""));
  return Number.isFinite(x) ? x : 0;
}

/** 주 수량을 짧게 — 만 단위가 넘으면 만주로 */
function qty(v: number): string {
  const a = Math.abs(v);
  if (a >= 10_000) return `${v > 0 ? "+" : ""}${(v / 10_000).toFixed(1)}만`;
  return `${v > 0 ? "+" : ""}${Math.round(v).toLocaleString("ko-KR")}`;
}

/** 며칠을 합쳐 볼지 — 1일은 오늘 하루 */
const SPANS = [1, 5, 10, 20, 60];

export function SupplyMini({ code }: { code: string }) {
  const [rows, setRows] = useState<RawRecord[] | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    if (!code) return;
    let alive = true;
    setRows(null);
    setErr(false);
    api
      .investorChart(code)
      .then((r) => {
        if (!alive) return;
        // 첫 행이 가장 최근이다
        setRows(pickList(r as RawRecord, ["stk_invsr_orgn_chart"]));
      })
      .catch(() => alive && setErr(true));
    return () => {
      alive = false;
    };
  }, [code]);

  if (err) return <div className="error-banner">수급을 못 받았습니다.</div>;
  if (!rows) return <div className="empty">불러오는 중…</div>;
  if (rows.length === 0) return <div className="empty">수급 데이터가 없습니다.</div>;

  /*
   * 앞에서부터 `span` 일치를 더한다.
   * 받아 둔 배열을 자르는 것이라 **조회가 늘지 않는다**(백 일치가 한 번에 온다).
   */
  const sum = (key: string, span: number) =>
    rows.slice(0, span).reduce((acc, r) => acc + n(r[key]), 0);

  /** 그 구간에 실제로 며칠치가 있나 — 상장 얼마 안 된 종목은 60일이 없다 */
  const have = (span: number) => Math.min(span, rows.length);

  /* 기관 안쪽 — 성격이 다른 넷. 들여써서 합계와 구별한다 */
  const lines: { label: string; key: string; sub?: boolean; hint?: string }[] = [
    { label: "개인", key: "ind_invsr" },
    { label: "외국인", key: "frgnr_invsr" },
    { label: "기관", key: "orgn" },
    { label: "금융투자", key: "fnnc_invt", sub: true, hint: "프로그램·헤지가 많아 방향성이 약합니다" },
    { label: "투신", key: "invtrt", sub: true, hint: "펀드 — 짧게 치는 편입니다" },
    { label: "연기금", key: "penfnd_etc", sub: true, hint: "길게 담습니다" },
    { label: "사모", key: "samo_fund", sub: true, hint: "짧게 칩니다" },
  ];

  const dt = String(rows[0].dt ?? "");
  const day = dt.length === 8 ? `${Number(dt.slice(4, 6))}/${Number(dt.slice(6, 8))}` : "";
  /* 데이터가 모자란 구간은 아예 안 그린다 — 5일 칸에 3일치를 넣으면 거짓말이 된다 */
  const spans = SPANS.filter((d) => d === 1 || rows.length >= d);

  return (
    <div className="sm">
      <div className="sm-day">
        {day} 기준 · 단위 주 · <b>당일</b> 말고는 그날까지 <b>합산</b>입니다
      </div>

      <div className="data-table-wrap">
        <table className="data-table num sm-table">
          <thead>
            <tr>
              <th></th>
              {spans.map((d) => (
                <th key={d} title={d === 1 ? "오늘 하루" : `최근 ${have(d)}일 합산`}>
                  {d === 1 ? "당일" : `${d}일`}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.label} className={l.sub ? "sm-sub" : ""}>
                <th scope="row" title={l.hint}>
                  {l.label}
                </th>
                {spans.map((d) => {
                  const v = sum(l.key, d);
                  return (
                    <td key={d} className={signClass(v)}>
                      {qty(v)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="table-note">
        <b>왼쪽에서 오른쪽으로 읽으면 그게 흐름입니다.</b> 당일만 파랗고 뒤가 빨가면
        오늘만 판 것이고, 쭉 파랗면 며칠째 파는 중입니다 — 같은 「오늘 매도」라도
        둘은 정반대의 이야기입니다.
        <br />
        <b>기관은 한 덩어리가 아닙니다.</b> 금융투자는 프로그램·헤지가 많아 방향성이 약하고
        연기금은 길게 담습니다 — 같은 플러스라도 어디서 나온 것인지에 따라 뜻이 다릅니다.
      </div>
    </div>
  );
}
