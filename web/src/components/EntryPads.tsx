import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 주문 메뉴 진입 패드 둘 — 숫자패드와 패턴 (2026-09-08).
 *
 * 벤티지: "pin 네자리 화면에 숫자패드 표시해서 입력할수 있게 해주고. 패턴잠금 옵션도
 * 하나 추가해서 패턴도 넣을수 있게해줘. 매번 입력하려니 귀찮고 숫자 넣으려니깐 저장된
 * 비밀번호 계속나와서 걸리적 거리네"
 *
 * ## 왜 <input> 을 안 쓰나
 *
 * `type="password"` 는 브라우저가 **저장된 비밀번호를 들이민다.** `autoComplete` 로
 * 막아 봐도 기기마다 다르게 군다. 그래서 입력칸을 아예 두지 않는다 — 화면에 그린
 * 단추를 누르면 값이 쌓이고, 다 차면 부모가 알아서 보낸다. 키보드가 안 뜨니
 * 자동완성이 끼어들 자리가 없다.
 *
 * ## 값의 형식
 *
 * 둘 다 **숫자열**이다. PIN 은 "0413" 처럼 네 자리, 패턴은 3×3 점의 인덱스(0~8)를
 * 지난 순서대로 "0125" 처럼 잇는다. 서버는 둘을 같은 해시 자리에 두고 같은 잠금
 * 규칙을 쓴다 — 형식이 같아야 그게 된다.
 */

/* ────────────────────────────────────────────────────────────────── */
/* 숫자패드                                                            */
/* ────────────────────────────────────────────────────────────────── */

/** setState 와 같은 꼴 — 부모가 `setPin` 을 그대로 넘기면 된다 */
type Setter = (v: string | ((prev: string) => string)) => void;

export function NumPad({
  value,
  onChange,
  length = 4,
  disabled,
  onComplete,
}: {
  value: string;
  onChange: Setter;
  length?: number;
  disabled?: boolean;
  /** 자리가 다 차면 — 부모가 곧장 보낼 수 있게 */
  onComplete?: (v: string) => void;
}) {
  /*
   * **함수형으로 쌓는다.** `onChange(value + d)` 로 두면 빠르게 두드릴 때 리렌더 전의
   * 옛 value 에 붙여서 글자가 씹힌다 — 「1 2 3」을 눌렀는데 한 자리만 차 있었다
   * (2026-09-08 브라우저에서 확인). prev 를 받아 붙이면 순서대로 다 들어간다.
   */
  const push = (d: string) => {
    if (disabled) return;
    onChange((prev) => {
      if (prev.length >= length) return prev;
      const next = prev + d;
      /* setState 안에서 부모를 부르면 안 된다 — 한 박자 뒤로 */
      if (next.length === length) queueMicrotask(() => onComplete?.(next));
      return next;
    });
  };
  const pop = () => {
    if (disabled) return;
    onChange((prev) => prev.slice(0, -1));
  };

  /* 실물 키보드가 있으면(PC) 그것도 받는다 — 폰만 쓰는 화면이 아니다 */
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (disabled) return;
      if (/^[0-9]$/.test(e.key)) {
        e.preventDefault();
        push(e.key);
      } else if (e.key === "Backspace") {
        e.preventDefault();
        pop();
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  });

  return (
    <div className="npad" aria-label="숫자 입력">
      <div className="npad-dots" aria-live="polite">
        {Array.from({ length }, (_, i) => (
          <i key={i} className={i < value.length ? "on" : ""} />
        ))}
      </div>
      <div className="npad-keys">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
          <button key={d} type="button" className="npad-key" disabled={disabled} onClick={() => push(d)}>
            {d}
          </button>
        ))}
        <button type="button" className="npad-key ghost" disabled={disabled || value.length === 0} onClick={() => onChange("")}>
          지움
        </button>
        <button type="button" className="npad-key" disabled={disabled} onClick={() => push("0")}>
          0
        </button>
        <button type="button" className="npad-key ghost" disabled={disabled || value.length === 0} onClick={pop} aria-label="한 자리 지우기">
          ⌫
        </button>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────── */
/* 패턴                                                                */
/* ────────────────────────────────────────────────────────────────── */

/**
 * 3×3 패턴. 점을 누른 채 끌면 지나는 점이 이어진다. 손을 떼면 끝이다.
 *
 * 값은 지난 점의 인덱스를 이은 숫자열 — 좌상이 0, 오른쪽으로 1·2, 다음 줄 3·4·5, 6·7·8.
 * 같은 점은 두 번 못 지난다. **사이에 점이 있으면 그 점도 지난 것으로 친다** —
 * 0 에서 2 로 곧장 가면 1 을 밟은 것이다. 안드로이드 잠금이 그렇게 굴고, 사람도 그렇게
 * 기억한다.
 */
const N = 3;

/** 두 점 사이에 낀 점 — 없으면 -1 */
function between(a: number, b: number): number {
  const ar = Math.floor(a / N), ac = a % N;
  const br = Math.floor(b / N), bc = b % N;
  const dr = br - ar, dc = bc - ac;
  if (dr % 2 !== 0 || dc % 2 !== 0) return -1;
  return (ar + dr / 2) * N + (ac + dc / 2);
}

export function PatternPad({
  value,
  onChange,
  disabled,
  onComplete,
  minLength = 4,
}: {
  value: string;
  onChange: Setter;
  disabled?: boolean;
  /** 손을 뗐을 때 — 네 점 이상이면 부모가 보낸다 */
  onComplete?: (v: string) => void;
  minLength?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [drawing, setDrawing] = useState(false);
  /* 끌고 있는 손가락의 지금 자리 — 마지막 점에서 손가락까지 선을 긋는다 */
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  /*
   * 지금 값을 ref 로도 든다. pointermove 는 초당 수십 번 오는데 리렌더는 그보다 느려서,
   * 클로저의 value 로 판단하면 같은 점을 여러 번 더하거나 사이 점을 놓친다.
   */
  const cur = useRef(value);
  cur.current = value;

  const dotAt = useCallback((clientX: number, clientY: number): number => {
    const el = ref.current;
    if (!el) return -1;
    const r = el.getBoundingClientRect();
    const x = (clientX - r.left) / r.width;
    const y = (clientY - r.top) / r.height;
    if (x < 0 || x >= 1 || y < 0 || y >= 1) return -1;
    const c = Math.floor(x * N), rr = Math.floor(y * N);
    /* 칸 한가운데 근처만 점으로 친다 — 칸 전체를 잡으면 스치기만 해도 이어진다 */
    const cx = (c + 0.5) / N, cy = (rr + 0.5) / N;
    const d = Math.hypot(x - cx, y - cy);
    return d < 0.14 ? rr * N + c : -1;
  }, []);

  const add = useCallback(
    (i: number) => {
      if (i < 0) return;
      const v = cur.current;
      if (v.includes(String(i))) return;
      let next = v;
      if (next.length > 0) {
        const last = Number(next[next.length - 1]);
        const mid = between(last, i);
        if (mid >= 0 && !next.includes(String(mid))) next += String(mid);
      }
      next += String(i);
      cur.current = next;
      onChange(next);
    },
    [onChange],
  );

  const start = (x: number, y: number) => {
    if (disabled) return;
    cur.current = "";
    onChange("");
    setDrawing(true);
    setCursor({ x, y });
    add(dotAt(x, y));
  };
  const move = (x: number, y: number) => {
    if (!drawing) return;
    setCursor({ x, y });
    add(dotAt(x, y));
  };
  const end = () => {
    if (!drawing) return;
    setDrawing(false);
    setCursor(null);
    const v = cur.current;
    if (v.length >= minLength) onComplete?.(v);
  };

  /* 손을 화면 밖에서 떼도 끝나야 한다 */
  useEffect(() => {
    if (!drawing) return;
    const up = () => end();
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  });

  /* 선을 그리려고 점의 화면 좌표를 구한다 */
  const el = ref.current;
  const box = el?.getBoundingClientRect();
  const center = (i: number) => {
    if (!box) return { x: 0, y: 0 };
    return { x: ((i % N) + 0.5) * (box.width / N), y: (Math.floor(i / N) + 0.5) * (box.height / N) };
  };
  const path = value.split("").map((ch) => center(Number(ch)));
  const tail = drawing && cursor && box ? { x: cursor.x - box.left, y: cursor.y - box.top } : null;

  return (
    <div
      ref={ref}
      className={`ppad${disabled ? " off" : ""}${drawing ? " drawing" : ""}`}
      onPointerDown={(e) => {
        e.preventDefault();
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
        start(e.clientX, e.clientY);
      }}
      onPointerMove={(e) => move(e.clientX, e.clientY)}
      onPointerUp={end}
      aria-label="패턴 입력"
    >
      {box && (
        <svg className="ppad-lines" width={box.width} height={box.height}>
          {path.length > 1 && <polyline points={path.map((p) => `${p.x},${p.y}`).join(" ")} />}
          {tail && path.length > 0 && <line x1={path[path.length - 1].x} y1={path[path.length - 1].y} x2={tail.x} y2={tail.y} />}
        </svg>
      )}
      {Array.from({ length: N * N }, (_, i) => (
        <span key={i} className={`ppad-dot${value.includes(String(i)) ? " on" : ""}`}>
          <i />
        </span>
      ))}
    </div>
  );
}
