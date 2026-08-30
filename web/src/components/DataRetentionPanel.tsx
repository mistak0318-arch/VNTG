import { useEffect, useState } from "react";
import { api, type DataReport } from "../api";

/**
 * 데이터 보관 (2026-08-31 요청 — 「기간별로 드는 용량 표시해주고, 최종적으로 전체
 * 용량도. 조절해가면서 하거나 추가 용량을 붙일 수도 있으니」).
 *
 * ## 이 화면이 답하려는 물음
 *
 *   1. 지금 뭐가 얼마나 쌓여 있나
 *   2. **기간을 줄이면 얼마가 빠지나** — 그게 안 보이면 숫자를 고를 수가 없다
 *   3. 더 쌓으려면 어디에 붙여야 하나
 *
 * 실측으로 시작된 화면이다: `server/data` 221MB 중 **214MB 가 실시간 로그**였고
 * 하루 43MB 씩 늘고 있었는데 **지우는 코드가 없었다.**
 */

const CHOICES: { d: number | null; label: string }[] = [
  { d: 7, label: "7일" },
  { d: 14, label: "14일" },
  { d: 30, label: "30일" },
  { d: 60, label: "60일" },
  { d: 90, label: "90일" },
  { d: 180, label: "180일" },
  { d: 365, label: "1년" },
  { d: null, label: "안 지움" },
];

function mb(b: number): string {
  if (b >= 1073741824) return `${(b / 1073741824).toFixed(2)}GB`;
  if (b >= 1048576) return `${(b / 1048576).toFixed(1)}MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(0)}KB`;
  return `${b}B`;
}

const KIND_NOTE: Record<string, string> = {
  daily: "",
  append: "한 파일에 덧붙이는 구조라 날짜로 못 자릅니다",
  single: "매번 덮어써서 이력이 없습니다",
};

/**
 * **기간별로 얼마가 빠지나** (2026-08-31 2차).
 *
 * ⚠️ 처음엔 「지금 설정이면 −몇 MB」 한 칸만 뒀는데, 설정이 넉넉하면 그 값이 늘
 * 0 이라 **표 전체가 「—」로 보였다.** 「조절해 가면서 정하겠다」는 사람에게 그건
 * 아무 정보가 아니다 — 고르기 전에 결과를 알아야 고를 수 있다.
 *
 * 그래서 **후보 기간마다** 얼마가 빠지는지 미리 계산해 나란히 놓는다. 숫자 자체가
 * 단추라 눌러서 바로 그 기간으로 정할 수 있다.
 *
 * 서버가 주는 나이대별 용량(`byAge`)의 **누적 밖**이 빠지는 양이다.
 */
function freedAt(byAge: { d7: number; d30: number; d90: number; d365: number; older: number }, keep: number): number {
  if (keep <= 7) return byAge.d30 + byAge.d90 + byAge.d365 + byAge.older;
  if (keep <= 30) return byAge.d90 + byAge.d365 + byAge.older;
  if (keep <= 90) return byAge.d365 + byAge.older;
  if (keep <= 365) return byAge.older;
  return 0;
}

/** 나이대 문턱과 겹치는 후보만 보여 준다 — 안 그러면 0 만 늘어선다 */
const BANDS = [7, 30, 90, 365];

export function DataRetentionPanel() {
  const [rep, setRep] = useState<DataReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    api.dataReport().then(setRep).catch(() => undefined);
  }, []);

  async function prune() {
    if (!window.confirm("보관 기간이 지난 파일을 지웁니다. 되돌릴 수 없습니다. 진행할까요?")) return;
    setBusy(true);
    try {
      const r = await api.dataPrune();
      setRep(r.report);
      setMsg(r.removed > 0 ? `${r.removed}개 지움 — ${mb(r.bytes)} 확보` : "지울 것이 없었습니다");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "정리 실패");
    } finally {
      setBusy(false);
    }
  }

  if (!rep) return <div className="table-note">불러오는 중…</div>;

  /* 하루에 전부 합쳐 얼마나 느는가 — 「이대로 두면 한 달 뒤」를 말하려고 */
  const perDayAll = rep.cats.reduce((a, c) => a + c.perDay, 0);

  return (
    <div className="dret">
      <div className="dret-top">
        <div>
          <b className="dret-total">{mb(rep.totalBytes)}</b>
          <span className="pt-n"> 쓰는 중</span>
          {perDayAll > 0 && <span className="pt-n"> · 하루 {mb(perDayAll)}씩</span>}
          {rep.disk && (
            <span className="pt-n">
              {" "}· 디스크 여유 {mb(rep.disk.free)} / {mb(rep.disk.total)}
            </span>
          )}
        </div>
        <button className="filter-btn" onClick={prune} disabled={busy || rep.prunableBytes === 0}>
          {busy
            ? "정리 중…"
            : rep.prunableBytes > 0
              ? `지금 정리 (−${mb(rep.prunableBytes)})`
              : "지금 설정으로는 지울 것 없음"}
        </button>
      </div>
      {/*
        「지울 것 없음」만 있으면 **다음에 뭘 해야 할지**를 말해 주지 않는다.
        지금 기준으로 얼마나 자랄지를 같이 적어 판단할 거리를 준다.
      */}
      {rep.prunableBytes === 0 && perDayAll > 0 && (
        <div className="table-note">
          지금 보관 기준으로는 지울 것이 없습니다. 이대로면 <b>한 달에 약{" "}
          {mb(perDayAll * 30)}</b>, <b>일 년에 약 {mb(perDayAll * 365)}</b> 늘어납니다 —
          아래 표의 기간 단추로 미리 줄여 둘 수 있습니다.
        </div>
      )}
      {msg && <div className="table-note">{msg}</div>}

      <div className="data-table-wrap">
        <table className="data-table dret-table">
          <thead>
            <tr>
              <th>갈래</th>
              <th className="num">지금</th>
              <th className="num">하루</th>
              <th>보관</th>
              <th>기간별로 줄이면</th>
            </tr>
          </thead>
          <tbody>
            {rep.cats.map((c) => (
              <tr key={c.key}>
                <td>
                  <b>{c.label}</b>
                  <div className="pt-n">{c.what}</div>
                  {c.oldest && (
                    <div className="pt-n">
                      {c.oldest} ~ {c.newest} · 파일 {c.files}개
                    </div>
                  )}
                  {KIND_NOTE[c.kind] && <div className="dret-warn">{KIND_NOTE[c.kind]}</div>}
                </td>
                <td className="num">{mb(c.bytes)}</td>
                <td className="num pt-n">{c.perDay > 0 ? mb(c.perDay) : "—"}</td>
                <td>
                  {c.kind === "daily" ? (
                    <select
                      className="ma-input"
                      style={{ width: "6.5rem" }}
                      value={c.keepDays === null ? "" : String(c.keepDays)}
                      onChange={async (e) => {
                        const v = e.target.value === "" ? null : Number(e.target.value);
                        setRep(await api.dataKeep(c.key, v));
                      }}
                    >
                      {CHOICES.map((x) => (
                        <option key={x.label} value={x.d === null ? "" : String(x.d)}>
                          {x.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="pt-n">—</span>
                  )}
                </td>
                {/*
                  기간별로 얼마가 빠지나. **숫자가 곧 단추다** — 눌러서 그 기간으로
                  정한다. 어느 후보로도 빠지는 게 없으면 그 사실을 한 줄로 말한다
                  (칸을 「—」로 비워 두면 「고장인가」로 읽힌다).
                */}
                <td>
                  {c.kind !== "daily" ? (
                    <span className="pt-n">—</span>
                  ) : BANDS.every((d) => freedAt(c.byAge, d) === 0) ? (
                    <span className="pt-n">
                      {c.bytes === 0 ? "쌓인 것 없음" : `전부 ${c.oldest ?? ""} 이후 — 줄여도 안 빠짐`}
                    </span>
                  ) : (
                    <div className="dret-bands">
                      {BANDS.map((d) => {
                        const f = freedAt(c.byAge, d);
                        return (
                          <button
                            key={d}
                            className={`dret-band${c.keepDays === d ? " on" : ""}`}
                            title={`${d}일만 남기면 ${mb(f)} 가 빠집니다`}
                            onClick={async () => setRep(await api.dataKeep(c.key, d))}
                          >
                            <em>{d === 365 ? "1년" : `${d}일`}</em>
                            <b className={f > 0 ? "negative" : ""}>{f > 0 ? `−${mb(f)}` : "0"}</b>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </td>
              </tr>
            ))}
            <tr>
              <td>
                <b>그 밖</b>
                <div className="pt-n">
                  일봉 캐시·테마 분류·관심종목처럼 <b>매번 덮어쓰는</b> 파일들. 이력이 없어
                  자를 것이 없습니다
                </div>
              </td>
              <td className="num">{mb(rep.otherBytes)}</td>
              <td className="num pt-n">—</td>
              <td>
                <span className="pt-n">—</span>
              </td>
              <td className="num pt-n">—</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="table-note">
        정리는 <b>6시간마다</b> 저절로 돕니다. 파일 이름의 날짜로만 자르므로, 이름에서
        날짜를 못 읽는 파일은 건드리지 않습니다.
      </div>
      <div className="table-note">
        ⚠️ <b>지운 날은 다시 만들 수 없습니다.</b> 신호등 점수·이벤트 로그는 그 시점에만
        계산되는 값이라 특히 그렇습니다. 실시간 로그는 크지만(하루 40MB 안팎) 지나간
        체결을 다시 볼 일은 드물어 기본을 30일로 두었습니다.
      </div>

      <details className="dret-move">
        <summary>저장 위치를 옮기려면 (용량을 더 붙였을 때)</summary>
        <div className="table-note">
          지금 위치: <code>{rep.dir}</code>
        </div>
        <div className="table-note">
          데이터 경로는 <b>서버 코드 67곳</b>이 저마다 들고 있어서, 설정에서 바꾸는
          단추를 다는 것은 그 전부를 손대는 일입니다. 위험 대비 얻는 것이 적어 그렇게
          하지 않았습니다. 대신 <b>폴더 자체를 옮기고 링크를 거는 쪽</b>이 안전하고
          결과가 같습니다 — 서버는 원래 자리로 알고 씁니다.
        </div>
        <pre className="dret-cmd">{`# 관리자 PowerShell에서 (서버를 먼저 끄세요)
Stop-Service vntg-hts        # 서비스로 돌리는 경우
Move-Item C:\\vntg-hts\\server\\data D:\\vntg-data
New-Item -ItemType Junction -Path C:\\vntg-hts\\server\\data -Target D:\\vntg-data
Start-Service vntg-hts`}</pre>
        <div className="table-note">
          옮긴 뒤 이 화면을 새로 열어 <b>디스크 여유</b>가 새 드라이브 값으로 바뀌었는지
          확인하세요. 안 바뀌었으면 링크가 안 걸린 것입니다.
        </div>
      </details>
    </div>
  );
}
