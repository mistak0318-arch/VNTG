import { useEffect, useMemo, useState } from "react";
import { api, type BuzzBoard, type BuzzBoardRow, type BuzzKind, type BuzzTermDetail } from "../api";
import { useSheetBack } from "../useSheetBack";

/**
 * 🌋 버즈 — 채널이 지금 무슨 얘기를 하는가 (2026-08-30 요청).
 *
 * ## 왜 만들었나
 *
 * 「데이터는 들어오는데 자세한 걸 볼 데가 없다」 — 정확한 지적이었다. 텔레그램
 * 알림은 「장전 브리핑룸에서 보세요」라고 하고, 그 카드는 요약 세 줄이 전부라
 * **서로를 가리키기만 하고 아무도 자세히 보여 주지 않았다.**
 *
 * ## 문턱 아래도 보여 준다
 *
 * 알림 문턱은 「울릴 것」을 고르는 값이지 「볼 것」을 고르는 값이 아니다. 문턱을
 * 넘은 것만 보여 주면 **아무것도 없는 날에 정말 조용한 건지 문턱이 높은 건지**
 * 알 수가 없다. 여기서는 창 안에서 언급된 것을 전부 늘어놓고, 문턱을 넘은 것에만
 * 금색 표시를 단다.
 *
 * ## 방 개수를 같이 센다
 *
 * **한 방이 같은 말을 열 번 한 것과 열 방이 한 번씩 한 것은 완전히 다른 사건**이다.
 * 앞은 그 방의 버릇이고 뒤는 시장의 화제다. 그래서 건수 옆에 방 개수를 붙인다.
 */

const WINDOWS = [
  /* 1시간 (2026-08-31 요청) — 장중에는 세 시간이면 이미 지나간 이야기다 */
  { h: 1, label: "1시간" },
  { h: 3, label: "3시간" },
  { h: 6, label: "6시간" },
  { h: 12, label: "12시간" },
  { h: 24, label: "24시간" },
  { h: 48, label: "48시간" },
];

const KIND_META: Record<BuzzKind, { label: string; hue: number }> = {
  myTheme: { label: "내 태그", hue: 145 },
  theme: { label: "테마", hue: 175 },
  stock: { label: "종목", hue: 265 },
  event: { label: "사건", hue: 25 },
  entity: { label: "인물·국가", hue: 205 },
};

function heat(ratio: number): number {
  return Math.max(0.16, Math.min(1, (ratio - 1) / 5));
}

function hsl2rgb(h: number, s: number, l: number): [number, number, number] {
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}
function luminance([r, g, b]: [number, number, number]): number {
  const c = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
}

/** 키워드 흐름과 같은 규칙 — 흰 글자 대비 4.5:1 을 넘을 때까지 명도를 낮춘다 */
function bubbleColor(kind: BuzzKind, ratio: number): string {
  const { hue } = KIND_META[kind];
  const h = heat(ratio);
  const sat = Math.round(34 + h * 28);
  let l = Math.round(22 + h * 24);
  while (l > 12 && 1.05 / (luminance(hsl2rgb(hue, sat, l)) + 0.05) < 4.5) l -= 2;
  return `hsl(${hue} ${sat}% ${l}%)`;
}

export function BuzzBoardPanel({
  onSelectStock,
}: {
  onSelectStock: (code: string, name: string) => void;
}) {
  const [hours, setHours] = useState(12);
  const [board, setBoard] = useState<BuzzBoard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<"ratio" | "recent" | "channels">("ratio");

  useEffect(() => {
    let alive = true;
    const load = () => {
      api
        .buzzBoard(hours)
        .then((b) => {
          if (!alive) return;
          setBoard(b);
          setError(null);
        })
        .catch((e: Error) => alive && setError(e.message));
    };
    load();
    /* 수집이 5분 주기라 그보다 자주 물어봐야 새 값이 없다 */
    const t = setInterval(load, 5 * 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [hours]);

  const rows = board?.rows ?? [];
  const sorted = useMemo(() => {
    const arr = [...rows];
    if (sortBy === "recent") arr.sort((a, b) => b.recent - a.recent);
    else if (sortBy === "channels") arr.sort((a, b) => b.channels - a.channels || b.recent - a.recent);
    return arr;
  }, [rows, sortBy]);

  const bubbles = sorted.slice(0, 40);
  const maxRecent = Math.max(1, ...bubbles.map((r) => r.recent));
  const alerted = rows.filter((r) => r.alerted);

  return (
    <div className="kwf">
      <div className="kwf-bar">
        <div className="kwf-wins">
          {WINDOWS.map((w) => (
            <button key={w.h} className={hours === w.h ? "on" : ""} onClick={() => setHours(w.h)}>
              {w.label}
            </button>
          ))}
          {/*
            직접 입력 (2026-08-31 요청) — 단추는 자주 쓰는 자리만 잡아 두고, 「2시간만」
            「어제 이맘때부터」처럼 그 사이를 보고 싶을 때가 있다. 1~336시간(2주).
          */}
          <label className="kwf-manual" title="시간을 직접 넣습니다 (1~336)">
            <input
              type="number"
              min={1}
              max={336}
              value={hours}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v) && v >= 1 && v <= 336) setHours(Math.round(v));
              }}
            />
            시간
          </label>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {!board && !error && <div className="empty">불러오는 중…</div>}

      {board && (
        <>
          <Headline board={board} onPick={setPicked} />
          <BoardHealth board={board} alerted={alerted.length} />
          <HourStrip board={board} />

          {bubbles.length === 0 ? (
            <div className="empty">
              최근 {board.windowHours}시간 동안 사전에 걸린 말이 없습니다.
              {!board.reader && " 텔레그램 세션이 없어 수집이 안 됩니다."}
            </div>
          ) : (
            <div className="kwf-cloud">
              {bubbles.map((r) => (
                <button
                  key={r.term}
                  className={`kwf-bub${r.alerted ? " both" : ""}`}
                  style={{
                    fontSize: `${11 + (r.recent / maxRecent) * 15}px`,
                    background: bubbleColor(r.kind, r.ratio),
                    borderColor: `hsl(${KIND_META[r.kind].hue} 45% ${Math.round(
                      34 + heat(r.ratio) * 22,
                    )}%)`,
                  }}
                  onClick={() => setPicked(r.term)}
                  title={`${KIND_META[r.kind].label} · ${r.recent}건 · ${r.channels}개 방 · 평소 ${r.baseline}건의 ${r.ratio}배`}
                >
                  {r.term}
                  <i>{board.baselineDays >= 2 ? `${r.ratio.toFixed(1)}×` : `${r.recent}건`}</i>
                  {r.alerted && <b className="kwf-both">급증</b>}
                </button>
              ))}
            </div>
          )}

          <div className="kwf-legend">
            {(Object.keys(KIND_META) as BuzzKind[]).map((k) => (
              <span key={k}>
                <i style={{ background: `hsl(${KIND_META[k].hue} 48% 38%)` }} />
                {KIND_META[k].label}
              </span>
            ))}
          </div>

          <div className="kwf-sort">
            <button className={sortBy === "ratio" ? "on" : ""} onClick={() => setSortBy("ratio")}>
              급증순
            </button>
            <button className={sortBy === "recent" ? "on" : ""} onClick={() => setSortBy("recent")}>
              건수순
            </button>
            <button
              className={sortBy === "channels" ? "on" : ""}
              onClick={() => setSortBy("channels")}
            >
              방 수순
            </button>
          </div>

          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>키워드</th>
                  <th>갈래</th>
                  <th className="num">지금</th>
                  <th className="num">방</th>
                  <th className="num">평소</th>
                  <th className="num">배율</th>
                </tr>
              </thead>
              <tbody>
                {sorted.slice(0, 50).map((r) => (
                  <tr
                    key={r.term}
                    className={`row-click${r.alerted ? " kwf-row-both" : ""}`}
                    onClick={() => setPicked(r.term)}
                  >
                    <td>
                      {r.term}
                      {r.alerted && <span className="kwf-new">급증</span>}
                    </td>
                    <td className="muted">{KIND_META[r.kind].label}</td>
                    <td className="num">{r.recent}</td>
                    <td className={`num${r.channels >= 3 ? " positive" : " muted"}`}>
                      {r.channels || "—"}
                      {/* 서명으로 걸러낸 몫 — 왜 건수가 적어 보이는지 설명해 준다 */}
                      {r.boilerplate >= 0.3 && (
                        <span
                          className="muted"
                          title={`언급의 ${Math.round(r.boilerplate * 100)}% 가 그 방들의 서명이라 뺐습니다`}
                        >
                          {" "}
                          ✂
                        </span>
                      )}
                    </td>
                    <td className="num muted">{board.baselineDays >= 2 ? r.baseline : "—"}</td>
                    <td className={`num${r.ratio >= 3 ? " positive" : ""}`}>
                      {board.baselineDays >= 2 ? `${r.ratio.toFixed(1)}×` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="table-note">
            <b>방</b> 칸이 중요합니다 — 한 방이 같은 말을 열 번 한 것과 <b>열 방이 한 번씩</b>{" "}
            한 것은 완전히 다른 사건입니다. 앞은 그 방의 버릇이고 뒤는 시장의 화제입니다.
            <br />
            <b>✂</b> 표시는 그 낱말의 언급 상당수가 <b>채널 서명</b>이라 뺐다는 뜻입니다 —
            「[하나증권 …]」처럼 방이 자기 소속을 밝히는 것은 시장의 화제가 아닙니다.
            <br />
            문턱(<b>{board.threshold.minCount}건·{board.threshold.minRatio}배</b> 또는{" "}
            <b>{board.threshold.sharpCount}건·{board.threshold.sharpRatio}배</b>)을 넘은 것에만
            금색 「급증」이 붙고 그때만 텔레그램으로 갑니다. <b>문턱 아래도 다 보여 주는</b>{" "}
            이유는, 안 보여 주면 조용한 날에 정말 조용한 건지 문턱이 높은 건지 알 수 없기
            때문입니다.
          </div>
        </>
      )}

      {picked && (
        <BuzzTermSheet term={picked} onClose={() => setPicked(null)} onSelectStock={onSelectStock} />
      )}
    </div>
  );
}

/**
 * 맨 위 한 문장 — **「지금 무슨 일인가」**를 읽고 끝낼 수 있게 (2026-08-30 요청).
 *
 * 낱말만 늘어놓으면 「관세, 트럼프, 중국」이라 결국 표를 다시 봐야 한다. 그래서
 * 문장으로 쓴다: **무엇이** 커졌고, **얼마나**(평소 대비), **몇 군데**에서, 그리고
 * **실제로 어떤 말**이 오갔는지. 근거를 같이 줘야 그 문장을 믿을 수 있다.
 *
 * 조용할 때도 문장으로 답한다 — 「없음」이라고만 하면 고장인지 조용한 건지 모른다.
 */
function Headline({
  board,
  onPick,
}: {
  board: BuzzBoard;
  onPick: (term: string) => void;
}) {
  const hot = board.rows.filter((r) => r.alerted).slice(0, 3);
  const win = `${board.windowHours}시간`;

  /*
   * ⚠️ 세션 유무를 **먼저** 보면 안 된다.
   *
   * 처음엔 `!reader` 이면 무조건 「수집이 멈춰 있습니다」로 끝냈는데, 그 아래에서는
   * 급증 2건을 보여 주고 있었다 — **같은 화면이 서로 다른 말을 했다.** 세션은
   * 배관 이야기이고 머리 문장은 데이터 이야기다. 창 안에 아무것도 없을 때만
   * 배관을 의심하는 게 맞다(그때는 그게 진짜 원인이다).
   */
  if (!board.reader && board.total === 0) {
    return (
      <div className="kwf-lead quiet">
        <b>수집이 멈춰 있습니다.</b> 텔레그램 사용자 세션이 없어 채널을 읽지 못합니다 —
        미니PC에서만 돕니다.
      </div>
    );
  }

  if (board.baselineDays < 2) {
    const top = board.rows.slice(0, 3);
    return (
      <div className="kwf-lead quiet">
        <b>아직 「평소」를 모릅니다</b> (기준선 {board.baselineDays}일). 며칠 쌓이면 갑자기
        커진 것을 짚어 드립니다.
        {top.length > 0 && (
          <>
            {" "}
            그동안은 <b>지금 많이 나온 말</b>만 보여 드립니다 —{" "}
            {top.map((r, i) => (
              <span key={r.term}>
                {i > 0 && ", "}
                <button className="kwf-lead-term" onClick={() => onPick(r.term)}>
                  {r.term}
                </button>
                <i> {r.recent}건</i>
              </span>
            ))}
            .
          </>
        )}
      </div>
    );
  }

  if (hot.length === 0) {
    const near = board.rows[0];
    return (
      <div className="kwf-lead quiet">
        <b>최근 {win}, 평소보다 크게 커진 주제는 없습니다.</b>
        {near ? (
          <>
            {" "}
            가장 눈에 띈 것은{" "}
            <button className="kwf-lead-term" onClick={() => onPick(near.term)}>
              {near.term}
            </button>
            (평소 {near.baseline}건 → {near.recent}건, {near.channels || "?"}개 방)이지만 아직
            문턱 아래입니다.
          </>
        ) : (
          " 사전에 걸린 말 자체가 없습니다."
        )}
      </div>
    );
  }

  const lead = hot[0];
  const others = hot.slice(1);
  return (
    <div className="kwf-lead hot">
      <div className="kwf-lead-main">
        지금 채널은{" "}
        <button className="kwf-lead-term big" onClick={() => onPick(lead.term)}>
          {lead.term}
        </button>{" "}
        얘기로 달아올랐습니다.
        {others.length > 0 && (
          <>
            {" "}
            <button className="kwf-lead-term" onClick={() => onPick(others[0].term)}>
              {others[0].term}
            </button>
            {others[1] && (
              <>
                ·
                <button className="kwf-lead-term" onClick={() => onPick(others[1].term)}>
                  {others[1].term}
                </button>
              </>
            )}
            도 같이 커졌습니다.
          </>
        )}
      </div>
      <div className="kwf-lead-why">
        평소 {win}에 <b>{lead.baseline}건</b>이던 것이 <b>{lead.recent}건</b>
        {lead.channels > 0 && (
          <>
            {" — "}
            <b>{lead.channels}개 방</b>이 함께 말하고 있습니다
            {lead.channels === 1 && " (한 방뿐이라 그 방의 버릇일 수 있습니다)"}
          </>
        )}
        .
      </div>
    </div>
  );
}

function BoardHealth({ board, alerted }: { board: BuzzBoard; alerted: number }) {
  return (
    <div className="kwf-health">
      <span>
        창 안 언급 <b>{board.total}</b>건
      </span>
      <span>
        기준선 <b>{board.baselineDays}</b>일
      </span>
      {alerted > 0 && (
        <span className="kwf-hot-count">
          급증 <b>{alerted}</b>건
        </span>
      )}
      {!board.reader && (
        <span className="kwf-warn">텔레그램 세션이 없어 수집이 안 됩니다 — 미니PC에서만 돕니다.</span>
      )}
      {board.reader && board.baselineDays < 3 && (
        <span className="kwf-warn">
          기준선 {board.baselineDays}/3일 — 사흘이 차기 전엔 배율 판정과 알림이 쉽니다.
        </span>
      )}
    </div>
  );
}

/** 시각별 언급량 — 「밤 몇 시에 터졌나」 */
function HourStrip({ board }: { board: BuzzBoard }) {
  if (board.byHour.length < 2) return null;
  const max = Math.max(...board.byHour.map((h) => h.count), 1);
  return (
    <div className="buzz-hours">
      {board.byHour.map((h) => (
        <div key={h.hour} className="buzz-hour" title={`${h.hour}시 ${h.count}건`}>
          <i style={{ height: `${Math.max(6, (h.count / max) * 100)}%` }} />
          <span>{h.hour}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * 낱말 하나의 속사정.
 *
 * 여기가 「자세한 내용」이다 — 언제부터 커졌나(48시간), 평소엔 어땠나(14일),
 * 어느 방이 말했나, 그리고 **실제 문장들**. 앞의 셋이 맥락이고 마지막이 근거다.
 */
function BuzzTermSheet({
  term,
  onClose,
  onSelectStock,
}: {
  term: string;
  onClose: () => void;
  onSelectStock: (code: string, name: string) => void;
}) {
  useSheetBack(true, onClose);
  const [d, setD] = useState<BuzzTermDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .buzzTerm(term)
      .then((r) => alive && setD(r))
      .catch((e: Error) => alive && setErr(e.message));
    return () => {
      alive = false;
    };
  }, [term]);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="sheet buzz-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-header">
          <h2>
            {term}
            {d?.kind && <span className="kwf-sheet-sub">{KIND_META[d.kind].label}</span>}
          </h2>
          <button className="close-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        {err && <div className="error-banner">{err}</div>}
        {!d && !err && <div className="empty">불러오는 중…</div>}

        {d && (
          <>
            {d.codes.length > 0 && (
              <div className="kwf-codes">
                {d.codes.map((c) => (
                  <button key={c} onClick={() => onSelectStock(c, term)}>
                    {c}
                  </button>
                ))}
              </div>
            )}

            <h4 className="buzz-h">언제부터 커졌나 <i>최근 48시간</i></h4>
            <Bars
              data={d.hourly.map((h) => ({ label: h.at.slice(-2), value: h.count }))}
              markEvery={6}
            />

            <h4 className="buzz-h">평소엔 어땠나 <i>최근 14일</i></h4>
            <Bars
              data={d.daily.map((x) => ({ label: x.day.slice(5), value: x.count }))}
              markEvery={3}
              wide
            />

            <h4 className="buzz-h">
              어느 방이 말했나 <i>{d.channels.length}개 방</i>
            </h4>
            {d.channels.length === 0 ? (
              <div className="empty">방 정보가 아직 없습니다 (이 기능 이후 쌓인 것부터 보입니다).</div>
            ) : (
              <div className="buzz-chans">
                {d.channels.map((c) => (
                  <span key={c.name}>
                    {c.name} <b>{c.count}</b>
                  </span>
                ))}
              </div>
            )}

            <h4 className="buzz-h">
              실제 문장 <i>{d.samples.length}건</i>
              {/*
                원문 창 (2026-08-31 요청) — 시트 안에서는 문장이 곁다리라 몇 줄만
                보인다. 정작 그 글을 읽고 싶을 때가 있고, 그때는 **글만 있는 화면**이
                필요하다. 본창을 안 떠나고 옆에 띄워 두고 읽으라고 팝업이다.
                텔레그램이 막힌 곳에서도 우리가 받아 둔 글은 그대로 읽힌다.
              */}
              <button
                className="buzz-src-btn"
                title="원문만 있는 작은 창으로 엽니다"
                onClick={() =>
                  window.open(
                    `${window.location.pathname}#/buzzSource?term=${encodeURIComponent(d.term)}`,
                    "vntg-buzz-src",
                    "width=620,height=880,resizable=yes,scrollbars=yes",
                  )
                }
              >
                🪟 원문 보기
              </button>
            </h4>
            {d.samples.length === 0 ? (
              <div className="empty">표본이 없습니다.</div>
            ) : (
              <ul className="buzz-msgs">
                {d.samples.map((s, i) => (
                  <li key={`${s.link}-${i}`}>
                    <div className="buzz-msg-head">
                      <b>{s.channel}</b>
                      <span>{s.at.slice(5, 16).replace("T", " ")}</span>
                    </div>
                    <p>{s.text}</p>
                    {s.link && (
                      <a href={s.link} target="_blank" rel="noreferrer">
                        원문 열기 ›
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** 작은 막대 그래프 — 눈금 없이 모양만. 정확한 값은 툴팁으로 */
function Bars({
  data,
  markEvery,
  wide,
}: {
  data: { label: string; value: number }[];
  markEvery: number;
  wide?: boolean;
}) {
  const max = Math.max(...data.map((d) => d.value), 1);
  if (data.every((d) => d.value === 0)) {
    return <div className="empty">이 구간에는 기록이 없습니다.</div>;
  }
  return (
    <div className={`buzz-bars${wide ? " wide" : ""}`}>
      {data.map((d, i) => (
        <div key={`${d.label}-${i}`} className="buzz-bar" title={`${d.label} · ${d.value}건`}>
          <i
            style={{
              height: `${d.value === 0 ? 2 : Math.max(8, (d.value / max) * 100)}%`,
              opacity: d.value === 0 ? 0.25 : 1,
            }}
          />
          <span>{i % markEvery === 0 ? d.label : ""}</span>
        </div>
      ))}
    </div>
  );
}
