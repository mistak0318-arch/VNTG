import type { ReactNode } from "react";

function fmtTime(ts: number | null): string {
  if (!ts) return "";
  return new Date(ts).toLocaleTimeString("ko-KR", { hour12: false });
}

export function OverviewCard({
  title,
  updatedAt,
  subtitle,
  loading,
  error,
  span2,
  children,
}: {
  title: string;
  updatedAt?: number | null;
  subtitle?: string;
  loading?: boolean;
  error?: string | null;
  span2?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`ov-card${span2 ? " ov-span2" : ""}`}>
      <div className="ov-card-h">
        <span className="ov-card-t">{title}</span>
        <span className="ov-card-sub">{subtitle ?? fmtTime(updatedAt ?? null)}</span>
      </div>
      {error ? (
        <div className="ov-card-b ov-error">{error}</div>
      ) : loading ? (
        <div className="ov-card-b">
          <div className="ov-skel" />
          <div className="ov-skel" />
          <div className="ov-skel" />
        </div>
      ) : (
        children
      )}
    </div>
  );
}
