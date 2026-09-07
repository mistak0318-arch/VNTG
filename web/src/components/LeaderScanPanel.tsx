import { useCallback, useEffect, useState } from "react";
import { SortableTh, useSortableTable } from "../useSortableTable";
import {
  api,
  fmtNum,
  signClass,
  type LeaderGroupStat,
  type LeaderScan,
  type LeaderTrackResult,
} from "../api";
import { LeaderConfigPanel } from "./LeaderConfigPanel";
import { SuperMark } from "../useSuperMarks";
import { WatchStar } from "../useWatchedCodes";
import type { LeaderMark, LeaderStock, LeaderTagCard } from "../api";

/**
 * 표식 묶음 — 종목명 옆 (2026-09-08). ★ 관심 · 🌟⚡🌈 · 신호등 점(원장에 있을 때만, 없으면 「안 잼」) · 🔥⏳.
 * 조회 0회 — 서버가 원장에서 붙여 보낸 `mark` 를 그린다. `SuperMark` 는 화면 쪽 원장 캐시라 둘이 같은 원장을 본다.
 */
export function MarkRow({ code, mark }: { code: string; mark?: LeaderMark }) {
  return (
    <span className="ls-marks">
      <WatchStar code={code} />
      <SuperMark code={code} />
      {mark?.signal ? (
        <span className="ls-sig" title={`신호등 분석 원장에 살아 있음 — 최근 ${mark.signal.score}점`}>
          <i className="sig-dot green" /> {mark.signal.score}
        </span>
      ) : (
        <span className="ls-sig none" title="신호등 원장에 없음 — 안 잼 (초록도 빨강도 아니다)">·</span>
      )}
      {mark && mark.hot.length > 0 && <span className="ls-alert" title={`🔥쏠림 ${mark.hot.join(" · ")}`}>🔥</span>}
      {mark && mark.late.length > 0 && <span className="ls-alert" title={`⏳늦음 ${mark.late.join(" · ")}`}>⏳</span>}
    </span>
  );
}

/** 태그 칩 — 숫자 붙은 것 (2026-09-08). 서버가 `tagDetail` 을 안 주면 이름만 */
export function TagChips({ t }: { t: Pick<LeaderStock, "tags" | "tagDetail"> }) {
  if (t.tagDetail && t.tagDetail.length > 0) {
    return (
      <>
        {t.tagDetail.map((d) => (
          <span className={`ls-tag tag-${d.tag}`} key={d.tag} title={d.hint}>
            {d.text}
          </span>
        ))}
      </>
    );
  }
  return (
    <>
      {t.tags.map((g) => (
        <span className="ls-tag" key={g}>
          {g}
        </span>
      ))}
    </>
  );
}

const TAG_ORDER = ["신고가", "거래량급증", "급등", "대금상위"];
const TAG_HINT: Record<string, string> = {
  신고가: "250일 최고가를 오늘 넘은 종목 — 추세장의 신호. 많을수록 판이 넓다",
  거래량급증: "전일 대비 거래량 2배↑ — 돈이 새로 들어온 자리. 신고가 없이 이것만 많으면 뜨거운 날",
  급등: "오늘 +5%↑ — 이미 오른 것. 이것만 많고 신고가가 적으면 하루 반짝일 확률이 높다",
  대금상위: "거래대금 문턱의 4배↑ — 단독으로는 못 들어오고 다른 태그와 겹칠 때만 붙는다",
};

/** 태그 카드 넷 — 「어떤 신호가 오늘 시장을 끌고 있나」 (2026-09-08) */
export function TagCards({
  cards,
  active,
  onPick,
  track,
  onSelectStock,
}: {
  cards: LeaderTagCard[];
  active: string | null;
  onPick: (tag: string | null) => void;
  /** 성적 탭에서 온 태그별 5일 평균·승률 — 있을 때만 */
  track?: Record<string, { avg5: number | null; win5: number | null; n: number }>;
  onSelectStock?: (code: string, name: string) => void;
}) {
  const by = new Map(cards.map((c) => [c.tag, c]));
  const nHigh = by.get("신고가")?.n ?? 0;
  const nSurge = by.get("급등")?.n ?? 0;
  const nVol = by.get("거래량급증")?.n ?? 0;
  const read =
    nHigh === 0 && nSurge === 0 && nVol === 0
      ? "걸린 게 없다 — 장 전이거나 조용한 날"
      : nHigh >= nSurge
        ? `신고가 ${nHigh} ≥ 급등 ${nSurge} — 추세가 넓다. 새 고점을 쓰는 판이다`
        : nSurge >= nHigh * 3 && nSurge >= 6
          ? `급등 ${nSurge} ≫ 신고가 ${nHigh} — 뜨거운 날. 이미 오른 것이 많고 새 고점은 적다 (체를 먼저)`
          : `급등 ${nSurge} > 신고가 ${nHigh} — 반등 또는 순환. 거래량 ${nVol} 이 어느 판에 몰렸나를 본다`;
  return (
    <div className="ls-cards-wrap">
      <div className="ls-cards">
        {TAG_ORDER.map((tag) => {
          const c = by.get(tag) ?? { tag, n: 0, green: 0, sectors: [], top: [] };
          const tr = track?.[tag];
          return (
            <button key={tag} className={`ls-card tag-${tag} ${active === tag ? "on" : ""}`} onClick={() => onPick(active === tag ? null : tag)} title={TAG_HINT[tag]}>
              <div className="ls-card-h">
                <b>{tag}</b>
                <span className="ls-card-n">{c.n}</span>
                {c.n > 0 && <i className="ls-card-g" title="신호등 원장에 살아 있는 것">초록 {c.green}</i>}
              </div>
              <div className="ls-card-sec">{c.sectors.length > 0 ? c.sectors.map((s) => `${s.name} ${s.n}`).join(" · ") : "—"}</div>
              <div className="ls-card-top">
                {c.top.map((t) => (
                  <span
                    key={t.code}
                    className="ls-card-stock"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectStock?.(t.code, t.name);
                    }}
                  >
                    {t.name}
                    <em className={signClass(t.changeRate)}> {pct(t.changeRate)}</em>
                    <SuperMark code={t.code} />
                  </span>
                ))}
              </div>
              {tr && tr.n > 0 && (
                <div className="ls-card-track">
                  5일 뒤 {tr.avg5 !== null ? pct(tr.avg5) : "-"} · 승률 {tr.win5 !== null ? `${tr.win5.toFixed(0)}%` : "-"} (n {tr.n})
                </div>
              )}
            </button>
          );
        })}
      </div>
      <div className="ls-cards-read">{read}</div>
    </div>
  );
}

/**
 * 주도주 탐색기 — **오늘 시장이 어디에 반응하는가.**
 *
 * 등락률 순위는 이미 있다. 그것만으로는 주도주를 못 고른다 — 하루 반짝 오른 것과
 * 사흘째 돈이 들어오는 것이 같은 목록에 섞여 나온다.
 *
 * 화면은 위에서 아래로 읽는 순서다.
 *   강한 섹터 (왜 강한가 · 이어지고 있나) → 걸린 종목 (왜 걸렸나)
 */

function pct(v: number): string {
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

export function LeaderScanPanel({
  onSelectStock,
  hideTrack = false,
}: {
  onSelectStock?: (code: string, name: string) => void;
  /** 주도주 메뉴는 성적을 제 탭에 두므로 여기선 숨긴다 (2026-09-08) */
  hideTrack?: boolean;
}) {
  const [data, setData] = useState<LeaderScan | null>(null);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  // 컬럼 정렬 — 모든 표 공통 규칙(2026-08-26)
  const stockSort = useSortableTable<LeaderScan["stocks"][number]>(data?.stocks ?? []);
  const [cfgOpen, setCfgOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (withNews: boolean) => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.leaderScan(withNews));
    } catch (e) {
      setError(e instanceof Error ? e.message : "불러오지 못했습니다");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    /*
     * 처음엔 **뉴스를 끄고** 부른다. 섹터마다 네이버를 부르므로 화면을 열 때마다
     * 돌면 하루 할당량이 녹는다. 「왜 강한가」는 눌러서 받는다.
     */
    void load(false);
    /* 장중엔 10분마다 스스로 (2026-09-08) — 09:00~15:40 만. 마감 뒤엔 하루의 결론이라 다시 볼 이유가 없다 */
    const t = window.setInterval(() => {
      const d = new Date();
      const m = d.getHours() * 60 + d.getMinutes();
      if (d.getDay() >= 1 && d.getDay() <= 5 && m >= 9 * 60 && m <= 15 * 60 + 40) void load(false);
    }, 10 * 60_000);
    return () => window.clearInterval(t);
  }, [load]);

  const hasNews = (data?.sectors ?? []).some((s) => s.news.length > 0);

  return (
    <div className="ls">
      <div className="filter-row">
        <button className="primary-btn" onClick={() => void load(false)} disabled={loading}>
          {loading ? "훑는 중…" : "다시 훑기"}
        </button>
        <button className="filter-btn" onClick={() => void load(true)} disabled={loading}>
          {hasNews ? "뉴스 다시" : "왜 강한가 (뉴스)"}
        </button>
        <button
          className={`filter-btn ${cfgOpen ? "active" : ""}`}
          onClick={() => setCfgOpen((v) => !v)}
        >
          조건
        </button>
        {data && (
          <span className="pt-n">
            거래대금 상위 {data.scanned}종목 · {data.config.minTradeValue}억 미만{" "}
            {data.belowThreshold}개 제외 · {new Date(data.at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })} 갱신{data.intraday ? " (장중, 10분마다)" : ""}
            {typeof data.newCount === "number" && data.newCount > 0 && <b className="ls-new-count"> · 오늘 처음 걸린 것 {data.newCount}</b>}
          </span>
        )}
      </div>

      {error && <div className="error-banner">{error}</div>}
      {data?.note && <div className="alert-note">{data.note}</div>}

      {/*
        조건 — **설정 > 분석 기준과 같은 패널**이다 (2026-08-27).
        예전엔 이 화면 안에만 있어서, 교차 신호나 브리핑에서 결과를 본 사람은
        그 숫자가 어디서 정해졌는지 못 찾았다. 값은 서버 한 곳이라 어디서 바꾸든 같다.
      */}
      {cfgOpen && (
        <section className="card">
          <h2>탐색 조건</h2>
          <LeaderConfigPanel />
        </section>
      )}

      {loading && !data && <div className="empty">거래대금 상위를 훑는 중…</div>}

      {/* ---------------- 강한 섹터 ---------------- */}
      {data && (
        <section className="card">
          <h2>강한 섹터</h2>
          {data.sectors.length === 0 ? (
            <div className="page-note">
              조건에 맞는 섹터가 없습니다. 장 시작 전이라 거래대금이 안 쌓였거나, 문턱이 높습니다.
            </div>
          ) : (
            <div className="ls-secs">
              {data.sectors.map((s) => (
                <div className="ls-sec" key={s.name}>
                  <div className="ls-sec-h">
                    <b className="ls-sec-nm">{s.name}</b>
                    <span className={`ls-sec-rt ${signClass(s.weightedRate)}`}>
                      {pct(s.weightedRate)}
                    </span>
                    {/*
                      폭이 낮으면 섹터가 아니라 **종목 이슈**다.
                      +3% 를 한 종목이 만든 것과 여덟 종목이 만든 것은 완전히 다른 장이다.
                    */}
                    <span
                      className={`ls-badge ${s.breadth >= 70 ? "ok" : "warn"}`}
                      title="오른 종목 비율 — 낮으면 섹터가 아니라 종목 이슈입니다"
                    >
                      폭 {s.breadth.toFixed(0)}% ({s.rising}/{s.members})
                    </span>
                    {s.prevBreadth !== null && s.prevBreadth !== undefined && (
                      <span className={`ls-arrow ${s.breadth > s.prevBreadth + 5 ? "up" : s.breadth < s.prevBreadth - 5 ? "down" : ""}`} title="어제 폭 → 오늘 폭">
                        어제 {s.prevBreadth.toFixed(0)}% {s.breadth > s.prevBreadth + 5 ? "↗" : s.breadth < s.prevBreadth - 5 ? "↘" : "→"}
                      </span>
                    )}
                    {s.streak !== null && s.streak >= 2 && <span className="ls-streak" title="며칠째 상위 섹터">{s.streak}일째</span>}
                    <span className="pt-n">{fmtNum(s.tradeValue)}억</span>
                  </div>

                  <div className="ls-sec-sub">
                    {/* 가중과 단순이 벌어지면 대형주 혼자 끌고 있다는 뜻이다 */}
                    <span title="단순평균. 가중과 크게 벌어지면 대형주 혼자 끌고 있다는 뜻입니다">
                      단순 {pct(s.simpleRate)}
                    </span>
                    <span title="며칠 연속 상위에 들었나">
                      연속 {s.streak === null ? "-" : `${s.streak}일`}
                    </span>
                    <span title="어제 뽑힌 종목 중 오늘도 남은 비율">
                      유지 {s.carryOver === null ? "-" : `${s.carryOver.toFixed(0)}%`}
                    </span>
                  </div>

                  <div className="ls-sec-leaders">
                    {s.leaders.map((l) => (
                      <button
                        key={l.code}
                        className="ls-chip"
                        onClick={() => onSelectStock?.(l.code, l.name)}
                        title={l.tags.join(" · ")}
                      >
                        {l.name}
                        <span className={signClass(l.changeRate)}> {pct(l.changeRate)}</span>
                      </button>
                    ))}
                  </div>

                  {s.news.length > 0 && (
                    <ul className="ls-news">
                      {s.news.map((n) => (
                        <li key={n.link}>
                          <a href={n.link} target="_blank" rel="noreferrer">
                            {n.title}
                          </a>
                          <span className="pt-n"> {n.press}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          )}
          <div className="table-note">
            등락률은 <b>거래대금 가중</b>입니다 — 보려는 게 「돈이 어디로 갔나」이므로 돈으로
            가중하는 게 맞습니다. <b>폭</b>을 같이 보세요: 한 종목이 끌어올린 +3%와 여덟 종목이
            고르게 오른 +3%는 완전히 다른 장입니다. <b>연속·유지</b>는 기록이 쌓여야 나옵니다.
          </div>
        </section>
      )}

      {/* ---------------- 태그 카드 넷 (2026-09-08) ---------------- */}
      {data && data.tagCards && <TagCards cards={data.tagCards} active={tagFilter} onPick={setTagFilter} onSelectStock={onSelectStock} />}

      {/* ---------------- 걸린 종목 ---------------- */}
      {data && (
        <section className="card">
          <h2>
            걸린 종목 ({tagFilter ? `${data.stocks.filter((s) => s.tags.includes(tagFilter)).length} / ` : ""}{data.stocks.length})
            {tagFilter && (
              <button className="filter-btn" onClick={() => setTagFilter(null)}>
                {tagFilter} 만 보는 중 — 전부
              </button>
            )}
          </h2>
          {data.stocks.length === 0 ? (
            <div className="page-note">조건에 맞는 종목이 없습니다.</div>
          ) : (
            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <SortableTh columnKey="name" label="종목" accessor={(t: LeaderScan["stocks"][number]) => t.name} sort={stockSort} className="sticky-col" />
                    <SortableTh columnKey="sector" label="업종" accessor={(t: LeaderScan["stocks"][number]) => t.sector ?? ""} sort={stockSort} />
                    <SortableTh columnKey="rate" label="등락률" accessor={(t: LeaderScan["stocks"][number]) => t.changeRate} sort={stockSort} />
                    <SortableTh columnKey="tv" label="거래대금" accessor={(t: LeaderScan["stocks"][number]) => t.tradeValue} sort={stockSort} />
                    <SortableTh columnKey="vol" label="거래량" accessor={(t: LeaderScan["stocks"][number]) => t.volumeRatio ?? -1} sort={stockSort} />
                    <th title="왜 걸렸나">이유</th>
                  </tr>
                </thead>
                <tbody>
                  {stockSort.sorted.filter((t) => !tagFilter || t.tags.includes(tagFilter)).map((t) => (
                    <tr
                      className={`clickable-row ${t.mark && (t.mark.hot.length > 0 || t.mark.late.length > 0) ? "ls-dim" : ""}`}
                      key={t.code}
                      onClick={() => onSelectStock?.(t.code, t.name)}
                      title={t.mark && (t.mark.hot.length > 0 || t.mark.late.length > 0) ? "🔥쏠림·⏳늦음 경보 — 뜨겁다는 뜻이지 좋다는 뜻이 아니다 (신조 ①체)" : undefined}
                    >
                      <td className="sticky-col">
                        {t.name}
                        {t.isNew && <i className="ls-new" title="오늘 처음 걸렸다 (어제 기록에 없음)">N</i>}
                        <MarkRow code={t.code} mark={t.mark} />
                      </td>
                      {/* 업종을 모르는 종목도 목록에는 남는다 — 신규상장은 스냅샷이 아직 못 담는다 */}
                      <td className="pt-n">{t.sector || "-"}</td>
                      <td className={`num ${signClass(t.changeRate)}`}>{pct(t.changeRate)}</td>
                      <td className="num">{fmtNum(t.tradeValue)}억</td>
                      <td className="num">
                        {t.volumeRatio === null ? "-" : `${t.volumeRatio.toFixed(1)}배`}
                      </td>
                      <td>
                        <TagChips t={t} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="table-note">
            <b>거래대금만 큰 종목은 안 넣습니다.</b> 삼성전자처럼 늘 상위에 있는 종목이 매일
            목록을 채우면, 오늘 새로 반응한 종목이 묻힙니다. 신고가·거래량급증·급등 중
            <b> 하나라도 걸려야</b> 들어옵니다. 종목을 누르면 신호등·차트·수급으로 갑니다.
          </div>
        </section>
      )}

      {!hideTrack && <LeaderTrackSection onSelectStock={onSelectStock} />}
    </div>
  );
}

/**
 * 성적 — **「그때 뽑은 게 그 뒤 어떻게 됐나」.**
 *
 * 고르는 것만으로는 눈이 안 자란다. 골라 놓고 결과를 안 보면 **맞은 것만 기억**한다.
 * 진짜 물음은 「탐색기가 맞나」가 아니라 **「나는 어떤 종류의 신호를 잘 고르나」**다.
 */
export function LeaderTrackSection({
  onSelectStock,
}: {
  onSelectStock?: (code: string, name: string) => void;
}) {
  const [data, setData] = useState<LeaderTrackResult | null>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.leaderTrack());
    } catch (e) {
      setError(e instanceof Error ? e.message : "불러오지 못했습니다");
    } finally {
      setLoading(false);
    }
  }, []);

  /*
   * 열었을 때만 부른다. 종목마다 일봉을 받아야 해서 몇 십 초 걸린다 —
   * 탐색하러 온 날에도 매번 기다리게 하면 안 된다.
   */
  useEffect(() => {
    if (open && !data) void load();
  }, [open, data, load]);

  return (
    <section className="card">
      <h2 className="ls-track-h">
        성적 — 그때 뽑은 게 그 뒤 어떻게 됐나
        <button className="filter-btn" onClick={() => setOpen((v) => !v)}>
          {open ? "접기" : "펼치기"}
        </button>
        {open && (
          <button className="filter-btn" onClick={() => void load()} disabled={loading}>
            {loading ? "…" : "↻"}
          </button>
        )}
      </h2>

      {!open ? (
        <div className="page-note">
          탐색기가 매일 뽑아 둔 것을 <b>1·5·20·60거래일</b>까지 따라갑니다. 종목마다 일봉을
          받아야 해서 눌렀을 때만 조회합니다.
        </div>
      ) : (
        <>
          {loading && !data && <div className="empty">일봉을 받는 중… (종목당 약 0.3초)</div>}
          {error && <div className="error-banner">{error}</div>}
          {data && <div className="alert-note">{data.note}</div>}

          {data && data.overall.n > 0 && (
            <>
              <h3 className="section-heading">어떤 신호를 잘 고르나</h3>
              <StatTable rows={data.byTag} label="이유" />
              <div className="table-note">
                <b>이게 이 화면의 본론입니다.</b> 신고가로 걸린 것과 거래량 급증으로 걸린 것은
                성격이 완전히 다릅니다 — 어느 쪽이 내 손에 맞는지는 세어 봐야 압니다. 한 종목이
                태그를 여럿 달면 <b>각 태그에 모두</b> 들어갑니다.
              </div>

              {data.bySector.length > 0 && (
                <>
                  <h3 className="section-heading">섹터는 이어졌나</h3>
                  <StatTable rows={data.bySector} label="섹터" />
                  <div className="table-note">
                    그때 강했던 섹터가 <b>그 뒤에도 강했는지</b>가 「주도 섹터」와 「하루 반짝」을
                    가릅니다.
                  </div>
                </>
              )}

              <h3 className="section-heading">전체</h3>
              <StatTable rows={[data.overall]} label="구분" />
            </>
          )}

          {data && data.picks.length > 0 && (
            <>
              <h3 className="section-heading">뽑힌 것들 ({data.picks.length})</h3>
              <div className="data-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th className="sticky-col">종목</th>
                      <th>편입일</th>
                      <th>편입가</th>
                      <th>이유</th>
                      {[1, 5, 20, 60].map((d) => (
                        <th key={d}>{d}일</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.picks.slice(0, 200).map((p) => (
                      <tr
                        className="clickable-row"
                        key={`${p.date}-${p.code}`}
                        onClick={() => onSelectStock?.(p.code, p.name)}
                      >
                        <td className="sticky-col">{p.name}</td>
                        <td>{p.date.slice(5)}</td>
                        <td className="num">{fmtNum(p.price)}</td>
                        <td>
                          {p.tags.map((g) => (
                            <span className="ls-tag" key={g}>
                              {g}
                            </span>
                          ))}
                        </td>
                        {[1, 5, 20, 60].map((d) => {
                          const o = p.outcomes.find((x) => x.days === d);
                          return (
                            <td className={`num ${o ? signClass(o.rate) : ""}`} key={d}>
                              {o ? `${o.rate > 0 ? "+" : ""}${o.rate.toFixed(2)}%` : "-"}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="table-note">
                빈 칸은 <b>아직 그만큼 지나지 않은 것</b>입니다. 결과는 편입 <b>다음</b> 거래일부터
                셉니다.
                {data.failed > 0 && ` · ${data.failed}종목은 일봉을 받지 못했습니다.`}
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}

/** 태그·섹터·전체가 같은 모양이라 표 하나로 그린다 */
function StatTable({ rows, label }: { rows: LeaderGroupStat[]; label: string }) {
  if (rows.length === 0) return <div className="page-note">아직 셀 것이 없습니다.</div>;
  return (
    <div className="data-table-wrap">
      <table className="data-table num">
        <thead>
          <tr>
            <th className="sticky-col">{label}</th>
            <th>기간</th>
            <th>건수</th>
            <th title="편입가보다 오른 비율">승률</th>
            <th>평균</th>
            <th title="몇 종목이 크게 튀면 평균이 거짓말을 한다">중앙값</th>
            <th>최고</th>
            <th>최저</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((g) =>
            g.byHorizon.map((h, i) => (
              <tr key={`${g.key}-${h.days}`} className={h.n === 0 ? "st-empty" : ""}>
                {i === 0 && (
                  <td className="sticky-col" rowSpan={g.byHorizon.length}>
                    <b>{g.key}</b>
                  </td>
                )}
                <td>{h.days}일</td>
                <td>{h.n}</td>
                <td className={h.n === 0 ? "" : h.winRate >= 50 ? "positive" : "negative"}>
                  {h.n === 0 ? "-" : `${h.winRate.toFixed(0)}%`}
                </td>
                <td className={h.n === 0 ? "" : signClass(h.avg)}>
                  {h.n === 0 ? "-" : `${h.avg > 0 ? "+" : ""}${h.avg.toFixed(2)}%`}
                </td>
                <td className={h.n === 0 ? "" : signClass(h.median)}>
                  {h.n === 0 ? "-" : `${h.median > 0 ? "+" : ""}${h.median.toFixed(2)}%`}
                </td>
                {/*
                  최고가 음수일 수 있다 — 그 기간에 오른 게 하나도 없으면 그렇다.
                  거기에 「+」를 붙이면 `+-5.37%` 가 된다. 부호는 값이 정하게 둔다.
                */}
                <td className={h.n === 0 ? "" : signClass(h.best)}>
                  {h.n === 0 ? "-" : `${h.best > 0 ? "+" : ""}${h.best.toFixed(2)}%`}
                </td>
                <td className={h.n === 0 ? "" : signClass(h.worst)}>
                  {h.n === 0 ? "-" : `${h.worst > 0 ? "+" : ""}${h.worst.toFixed(2)}%`}
                </td>
              </tr>
            )),
          )}
        </tbody>
      </table>
    </div>
  );
}
