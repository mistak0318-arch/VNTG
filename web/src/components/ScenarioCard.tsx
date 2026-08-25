import { useEffect, useMemo, useState } from "react";
import { api, fmtNum, type JournalTrade } from "../api";

/**
 * 진입 전 시나리오 카드 — 관심종목 상태를 「보유」로 바꾸는 관문 (2026-08-25).
 *
 * 1년 시뮬레이션의 결론이 「기록 기능이 돈을 벌었다」였다. 그런데 지금 기록은
 * 전부 **사후**다 — 복기 노트는 장 마감 뒤에 적는다. 제일 값진 기록은 사기 **전**의
 * 계획이다: 어디서 자르고(손절), 어디서 팔고(목표), 왜 사는가(근거). 그걸 안 적고
 * 산 매매가 뉴스 추격이 된다.
 *
 * 그래서 「보유」 버튼이 이 카드를 연다. 여기 적으면 **복기 노트의 오늘 매수**로
 * 저장된다 — 손절 감시(stopWatch)가 이 손절선을 물고, 근거 태그별 평균 R 통계에도
 * 들어간다. 별도 저장소가 아니라 이미 있는 기록 축에 꽂는 것이다.
 *
 * 강요는 하지 않는다 — 「기록 없이 표시만」 이 아래 작게 있다. 관문의 값은 강제가
 * 아니라 마찰이다: 한 번 더 생각하게 만드는 것.
 */

export function ScenarioCard({
  code,
  name,
  price,
  onDone,
  onSkip,
  onCancel,
}: {
  code: string;
  name: string;
  /** 지금 가격 — 단가 칸의 초기값 */
  price: number | null;
  /** 기록까지 저장하고 보유로 바꿨다 */
  onDone: () => void;
  /** 기록 없이 보유 표시만 */
  onSkip: () => void;
  onCancel: () => void;
}) {
  const [buyPrice, setBuyPrice] = useState(price !== null && price > 0 ? String(price) : "");
  const [qty, setQty] = useState("");
  const [stop, setStop] = useState("");
  const [target, setTarget] = useState("");
  const [note, setNote] = useState("");
  const [reasons, setReasons] = useState<string[]>([]);
  const [tags, setTags] = useState<{ key: string; label: string; hint: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .journal()
      .then((d) => setTags(d.reasonTags))
      .catch(() => undefined);
  }, []);

  const p = Number(buyPrice.replace(/,/g, ""));
  const s = Number(stop.replace(/,/g, ""));
  const t = Number(target.replace(/,/g, ""));
  /** 손익비 — 계획 단계에서 이 숫자가 1 아래면 산수부터 지는 자리다 */
  const rr = useMemo(() => {
    if (!(p > 0) || !(s > 0) || !(t > 0) || s >= p || t <= p) return null;
    return (t - p) / (p - s);
  }, [p, s, t]);

  async function save() {
    if (!(p > 0)) {
      setError("단가를 적어 주세요");
      return;
    }
    if (!(s > 0) || s >= p) {
      setError("손절선을 단가보다 낮게 적어 주세요 — 이 카드의 핵심입니다");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
      // 오늘 복기 노트를 받아 매수를 덧붙인다 — trades 는 통째로 보내야 안 지워진다
      const data = await api.journal();
      const prev = data.entries.find((e) => e.date === today);
      const trade: JournalTrade = {
        id: `sc_${Date.now().toString(36)}`,
        kind: "buy",
        code,
        name,
        price: p,
        qty: Number(qty.replace(/,/g, "")) || 0,
        note,
        reasons,
        stop: s,
        ...(t > 0 ? { target: t } : {}),
      };
      await api.journalSave({ date: today, trades: [...(prev?.trades ?? []), trade] });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "저장 실패");
      setSaving(false);
    }
  }

  return (
    <div className="overlay" onClick={onCancel}>
      <div className="sheet sc-card" onClick={(e) => e.stopPropagation()}>
        <div className="sc-head">
          <b>진입 시나리오 — {name}</b>
          <button className="sc-close" onClick={onCancel} aria-label="닫기">
            ✕
          </button>
        </div>
        <div className="sc-hint">
          사기 전에 적는 게 이 카드의 전부입니다. 여기 적으면 <b>복기 노트의 오늘 매수</b>로
          저장되고, 손절선은 <b>손절 감시</b>가 뭅니다.
        </div>

        <div className="sc-grid">
          <label>
            단가
            <input
              inputMode="numeric"
              value={buyPrice}
              onChange={(e) => setBuyPrice(e.target.value)}
              placeholder={price !== null ? fmtNum(price) : "매수가"}
            />
          </label>
          <label>
            수량
            <input inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="주" />
          </label>
          <label>
            손절선 <i className="sc-req">필수</i>
            <input inputMode="numeric" value={stop} onChange={(e) => setStop(e.target.value)} placeholder="어디서 자르나" />
          </label>
          <label>
            목표가
            <input inputMode="numeric" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="어디서 파나" />
          </label>
        </div>

        {rr !== null && (
          <div className={`sc-rr ${rr >= 2 ? "good" : rr >= 1 ? "mid" : "bad"}`}>
            손익비 <b>{rr.toFixed(1)} : 1</b>
            {rr < 1 && " — 얻을 것보다 잃을 것이 큽니다"}
          </div>
        )}

        {tags.length > 0 && (
          <div className="sc-tags">
            <span className="sc-tags-label">왜 사나</span>
            {tags.map((tag) => {
              const on = reasons.includes(tag.key);
              return (
                <button
                  key={tag.key}
                  type="button"
                  className={`jn-tag${on ? " on" : ""}`}
                  title={tag.hint}
                  onClick={() =>
                    setReasons(on ? reasons.filter((x) => x !== tag.key) : [...reasons, tag.key])
                  }
                >
                  {tag.label}
                </button>
              );
            })}
          </div>
        )}

        <textarea
          className="sc-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="시나리오 한 줄 — 무엇이 보이면 계획대로고, 무엇이 보이면 틀린 건가"
          rows={2}
        />

        {error && <div className="error-banner">{error}</div>}

        <div className="sc-actions">
          <button className="filter-btn active" onClick={() => void save()} disabled={saving}>
            {saving ? "저장 중…" : "기록하고 보유로"}
          </button>
          <button className="sc-skip" onClick={onSkip}>
            기록 없이 표시만
          </button>
        </div>
      </div>
    </div>
  );
}
