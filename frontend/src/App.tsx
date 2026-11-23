import React from 'react';
import { DesktopShell } from './layout/DesktopShell';

interface BoundaryState {
  error: Error | null;
  componentStack: string;
}

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, BoundaryState> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null, componentStack: '' };
  }

  static getDerivedStateFromError(error: Error): Partial<BoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    const stack = info.componentStack ?? '';
    console.error('MERIDIAN_UI_ERROR:', error.message, '\nSTACK:', error.stack, '\nCOMPONENT:', stack);
    this.setState({ error, componentStack: stack });
  }

  render() {
    if (this.state.error) {
      return (
        <div className="p-6 bg-[#161b22] text-rose-300 font-mono text-xs h-screen overflow-auto">
          <div className="text-sm font-bold text-rose-400 mb-2">
            MERIDIAN UI 渲染异常：{this.state.error.message}
          </div>
          <pre className="whitespace-pre-wrap text-slate-300 mb-4">{this.state.error.stack}</pre>
          <pre className="whitespace-pre-wrap text-sky-300">{this.state.componentStack}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

export const App: React.FC = () => {
  return (
    <ErrorBoundary>
      <DesktopShell />
    </ErrorBoundary>
  );
};

export default App;
