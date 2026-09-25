import { useEffect, useState } from "react";

export type ThemeChoice = "system" | "light" | "dark";

const KEY = "theme";
const query = () => window.matchMedia("(prefers-color-scheme: dark)");

function read(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

function apply(choice: ThemeChoice) {
  const dark = choice === "dark" || (choice === "system" && query().matches);
  document.documentElement.classList.toggle("dark", dark);
}

/**
 * Light / dark / system. The choice is saved per browser; "system" follows the
 * OS setting live. index.html applies it before first paint, so there is no flash.
 */
export function useTheme() {
  const [choice, setChoice] = useState<ThemeChoice>(read);

  useEffect(() => {
    apply(choice);
    try {
      if (choice === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, choice);
    } catch {
      // storage can be blocked (private mode); the theme still applies for this session
    }
    if (choice !== "system") return;
    const mq = query();
    const onChange = () => apply("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [choice]);

  return [choice, setChoice] as const;
}
