import type { ReactNode } from "react";

interface PageHeaderProps {
  title: string;
  /** Date or subtitle line next to the title (mono, data 12). */
  description: ReactNode;
  /** Right-hand action slot: buttons, search, toggles. */
  actions?: ReactNode;
  /** Extra lines under the header row (kept for existing callers). */
  children?: ReactNode;
}

export function PageHeader({ title, description, actions, children }: PageHeaderProps) {
  return (
    <header className="flex flex-col gap-sp-1">
      <div className="flex flex-wrap items-baseline gap-x-sp-4 gap-y-sp-1">
        <h1 className="font-display text-h1">{title}</h1>
        <p className="min-w-0 font-mono text-data text-ink-2">{description}</p>
        {actions ? <div className="ml-auto flex flex-wrap items-center gap-sp-2" data-slot="page-header-actions">{actions}</div> : null}
      </div>
      {children}
    </header>
  );
}
