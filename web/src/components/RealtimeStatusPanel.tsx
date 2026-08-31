import { useEffect, useState } from "react";
import { api, type RealtimeStatus, type RealtimeStoreInfo } from "../api";

/**
 * 실시간 상태 (2026-08-31).
 *
 * ## 왜 필요했나
 *
 * 오늘 실시간 REG 가 **200쌍 상한에 걸려 통째로 거절**되고 있는 것을 찾았다
 * (`105118`). 그런데 소켓은 「연결됨 · healthy」였다 — **화면상으로는 완전히
 * 멀쩡해 보인다.** 값이 안 오는데 아무도 모르는 것이 제일 나쁜 실패다.
 *
 * 그 상태를 볼 수 있는 화면이 앱에 **하나도 없었다.** 서버 API 를 직접 두드려야
 * 알 수 있었는데, 로그인을 켜면 그것도 401 로 막힌다.
 *
 * 그래서 세 숫자를 보여 준다:
 *   · **구독** — 몇 쌍을 걸어 뒀나
 *   · **받은 값** — 실제로 값이 온 종목 수. 구독보다 한참 적으면 안 오고 있는 것이다
 *   · **거절** — 여기 뭐가 있으면 「연결은 됐는데 안 온다」의 원인이다
 */

function fmt(n: number | undefined): string {
  return typeof n === "number" ? n.toLocaleString("ko-KR") : "-";
}

export function RealtimeStatusPanel() {
  const [s, setS] = useState<RealtimeStatus | null>(null);
  const [store, setStore] = useState<RealtimeStoreInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const load = () => {
      api.realtimeStatus().then(setS).catch((e) => setErr(e instanceof Error ? e.message : "못 받음"));
      api.realtimeStoreInfo().then(setStore).catch(() => undefined);
    };
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, []);

  if (err) return <div className="error-banner">{err}</div>;
  if (!s) return <div className="table-note">불러오는 중…</div>;

  const errs = s.regErrors ?? [];
  return (
    <div className="rts">
      <div className="rts-top">
        <span className={`rts-dot${s.healthy ? " ok" : ""}`} />
        <b>{s.state}</b>
        {!s.enabled && <span className="pt-n"> · 꺼져 있음</span>}
      </div>

      <div className="rts-nums">
        <span>
          <em>구독</em>
          <b>{fmt(s.subscribed)}</b>
        </span>
        <span>
          <em>받은 값</em>
          <b>{fmt(s.keys)}</b>
        </span>
        <span>
          <em>쌓인 점</em>
          <b>{fmt(store?.points)}</b>
        </span>
        <span>
          <em>거절</em>
          <b className={errs.length > 0 ? "negative" : ""}>{errs.length}</b>
        </span>
      </div>

      {/*
        거절은 **접지 않고 그대로** 보여 준다. 이걸 접어 두면 오늘 같은 일이
        또 몇 달 동안 안 보인다.
      */}
      {errs.length > 0 && (
        <div className="rts-errs">
          {errs.slice(-5).map((e, i) => (
            <div key={i}>
              <span className="pt-n">{e.at.slice(11, 19)}</span> <b>{e.code}</b> {e.msg}
            </div>
          ))}
        </div>
      )}

      {store?.types && Object.keys(store.types).length > 0 && (
        <div className="table-note">
          갈래별 받은 값 —{" "}
          {Object.entries(store.types)
            .map(([k, v]) => `${k} ${v}`)
            .join(" · ")}
          {" "}(0B 체결 · 0D 호가 · 0F 거래원 · 0w 프로그램)
        </div>
      )}

      <div className="table-note">
        <b>받은 값이 구독보다 한참 적으면</b> 값이 안 오고 있는 것입니다. 소켓이
        「연결됨」이어도 등록이 거절되면 그렇게 됩니다 — 그때 <b>거절</b> 칸에 이유가
        남습니다. 장이 열려 있지 않으면 자연히 적습니다.
      </div>
    </div>
  );
}
