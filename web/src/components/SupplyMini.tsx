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
 * 그래서 오늘 하루만, 세 줄로 줄인다. **개인·외국인·기관** — 이 셋이 방향을 만든다.
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
  /*
   * 며칠치를 합쳐 본다.
   *
   * 하루만 보면 **우연과 흐름이 안 갈린다** — 외국인이 오늘 판 게 며칠째 파는 중인지
   * 어제까지 사다가 오늘만 판 것인지는 정반대의 이야기다. 그래서 5·10·20·60일을 같이 둔다.
   *
   * 받아 둔 배열을 앞에서부터 잘라 더하는 것이라 **조회가 늘지 않는다**(백 일치가 온다).
   */
  const [span, setSpan] = useState(1);

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

  /** 앞에서부터 `span` 일치를 더한다 */
  const sum = (key: string) =>
    rows.slice(0, span).reduce((acc, r) => acc + n(r[key]), 0);

  const ind = sum("ind_invsr");
  const frg = sum("frgnr_invsr");
  const org = sum("orgn");

  /* 기관 안쪽 — 성격이 다른 넷 */
  const parts = [
    { label: "금융투자", v: sum("fnnc_invt"), hint: "프로그램·헤지가 많아 방향성이 약합니다" },
    { label: "투신", v: sum("invtrt"), hint: "펀드 — 짧게 치는 편입니다" },
    { label: "연기금", v: sum("penfnd_etc"), hint: "길게 담습니다" },
    { label: "사모", v: sum("samo_fund"), hint: "짧게 칩니다" },
  ];

  const dt = String(rows[0].dt ?? "");
  const day = dt.length === 8 ? `${Number(dt.slice(4, 6))}/${Number(dt.slice(6, 8))}` : "";
  const have = Math.min(span, rows.length);

  return (
    <div className="sm">
      <div className="filter-row">
        {SPANS.map((d) => (
          <button
            key={d}
            className={`filter-btn ${span === d ? "active" : ""}`}
            onClick={() => setSpan(d)}
            disabled={d > rows.length}
          >
            {d === 1 ? "당일" : `${d}일`}
          </button>
        ))}
      </div>
      <div className="sm-day">
        {day} 기준
        {span > 1 && ` · 최근 ${have}일 합산`} · 단위 주
      </div>

      {(
        [
          ["개인", ind],
          ["외국인", frg],
        ] as [string, number][]
      ).map(([label, v]) => (
        <div className="sm-row" key={label}>
          <span className="sm-k">{label}</span>
          <b className={`sm-v ${signClass(v)}`}>{qty(v)}</b>
        </div>
      ))}

      <div className="sm-row">
        <span className="sm-k">기관</span>
        <b className={`sm-v ${signClass(org)}`}>{qty(org)}</b>
      </div>
      {/* 합계 옆이 아니라 아래에 붙인다 — 한 줄에 넷을 우겨넣으면 폰에서 뭉갠다 */}
      <div className="sm-parts">
        {parts.map((p) => (
          <span className="sm-part" key={p.label} title={p.hint}>
            <em>{p.label}</em>
            <b className={signClass(p.v)}>{qty(p.v)}</b>
          </span>
        ))}
      </div>

      <div className="table-note">
        하루만 보면 <b>우연과 흐름이 안 갈립니다</b> — 오늘 판 게 며칠째 파는 중인지
        어제까지 사다가 오늘만 판 것인지는 정반대의 이야기라 5·20일을 같이 보세요.
        <br />
        <b>기관은 한 덩어리가 아닙니다.</b> 금융투자는 프로그램·헤지가 많아 방향성이 약하고
        연기금은 길게 담습니다 — 같은 플러스라도 어디서 나온 것인지에 따라 뜻이 다릅니다.
      </div>
    </div>
  );
}
