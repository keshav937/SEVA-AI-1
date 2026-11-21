import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface State {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error): State {
    let readable = error.message || 'An unexpected error occurred.';
    try {
      const parsed = JSON.parse(readable);
      if (parsed?.error) readable = parsed.error;
    } catch {
      // plain string error
    }
    return { hasError: true, message: readable };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-white flex items-center justify-center p-6">
          <div className="max-w-md w-full border border-slate-200 rounded-xl p-6 bg-slate-50">
            <div className="flex items-center gap-3 text-red-700 mb-3">
              <AlertTriangle className="w-5 h-5 shrink-0" />
              <h2 className="font-display text-lg font-semibold text-slate-900">
                Application Recovery Required
              </h2>
            </div>
            <p className="text-sm text-slate-600 mb-5 leading-relaxed">{this.state.message}</p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="inline-flex items-center gap-2 px-4 py-2.5 bg-green-900 text-white text-sm font-medium rounded-lg hover:bg-green-800 transition-colors"
            >
              <RefreshCw className="w-4 h-4" />
              Reload Platform
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
