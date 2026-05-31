import { Component } from "react";
import type { ReactNode, ErrorInfo } from "react";
import { rpc } from "@/lib/rpc";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("[ErrorBoundary]", error, errorInfo);
    const stack = [
      error.stack,
      errorInfo.componentStack ? `Component stack:${errorInfo.componentStack}` : "",
    ].filter(Boolean).join("\n");
    rpc.logClientError("reactRenderError", error.message, stack);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div className="flex flex-col items-center justify-center h-full gap-4 p-8">
          <div className="text-destructive font-semibold text-lg">Something went wrong</div>
          <p className="text-sm text-muted-foreground max-w-md text-center">
            {this.state.error?.message ?? "An unexpected error occurred."}
          </p>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            className="px-4 py-2 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90"
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
