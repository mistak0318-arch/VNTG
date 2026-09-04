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
  type AccessAudit,
  type OrderDevice,
  type OrderSettings,
  type OrderStatus,
  type OrderTicket,
  type OrderVenue,
  type TradeType,
} from "../api";
import { OrderBookPanel } from "../components/OrderBookPanel";
import { StockSearchBox } from "../components/StockSearchBox";
import { latestStock } from "../useRecentStocks";
import { LiveDot } from "../components/LiveDot";

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

/*
 * 거래소 — **통합이 먼저** (2026-09-04, 벤티지: "통합 · KRX · NXT 이 순으로 나와 줘야지").
 *
 * 통합(SOR)은 키움이 두 시장을 보고 더 좋은 쪽으로 보내는 것이라 **기본으로 고를 만한 것이
 * 맨 앞**에 있어야 한다. 「그때 열려 있는 곳」 설정도 이 차례로 훑으므로 통합이 먼저 잡힌다.
 */
const VENUES: { key: OrderVenue; label: string; hint: string }[] = [
  { key: "SOR", label: "통합(SOR)", hint: "키움이 KRX·NXT 중 더 좋은 쪽으로 보낸다" },
  { key: "KRX", label: "KRX", hint: "정규장 08:30~15:30" },
  { key: "NXT", label: "NXT", hint: "프리 08:00 · 메인 09:00~15:20 · 애프터 ~20:00" },
];

type Sub = "order" | "open" | "fills" | "balance" | "log" | "config";

const SUBS: { key: Sub; label: string }[] = [
  { key: "order", label: "매수·매도" },
  { key: "open", label: "미체결" },
  { key: "fills", label: "체결" },
  { key: "balance", label: "잔고" },
  { key: "log", label: "기록" },
  /* 설정 (2026-09-04) — 한도는 여기 없다. 그건 파일을 직접 연다 */
  { key: "config", label: "설정" },
];

function won(n: number | null | undefined): string {
  return n === null || n === undefined ? "-" : `${Math.round(n).toLocaleString()}원`;
}

/** 서버가 「없는 길」이라고 답하면 세션이 끊긴 것이다 — 그때만 로그인 칸으로 되돌린다 */
function isGone(e: unknown): boolean {
  return e instanceof Error && /not found/i.test(e.message);
}

/**
 * 주소로 넘어온 값 (2026-09-04) — 손절 알림이 「값이 채워진 매도 폼」으로 보낸다.
 *
 *   #/order?stk=034020&name=두산에너빌리티&side=sell&tt=28&cond=75000&price=75000&qty=100
 *
 * ⚠️ 종목 칸 이름이 `stk` 인 이유: `code` 를 쓰면 해시 라우터가 **종목 이동**으로 읽어
 * 주문 화면 위에 종목 상세 시트를 띄운다(2026-09-04 실측). 라우터가 모르는 이름이어야 한다.
 *
 * ⚠️ **채워 주기만 한다.** 주문서 확인과 주문 비밀번호는 그대로 남아 있다 — 링크 하나로
 * 주문이 나가면 그건 알림에 링크를 심은 사람이 주문을 낼 수 있다는 뜻이 된다.
 */
interface Prefill {
  code: string;
  name: string;
  side: "buy" | "sell" | null;
  tradeType: string | null;
  price: string;
  cond: string;
  qty: string;
  /** 값이 바뀌었는지 가리는 열쇠 — 같은 화면에서 링크를 또 눌러도 다시 채워진다 */
  key: string;
}

/**
 * ⚠️ **해시 라우터보다 먼저 집어 둔다** (2026-09-04 실측).
 *
 * 라우터(`useHashRoute`)는 해시를 `{tab, stock}` 만으로 **다시 쓴다** — `#/order?stk=…&qty=…`
 * 로 들어와도 곧 `#/order` 가 되어 우리 값이 사라진다. 실제로 그래서 프리필이 통째로 날아갔다.
 *
 * 이 파일은 App 이 import 하는 순간 실행되므로, 여기서 건 `hashchange` 리스너가 라우터의
 * 것(첫 렌더 뒤 useEffect 에서 건다)보다 **먼저 등록되고 먼저 불린다.** 그 틈에 값을 집어
 * 모듈 변수에 둔다. 화면은 그걸 꺼내 쓰고 비운다 — 한 번 쓰고 버리는 쪽지다.
 */
let pendingPrefill: Prefill | null = null;

function grabPrefill(): void {
  const p = readPrefill();
  if (p.code) pendingPrefill = p;
}

if (typeof window !== "undefined") {
  grabPrefill();
  window.addEventListener("hashchange", grabPrefill);
}

const EMPTY_PREFILL: Prefill = { code: "", name: "", side: null, tradeType: null, price: "", cond: "", qty: "", key: "" };

/**
 * 쪽지를 **보기만** 한다 — 비우지 않는다.
 *
 * 주문 화면은 잠겨 있을 때도(세션 없음·비밀번호 없음) 뜬다. 거기서 쪽지를 비워 버리면
 * 로그인을 마치고 폼이 뜨는 순간엔 이미 값이 없다 — 알림을 눌러 온 사람이 빈 폼을 만난다.
 * 그래서 **폼이 실제로 값을 채운 뒤에** 비운다(`clearPrefill`).
 */
function peekPrefill(): Prefill {
  return pendingPrefill ?? EMPTY_PREFILL;
}

function clearPrefill(): void {
  pendingPrefill = null;
}

function readPrefill(): Prefill {
  const raw = window.location.hash.replace(/^#\/?/, "");
  const q = new URLSearchParams(raw.split("?")[1] ?? "");
  const num = (k: string) => {
    const v = (q.get(k) ?? "").replace(/\D/g, "");
    return v;
  };
  const side = q.get("side");
  return {
    code: normalizeStockCode(q.get("stk") ?? ""),
    name: q.get("name") ?? "",
    side: side === "sell" || side === "buy" ? side : null,
    tradeType: q.get("tt"),
    price: num("price"),
    cond: num("cond"),
    qty: num("qty"),
    key: raw,
  };
}

export function OrderPage({ onSelectStock }: { onSelectStock?: (code: string, name: string) => void }) {
  const [status, setStatus] = useState<OrderStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sub, setSub] = useState<Sub>("order");
  const [left, setLeft] = useState(0);
  /* 주소가 값을 들고 오면 그 값으로 폼을 채운다 — 손절 알림이 이 길로 들어온다 */
  const [prefill, setPrefill] = useState<Prefill>(peekPrefill);

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

  /* 이미 주문 화면인 채로 알림을 또 누르면 해시만 바뀐다 — 그때도 채워져야 한다 */
  useEffect(() => {
    const onHash = () => {
      /* 쪽지는 위 모듈 리스너가 이미 집어 뒀다 — 여기서는 보기만 한다 */
      const p = peekPrefill();
      if (!p.code) return;
      setPrefill(p);
      setSub("order");
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

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
        <SessionGate status={status} onDone={load} />
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
          {sub === "order" && (
            <OrderForm status={status} prefill={prefill} onDone={load} onSelectStock={onSelectStock} />
          )}
          {sub === "open" && <OpenTab status={status} onDone={load} />}
          {sub === "fills" && <FillsTab />}
          {sub === "balance" && <BalanceTab onSelectStock={onSelectStock} />}
          {sub === "log" && <LogTab />}
          {sub === "config" && <ConfigTab status={status} onDone={load} />}
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

function SessionGate({ status, onDone }: { status: OrderStatus; onDone: () => void }) {
  const [id, setId] = useState("");
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /*
   * 등록 안 된 기기면 서버가 `needDevice` 로 돌려보낸다 (2026-09-04). 그때만 메일 확인
   * 단계로 넘어간다 — 등록된 기기는 이 화면을 평생 안 본다.
   */
  const [ticket, setTicket] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [devName, setDevName] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  /* PIN 으로 여는 판 — 설정이 정한다. 새 기기 등록만은 아이디·비밀번호로 (서버가 막는다) */
  const [pin, setPin] = useState("");
  /*
   * **등록하러 아이디·비밀번호 칸으로 건너간다** (2026-09-04).
   *
   * 벤티지: "태블릿에서 알맞은 비밀번호를 입력해도 다시 로그인 화면으로 가버려.
   * 이 기기를 새로 등록을 눌러도 로그인 화면으로."
   *
   * PIN 판에는 아이디·비밀번호 칸이 없어서 `id`·`pw` 가 **늘 빈 문자열**이었다. 그 상태로
   * 「이 기기를 새로 등록」을 누르면 빈 자격증명이 서버로 갔고, 서버는 당연히 401 을 줬다.
   * 그 401 이 앱 로그인 칸을 올렸다(`api.ts` 에서 같이 고쳤다). 즉 **PIN 판에서는 새 기기를
   * 등록할 길이 아예 없었다** — 단추만 있고 길이 없었던 것이다.
   *
   * 「새 기기는 아이디·비밀번호로만」이라는 규칙 자체는 그대로 둔다. 네 자리로 기기를
   * 늘릴 수 있으면 기기 겹이 뜻을 잃는다. 대신 **물어볼 자리를 만든다.**
   */
  const [regMode, setRegMode] = useState(false);
  const byPin = status.settings?.entryMode === "pin" && !regMode;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    /* 등록 판에서 엔터를 치면 **등록**이다 — 세션을 열려 하면 아직 등록이 없어 되돌아온다 */
    if (regMode) {
      void startDevice();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (byPin) {
        await api.orderOpenSessionPin(pin);
        setPin("");
        onDone();
        return;
      }
      await api.orderOpenSession(id, pw);
      setPw("");
      onDone();
    } catch (e2) {
      const msg = e2 instanceof Error ? e2.message : "열지 못했다";
      /* 서버가 준 문구에 「등록」이 있으면 기기 단계다 — 상태 코드는 api 층이 안 넘긴다 */
      if (/등록/.test(msg)) {
        /*
         * PIN 으로 들어왔으면 **곧장 메일을 못 쏜다** — 등록은 아이디·비밀번호로만 되고
         * 그 값이 이 판엔 없다. 빈 값으로 보내면 401 만 받는다(여태 그랬다).
         * 칸을 먼저 내주고, 왜 또 묻는지 적는다.
         */
        if (byPin) {
          setRegMode(true);
          setError("이 기기는 주문에 등록돼 있지 않습니다 — 등록은 아이디·비밀번호로만 됩니다");
          return;
        }
        setError(null);
        void startDevice();
        return;
      }
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  async function startDevice() {
    /* 아이디·비밀번호가 없으면 보내지 않는다 — 빈 값은 401 만 받고 사람은 이유를 모른다 */
    if (!id || !pw) {
      setRegMode(true);
      setError("등록하려면 앱 아이디와 비밀번호를 넣어 주세요 (PIN 으로는 새 기기를 못 들입니다)");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api.orderDeviceStart(id, pw);
      setTicket(r.ticket);
      setSent("메일로 6자리 숫자를 보냈습니다 (10분)");
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : "확인 메일을 못 보냈다");
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.orderDeviceVerify(ticket ?? "", code, devName);
      /*
       * 등록됐으면 곧바로 세션을 연다 — 비밀번호를 또 치게 하지 않는다.
       * PIN 판에서도 이 길이 통한다(2026-09-04 서버에서 같이 고쳤다): 아이디·비밀번호는
       * PIN 보다 약한 열쇠가 아니라, PIN 이 안 오면 원래 길로 본다.
       */
      await api.orderOpenSession(id, pw);
      setPw("");
      setCode("");
      setTicket(null);
      setRegMode(false);
      onDone();
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : "확인 실패");
    } finally {
      setBusy(false);
    }
  }

  if (ticket) {
    return (
      <form className="ord-gate" onSubmit={(e) => void verify(e)}>
        <div className="ord-gate-mark">📧</div>
        <b>이 기기를 주문에 등록합니다</b>
        <p>
          아이디·비밀번호는 <b>아는 것</b>이라 새어 나가면 어디서든 쓸 수 있습니다. 기기는{" "}
          <b>가진 것</b>이라, 둘 다 알아도 등록 안 된 기기에서는 주문 메뉴가 열리지 않습니다.
        </p>
        {sent && <p className="ord-ok">{sent}</p>}
        <input
          className="ord-in"
          inputMode="numeric"
          placeholder="메일로 받은 6자리"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
        />
        <input
          className="ord-in"
          placeholder="이 기기 이름 (예: 갤럭시 S25)"
          value={devName}
          onChange={(e) => setDevName(e.target.value)}
        />
        {error && <p className="ord-err">{error}</p>}
        <button type="submit" className="ord-go" disabled={busy || code.length !== 6}>
          {busy ? "확인 중…" : "등록하고 열기"}
        </button>
        <button type="button" className="ord-cancel" onClick={() => setTicket(null)}>
          그만
        </button>
      </form>
    );
  }

  if (byPin) {
    return (
      <form className="ord-gate" onSubmit={(e) => void submit(e)}>
        <div className="ord-gate-mark">🔢</div>
        <b>진입 PIN 네 자리</b>
        <p>
          <b>등록된 기기</b>에서만 열립니다 — 그래서 네 자리로 충분합니다. 다섯 번 틀리면 30분 잠기고
          텔레그램으로 알립니다. 주문을 낼 때는 <b>주문 비밀번호</b>를 따로 묻습니다.
        </p>
        {status.pinIsDefault && (
          <p className="ord-err">
            아직 기본값 <b>0000</b> 입니다 — 열고 나서 <b>설정 › 진입 PIN</b> 에서 바꾸세요.
          </p>
        )}
        <input
          className="ord-in ord-pin"
          type="password"
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="● ● ● ●"
          maxLength={4}
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 4))}
        />
        {error && <p className="ord-err">{error}</p>}
        <button type="submit" className="ord-go" disabled={busy || pin.length !== 4}>
          {busy ? "확인 중…" : "주문 메뉴 열기"}
        </button>
        {/*
          여태 여기서 곧장 메일을 쏘려 했다 — 그런데 이 판엔 아이디·비밀번호 칸이 없어
          빈 값이 나갔고 401 만 돌아왔다. 이제 **칸부터 내준다.**
        */}
        <button type="button" className="ord-cancel" onClick={() => setRegMode(true)} disabled={busy}>
          이 기기를 새로 등록
        </button>
      </form>
    );
  }

  return (
    <form className="ord-gate" onSubmit={(e) => void submit(e)}>
      <div className="ord-gate-mark">{regMode ? "🆕" : "🔐"}</div>
      <b>{regMode ? "이 기기를 주문에 등록합니다" : "주문 메뉴는 한 번 더 확인한다"}</b>
      <p>
        {regMode ? (
          <>
            앱 로그인과 같은 <b>아이디·비밀번호</b>를 넣으면 등록 확인 메일을 보냅니다.
            <b> PIN 으로는 새 기기를 못 들입니다</b> — 네 자리로 기기를 늘릴 수 있으면 「등록된
            기기에서만」이라는 겹이 뜻을 잃기 때문입니다.
          </>
        ) : (
          "앱 로그인과 같은 아이디·비밀번호입니다. 등록 안 된 기기라면 메일 확인이 한 번 더 있습니다."
        )}
      </p>
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
      {regMode ? (
        <>
          <button
            type="button"
            className="ord-go"
            disabled={busy || !id || !pw}
            onClick={() => void startDevice()}
          >
            {busy ? "메일 보내는 중…" : "확인 메일 보내기"}
          </button>
          <button
            type="button"
            className="ord-cancel"
            onClick={() => {
              setRegMode(false);
              setError(null);
            }}
            disabled={busy}
          >
            PIN 으로 돌아가기
          </button>
        </>
      ) : (
        <button type="submit" className="ord-go" disabled={busy || !id || !pw}>
          {busy ? "확인 중…" : "주문 메뉴 열기"}
        </button>
      )}
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

/* ── 매수·매도 ──────────────────────────────────────────────────────────── */

function OrderForm({
  status,
  prefill,
  onDone,
  onSelectStock,
}: {
  status: OrderStatus;
  prefill: Prefill;
  onDone: () => void;
  onSelectStock?: (code: string, name: string) => void;
}) {
  const [side, setSide] = useState<"buy" | "sell">(prefill.side ?? "buy");
  /*
   * **직전에 보던 종목으로 연다** (2026-09-04 — 벤티지: "매번 검색해야 돼서 불편").
   *
   * 링크로 온 값이 먼저다. 없을 때만 최근 본 종목을 채운다.
   *
   * ⚠️ 종목만 채우고 **수량·가격은 안 채운다.** 주문 화면에서 자동으로 채워진 값은
   * 사람이 「내가 고른 것」으로 착각하기 쉬운데, 종목은 틀려도 주문서 확인 화면에서
   * 이름이 보여 걸리지만 수량은 안 걸린다. 그리고 채운 사실을 칸 옆에 적어 둔다 —
   * 자동으로 들어온 값은 자동이라고 말해야 한다.
   */
  const [autoPicked] = useState(() => (prefill.code ? null : latestStock()));
  const [code, setCode] = useState(prefill.code || autoPicked?.code || "");
  const [name, setName] = useState(prefill.name || autoPicked?.name || "");
  /*
   * 기본 거래소는 **지금 열려 있는 곳** (2026-09-04).
   *
   * 예전엔 무조건 KRX 였다. 그래서 아침 8시대(NXT 프리마켓만 열린 시간)에 들어오면
   * 「KRX 가 주문을 받는 시간이 아니다」만 뜨고 — NXT 를 누르면 되는데 그 말이 없었다.
   * 벤티지: "nxt에서는 거래 안되는거야?" 되는데 **화면이 안 되는 것처럼 보였다.**
   */
  const [venue, setVenue] = useState<OrderVenue>(() => {
    /*
     * 설정에서 못 박아 뒀으면 그것, 「그때 열려 있는 곳」이면 열린 데를 고른다.
     * 다만 **낼 수 없는 거래소는 애초에 안 고른다** — 모의투자는 KRX 뿐이라, 통합(SOR)이
     * 먼저 있다고 그걸 잡으면 눌러 보고서야 RC9000 을 만난다 (2026-09-04).
     */
    const allowed = status.venueAllowed ?? VENUES.map((v) => v.key);
    const fixed = status.settings?.defaultVenue;
    if (fixed && fixed !== "auto" && allowed.includes(fixed)) return fixed;
    return allowed.find((k) => status.open[k]) ?? allowed[0] ?? "KRX";
  });
  /*
   * 매매구분 (2026-09-04). 예전엔 「시장가」 스위치 하나였는데 실제로는 18가지다 —
   * 목록은 **서버가 준다**(status.tradeTypes). 화면이 표를 들고 있으면 언젠가 서버와 갈린다.
   */
  const [tradeType, setTradeType] = useState(prefill.tradeType ?? status.settings?.defaultTradeType ?? "0");
  const [qty, setQty] = useState(prefill.qty);
  const [price, setPrice] = useState(prefill.price);
  const [cond, setCond] = useState(prefill.cond);
  /*
   * 호가를 누르면 **어느 칸**에 넣나 (2026-09-04). 보통은 가격 칸 하나뿐이라 고민이 없는데,
   * 스톱지정가는 발동가와 주문단가 둘이라 받을 곳을 정해야 한다. 스톱을 고르면 발동가가
   * 먼저다 — 그게 본론이고, 주문단가는 대개 거기서 몇 호가 안쪽이라 뒤에 정한다.
   */
  const [condFocus, setCondFocus] = useState(true);
  /* 호가창이 올려 주는 지금 값 — 종목 이름 옆에 적는다. 따로 조회하지 않는다 */
  const [quote, setQuote] = useState<{
    price: number;
    changeRate: number | null;
    krxHigh: number;
    krxLow: number;
    nxtHigh: number | null;
    nxtLow: number | null;
  } | null>(null);
  /*
   * 「가능금액의 몇 %」·「보유의 몇 %」를 세려면 계좌를 알아야 한다 (2026-09-04).
   * 폼을 열 때 한 번만 받는다 — 잔고 탭처럼 10초마다 부르면 주문 앱키에 조회가 계속 나간다.
   */
  const [acct, setAcct] = useState<OrderAccount | null>(null);
  useEffect(() => {
    void api
      .orderAccount()
      .then(setAcct)
      .catch(() => setAcct(null));
  }, []);
  /**
   * 수량과 금액은 서로를 고친다 — **누가 마지막에 손댔는지**를 알아야 무한히 되돌지 않는다.
   * 수량을 고쳤으면 금액이 따라오고, 금액을 고쳤으면 수량이 따라온다.
   */
  const lastEdit = useRef<"qty" | "amount">("qty");
  /** 「직접」을 누르면 커서를 수량 칸에 놓는다 */
  const qtyRef = useRef<HTMLInputElement>(null);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ticket, setTicket] = useState<{ nonce: string; expiresAt: number; ticket: OrderTicket } | null>(null);

  /*
   * 링크로 새 값이 오면 갈아 끼운다. **비어 있는 칸은 안 건드린다** — 사용자가 손으로
   * 고쳐 둔 값을 링크가 지우면 안 된다. 다만 링크가 값을 명시했으면 그쪽이 이긴다.
   */
  useEffect(() => {
    if (!prefill.code) return;
    setCode(prefill.code);
    setName(prefill.name);
    if (prefill.side) setSide(prefill.side);
    if (prefill.tradeType) setTradeType(prefill.tradeType);
    if (prefill.qty) setQty(prefill.qty);
    if (prefill.price) setPrice(prefill.price);
    if (prefill.cond) setCond(prefill.cond);
    /* 발동가가 채워져 왔으면 다음 호가 클릭은 주문단가 차례다 */
    setCondFocus(!prefill.cond);
    /* 다 썼으니 쪽지를 비운다 — 화면을 옮겼다 돌아왔을 때 손으로 고친 값을 덮지 않게 */
    clearPrefill();
  }, [prefill.key]);

  const types: TradeType[] = status.tradeTypes ?? [];
  const tt = types.find((t) => t.code === tradeType) ?? null;
  /* 「값을 안 쓰는 구분」이면 가격 칸을 잠근다 — 넣어 봐야 서버가 거절한다 */
  const usesPrice = tt ? tt.price !== "no" : true;
  const needsPrice = tt?.price === "req";
  const usesCond = tt?.cond === true;
  /* 시간외 구분은 정규장 밖에 내는 것이 정상이라 「시간 아님」 경고를 띄우지 않는다 */
  const open = tt?.late ? true : status.open[venue];
  /* 셈에 쓸 값 — 지정가면 그 값, 아니면 호가창이 아는 현재가(스톱은 발동가) */
  const unit = Number(price) || Number(cond) || 0;
  const held = acct?.holdings.find((h) => h.code === code)?.qty ?? 0;
  /*
   * 「100%」가 뜻하는 것. 매수는 **주문 가능 금액**, 매도는 **들고 있는 수량**이다.
   * 매수는 한 건 한도(기본 100만)도 같이 본다 — 100% 를 눌렀는데 서버가 거절하면
   * 그 단추는 없느니만 못하다. 한도에 걸려 줄었으면 그 사실을 아래에 적는다.
   */
  const cashBase = Math.min(acct?.deposit ?? 0, status.guard.maxOrderKrw);
  const maxQty = side === "buy" ? (unit > 0 ? Math.floor(cashBase / unit) : 0) : held;
  const cappedByGuard = side === "buy" && (acct?.deposit ?? 0) > status.guard.maxOrderKrw;

  function setPct(pct: number) {
    lastEdit.current = "qty";
    setQty(String(Math.max(0, Math.floor((maxQty * pct) / 100))));
  }

  /* 수량·가격이 바뀌면 금액이 따라온다 (금액을 손대는 중이면 가만둔다) */
  useEffect(() => {
    if (lastEdit.current !== "qty") return;
    const n = Number(qty) || 0;
    setAmount(n > 0 && unit > 0 ? String(n * unit) : "");
  }, [qty, unit]);

  const openVenues = VENUES.filter((v) => status.open[v.key]).map((v) => v.label);
  const ready = Boolean(code) && Boolean(qty) && (!needsPrice || Boolean(price)) && (!usesCond || Boolean(cond));

  /** 호가창이 부른다 — 값을 안 쓰는 구분이면 무시한다(넣어 봐야 서버가 거절한다) */
  function pickPrice(p: number) {
    if (usesCond && condFocus) {
      setCond(String(p));
      /* 발동가를 찍었으면 다음 클릭은 주문단가다 — 두 번 눌러 스톱 하나를 완성한다 */
      setCondFocus(false);
      return;
    }
    if (usesPrice) setPrice(String(p));
  }

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
    /*
     * ⚠️ **확인 창을 이 폼 안에 두지 말 것** (2026-09-04 실측으로 잡음).
     *
     * 벤티지: "매수 주문 넣어봤는데 주문도 안 들어가고 창도 안 닫히고."
     *
     * 확인 창도 `<form>` 이라, 주문 폼 **안에** 그리면 폼이 겹친다. HTML 은 폼 중첩을 허용하지
     * 않아서 브라우저가 안쪽 폼 태그를 조용히 버린다 — 그러면 「매수 실행」 단추가 **바깥 폼**을
     * 제출한다. 즉 실행 대신 `prepare` 가 다시 돌아 **새 주문서가 만들어지고**, 창은 그대로 남고,
     * 주문은 한 건도 안 나간다. 정확히 그 증상이었다.
     *
     * 확인 창은 화면에 떠 있는 덮개(position: fixed)라 자리를 안 먹는다 — 폼 **밖에** 둔다.
     */
    <>
      <form className={`ord-wrap ${side}`} onSubmit={(e) => void prepare(e)}>
      {/*
        머리는 폭을 다 쓴다 — 종목과 매수·매도는 「무엇을 어느 쪽으로」라서 제일 먼저 정한다.
        키움 앱도 이 둘을 호가창 **위**에 두고, 그 아래를 호가 | 주문으로 가른다.
      */}
      <div className="ord-head">
        <div className="ord-pick">
          <StockSearchBox
            placeholder="종목명 또는 6자리 코드"
            clearOnPick={false}
            onPick={(c, n) => {
              setCode(c);
              setName(n);
              setQuote(null);
            }}
          />
          {code && (
            <div className="ord-picked">
              {/*
                이름을 누르면 종목상세 (2026-09-04) — 값을 적기 전에 그 종목을 한 번 더 보는 길.
                **새 브라우저 탭으로 연다.** 이 화면 안에서 옮겨 가면 적어 둔 수량·가격이 날아간다 —
                종목을 보러 갔다가 주문을 처음부터 다시 치게 만들 수는 없다.
              */}
              <button
                type="button"
                className="ord-name-go"
                onClick={() =>
                  window.open(
                    `${window.location.pathname}#/stockAnalysis?code=${code}&name=${encodeURIComponent(name || code)}`,
                    "_blank",
                  )
                }
                title="종목 상세 — 새 탭으로 (적어 둔 값은 그대로 남습니다)"
              >
                {name || code}
              </button>
              <span className="ord-code">{code}</span>
              {/* 자동으로 들어온 값은 **자동이라고 말한다** — 고른 것으로 착각하면 안 된다 */}
              {autoPicked && code === autoPicked.code && (
                <em className="ord-auto" title="직전에 보던 종목을 채워 뒀습니다. 위에서 다시 검색하면 바뀝니다">
                  직전에 보던 종목
                </em>
              )}
              {/* 지금 값 — 가격을 적기 전에 「어디쯤인가」가 먼저 보여야 한다 */}
              {/*
                주문 화면에서는 이 표시가 **제일 중요한 자리**다 — 멈춘 값으로 주문을 내는 것이
                이 도구에서 가장 비싼 실수다. 상단 줄에도 같은 표시가 있지만, 가격을 적는
                눈길이 닿는 곳에 한 번 더 둔다.
              */}
              <LiveDot code={code} name={name} />
              {quote && quote.price > 0 && (
                <span className={`ord-quote ${signClass(quote.changeRate)}`}>
                  {fmtNum(quote.price)}
                  {quote.changeRate !== null && (
                    <i>
                      {quote.changeRate > 0 ? "+" : ""}
                      {quote.changeRate.toFixed(2)}%
                    </i>
                  )}
                </span>
              )}
            </div>
          )}
          {/*
            당일 고·저 — **KRX 와 NXT 를 갈라서** (2026-09-04). 두 시장은 고저가 다르고,
            지금 어느 쪽에 내는지에 따라 「위쪽이 어디였나」가 달라진다.
            호가창이 이미 받은 값이라 조회가 늘지 않는다.
          */}
          {code && quote && (quote.krxHigh > 0 || quote.nxtHigh) && (
            <div className="ord-hl">
              {quote.krxHigh > 0 && (
                <span>
                  <i>KRX</i> 고 <b className="positive">{fmtNum(quote.krxHigh)}</b> 저{" "}
                  <b className="negative">{fmtNum(quote.krxLow)}</b>
                </span>
              )}
              {quote.nxtHigh ? (
                <span>
                  <i>NXT</i> 고 <b className="positive">{fmtNum(quote.nxtHigh)}</b> 저{" "}
                  <b className="negative">{fmtNum(quote.nxtLow ?? 0)}</b>
                </span>
              ) : null}
            </div>
          )}
        </div>
        <div className="ord-side">
          <button type="button" className={side === "buy" ? "on buy" : ""} onClick={() => setSide("buy")}>
            매수
          </button>
          <button type="button" className={side === "sell" ? "on sell" : ""} onClick={() => setSide("sell")}>
            매도
          </button>
        </div>
      </div>

      {/*
        호가 | 주문칸 (2026-09-04 — 벤티지: "호가창이 밀려서 안보여, 주문도 세로 배치라 불편해.
        키움처럼 구현할 수 있겠니?").

        예전엔 폰에서 폼을 세우고 호가를 **그 아래로** 내렸다. 그러면 값을 넣는 동안 호가가
        화면 밖이라, 호가를 눌러 값을 넣는다는 이 화면의 핵심이 죽는다. 키움 앱처럼 **폰에서도
        나란히** 둔다 — 왼쪽은 호가(좁게, 가격·잔량만), 오른쪽은 입력칸.
      */}
      <div className="ord-grid">
        <div className="ord-book">
          {code ? (
            <OrderBookPanel code={code} onPickPrice={pickPrice} onQuote={setQuote} />
          ) : (
            <p className="empty">종목을 고르면 호가가 뜬다</p>
          )}
        </div>

        <div className="ord-fields">
          <label className="ord-lab">거래소</label>
          <div className="ord-venue">
            {VENUES.map((v) => {
              const can = (status.venueAllowed ?? VENUES.map((x) => x.key)).includes(v.key);
              return (
                <button
                  key={v.key}
                  type="button"
                  disabled={!can}
                  title={can ? v.hint : "모의투자에서는 못 냅니다 — 실전 계좌에서만"}
                  className={`${venue === v.key ? "on" : ""}${!can || !status.open[v.key] ? " shut" : ""}`}
                  onClick={() => setVenue(v.key)}
                >
                  {v.label}
                  <i>{!can ? "모의 불가" : status.open[v.key] ? "열림" : "닫힘"}</i>
                </button>
              );
            })}
          </div>

          {status.mock && (status.venueAllowed ?? []).length === 1 && (
            <div className="ord-caps">
              모의투자는 <b>KRX 만</b> 받습니다 — 통합(SOR)·NXT 는 실전 계좌에서만 (키움 RC9000)
            </div>
          )}

          <label className="ord-lab">매매구분</label>
          <select
            className="ord-in"
            value={tradeType}
            onChange={(e) => {
              setTradeType(e.target.value);
              /* 구분이 바뀌면 호가 클릭이 갈 곳도 처음으로 — 스톱을 새로 고르면 발동가부터다 */
              setCondFocus(true);
            }}
          >
            {types.map((t) => (
              <option key={t.code} value={t.code}>
                {t.label}
              </option>
            ))}
          </select>
          {tt && <div className="ord-caps">{tt.hint}</div>}

          <label className="ord-lab">수량</label>
          <div className="ord-step">
            <button
              type="button"
              onClick={() => {
                lastEdit.current = "qty";
                setQty((v) => String(Math.max(0, (Number(v) || 0) - 1)));
              }}
            >
              −
            </button>
            <input
              ref={qtyRef}
              className="ord-in"
              inputMode="numeric"
              value={qty}
              onChange={(e) => {
                lastEdit.current = "qty";
                setQty(e.target.value.replace(/\D/g, ""));
              }}
              placeholder="주"
            />
            <button
              type="button"
              onClick={() => {
                lastEdit.current = "qty";
                setQty((v) => String((Number(v) || 0) + 1));
              }}
            >
              ＋
            </button>
          </div>

          {/*
            비율 단추 (2026-09-04, 벤티지 요청). 매수는 가능금액, 매도는 보유수량 기준.
            기준을 못 잡으면(가격이 없거나 계좌를 못 읽으면) 눌리지 않는다 — 0 주가 들어가는 게 더 나쁘다.
          */}
          <div className="ord-pct">
            {[10, 25, 50, 100].map((n) => (
              <button key={n} type="button" disabled={maxQty <= 0} onClick={() => setPct(n)}>
                {n}%
              </button>
            ))}
            <button
              type="button"
              className="ord-pct-self"
              onClick={() => {
                lastEdit.current = "qty";
                setQty("");
                qtyRef.current?.focus();
              }}
            >
              직접
            </button>
          </div>
          <div className="ord-caps">
            {side === "buy"
              ? acct
                ? `가능금액 ${won(acct.deposit)}${cappedByGuard ? " (한 건 한도까지만)" : ""} → 최대 ${maxQty.toLocaleString()}주`
                : "계좌를 못 읽어 비율을 못 셉니다"
              : held > 0
                ? `보유 ${held.toLocaleString()}주`
                : code
                  ? "이 계좌에 없는 종목입니다"
                  : "종목을 고르면 보유 수량이 나옵니다"}
          </div>

          {usesCond && (
            <>
              <label className="ord-lab">발동가</label>
              <input
                className="ord-in"
                inputMode="numeric"
                value={cond}
                onChange={(e) => setCond(e.target.value.replace(/\D/g, ""))}
                placeholder="발동가"
              />
            </>
          )}

          <label className="ord-lab">{usesCond ? "주문단가" : "가격"}</label>
          <div className="ord-step">
            <button type="button" disabled={!usesPrice} onClick={() => setPrice((v) => String(Math.max(0, (Number(v) || 0) - 100)))}>
              −
            </button>
            <input
              className="ord-in"
              inputMode="numeric"
              disabled={!usesPrice}
              value={usesPrice ? price : ""}
              onChange={(e) => setPrice(e.target.value.replace(/\D/g, ""))}
              placeholder={usesPrice ? "원" : "값 없음"}
            />
            <button type="button" disabled={!usesPrice} onClick={() => setPrice((v) => String((Number(v) || 0) + 100))}>
              ＋
            </button>
          </div>

          {/*
            예상 금액도 **적을 수 있다** (2026-09-04, 벤티지: "금액을 넣으면 수량이 자동으로
            입력되게끔"). 「30만 원어치」로 생각할 때가 있는데, 그걸 수량으로 바꾸는 나눗셈을
            사람이 할 이유가 없다. 딱 나누어떨어지지 않으면 **내림** — 넘치면 주문이 거절된다.
          */}
          <label className="ord-lab">예상 금액</label>
          <div className="ord-amt">
            <input
              className="ord-in"
              inputMode="numeric"
              value={amount ? Number(amount).toLocaleString() : ""}
              onChange={(e) => {
                lastEdit.current = "amount";
                const v = e.target.value.replace(/\D/g, "");
                setAmount(v);
                setQty(unit > 0 && v ? String(Math.floor(Number(v) / unit)) : "");
              }}
              placeholder={unit > 0 ? "금액을 적으면 수량이" : "가격 먼저"}
              disabled={unit <= 0}
            />
            <span>원</span>
          </div>
          <div className="ord-caps">
            한 건 {won(status.guard.maxOrderKrw)} · 지정가 현재가 ±{status.guard.priceCollarPct}%
            {usesCond ? ` · 발동가 ±${status.guard.stopCollarPct}%` : ""} · 남은 건수{" "}
            {Math.max(0, status.guard.maxDailyCount - status.today.count)}
          </div>
        </div>

        <div className="ord-submit">
          {!open && status.guard.marketHoursOnly && (
            <p className="ord-err">
              {venue} 는 지금 주문을 안 받는다
              {openVenues.length > 0 ? (
                <>
                  {" — "}
                  <b>{openVenues.join(" · ")}</b> 는 열려 있다
                </>
              ) : (
                <> — 지금은 어느 거래소도 안 받는다 (NXT 프리 08:00 · KRX 08:30 · NXT 애프터 ~20:00)</>
              )}
            </p>
          )}
          {error && <p className="ord-err">{error}</p>}
          <button type="submit" className={`ord-go ${side}`} disabled={busy || !ready}>
            {busy ? "확인 중…" : side === "buy" ? "매수 주문" : "매도 주문"}
          </button>
          <p className="ord-note">
            {code && (
              <>
                호가를 누르면 {usesCond ? <b>{condFocus ? "발동가" : "주문단가"}</b> : "가격"} 칸에 들어간다
                {usesCond && (
                  <>
                    {" · "}
                    <button type="button" className="ord-mk" onClick={() => setCondFocus((v) => !v)}>
                      {condFocus ? "발동가로 받는 중" : "주문단가로 받는 중"}
                    </button>
                  </>
                )}
                {" · "}
              </>
            )}
            {usesCond ? "발동가에 닿으면 주문단가로 나간다 — 지켜보는 쪽은 키움이라 앱을 꺼 둬도 산다. " : ""}
            주문서를 눈으로 확인하고 비밀번호를 넣어야 실제로 나간다.
          </p>
        </div>
      </div>

      </form>

      {ticket && (
        <Confirm
          nonce={ticket.nonce}
          expiresAt={ticket.expiresAt}
          ticket={ticket.ticket}
          status={status}
          onClose={() => setTicket(null)}
          onDone={() => {
            setTicket(null);
            setQty("");
            onDone();
          }}
        />
      )}
    </>
  );
}

/* ── 두 번째 단계 — 주문서 확인 + 비밀번호 ──────────────────────────────── */

function Confirm({
  nonce,
  expiresAt,
  ticket,
  status,
  onClose,
  onDone,
}: {
  nonce: string;
  expiresAt: number;
  ticket: OrderTicket | CancelTicket;
  status: OrderStatus;
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
  /*
   * 비밀번호를 지금 안 물어도 되는 상태인가 (2026-09-04) — 설정에서 「기억하기」를 켜고
   * 앞선 주문에서 한 번 맞힌 뒤, 아직 시한 안일 때. **비밀번호를 어디에 저장한 게 아니라**
   * 서버가 이 주문 세션에 「확인됨」 시각을 찍어 둔 것이다.
   */
  const graced = status.settings.rememberPassword && status.passwordLeftSec > 0;
  const [remember, setRemember] = useState(status.settings.rememberPassword);

  async function go(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.orderExecute(nonce, pw, remember);
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
          {sideKo}하시겠습니까? <span className={`ord-tick${dead ? " dead" : ""}`}>{dead ? "만료" : `${sec}초`}</span>
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
        {graced ? (
          <div className="ord-graced">
            🔓 비밀번호 기억 중 — {Math.ceil(status.passwordLeftSec / 60)}분 남음. 이번엔 안 묻습니다.
          </div>
        ) : (
          <>
            <input
              ref={pwRef}
              className="ord-in"
              type="password"
              autoComplete="off"
              placeholder="주문 비밀번호"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
            />
            {status.settings.rememberPassword && (
              <label className="ord-remember">
                <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                {status.settings.rememberMinutes}분 동안 다시 묻지 않기
                <i>비밀번호를 저장하지 않습니다 — 이 주문 세션에만, 닫으면 사라집니다</i>
              </label>
            )}
          </>
        )}
        {error && <p className="ord-err">{error}</p>}
        {okMsg && <p className="ord-ok">{okMsg}</p>}
        <div className="ord-modal-btns">
          <button type="button" className="ord-cancel" onClick={onClose}>
            그만
          </button>
          <button type="submit" className={`ord-go ${isCancel ? "" : ticket.side}`} disabled={busy || dead || (!graced && !pw)}>
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

function OpenTab({ status, onDone }: { status: OrderStatus; onDone: () => void }) {
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
          <table className="ord-table stack">
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
                  <td data-l="시각">{r.time || "-"}</td>
                  <td className="ord-name">
                    {r.name || r.code} <span className="ord-code">{r.code}</span>
                  </td>
                  <td data-l="구분">{r.side || "-"}</td>
                  <td className="r" data-l="주문">{fmtNum(r.qty)}</td>
                  <td className="r" data-l="체결">{fmtNum(r.filled)}</td>
                  <td className="r" data-l="남은">{fmtNum(r.remain)}</td>
                  <td className="r" data-l="가격">{r.price ? r.price.toLocaleString() : "-"}</td>
                  <td className="r" data-l="발동가">{r.stopPrice ? r.stopPrice.toLocaleString() : "-"}</td>
                  <td data-l="상태">{r.status || "-"}</td>
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
          status={status}
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

/**
 * 잔고 — **손절선을 여기서 적는다** (2026-09-04).
 *
 * 벤티지: "그걸 복기노트에서 하면 안되지 주문메뉴의 계좌에서 해야지."
 *
 * 맞다. 어제까지 손절선은 복기 노트의 매수 기록에만 붙었는데, 그건 「돌아보며 적는 장부」지
 * 「지금 들고 있는 것」이 아니다. 계좌에 있는데 복기 노트에 안 적은 종목은 감시가 안 됐다.
 * 이제 **들고 있는 줄에 바로** 적고, 그 값으로 손절 감시가 돌고, 옆 단추가 스톱주문을 연다.
 */
function BalanceTab({ onSelectStock }: { onSelectStock?: (code: string, name: string) => void }) {
  const [acc, setAcc] = useState<OrderAccount | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 고치는 중인 칸 — 저장 전까지는 화면 값이 이긴다 */
  const [edit, setEdit] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(() => {
    void api
      .orderAccount()
      .then((a) => {
        setAcc(a);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "조회 실패"));
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);

  async function save(code: string, name: string, raw: string) {
    setSaving(code);
    try {
      const r = await api.orderSetStop(code, Number(raw.replace(/\D/g, "")) || 0, name);
      setAcc((prev) => (prev ? { ...prev, stops: r.stops } : prev));
      setEdit((prev) => {
        const next = { ...prev };
        delete next[code];
        return next;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "손절선을 못 적었다");
    } finally {
      setSaving(null);
    }
  }

  if (error && !acc)
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
      {error && <p className="ord-err">{error}</p>}
      {acc.holdings.length === 0 ? (
        <p className="empty">이 계좌에 보유 종목이 없다</p>
      ) : (
        <div className="ord-scroll">
          {/*
            `stack` — 폰에서는 이 표가 **줄마다 카드**로 접힌다 (2026-09-04).
            칸이 아홉이라 폰에서 옆으로 밀리는데, 하필 제일 중요한 손절선·스톱이 오른쪽 끝이라
            보이지도 않았다. 표를 하나 더 만드는 대신 CSS 로 접는다 — 마크업이 둘이면
            언젠가 한쪽만 고쳐진다. 칸 이름은 `data-l` 로 들고 다닌다.
          */}
          <table className="ord-table stack">
            <thead>
              <tr>
                <th>종목</th>
                <th className="r">수량</th>
                <th className="r">평단</th>
                <th className="r">현재가</th>
                <th className="r">평가손익</th>
                <th className="r">수익률</th>
                <th className="r">손절선</th>
                <th className="r">여유</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {acc.holdings.map((h) => {
                const saved = acc.stops?.[h.code]?.stop ?? 0;
                const shown = edit[h.code] ?? (saved ? String(saved) : "");
                const dirty = edit[h.code] !== undefined && Number(shown || 0) !== saved;
                /* 지금 값에서 손절선까지 몇 % 남았나 — 음수면 이미 깨진 것이다 */
                const room = saved > 0 && h.cur > 0 ? ((h.cur - saved) / h.cur) * 100 : null;
                return (
                  <tr key={h.code}>
                    <td
                      className={`ord-name${onSelectStock ? " click" : ""}`}
                      onClick={() => onSelectStock?.(h.code, h.name)}
                    >
                      {h.name} <span className="ord-code">{h.code}</span>
                    </td>
                    <td className="r" data-l="수량">{fmtNum(h.qty)}</td>
                    <td className="r" data-l="평단">{fmtNum(h.avg)}</td>
                    <td className="r" data-l="현재가">{fmtNum(h.cur)}</td>
                    <td className={`r ${signClass(h.pnl)}`} data-l="평가손익">{fmtNum(h.pnl)}</td>
                    <td className={`r ${signClass(h.pnlRate)}`} data-l="수익률">{h.pnlRate.toFixed(2)}%</td>
                    <td className="r" data-l="손절선">
                      <input
                        className="ord-stop-in"
                        inputMode="numeric"
                        placeholder="비움"
                        value={shown}
                        onChange={(e) => setEdit((p) => ({ ...p, [h.code]: e.target.value.replace(/\D/g, "") }))}
                        onBlur={() => dirty && void save(h.code, h.name, shown)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                        }}
                        disabled={saving === h.code}
                        title="이 값 아래로 가면 알림이 옵니다. 비우면 감시를 끕니다"
                      />
                    </td>
                    <td className={`r ${room !== null && room < 0 ? "negative" : ""}`} data-l="여유">
                      {room === null ? "-" : `${room.toFixed(1)}%`}
                    </td>
                    <td>
                      {saved > 0 && (
                        <a
                          className="ord-x stop"
                          href={`#/order?stk=${h.code}&name=${encodeURIComponent(
                            h.name,
                          )}&side=sell&tt=28&cond=${saved}&price=${saved}&qty=${h.qty}`}
                          title={`${h.qty}주 · 발동가 ${saved.toLocaleString()}원으로 매도 스톱주문`}
                        >
                          🛑 스톱
                        </a>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="ord-note">
        <b>손절선</b>은 여기 적습니다 — 적으면 <b>손절 감시</b>가 물고(장중 1분마다, 종목당 하루 한 번),
        깨지면 알림함과 텔레그램으로 옵니다. 비우면 감시를 끕니다. 「🛑 스톱」은 그 값으로{" "}
        <b>스톱지정가 매도</b> 폼을 엽니다 — 미리 걸어 두면 지켜보는 쪽이 키움이라 앱을 꺼 둬도 나갑니다.
      </p>
      <p className="ord-note">
        이 잔고는 <b>주문 전용 앱키의 계좌</b>입니다. 「연동 계좌 (키움)」가 보여 주는 조회용 계좌와 다를 수 있습니다.
        복기 노트의 손절선은 그대로 삽니다 — 그쪽은 <b>R 배수의 분모</b>라 「그때 정한 값」이고, 여기는 「지금 값」입니다.
        같은 종목이 양쪽에 있으면 <b>여기가 이깁니다</b>.
      </p>
    </div>
  );
}

/**
 * 주문 › 설정 (2026-09-04) — 벤티지: "기록 옆에 설정 메뉴도 만들어 줘."
 *
 * **여기서 못 고치는 것이 무엇인지가 더 중요하다.** 한 건·하루 한도, 가격 울타리, 장중만 —
 * 이것들은 `server/data/orderGuard.json` 을 직접 열어 고치고 서버를 다시 켜야 한다.
 * 화면에서 고칠 수 있으면 그건 한도가 아니다(설계 L3). 여기서는 **보여만 준다.**
 */
function ConfigTab({ status, onDone }: { status: OrderStatus; onDone: () => void }) {
  const [cfg, setCfg] = useState(status.settings);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pwA, setPwA] = useState("");
  const [pwB, setPwB] = useState("");
  const [pwCur, setPwCur] = useState("");
  const [pinA, setPinA] = useState("");
  const [pinCur, setPinCur] = useState("");

  async function save(patch: Partial<typeof cfg>) {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      const r = await api.orderSettingsSave(patch);
      setCfg(r.settings);
      setMsg("저장했습니다");
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "저장 실패");
    } finally {
      setBusy(false);
    }
  }

  async function changePin(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      await api.orderSetPin(pinA, pinCur);
      setPinA("");
      setPinCur("");
      setMsg("진입 PIN 을 바꿨습니다");
      onDone();
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : "실패");
    } finally {
      setBusy(false);
    }
  }

  async function changePw(e: React.FormEvent) {
    e.preventDefault();
    if (pwA !== pwB) {
      setError("새 비밀번호 두 칸이 다릅니다");
      return;
    }
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      await api.orderSetPassword(pwA, pwCur);
      setPwA("");
      setPwB("");
      setPwCur("");
      setMsg("주문 비밀번호를 바꿨습니다");
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : "실패");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ord-tab ord-cfg">
      {msg && <p className="ord-ok">{msg}</p>}
      {error && <p className="ord-err">{error}</p>}

      <section className="ord-cfg-sec">
        <h4>주문 비밀번호 기억하기</h4>
        <p className="ord-note">
          켜면 한 번 맞힌 뒤 정해 둔 시간 동안 실행마다 묻지 않습니다.{" "}
          <b>비밀번호를 저장하지 않습니다</b> — 서버가 이 주문 세션에 「확인됨」 시각만 찍어 둡니다.
          주문 메뉴를 닫거나 잠그면 그 자리에서 사라지고, 세션의 최대 수명(60분)을 넘지 않습니다.
        </p>
        <div className="ord-cfg-row">
          <label>
            <input
              type="checkbox"
              checked={cfg.rememberPassword}
              disabled={busy}
              onChange={(e) => void save({ rememberPassword: e.target.checked })}
            />
            기억하기 쓰기
          </label>
          <select
            className="ord-in"
            value={cfg.rememberMinutes}
            disabled={busy || !cfg.rememberPassword}
            onChange={(e) => void save({ rememberMinutes: Number(e.target.value) })}
          >
            {[5, 10, 15, 30, 60].map((m) => (
              <option key={m} value={m}>
                {m}분
              </option>
            ))}
          </select>
          <span className="ord-caps">
            {status.passwordLeftSec > 0 ? `지금 ${Math.ceil(status.passwordLeftSec / 60)}분 남음` : "지금은 매번 묻습니다"}
          </span>
          <button
            type="button"
            className="ord-x"
            disabled={busy || status.passwordLeftSec <= 0}
            onClick={() => void api.orderForget().then(onDone)}
          >
            지금 잊기
          </button>
        </div>
      </section>

      <section className="ord-cfg-sec">
        <h4>주문 메뉴가 닫히는 시간</h4>
        <p className="ord-note">
          열어 두면 잊고 자리를 뜨게 됩니다. <b>가만히 두면</b> 그 시간에 닫히고, 계속 쓰더라도{" "}
          <b>최대 시간</b>이 지나면 닫습니다. 짧을수록 안전하고 길수록 편합니다 — 기기를 잃어버렸을 때
          남에게 열려 있는 시간이 이 값입니다.
        </p>
        <div className="ord-cfg-row">
          <span className="ord-caps">가만히 두면</span>
          <select
            className="ord-in"
            value={cfg.idleMinutes}
            disabled={busy}
            onChange={(e) => void save({ idleMinutes: Number(e.target.value) })}
          >
            {[3, 5, 10, 20, 30, 60].map((m) => (
              <option key={m} value={m}>
                {m}분
              </option>
            ))}
          </select>
          <span className="ord-caps">최대</span>
          <select
            className="ord-in"
            value={cfg.maxMinutes}
            disabled={busy}
            onChange={(e) => void save({ maxMinutes: Number(e.target.value) })}
          >
            {[30, 60, 120, 240].map((m) => (
              <option key={m} value={m}>
                {m}분
              </option>
            ))}
          </select>
          <span className="ord-caps">바꾼 값은 다음에 열 때부터</span>
        </div>
      </section>

      <DeviceSection cfg={cfg} busy={busy} onSave={save} />

      <section className="ord-cfg-sec">
        <h4>기본값</h4>
        <div className="ord-cfg-row">
          <span className="ord-caps">거래소</span>
          <select
            className="ord-in"
            value={cfg.defaultVenue}
            disabled={busy}
            onChange={(e) => void save({ defaultVenue: e.target.value as typeof cfg.defaultVenue })}
          >
            <option value="auto">그때 열려 있는 곳</option>
            {VENUES.map((v) => (
              <option key={v.key} value={v.key}>
                {v.label}
              </option>
            ))}
          </select>
          <span className="ord-caps">매매구분</span>
          <select
            className="ord-in"
            value={cfg.defaultTradeType}
            disabled={busy}
            onChange={(e) => void save({ defaultTradeType: e.target.value })}
          >
            {(status.tradeTypes ?? []).map((t) => (
              <option key={t.code} value={t.code}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
      </section>

      <section className="ord-cfg-sec">
        <h4>주문 메뉴를 무엇으로 여나</h4>
        <p className="ord-note">
          <b>PIN 네 자리</b>는 손이 편합니다. 대신 네 자리는 만 가지뿐이라 <b>혼자 서는 문이 아닙니다</b> —
          그래서 <b>「등록된 기기에서만 주문」이 켜져 있을 때만</b> 고를 수 있습니다(서버가 막습니다).
          앞에 등록된 기기가 있고, 뒤에 주문 비밀번호가 따로 있어서 겹이 유지됩니다.
          다섯 번 틀리면 30분 잠기고 텔레그램으로 알립니다.
        </p>
        <div className="ord-cfg-row">
          {(["password", "pin"] as const).map((m) => (
            <button
              key={m}
              type="button"
              className={`filter-btn ${cfg.entryMode === m ? "active" : ""}`}
              disabled={busy}
              onClick={() => void save({ entryMode: m })}
            >
              {m === "password" ? "아이디·비밀번호" : "PIN 네 자리"}
            </button>
          ))}
          {status.pinIsDefault && <span className="ord-err">PIN 이 아직 기본값 0000 입니다</span>}
          {status.pinLockedUntilMs > 0 && (
            <span className="ord-err">
              PIN 잠금 — {Math.ceil((status.pinLockedUntilMs - Date.now()) / 60000)}분 남음
            </span>
          )}
        </div>
      </section>

      <form className="ord-cfg-sec" onSubmit={(e) => void changePin(e)}>
        <h4>진입 PIN 바꾸기</h4>
        <p className="ord-note">
          지금 PIN 또는 <b>주문 비밀번호</b>로 확인합니다 — PIN 을 잊어도 되돌릴 길이 있어야 합니다.
          0000·1234 처럼 뻔한 숫자는 막습니다. <b>주문 비밀번호와 다른 것</b>으로 하세요 — 같게 두면
          겹이 둘에서 하나로 줍니다.
        </p>
        <input
          className="ord-in"
          type="password"
          placeholder={status.pinIsDefault ? "지금 PIN (기본값 0000) 또는 주문 비밀번호" : "지금 PIN 또는 주문 비밀번호"}
          value={pinCur}
          onChange={(e) => setPinCur(e.target.value)}
        />
        <input
          className="ord-in ord-pin"
          type="password"
          inputMode="numeric"
          placeholder="새 PIN 네 자리"
          maxLength={4}
          value={pinA}
          onChange={(e) => setPinA(e.target.value.replace(/\D/g, "").slice(0, 4))}
        />
        <button type="submit" className="ord-go" disabled={busy || pinA.length !== 4 || !pinCur}>
          바꾸기
        </button>
      </form>

      <form className="ord-cfg-sec" onSubmit={(e) => void changePw(e)}>
        <h4>주문 비밀번호 바꾸기</h4>
        <input className="ord-in" type="password" placeholder="지금 비밀번호" value={pwCur} onChange={(e) => setPwCur(e.target.value)} />
        <input className="ord-in" type="password" placeholder="새 비밀번호 (6자 이상)" value={pwA} onChange={(e) => setPwA(e.target.value)} />
        <input className="ord-in" type="password" placeholder="한 번 더" value={pwB} onChange={(e) => setPwB(e.target.value)} />
        <button type="submit" className="ord-go" disabled={busy || pwA.length < 6 || !pwCur}>
          바꾸기
        </button>
      </form>

      <AccessLogSection />

      <section className="ord-cfg-sec">
        <h4>한도 — 여기서는 못 고칩니다</h4>
        <p className="ord-note">
          아래 값은 <code>server/data/orderGuard.json</code> 을 직접 열어 고치고 서버를 다시 켜야 바뀝니다.
          <b> 화면에서 고칠 수 있으면 그건 한도가 아닙니다.</b> 넘으면 줄여서 내지 않고 <b>거절</b>합니다.
        </p>
        <dl className="ord-cfg-kv">
          <div>
            <dt>한 건</dt>
            <dd>{won(status.guard.maxOrderKrw)}</dd>
          </div>
          <div>
            <dt>하루 합계</dt>
            <dd>{won(status.guard.maxDailyKrw)}</dd>
          </div>
          <div>
            <dt>하루 건수</dt>
            <dd>{status.guard.maxDailyCount}건</dd>
          </div>
          <div>
            <dt>지정가 울타리</dt>
            <dd>현재가 ±{status.guard.priceCollarPct}%</dd>
          </div>
          <div>
            <dt>스톱 발동가</dt>
            <dd>현재가 ±{status.guard.stopCollarPct}%</dd>
          </div>
          <div>
            <dt>장중만</dt>
            <dd>{status.guard.marketHoursOnly ? "예" : "아니오"}</dd>
          </div>
          <div>
            <dt>허용 종목</dt>
            <dd>{status.guard.allowedCodes?.length ? `${status.guard.allowedCodes.length}개만` : "전체"}</dd>
          </div>
          <div>
            <dt>모의/실전</dt>
            <dd>{status.mock ? "모의투자" : "실전 계좌"}</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}

/**
 * 등록된 기기 (2026-09-04) — 벤티지: "등록되어 있는 걸 삭제하고 수정할 수 있는 메뉴도."
 *
 * 지금 쓰는 기기도 지울 수 있게 둔다 — 빌린 컴퓨터에서 열었다면 지우고 싶을 것이다.
 * 대신 「지금 이 기기」라고 적어 **모르고 지우는 일**만 막는다.
 */
function DeviceSection({
  cfg,
  busy,
  onSave,
}: {
  cfg: OrderSettings;
  busy: boolean;
  onSave: (patch: Partial<OrderSettings>) => Promise<void>;
}) {
  const [devices, setDevices] = useState<OrderDevice[]>([]);
  const [mailReady, setMailReady] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    void api
      .orderDevices()
      .then((r) => {
        setDevices(r.devices);
        setMailReady(r.mailReady);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "못 읽었다"));
  }, []);
  useEffect(load, [load]);

  return (
    <section className="ord-cfg-sec">
      <h4>주문할 수 있는 기기</h4>
      <p className="ord-note">
        아이디·비밀번호는 <b>아는 것</b>이라 새어 나가면 어디서든 쓸 수 있습니다. 기기는 <b>가진 것</b>이라
        성질이 다릅니다 — 켜 두면 둘 다 알아도 <b>등록 안 된 기기에서는 주문 메뉴가 열리지 않습니다</b>.
        새 기기는 메일로 받은 6자리로 등록합니다.
      </p>
      {!mailReady && (
        <p className="ord-err">
          메일이 설정돼 있지 않아 기기 확인을 할 수 없습니다 — 이 설정은 켜도 동작하지 않습니다.
        </p>
      )}
      <div className="ord-cfg-row">
        <label>
          <input
            type="checkbox"
            checked={cfg.requireTrustedDevice}
            disabled={busy}
            onChange={(e) => void onSave({ requireTrustedDevice: e.target.checked })}
          />
          등록된 기기에서만 주문
        </label>
        {/*
          접근 점검 알림 (2026-09-04) — 벤티지: "주문 접근 점검 텔레그램 계속 오는데."
          끄더라도 점검은 6시간마다 그대로 돌고 기록도 남는다. 안 가는 건 **알림뿐**이다 —
          이 화면이 이미 「마지막 점검 · 이상 없음」을 말하고 있어서 겹치는 통로다.
        */}
        <label title="끄더라도 점검과 기록은 그대로입니다 — 텔레그램만 안 갑니다">
          <input
            type="checkbox"
            checked={cfg.auditTelegram !== false}
            disabled={busy}
            onChange={(e) => void onSave({ auditTelegram: e.target.checked })}
          />
          접근 점검을 텔레그램으로도
        </label>
      </div>
      {error && <p className="ord-err">{error}</p>}
      {devices.length === 0 ? (
        <p className="empty">아직 등록된 기기가 없습니다</p>
      ) : (
        <div className="ord-scroll">
          <table className="ord-table stack">
            <thead>
              <tr>
                <th>이름</th>
                <th>등록</th>
                <th>마지막</th>
                <th>주소</th>
                <th className="r">주문</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {devices.map((d) => (
                <tr key={d.id}>
                  <td className="ord-name">
                    {d.name} {d.current && <span className="ord-code">지금 이 기기</span>}
                  </td>
                  <td data-l="등록">{d.addedAt.slice(0, 10)}</td>
                  <td data-l="마지막">{d.lastAt.slice(5, 16).replace("T", " ")}</td>
                  <td data-l="주소">{d.lastIp}</td>
                  <td className="r" data-l="주문">
                    {d.orders}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="ord-x"
                      onClick={() => {
                        const name = window.prompt("이 기기의 새 이름", d.name);
                        if (name) void api.orderDeviceRename(d.id, name).then((r) => setDevices(r.devices));
                      }}
                    >
                      이름
                    </button>{" "}
                    <button
                      type="button"
                      className="ord-x"
                      onClick={() => {
                        if (!window.confirm(`${d.name} 을 지웁니다. 그 기기는 다음에 열 때 메일 확인을 다시 거칩니다.`)) return;
                        void api.orderDeviceRemove(d.id).then((r) => setDevices(r.devices));
                      }}
                    >
                      삭제
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/**
 * 접근 점검 (2026-09-04) — **줄을 늘어놓지 않는다.**
 *
 * 벤티지: "전부를 다 보여줄 필요는 없어. 그럼 엄청 쌓일 테니깐. 「기록 중」이라고만 쓰고
 * 「이상 행위 없었음」 이렇게 표시해줘. 니가 주기적으로 체크해주고."
 *
 * 맞다. 로그를 화면에 쏟는 것은 **판정을 사람에게 미루는 일**이다. 하루 수십 줄이 쌓이면
 * 아무도 안 읽고, 안 읽는 기록은 없는 것과 같다. 서버가 6시간마다 훑고(`startOrderAudit`)
 * **다른 것만** 말한다. 여기서는 그 판정을 한 줄로 보여 주고, 걸린 것이 있을 때만 편다.
 */
function AccessLogSection() {
  const [audit, setAudit] = useState<AccessAudit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(() => {
    void api
      .orderAudit(24)
      .then(setAudit)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "못 읽었다"));
  }, []);
  useEffect(load, [load]);

  const warns = (audit?.findings ?? []).filter((f) => f.level === "warn");

  return (
    <section className="ord-cfg-sec">
      <h4>접근 점검</h4>
      {error && <p className="ord-err">{error}</p>}
      {!audit ? (
        <p className="empty">훑는 중…</p>
      ) : (
        <>
          <div className={`ord-audit ${audit.ok ? "ok" : "bad"}`}>
            <b>{audit.ok ? "이상 행위 없었음" : `눈에 띄는 것 ${audit.findings.length}건`}</b>
            <span>
              기록 중 · 지난 {audit.hours}시간 {audit.records}줄 (통틀어 {audit.total}줄) ·{" "}
              {audit.ips.length > 0 ? `주소 ${audit.ips.length}곳` : "접근 없음"}
            </span>
            <i>
              점검{" "}
              {new Date(audit.checkedAt).toLocaleTimeString("ko-KR", { hour12: false, timeZone: "Asia/Seoul" })}
            </i>
          </div>
          <p className="ord-note">
            서버가 <b>6시간마다</b> 스스로 훑고, <b>이상이 있을 때만</b> 텔레그램으로 보냅니다 —
            조용한 것이 정상입니다. 보는 것: 주소가 둘 이상 · 비밀번호·로그인 실패 · 한도 거절 ·
            키움이 거절한 실패 · 기기 등록·삭제 · 화면 잠금. 주문 자체는 <b>기록</b> 탭에 있습니다.
          </p>
          {audit.findings.length > 0 && (
            <>
              <button type="button" className="ord-x" onClick={() => setOpen((v) => !v)}>
                {open ? "접기" : `자세히 (${audit.findings.length}건)`}
              </button>
              {open && (
                <ul className="ord-audit-list">
                  {audit.findings.map((f, i) => (
                    <li key={`${f.at}-${i}`} className={f.level}>
                      <span className="ord-audit-at">{f.at.slice(5, 16).replace("T", " ")}</span>
                      <span className="ord-audit-msg">{f.msg}</span>
                      {f.ip && <span className="ord-audit-ip">{f.ip}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          {warns.length === 0 && audit.findings.length > 0 && (
            <p className="ord-caps">전부 알아 둘 만한 것뿐이고, 위험해 보이는 것은 없습니다.</p>
          )}
        </>
      )}
    </section>
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
