import { Component, Fragment, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode; fallback(reset: () => void): ReactNode; onError?(error: unknown, info: ErrorInfo): void; resetKey?: unknown };

/** Keep a rendering fault on one screen from blanking the whole app. */
export class ErrorBoundary extends Component<Props, { failed: boolean; generation: number }> {
  state = { failed: false, generation: 0 };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown, info: ErrorInfo) { this.props.onError?.(error, info); }
  componentDidUpdate(previous: Props) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) this.reset();
  }
  reset = () => this.setState(({ generation }) => ({ failed: false, generation: generation + 1 }));
  render() {
    if (this.state.failed) return this.props.fallback(this.reset);
    // Remount children after recovery so their state starts clean.
    return <Fragment key={this.state.generation}>{this.props.children}</Fragment>;
  }
}
