import { useEffect, useState } from "react";
import { api, fmtNum, signClass, type StockNote } from "../api";
import { StockTags } from "./StockTags";

/**
 * 종목 메모.
 *
 * 메모만 남기면 "무슨 생각이었는지"는 알아도 그 판단이 맞았는지 모른다.
 * 작성 시점의 가격을 함께 박아두고 현재가와 비교해 보여줘야 복기가 된다.
 */

function fmtWhen(iso: string): string {
  return new Date(iso).toLocaleString("ko-KR", {
    year: "2-digit",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function daysAgo(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400_000);
  if (days <= 0) return "오늘";
  if (days === 1) return "어제";
  return `${days}일 전`;
}

export function StockNotes({
  code,
  name,
  currentPrice,
}: {
  code: string;
  name: string;
  /** 현재가 — 메모 작성가 대비 수익률 계산용 */
  currentPrice?: number;
}) {
  const [notes, setNotes] = useState<StockNote[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);

  async function load() {
    try {
      setNotes((await api.notes(code)).notes);
    } catch (e) {
      setError(e instanceof Error ? e.message : "불러오기 실패");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  async function add() {
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      setNotes((await api.noteAdd(code, name, text)).notes);
      setText("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "저장 실패");
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit() {
    if (!editing) return;
    try {
      setNotes((await api.noteUpdate(code, editing.id, editing.text)).notes);
      setEditing(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "수정 실패");
    }
  }

  async function remove(id: string) {
    if (!window.confirm("이 메모를 삭제할까요?")) return;
    try {
      setNotes((await api.noteRemove(code, id)).notes);
    } catch (e) {
      setError(e instanceof Error ? e.message : "삭제 실패");
    }
  }

  return (
    <div className="notes">
    {/*
      **태그가 메모 위다** (2026-09-01).
    
      벤티지: "각 종목 상세에 메모 적잖아. 그 위에 #태그 칸 하나 두어서 태그를 적는 거지."
    
      종목을 보다가 「이건 로봇이네」 싶을 때 그 자리에서 붙일 수 있어야 한다 —
      별도 화면으로 가야 하면 안 하게 된다.
    */}
    <StockTags code={code} name={name} />
      {error && <div className="error-banner">{error}</div>}

      <div className="note-input">
        <textarea
          className="note-textarea"
          placeholder={`${name}에 대한 생각을 적어두세요. 지금 가격이 함께 기록됩니다.`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
        />
        <button className="filter-btn active" onClick={add} disabled={busy || !text.trim()}>
          {busy ? "저장 중…" : "메모 저장"}
        </button>
      </div>

      {notes.length === 0 && <div className="empty">아직 메모가 없습니다.</div>}

      <div className="note-list">
        {notes.map((n) => {
          // 그때 대비 지금 — 이 기능의 핵심
          const ret = currentPrice && n.price > 0 ? ((currentPrice - n.price) / n.price) * 100 : null;
          return (
            <div className="note-item" key={n.id}>
              <div className="note-head">
                <span className="note-when">
                  {fmtWhen(n.at)} <em>{daysAgo(n.at)}</em>
                </span>
                <span className="note-price">
                  작성가 <b>{n.price > 0 ? fmtNum(n.price) : "-"}</b>
                  <span className={signClass(n.changeRate)}>
                    {" "}
                    ({n.changeRate > 0 ? "+" : ""}
                    {n.changeRate.toFixed(2)}%)
                  </span>
                </span>
                {ret !== null && (
                  <span className={`note-return ${signClass(ret)}`}>
                    이후 {ret > 0 ? "+" : ""}
                    {ret.toFixed(2)}%
                  </span>
                )}
                <span className="note-actions">
                  <button className="row-del-btn" onClick={() => setEditing({ id: n.id, text: n.text })}>
                    수정
                  </button>
                  <button className="row-del-btn" onClick={() => remove(n.id)}>
                    ✕
                  </button>
                </span>
              </div>

              {editing?.id === n.id ? (
                <div className="note-edit">
                  <textarea
                    className="note-textarea"
                    value={editing.text}
                    onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                    rows={3}
                  />
                  <div className="ma-form-row">
                    <button className="filter-btn active" onClick={saveEdit}>
                      저장
                    </button>
                    <button className="filter-btn" onClick={() => setEditing(null)}>
                      취소
                    </button>
                  </div>
                </div>
              ) : (
                <div className="note-body">{n.text}</div>
              )}
            </div>
          );
        })}
      </div>

      <div className="table-note">
        메모를 저장할 때 그 시점의 주가가 함께 기록됩니다. 오른쪽 &apos;이후 %&apos;는 그때 대비 지금
        수익률이라 판단이 맞았는지 되돌아볼 수 있습니다. (작성가·시각은 수정해도 바뀌지 않습니다)
      </div>
    </div>
  );
}
