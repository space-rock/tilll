import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "../../router.js";

/** The title of a page, with an optional line under it, a breadcrumb above it and actions on the right. */
export function PageHeader({
  title,
  description,
  breadcrumb,
  actions,
  badge,
}: {
  title: ReactNode;
  description?: ReactNode;
  breadcrumb?: { label: string; to?: string }[];
  actions?: ReactNode;
  badge?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-3 pb-1">
      {breadcrumb && (
        <nav aria-label="Breadcrumb">
          <ol className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
            {breadcrumb.map((crumb, index) => (
              <li key={crumb.label} className="flex items-center gap-1">
                {index > 0 && <ChevronRight aria-hidden="true" className="h-3.5 w-3.5" />}
                {crumb.to ? (
                  <Link to={crumb.to} className="hover:text-foreground hover:underline">
                    {crumb.label}
                  </Link>
                ) : (
                  <span aria-current="page" className="text-foreground">
                    {crumb.label}
                  </span>
                )}
              </li>
            ))}
          </ol>
        </nav>
      )}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="font-display text-2xl font-semibold tracking-tight">{title}</h1>
            {badge}
          </div>
          {description && <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}
