import * as React from "react";
import { Sun, Moon } from "lucide-react";
import { Button } from "@carrier/ui";
import { useTheme } from "../components/theme";

/** Theme toggle usable outside the authenticated Shell (e.g. /login). */
export function ThemeToggleStandalone() {
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
