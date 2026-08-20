import { useCallback, useEffect, useState } from "react";
import { api, type EventPlayResult, type EvaluatedTheme } from "../api";

/**
 * 일정 매매 — **일정을 보고 미리 들어가서, 일정 즈음에 나온다.**
 *
 * 주도주 탐색기의 형제다. 탐색기가 「지금 무엇이 강한가」라면 이건
 * **「다음에 무엇이 강해질 자리인가」**다 — 이미 오른 걸 훑어서는 안 나온다.
 *
 * 성적을 재는 축이 다르다. 다른 추적기는 편입 후 1·5·20일을 세지만 여기는
 * **일정일(D0)을 0으로 놓고 앞뒤**를 본다. 물음이 이것이기 때문이다 —
 * **「소문에 사서 뉴스에 판다」가 내 종목에도 맞나?**
 */

function pct(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "-";
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function cls(v: number | null): string {
  if (v === null || !Number.isFinite(v) || v === 0) return "";
  return v > 0 ? "positive" : "negative";
}

export function EventPlayPanel() {
  const [plays, setPlays] = useState<EventPlayResult[]>([]);
  const [themes, setThemes] = useState<EvaluatedTheme[]>([]);
  const [loading, setLoading] = useState(false);
  const [tracked, setTracked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<{ date: string; title: string; note: string; themeIds: string[] }>(
    { date: "", title: "", note: "", themeIds: [] },
  );

  const loadList = useCallback(async () => {
    try {
      const r = await api.eventPlays();
      setPlays(r.plays.map((p) => ({ ...p, themes: [], upcoming: false })));
      setTracked(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "불러오지 못했습니다");
    }
  }, []);

  useEffect(() => {
    void loadList();
    api.customThemes().then((r) => setThemes(r.themes)).catch(() => setThemes([]));
  }, [loadList]);

  /*
   * 성적은 **눌렀을 때만** 받는다. 테마 구성종목마다 일봉을 받아야 해서
   * 몇 십 초 걸린다 — 일정을 적으러 온 날에도 매번 기다리게 하면 안 된다.
   */
  const track = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.eventPlaysTrack();
      setPlays(r.plays);
      setTracked(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "추적 실패");
    } finally {
      setLoading(false);
    }
  }, []);

  async function submit() {
    try {
      await api.eventPlaySave(form);
      setForm({ date: "", title: "", note: "", themeIds: [] });
      setAdding(false);
      await loadList();
    } catch (e) {
      setError(e instanceof Error ? e.message : "저장 실패");
    }
  }

  return (
    <div className="ep">
      <HowTo />

      <div className="filter-row">
        <button className="primary-btn" onClick={() => setAdding((v) => !v)}>
          {adding ? "닫기" : "+ 일정 담기"}
        </button>
        <button className="filter-btn" onClick={() => void track()} disabled={loading}>
          {loading ? "일봉 받는 중…" : tracked ? "성적 다시" : "성적 보기"}
        </button>
        <span className="pt-n">담은 일정 {plays.length}건</span>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {adding && (
        <section className="card">
          <h2>일정 담기</h2>
          <div className="st-cfg-row">
            <span className="st-cfg-k">일정일</span>
            <input
              type="date"
              value={form.date}
              onChange={(e) => setForm({ ...form, date: e.target.value })}
            />
          </div>
          <div className="st-cfg-row">
            <span className="st-cfg-k">무슨 일정</span>
            <input
              type="text"
              className="ep-wide"
              placeholder="예: 트럼프 한국 방한 / 체코 원전 수주 발표"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />
          </div>
          <div className="st-cfg-row">
            <span className="st-cfg-k">왜 이 테마인가</span>
            <input
              type="text"
              className="ep-wide"
              placeholder="나중에 읽을 사람은 나다 — 그때의 생각을 적는다"
              value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
            />
          </div>
          <div className="st-cfg-row">
            <span className="st-cfg-k">반응할 테마</span>
            <span className="ep-themes">
              {themes.length === 0 ? (
                <span className="pt-n">「내 테마」가 없습니다. 먼저 만들어 주세요.</span>
              ) : (
                themes.map((t) => (
                  <button
                    key={t.id}
                    className={`filter-btn ${form.themeIds.includes(t.id) ? "active" : ""}`}
                    onClick={() =>
                      setForm({
                        ...form,
                        themeIds: form.themeIds.includes(t.id)
                          ? form.themeIds.filter((x) => x !== t.id)
                          : [...form.themeIds, t.id],
                      })
                    }
                  >
                    {t.name}
                  </button>
                ))
              )}
            </span>
          </div>
          <div className="st-cfg-note">
            <b>「내 테마」로만 고를 수 있습니다.</b> 증권사 분류로는 「원전」·「조선」처럼
            일정에 반응하는 묶음이 안 나옵니다 — 내가 정한 묶음이어야 뜻이 있습니다.
          </div>
          <div className="filter-row">
            <button className="primary-btn" onClick={() => void submit()}>
              담기
            </button>
          </div>
        </section>
      )}

      {plays.length === 0 ? (
        <div className="page-note">
          아직 담은 일정이 없습니다. <b>+ 일정 담기</b>로 앞으로 올 일정과 거기 반응할 테마를
          미리 짝지어 두세요. 지난 일정을 넣어 <b>되짚어 보는 것</b>도 됩니다 — 그게 더 빨리
          배웁니다.
        </div>
      ) : (
        plays.map((p) => <PlayCard key={p.id} p={p} tracked={tracked} onChanged={loadList} />)
      )}
    </div>
  );
}

/** 매매기법 설명 — 접어 둔다. 펴 두면 화면만 길어진다 */
function HowTo() {
  return (
    <details className="ep-howto">
      <summary>일정 매매란 — 어떻게 쓰나</summary>
      <div className="ep-howto-body">
        <p>
          <b>일정이 먼저 있고, 거기 반응할 섹터를 미리 고르는 방식</b>입니다.
        </p>
        <ul>
          <li>원전주 ← 두산에너빌리티 체코 수주</li>
          <li>조선주 ← 트럼프 한국 방한</li>
        </ul>
        <p>
          신호등이나 주도주 탐색기로는 이게 안 걸립니다. 그것들은 <b>이미 오른 것</b>을 훑기
          때문입니다. 일정 매매는 <b>오르기 전에</b> 자리를 잡습니다.
        </p>

        <h4>왜 성적을 D0 기준으로 재나</h4>
        <p>
          다른 추적기는 「편입 후 1·5·20일」을 셉니다. 여기서 그러면 안 됩니다. 물어야 할 건
          이것이니까요 —
        </p>
        <p className="ep-q">
          <b>「소문에 사서 뉴스에 판다」가 내 종목에도 맞나?</b>
        </p>
        <p>
          그래서 <b>일정일을 0으로 놓고 앞뒤</b>를 봅니다. D-20 부터 올라와 D0 에 꺾이면 그
          격언이 내 시장에서도 사실이라는 증거고, <b>그날 팔았어야</b> 했다는 뜻입니다.
          반대로 D0 이후에 더 오른다면 나는 <b>너무 일찍 팔고 있었다</b>는 뜻입니다.
        </p>
        <p>
          기준(100)은 <b>D-1 종가</b>입니다. 「일정 직전에 샀다면」이 가장 흔한 실제 행동이라
          그게 읽기 쉽습니다.
        </p>

        <h4>이렇게 쓰세요</h4>
        <ol>
          <li>
            <b>지난 일정부터 넣어 보세요.</b> 작년에 실제로 매매했던 것을 되짚으면, 조건을
            짐작이 아니라 <b>내 실적에서</b> 뽑아낼 수 있습니다.
          </li>
          <li>앞으로 올 일정을 캘린더에서 보고 미리 담아 둡니다.</li>
          <li>
            일정이 지난 뒤 <b>성적 보기</b>로 곡선을 확인합니다. 「런업」과 「일정 후」를
            견주면 언제 나왔어야 했는지가 보입니다.
          </li>
        </ol>
        <p className="ep-warn">
          <b>이 앱은 주문을 넣지 않습니다.</b> 매매는 직접 하시고 기록은 복기 노트에
          남기세요 — 그래야 「내 판단 추적」이 같이 셉니다.
        </p>
      </div>
    </details>
  );
}

function PlayCard({
  p,
  tracked,
  onChanged,
}: {
  p: EventPlayResult;
  tracked: boolean;
  onChanged: () => void;
}) {
  return (
    <section className="card ep-play">
      <div className="ep-play-h">
        <b className="ep-play-t">{p.title}</b>
        <span className="pt-n">{p.date}</span>
        {p.upcoming && <span className="ls-badge ok">예정</span>}
        <button
          className="row-del-btn"
          onClick={() => void api.eventPlayRemove(p.id).then(onChanged)}
          title="지우기"
        >
          ✕
        </button>
      </div>
      {p.note && <div className="ep-play-note">“{p.note}”</div>}

      {!tracked ? (
        <div className="page-note">
          위 <b>성적 보기</b>를 누르면 테마 곡선을 채웁니다.
        </div>
      ) : p.themes.length === 0 ? (
        <div className="page-note">연결된 테마가 없거나 일봉을 받지 못했습니다.</div>
      ) : (
        p.themes.map((t) => (
          <div className="ep-theme" key={t.themeId}>
            <div className="ep-theme-h">
              <b>{t.themeName}</b>
              <span className="pt-n">{t.members}종목</span>
              <span title="일정 전 최고 상승 (D-20~D-1)">
                런업 <b className={cls(t.runUp)}>{pct(t.runUp)}</b>
              </span>
              <span title="일정 이후 마지막 값">
                일정 후 <b className={cls(t.after)}>{pct(t.after)}</b>
              </span>
              {/* 이게 이 화면의 결론이다 — 그날 팔았어야 했나 */}
              {t.peakedAtEvent !== null && (
                <span className={`ls-badge ${t.peakedAtEvent ? "warn" : "ok"}`}>
                  {t.peakedAtEvent ? "일정일이 고점" : "일정 후에도 상승"}
                </span>
              )}
            </div>
            <div className="ep-curve">
              {t.points.map((pt) => (
                <div className="ep-pt" key={pt.offset}>
                  <span className="ep-pt-x">
                    {pt.offset === 0 ? "D0" : pt.offset > 0 ? `+${pt.offset}` : pt.offset}
                  </span>
                  <span className={`ep-pt-v ${cls(pt.rate)}`}>{pct(pt.rate)}</span>
                </div>
              ))}
            </div>
          </div>
        ))
      )}
      <div className="table-note">
        기준(100)은 <b>D-1 종가</b>입니다. 곡선은 테마 구성종목의 <b>단순평균</b>이라
        「이 묶음이 함께 움직였나」를 봅니다 — 대형주 하나가 대표하면 그건 테마가 아닙니다.
      </div>
    </section>
  );
}
