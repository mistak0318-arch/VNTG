/**
 * 시스 캐릭터 (2026-09-03) — 벤티지가 준 그림을 따라 그린 SVG.
 * 남색 구체 + 은색 테두리, 청록으로 빛나는 눈 둘, 안테나 둘, 왼쪽에 귀(원형 스피커).
 * 글자 크기를 따라가게 `em` 으로 — 버튼에선 1.4em, 제목에선 1.2em.
 */
export function SysIcon({ size = "1.4em", glow = true }: { size?: string; glow?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className="sys-icon">
      <defs>
        <radialGradient id="sysBody" cx="38%" cy="32%" r="70%">
          <stop offset="0%" stopColor="#5c6f92" />
          <stop offset="55%" stopColor="#1f2c4d" />
          <stop offset="100%" stopColor="#0b1430" />
        </radialGradient>
        <linearGradient id="sysRim" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#e8edf5" />
          <stop offset="50%" stopColor="#8a97ad" />
          <stop offset="100%" stopColor="#c9d2e0" />
        </linearGradient>
        <radialGradient id="sysEye" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#f2fffd" />
          <stop offset="45%" stopColor="#8ff5ec" />
          <stop offset="100%" stopColor="#2fd6d0" stopOpacity="0.15" />
        </radialGradient>
        {glow && (
          <filter id="sysGlow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="1.6" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        )}
      </defs>
      {/* 안테나 */}
      <path d="M22 16 L17 5" stroke="url(#sysRim)" strokeWidth="3" strokeLinecap="round" />
      <path d="M42 16 L47 5" stroke="url(#sysRim)" strokeWidth="3" strokeLinecap="round" />
      <circle cx="17" cy="5" r="2" fill="#c9d2e0" />
      <circle cx="47" cy="5" r="2" fill="#c9d2e0" />
      {/* 몸통 */}
      <circle cx="32" cy="34" r="25" fill="url(#sysBody)" stroke="url(#sysRim)" strokeWidth="2.2" />
      {/* 정수리 은판 */}
      <path d="M17 24 Q32 12 47 24 Q40 21 32 21 Q24 21 17 24 Z" fill="#b8c3d4" opacity="0.85" />
      {/* 바이저 */}
      <path d="M13 34 Q32 22 51 34 Q46 47 32 48 Q18 47 13 34 Z" fill="#0d1733" stroke="#3a4a6e" strokeWidth="1" />
      {/* 귀 */}
      <circle cx="9" cy="35" r="4.5" fill="#1a2648" stroke="#2fd6d0" strokeWidth="1.2" />
      <circle cx="9" cy="35" r="1.8" fill="#2fd6d0" opacity="0.8" />
      {/* 눈 */}
      <g filter={glow ? "url(#sysGlow)" : undefined}>
        <circle cx="25" cy="35" r="4.6" fill="url(#sysEye)" />
        <circle cx="39" cy="35" r="4.6" fill="url(#sysEye)" />
      </g>
      {/* 입 슬릿 */}
      <rect x="27" y="52" width="10" height="1.6" rx="0.8" fill="#8a97ad" opacity="0.7" />
    </svg>
  );
}
