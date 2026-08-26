import { useEffect, useMemo, useState } from "react";
import { api, fmtNum, signClass, type TrackedStock } from "../api";
import { fid, krxOverlayLive, useRealtime } from "../useRealtime";
import { ColumnGrip, useColumnWidths } from "./ColumnWidths";

/**
 * 관심종목 실시간 시세판 — **HTS [0130] 자리.**
 *
 * ## 왜 이제야 되나
 *
 * 예전 방식(REST 폴링)으로는 스무 종목을 실시간으로 못 봤다. 키움은 **TR 당 초당 5건**이라
 * 종목마다 부르면 넷째 종목에서 이미 한도다. 그래서 관심종목 화면은 늘 「몇 십 초 전 값」이었다.
 *
 * 웹소켓은 **등록해 두면 밀어준다.** 종목 수가 늘어도 호출이 늘지 않는다 —
 * 오십 종목을 세 번의 등록 요청으로 걸어 확인했다.
 *
 * ## 밑그림은 REST
 *
 * 실시간은 「지금부터의 변화」만 준다. 장이 닫혀 있거나 방금 열었을 때 빈 표가 뜨면
 * 못 쓰므로, 관심종목 추적(REST)을 깔고 그 위에 실시간을 얹는다.
 *
 * ## 폰에서 읽히게
 *
 * 칸을 여섯 개 이상 두면 폰에서 글자가 뭉갠다. **이름·현재가·등락률·체결강도** 넷만 둔다.
 * 체결강도를 넣은 건 등락률만으로는 「오르는 중」과 「올라서 멈춘 것」이 안 갈리기 때문이다.
 */

type SortKey = "rate" | "name" | "strength";

export function WatchTicker({
  onSelectStock,
}: {
  onSelectStock?: (code: string, name: string) => void;
}) {
  const [base, setBase] = useState<TrackedStock[] | null>(null);
  const [sort, setSort] = useState<SortKey>("rate");
  /* 칸 너비 조절 — 시세분석과 같은 공통 모듈 */
  const cw = useColumnWidths("watchTicker");

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .watchlistTracking()
        .then((r) => alive && setBase(r.items))
        .catch(() => alive && setBase([]));
    void load();
    // 밑그림은 자주 받을 이유가 없다 — 실시간이 위에서 갱신한다
    const t = setInterval(load, 120_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const codes = useMemo(() => (base ?? []).map((b) => b.code).filter(Boolean), [base]);
  const rt = useRealtime(
    codes.map((c) => `0B:${c}`),
    1500,
  );

  if (base === null) return <div className="empty">불러오는 중…</div>;
  if (base.length === 0) return <div className="empty">관심종목이 없습니다.</div>;

  /*
   * 실시간이 있으면 그 값, 없으면 REST 값.
   * FID: 10 현재가 · 12 등락율 · 13 누적거래량 · 228 체결강도
   */
  const rows = base.map((b) => {
    // KRX 정규장 밖엔 0B 를 안 믿는다 — 프리장 KRX 0% 가 본 시세(통합)를 덮었다
    const v = krxOverlayLive() ? rt.values[`0B:${b.code}`] ?? null : null;
    const live = fid(v, "10");
    const rate = fid(v, "12");
    return {
      ...b,
      shownPrice: live === null ? b.price : Math.abs(live),
      shownRate: rate === null ? b.changeRate : rate,
      volume: fid(v, "13"),
      strength: fid(v, "228"),
      isLive: live !== null,
    };
  });

  rows.sort((a, b) => {
    if (sort === "name") return a.name.localeCompare(b.name);
    if (sort === "strength") return (b.strength ?? -1) - (a.strength ?? -1);
    return b.shownRate - a.shownRate;
  });

  const liveCount = rows.filter((r) => r.isLive).length;

  return (
    <div>
      <div className="filter-row">
        {(
          [
            ["rate", "등락률"],
            ["strength", "체결강도"],
            ["name", "이름"],
          ] as [SortKey, string][]
        ).map(([k, l]) => (
          <button
            key={k}
            className={`filter-btn ${sort === k ? "active" : ""}`}
            onClick={() => setSort(k)}
          >
            {l}
          </button>
        ))}
        {/* 몇 개가 실제로 실시간인지 — 장이 닫히면 0 이 되는 게 정상이다 */}
        <span className={`pt-n ${rt.healthy ? "" : "negative"}`}>
          {rt.healthy ? `실시간 ${liveCount}/${rows.length}` : "실시간 끊김"}
        </span>
      </div>

      <div className="data-table-wrap">
        <table className={`data-table num wt${cw.customized ? " col-fixed" : ""}`}>
          <colgroup>
            {["name", "price", "rate", "strength"].map((k) => (
              <col key={k} style={cw.styleOf(k)} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th className="sticky-col">
                종목
                <ColumnGrip cw={cw} k="name" />
              </th>
              <th>
                현재가
                <ColumnGrip cw={cw} k="price" />
              </th>
              <th>
                등락률
                <ColumnGrip cw={cw} k="rate" />
              </th>
              <th title="100 을 넘으면 매수 체결이 우세. 등락률만으로는 오르는 중과 올라서 멈춘 것이 안 갈린다">
                체결강도
                <ColumnGrip cw={cw} k="strength" />
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.code}
                className={onSelectStock ? "clickable-row" : ""}
                onClick={() => onSelectStock?.(r.code, r.name)}
              >
                <td className="sticky-col">
                  {/* 실시간으로 도는 종목에 점 하나 — 어떤 게 살아 있는지 */}
                  {r.isLive && <span className="wt-dot" />}
                  {r.name}
                </td>
                <td>{fmtNum(r.shownPrice)}</td>
                <td className={signClass(r.shownRate)}>
                  {r.shownRate > 0 ? "+" : ""}
                  {r.shownRate.toFixed(2)}%
                </td>
                <td className={r.strength === null ? "pt-n" : r.strength >= 100 ? "positive" : "negative"}>
                  {r.strength === null ? "-" : r.strength.toFixed(0)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="table-note">
        <b>체결강도</b>는 100 을 넘으면 매수 체결이 우세하다는 뜻입니다 — 등락률만으로는
        「오르는 중」과 「올라서 멈춘 것」이 안 갈립니다. 점(●)이 붙은 종목은 지금 실시간으로
        도는 것이고, 장이 닫히면 밑그림(조회) 값만 남습니다.
      </div>
    </div>
  );
}
