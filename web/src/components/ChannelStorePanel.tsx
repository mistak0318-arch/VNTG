import { useCallback, useEffect, useState } from "react";
import { api, type ChannelStoreStatus } from "../api";
import { useFold } from "../useFold";

/**
 * **채널 글 창고** — 얼마나 찼나 (2026-09-05).
 *
 * 벤티지가 창고 상태를 보려고 미니PC 에서 `curl` 을 쳤는데 「로그인이 필요합니다」가 나왔다.
 * 창구가 로그인을 요구하는 건 맞다 — 채널 글은 남의 방 이야기다. 그러면 **화면에 있어야** 한다.
 *
 * 이 판이 답하는 것 넷:
 *   · 창고가 **차 있나** (총 건수·크기)
 *   · **뒤로 어디까지** 닿나 — 「한 달」을 골라도 실제로는 여기까지만 본다
 *   · **수집이 돌고 있나** — 마지막 회차가 언제, 몇 건, 실패했나
 *   · 날짜별로 고르게 쌓였나 — 중간이 비면 그날 수집이 멎었던 것이다
 *
 * 창고가 안 차면 검색이 얕아지는데, 그 사실이 검색 화면에서는 「0건」으로만 보인다.
 * 원인을 볼 자리를 따로 두는 이유가 그것이다.
 *
 * ## 그런데 **기본은 접혀 있다** (2026-09-05)
 *
 * 벤티지: "상단에 보여주는 거는 접힘 메뉴로 해서 기본이 접힌 상태로. 접힌 상태에서는
 * 수집 동향만 간략하게. 지금 사각형이 너무 길어짐."
 *
 * 맞다. 이건 **평소에 볼 것이 아니라 이상할 때 여는 자리**다. 검색하러 온 사람 앞을
 * 여섯 칸짜리 표가 늘 막고 있을 이유가 없다.
 *
 * 대신 접혀 있어도 **한 줄은 남긴다** — 「3.2만건 · 뒤로 12일 · 방금 수집」.
 * 펴 볼지 판단할 근거가 없으면 접기가 그냥 숨기기가 된다. 그리고 **뭔가 잘못되면
 * 접힌 줄이 빨개진다** — 수집이 멎었는데 접혀 있다고 조용하면 접은 것이 사고가 된다.
 */

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)}MB`;
const num = (n: number) => n.toLocaleString("ko-KR");

function ago(iso: string | null): string {
  if (!iso) return "-";
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (m < 1) return "방금";
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}

export function ChannelStorePanel() {
  const [st, setSt] = useState<ChannelStoreStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  /* 기본은 접힘 — 평소에 볼 것이 아니라 이상할 때 여는 자리다 */
  const [open, toggleFold] = useFold("store", false, "tg");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .channelStore()
      .then(setSt)
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    load();
    /* 수집이 10분마다라 1분에 한 번이면 넉넉하다 */
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  async function seed() {
    if (!confirm("채널 일흔 곳을 깊게 다시 긁습니다. 자주 하면 텔레그램이 잠깐 막습니다. 하시겠습니까?")) return;
    setBusy(true);
    setMsg(null);
    setError(null);
    try {
      const r = await api.channelStoreSeed();
      setMsg(r.ran ? `채웠습니다 — ${num(r.added)}건 새로 저장` : `건너뛰었습니다 — ${r.why}`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "실패");
    } finally {
      setBusy(false);
    }
  }

  if (error) return <div className="error-banner">{error}</div>;
  if (!st) return <p className="pt-n">창고를 읽는 중…</p>;

  /* 뒤로 실제 며칠 닿나 — 「한 달」을 골라도 이만큼만 본다 */
  const reachDays = st.oldest
    ? Math.max(0, (Date.now() - new Date(st.oldest).getTime()) / 86400_000)
    : 0;
  const stale = st.collector ? Date.now() - new Date(st.collector.at).getTime() > 25 * 60_000 : true;
  /* 접힌 줄을 빨갛게 만들 조건 — 접어 뒀다고 고장이 조용하면 안 된다 */
  const bad = st.totalLines === 0 || stale || Boolean(st.collector?.error);

  return (
    <section className="card cst">
      <button className="cst-head" onClick={toggleFold} title={open ? "접기" : "펴기"}>
        <span className="cst-caret">{open ? "▾" : "▸"}</span>
        <b>채널 글 창고</b>
        {/* 접혀 있어도 한 줄 — 펴 볼지 판단할 근거 */}
        <span className={`cst-peek${bad ? " bad" : ""}`}>
          {st.totalLines === 0
            ? "아직 비어 있음"
            : `${num(st.totalLines)}건 · 뒤로 ${reachDays.toFixed(reachDays < 10 ? 1 : 0)}일 · 수집 ${
                st.collector ? ago(st.collector.at) : "아직"
              }`}
        </span>
      </button>

      {!open && st.collector?.error && (
        <p className="ord-err">마지막 수집이 실패했습니다 — {st.collector.error}</p>
      )}

      {open && (
      <>
      <p className="pt-n">
        검색은 여기서 나옵니다 — 텔레그램을 다시 부르지 않습니다.{" "}
        <button className="filter-btn" onClick={() => void seed()} disabled={busy}>
          {busy ? "긁는 중…" : "뒤로 더 긁기"}
        </button>
      </p>

      {msg && <p className="pt-n">{msg}</p>}

      <dl className="cst-kv">
        <div>
          <dt>쌓인 글</dt>
          <dd>{num(st.totalLines)}건</dd>
        </div>
        <div>
          <dt>크기</dt>
          <dd>{mb(st.totalBytes)}</dd>
        </div>
        <div title="「한 달」로 검색해도 실제로는 여기까지만 봅니다. 채널마다 가져올 수 있는 글 수에 상한이 있어서입니다">
          <dt>뒤로 닿는 데</dt>
          <dd className={reachDays < 3 ? "negative" : ""}>
            {st.oldest ? `${reachDays.toFixed(reachDays < 10 ? 1 : 0)}일` : "없음"}
          </dd>
        </div>
        <div>
          <dt>가장 최근 글</dt>
          <dd>{ago(st.newest)}</dd>
        </div>
        <div title="10분마다 최근 30분치를 받습니다 — 겹쳐 받아서 한 번 실패해도 다음이 메웁니다">
          <dt>마지막 수집</dt>
          <dd className={stale ? "negative" : ""}>
            {st.collector ? ago(st.collector.at) : "아직"}
            {st.collector && (
              <span className="pt-n"> · {num(st.collector.added)}건 저장</span>
            )}
          </dd>
        </div>
        <div>
          <dt>보관</dt>
          <dd>{st.keepDays}일</dd>
        </div>
      </dl>

      {st.collector?.error && (
        <p className="ord-err">마지막 수집이 실패했습니다 — {st.collector.error}</p>
      )}
      {stale && st.collector && (
        <p className="ord-err">
          25분 넘게 수집이 안 돌았습니다 — 텔레그램 세션이나 서버 로그(<b>[channels]</b>)를 보세요.
        </p>
      )}
      {st.totalLines === 0 && (
        <p className="pt-n">
          아직 비어 있습니다. 서버를 켠 지 1~2분이면 <b>첫 채우기</b>가 돕니다 — 그래도 비어
          있으면 텔레그램 세션이 없는 것입니다.
        </p>
      )}

      {/*
        날짜별로 보여 주는 이유: **중간이 비면 그날 수집이 멎었던 것**이다.
        총계만 보면 그게 안 보인다 — 어제 하루가 통째로 비어도 총계는 그럴듯하다.
      */}
      {st.days.length > 0 && (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>날짜</th>
                <th className="num">글</th>
                <th className="num">크기</th>
              </tr>
            </thead>
            <tbody>
              {st.days.map((d) => (
                <tr key={d.day}>
                  <td>{d.day.slice(5)}</td>
                  <td className={`num ${d.lines === 0 ? "negative" : ""}`}>{num(d.lines)}</td>
                  <td className="num pt-n">{mb(d.bytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      </>
      )}
    </section>
  );
}
