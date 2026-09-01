import { useEffect, useState } from "react";
import { api, type ScreenUniverse, type UniverseChoice } from "../api";

/**
 * **신호등 모집단 고르기** (2026-09-01).
 *
 * 벤티지: "신호등의 각 그룹군에 관해서 전부 설정으로 옮기는 거야. 신호등에 넣을 수
 * 있는 그룹을 내가 고르는 거고(체크박스 형태로 하면 될 듯), 고르고 나면 신호등
 * 찾기에서 그게 보이는 거지. 당연히 신호등 분석의 지금 돌리기는 신호등 찾기에서
 * 보이는 그룹군에 대해서만 돌아가는 거고. 그럼 신호등에 들어갈 그룹을 더 확장하기도
 * 편하잖아."
 *
 * ## 무엇이 문제였나
 *
 * 모집단이 코드에 고정 열셋이었고 **신호등 분석이 그걸 전부 돌았다** — 목록당
 * 500종목이라 40분이 걸렸다. 안 쓰는 목록까지 다 받는 셈이다.
 *
 * 그리고 기간이 코드에 박혀 있었다. 「외국인 순매수 상위」가 `dt:"1"` 이라
 * **진짜로 하루치**였는데, 그건 우리 실측 결론(「연속보다 기간별 누적」)과
 * 정면으로 어긋난다.
 *
 * ## 여기서 고른 것이 세 곳에 같이 반영된다
 *
 *   · 신호등 찾기 — 모집단 단추
 *   · 조건 검색 — 「어디서 찾나」
 *   · 신호등 분석(지금 돌리기) — 켠 목록만 돈다
 */

/** 기간 단추에 붙일 이름 — 「1일」이 왜 나쁜지 한 줄로 말해 준다 */
const SPAN_NOTE: Record<number, string> = {
  1: "하루치 — 그날 튄 것에 휘둘립니다",
  5: "한 주",
  10: "두 주",
  20: "한 달",
  60: "석 달",
};

export function UniversePanel() {
  const [catalog, setCatalog] = useState<ScreenUniverse[]>([]);
  const [items, setItems] = useState<UniverseChoice[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    void api
      .signalUniverseCatalog()
      .then((r) => {
        setCatalog(r.catalog);
        setItems(r.config.items);
      })
      .catch(() => undefined);
  }, []);

  const at = (key: string) => items.find((i) => i.key === key);

  const patch = (key: string, next: Partial<UniverseChoice>) => {
    setItems((p) => p.map((i) => (i.key === key ? { ...i, ...next } : i)));
    setDirty(true);
    setMsg(null);
  };

  async function save() {
    setBusy(true);
    try {
      const r = await api.signalUniverseSave(items);
      setItems(r.config.items);
      setDirty(false);
      const on = r.config.items.filter((i) => i.enabled).length;
      setMsg(`저장했습니다 — ${on}개 목록을 씁니다.`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "저장 실패");
    } finally {
      setBusy(false);
    }
  }

  if (catalog.length === 0) return <div className="table-note">불러오는 중…</div>;

  const on = items.filter((i) => i.enabled).length;

  return (
    <div className="uni">
      <p className="table-note">
        여기서 고른 목록이 <b>신호등 찾기 · 조건 검색 · 신호등 분석</b> 세 곳에 같이
        반영됩니다. 신호등 분석의 「지금 돌리기」는 <b>켠 목록만</b> 돕니다 — 목록당
        500종목이라, 열셋을 다 켜면 40분이 걸립니다.
      </p>

      <div className="uni-list">
        {catalog.map((u) => {
          const c = at(u.key);
          const enabled = c?.enabled !== false;
          return (
            <div className={`uni-row${enabled ? " on" : ""}`} key={u.key}>
              <label className="uni-head">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => patch(u.key, { enabled: e.target.checked })}
                />
                <b>{u.label}</b>
              </label>
              <div className="uni-hint">{u.hint}</div>
              {/*
                **기간은 목록이 허락한 것만** 보여 준다. 거래대금 상위처럼 기간
                개념이 없는 목록에 칸을 그리면, 눌러도 아무 일이 안 일어난다.
              */}
              {u.spans && u.spans.length > 0 && (
                <div className="filter-row uni-spans">
                  <span className="pt-n">기간</span>
                  {u.spans.map((sp) => (
                    <button
                      key={sp}
                      className={`filter-btn ${(c?.span ?? u.defaultSpan) === sp ? "active" : ""}`}
                      onClick={() => patch(u.key, { span: sp })}
                      disabled={!enabled}
                      title={SPAN_NOTE[sp] ?? ""}
                    >
                      {sp}일
                    </button>
                  ))}
                  {(c?.span ?? u.defaultSpan) === 1 && (
                    <span className="uni-warn">
                      ⚠️ 하루치는 그날 튄 것에 휘둘립니다 — 실측에서 「연속보다 기간별
                      누적」이 나았습니다
                    </span>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="filter-row uni-actions">
        <button
          className={`primary-btn${dirty ? " sig-save-need" : ""}`}
          onClick={() => void save()}
          disabled={busy}
        >
          {busy ? "저장 중…" : dirty ? "저장해야 반영됩니다" : "저장"}
        </button>
        <span className="pt-n">
          {on} / {catalog.length}개 켬
        </span>
        {msg && <span className="table-note">{msg}</span>}
      </div>
    </div>
  );
}
