import { useCallback, useEffect, useMemo, useState } from "react";
import { api, fmtNum, type EtfListRow, type WatchItem } from "../api";
import type { CumRow } from "../pages/EtfPage";

/**
 * ETF 관심종목 (2026-08-27) — **퇴직연금으로 굴리는 ETF를 따로 본다.**
 *
 * 관심종목(VNTG)은 종목·ETF가 섞여 있어서, ETF 만 보려면 매번 눈으로 걸러야 했다.
 * 그런데 ETF 는 보는 값이 다르다 — 개별 종목은 신호등·수급을 보지만 ETF 는
 * **괴리율·NAV·추적지수**가 먼저고, 퇴직연금이라 **얼마나 오래 들고 있나**가 중요하다.
 *
 * ## 저장은 기존 관심종목을 그대로 쓴다
 *
 * 별도 저장소를 만들지 않는다 — 같은 ETF 를 두 곳에서 관리하면 반드시 어긋난다.
 * 관심종목에 담되 **ETF 전체 시세(ka40004)에 있는 코드만** 여기 보여 준다.
 * 담기·빼기도 그 저장소에 그대로 쓰므로 관심종목 화면과 늘 같은 것을 본다.
 */

function pct(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "-";
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function cls(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v) || v === 0) return "";
  return v > 0 ? "positive" : "negative";
}

/** 편입 기간 — 퇴직연금은 「며칠 들고 얼마」가 전부다 */
function heldLabel(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400_000);
  if (!Number.isFinite(days) || days < 0) return "";
  if (days === 0) return "오늘";
  if (days < 31) return `${days}일`;
  return `${(days / 30.4).toFixed(1)}개월`;
}

export function EtfWatchTab({ onSelectStock }: { onSelectStock: (code: string, name: string) => void }) {
  const [rows, setRows] = useState<EtfListRow[] | null>(null);
  const [items, setItems] = useState<WatchItem[] | null>(null);
  const [groups, setGroups] = useState<string[]>([]);
  const [group, setGroup] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  /* 그룹 편집 (2026-08-27) — 켜면 그룹 줄에 ✎·✕ 가 붙고, 표에서 그룹을 넣고 뺀다 */
  const [editing, setEditing] = useState(false);
  const [newGroup, setNewGroup] = useState("");

  const load = useCallback(async () => {
    try {
      const [etf, w, g] = await Promise.all([api.etfList(), api.watchlist(), api.watchGroups()]);
      setRows(etf.rows);
      setItems(w.items);
      setGroups(g.groups);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "불러오기 실패");
    }
  }, []);

  /*
   * 기간 수익률 (2026-08-27) — ETF 는 **보유 기간별 성적**이 본론이다.
   * 「기간 등락률」 탭이 쓰는 것과 **같은 서버 계산**(ETF 모집단 누적)을 그대로 받아
   * 코드로 붙인다 — 새 계산을 만들면 두 화면이 언젠가 다른 말을 한다.
   * 값이 무거워 한 번만 받는다(시세와 달리 하루 안에 잘 안 바뀐다).
   */
  const [cum, setCum] = useState<Map<string, CumRow>>(new Map());
  useEffect(() => {
    let alive = true;
    fetch(`/api/rank/cumulative?days=5&market=ETF&universe=200`)
      .then((r) => r.json())
      .then((j: { rows?: CumRow[] }) => {
        if (alive) setCum(new Map((j.rows ?? []).map((r) => [r.code, r])));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    void load();
    /* ETF 시세는 자주 안 바뀐다 — 1분이면 넉넉하다 */
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 60_000);
    return () => clearInterval(t);
  }, [load]);

  /** 코드 → ETF 시세 (담긴 것 중 ETF 인 것만 걸러내는 잣대이기도 하다) */
  const etfByCode = useMemo(() => new Map((rows ?? []).map((r) => [r.code, r])), [rows]);

  /** 담긴 관심종목 중 **ETF 인 것만** — 그룹 필터까지 */
  const mine = useMemo(() => {
    return (items ?? [])
      .filter((it) => !it.divider && etfByCode.has(it.code))
      .filter((it) => !group || (it.groups ?? []).includes(group))
      .map((it) => ({ item: it, etf: etfByCode.get(it.code)! }))
      .sort((a, b) => (b.etf.changeRate ?? 0) - (a.etf.changeRate ?? 0));
  }, [items, etfByCode, group]);

  /* 담기 후보 — 아직 안 담은 ETF 중 검색어에 맞는 것 */
  const heldCodes = new Set((items ?? []).map((i) => i.code));
  const candidates = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    return (rows ?? [])
      .filter((r) => !heldCodes.has(r.code))
      .filter(
        (r) =>
          r.name.toLowerCase().includes(needle) ||
          r.index.toLowerCase().includes(needle) ||
          r.code.includes(needle),
      )
      .slice(0, 10);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, q, items]);

  async function addEtf(r: EtfListRow) {
    setBusy(true);
    try {
      await api.watchlistAdd({
        code: r.code,
        name: r.name,
        addedPrice: r.price,
        groups: group ? [group] : undefined,
      });
      setQ("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "담기 실패");
    } finally {
      setBusy(false);
    }
  }

  /* ── 그룹 편집 (2026-08-27) — 저장소가 관심종목과 같으니 그룹도 그쪽 API 를 그대로 쓴다 ── */
  async function addGroup() {
    const name = newGroup.trim();
    if (!name) return;
    setBusy(true);
    try {
      const r = await api.watchGroupAdd(name);
      setGroups(r.groups);
      setNewGroup("");
      setGroup(name); // 만들자마자 그 그룹을 보고 있게 — 담으러 온 것이다
    } catch (e) {
      setError(e instanceof Error ? e.message : "그룹 추가 실패");
    } finally {
      setBusy(false);
    }
  }

  async function renameGroup(from: string) {
    const next = window.prompt(`「${from}」의 새 이름`, from)?.trim();
    if (!next || next === from) return;
    try {
      const r = await api.watchGroupRename(from, next);
      setGroups(r.groups);
      if (group === from) setGroup(next);
      await load(); // 종목이 물고 있는 그룹 이름도 바뀐다
    } catch (e) {
      setError(e instanceof Error ? e.message : "이름 변경 실패");
    }
  }

  async function removeGroup(name: string) {
    if (!window.confirm(`「${name}」 그룹을 지웁니다. 담긴 종목은 남고 그룹만 빠집니다.`)) return;
    try {
      const r = await api.watchGroupRemove(name);
      setGroups(r.groups);
      if (group === name) setGroup("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "그룹 삭제 실패");
    }
  }

  /** 이 ETF 를 그 그룹에 넣거나 뺀다 — 한 종목이 여러 그룹에 들 수 있다 */
  async function toggleGroup(code: string, g: string) {
    try {
      const r = await api.watchGroupToggle(code, g);
      setItems(r.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : "그룹 변경 실패");
    }
  }

  async function removeEtf(code: string, name: string) {
    if (!window.confirm(`「${name}」을(를) 관심종목에서 뺍니다.`)) return;
    try {
      await api.watchlistRemove(code);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "삭제 실패");
    }
  }

  if (error) return <div className="error-banner">{error}</div>;
  if (rows === null || items === null) return <div className="empty">불러오는 중…</div>;

  /* 합계 — 퇴직연금은 「전체가 지금 어떤가」가 먼저다 */
  const rated = mine.filter((m) => m.etf.changeRate !== null);
  const avg =
    rated.length > 0 ? rated.reduce((a, b) => a + (b.etf.changeRate ?? 0), 0) / rated.length : null;
  const rise = rated.filter((m) => (m.etf.changeRate ?? 0) > 0).length;
  /*
   * ETF 의 판정 기준은 **개별 종목과 다르다** (2026-08-27).
   *
   * 정배열·수급·재무는 ETF 에 뜻이 없다 — 바구니는 실적을 내지 않는다.
   * ETF 에서 잘못될 수 있는 것은 둘뿐이고, 둘 다 **살 때·팔 때** 손해로 직결된다:
   *
   *   괴리율  제값(NAV)에서 얼마나 벗어나 거래되나 — 비싸게 사고 싸게 파는 위험
   *   유동성  거래대금이 얇으면 **팔고 싶을 때 못 판다**(호가가 벌어져 밀린다)
   *
   * 추적오차는 「지수를 잘 따라가나」인데 장기 보유(퇴직연금)에서만 누적으로 아프다.
   */
  const devWarn = mine.filter((m) => Math.abs(m.etf.deviation ?? 0) >= 1);
  const thin = mine.filter((m) => m.etf.tradeValue < 10);
  const errWarn = mine.filter((m) => Math.abs(m.etf.traceErr ?? 0) >= 1);

  return (
    <div>
      <div className="filter-row">
        <button
          className={`filter-btn ${!group ? "active" : ""}`}
          onClick={() => setGroup("")}
        >
          전체 {mine.length > 0 && <span className="pt-n">{mine.length}</span>}
        </button>
        {groups.map((g) => (
          <span className="etfw-gchip" key={g}>
            <button
              className={`filter-btn ${group === g ? "active" : ""}`}
              onClick={() => setGroup(group === g ? "" : g)}
            >
              {g}
              {/* 그 그룹에 담긴 ETF 수 — 비어 있는 그룹이 바로 보인다 */}
              <span className="pt-n">
                {" "}
                {
                  (items ?? []).filter((it) => !it.divider && etfByCode.has(it.code) && (it.groups ?? []).includes(g))
                    .length
                }
              </span>
            </button>
            {editing && (
              <>
                <button className="etfw-gedit" onClick={() => void renameGroup(g)} title="이름 바꾸기">
                  ✎
                </button>
                <button className="etfw-gedit" onClick={() => void removeGroup(g)} title="그룹 삭제">
                  ✕
                </button>
              </>
            )}
          </span>
        ))}
        {editing ? (
          <span className="etfw-gchip">
            <input
              className="ma-input uw-newgroup"
              autoFocus
              placeholder="새 그룹 이름"
              value={newGroup}
              onChange={(e) => setNewGroup(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void addGroup();
                if (e.key === "Escape") setNewGroup("");
              }}
            />
            <button className="filter-btn active" onClick={() => void addGroup()} disabled={busy || !newGroup.trim()}>
              추가
            </button>
          </span>
        ) : null}
        <button
          className={`filter-btn ${adding ? "active" : ""}`}
          onClick={() => setAdding((v) => !v)}
          title="ETF 이름·추적지수로 찾아 담습니다"
        >
          ＋ ETF 담기
        </button>
        <button
          className={`filter-btn ${editing ? "active" : ""}`}
          onClick={() => setEditing((v) => !v)}
          title="그룹을 만들고 이름을 바꾸고 지웁니다 — 켜면 표에서 그룹을 넣고 뺄 수 있습니다"
        >
          {editing ? "편집 끝" : "✏ 그룹 편집"}
        </button>
      </div>

      {adding && (
        <section className="pt-entry uw-add">
          <div className="pt-entry-row">
            <div className="pt-search">
              <input
                className="pt-input"
                autoFocus
                placeholder="ETF 이름·추적지수·코드 (예: KODEX 반도체, S&P500, 미국배당)"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
              {candidates.length > 0 && (
                <ul className="pt-results">
                  {candidates.map((r) => (
                    <li key={r.code}>
                      <button onClick={() => void addEtf(r)} disabled={busy}>
                        <b>{r.name}</b> <span className="pt-n">{r.code}</span>
                        <span className="pt-n"> · {r.index}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <button className="filter-btn" onClick={() => setAdding(false)}>
              닫기
            </button>
          </div>
          <span className="tg-ctl-hint">
            {group ? `「${group}」 그룹에 담깁니다` : "그룹을 고르고 담으면 그 그룹으로 들어갑니다"} ·
            편입가는 지금 가격으로 자동
          </span>
        </section>
      )}

      {mine.length === 0 ? (
        <div className="empty">
          담긴 ETF 가 없습니다 — 위 <b>「＋ ETF 담기」</b>로 추가하세요. 관심종목(VNTG)에
          담긴 ETF 도 여기 자동으로 나옵니다.
        </div>
      ) : (
        <>
          {/* 요약 + ETF 전용 경고 — 개별 종목의 신호등 자리에 오는 것들 */}
          <div className="etfw-sum">
            <span>
              담은 ETF <b>{mine.length}</b>
            </span>
            <span>
              오늘 평균 <b className={cls(avg)}>{pct(avg)}</b>
            </span>
            <span className="pt-n">
              ▲{rise} / ▼{rated.length - rise}
            </span>
            {devWarn.length > 0 && (
              <span className="etfw-warn" title={devWarn.map((m) => m.etf.name).join(", ")}>
                괴리 주의 {devWarn.length}
              </span>
            )}
            {thin.length > 0 && (
              <span className="etfw-warn" title={thin.map((m) => m.etf.name).join(", ")}>
                유동성 주의 {thin.length}
              </span>
            )}
            {errWarn.length > 0 && (
              <span className="etfw-warn" title={errWarn.map((m) => m.etf.name).join(", ")}>
                추적오차 큼 {errWarn.length}
              </span>
            )}
          </div>

          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>ETF</th>
                  <th>현재가</th>
                  <th>당일</th>
                  <th>편입가</th>
                  <th>수익률</th>
                  {/* 보유 기간별 성적 — ETF 의 본론 (2026-08-27) */}
                  <th title="최근 5거래일 누적">5일</th>
                  <th title="최근 10거래일 누적">10일</th>
                  <th title="최근 20거래일 누적 (약 한 달)">20일</th>
                  <th title="최근 60거래일 누적 (약 석 달)">60일</th>
                  {/* 아래 셋이 ETF 의 판정 기준 — 개별 종목의 신호등·수급 자리다 */}
                  <th title="NAV(제값) 대비 얼마나 벗어나 거래되나">괴리율</th>
                  <th title="지수를 얼마나 잘 따라가나 — 장기 보유에서 누적으로 아프다">추적오차</th>
                  <th title="거래대금이 얇으면 팔고 싶을 때 밀린다">유동성</th>
                  <th>추적지수</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {mine.map(({ item, etf }) => {
                  const ret =
                    item.addedPrice > 0 ? ((etf.price - item.addedPrice) / item.addedPrice) * 100 : null;
                  const c = cum.get(item.code);
                  return (
                    <tr key={item.code} className="clickable" onClick={() => onSelectStock(item.code, item.name)}>
                      <td className="sticky-col">
                        <b>{etf.name}</b> <span className="pt-n">{item.code}</span>
                        {/* 편집 중이면 그룹을 칩으로 눌러 넣고 뺀다 — 한 ETF 가 여러 그룹에 들 수 있다 */}
                        {editing ? (
                          <span className="etfw-gpick" onClick={(e) => e.stopPropagation()}>
                            {groups.map((g) => {
                              const on = (item.groups ?? []).includes(g);
                              return (
                                <button
                                  key={g}
                                  className={`jn-tag ${on ? "on" : ""}`}
                                  onClick={() => void toggleGroup(item.code, g)}
                                  title={on ? `「${g}」에서 빼기` : `「${g}」에 넣기`}
                                >
                                  {g}
                                </button>
                              );
                            })}
                          </span>
                        ) : (
                          (item.groups ?? []).length > 0 && (
                            <i className="etfw-groups">{(item.groups ?? []).join(" · ")}</i>
                          )
                        )}
                      </td>
                      <td className="num">{fmtNum(etf.price)}</td>
                      <td className={`num ${cls(etf.changeRate)}`}>{pct(etf.changeRate)}</td>
                      <td className="num">{fmtNum(item.addedPrice)}</td>
                      {/* 수익률 아래 편입 기간 — 「며칠 들고 얼마」 (관심종목 화면과 같은 문법) */}
                      <td className={`num strong-col ${cls(ret)}`}>
                        {pct(ret)}
                        <i className="wl-held">{heldLabel(item.addedAt)}</i>
                      </td>
                      {/* 기간 수익률 — 값이 아직 안 왔거나 봉이 모자라면 「-」 */}
                      {([c?.r5, c?.r10, c?.r20, c?.r60] as (number | null | undefined)[]).map((v, i) => (
                        <td key={i} className={`num ${cls(v)}`}>
                          {pct(v)}
                        </td>
                      ))}
                      {/* 괴리율 ±1% 넘으면 제값에서 멀다 — 그때 사면 그만큼 비싸게 산다 */}
                      <td
                        className={`num ${Math.abs(etf.deviation ?? 0) >= 1 ? "negative" : ""}`}
                        title="양수면 NAV 보다 비싸게(프리미엄) 거래 중"
                      >
                        {pct(etf.deviation)}
                      </td>
                      <td className={`num ${Math.abs(etf.traceErr ?? 0) >= 1 ? "negative" : ""}`}>
                        {etf.traceErr === null ? "-" : `${etf.traceErr.toFixed(2)}%`}
                      </td>
                      {/* 유동성 — 10억 미만이면 팔 때 호가가 벌어진다 */}
                      <td className={`num ${etf.tradeValue < 10 ? "negative" : ""}`}>
                        {fmtNum(Math.round(etf.tradeValue))}억
                      </td>
                      <td className="pt-n">{etf.index}</td>
                      <td>
                        <button
                          className="row-del-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            void removeEtf(item.code, item.name);
                          }}
                          title="관심종목에서 빼기"
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div className="table-note">
        <b>ETF 는 판정 기준이 다릅니다</b> — 정배열·수급·재무는 바구니에 뜻이 없습니다.
        여기서 보는 것은 셋입니다: <b>괴리율</b>(±1% 넘으면 제값에서 멀어 그만큼 비싸게
        사거나 싸게 팝니다) · <b>추적오차</b>(지수를 못 따라간 정도 — 오래 들고 있을수록
        누적으로 아픕니다) · <b>유동성</b>(거래대금 10억 미만이면 팔고 싶을 때 호가가
        벌어져 밀립니다). 수익률 옆 <b>편입 기간</b>은 퇴직연금처럼 길게 굴릴 때 「며칠
        들고 얼마」를 보라고 둡니다.
        <br />
        <b>그룹은 관심종목(VNTG)과 공유합니다</b> — 저장소가 하나라서 여기서 만든 그룹은
        관심종목에도 보이고, 그 반대도 같습니다. ETF 만 따로 묶고 싶으면 「퇴직연금」처럼
        <b> ETF 전용 그룹을 하나 만들어</b> 쓰면 됩니다(이 화면은 어차피 ETF 만 걸러 보여
        줍니다). 담긴 ETF 도 마찬가지로 관심종목에 함께 있습니다.
        과세유형(비과세·보유기간과세)·NAV·구성종목은 ETF 를 눌러 상세에서 봅니다.
      </div>
    </div>
  );
}
