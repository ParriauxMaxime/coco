import React from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { chunkGone, reloadWhenSafe } from './updates.ts';

export const reportError = (kind: string, error: unknown, extra: Record<string, unknown> = {}) => {
  const e = error instanceof Error ? error : new Error(String(error));
  const body = JSON.stringify({ kind, message: e.message, stack: e.stack, url: location.href, ...extra });
  void fetch('/api/client-error', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }).catch(() => {});
};

export function watchErrors() {
  addEventListener('error', (e) => reportError('window', e.error ?? e.message));
  addEventListener('unhandledrejection', (e) => reportError('promise', e.reason));
}

type Props = { children: ReactNode; label?: string; inline?: boolean };

export default class ErrorBoundary extends React.Component<Props, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (chunkGone(error)) reloadWhenSafe();
    reportError(this.props.label ?? 'render', error, { componentStack: info.componentStack });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const note = (
      <div className={`dp-crash${this.props.inline ? ' dp-crash-inline' : ''}`} role="alert">
        <b>{this.props.inline ? 'This part failed to render' : 'coco crashed'}</b>
        <code>{error.message}</code>
        <span>
          <button type="button" className="dp-btn dp-sm" onClick={() => this.setState({ error: null })}>Try again</button>
          {!this.props.inline && <button type="button" className="dp-btn dp-sm" onClick={() => location.reload()}>Reload</button>}
        </span>
      </div>
    );
    return this.props.inline ? note : <div className="dp dp-float">{note}</div>;
  }
}
