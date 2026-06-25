import * as React from "react";
import { Link, useParams, useNavigate, Outlet } from "react-router";
import { Button } from "@carrier/ui";
import { cn } from "@carrier/ui";
import { Sun, Moon, ChevronDown, LogOut } from "lucide-react";
import type { Me } from "@carrier/contract";
import { useTheme } from "./theme";
import { api } from "../api/client";

function ThemeToggle() {
  const { theme, toggle } = useTheme();
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={toggle}
      aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
    >
      {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </Button>
  );
}

function OrgSwitcher({ me, activeSlug }: { me: Me; activeSlug?: string }) {
  const [open, setOpen] = React.useState(false);
  const navigate = useNavigate();
  const ref = React.useRef<HTMLDivElement | null>(null);
  const active = me.orgs.find((o) => o.slug === activeSlug) ?? me.orgs[0];

  React.useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  return (
    <div className="relative" ref={ref}>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {active?.name ?? "Select org"}
        <ChevronDown className="h-3.5 w-3.5" aria-hidden />
      </Button>
      {open ? (
        <ul
          role="listbox"
          className="absolute left-0 z-20 mt-1 min-w-48 rounded-md border border-neutral-200 bg-white py-1 shadow-lg dark:border-neutral-800 dark:bg-neutral-900"
        >
          {me.orgs.map((org) => (
            <li key={org.id} role="option" aria-selected={org.slug === activeSlug}>
              <button
                onClick={() => {
                  setOpen(false);
                  navigate(`/${org.slug}`);
                }}
                className={cn(
                  "flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-neutral-100 focus-ring dark:hover:bg-neutral-800",
                  org.slug === activeSlug && "font-medium",
                )}
              >
                <span>{org.name}</span>
                <span className="text-xs text-fg-muted">{org.kind}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * App shell — header with brand, org switcher, theme toggle, and account.
 * Used as the layout route for all authenticated pages. The IDE route renders
 * inside the shell's `<Outlet/>` but uses the full content area.
 */
export function Shell({ me }: { me: Me }) {
  const { org } = useParams();
  const navigate = useNavigate();

  const logout = async () => {
    await api.logout();
    navigate("/login");
  };

  return (
    <div className="flex h-full flex-col bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-neutral-900 focus:px-3 focus:py-1.5 focus:text-sm focus:text-white dark:focus:bg-neutral-100 dark:focus:text-neutral-900"
      >
        Skip to content
      </a>
      <header className="flex items-center gap-3 border-b border-neutral-200 px-4 py-2 dark:border-neutral-800">
        <Link to="/" className="text-sm font-semibold">
          Carrier
        </Link>
        <OrgSwitcher me={me} activeSlug={org} />
        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle />
          <span className="hidden text-sm text-fg-muted sm:inline">{me.account.login}</span>
          <img
            src={me.account.avatarUrl}
            alt=""
            className="h-6 w-6 rounded-full"
            referrerPolicy="no-referrer"
          />
          <Button variant="ghost" size="icon" onClick={logout} aria-label="Sign out">
            <LogOut className="h-4 w-4" />
          </Button>
        </div>
      </header>
      <main id="main" className="min-h-0 flex-1">
        <Outlet />
      </main>
    </div>
  );
}
