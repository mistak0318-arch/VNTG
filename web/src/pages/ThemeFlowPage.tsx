import { useEffect, useState } from "react";
import React from "react";
import { api, type ThemeFlowRow } from "../api";
import { MultCell, TodayCell, cls, eok, pct } from "../components/FlowBits";

/**
 * **테마 자금흐름** (2026-10-12) — ETF 자금흐름의 네이버 테마 판.
 *
 * 벤티지: "ETF랑 똑같은 구조로 해서 네이버 테마로도 구성해보자고."
 *
 * ETF 판은 대표 ETF 쉰 남짓만 본다. ETF 가 안 만들어진 테마는 **아예 화면에 없다.**
 * 네이버 테마는 수백 개고 벤티지가 이미 믿는 분류라, ETF 로는 안 보이는 쏠림이 여기서
 * 드러난다. **같은 잣대**(1·5·20일 + 거래대금 배수)로 나란히 둬야 그 차이가 읽힌다.
 *
 * 등락률은 대세 테마 분석이 쓰는 함수(`themeTrend`)가 낸 값 그대로다 — 같은 테마를 두고
 * 두 화면이 다른 숫자를 말하면 둘 다 못 믿는다.
 */

/** 정렬할 수 있는 칸 — 숫자 칸 전부 */
type SortKey = "d1" | "d5" | "d20" | "volRatio" | "value5" | "todayValue" | "members";

export function ThemeFlowPage({ onSelectStock }: { onSelectStock?: (code: string, name: string) => void }) {
  const [rows, setRows] = useState<ThemeFlowRow[] | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("volRatio");
  const [desc, setDesc] = useState(true);
  const [help, setHelp] = useState(false);
  /*
   * **테마명을 누르면 구성종목이 펼쳐진다** (2026-10-13 — 벤티지: "네이버 테마 부분
   * 테마명 누르면 종목 구성 보이게 해줘야지").
   *
   * 시트로 띄우지 않고 **줄을 펼친다.** 이 화면은 이미 시트 안에서 열릴 수 있는데
   * 시트 위에 시트를 올리면 뒤로가기가 엉킨다(10/08 에 ETF 상세에서 겪었다).
   * 펼치면 표를 떠나지 않아 「어느 테마의 종목인지」도 눈에 남는다.
   */
  const [open, setOpen] = useState<string | null>(null);
  const [stocks, setStocks] = useState<Record<string, { code: string; name: string; changeRate: number | null; desc: string }[]>>({});
  const toggle = (key: string) => {
    setOpen((v) => (v === key ? null : key));
    if (!stocks[key]) {
      void api
        .themeStocks2("kr", key)
        .then((r) => setStocks((m) => ({ ...m, [key]: r.stocks })))
        .catch(() => setStocks((m) => ({ ...m, [key]: [] })));
    }
  };

  useEffect(() => {
    let alive = true;
    api
      .themeFlow("kr")
      .then((r) => {
        if (!alive) return;
        setRows(r.rows);
        setNote(r.note);
      })
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, []);

  if (error) return <div className="page-note">테마 자금흐름을 못 받았습니다 — {error}</div>;
  if (!rows) return <div className="page-note">불러오는 중…</div>;

  const sorted = [...rows].sort((a, b) => {
    const av = a[sortKey];
    const bv = b[sortKey];
    /* 못 잰 값은 **늘 뒤로** — 뒤집었다고 「모르는 것」이 1등이 되면 안 된다 */
    if (av === null) return 1;
    if (bv === null) return -1;
    return desc ? bv - av : av - bv;
  });
  const hit = (k: SortKey) => () => {
    if (k === sortKey) setDesc((v) => !v);
    else {
      setSortKey(k);
      setDesc(true);
    }
  };
  const Th = ({ k, children, title }: { k: SortKey; children: React.ReactNode; title?: string }) => (
    <th className={`sortable-th${sortKey === k ? " active" : ""}`} onClick={hit(k)} title={title}>
      {children}
      <i>{sortKey === k ? (desc ? "▾" : "▴") : ""}</i>
    </th>
  );

  /* 맨 위 한 줄 — 돈이 제일 몰린 테마와 20일 최고. 표를 다 읽기 전에 답이 보여야 한다 */
  const hot = [...rows].filter((r) => r.volRatio !== null).sort((a, b) => (b.volRatio ?? 0) - (a.volRatio ?? 0))[0];
  const best20 = [...rows].filter((r) => r.d20 !== null).sort((a, b) => (b.d20 ?? 0) - (a.d20 ?? 0))[0];

  return (
    <div className="page">
      <div className="tt-bar">
        {hot && (
          <span className="fl-chip hot">
            지금 돈이 제일 몰린 테마 <b>{hot.name}</b> <em>{hot.volRatio?.toFixed(2)}배</em>
          </span>
        )}
        {best20 && (
          <span className={`fl-chip ${cls(best20.d20)}`}>
            20일 최고 <b>{best20.name}</b> <em>{pct(best20.d20)}</em>
          </span>
        )}
        <button type="button" className={`tt-info${help ? " on" : ""}`} onClick={() => setHelp((v) => !v)} title="이 표를 읽는 법">
          ⓘ
        </button>
      </div>
      {help && (
        <p className="page-note">
          <b>배수</b>는 최근 5일 평균 거래대금 ÷ 그 앞 20일 평균입니다 — <b>1.5 이상</b>이면 전보다 돈이 몰리는 중입니다.
          등락률은 구성종목 평균이고 <b>대세 테마 분석과 같은 값</b>입니다. {note}
        </p>
      )}
      <div className="data-table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th className="sticky-col">테마</th>
              <Th k="members" title="구성종목 수 / 그중 일봉으로 잰 수">종목</Th>
              <th>대표주</th>
              <Th k="d1">1일</Th>
              <Th k="d5">5일</Th>
              <Th k="d20">20일</Th>
              <Th k="volRatio" title="최근 5일 평균 거래대금 ÷ 그 앞 20일 평균">배수</Th>
              <Th k="value5">5일 평균</Th>
              <Th k="todayValue">오늘</Th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <React.Fragment key={r.key}>
              <tr className={open === r.key ? "tf-open" : undefined}>
                <td className="sticky-col">
                  <button type="button" className="tf-name" onClick={() => toggle(r.key)} title="눌러서 구성종목 보기">
                    <b>{r.name}</b>
                    <i>{open === r.key ? "▾" : "▸"}</i>
                  </button>
                </td>
                <td className="num pt-n">
                  {r.measured}/{r.members}
                </td>
                <td>
                  {r.leadCode && r.leadName ? (
                    <button type="button" className="ss-peer" onClick={() => onSelectStock?.(r.leadCode!, r.leadName!)}>
                      {r.leadName}
                    </button>
                  ) : (
                    "-"
                  )}
                </td>
                <td className={`num ${cls(r.d1)}`}>{pct(r.d1)}</td>
                <td className={`num ${cls(r.d5)}`}>{pct(r.d5)}</td>
                <td className={`num ${cls(r.d20)}`}>{pct(r.d20)}</td>
                <td className="num">
                  <MultCell v={r.volRatio} />
                </td>
                <td className="num">{eok(r.value5)}</td>
                <td className="num">
                  <TodayCell today={r.todayValue} avg5={r.value5} />
                </td>
              </tr>
              {open === r.key && (
                <tr className="tf-stocks">
                  <td colSpan={9}>
                    {!stocks[r.key] ? (
                      <span className="pt-n">불러오는 중…</span>
                    ) : stocks[r.key].length === 0 ? (
                      <span className="pt-n">구성종목을 못 받았습니다.</span>
                    ) : (
                      <div className="tf-chips">
                        {stocks[r.key].map((x) => (
                          <button
                            key={x.code}
                            type="button"
                            className={`tf-chip ${cls(x.changeRate)}`}
                            onClick={() => onSelectStock?.(x.code, x.name)}
                            title={x.desc || undefined}
                          >
                            {x.name}
                            {x.changeRate !== null && <em>{pct(x.changeRate)}</em>}
                          </button>
                        ))}
                      </div>
                    )}
                  </td>
                </tr>
              )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <div className="table-note">{note}</div>
    </div>
  );
}
