import { useEffect, useState } from "react";
import { api, type BuzzConfig } from "../api";

/**
 * 버즈·키워드 알고리즘 설정 (2026-08-30 요청).
 *
 * ## 값 하나가 규칙 넷을 대신한다
 *
 * 예전 문턱은 「6건 이상 **그리고** 3배 이상, **또는** 3건 이상 **그리고** 8배 이상」
 * 이었다. 값 네 개를 눈대중으로 맞춘 것이라, 하나를 건드리면 나머지와 어긋났다.
 *
 * 지금은 **뜻밖의 정도** 하나로 판정한다:
 *
 *     z = (지금 − 평소) / √(평소 + 1)
 *
 * 드문 사건의 건수는 푸아송을 따르고 그 표준편차가 √평소다. 즉 z 는 「평균에서
 * 몇 표준편차 벗어났나」다. 배수와 달리 **표본 크기를 함께 본다** —
 * 「0.5건이 2건(4배)」과 「10건이 40건(4배)」을 같은 것으로 취급하지 않는다.
 *
 * 옛 규칙 둘이 갈리던 지점을 재 보니 z=2.31 과 z=2.24 였다. 두 규칙은 사실
 * **한 숫자를 서툴게 근사한 것**이었고, 그래서 기본값이 2.2 다.
 *
 * ## 여기서 바꾸면 두 화면이 같이 바뀐다
 *
 * 텔레그램 버즈와 뉴스 키워드 흐름이 **같은 자**를 쓴다. 자가 다르면 「채널에서는
 * 잡혔는데 뉴스에서는 안 잡힌」 것이 진짜 차이인지 설정 차이인지 알 수 없다.
 */

const PRESETS: { label: string; hint: string; patch: Partial<BuzzConfig> }[] = [
  {
    label: "느슨하게",
    hint: "z 1.6 — 조짐까지 본다. 잔챙이가 섞인다",
    patch: { zMin: 1.6, minCount: 2 },
  },
  {
    label: "기본",
    hint: "z 2.2 — 예전 규칙 둘이 갈리던 지점",
    patch: { zMin: 2.2, minCount: 3 },
  },
  {
    label: "엄격하게",
    hint: "z 3.2 — 확실한 것만. 조용한 날이 많아진다",
    patch: { zMin: 3.2, minCount: 5 },
  },
];

export function BuzzConfigPanel() {
  const [cfg, setCfg] = useState<BuzzConfig | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .buzzConfig()
      .then(setCfg)
      .catch((e: Error) => setErr(e.message));
  }, []);

  const save = async (patch: Partial<BuzzConfig>) => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      setCfg(await api.buzzConfigSave(patch));
      setMsg("저장했습니다 — 다음 판정부터 적용됩니다");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "저장 실패");
    } finally {
      setBusy(false);
    }
  };

  if (!cfg) return <div className="empty">{err ?? "불러오는 중…"}</div>;

  return (
    <div className="login-set">
      <p className="login-set-note">
        텔레그램 <b>🌋 버즈</b>와 뉴스 <b>🔮 키워드 흐름</b>이 이 값을 함께 씁니다. 자가
        다르면 「채널에선 잡혔는데 뉴스에선 안 잡힌」 것이 진짜 차이인지 설정 차이인지
        알 수 없기 때문입니다.
      </p>

      <h4 className="login-set-h">얼마나 예민하게</h4>
      <div className="kwf-wins" style={{ marginBottom: 10 }}>
        {PRESETS.map((p) => (
          <button
            key={p.label}
            className={Math.abs(cfg.zMin - (p.patch.zMin ?? 0)) < 0.05 ? "on" : ""}
            disabled={busy}
            onClick={() => void save(p.patch)}
            title={p.hint}
          >
            {p.label}
          </button>
        ))}
      </div>
      <Slider
        label="급증 문턱 (z)"
        value={cfg.zMin}
        min={0.5}
        max={6}
        step={0.1}
        busy={busy}
        onDone={(v) => void save({ zMin: v })}
        note={
          <>
            평균에서 <b>몇 표준편차</b> 벗어나야 「급증」으로 볼지. 낮추면 조짐까지
            잡히고 높이면 확실한 것만 남습니다. 참고로 <b>2.2</b> 는 예전 규칙
            「6건·3배」(z 2.31)와 「3건·8배」(z 2.24)가 갈리던 지점입니다.
          </>
        }
      />
      <Slider
        label="최소 건수"
        value={cfg.minCount}
        min={1}
        max={20}
        step={1}
        busy={busy}
        onDone={(v) => void save({ minCount: v })}
        note="아무리 뜻밖이어도 이 건수 미만이면 안 울립니다 — 1~2건은 아직 흐름이 아닙니다."
      />

      <h4 className="login-set-h">출처가 갈릴수록 믿는다</h4>
      <p className="login-set-note">
        <b>한 방(매체)이 같은 말을 열 번 한 것</b>과 <b>열 곳이 한 번씩 한 것</b>은
        완전히 다른 사건입니다. 앞은 그곳의 버릇이고 뒤는 시장의 화제입니다. 그래서
        점수에 출처 다양성을 곱합니다.
      </p>
      <Slider
        label="온전한 점수를 받는 출처 수"
        value={cfg.fullSources}
        min={1}
        max={8}
        step={1}
        busy={busy}
        onDone={(v) => void save({ fullSources: v })}
        note="이만큼 갈리면 깎지 않습니다. 1로 두면 다양성을 아예 안 봅니다."
      />
      <Slider
        label="한 곳에서만 나왔을 때 가중치"
        value={cfg.singleSourcePenalty}
        min={0.1}
        max={1}
        step={0.05}
        busy={busy}
        onDone={(v) => void save({ singleSourcePenalty: v })}
        note="0.5면 절반으로 깎습니다. 1이면 안 깎습니다."
      />

      <h4 className="login-set-h">무엇을 「평소」로 볼지</h4>
      <Slider
        label="기준선 일수"
        value={cfg.baselineDays}
        min={2}
        max={30}
        step={1}
        busy={busy}
        onDone={(v) => void save({ baselineDays: v })}
        note="길수록 안정적이지만 최근 변화에 둔해집니다. 7일이 무난합니다."
      />
      <Slider
        label="버즈 판정 창 (시간)"
        value={cfg.buzzWindowHours}
        min={1}
        max={48}
        step={1}
        busy={busy}
        onDone={(v) => void save({ buzzWindowHours: v })}
        note="텔레그램 알림이 되짚는 시간. 화면에서 고르는 창과는 별개입니다."
      />

      <div className="login-set-row" style={{ marginTop: 14 }}>
        <div>
          <b>시간대 보정</b>
          <span className="login-set-hint">
            채널도 뉴스도 하루 내내 고르지 않습니다 — 새벽은 조용하고 아침은 시끄럽습니다.
            끄면 「하루 내내 고르다」고 가정하는데, 그러면 <b>새벽엔 뭐든 급증으로 보이고
            장중엔 평범한 것이 급증으로 보입니다.</b>
          </span>
        </div>
        <button
          className={cfg.timeOfDay ? "login-set-on" : "login-set-off"}
          disabled={busy}
          onClick={() => void save({ timeOfDay: !cfg.timeOfDay })}
        >
          {cfg.timeOfDay ? "켜짐" : "꺼짐"}
        </button>
      </div>

      <button
        className="login-set-danger"
        style={{ marginTop: 16 }}
        disabled={busy}
        onClick={() =>
          void save({
            zMin: 2.2,
            minCount: 3,
            fullSources: 3,
            singleSourcePenalty: 0.5,
            buzzWindowHours: 12,
            baselineDays: 7,
            timeOfDay: true,
          })
        }
      >
        기본값으로 되돌리기
      </button>

      {msg && <div className="login-set-msg">{msg}</div>}
      {err && <div className="login-set-err">{err}</div>}
    </div>
  );
}

/**
 * 미끄럼 막대.
 *
 * 끄는 동안에는 화면만 움직이고 **손을 뗄 때 저장**한다 — 끌 때마다 저장하면
 * 한 번 끄는 데 요청이 수십 개 나간다.
 */
function Slider({
  label,
  value,
  min,
  max,
  step,
  busy,
  onDone,
  note,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  busy: boolean;
  onDone: (v: number) => void;
  note: React.ReactNode;
}) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <div className="buzz-slider">
      <label>
        <span>{label}</span>
        <b>{step < 1 ? v.toFixed(2) : v}</b>
      </label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={v}
        disabled={busy}
        onChange={(e) => setV(Number(e.target.value))}
        onMouseUp={() => v !== value && onDone(v)}
        onTouchEnd={() => v !== value && onDone(v)}
        onKeyUp={() => v !== value && onDone(v)}
      />
      <p className="login-set-note">{note}</p>
    </div>
  );
}
