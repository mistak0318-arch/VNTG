import { useEffect, useMemo, useState } from "react";
import { api, type KeywordFlow, type KeywordHit, type KeywordKind } from "../api";
import { useSheetBack } from "../useSheetBack";

/**
 * 키워드 흐름 (2026-08-30 요청 — 「뉴스에서 트렌드·키워드를 자동으로 잡자」).
 *
 * ## 이 화면이 답하는 질문
 *
 * 「지금 뉴스에서 **평소보다 갑자기 커진 말**이 뭔가.」
 *
 * 「많이 나온 말」이 아니다. 그건 매일 삼성전자·코스피라 아무것도 안 알려 준다.
 * 게다가 언급 1위 종목은 대개 **이미 오른 종목**이라 보고 들어가면 늦는다.
 * 그래서 크기(언급 수)보다 **진하기(급증 배율)**를 먼저 보게 만들었다.
 *
 * ## 왜 동그라미인가
 *
 * 표로 주면 위에서부터 읽게 되는데, 이 데이터는 **한눈에 덩어리를 보는 것**이
 * 목적이다. 큰 것이 많이 나온 것, 진한 것이 갑자기 커진 것 — 진하고 큰 것이
 * 오른쪽 위에 몰려 있으면 그게 오늘의 사건이다. 정확한 숫자가 필요하면 아래 표.
 *
 * ## ⚠️ 기준선이 없으면 급증도 없다
 *
 * 어제까지의 기록이 있어야 「평소」를 안다. 하루도 안 쌓였으면 배율이 무의미하므로
 * 화면이 그렇게 **말한다** — 지어낸 배율을 보여 주는 것보다 낫다.
 */

const WINDOWS = [
  { min: 10, label: "10분" },
  { min: 30, label: "30분" },
  { min: 60, label: "1시간" },
  { min: 180, label: "3시간" },
  { min: 360, label: "6시간" },
  { min: 1440, label: "24시간" },
];

const KIND_META: Record<KeywordKind, { label: string; hue: number }> = {
  myTheme: { label: "내 테마", hue: 145 },
  theme: { label: "테마", hue: 175 },
  stock: { label: "종목", hue: 265 },
  event: { label: "사건", hue: 25 },
  entity: { label: "인물·국가", hue: 205 },
  new: { label: "신규어", hue: 320 },
};

/** 배율 → 색 진하기. 2배부터 눈에 띄게, 6배 넘으면 더 진해지지 않는다(눈이 못 센다) */
function heat(ratio: number): number {
  return Math.max(0.16, Math.min(1, (ratio - 1) / 5));
}

/* ── 색: 흰 글자가 읽히는 선까지만 밝힌다 ──────────────────────────────── */

function hsl2rgb(h: number, s: number, l: number): [number, number, number] {
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

/** WCAG 상대 휘도 */
function luminance([r, g, b]: [number, number, number]): number {
  const c = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
}

/**
 * ⚠️ **HSL 명도가 같아도 색상마다 실제 밝기가 다르다.**
 *
 * 처음엔 색상별로 같은 명도를 썼는데, 실측에서 초록·틸 계열이 흰 글자 대비
 * **2.3:1** 로 나왔다(합격선 4.5:1). 같은 `lightness 46%` 라도 초록은 파랑보다
 * 훨씬 밝기 때문이다. 손으로 색상마다 상한을 정할 수도 있지만, 색을 하나 더할
 * 때마다 또 손으로 맞춰야 한다.
 *
 * 그래서 **재서 낮춘다.** 대비가 4.5 를 넘을 때까지 명도를 2씩 내린다. 색을 나중에
 * 바꾸거나 더해도 규칙이 저절로 지켜진다.
 */
function bubbleColor(kind: KeywordKind, ratio: number): string {
  const { hue } = KIND_META[kind];
  const h = heat(ratio);
  const sat = Math.round(34 + h * 28);
  let l = Math.round(22 + h * 24);
  while (l > 12 && 1.05 / (luminance(hsl2rgb(hue, sat, l)) + 0.05) < 4.5) l -= 2;
  return `hsl(${hue} ${sat}% ${l}%)`;
}

export function KeywordFlowPanel({
  onSelectStock,
}: {
  onSelectStock: (code: string, name: string) => void;
}) {
  const [windowMin, setWindowMin] = useState(60);
  const [flow, setFlow] = useState<KeywordFlow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<KeywordHit | null>(null);
  /** 표를 배율순으로 볼지 건수순으로 볼지 */
  const [sortBy, setSortBy] = useState<"ratio" | "recent">("ratio");

  const load = (min: number) => {
    api
      .keywordFlow(min)
      .then((f) => {
        setFlow(f);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  };

  useEffect(() => {
    load(windowMin);
    /* 3분마다 — 수집 주기와 같다. 더 자주 불러도 새 기사가 없다 */
    const t = setInterval(() => load(windowMin), 3 * 60_000);
    return () => clearInterval(t);
  }, [windowMin]);

  const refresh = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.keywordCollect();
      load(windowMin);
    } catch {
      /* 수집 실패는 화면을 막지 않는다 — 지금 있는 것으로 계속 본다 */
    } finally {
      setBusy(false);
    }
  };

  const hits = flow?.hits ?? [];
  const sorted = useMemo(() => {
    const arr = [...hits];
    if (sortBy === "recent") arr.sort((a, b) => b.recent - a.recent);
    return arr;
  }, [hits, sortBy]);

  /* 동그라미는 상위 40개까지 — 그 아래는 눈으로 구분이 안 된다 */
  const bubbles = sorted.slice(0, 40);
  const maxRecent = Math.max(1, ...bubbles.map((h) => h.recent));

  return (
    <div className="kwf">
      <div className="kwf-bar">
        <div className="kwf-wins">
          {WINDOWS.map((w) => (
            <button
              key={w.min}
              className={windowMin === w.min ? "on" : ""}
              onClick={() => setWindowMin(w.min)}
            >
              {w.label}
            </button>
          ))}
        </div>
        <button className="kwf-refresh" onClick={() => void refresh()} disabled={busy}>
          {busy ? "긁는 중…" : "지금 긁기"}
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {!flow && !error && <div className="empty">불러오는 중…</div>}

      {flow && (
        <>
          <NewsHeadline flow={flow} onPick={setPicked} />
          <Health flow={flow} />
          <Timeline flow={flow} />

          {bubbles.length === 0 ? (
            <div className="empty">
              이 창에서는 두 번 이상 나온 말이 없습니다. 창을 넓혀 보세요.
            </div>
          ) : (
            <div className="kwf-cloud">
              {bubbles.map((h) => (
                <button
                  key={h.term}
                  /* 「양쪽」은 이 화면에서 제일 값진 신호라 테두리로 크게 표시한다 —
                     배지만 달면 동그라미가 많을 때 묻힌다 */
                  className={`kwf-bub${h.fresh ? " fresh" : ""}${
                    h.buzzRatio !== null && h.buzzRatio >= 2 ? " both" : ""
                  }`}
                  style={{
                    /* 크기는 건수, 색은 배율 — 두 축을 한 동그라미에 담는다 */
                    fontSize: `${11 + (h.recent / maxRecent) * 15}px`,
                    background: bubbleColor(h.kind, h.ratio),
                    borderColor: `hsl(${KIND_META[h.kind].hue} 45% ${Math.round(
                      34 + heat(h.ratio) * 22,
                    )}%)`,
                  }}
                  onClick={() => setPicked(h)}
                  title={`${KIND_META[h.kind].label} · ${h.recent}건 · 평소 ${h.baseline}건 · ${h.ratio}배`}
                >
                  {h.term}
                  <i>{h.fresh ? "NEW" : `${h.ratio.toFixed(1)}×`}</i>
                  {h.buzzRatio !== null && h.buzzRatio >= 2 && <b className="kwf-both">양쪽</b>}
                </button>
              ))}
            </div>
          )}

          <Legend />

          <div className="kwf-sort">
            <button className={sortBy === "ratio" ? "on" : ""} onClick={() => setSortBy("ratio")}>
              급증순
            </button>
            <button className={sortBy === "recent" ? "on" : ""} onClick={() => setSortBy("recent")}>
              건수순
            </button>
          </div>

          <div className="data-table-wrap">
            <table className="data-table kwf-table">
              <thead>
                <tr>
                  <th>키워드</th>
                  <th>갈래</th>
                  <th className="num">지금</th>
                  <th className="num">평소</th>
                  <th className="num">배율</th>
                  <th className="num">채널</th>
                  <th className="num">등락</th>
                </tr>
              </thead>
              <tbody>
                {sorted.slice(0, 40).map((h) => (
                  <tr
                    key={h.term}
                    onClick={() => setPicked(h)}
                    className={`row-click${
                      h.buzzRatio !== null && h.buzzRatio >= 2 ? " kwf-row-both" : ""
                    }`}
                  >
                    <td>
                      {h.term}
                      {h.fresh && <span className="kwf-new">NEW</span>}
                    </td>
                    <td className="muted">{KIND_META[h.kind].label}</td>
                    <td className="num">{h.recent}</td>
                    <td className="num muted">{h.baseline || "—"}</td>
                    <td className={`num${h.ratio >= 3 ? " positive" : ""}`}>
                      {h.fresh ? "신규" : `${h.ratio.toFixed(1)}×`}
                    </td>
                    <td className="num">
                      {h.buzzRatio === null ? (
                        <span className="muted" title="채널 쪽 기준선이 아직 모자랍니다">
                          —
                        </span>
                      ) : h.buzzRatio >= 2 ? (
                        <span className="positive">{h.buzzRatio.toFixed(1)}×</span>
                      ) : (
                        <span className="muted">·</span>
                      )}
                    </td>
                    <td className="num">
                      {h.changeRate === undefined ? (
                        <span className="muted">—</span>
                      ) : (
                        <span className={h.changeRate >= 0 ? "positive" : "negative"}>
                          {h.changeRate.toFixed(2)}%
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="table-note">
            <b>동그라미의 크기</b>는 지금 나온 건수, <b>색 진하기</b>는 평소 대비 몇 배인지입니다.
            진하고 큰 것이 오늘의 사건입니다.
            <br />
            <b>「양쪽」</b>은 텔레그램 채널에서도 같이 급증했다는 뜻입니다. 채널은 빠르고
            투기적이고 뉴스는 느리고 공식적이라 <b>편향 방향이 반대</b>입니다 — 둘이 같이
            떴다면 한쪽만 뜬 것보다 믿을 만합니다.
            <br />
            <b>등락</b> 칸이 이미 크게 올라 있으면 그 키워드는 <b>뒷북</b>일 수 있습니다.
          </div>
        </>
      )}

      {flow && <BuzzSection />}

      {picked && <KeywordSheet hit={picked} onClose={() => setPicked(null)} onSelectStock={onSelectStock} />}
    </div>
  );
}

/**
 * 맨 위 한 문장 — **「지금 뉴스가 무슨 일로 시끄러운가」** (2026-08-30 요청).
 *
 * 낱말만 늘어놓으면 결국 표를 다시 봐야 한다. 그래서 문장으로 쓴다: 무엇이,
 * 얼마나(평소 대비), **몇 개 매체**가, 그리고 **실제 기사 제목**까지.
 *
 * 매체 수를 근거로 넣는 이유: 같은 기사가 열 매체로 퍼지면 건수는 열 배가 되지만
 * 그건 열 개의 사건이 아니라 **한 사건이 열 번 복사된 것**이다. 반대로 여러 매체가
 * 각자 다르게 쓰고 있으면 그건 진짜 큰 건이다. 숫자 하나로 그 둘이 갈린다.
 */
function NewsHeadline({
  flow,
  onPick,
}: {
  flow: KeywordFlow;
  onPick: (h: KeywordHit) => void;
}) {
  const win =
    flow.windowMin >= 60 ? `${Math.round(flow.windowMin / 60)}시간` : `${flow.windowMin}분`;

  if (flow.baselineDays < 1) {
    const top = flow.hits.slice(0, 3);
    return (
      <div className="kwf-lead quiet">
        <b>아직 「평소」를 모릅니다.</b> 하루치가 더 쌓이면 갑자기 커진 말을 짚어 드립니다.
        {top.length > 0 && (
          <>
            {" "}
            그동안은 <b>많이 나온 말</b>만 —{" "}
            {top.map((h, i) => (
              <span key={h.term}>
                {i > 0 && ", "}
                <button className="kwf-lead-term" onClick={() => onPick(h)}>
                  {h.term}
                </button>
                <i> {h.recent}건</i>
              </span>
            ))}
            .
          </>
        )}
      </div>
    );
  }

  /* 문턱이랄 게 없는 화면이라 「충분히 뜻밖인 것」을 직접 고른다 */
  const hot = flow.hits.filter((h) => h.z >= 2.2 && h.recent >= 3).slice(0, 3);
  if (hot.length === 0) {
    const near = flow.hits[0];
    return (
      <div className="kwf-lead quiet">
        <b>최근 {win}, 뉴스에 크게 커진 주제는 없습니다.</b>
        {near && (
          <>
            {" "}
            가장 눈에 띈 것은{" "}
            <button className="kwf-lead-term" onClick={() => onPick(near)}>
              {near.term}
            </button>
            (평소 {near.baseline}건 → {near.recent}건)이지만 아직 평소 범위 안입니다.
          </>
        )}
      </div>
    );
  }

  const lead = hot[0];
  const others = hot.slice(1);
  const quote = lead.samples[0];
  return (
    <div className="kwf-lead hot">
      <div className="kwf-lead-main">
        지금 뉴스는{" "}
        <button className="kwf-lead-term big" onClick={() => onPick(lead)}>
          {lead.term}
        </button>{" "}
        {lead.fresh ? "얘기가 처음 올라왔습니다." : "얘기로 시끄럽습니다."}
        {others.length > 0 && (
          <>
            {" "}
            {others.map((h, i) => (
              <span key={h.term}>
                {i > 0 && "·"}
                <button className="kwf-lead-term" onClick={() => onPick(h)}>
                  {h.term}
                </button>
              </span>
            ))}
            도 같이 커졌습니다.
          </>
        )}
      </div>
      <div className="kwf-lead-why">
        평소 {win}에 <b>{lead.baseline}건</b>이던 것이 <b>{lead.recent}건</b>
        {lead.presses > 0 && (
          <>
            {" — "}
            <b>{lead.presses}개 매체</b>가 다루고 있습니다
            {lead.presses === 1 && " (한 매체뿐이라 아직 단발입니다)"}
          </>
        )}
        {lead.buzzRatio !== null && lead.buzzRatio >= 2 && (
          <>
            . 텔레그램 채널에서도 <b>같이 급증</b>했습니다
          </>
        )}
        .
      </div>
      {quote && (
        <div className="kwf-lead-quote">
          「{quote.title}」 <i>({quote.press})</i>
        </div>
      )}
    </div>
  );
}

/**
 * 지금 이 화면을 믿어도 되나.
 *
 * 「아무것도 안 뜬다」가 **조용한 것인지 고장인지** 구분이 안 되면 사람은 화면을
 * 안 믿게 된다. 기사 수와 기준선 일수를 그대로 보여 준다.
 */
function Health({ flow }: { flow: KeywordFlow }) {
  const thin = flow.articles < 5;
  return (
    <div className="kwf-health">
      <span>
        창 안 기사 <b>{flow.articles}</b>건
      </span>
      <span>
        기준선 <b>{flow.baselineDays}</b>일
      </span>
      {flow.baselineDays < 2 && (
        <span className="kwf-warn">
          평소를 아직 모릅니다 — 배율 대신 <b>건수</b>로 보세요. 하루 더 쌓이면 급증
          판정이 섭니다.
        </span>
      )}
      {thin && flow.baselineDays >= 2 && (
        <span className="kwf-warn">
          표본이 적어(<b>{flow.articles}건</b>) 배율이 크게 흔들립니다. 창을 넓혀 보세요.
        </span>
      )}
      {!flow.buzzReady && (
        <span className="muted">채널 쪽 기준선이 모자라 「양쪽」 확인은 아직 못 합니다</span>
      )}
    </div>
  );
}

/** 분 단위 기사량 — 「지금 시끄러운가」를 한 줄로 */
function Timeline({ flow }: { flow: KeywordFlow }) {
  const t = flow.timeline;
  if (t.length < 3) return null;
  const max = Math.max(...t.map((x) => x.count), 1);
  return (
    <div className="kwf-timeline" title="분 단위 기사 수">
      {t.map((x) => (
        <i key={x.minute} style={{ height: `${Math.max(8, (x.count / max) * 100)}%` }} />
      ))}
    </div>
  );
}

function Legend() {
  return (
    <div className="kwf-legend">
      {(Object.keys(KIND_META) as KeywordKind[]).map((k) => (
        <span key={k}>
          <i style={{ background: `hsl(${KIND_META[k].hue} 48% 38%)` }} />
          {KIND_META[k].label}
        </span>
      ))}
    </div>
  );
}

/**
 * 🌋 채널 버즈 — **다른 쪽 귀** (2026-08-30, 「버즈 볼 수 있는 메뉴를 못 찾겠다」).
 *
 * 원래 장전 브리핑룸의 여섯 번째 카드에만 있어서, 한참 스크롤해야 나왔다. 그런데
 * 이건 위쪽 뉴스 키워드와 **같은 물음의 다른 답**이라(느린 귀 / 빠른 귀) 나란히
 * 있어야 뜻이 산다. 위에서 「양쪽」 배지를 보고 여기서 그 근거를 확인하게 된다.
 *
 * ## 있으면 크게, 없으면 조용히
 *
 * 버즈는 **드물게 뜨는 것이 정상**이다. 매일 뜨면 문턱이 낮은 것이다. 그래서
 * 평소엔 한 줄로 접혀 있다가, **뜨는 날은 눈에 띄게** 펼친다 — 놓치면 안 되는
 * 정보인데 평소와 같은 모양이면 그냥 지나친다.
 */
function BuzzSection() {
  const [buzz, setBuzz] = useState<Awaited<ReturnType<typeof api.buzz>> | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .buzz()
      .then((b) => alive && setBuzz(b))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  if (!buzz) return null;
  const hits = buzz.hits ?? [];
  const hot = hits.length > 0;

  return (
    <div className={`kwf-buzz${hot ? " hot" : ""}`}>
      <button className="kwf-buzz-head" onClick={() => setOpen((v) => !v)}>
        <span className="kwf-buzz-title">
          🌋 채널 버즈
          {hot ? (
            <b className="kwf-buzz-count">{hits.length}건 급증</b>
          ) : (
            <i>최근 {buzz.windowHours}시간 조용함</i>
          )}
        </span>
        <span className="kwf-buzz-toggle">{open || hot ? "▾" : "▸"}</span>
      </button>

      {/* 뜬 날은 접혀 있어도 보여 준다 — 한 번 더 눌러야 보이면 놓친다 */}
      {(open || hot) && (
        <div className="kwf-buzz-body">
          {hot ? (
            <>
              <p className="kwf-buzz-lead">
                텔레그램 채널에서 평소보다 크게 늘어난 주제입니다. 위 뉴스 목록에도
                같은 말이 있으면 <b>양쪽</b> 배지가 붙습니다 — 그게 제일 믿을 만합니다.
              </p>
              {hits.map((h) => (
                <div className="kwf-buzz-hit" key={h.term}>
                  <div className="kwf-buzz-hit-head">
                    <b>{h.term}</b>
                    <span>
                      {h.recent}건 · 평소 {h.baseline}건의 <b>{h.ratio}배</b>
                    </span>
                  </div>
                  {h.samples[0] && (
                    <p className="kwf-buzz-sample">
                      {h.samples[0].text.slice(0, 100)}
                      <i> ({h.samples[0].channel})</i>
                    </p>
                  )}
                </div>
              ))}
            </>
          ) : (
            <BuzzWhy buzz={buzz} />
          )}
        </div>
      )}
    </div>
  );
}

/** 조용할 때 「왜 안 뜨나」 — 고장인지 진짜 조용한 건지 */
function BuzzWhy({ buzz }: { buzz: NonNullable<Awaited<ReturnType<typeof api.buzz>>> }) {
  if (buzz.health && !buzz.health.reader) {
    return (
      <p className="kwf-buzz-lead">
        텔레그램 사용자 세션이 없어 수집이 안 됩니다 — 미니PC에서만 돕니다.
      </p>
    );
  }
  if (buzz.baselineDays < 3) {
    return (
      <p className="kwf-buzz-lead">
        기준선 수집 중 ({buzz.baselineDays}/3일). 사흘치가 쌓이면 「평소 대비 몇 배」
        판정이 시작됩니다.
        {buzz.health && (
          <>
            {" "}
            오늘 센 것 <b>{buzz.health.todayCount}건</b>.
          </>
        )}
      </p>
    );
  }
  return (
    <>
      <p className="kwf-buzz-lead">
        문턱은 <b>{buzz.threshold?.minCount}건·{buzz.threshold?.minRatio}배</b> 또는{" "}
        <b>{buzz.threshold?.sharpCount}건·{buzz.threshold?.sharpRatio}배</b>입니다.
      </p>
      {buzz.nearMiss && buzz.nearMiss.length > 0 ? (
        <>
          <p className="kwf-buzz-lead">아깝게 못 넘은 것 — 여기가 줄줄이면 문턱이 높은 것입니다.</p>
          <div className="kwf-buzz-near">
            {buzz.nearMiss.slice(0, 6).map((t) => (
              <span key={t.term}>
                {t.term} <b>{t.recent}건·{t.ratio}배</b>
              </span>
            ))}
          </div>
        </>
      ) : (
        <p className="kwf-buzz-lead">문턱 근처에 온 것도 없습니다 — 정말로 조용합니다.</p>
      )}
    </>
  );
}

/** 왜 떴는지 — 그 낱말이 실제로 나온 기사들 */
function KeywordSheet({
  hit,
  onClose,
  onSelectStock,
}: {
  hit: KeywordHit;
  onClose: () => void;
  onSelectStock: (code: string, name: string) => void;
}) {
  useSheetBack(true, onClose);
  return (
    <div className="overlay" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-header">
          <h2>
            {hit.term}
            <span className="kwf-sheet-sub">
              {KIND_META[hit.kind].label} · {hit.recent}건
              {hit.fresh ? " · 처음 등장" : ` · 평소의 ${hit.ratio.toFixed(1)}배`}
            </span>
          </h2>
          <button className="close-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        {hit.codes.length > 0 && (
          <div className="kwf-codes">
            {hit.codes.map((c) => (
              <button key={c} onClick={() => onSelectStock(c, hit.term)}>
                {c}
              </button>
            ))}
          </div>
        )}

        {hit.samples.length === 0 ? (
          <div className="empty">표본이 없습니다.</div>
        ) : (
          <ul className="kwf-arts">
            {hit.samples.map((s) => (
              <li key={s.link}>
                <a href={s.link} target="_blank" rel="noreferrer">
                  {s.title}
                </a>
                <span className="muted">
                  {s.press} · {s.at.slice(11, 16)}
                </span>
              </li>
            ))}
          </ul>
        )}

        <div className="table-note">
          기사 표본은 <b>최근 6건</b>만 남깁니다 — 목록이 아니라 「왜 떴는지」를 보려는
          칸입니다.
        </div>
      </div>
    </div>
  );
}
