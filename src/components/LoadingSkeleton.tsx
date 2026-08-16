type LoadingSkeletonProps = {
  label: string;
  rows?: number;
  variant?: "list" | "metrics" | "detail" | "map";
  className?: string;
};

export function LoadingSkeleton({ label, rows = 3, variant = "list", className = "" }: LoadingSkeletonProps) {
  return (
    <div
      className={`loadingSkeleton loadingSkeleton-${variant}${className ? ` ${className}` : ""}`}
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <span className="srOnly">{label}</span>
      <div className="loadingSkeletonBody" aria-hidden="true">
        {Array.from({ length: rows }, (_, index) => (
          <div className="loadingSkeletonRow" key={index}>
            <span className="loadingSkeletonPrimary" />
            <span className="loadingSkeletonSecondary" />
            <span className="loadingSkeletonTertiary" />
          </div>
        ))}
      </div>
    </div>
  );
}
