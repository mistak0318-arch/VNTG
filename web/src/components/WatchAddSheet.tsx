import { useEffect, useState } from "react";
import { api, type WatchItem } from "../api";
import { useWatchedCodes } from "../useWatchedCodes";

/**
 * 관심종목 담기 — 어느 그룹에 넣을지 고른다.
 *
 * 예전엔 별을 누르면 그냥 담겼다. 그룹이 하나뿐이면 그게 맞지만, 그룹을 나눠 쓰기
 * 시작하면 **담은 뒤에 옮겨야 해서** 그 일을 안 하게 된다. 결국 전부 기본 그룹에 쌓인다.
 * 키움 HTS 가 담을 때 그룹을 묻는 이유가 그것이다.
 *
 * 그룹이 하나도 없으면 묻지 않고 바로 담는다 — 고를 게 없는데 창을 띄우는 건 방해다.
 * 그건 이 컴포넌트를 여는 쪽(openWatchAdd)이 판단한다.
 */
export interface WatchAddTarget {
  code: string;
  name: string;
  /** 편입가 — 안 주면 담는 쪽에서 현재가를 받아 채운다 */
  addedPrice: number;
}

export function WatchAddSheet({
  target,
  onClose,
  onDone,
}: {
  target: WatchAddTarget;
  onClose: () => void;
  onDone?: () => void;
}) {
  const [groups, setGroups] = useState<string[]>([]);
  const [items, setItems] = useState<WatchItem[]>([]);
  /** 여러 그룹에 동시에 담는다 — 한 종목은 성격이 하나가 아니다 */
  const [picked, setPicked] = useState<string[]>([]);
  const [memo, setMemo] = useState("");
  const [newGroup, setNewGroup] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const watched = useWatchedCodes();

  useEffect(() => {
    Promise.all([api.watchGroups(), api.watchlist()])
      .then(([g, w]) => {
        setGroups(g.groups);
        setItems(w.items);
        setPicked(g.groups[0] ? [g.groups[0]] : []);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  /** 그룹마다 몇 개 담겨 있는지 — 키움처럼 옆에 세워 두면 고르기 쉽다 */
  const countOf = (g: string) => items.filter((i) => (i.groups ?? []).includes(g)).length;

  async function addGroup() {
    const name = newGroup.trim();
    if (!name || groups.includes(name)) return;
    setError(null);
    try {
      const r = await api.watchGroupAdd(name);
      setGroups(r.groups);
      setPicked((p) => [...p, name]);
      setNewGroup("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "그룹 추가 실패");
    }
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.watchlistAdd({
        code: target.code,
        name: target.name,
        addedPrice: target.addedPrice,
        memo: memo.trim() || undefined,
        groups: picked,
      });
      watched.markAdded(target.code);
      onDone?.();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "담기 실패");
      setBusy(false);
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="sheet wa-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-header">
          <h2>
            관심종목 담기
            <span className="sheet-sub">
              {target.name} ({target.code})
            </span>
          </h2>
          <button className="close-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        {error && <div className="error-banner">{error}</div>}

        <p className="page-note">
          담을 그룹을 <b>여러 개</b> 고를 수 있습니다 — 한 종목은 성격이 하나가 아닙니다.
          편입가는 <b>{target.addedPrice.toLocaleString("ko-KR")}원</b>(지금
          가격)으로 기록되고, 그때부터 수익률이 추적됩니다.
        </p>

        <div className="wa-groups">
          {groups.length === 0 && (
            <div className="empty">그룹이 없습니다. 아래에서 먼저 만들어 주세요.</div>
          )}
          {groups.map((g) => (
            <button
              key={g}
              className={`wa-group${picked.includes(g) ? " on" : ""}`}
              onClick={() =>
                setPicked((p) => (p.includes(g) ? p.filter((x) => x !== g) : [...p, g]))
              }
            >
              <span className="wa-check">{picked.includes(g) ? "☑" : "☐"}</span>
              <span className="wa-group-name">{g}</span>
              <span className="wa-group-count">{countOf(g)}종목</span>
            </button>
          ))}
        </div>

        <div className="filter-row">
          <input
            className="pt-input"
            placeholder="새 그룹 이름"
            value={newGroup}
            onChange={(e) => setNewGroup(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void addGroup()}
          />
          <button className="filter-btn" onClick={() => void addGroup()} disabled={!newGroup.trim()}>
            + 그룹 추가
          </button>
        </div>

        <input
          className="pt-input wide"
          style={{ marginTop: 8 }}
          placeholder="메모 — 왜 담는지 한 줄 (비워도 됩니다)"
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
        />

        <div className="filter-row" style={{ marginTop: 10 }}>
          <button className="algo-run-btn" onClick={() => void submit()} disabled={busy}>
            {busy
              ? "담는 중…"
              : picked.length === 0
                ? "담기 (기본 그룹)"
                : picked.length === 1
                  ? `「${picked[0]}」에 담기`
                  : `${picked.length}개 그룹에 담기`}
          </button>
          <button className="filter-btn" onClick={onClose}>
            취소
          </button>
        </div>
      </div>
    </div>
  );
}
