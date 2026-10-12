import { useEffect, useState } from "react";
import { api, type ThemeFlowRow } from "../api";
import { ConstituentSheet, type ConstituentTarget } from "../components/overview/ConstituentSheet";
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
   * **테마명을 누르면 구성종목 시트가 뜬다** (2026-10-13).
   *
   * 처음엔 줄을 펼쳐 칩으로 늘어놓았는데 벤티지가 폰에서 보고 말했다 — "내 테마나 테마맵에서
   * 누를 때 나오는 것처럼 해 주면 안 돼? 이거 보기 불편한데." 맞는 말이다. 칩은 **등락률
   * 하나밖에 못 싣는다** — 현재가도 시총도 정렬도 없고, 폭이 좁으면 옆으로 잘린다.
   *
   * 테마맵·내 테마가 쓰는 `ConstituentSheet` 는 같은 물음에 이미 답하고 있다. 시세·시총·
   * 정렬·실시간(●)·＋내 태그·미국 짝까지 전부 붙어 있고, 무엇보다 **한 곳만 고치면 모든
   * 화면이 같이 좋아진다.** 테마 키(`kr:449`)를 그대로 넘기면 시트가 서버의 테마 강도에서
   * 꺼내 쓰므로 조회도 0회다.
   */
  const [pick, setPick] = useState<ConstituentTarget | null>(null);

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
              <tr key={r.key}>
                <td className="sticky-col">
                  <button
                    type="button"
                    className="tf-name"
                    onClick={() => setPick({ kind: "theme", code: r.key, name: r.name })}
                    title="눌러서 구성종목 보기"
                  >
                    <b>{r.name}</b>
                    <i>▸</i>
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
            ))}
          </tbody>
        </table>
      </div>
      <div className="table-note">{note}</div>
      {pick && (
        <ConstituentSheet
          target={pick}
          onClose={() => setPick(null)}
          onSelectStock={(code, name) => {
            setPick(null);
            onSelectStock?.(code, name);
          }}
        />
      )}
    </div>
  );
}
