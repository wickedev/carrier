import * as React from "react";
import { ErrorState } from "./primitives";

interface Props {
  children: React.ReactNode;
  fallback?: (error: Error, reset: () => void) => React.ReactNode;
}

interface State {
  error: Error | null;
}

/** Class-based error boundary to contain failures in primary views (Req 18.3). */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      if (this.props.fallback) return this.props.fallback(this.state.error, this.reset);
      return <ErrorState message={this.state.error.message} onRetry={this.reset} />;
    }
    return this.props.children;
  }
}
