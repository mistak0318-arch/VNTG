import { useEffect, useState } from "react";
import { api, type LedgerResetReport } from "../api";

/**
 * **원장에 선 긋기** (2026-09-01) — 지우는 게 아니라 옮긴다.
 *
 * 벤티지: "지금 신호등 체계가 바뀌다 못해 아주 새거다. 지표들도 다 그렇고.
 * 그럼 지금까지 신호등에 들어왔던거 싹 지우고 오늘부터 재수집해서 보는게
 * 의미 있을거 같은데."
 *
 * ## 왜 이 화면이 「미리 보기」부터인가
 *
 * 되돌릴 수 있는 일이라도 **무엇이 사라지는지 모르는 채로 누르면 안 된다.**
 * 그래서 화면을 열면 먼저 세어 보여 주고, 그다음에 단추가 나온다.
 *
 * 「지금 기준으로 걸린 것이 몇 건인가」를 같이 적는 것이 요점이다 — 그 숫자가
 * 0 이면 지금 쌓인 것이 전부 다른 규칙으로 걸렸다는 뜻이라, 선을 그을 이유가
 * 화면에서 바로 보인다.
 */
export function LedgerResetPanel() {
  const [pre, setPre] = useState<LedgerResetReport | null>(null);
  const [done, setDone] = useState<LedgerResetReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open || pre) return;
    api
      .signalResetLedgersPreview()
      .then(setPre)
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : "미리 보기 실패"));
  }, [open, pre]);

  const run = () => {
    const n = pre?.totalMoved ?? 0;
    if (
      !window.confirm(
        `원장 ${n.toLocaleString("ko-KR")}건을 보관하고 비웁니다.\n\n` +
          `· 파일은 server/data 에 .archive-... 로 남습니다 (되돌릴 수 있습니다)\n` +
          `· 관심종목의 자동 그룹(점수대·슈퍼신호등)에서도 종목이 빠집니다\n` +
          `· 표본·일봉·일별원장·ETF 그룹·메모는 건드리지 않습니다\n\n` +
          `오늘부터 지금 기준으로 새로 쌓입니다. 진행할까요?`,
      )
    )
      return;
    setBusy(true);
    setErr(null);
    api
      .signalResetLedgers()
      .then((r) => {
        setDone(r);
        setPre(null);
      })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : "실패"))
      .finally(() => setBusy(false));
  };

  const groupTotal = (r: LedgerResetReport) =>
    Object.values(r.groups).reduce((a, b) => a + b, 0);

  return (
    <section className="card">
      <button className="gb-head" onClick={() => setOpen((v) => !v)}>
        <span className="gb-caret">{open ? "▾" : "▸"}</span>
        <b>원장에 선 긋기</b>
        <span className="pt-n">
          기준이 바뀌었을 때 — 지금까지 쌓인 편입 기록을 보관하고 오늘부터 새로 셉니다
        </span>
      </button>

      {open && (
        <>
          <p className="table-note">
            신호등 기준을 바꾸면 <b>그 전의 90점과 그 뒤의 90점은 다른 것</b>입니다. 한 표에
            섞이면 평균이 뜻을 잃습니다. 그래서 기준마다 <b>지문</b>을 남기는데, 지문이 여러
            가지 섞인 원장은 성적을 읽을 수가 없습니다.
            <br />
            <b>지우지 않고 옮깁니다</b> — 파일은 <code>server/data</code> 에{" "}
            <code>.archive-날짜.json</code> 으로 남습니다. 편입 원장은 소급이 안 되기 때문에,
            나중에 「옛 기준이 실제로 얼마나 나빴나」를 물으려면 그게 있어야 합니다.
          </p>

          {err && <p className="sim-err">{err}</p>}

          {pre && !done && (
            <>
              <div className="data-table-wrap">
                <table className="data-table num">
                  <thead>
                    <tr>
                      <th>원장</th>
                      <th className="num">보관할 건수</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pre.ledgers.map((l) => (
                      <tr key={l.file}>
                        <td>{l.label}</td>
                        <td className="num">
                          {l.error ? (
                            <span className="negative">읽기 실패</span>
                          ) : (
                            l.moved.toLocaleString("ko-KR")
                          )}
                        </td>
                      </tr>
                    ))}
                    <tr className="gb-base">
                      <td>
                        <b>합계</b>
                      </td>
                      <td className="num">
                        <b>{pre.totalMoved.toLocaleString("ko-KR")}</b>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="pt-n">
                관심종목 자동 그룹에서 빠질 종목 <b>{groupTotal(pre)}</b>개 · 지금 기준 지문{" "}
                <code>{pre.fingerprint ?? "?"}</code>
              </p>
              <p className="table-note">
                <b>건드리지 않는 것:</b> 검증 표본(과거 시세로 만든 것이라 기준과 무관합니다) ·
                일봉 · 일별 원장(둘 다 소급이 안 되고 표본의 재료입니다) · ETF 그룹(사람이
                담은 것입니다) · 복기 노트 · 메모 · 태그 · 각 원장의 설정값(무지개 일수·모집단
                크기 등).
              </p>
              <div className="sim-actions">
                <button className="primary-btn" onClick={run} disabled={busy}>
                  {busy ? "정리 중…" : `원장 ${pre.totalMoved.toLocaleString("ko-KR")}건 보관하고 비우기`}
                </button>
              </div>
            </>
          )}

          {done && (
            <div className="page-note">
              <b>끝났습니다.</b> {done.totalMoved.toLocaleString("ko-KR")}건을 보관하고 비웠습니다
              (자동 그룹에서 {groupTotal(done)}종목 뺌).
              <br />
              기준 지문 <code>{done.fingerprint ?? "?"}</code> — 여기서부터 쌓이는 것은 모두 이
              기준입니다.
              <br />
              보관 파일:{" "}
              {done.ledgers
                .filter((l) => l.archive)
                .map((l) => l.archive)
                .join(" · ") || "(없음)"}
              <br />
              <span className="pt-n">
                다음 편입은 오늘 15:40 마감 뒤 정리에서 쌓입니다. 지금 바로 채우려면 설정 &gt;
                마감 뒤 정리에서 ⑤신호등 분석·⑥슈퍼신호등을 누르세요.
              </span>
            </div>
          )}
        </>
      )}
    </section>
  );
}
