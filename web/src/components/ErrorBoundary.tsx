import { Component, type ErrorInfo, type ReactNode } from 'react';

interface State {
  error: Error | null;
}

/**
 * Last line of defence: a rendering bug must not leave a blank page. Shows what failed and
 * offers a reload; the server keeps any running turn going in the meantime.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('LLM Council failed to render', error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="full-page" role="alert">
        <h1 className="full-page-heading">Something went wrong on this page</h1>
        <p className="full-page-text">{this.state.error.message || 'An unexpected error occurred while drawing the page.'}</p>
        <p className="full-page-text">Running council turns continue on the server. Reloading shows their current state.</p>
        <button type="button" className="button primary" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}
