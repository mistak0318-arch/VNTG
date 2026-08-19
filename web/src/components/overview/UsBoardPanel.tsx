import { useCallback, useEffect, useState } from "react";
import {
  api,
  fmtNum,
  type RateRow,
  type UsBoardSignal,
  type UsMajorResult,
  type UsQuoteRow,
  type UsWatchGroup,
  type UsSearchResult,
} from "../../api";
import { useSection } from "../../useSection";
import { YahooChartSheet, type ChartTarget } from "./YahooChartSheet";
import { showDayQuote } from "../../usSession";

/**
 * 미국 전광판.
 *
 * 미국장이 열려 있는 동안 보는 자리다. 국내 시황 카드들 사이에 흩어져 있던 미국 값을
 * **한 화면에 세로로 쌓아** 위에서 아래로 훑게 한다 —
 *
 *   지수 넉 장 → 국채금리 → 코스피 야간선물 → 내 관심종목
 *
 * ## 새로 받는 게 없다
 *
 * 지수·금리·야간선물은 시황이 이미 받는 `usMajor`·`rates` 섹션 그대로다.
 * 관심종목은 「관심종목(해외)」가 쓰는 그 저장소를 그대로 쓴다 — 여기서 넣고 빼면
 * 그 화면에서도 같이 바뀐다. **같은 목록을 두 곳에서 따로 관리하게 만들지 않는다.**
 */

/** 위에 큰 상자로 세울 지수 — 국내 지수 카드와 같은 모양 */
/*
 * VIX 를 지수와 같은 줄에 둔다.
 *
 * 지수 넷만 보면 「올랐다/내렸다」는 알아도 **그게 편안한 상승인지 불안한 상승인지**를
 * 모른다. VIX 는 그 한 칸을 채운다. 값이 오르는 게 나쁜 쪽이라 색은 거꾸로 읽어야 하는데,
 * 그건 서버가 붙여 주는 판정 줄(why)이 말해 준다.
 */
const BOX_KEYS = ["gspc", "ndx", "rut", "sox", "vix"] as const;
/** 원자재 — 국채금리 아래 따로. 지수와 단위가 달라 같은 줄에 섞으면 못 읽는다 */
const COMMODITY_KEYS = ["wti", "brent", "gold"] as const;

function pct(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "-";
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function cls(v: number | null): string {
  if (v === null || !Number.isFinite(v) || v === 0) return "";
  return v > 0 ? "positive" : "negative";
}

export function UsBoardPanel() {
  const usMajor = useSection<UsMajorResult>("usMajor", 15_000);
  const rates = useSection<RateRow[]>("rates", 30_000);

  const rows = usMajor.data?.rows ?? [];
  const boxes = BOX_KEYS.map((k) => rows.find((r) => r.key === k)).filter(
    (r): r is NonNullable<typeof r> => Boolean(r),
  );
  const night = usMajor.data?.nightFutures ?? null;
  const commodities = COMMODITY_KEYS.map((k) => rows.find((r) => r.key === k)).filter(
    (r): r is NonNullable<typeof r> => Boolean(r),
  );
  /* 눌러서 차트 — 숫자 한 줄만으로는 「어디쯤인가」를 모른다 */
  const [chart, setChart] = useState<ChartTarget | null>(null);
  const usRates = (rates.data ?? []).filter((r) => r.group === "해외");

  return (
    <div className="usb">
      {/*
        신호등이 맨 위다. 열 줄을 훑어서 「오늘 미국이 괜찮은가」를 세는 건 사람이 할 일이 아니다.
        판정은 서버가 한다 — 화면에서 굴리면 리포트가 같은 판정을 다시 짜야 한다.
      */}
      {usMajor.data?.boardSignal && <BoardLight sig={usMajor.data.boardSignal} />}

      {/* ---------------- 지수 ---------------- */}
      <section className="ov-card">
        <div className="ov-card-h">
          <span className="ov-card-t">미국 지수</span>
          <span className="ov-card-sub">
            {usMajor.data?.fetchedAt
              ? new Date(usMajor.data.fetchedAt).toLocaleTimeString("ko-KR", { hour12: false })
              : ""}
          </span>
        </div>
        <div className="ov-card-b">
          {boxes.length === 0 ? (
            <div className="empty">불러오는 중…</div>
          ) : (
            <div className="usb-boxes">
              {boxes.map((b) => (
                <button
                  type="button"
                  className={`usb-box clickable${b.signal ? ` sig-${b.signal.level}` : ""}`}
                  key={b.key}
                  onClick={() =>
                    setChart({ symbol: b.symbol, label: b.label, digits: b.digits })
                  }
                  title="눌러서 차트 보기"
                >
                  <div className="usb-box-nm">{b.label}</div>
                  <div className={`usb-box-px ${cls(b.changeRate)}`}>
                    {b.price === null ? "-" : fmtNum(Number(b.price.toFixed(b.digits)))}
                  </div>
                  <div className={`usb-box-chg ${cls(b.changeRate)}`}>
                    {b.change === null
                      ? ""
                      : `${b.change > 0 ? "▲" : b.change < 0 ? "▼" : ""}${Math.abs(b.change).toFixed(b.digits)}`}{" "}
                    {pct(b.changeRate)}
                  </div>
                  {/* 왜 눈에 띄는지 한 줄. 색만 있으면 이유를 모른다 */}
                  {b.signal && <div className="usb-box-why">{b.signal.why}</div>}
                </button>
              ))}
            </div>
          )}
          {usMajor.data?.curveNote && (
            <div className="usb-curve">{usMajor.data.curveNote}</div>
          )}
        </div>
      </section>

      {/* ---------------- 국채금리 ---------------- */}
      <section className="ov-card">
        <div className="ov-card-h">
          <span className="ov-card-t">미국 국채금리</span>
          {/* 갱신 시각을 적어 둔다 — 안 적으면 「이거 살아 있나」를 매번 의심하게 된다 */}
          <span className="ov-card-sub">
            {rates.updatedAt
              ? new Date(rates.updatedAt).toLocaleTimeString("ko-KR", { hour12: false })
              : ""}
          </span>
        </div>
        <div className="ov-card-b">
          {usRates.length === 0 ? (
            <div className="empty">불러오는 중…</div>
          ) : (
            <div className="usb-rates">
              {usRates.map((r) => (
                <div className="usb-rate" key={r.code}>
                  <span className="usb-rate-nm">{r.name}</span>
                  <b className="usb-rate-v">{r.rate === null ? "-" : `${r.rate.toFixed(3)}%`}</b>
                  {/* 금리는 등락률이 아니라 %p 로 읽어야 한다 */}
                  <span className={`usb-rate-d ${cls(r.change)}`}>
                    {r.change === null
                      ? ""
                      : `${r.change > 0 ? "+" : ""}${r.change.toFixed(3)}%p`}
                  </span>
                </div>
              ))}
            </div>
          )}
          <div className="table-note">
            금리는 <b>%p(변화폭)</b> 로 읽습니다 — 4.71%가 4.72%로 가는 건 등락률로는 0.2%지만
            시장이 반응하는 건 0.01%p 라는 폭 자체입니다.
          </div>
        </div>
      </section>

      {/* ---------------- 원자재 ---------------- */}
      <section className="ov-card">
        <div className="ov-card-h">
          <span className="ov-card-t">원자재</span>
          <span className="ov-card-sub">
            {usMajor.data?.fetchedAt
              ? new Date(usMajor.data.fetchedAt).toLocaleTimeString("ko-KR", { hour12: false })
              : ""}
          </span>
        </div>
        <div className="ov-card-b">
          {commodities.length === 0 ? (
            <div className="empty">불러오는 중…</div>
          ) : (
            <div className="usb-boxes">
              {commodities.map((b) => (
                <button
                  type="button"
                  className={`usb-box clickable${b.signal ? ` sig-${b.signal.level}` : ""}`}
                  key={b.key}
                  onClick={() =>
                    setChart({ symbol: b.symbol, label: b.label, digits: b.digits })
                  }
                  title="눌러서 차트 보기"
                >
                  <div className="usb-box-nm">{b.label}</div>
                  <div className={`usb-box-px ${cls(b.changeRate)}`}>
                    {b.price === null ? "-" : fmtNum(Number(b.price.toFixed(b.digits)))}
                  </div>
                  <div className={`usb-box-chg ${cls(b.changeRate)}`}>
                    {b.change === null
                      ? ""
                      : `${b.change > 0 ? "▲" : b.change < 0 ? "▼" : ""}${Math.abs(b.change).toFixed(b.digits)}`}{" "}
                    {pct(b.changeRate)}
                  </div>
                  {b.signal && <div className="usb-box-why">{b.signal.why}</div>}
                </button>
              ))}
            </div>
          )}
          <div className="table-note">
            유가는 <b>정유·화학·항공</b>에 바로 닿습니다. 금은 금리·달러의 반대편이라 같이 보면
            지금 시장이 <b>위험을 사는지 피하는지</b>가 읽힙니다. WTI·브렌트는 선물(근월물)입니다.
          </div>
        </div>
      </section>

      {/* ---------------- 야간선물 ---------------- */}
      <section className="ov-card">
        <div className="ov-card-h">
          <span className="ov-card-t">코스피 야간선물</span>
          <span className="ov-card-sub">
            {usMajor.data?.fetchedAt
              ? new Date(usMajor.data.fetchedAt).toLocaleTimeString("ko-KR", { hour12: false })
              : ""}
          </span>
        </div>
        <div className="ov-card-b">
          {!night ? (
            <div className="empty">야간선물 값이 아직 없습니다.</div>
          ) : (
            <button
              type="button"
              className="usb-night clickable"
              onClick={() =>
                setChart({
                  kind: "futures",
                  symbol: night.symbol,
                  label: "코스피 야간선물",
                  digits: night.digits,
                })
              }
              title="눌러서 차트 보기"
            >
              <div className={`usb-night-px ${cls(night.changeRate)}`}>
                {night.price === null ? "-" : fmtNum(Number(night.price.toFixed(night.digits)))}
              </div>
              <div className={`usb-night-chg ${cls(night.changeRate)}`}>
                {night.change === null
                  ? ""
                  : `${night.change > 0 ? "▲" : "▼"}${Math.abs(night.change).toFixed(night.digits)}`}{" "}
                {pct(night.changeRate)}
              </div>
            </button>
          )}
          <div className="table-note">
            미국장이 열려 있는 동안 움직이는 값이라 <b>내일 개장가의 예고편</b>입니다.
            눌러서 흐름을 볼 수 있습니다 — 월물은 3개월마다 바뀌므로 그 이전 구간은 없습니다.
          </div>
        </div>
      </section>

      {/* ---------------- 관심종목 ---------------- */}
      <UsBoardWatch onOpen={(symbol, label) => setChart({ kind: "usStock", symbol, label })} />

      {chart && <YahooChartSheet target={chart} onClose={() => setChart(null)} />}
    </div>
  );
}

/**
 * 전광판 관심종목.
 *
 * 「관심종목(해외)」와 **같은 저장소**를 쓴다. 여기서 넣고 빼면 거기서도 바뀐다 —
 * 같은 목록을 두 곳에서 따로 관리하게 만들면 반드시 어긋난다.
 * 보여줄 그룹은 골라서 기억한다(기기별).
 */
const GROUP_KEY = "vntg.usboard.group";

function UsBoardWatch({ onOpen }: { onOpen: (symbol: string, label: string) => void }) {
  const [groups, setGroups] = useState<UsWatchGroup[]>([]);
  const [openId, setOpenId] = useState<string>(() => localStorage.getItem(GROUP_KEY) ?? "");
  const [editing, setEditing] = useState(false);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<UsSearchResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 마지막으로 값을 받은 시각 — 안 적어 두면 살아 있는지 의심하게 된다 */
  const [at, setAt] = useState<number | null>(null);

  const load = useCallback(async (quiet = false) => {
    try {
      const r = await api.usWatch();
      setGroups(r.groups);
      setAt(Date.now());
      setError(null);
    } catch (e) {
      if (!quiet) setError(e instanceof Error ? e.message : "불러오지 못했습니다");
    }
  }, []);

  useEffect(() => {
    void load();
    // 미국장이 도는 동안 값이 움직인다. 20초면 전광판으로 충분하다
    const t = setInterval(() => void load(true), 20_000);
    return () => clearInterval(t);
  }, [load]);

  // 종목 검색
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setFound([]);
      return;
    }
    const t = setTimeout(() => {
      api
        .usWatchSearch(q)
        .then((r) => setFound(r.results))
        .catch(() => setFound([]));
    }, 300);
    return () => clearTimeout(t);
  }, [query]);

  const current = groups.find((g) => g.id === openId) ?? groups[0] ?? null;

  function pickGroup(id: string) {
    setOpenId(id);
    localStorage.setItem(GROUP_KEY, id);
  }

  async function run(fn: () => Promise<{ groups: UsWatchGroup[] }>) {
    setBusy(true);
    setError(null);
    try {
      setGroups((await fn()).groups);
    } catch (e) {
      setError(e instanceof Error ? e.message : "실패");
    } finally {
      setBusy(false);
    }
  }

  /** 한 칸 위·아래로. 화면을 먼저 바꾸고 서버에 보낸다 */
  async function move(symbol: string, delta: -1 | 1) {
    if (!current) return;
    const order = current.stocks.map((s) => s.symbol);
    const at = order.indexOf(symbol);
    const to = at + delta;
    if (at < 0 || to < 0 || to >= order.length) return;
    [order[at], order[to]] = [order[to], order[at]];
    setGroups((prev) =>
      prev.map((g) =>
        g.id === current.id
          ? { ...g, stocks: order.map((sym) => g.stocks.find((s) => s.symbol === sym)!) }
          : g,
      ),
    );
    await run(() => api.usWatchStockOrder(current.id, order));
  }

  return (
    <section className="ov-card">
      <div className="ov-card-h">
        <span className="ov-card-t">관심종목</span>
        <span className="ov-card-sub">
          {current ? `${current.stocks.length}종목` : ""}
          {at && ` · ${new Date(at).toLocaleTimeString("ko-KR", { hour12: false })}`}
        </span>
      </div>
      <div className="ov-card-b">
        {error && <div className="error-banner">{error}</div>}

        <div className="filter-row">
          {groups.map((g) => (
            <button
              key={g.id}
              className={`filter-btn ${current?.id === g.id ? "active" : ""}`}
              onClick={() => pickGroup(g.id)}
            >
              {g.name}
              <span className={`uw-grate ${cls(g.changeRate)}`}> {pct(g.changeRate)}</span>
            </button>
          ))}
          <button
            className={`filter-btn ${editing ? "active" : ""}`}
            onClick={() => setEditing((v) => !v)}
          >
            {editing ? "편집 끝" : "✏ 편집"}
          </button>
        </div>

        {editing && current && (
          <div className="search-box usb-add">
            <input
              className="search-input"
              placeholder={`「${current.name}」에 넣을 종목 — 티커나 이름으로`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query.trim() && found.length > 0 && (
              <div className="search-dropdown">
                {found.map((f) => (
                  <button
                    key={f.symbol}
                    className="search-result-row"
                    disabled={busy}
                    onClick={() => {
                      setQuery("");
                      setFound([]);
                      void run(() => api.usWatchStockAdd(current.id, f.symbol, f.name));
                    }}
                  >
                    <span className="name">{f.symbol}</span>
                    <span className="sub">
                      {f.name}
                      {f.exchange ? ` · ${f.exchange}` : ""}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {!current ? (
          <div className="page-note">
            그룹이 없습니다. <b>관심종목(해외)</b> 메뉴에서 먼저 만들어 주세요.
          </div>
        ) : current.stocks.length === 0 ? (
          <div className="page-note">
            담긴 종목이 없습니다. <b>✏ 편집</b>을 켜고 검색해서 넣으세요.
          </div>
        ) : (
          <div className="usb-list">
            {current.stocks.map((s, i) => (
              <UsBoardRow
                key={s.symbol}
                row={s}
                editing={editing}
                first={i === 0}
                last={i === current.stocks.length - 1}
                onMove={(d) => void move(s.symbol, d)}
                onRemove={() => void run(() => api.usWatchStockRemove(current.id, s.symbol))}
                onOpen={() => onOpen(s.symbol, s.name || s.symbol)}
              />
            ))}
          </div>
        )}

        <div className="table-note">
          <b>관심종목(해외)</b> 와 같은 목록입니다 — 여기서 넣고 빼면 거기서도 바뀝니다.
          종목을 누르면 <b>상세</b>가 열립니다.
          괄호는 <b>미국 주간거래</b>(한국 낮에 열리는 세션)이며, <b>정규장이 열리면 사라집니다</b> —
          그때부터 지금 값은 정규장 하나뿐입니다.
        </div>
      </div>
    </section>
  );
}

function UsBoardRow({
  row,
  editing,
  first,
  last,
  onMove,
  onRemove,
  onOpen,
}: {
  row: UsQuoteRow;
  editing: boolean;
  first: boolean;
  last: boolean;
  onMove: (d: -1 | 1) => void;
  onRemove: () => void;
  onOpen: () => void;
}) {
  return (
    <div className="usb-row">
      {editing && (
        <span className="usb-move">
          <button className="gt-move" onClick={() => onMove(-1)} disabled={first} title="위로">
            ▲
          </button>
          <button className="gt-move" onClick={() => onMove(1)} disabled={last} title="아래로">
            ▼
          </button>
        </span>
      )}
      {/* 종목을 누르면 상세가 열린다 — 예전엔 표에서 끊겼다 */}
      <button type="button" className="usb-sym usb-open" onClick={onOpen} title="눌러서 상세 보기">
        {row.flag} {row.symbol}
        <span className="usb-nm">{row.name}</span>
      </button>
      <span className="usb-px">
        {row.price === null ? "-" : row.price.toFixed(2)}
        {/* 정규장이 열리면 주간거래 괄호는 지운다 — 가격이 두 개면 어느 쪽이 지금 값인지 헷갈린다 */}
        {showDayQuote(row) && (
          <span className="uw-day"> ({row.dayPrice!.toFixed(2)})</span>
        )}
      </span>
      <span className={`usb-rt ${cls(row.changeRate)}`}>
        {pct(row.changeRate)}
        {showDayQuote(row) && (
          <span className={`uw-day ${cls(row.dayChangeRate)}`}> ({pct(row.dayChangeRate)})</span>
        )}
      </span>
      {editing && (
        <button className="row-del-btn" onClick={onRemove} title="빼기">
          ✕
        </button>
      )}
    </div>
  );
}

/**
 * 전광판 맨 위 신호등.
 *
 * 색 하나로 끝내지 않고 **왜 그런지**를 같이 낸다. 「빨강」만 있으면 무엇을 봐야 할지 모른다.
 */
function BoardLight({ sig }: { sig: UsBoardSignal }) {
  const label = sig.level === "red" ? "주의" : sig.level === "yellow" ? "보통" : "무난";
  return (
    <section className={`ov-card usb-light ${sig.level}`}>
      <div className="ov-card-b usb-light-b">
        <span className={`sig-dot big ${sig.level}`} />
        <span className="usb-light-lv">{label}</span>
        <span className="usb-light-sum">{sig.summary}</span>
        {sig.reasons.length > 0 && (
          <details className="usb-light-why">
            <summary>이유 {sig.reasons.length}</summary>
            <ul>
              {sig.reasons.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </section>
  );
}
