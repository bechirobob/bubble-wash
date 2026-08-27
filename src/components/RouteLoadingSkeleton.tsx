export function RouteLoadingSkeleton() {
  return (
    <main className="routeLoadingShell" role="status" aria-live="polite" aria-busy="true">
      <span className="srOnly">Loading the next Bubble Wash page</span>
      <div className="routeLoadingFrame" aria-hidden="true">
        <header className="routeLoadingHeader pageShell">
          <span className="routeLoadingBrand">
            <span className="routeSkeletonBlock routeSkeletonLogo" />
            <span className="routeSkeletonLine routeSkeletonBrandName" />
          </span>
          <span className="routeLoadingNav">
            {Array.from({ length: 5 }, (_, index) => <span className="routeSkeletonLine" key={index} />)}
          </span>
        </header>

        <section className="routeLoadingHero pageShell">
          <div className="routeLoadingCopy">
            <span className="routeSkeletonLine routeSkeletonEyebrow" />
            <span className="routeSkeletonLine routeSkeletonTitle" />
            <span className="routeSkeletonLine routeSkeletonTitle routeSkeletonTitleShort" />
            <span className="routeSkeletonLine routeSkeletonSummary" />
            <span className="routeSkeletonLine routeSkeletonSummary routeSkeletonSummaryShort" />
          </div>
          <span className="routeSkeletonBlock routeSkeletonPanel" />
        </section>

        <section className="routeLoadingContent pageShell">
          {Array.from({ length: 3 }, (_, index) => (
            <span className="routeLoadingContentRow" key={index}>
              <span className="routeSkeletonLine" />
              <span className="routeSkeletonLine" />
              <span className="routeSkeletonLine" />
            </span>
          ))}
        </section>
      </div>
    </main>
  );
}
