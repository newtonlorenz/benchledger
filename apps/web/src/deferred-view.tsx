import { Component, lazy, Suspense, useState, type ComponentType, type ReactNode } from "react";
import "./deferred-view.css";

class ModuleLoadError extends Error {}

class ViewBoundary extends Component<{ children: ReactNode; name: string; recovery: string; onRetry(): void }, { failed: boolean; loadFailed: boolean }> {
  override state = { failed: false, loadFailed: false };

  static getDerivedStateFromError(error: unknown) { return { failed: true, loadFailed: error instanceof ModuleLoadError }; }

  override render() {
    if (!this.state.failed) return this.props.children;
    return <div className="deferred-view-message">
      <p role="alert">{this.props.name} could not be opened.</p>
      <p>{this.props.recovery}</p>
      {this.state.loadFailed
        ? <p>Check your connection, save any open work, then refresh the page to load this view.</p>
        : <button type="button" className="button button-secondary" onClick={this.props.onRetry}>Retry {this.props.name.toLowerCase()}</button>}
    </div>;
  }
}

/** Keep optional code and failures local. A retry never reloads the workspace. */
export function deferView<Props extends object>(
  load: () => Promise<{ default: ComponentType<Props> }>,
  options: { name: string; loading: string; recovery: string },
) {
  // Browsers cache rejected module imports. Do not offer an ineffective retry or
  // automatically reload a page that may contain unsaved work elsewhere.
  const View = lazy(() => load().catch(() => { throw new ModuleLoadError(); }));
  return function DeferredView(props: Props) {
    const [attempt, setAttempt] = useState(0);
    return <ViewBoundary key={attempt} name={options.name} recovery={options.recovery} onRetry={() => setAttempt(value => value + 1)}>
      <Suspense fallback={<p className="deferred-view-message" role="status">{options.loading}</p>}>
        <View {...props} />
      </Suspense>
    </ViewBoundary>;
  };
}
