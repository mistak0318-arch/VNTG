import { useRef, useState } from "react";
import { api, fmtNum, type EvaluatedAccount, type ManualImportPlan } from "../api";

/**
 * **수동계좌를 CSV 로 한꺼번에** (2026-10-07 — 벤티지: "증권사 캡쳐해서 AI로 해당 양식에 맞춰서 csv
 * 만들어달라 하고 업로드 할게").
 *
 * 캘린더가 이미 쓰는 길 그대로다 — **양식을 내려받아 AI 에게 주고, 채워 온 파일을 올린다.**
 * 다른 점 하나: 계좌는 돈이 걸린 자리라 **올리자마자 덮지 않는다.** 먼저 「무엇이 바뀌는지」를 받아 보여 주고,
 * 사람이 보고 나서 「적용」을 눌러야 들어간다. 잘못 만든 파일 하나로 계좌가 통째로 뒤집히면 안 된다.
 */

/** 양식 — **파서가 읽는 꼴 그대로**여야 한다. 양식과 파서가 어긋나면 사람이 고생한다 */
function downloadTemplate(): void {
  const lines = [
    "# VNTG 수동계좌 가져오기 양식",
    "#",
    "# 증권사 앱 화면을 캡처해서 AI 에게 「이 CSV 양식대로 채워 줘」라고 하면 됩니다.",
    "# 계좌는 「증권사 + 계좌이름」으로 구분합니다 — 없는 계좌면 새로 만듭니다.",
    "# 수량·평단가·예수금은 숫자만 봅니다(1,234 처럼 쉼표가 있어도, 「70,000원」처럼 단위가 붙어도 읽습니다).",
    "# 예수금은 그 계좌에 한 번만 적으면 됩니다. 종목 없이 예수금만 적은 줄도 됩니다.",
    "# 아래 예시 두 줄은 지우고 쓰세요.",
    "증권사,계좌이름,종목코드,종목명,수량,평단가,예수금",
    "키움증권,연금저축,005930,삼성전자,10,70000,1500000",
    "키움증권,연금저축,000660,SK하이닉스,5,180000,",
  ];
  /* 엑셀이 한글을 깨지 않게 BOM 을 붙인다 — 캘린더 양식과 같은 처방 */
  const blob = new Blob([`﻿${lines.join("\n")}\n`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "VNTG_수동계좌_양식.csv";
  a.click();
  URL.revokeObjectURL(url);
}

export function ManualImportPanel({ onApplied }: { onApplied: (accounts: EvaluatedAccount[]) => void }) {
  const [open, setOpen] = useState(false);
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState("");
  const [mode, setMode] = useState<"merge" | "replace">("merge");
  const [plan, setPlan] = useState<ManualImportPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function pick(file: File) {
    setErr(null);
    setMsg(null);
    setPlan(null);
    setFileName(file.name);
    const text = await file.text();
    setCsv(text);
    await preview(text, mode);
  }

  async function preview(text: string, m: "merge" | "replace") {
    if (!text.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.manualImport(text, m, true);
      setPlan(r.plan);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "읽지 못했습니다");
      setPlan(null);
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!csv.trim() || !plan) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.manualImport(csv, mode, false);
      if (r.accounts) onApplied(r.accounts);
      const n = r.plan.accounts.reduce((s, a) => s + a.add.length + a.update.length, 0);
      const d = r.plan.accounts.reduce((s, a) => s + a.remove.length, 0);
      setMsg(`✓ ${r.plan.accounts.length}개 계좌에 ${n}종목 반영${d > 0 ? ` · ${d}종목 뺌` : ""}`);
      setPlan(null);
      setCsv("");
      setFileName("");
      if (fileRef.current) fileRef.current.value = "";
    } catch (e) {
      setErr(e instanceof Error ? e.message : "적용하지 못했습니다");
    } finally {
      setBusy(false);
    }
  }

  const total = plan
    ? plan.accounts.reduce((s, a) => s + a.add.length + a.update.length + a.remove.length, 0)
    : 0;

  return (
    <section className="card mi">
      <h3 className="section-heading">
        <button type="button" className="mi-toggle" onClick={() => setOpen((v) => !v)}>
          {open ? "▾" : "▸"} CSV 로 한꺼번에 넣기
        </button>
        <i className="pt-n">증권사 화면을 캡처해 AI 에게 양식대로 시키면 됩니다</i>
      </h3>
      {open && (
        <div className="mi-body">
          <div className="mi-row">
            <button type="button" className="filter-btn" onClick={downloadTemplate}>
              ① 양식 내려받기
            </button>
            <label className="filter-btn mi-file">
              ② 파일 고르기
              <input
                ref={fileRef}
                type="file"
                accept=".csv,text/csv,text/plain"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void pick(f);
                }}
              />
            </label>
            {fileName && <span className="pt-n">{fileName}</span>}
          </div>

          <div className="mi-row">
            <span className="pt-n">넣는 방식</span>
            {([
              ["merge", "적힌 것만 더하기·고치기", "파일에 없는 종목은 그대로 둡니다"],
              ["replace", "이 파일과 똑같이 맞추기", "파일에 없는 종목은 계좌에서 뺍니다 — 증권사 화면을 그대로 옮길 때"],
            ] as const).map(([k, label, why]) => (
              <button
                key={k}
                type="button"
                className={`filter-btn ${mode === k ? "active" : ""}`}
                title={why}
                onClick={() => {
                  setMode(k);
                  if (csv) void preview(csv, k);
                }}
              >
                {label}
              </button>
            ))}
          </div>

          {busy && <div className="page-note">읽는 중…</div>}
          {err && <div className="error-banner">{err}</div>}
          {msg && <div className="alert-note">{msg}</div>}

          {plan && (
            <div className="mi-plan">
              <div className="mi-plan-h">
                바뀌는 것 — 계좌 {plan.accounts.length}개 · 종목 {total}건
                {plan.skipped.length > 0 && <em className="negative"> · 건너뛴 줄 {plan.skipped.length}</em>}
              </div>
              {plan.accounts.map((a) => (
                <div key={`${a.broker}|${a.name}`} className="mi-acc">
                  <b>
                    {a.broker} · {a.name}
                  </b>
                  {a.isNew && <em className="mi-new">새 계좌</em>}
                  {a.cash !== null && <span className="pt-n"> 예수금 {fmtNum(a.cash)}</span>}
                  <ul className="mi-list">
                    {a.add.map((h) => (
                      <li key={`a${h.code}`}>
                        <em className="positive">추가</em> {h.name} <span className="pt-n">{h.code}</span> · {fmtNum(h.qty)}주 ·{" "}
                        {fmtNum(h.avgPrice)}
                      </li>
                    ))}
                    {a.update.map((h) => (
                      <li key={`u${h.code}`}>
                        <em>변경</em> {h.name} <span className="pt-n">{h.code}</span> · {fmtNum(h.wasQty)}→
                        <b>{fmtNum(h.qty)}</b>주 · {fmtNum(h.wasAvg)}→<b>{fmtNum(h.avgPrice)}</b>
                      </li>
                    ))}
                    {a.remove.map((h) => (
                      <li key={`r${h.code}`}>
                        <em className="negative">뺌</em> {h.name} <span className="pt-n">{h.code}</span> · {fmtNum(h.qty)}주
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {plan.skipped.length > 0 && (
                <details className="mi-skip">
                  <summary>건너뛴 줄 {plan.skipped.length}개 — 왜 그런지</summary>
                  <ul>
                    {plan.skipped.slice(0, 20).map((s) => (
                      <li key={s.line}>
                        {s.line}줄: {s.why} <span className="pt-n">{s.text}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              <div className="mi-row">
                <button type="button" className="filter-btn active" onClick={() => void apply()} disabled={busy || total === 0}>
                  ③ 이대로 적용
                </button>
                <button type="button" className="filter-btn" onClick={() => { setPlan(null); setCsv(""); setFileName(""); if (fileRef.current) fileRef.current.value = ""; }}>
                  취소
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
