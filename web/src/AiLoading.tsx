export function AiLoading({ children }: { children: string }) {
  return <span className="ai-loading" role="status">
    <span className="ai-loading-mark" aria-hidden="true" />
    {children}
  </span>;
}
