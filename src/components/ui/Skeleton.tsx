export function Skeleton({ className = "", fill = false }: { className?: string; fill?: boolean }) {
  return (
    <div
      aria-hidden="true"
      className={`skeleton overflow-hidden bg-surface-2 ${fill ? "absolute inset-0" : "relative"} ${className}`}
    />
  );
}
