import type { ReactNode } from 'react';

/** Consistent page title + breadcrumb, with an optional actions slot on the right. */
export function PageHeader({
  title,
  crumb,
  subtitle,
  right,
}: {
  title: string;
  crumb?: string;
  subtitle?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h2 className="text-2xl font-bold tracking-tight text-ink">{title}</h2>
        {crumb && (
          <p className="mt-1 text-xs text-muted">
            <span className="font-semibold text-brand-700">Home</span> / {crumb}
          </p>
        )}
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {right && <div className="flex flex-wrap items-center gap-3">{right}</div>}
    </div>
  );
}
