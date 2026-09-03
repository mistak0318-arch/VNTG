import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  fmtNum,
  normalizeStockCode,
  signClass,
  type CancelTicket,
  type OrderAccount,
  type OrderLogRow,
  type OrderRow,
  type OrderStatus,
  type OrderTicket,
  type OrderVenue,
  type StockSearchResult,
  type TradeType,
} from "../api";
import { OrderBookPanel } from "../components/OrderBookPanel";

/**
 * 주문 (2026-09-03) — 벤티지: "주문 메뉴 들어갈 때는 아이디랑 비밀번호를 한 번 더,
 * 그 세션을 유지하는 동안. 주문 걸 때도 비밀번호 한 번 더. 대신 자동주문은 아니어야겠지."
 *
 * ## 이 화면의 규칙 — 다른 화면과 다르다
 *
 * 1. **남이 쓴 글자를 안 그린다.** 뉴스·텔레그램·공시는 이 화면에 없다. 주문 버튼과
 *    같은 문서 안에 남의 콘텐츠가 있으면 그게 곧 XSS 로 주문을 누르는 길이다.
 * 2. **문이 셋이다.** 앱 로그인(이미 지남) → 주문 메뉴 열기(아이디·비밀번호 재입력,
 *    세션 10분) → 주문 실행마다 주문 비밀번호. 셋은 서로 다른 비밀번호다.
 * 3. **한 번에 안 나간다.** 주문서(prepare, 30초)를 받아 **금액을 눈으로 확인**한 뒤에야
 *    실행(execute)이 있다. 더블클릭은 두 번째가 만료로 죽는다.
 * 4. **자동은 없다.** 이 화면에서 사람이 누르는 것 말고 주문이 나가는 길은 서버에 없다.
 *
 * 시간이 남았는지·모의인지 실전인지는 **머리띠에 상시** 붙는다. 헷갈리는 순간이 사고다.
 */

const VENUES: { key: OrderVenue; label: string; hint: string }[] = [
  { key: "KRX", label: "KRX", hint: "정규장 08:30~15:30" },
  { key: "NXT", label: "NXT", hint: "프리 08:00 · 메인 09:00~15:20 · 애프터 ~20:00" },
  { key: "SOR", label: "통합(SOR)", hint: "키움이 더 좋은 쪽으로 보낸다" },
];

type Sub = "order" | "open" | "fills" | "balance" | "log";

const SUBS: { key: Sub; label: string }[] = [
  { key: "order", label: "매수·매도" },
  { key: "open", label: "미체결" },
  { key: "fills", label: "체결" },
  { key: "balance", label: "잔고" },
  { key: "log", label: "기록" },
];

function won(n: number | null | undefined): string {
  return n === null || n === undefined ? "-" : `${Math.round(n).toLocaleString()}원`;
}

/** 서버가 「없는 길」이라고 답하면 세션이 끊긴 것이다 — 그때만 로그인 칸으로 되돌린다 */
function isGone(e: unknown): boolean {
  return e instanceof Error && /not found/i.test(e.message);
}

export function OrderPage({ onSelectStock }: { onSelectStock?: (code: string, name: string) => void }) {
  const [status, setStatus] = useState<OrderStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sub, setSub] = useState<Sub>("order");
  const [left, setLeft] = useState(0);

  const load = useCallback(async () => {
    try {
      const s = await api.orderStatus();
      setStatus(s);
      setLeft(s.sessionLeftSec);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "상태를 못 읽었다");
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load]);

  /* 남은 시간은 눈앞에서 줄어야 한다 — 서버 값에서 시작해 1초씩 */
  const ticking = left > 0;
  useEffect(() => {
    if (!ticking) return;
    const t = setInterval(() => setLeft((v) => Math.max(0, v - 1)), 1000);
    return () => clearInterval(t);
  }, [ticking]);

  /* 0 이 되면 서버에 물어 실제로 닫혔는지 확인한다 — 화면만 닫으면 거짓말이 된다 */
  useEffect(() => {
    if (status?.session && left === 0) void load();
  }, [left, status?.session, load]);

  if (err && !status)
    return (
      <div className="page">
        <p className="empty">{err}</p>
      </div>
    );
  if (!status)
    return (
      <div className="page">
        <p className="empty">불러오는 중…</p>
      </div>
    );

  /* 킬 스위치·앱키 — 여기서 막히면 화면이 아니라 서버 .env 를 고쳐야 한다 */
  if (!status.enabled || !status.configured) {
    return (
      <div className="page ord">
        <h2 className="page-title">주문</h2>
        <div className="ord-off">
          <div className="ord-off-mark">🔒</div>
          <b>주문 기능이 꺼져 있다</b>
          <p>{status.reason}</p>
          <pre className="ord-env">{`# server/.env
ORDERS_ENABLED=1
KIWOOM_ORDER_APP_KEY=...       # 조회용 키와 별도 (소액 전용 계좌)
KIWOOM_ORDER_APP_SECRET=...
KIWOOM_ORDER_IS_MOCK=true      # 실전은 false 를 손으로 적어야 한다
TELEGRAM_CHAT_ID_ORDER=...     # 주문·체결이 갈 방`}</pre>
          <p className="ord-note">
            고친 뒤 서버를 다시 켜야 한다. 모의투자 앱키는 키움 REST 개발자 포털에서 따로 신청한다.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="page ord">
      <Band status={status} left={left} onChange={load} />
      {!status.session ? (
        <SessionGate onDone={load} />
      ) : !status.hasPassword ? (
        <PasswordSetup onDone={load} />
      ) : status.uiLocked ? (
        <LockedCard onDone={load} />
      ) : (
        <>
          <div className="ord-subs">
            {SUBS.map((s) => (
              <button
                key={s.key}
                type="button"
                className={`ord-sub${sub === s.key ? " on" : ""}`}
                onClick={() => setSub(s.key)}
              >
                {s.label}
              </button>
            ))}
          </div>
          {sub === "order" && <OrderForm status={status} onDone={load} />}
          {sub === "open" && <OpenTab onDone={load} />}
          {sub === "fills" && <FillsTab />}
          {sub === "balance" && <BalanceTab onSelectStock={onSelectStock} />}
          {sub === "log" && <LogTab />}
        </>
      )}
    </div>
  );
}

/* ── 머리띠 ─────────────────────────────────────────────────────────────── */

function Band({ status, left, onChange }: { status: OrderStatus; left: number; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const mm = String(Math.floor(left / 60)).padStart(2, "0");
  const ss = String(left % 60).padStart(2, "0");

  async function lock() {
    setBusy(true);
    try {
      await api.orderLock(true);
    } catch {
      /* 잠그기가 실패해도 알릴 것이 없다 — 다시 누르면 된다 */
    } finally {
      setBusy(false);
      onChange();
    }
  }

  async function close() {
    setBusy(true);
    try {
      await api.orderCloseSession();
    } catch {
      /* 이미 닫혔어도 결과는 같다 */
    } finally {
      setBusy(false);
      onChange();
    }
  }

  return (
    <div className={`ord-band ${status.mock ? "mock" : "real"}`}>
      <span className="ord-band-tag">{status.mock ? "모의투자" : "실전 계좌"}</span>
      <span className="ord-band-mid">
        오늘 {status.today.count}/{status.guard.maxDailyCount}건 · {won(status.today.krw)} /{" "}
        {won(status.guard.maxDailyKrw)}
        {status.watching > 0 ? ` · 체결 감시 ${status.watching}` : ""}
      </span>
      {status.session && (
        <>
          <span className="ord-band-timer" title="가만히 두면 10분에 닫힌다">
            ⏳ {mm}:{ss}
          </span>
          <button type="button" className="ord-band-btn" disabled={busy} onClick={() => void lock()}>
            잠금
          </button>
          <button type="button" className="ord-band-btn" disabled={busy} onClick={() => void close()}>
            닫기
          </button>
        </>
      )}
    </div>
  );
}

/* ── 문 ① 주문 메뉴 열기 ────────────────────────────────────────────────── */

function SessionGate({ onDone }: { onDone: () => void }) {
  const [id, setId] = useState("");
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.orderOpenSession(id, pw);
      setPw("");
      onDone();
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : "열지 못했다");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="ord-gate" onSubmit={(e) => void submit(e)}>
      <div className="ord-gate-mark">🔐</div>
      <b>주문 메뉴는 한 번 더 확인한다</b>
      <p>앱 로그인과 같은 아이디·비밀번호다. 열어 두면 10분, 계속 써도 60분 뒤엔 닫힌다.</p>
      <input
        className="ord-in"
        autoComplete="username"
        placeholder="아이디"
        value={id}
        onChange={(e) => setId(e.target.value)}
      />
      <input
        className="ord-in"
        type="password"
        autoComplete="current-password"
        placeholder="비밀번호"
        value={pw}
        onChange={(e) => setPw(e.target.value)}
      />
      {error && <p className="ord-err">{error}</p>}
      <button type="submit" className="ord-go" disabled={busy || !id || !pw}>
        {busy ? "확인 중…" : "주문 메뉴 열기"}
      </button>
    </form>
  );
}

/* ── 문 ② 주문 비밀번호 ─────────────────────────────────────────────────── */

function PasswordSetup({ onDone }: { onDone: () => void }) {
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (a !== b) {
      setError("두 칸이 다르다");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.orderSetPassword(a, null);
      setA("");
      setB("");
      onDone();
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : "정하지 못했다");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="ord-gate" onSubmit={(e) => void submit(e)}>
      <div className="ord-gate-mark">🔑</div>
      <b>주문 비밀번호를 정한다</b>
      <p>
        앱 비밀번호와 <b>다른 것</b>으로. 주문을 실행할 때마다 이걸 묻는다. 서버는 해시만 남기므로 잊으면
        <code> server/data/orderAuth.json </code>을 지우고 다시 정해야 한다.
      </p>
      <input
        className="ord-in"
        type="password"
        autoComplete="new-password"
        placeholder="주문 비밀번호 (6자 이상)"
        value={a}
        onChange={(e) => setA(e.target.value)}
      />
      <input
        className="ord-in"
        type="password"
        autoComplete="new-password"
        placeholder="한 번 더"
        value={b}
        onChange={(e) => setB(e.target.value)}
      />
      {error && <p className="ord-err">{error}</p>}
      <button type="submit" className="ord-go" disabled={busy || a.length < 6}>
        {busy ? "저장 중…" : "정하기"}
      </button>
    </form>
  );
}

function LockedCard({ onDone }: { onDone: () => void }) {
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function unlock(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.orderLock(false, pw);
      setPw("");
      onDone();
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : "풀지 못했다");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="ord-gate" onSubmit={(e) => void unlock(e)}>
      <div className="ord-gate-mark">🛑</div>
      <b>주문이 잠겨 있다</b>
      <p>잠금이 걸린 동안에는 어떤 주문도 나가지 않는다. 풀려면 주문 비밀번호가 필요하다.</p>
      <input
        className="ord-in"
        type="password"
        placeholder="주문 비밀번호"
        value={pw}
        onChange={(e) => setPw(e.target.value)}
      />
      {error && <p className="ord-err">{error}</p>}
      <button type="submit" className="ord-go" disabled={busy || !pw}>
        잠금 풀기
      </button>
    </form>
  );
}

/* ── 종목 고르기 ────────────────────────────────────────────────────────── */

function StockPick({ code, name, onPick }: { code: string; name: string; onPick: (c: string, n: string) => void }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<StockSearchResult[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const term = q.trim();
    if (term.length < 1) {
      setRows([]);
      return;
    }
    timer.current = setTimeout(() => {
      void api
        .searchStocks(term)
        .then((r) => setRows((r.results ?? []).slice(0, 8)))
        .catch(() => setRows([]));
    }, 250);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [q]);

  return (
    <div className="ord-pick">
      <input
        className="ord-in"
        placeholder="종목명 또는 6자리 코드"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {code && (
        <div className="ord-picked">
          <b>{name || code}</b>
          <span className="ord-code">{code}</span>
        </div>
      )}
      {rows.length > 0 && (
        <div className="ord-pick-list">
          {rows.map((r) => (
            <button
              key={r.code}
              type="button"
              onClick={() => {
                onPick(normalizeStockCode(r.code), r.name);
                setQ("");
                setRows([]);
              }}
            >
              <b>{r.name}</b>
              <span>{r.code}</span>
              <small>{r.marketName}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── 매수·매도 ──────────────────────────────────────────────────────────── */

function OrderForm({ status, onDone }: { status: OrderStatus; onDone: () => void }) {
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [venue, setVenue] = useState<OrderVenue>("KRX");
  /*
   * 매매구분 (2026-09-04). 예전엔 「시장가」 스위치 하나였는데 실제로는 18가지다 —
   * 목록은 **서버가 준다**(status.tradeTypes). 화면이 표를 들고 있으면 언젠가 서버와 갈린다.
   */
  const [tradeType, setTradeType] = useState("0");
  const [qty, setQty] = useState("");
  const [price, setPrice] = useState("");
  const [cond, setCond] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ticket, setTicket] = useState<{ nonce: string; expiresAt: number; ticket: OrderTicket } | null>(null);

  const types: TradeType[] = status.tradeTypes ?? [];
  const tt = types.find((t) => t.code === tradeType) ?? null;
  /* 「값을 안 쓰는 구분」이면 가격 칸을 잠근다 — 넣어 봐야 서버가 거절한다 */
  const usesPrice = tt ? tt.price !== "no" : true;
  const needsPrice = tt?.price === "req";
  const usesCond = tt?.cond === true;
  /* 시간외 구분은 정규장 밖에 내는 것이 정상이라 「시간 아님」 경고를 띄우지 않는다 */
  const open = tt?.late ? true : status.open[venue];
  const ready = Boolean(code) && Boolean(qty) && (!needsPrice || Boolean(price)) && (!usesCond || Boolean(cond));

  async function prepare(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.orderPrepare({
        side,
        code,
        name,
        qty: Number(qty),
        price: usesPrice && price ? Number(price) : null,
        condPrice: tt?.cond && cond ? Number(cond) : null,
        tradeType,
        venue,
      });
      setTicket(r);
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : "주문서를 못 만들었다");
      if (isGone(e2)) onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ord-grid">
      <div className="ord-book">
        {code ? <OrderBookPanel code={code} /> : <p className="empty">종목을 고르면 호가가 뜬다</p>}
      </div>

      <form className={`ord-form ${side}`} onSubmit={(e) => void prepare(e)}>
        <div className="ord-side">
          <button type="button" className={side === "buy" ? "on buy" : ""} onClick={() => setSide("buy")}>
            매수
          </button>
          <button type="button" className={side === "sell" ? "on sell" : ""} onClick={() => setSide("sell")}>
            매도
          </button>
        </div>

        <StockPick
          code={code}
          name={name}
          onPick={(c, n) => {
            setCode(c);
            setName(n);
          }}
        />

        <label className="ord-lab">거래소</label>
        <div className="ord-venue">
          {VENUES.map((v) => (
            <button
              key={v.key}
              type="button"
              title={v.hint}
              className={`${venue === v.key ? "on" : ""}${status.open[v.key] ? "" : " shut"}`}
              onClick={() => setVenue(v.key)}
            >
              {v.label}
              <i>{status.open[v.key] ? "열림" : "닫힘"}</i>
            </button>
          ))}
        </div>

        <label className="ord-lab">수량</label>
        <input
          className="ord-in"
          inputMode="numeric"
          value={qty}
          onChange={(e) => setQty(e.target.value.replace(/\D/g, ""))}
          placeholder="주"
        />

        <label className="ord-lab">매매구분</label>
        <select className="ord-in" value={tradeType} onChange={(e) => setTradeType(e.target.value)}>
          {types.map((t) => (
            <option key={t.code} value={t.code}>
              {t.label}
            </option>
          ))}
        </select>
        {tt && <div className="ord-caps">{tt.hint}</div>}

        {usesCond && (
          <>
            <label className="ord-lab">발동가 (조건단가)</label>
            <input
              className="ord-in"
              inputMode="numeric"
              value={cond}
              onChange={(e) => setCond(e.target.value.replace(/\D/g, ""))}
              placeholder="이 값에 닿으면 주문이 나간다"
            />
          </>
        )}

        <label className="ord-lab">{usesCond ? "주문단가 (발동 뒤 낼 값)" : "가격"}</label>
        <input
          className="ord-in"
          inputMode="numeric"
          disabled={!usesPrice}
          value={usesPrice ? price : ""}
          onChange={(e) => setPrice(e.target.value.replace(/\D/g, ""))}
          placeholder={usesPrice ? (needsPrice ? "원" : "원 (안 적어도 된다)") : `${tt?.label ?? ""} — 값을 안 적는다`}
        />

        <div className="ord-sum">
          <span>예상 금액</span>
          <b>{!price || !qty ? "-" : won(Number(price) * Number(qty))}</b>
        </div>
        <div className="ord-caps">
          한 건 {won(status.guard.maxOrderKrw)} · 지정가 현재가 ±{status.guard.priceCollarPct}%
          {usesCond ? ` · 발동가 현재가 ±${status.guard.stopCollarPct}%` : ""} · 남은 건수{" "}
          {Math.max(0, status.guard.maxDailyCount - status.today.count)}
        </div>

        {!open && status.guard.marketHoursOnly && <p className="ord-err">{venue} 가 주문을 받는 시간이 아니다</p>}
        {error && <p className="ord-err">{error}</p>}

        <button type="submit" className={`ord-go ${side}`} disabled={busy || !ready}>
          {busy ? "확인 중…" : side === "buy" ? "매수 주문서 만들기" : "매도 주문서 만들기"}
        </button>
        <p className="ord-note">주문서를 눈으로 확인하고 비밀번호를 넣어야 실제로 나간다.</p>
      </form>

      {ticket && (
        <Confirm
          nonce={ticket.nonce}
          expiresAt={ticket.expiresAt}
          ticket={ticket.ticket}
          onClose={() => setTicket(null)}
          onDone={() => {
            setTicket(null);
            setQty("");
            onDone();
          }}
        />
      )}
    </div>
  );
}

/* ── 두 번째 단계 — 주문서 확인 + 비밀번호 ──────────────────────────────── */

function Confirm({
  nonce,
  expiresAt,
  ticket,
  onClose,
  onDone,
}: {
  nonce: string;
  expiresAt: number;
  ticket: OrderTicket | CancelTicket;
  onClose: () => void;
  onDone: () => void;
}) {
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sec, setSec] = useState(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)));
  const pwRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    pwRef.current?.focus();
    const t = setInterval(() => setSec(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000))), 250);
    return () => clearInterval(t);
  }, [expiresAt]);

  const dead = sec <= 0;
  const isCancel = ticket.kind === "cancel";
  const sideKo = isCancel ? "취소" : ticket.side === "buy" ? "매수" : "매도";
  const [okMsg, setOkMsg] = useState<string | null>(null);

  async function go(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.orderExecute(nonce, pw);
      setPw("");
      setOkMsg(`${sideKo} 접수 — 주문번호 ${r.ordNo || "?"} ${r.msg}`);
      setTimeout(onDone, 1200);
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : "실패");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ord-modal-back" onClick={onClose}>
      <form
        className={`ord-modal ${isCancel ? "cancel" : ticket.side}`}
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => void go(e)}
      >
        <h3>
          {sideKo} 확인 <span className={`ord-tick${dead ? " dead" : ""}`}>{dead ? "만료" : `${sec}초`}</span>
        </h3>
        <div className="ord-modal-name">
          {ticket.name || ticket.code} <span className="ord-code">{ticket.code}</span>
        </div>
        <dl className="ord-modal-kv">
          <div>
            <dt>수량</dt>
            <dd>{ticket.qty.toLocaleString()}주</dd>
          </div>
          {ticket.kind === "order" && (
            <>
              <div>
                <dt>구분</dt>
                <dd>{ticket.tradeLabel}</dd>
              </div>
              <div>
                <dt>가격</dt>
                <dd>{ticket.price === null ? ticket.tradeLabel : `${ticket.price.toLocaleString()}원`}</dd>
              </div>
              {/* 스톱은 발동가가 본론이다 — 총액보다 먼저 눈에 들어와야 한다 */}
              {ticket.condPrice !== null && (
                <div className="ord-stop-kv">
                  <dt>발동가</dt>
                  <dd>{ticket.condPrice.toLocaleString()}원</dd>
                </div>
              )}
              <div>
                <dt>현재가</dt>
                <dd>{ticket.refPrice ? `${ticket.refPrice.toLocaleString()}원` : "-"}</dd>
              </div>
            </>
          )}
          {ticket.kind === "cancel" && (
            <div>
              <dt>원주문</dt>
              <dd>{ticket.ordNo}</dd>
            </div>
          )}
          <div>
            <dt>거래소</dt>
            <dd>{ticket.venue}</dd>
          </div>
        </dl>
        {ticket.kind === "order" && (
          <div className="ord-modal-amt">
            <span>{ticket.condPrice !== null ? "발동되면 총액" : "총액"}</span>
            <b>{won(ticket.amount)}</b>
          </div>
        )}
        <input
          ref={pwRef}
          className="ord-in"
          type="password"
          autoComplete="off"
          placeholder="주문 비밀번호"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
        />
        {error && <p className="ord-err">{error}</p>}
        {okMsg && <p className="ord-ok">{okMsg}</p>}
        <div className="ord-modal-btns">
          <button type="button" className="ord-cancel" onClick={onClose}>
            그만
          </button>
          <button type="submit" className={`ord-go ${isCancel ? "" : ticket.side}`} disabled={busy || dead || !pw}>
            {busy ? "보내는 중…" : dead ? "만료됨 — 다시" : `${sideKo} 실행`}
          </button>
        </div>
      </form>
    </div>
  );
}

/* ── 미체결·체결 ────────────────────────────────────────────────────────── */

function useRows(fetcher: () => Promise<{ rows: OrderRow[] }>, ms: number) {
  const [rows, setRows] = useState<OrderRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const run = useCallback(() => {
    void fetcher()
      .then((r) => {
        setRows(r.rows ?? []);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "조회 실패"))
      .finally(() => setLoading(false));
  }, [fetcher]);

  useEffect(() => {
    run();
    const t = setInterval(run, ms);
    return () => clearInterval(t);
  }, [run, ms]);

  return { rows, error, loading, reload: run };
}

function OpenTab({ onDone }: { onDone: () => void }) {
  const { rows, error, loading, reload } = useRows(api.orderOpen, 4000);
  const [ticket, setTicket] = useState<{ nonce: string; expiresAt: number; ticket: CancelTicket } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function cancel(r: OrderRow) {
    setMsg(null);
    try {
      const t = await api.orderCancelPrepare({
        ordNo: r.ordNo,
        code: r.code,
        name: r.name,
        qty: r.remain || r.qty,
        venue: (r.venue as OrderVenue) || "KRX",
      });
      setTicket(t);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "취소 주문서를 못 만들었다");
      if (isGone(e)) onDone();
    }
  }

  return (
    <div className="ord-tab">
      {loading && <p className="empty">불러오는 중…</p>}
      {error && <p className="ord-err">{error}</p>}
      {msg && <p className="ord-err">{msg}</p>}
      {!loading && rows.length === 0 && !error && <p className="empty">미체결 주문이 없다</p>}
      {rows.length > 0 && (
        <div className="ord-scroll">
          <table className="ord-table">
            <thead>
              <tr>
                <th>시각</th>
                <th>종목</th>
                <th>구분</th>
                <th className="r">주문</th>
                <th className="r">체결</th>
                <th className="r">남은</th>
                <th className="r">가격</th>
                <th className="r">발동가</th>
                <th>상태</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.ordNo}-${r.time}`}>
                  <td>{r.time || "-"}</td>
                  <td>
                    {r.name || r.code} <span className="ord-code">{r.code}</span>
                  </td>
                  <td>{r.side || "-"}</td>
                  <td className="r">{fmtNum(r.qty)}</td>
                  <td className="r">{fmtNum(r.filled)}</td>
                  <td className="r">{fmtNum(r.remain)}</td>
                  <td className="r">{r.price ? r.price.toLocaleString() : "-"}</td>
                  <td className="r">{r.stopPrice ? r.stopPrice.toLocaleString() : "-"}</td>
                  <td>{r.status || "-"}</td>
                  <td>
                    <button type="button" className="ord-x" onClick={() => void cancel(r)}>
                      취소
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {ticket && (
        <Confirm
          nonce={ticket.nonce}
          expiresAt={ticket.expiresAt}
          ticket={ticket.ticket}
          onClose={() => setTicket(null)}
          onDone={() => {
            setTicket(null);
            reload();
            onDone();
          }}
        />
      )}
    </div>
  );
}

function FillsTab() {
  const { rows, error, loading } = useRows(api.orderFills, 6000);
  return (
    <div className="ord-tab">
      {loading && <p className="empty">불러오는 중…</p>}
      {error && <p className="ord-err">{error}</p>}
      {!loading && rows.length === 0 && !error && <p className="empty">오늘 체결이 없다</p>}
      {rows.length > 0 && (
        <div className="ord-scroll">
          <table className="ord-table">
            <thead>
              <tr>
                <th>시각</th>
                <th>종목</th>
                <th>구분</th>
                <th className="r">체결</th>
                <th className="r">체결가</th>
                <th>주문번호</th>
                <th>상태</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.ordNo}-${i}`}>
                  <td>{r.time || "-"}</td>
                  <td>
                    {r.name || r.code} <span className="ord-code">{r.code}</span>
                  </td>
                  <td>{r.side || "-"}</td>
                  <td className="r">{fmtNum(r.filled || r.qty)}</td>
                  <td className="r">{r.price ? r.price.toLocaleString() : "-"}</td>
                  <td>{r.ordNo}</td>
                  <td>{r.status || "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="ord-note">
        체결되면 이 표를 안 보고 있어도 <b>알림함(종)과 텔레그램</b>이 먼저 울린다 — 우리가 낸 주문만 감시한다.
      </p>
    </div>
  );
}

function BalanceTab({ onSelectStock }: { onSelectStock?: (code: string, name: string) => void }) {
  const [acc, setAcc] = useState<OrderAccount | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const run = () =>
      void api
        .orderAccount()
        .then((a) => {
          setAcc(a);
          setError(null);
        })
        .catch((e: unknown) => setError(e instanceof Error ? e.message : "조회 실패"));
    run();
    const t = setInterval(run, 10_000);
    return () => clearInterval(t);
  }, []);

  if (error)
    return (
      <div className="ord-tab">
        <p className="ord-err">{error}</p>
      </div>
    );
  if (!acc)
    return (
      <div className="ord-tab">
        <p className="empty">불러오는 중…</p>
      </div>
    );

  return (
    <div className="ord-tab">
      <div className="ord-dep">
        <span>주문 가능 금액</span>
        <b>{won(acc.deposit)}</b>
      </div>
      {acc.holdings.length === 0 ? (
        <p className="empty">이 계좌에 보유 종목이 없다</p>
      ) : (
        <div className="ord-scroll">
          <table className="ord-table">
            <thead>
              <tr>
                <th>종목</th>
                <th className="r">수량</th>
                <th className="r">평단</th>
                <th className="r">현재가</th>
                <th className="r">평가손익</th>
                <th className="r">수익률</th>
              </tr>
            </thead>
            <tbody>
              {acc.holdings.map((h) => (
                <tr
                  key={h.code}
                  className={onSelectStock ? "click" : ""}
                  onClick={() => onSelectStock?.(h.code, h.name)}
                >
                  <td>
                    {h.name} <span className="ord-code">{h.code}</span>
                  </td>
                  <td className="r">{fmtNum(h.qty)}</td>
                  <td className="r">{fmtNum(h.avg)}</td>
                  <td className="r">{fmtNum(h.cur)}</td>
                  <td className={`r ${signClass(h.pnl)}`}>{fmtNum(h.pnl)}</td>
                  <td className={`r ${signClass(h.pnlRate)}`}>{h.pnlRate.toFixed(2)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="ord-note">
        이 잔고는 <b>주문 전용 앱키의 계좌</b>다. 「연동 계좌 (키움)」가 보여 주는 조회용 계좌와 다를 수 있다.
      </p>
    </div>
  );
}

const KIND_KO: Record<OrderLogRow["kind"], string> = {
  session: "세션",
  order: "주문",
  cancel: "취소",
  fill: "체결",
  reject: "거절",
  error: "실패",
  lock: "잠금",
  password: "비밀번호",
  raw: "원문",
};

function LogTab() {
  const [rows, setRows] = useState<OrderLogRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .orderLog(200)
      .then((r) => setRows(r.rows ?? []))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "조회 실패"));
  }, []);

  if (error)
    return (
      <div className="ord-tab">
        <p className="ord-err">{error}</p>
      </div>
    );

  return (
    <div className="ord-tab">
      <p className="ord-note">
        주문 <b>시도</b>가 전부 남는다 — 거절과 실패까지. 이 목록에 없는 체결이 계좌에 있으면 우리가 낸 주문이 아니다.
      </p>
      {rows.length === 0 ? (
        <p className="empty">아직 기록이 없다</p>
      ) : (
        <div className="ord-scroll">
          <table className="ord-table">
            <thead>
              <tr>
                <th>시각</th>
                <th>종류</th>
                <th>종목</th>
                <th className="r">수량</th>
                <th className="r">가격</th>
                <th>내용</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.at}-${i}`} className={r.kind === "reject" || r.kind === "error" ? "bad" : ""}>
                  <td>{r.at.slice(5, 16).replace("T", " ")}</td>
                  <td>
                    {KIND_KO[r.kind] ?? r.kind}
                    {r.mock ? <i className="ord-mock">모의</i> : null}
                  </td>
                  <td>{r.name || r.code || "-"}</td>
                  <td className="r">{r.qty ? fmtNum(r.qty) : "-"}</td>
                  <td className="r">{r.price ? fmtNum(r.price) : "-"}</td>
                  <td className="ord-msg">{r.msg || "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
