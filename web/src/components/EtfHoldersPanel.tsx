import { useEffect, useState } from "react";
import { api, fmtNum, type EtfHolder } from "../api";

/**
 * 담은 ETF (2026-08-27) — **이 종목을 편입한 ETF 들.**
 *
 * 「이 종목이 어느 묶음에 속하나」를 업종·테마와 나란히 답하는 자리다. ETF 는 그중
 * 실제로 돈이 들어오는 묶음이라, 어떤 ETF 가 얼마나 담았는지가 수급의 배경이 된다.
 * 큰 ETF 에 크게 담겼으면 그 ETF 로 들어온 돈이 이 종목을 같이 산다.
 *
 * ## 어디서 오나
 *
 * 「종목 → 담은 ETF」는 어느 API 에도 없어서(실측 확인) 서버가 **하루 한 번 뒤집어**
 * 인덱스를 만든다(거래대금 상위 ETF 150곳의 구성종목). 여기서는 그 파일을 읽을 뿐이라
 * 조회가 0회다.
 *
 * ⚠️ 원천이 **Top10 구성종목**이라, 담겨 있어도 비중이 낮으면 안 잡힌다.
 * 「없음」이 「안 담겼음」이 아니라는 걸 화면이 말한다.
 */

function pct(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "-";
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function cls(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v) || v === 0) return "";
  return v > 0 ? "positive" : "negative";
}

export function EtfHoldersPanel({
  code,
  name,
  onSelectStock,
}: {
  code: string;
  name: string;
  onSelectStock?: (code: string, name: string) => void;
}) {
  const [data, setData] = useState<{ holders: EtfHolder[]; builtAt: string; scanned: number } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setData(null);
    api
      .etfHolders(code)
      .then((r) => alive && setData(r))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [code]);

  if (error) return <div className="error-banner">{error}</div>;
  if (!data) return <div className="empty">불러오는 중…</div>;

  if (data.holders.length === 0) {
    return (
      <div className="page-note">
        {data.builtAt ? (
          <>
            거래대금 상위 <b>{data.scanned}개 ETF</b>의 주요 구성종목(Top10)에서 「{name}」을
            찾지 못했습니다. 원천이 <b>Top10 만</b> 주므로, 담겨 있어도 비중이 낮으면 여기
            안 나옵니다 — <b>「없음」이 「안 담겼음」은 아닙니다.</b>
          </>
        ) : (
          <>
            ETF 보유 인덱스가 아직 만들어지지 않았습니다 — 서버가 하루 한 번(장 마감 뒤)
            거래대금 상위 ETF 를 훑어 만듭니다.
          </>
        )}
      </div>
    );
  }

  /* 이 종목에 걸린 ETF 자금의 크기 — 비중 × 순자산의 합 (얼마나 이 종목을 떠받치나) */
  const linked = data.holders.reduce(
    (a, h) => a + (h.aumRaw > 0 && h.weight ? (h.aumRaw * h.weight) / 100 : 0),
    0,
  );

  return (
    <div>
      <div className="etfw-sum">
        <span>
          담은 ETF <b>{data.holders.length}</b>곳
        </span>
        {linked > 0 && (
          <span title="각 ETF 의 순자산 × 편입비중을 더한 값 — 이 종목에 걸린 ETF 자금">
            연결 자금 <b>{fmtNum(Math.round(linked / 100_000_000))}억</b>
          </span>
        )}
        <span className="pt-n">비중 큰 순</span>
      </div>

      <div className="data-table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>ETF</th>
              <th title="이 ETF 안에서 이 종목이 차지하는 비중">편입비중</th>
              <th title="ETF 순자산총액 — 클수록 그 ETF 로 들어오는 돈이 이 종목을 많이 산다">순자산</th>
              <th>당일</th>
              <th>1주</th>
              <th>1개월</th>
              <th>3개월</th>
              <th>추적지수</th>
            </tr>
          </thead>
          <tbody>
            {data.holders.map((h) => (
              <tr
                key={h.code}
                className="clickable"
                onClick={() => onSelectStock?.(h.code, h.name)}
                title="ETF 상세로"
              >
                <td className="sticky-col">
                  <b>{h.name}</b> <span className="pt-n">{h.code}</span>
                </td>
                <td className="num strong-col">
                  {h.weight === null ? "-" : `${h.weight.toFixed(2)}%`}
                </td>
                <td className="num">{h.aum || "-"}</td>
                <td className={`num ${cls(h.changeRate)}`}>{pct(h.changeRate)}</td>
                <td className={`num ${cls(h.w1)}`}>{pct(h.w1)}</td>
                <td className={`num ${cls(h.m1)}`}>{pct(h.m1)}</td>
                <td className={`num ${cls(h.m3)}`}>{pct(h.m3)}</td>
                <td className="pt-n">{h.index}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="table-note">
        거래대금 상위 <b>{data.scanned}개 ETF</b>의 <b>주요 구성종목(Top10)</b>을 뒤집어
        만든 목록입니다 — 담겨 있어도 비중이 낮으면 안 잡히니 <b>여기 없다고 안 담긴 건
        아닙니다</b>. 편입비중이 크고 순자산이 큰 ETF 일수록 그 ETF 로 들어온 돈이 이
        종목을 많이 삽니다. 인덱스 갱신:{" "}
        {data.builtAt ? new Date(data.builtAt).toLocaleString("ko-KR") : "-"} (하루 1회)
      </div>
    </div>
  );
}
