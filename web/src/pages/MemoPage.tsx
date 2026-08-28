import { useCallback, useEffect, useState } from "react";
import { api, type MemoEntry, type MemoFile } from "../api";

/**
 * 메모장 (2026-08-26) — **메모장 + 일기장.**
 *
 * 복기 노트는 매매의 복기이고 종목 메모는 종목에 붙는 짧은 글이다. 그 어디에도
 * 안 붙는 생각 — 추적 관찰 중인 종목, 추세 가설, 시장 일기, 배운 것 — 이 갈 곳이
 * 없어서 만들었다.
 *
 * 구조는 왼쪽 목록 / 오른쪽 편집기. **찾기가 핵심**이라 검색과 태그 필터를
 * 목록 머리에 뒀다 — 적기만 하고 못 찾는 메모장은 결국 안 쓰게 된다.
 *
 * 틀(템플릿)은 강요가 아니라 **시작 문장**이다. 빈 화면 앞에서 뭘 적을지
 * 망설이는 시간이 제일 길다 — 버튼 하나로 골격을 깔고 채우기만 한다.
 */

const TEMPLATES: { tag: string; label: string; body: string }[] = [
  {
    tag: "추적관찰",
    label: "👀 추적 관찰 종목",
    body: "종목: \n지금 자리(가격·추세): \n왜 지켜보나: \n들어갈 조건(트리거): \n관두는 조건(무효): \n",
  },
  {
    tag: "추세",
    label: "🌊 추세 가설",
    body: "무엇이 움직이나: \n왜 그렇게 보나(근거): \n맞다면 보일 신호: \n틀렸다면 보일 신호: \n언제 다시 점검: \n",
  },
  {
    tag: "일기",
    label: "📅 시장 일기",
    body: "오늘 시장 한 줄: \n눈에 띈 것: \n내 판단과 그 이유: \n내일 볼 것: \n",
  },
  {
    tag: "교훈",
    label: "💡 배운 것",
    body: "상황: \n배운 것: \n다음엔 어떻게: \n",
  },
  {
    tag: "아이디어",
    label: "⚡ 매매 아이디어",
    body: "아이디어 한 줄: \n어떤 조건에서 사나: \n얼마에 자르나(손절): \n어디까지 보나(목표): \n",
  },
];

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}.${two(d.getMonth() + 1)}.${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** 편집 중인 글 — id 가 없으면 새 글이다 */
interface Draft {
  id: string | null;
  title: string;
  body: string;
  tags: string;
  pinned: boolean;
}

const EMPTY: Draft = { id: null, title: "", body: "", tags: "", pinned: false };

export function MemoPage() {
  const [items, setItems] = useState<MemoEntry[]>([]);
  const [tags, setTags] = useState<{ tag: string; count: number }[]>([]);
  const [q, setQ] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (query: string, tag: string) => {
    try {
      const [l, t] = await Promise.all([api.memoList(query, tag), api.memoTags()]);
      setItems(l.items);
      setTags(t.tags);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "불러오지 못했습니다");
    }
  }, []);

  // 검색은 300ms 눌러서 — 한 글자마다 서버를 부르면 목록이 덜컹인다
  useEffect(() => {
    const t = setTimeout(() => void load(q, tagFilter), q ? 300 : 0);
    return () => clearTimeout(t);
  }, [q, tagFilter, load]);

  function openMemo(m: MemoEntry) {
    if (dirty && !window.confirm("저장하지 않은 내용이 있습니다. 버리고 이동할까요?")) return;
    setDraft({ id: m.id, title: m.title, body: m.body, tags: m.tags.join(", "), pinned: m.pinned });
    setDirty(false);
  }

  function newMemo(tpl?: (typeof TEMPLATES)[number]) {
    if (dirty && !window.confirm("저장하지 않은 내용이 있습니다. 버리고 새 글을 쓸까요?")) return;
    setDraft({
      id: null,
      title: tpl ? `${tpl.label.replace(/^\S+\s/, "")} — ` : "",
      body: tpl ? tpl.body : "",
      tags: tpl ? tpl.tag : "",
      pinned: false,
    });
    setDirty(Boolean(tpl));
  }

  /** 이미 글을 쓰는 중이면 틀을 **본문 끝에 잇는다** — 지우고 새로 시작하지 않는다 */
  function appendTemplate(tpl: (typeof TEMPLATES)[number]) {
    if (!draft.body.trim() && !draft.title.trim() && draft.id === null) {
      newMemo(tpl);
      return;
    }
    setDraft((d) => ({
      ...d,
      body: d.body ? `${d.body.replace(/\n*$/, "")}\n\n${tpl.body}` : tpl.body,
      tags: d.tags.includes(tpl.tag) ? d.tags : d.tags ? `${d.tags}, ${tpl.tag}` : tpl.tag,
    }));
    setDirty(true);
  }

  async function save() {
    if (!draft.title.trim() && !draft.body.trim()) return;
    setBusy(true);
    try {
      const tagList = draft.tags.split(",").map((t) => t.trim()).filter(Boolean);
      if (draft.id === null) {
        const r = await api.memoAdd(draft.title, draft.body, tagList);
        setDraft((d) => ({ ...d, id: r.memo.id }));
      } else {
        await api.memoUpdate(draft.id, { title: draft.title, body: draft.body, tags: tagList });
      }
      setDirty(false);
      await load(q, tagFilter);
    } catch (e) {
      setError(e instanceof Error ? e.message : "저장 실패");
    } finally {
      setBusy(false);
    }
  }

  async function togglePin(m: MemoEntry) {
    try {
      await api.memoUpdate(m.id, { pinned: !m.pinned });
      await load(q, tagFilter);
    } catch {
      /* 고정 실패는 조용히 — 다음 클릭에 다시 시도된다 */
    }
  }

  async function remove() {
    if (draft.id === null) {
      setDraft(EMPTY);
      setDirty(false);
      return;
    }
    if (!window.confirm("이 메모를 삭제할까요? 되돌릴 수 없습니다.")) return;
    setBusy(true);
    try {
      await api.memoRemove(draft.id);
      setDraft(EMPTY);
      setDirty(false);
      await load(q, tagFilter);
    } catch (e) {
      setError(e instanceof Error ? e.message : "삭제 실패");
    } finally {
      setBusy(false);
    }
  }

  const set = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setDirty(true);
  };

  return (
    <div className="memo">
      {error && <div className="error-banner">{error}</div>}

      <div className="memo-grid">
        {/* ── 왼쪽: 찾기 + 목록 ── */}
        <section className="memo-list">
          <input
            className="search-input"
            type="text"
            inputMode="search"
            placeholder="제목·내용·태그로 찾기"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <div className="filter-row memo-tags">
            <button
              className={`filter-btn ${tagFilter === "" ? "active" : ""}`}
              onClick={() => setTagFilter("")}
            >
              전체
            </button>
            {tags.map((t) => (
              <button
                key={t.tag}
                className={`filter-btn ${tagFilter === t.tag ? "active" : ""}`}
                onClick={() => setTagFilter(tagFilter === t.tag ? "" : t.tag)}
              >
                #{t.tag} <i className="memo-cnt">{t.count}</i>
              </button>
            ))}
          </div>

          <button className="refresh-btn memo-new" onClick={() => newMemo()}>
            ✍️ 새 메모
          </button>

          {items.length === 0 ? (
            <div className="empty">
              {q || tagFilter ? "찾는 메모가 없습니다." : "아직 메모가 없습니다 — 오른쪽 틀 버튼으로 시작해 보세요."}
            </div>
          ) : (
            <div className="memo-rows">
              {items.map((m) => (
                <button
                  key={m.id}
                  className={`memo-row${draft.id === m.id ? " on" : ""}`}
                  onClick={() => openMemo(m)}
                >
                  <span className="memo-row-head">
                    <i
                      className={`memo-pin${m.pinned ? " on" : ""}`}
                      title={m.pinned ? "고정 해제" : "맨 위에 고정"}
                      onClick={(e) => {
                        e.stopPropagation();
                        void togglePin(m);
                      }}
                    >
                      📌
                    </i>
                    <b>{m.title || "(제목 없음)"}</b>
                  </span>
                  {/* 첫 줄 미리보기 — 제목만으로 못 찾는 글이 태반이다 */}
                  {m.body && <span className="memo-prev">{m.body.slice(0, 80)}</span>}
                  <span className="memo-meta">
                    {fmtDate(m.updatedAt)}
                    {/* 붙임이 있으면 목록에서 바로 보인다 — 없으면 열어 봐야 안다 */}
                    {(m.files?.length ?? 0) > 0 && <i className="memo-clip">📎{m.files!.length}</i>}
                    {m.tags.map((t) => (
                      <i key={t}>#{t}</i>
                    ))}
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>

        {/* ── 오른쪽: 편집기 ── */}
        <section className="memo-editor">
          <div className="filter-row memo-tpl">
            {TEMPLATES.map((t) => (
              <button
                key={t.tag}
                className="filter-btn"
                onClick={() => appendTemplate(t)}
                title="틀을 본문에 넣습니다 — 쓰던 글이 있으면 끝에 이어 붙습니다"
              >
                {t.label}
              </button>
            ))}
          </div>
          <input
            className="search-input memo-title"
            type="text"
            placeholder="제목"
            value={draft.title}
            onChange={(e) => set({ title: e.target.value })}
          />
          <textarea
            className="memo-body"
            placeholder={"내용 — 자유롭게. 위 틀 버튼을 누르면 골격이 깔립니다."}
            value={draft.body}
            onChange={(e) => set({ body: e.target.value })}
          />
          <input
            className="search-input memo-taginput"
            type="text"
            placeholder="태그 (쉼표로 구분 — 예: 추적관찰, 2차전지)"
            value={draft.tags}
            onChange={(e) => set({ tags: e.target.value })}
          />
          {/*
            붙임 파일 — **저장된 메모에만** 붙는다. 새 글은 아직 id 가 없어서
            파일을 매달 곳이 없다. 그래서 저장 전에는 안내만 띄운다.
          */}
          <MemoFiles
            memo={items.find((m) => m.id === draft.id) ?? null}
            onChanged={() => void load(q, tagFilter)}
          />

          <div className="memo-actions">
            <button
              className="refresh-btn"
              onClick={() => void save()}
              disabled={busy || (!draft.title.trim() && !draft.body.trim())}
            >
              {busy ? "저장 중…" : dirty ? "저장" : draft.id ? "저장됨 ✓" : "저장"}
            </button>
            {(draft.id !== null || draft.title || draft.body) && (
              <button className="filter-btn" onClick={() => void remove()} disabled={busy}>
                {draft.id === null ? "비우기" : "🗑 삭제"}
              </button>
            )}
            {draft.id !== null && (
              <span className="memo-saved-at">
                작성 {fmtDate(items.find((m) => m.id === draft.id)?.at ?? "")}
              </span>
            )}
          </div>
        </section>
      </div>

      <div className="table-note">
        복기 노트(매매 복기)·종목 메모와 별개인 <b>자유 메모장</b>입니다. 태그와 검색으로
        다시 찾습니다 — 「추적관찰」 태그를 붙여 두면 나중에 그 칩 하나로 관찰 목록이 됩니다.
        저장은 서버 파일이라 PC·폰 어디서든 같은 내용이 보입니다.
      </div>
    </div>
  );
}

/**
 * 메모 붙임 파일 — 올리기·미리보기·내려받기.
 *
 * ## 미리보기를 왜 붙이나
 *
 * 차트 캡처를 붙여 놓고 「그때 그 그림」을 다시 보려는 것이 이 기능의 목적인데,
 * 파일 이름만 늘어놓으면 **하나하나 내려받아 열어 봐야** 한다. 그러면 안 보게 된다.
 * 이미지는 바로 펴 두고, PDF·영상은 눌렀을 때 그 자리에서 연다.
 *
 * ## 저장된 메모에만 붙는다
 *
 * 새 글은 아직 id 가 없어서 파일을 매달 곳이 없다 — 먼저 저장하라고 적어 둔다.
 */
function MemoFiles({ memo, onChanged }: { memo: MemoEntry | null; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /** 크게 볼 파일 — PDF·영상은 시트에서 연다 */
  const [open, setOpen] = useState<MemoFile | null>(null);

  if (!memo) {
    return (
      <div className="memo-files empty">
        <span className="pt-n">
          📎 파일을 붙이려면 <b>먼저 저장</b>하세요 — 이미지·PDF·영상을 넣어 둘 수 있습니다.
        </span>
      </div>
    );
  }

  async function upload(list: FileList | null) {
    if (!list || !memo) return;
    setBusy(true);
    setErr(null);
    try {
      for (const f of Array.from(list)) await api.memoFileAdd(memo.id, f);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "올리지 못했습니다");
    } finally {
      setBusy(false);
    }
  }

  const files = memo.files ?? [];
  const isImg = (f: MemoFile) => f.mime.startsWith("image/");
  const isVid = (f: MemoFile) => f.mime.startsWith("video/");
  const isPdf = (f: MemoFile) => f.mime === "application/pdf";

  return (
    <div className="memo-files">
      <div className="memo-files-head">
        <label className="filter-btn">
          📎 파일 붙이기
          <input
            type="file"
            multiple
            hidden
            disabled={busy}
            onChange={(e) => {
              void upload(e.target.files);
              e.target.value = ""; // 같은 파일을 다시 골라도 이벤트가 오게
            }}
          />
        </label>
        {busy && <span className="pt-n">올리는 중…</span>}
        {files.length > 0 && <span className="pt-n">{files.length}개</span>}
      </div>
      {err && <div className="error-banner">{err}</div>}

      {files.length > 0 && (
        <div className="memo-file-grid">
          {files.map((f) => (
            <div className="memo-file" key={f.id}>
              {/* 이미지는 **펴 둔다** — 그러려고 붙이는 것이다 */}
              {isImg(f) ? (
                <button className="memo-file-thumb" onClick={() => setOpen(f)} title={f.name}>
                  <img src={api.memoFileUrl(memo.id, f.id, true)} alt={f.name} loading="lazy" />
                </button>
              ) : (
                <button className="memo-file-thumb icon" onClick={() => setOpen(f)} title={f.name}>
                  <span>{isPdf(f) ? "📄" : isVid(f) ? "🎬" : "📦"}</span>
                </button>
              )}
              <div className="memo-file-foot">
                <span className="memo-file-name" title={f.name}>
                  {f.name}
                </span>
                <span className="pt-n">{(f.size / 1024 / 1024).toFixed(1)}MB</span>
                <a
                  className="memo-file-dl"
                  href={api.memoFileUrl(memo.id, f.id)}
                  title="내려받기"
                >
                  ⤓
                </a>
                <button
                  className="memo-file-x"
                  title="지우기"
                  onClick={() => {
                    if (!window.confirm(`「${f.name}」 을 지울까요?`)) return;
                    void api.memoFileRemove(memo.id, f.id).then(onChanged);
                  }}
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 크게 보기 — 이미지·PDF·영상을 그 자리에서 연다 */}
      {open && (
        <div className="overlay" onClick={() => setOpen(null)}>
          <div className="sheet memo-viewer" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-header">
              <h2>{open.name}</h2>
              <a className="filter-btn" href={api.memoFileUrl(memo.id, open.id)}>
                ⤓ 받기
              </a>
              <button className="close-btn" onClick={() => setOpen(null)}>
                ✕
              </button>
            </div>
            {isImg(open) ? (
              <img className="memo-view-img" src={api.memoFileUrl(memo.id, open.id, true)} alt={open.name} />
            ) : isVid(open) ? (
              <video className="memo-view-vid" src={api.memoFileUrl(memo.id, open.id, true)} controls />
            ) : isPdf(open) ? (
              <iframe className="memo-view-pdf" src={api.memoFileUrl(memo.id, open.id, true)} title={open.name} />
            ) : (
              <div className="page-note">
                미리보기를 만들 수 없는 형식입니다 — <b>⤓ 받기</b>로 내려받아 여세요.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
