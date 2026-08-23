import { useEffect, useRef, useState } from "react";
import { removePref, setPref } from "../prefs";
import { api, type ParsedEvent, type VisionModelOption } from "../api";

/**
 * 이미지에서 일정 가져오기.
 *
 * 증권사 리포트 캡처나 카톡으로 받은 일정표를 그대로 올리면 날짜·제목을 뽑는다.
 *
 * **뽑은 걸 바로 넣지 않는다.** 이미지 인식은 틀릴 수 있고, 틀린 일정이 조용히 들어가면
 * 나중에 그게 틀린 줄도 모른 채 그 날짜를 믿게 된다.
 * 그래서 뽑기 → 확인(체크 해제로 제외) → 추가, 세 단계로 나눴다.
 */

const KIND_LABEL: Record<string, string> = {
  market: "증시 일정",
  earnings: "실적 발표",
  holiday: "휴장일",
  personal: "개인 일정",
};

const PROVIDER_LABEL: Record<string, string> = {
  gemini: "Gemini",
  openai: "OpenAI",
  anthropic: "Claude",
};

/** 파일을 base64로. data: 접두사는 떼서 보낸다 */
function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(new Error("파일을 읽지 못했습니다"));
    reader.readAsDataURL(file);
  });
}

export function CalendarImageImport({ onImported }: { onImported?: () => void }) {
  const [ready, setReady] = useState(true);
  const [models, setModels] = useState<VisionModelOption[]>([]);
  // 어떤 모델이 자기 자료에 맞는지는 써봐야 안다. 고른 걸 기억해둔다.
  const [chosen, setChosen] = useState<string>(
    () => localStorage.getItem("vntg.calendar.visionModel") ?? "",
  );
  const [preview, setPreview] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [events, setEvents] = useState<ParsedEvent[]>([]);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api
      .calendarVisionStatus()
      .then((r) => {
        setReady(r.ready);
        setModels(r.models);
        // 저장해둔 모델이 더 이상 못 쓰는 것이면(키를 뺐다든지) 첫 번째로 되돌린다
        setChosen((prev) =>
          r.models.some((m) => m.model === prev) ? prev : (r.models[0]?.model ?? ""),
        );
      })
      .catch(() => setReady(false));
  }, []);

  async function pickFile(file: File) {
    if (!file.type.startsWith("image/")) {
      setNote("이미지 파일만 올릴 수 있습니다.");
      return;
    }
    // 큰 이미지는 그대로 보내면 토큰도 늘고 요청도 무거워진다
    if (file.size > 8 * 1024 * 1024) {
      setNote("8MB 이하 이미지만 올릴 수 있습니다.");
      return;
    }

    setBusy("parse");
    setNote(null);
    setEvents([]);
    setFileName(file.name);
    setPreview(URL.createObjectURL(file));

    try {
      const base64 = await toBase64(file);
      const picked = models.find((m) => m.model === chosen);
      const r = await api.calendarVisionParse(base64, file.type, picked?.provider, picked?.model);
      setEvents(r.events);
      setPicked(new Set(r.events.map((_, i) => i)));
      if (r.events.length === 0) {
        setNote(r.error ?? "일정을 찾지 못했습니다.");
      } else {
        setNote(
          `${r.events.length}건 인식 · ${PROVIDER_LABEL[r.provider ?? ""] ?? r.provider} ${r.model} · 토큰 ${r.inputTokens}/${r.outputTokens}`,
        );
      }
    } catch (err) {
      setNote(err instanceof Error ? err.message : "분석 실패");
    } finally {
      setBusy(null);
    }
  }

  async function commit() {
    const chosen = events.filter((_, i) => picked.has(i));
    if (chosen.length === 0) return;
    setBusy("commit");
    try {
      const r = await api.calendarVisionCommit(chosen, fileName);
      setNote(`${r.added}건을 캘린더에 추가했습니다.`);
      setEvents([]);
      setPreview(null);
      setFileName("");
      if (inputRef.current) inputRef.current.value = "";
      onImported?.();
    } catch (err) {
      setNote(err instanceof Error ? err.message : "추가 실패");
    } finally {
      setBusy(null);
    }
  }

  function toggle(i: number) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  function patch(i: number, next: Partial<ParsedEvent>) {
    setEvents((prev) => prev.map((e, idx) => (idx === i ? { ...e, ...next } : e)));
  }

  if (!ready) {
    return (
      <div className="page-note">
        <b>이미지 분석 키가 설정되지 않았습니다.</b>
        <br />
        <code>server/.env</code> 에 아래 중 하나를 넣으면 됩니다. 위에 있는 것일수록 저렴합니다.
        <br />
        <code>GEMINI_API_KEY</code> (aistudio.google.com) ·<code> OPENAI_API_KEY</code> ·
        <code> ANTHROPIC_API_KEY</code>
        <br />
        이미지 한 장 분석은 Gemini 기준 약 $0.0015 입니다.
      </div>
    );
  }

  return (
    <div className="cal-image">
      <div className="filter-row">
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="cal-image-input"
          disabled={busy !== null}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void pickFile(f);
          }}
        />
        {busy === "parse" && <span className="breadth-count">분석 중…</span>}
      </div>

      {models.length > 0 && (
        <div className="filter-row cal-model-row">
          <label className="cal-model-label">
            분석 모델
            <select
              className="group-select"
              value={chosen}
              disabled={busy !== null}
              onChange={(e) => {
                setChosen(e.target.value);
                setPref("vntg.calendar.visionModel", e.target.value);
              }}
            >
              {models.map((m) => (
                <option key={m.model} value={m.model}>
                  {PROVIDER_LABEL[m.provider] ?? m.provider} · {m.label}
                </option>
              ))}
            </select>
          </label>
          <span className="breadth-count">
            {models.find((m) => m.model === chosen)?.hint ?? ""}
          </span>
        </div>
      )}

      {note && <div className="alert-note">{note}</div>}

      {preview && (
        <img className="cal-image-preview" src={preview} alt="업로드한 이미지 미리보기" />
      )}

      {events.length > 0 && (
        <>
          <h3 className="section-heading">
            인식된 일정 {events.length}건 · 추가할 것 {picked.size}건
          </h3>
          <div className="cal-parsed">
            {events.map((e, i) => (
              <div className={`cal-parsed-row${picked.has(i) ? "" : " off"}`} key={i}>
                <input type="checkbox" checked={picked.has(i)} onChange={() => toggle(i)} />
                <input
                  className="cal-parsed-date"
                  type="date"
                  value={e.date}
                  onChange={(ev) => patch(i, { date: ev.target.value })}
                />
                <input
                  className="cal-parsed-title"
                  value={e.title}
                  onChange={(ev) => patch(i, { title: ev.target.value })}
                />
                <select
                  className="cal-parsed-kind"
                  value={e.kind}
                  onChange={(ev) => patch(i, { kind: ev.target.value })}
                >
                  {Object.entries(KIND_LABEL).map(([k, label]) => (
                    <option key={k} value={k}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>

          <div className="sig-config-actions">
            <button className="primary-btn" onClick={commit} disabled={busy !== null || picked.size === 0}>
              {busy === "commit" ? "추가 중…" : `${picked.size}건 캘린더에 추가`}
            </button>
            <button
              className="filter-btn"
              disabled={busy !== null}
              onClick={() => {
                setEvents([]);
                setPreview(null);
                setNote(null);
              }}
            >
              취소
            </button>
          </div>

          <div className="table-note">
            인식이 틀릴 수 있으니 <b>날짜와 제목을 확인하고 추가하세요.</b> 표에서 바로 고칠 수
            있고, 체크를 풀면 그 항목은 들어가지 않습니다. 결과가 엉성하면 위에서{" "}
            <b>더 좋은 모델로 바꿔 다시 올려보세요</b> — 표가 복잡하거나 손글씨면 저렴한 모델이
            날짜를 밀려 읽는 경우가 있습니다.
          </div>
        </>
      )}
    </div>
  );
}
