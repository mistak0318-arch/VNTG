import { useEffect, useRef, useState } from "react";
import { api, type StockTag } from "../api";

/**
 * **종목 태그** (2026-09-01) — 메모 바로 위.
 *
 * 벤티지: "내 테마라는 이름을 태그라는 이름으로 바꿀까? 각 종목 상세에 메모
 * 적잖아. 그 위에 #태그 칸 하나 두어서 태그를 적는 거지. 그 태그가 자동으로
 * 그룹이 돼서 태그 그룹으로 들어가고 — 마치 테마를 내가 태그로 만드는 거야."
 * "태그 있는 애들은 그 태그 집단의 등락률을 옆에 표시해주고."
 *
 * ## 왜 메모 옆인가
 *
 * 종목을 보다가 「아 이건 로봇이네」 싶을 때 **그 자리에서** 붙일 수 있어야 한다.
 * 별도 화면(테마 만들기)으로 가야 하면 안 하게 된다 — 실제로 스물여덟 개를 만든
 * 뒤로 잘 안 늘었다.
 *
 * ## 자동완성이 본체다
 *
 * `#반도` 를 치면 「반도체」·「반도체 소부장 (전공정)」이 뜬다. 이게 없으면
 * 「반도체」·「반도체장비」·「반도체_소부장」이 따로 생겨서 **같은 뜻의 그룹이
 * 셋**이 된다. 태그 체계가 망하는 건 대부분 이것 때문이라, 자동완성은 곁다리가
 * 아니라 이 기능의 절반이다.
 *
 * ## 등락률을 같이 보여 준다
 *
 * 이름만 있으면 그냥 꼬리표다. 「로봇 −3.14% (14종목)」이라야 **지금 그 무리가
 * 어떤지**가 한눈에 온다 — 태그를 붙이는 이유가 거기 있다.
 *
 * 저장소는 「내 테마」(`customThemes`)와 **같은 것**이다. 태그 이름이 테마 이름이고
 * 그 태그가 붙은 종목이 구성종목이다 — 두 벌로 두면 한쪽에서 지운 게 다른 쪽에
 * 남는다.
 */

const f2 = (v: number | null): string =>
  v === null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;

export function StockTags({ code, name }: { code: string; name: string }) {
  const [tags, setTags] = useState<StockTag[]>([]);
  const [q, setQ] = useState("");
  const [hints, setHints] = useState<{ name: string; count: number }[]>([]);
  const [open, setOpen] = useState(false);
  /**
   * 펼친 태그 — 구성종목을 보여 준다 (2026-09-01).
   *
   * 벤티지: "각 태그 클릭하면 담겨진 종목하고 나와줘야지. 테마 클릭하는 것처럼."
   *
   * 종목은 이미 받아 뒀다(`StockTag.stocks`) — 누를 때 또 부르면 그 사이 빈
   * 목록이 잠깐 보인다.
   */
  const [openTag, setOpenTag] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  const load = () => {
    void api
      .stockTags(code)
      .then((r) => setTags(r.tags))
      .catch(() => setTags([]));
  };

  useEffect(load, [code]);

  /*
   * 후보는 **칠 때마다** 받는다. 목록이 수십 개라 서버가 파일 하나를 읽는 값이고,
   * 사람이 치는 속도보다 빠르다. 디바운스를 넣으면 오히려 한 박자 늦게 뜬다.
   */
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void api
      .tagSuggest(q)
      .then((r) => {
        if (alive) setHints(r.tags);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [q, open, tags.length]);

  /* 바깥을 누르면 닫는다 — 후보 목록이 떠 있는 채로 다른 걸 누르면 가린다 */
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  async function add(tagName: string) {
    const clean = tagName.replace(/^#/, "").trim();
    if (!clean) return;
    setBusy(true);
    setErr(null);
    try {
      await api.tagAdd(code, clean);
      setQ("");
      load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "붙이기 실패");
    } finally {
      setBusy(false);
    }
  }

  async function drop(tagName: string) {
    setBusy(true);
    try {
      await api.tagRemove(code, tagName);
      load();
    } catch {
      /* 실패해도 목록만 그대로 — 다음에 다시 누르면 된다 */
    } finally {
      setBusy(false);
    }
  }

  /** 이미 붙은 것은 후보에서 뺀다 — 눌러도 아무 일이 안 일어나면 고장으로 보인다 */
  const mine = new Set(tags.map((t) => t.name));
  const fresh = hints.filter((h) => !mine.has(h.name));
  /** 완전히 새 이름인가 — 그러면 「만들기」를 보여 준다 */
  const isNew =
    q.replace(/^#/, "").trim().length > 0 &&
    !hints.some((h) => h.name === q.replace(/^#/, "").trim()) &&
    !mine.has(q.replace(/^#/, "").trim());

  return (
    <div className="stag" ref={box}>
      <div className="stag-row">
        <span className="stag-label">#태그</span>

        {tags.map((t) => (
          <span
            className={`stag-chip ${t.rate === null ? "" : t.rate > 0 ? "up" : t.rate < 0 ? "down" : ""}${openTag === t.name ? " on" : ""}`}
            key={t.name}
            title={`${t.name} — ${t.count}종목, 시총 가중평균 ${f2(t.rate)}
눌러서 구성종목 보기`}
            onClick={() => setOpenTag((p) => (p === t.name ? null : t.name))}
            role="button"
          >
            <i className="stag-dot" style={{ background: t.color }} />
            {t.name}
            {/*
              **등락률이 이름 옆에 붙는다.** 이름만 있으면 꼬리표일 뿐이고,
              「로봇 −3.14%」라야 지금 그 무리가 어떤지가 한눈에 온다.
            */}
            <b className="stag-rate">{f2(t.rate)}</b>
            <i className="stag-n">{t.count}</i>
            <button
              className="stag-x"
              onClick={(e) => {
                /* 칩을 누르면 펴지므로, ✕ 는 그 위로 안 번지게 막는다 */
                e.stopPropagation();
                void drop(t.name);
              }}
              title="이 태그를 뗍니다"
            >
              ✕
            </button>
          </span>
        ))}

        <span className="stag-input-wrap">
          <input
            className="stag-input"
            value={q}
            placeholder={tags.length === 0 ? `#태그 — ${name} 을(를) 뭐라 부를까요` : "#추가"}
            onChange={(e) => {
              setQ(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                /* 후보가 하나면 그걸로 — 오타로 새 태그가 생기는 것을 막는다 */
                void add(fresh.length === 1 && !isNew ? fresh[0].name : q);
              } else if (e.key === "Escape") {
                setOpen(false);
              }
            }}
            disabled={busy}
          />

          {open && (fresh.length > 0 || isNew) && (
            <div className="stag-hints">
              {isNew && (
                <button className="stag-hint new" onClick={() => void add(q)}>
                  + <b>{q.replace(/^#/, "").trim()}</b> 새로 만들기
                </button>
              )}
              {fresh.map((h) => (
                <button className="stag-hint" key={h.name} onClick={() => void add(h.name)}>
                  {h.name}
                  <i className="stag-n">{h.count}</i>
                </button>
              ))}
            </div>
          )}
        </span>
      </div>

      {/*
        **구성종목** — 칩을 누르면 편다. 테마 MAP 에서 타일을 누르는 것과 같은 결이다.
        종목을 누르면 그 종목으로 간다 — 태그로 묶어 놓고 그 안을 도는 게 이 기능의 값이다.
      */}
      {openTag && (
        <div className="stag-sheet">
          {(() => {
            const t = tags.find((x) => x.name === openTag);
            if (!t) return null;
            const rows = [...t.stocks].sort((a, b) => b.changeRate - a.changeRate);
            return (
              <>
                <div className="stag-sheet-head">
                  <b>{t.name}</b>
                  <span className={t.rate !== null && t.rate > 0 ? "positive" : "negative"}>
                    {f2(t.rate)}
                  </span>
                  <span className="pt-n">{t.count}종목</span>
                  <button className="stag-x" onClick={() => setOpenTag(null)}>
                    ✕
                  </button>
                </div>
                <div className="stag-stocks">
                  {rows.map((x) => (
                    <a
                      className="stag-stock"
                      key={x.code}
                      href={`#/stock/${x.code}`}
                      title={`${x.name} (${x.code})`}
                    >
                      <span className="stag-stock-n">{x.name}</span>
                      <b className={x.changeRate > 0 ? "positive" : x.changeRate < 0 ? "negative" : ""}>
                        {x.changeRate > 0 ? "+" : ""}
                        {x.changeRate.toFixed(2)}%
                      </b>
                    </a>
                  ))}
                </div>
              </>
            );
          })()}
        </div>
      )}

      {err && <div className="stag-err">{err}</div>}

      {tags.length === 0 && (
        <div className="stag-note">
          태그를 붙이면 <b>같은 태그끼리 묶여 하나의 무리</b>가 됩니다 — 테마·업종 MAP 의
          「내 태그」와 테마 DB 에서 그 무리의 등락률·구성종목을 볼 수 있습니다.
          네이버 테마와 달리 <b>내가 그때 붙인 것</b>이라, 나중에 「내가 8월에 로봇이라
          부른 종목들이 어땠나」를 정직하게 물을 수 있습니다.
        </div>
      )}
    </div>
  );
}
