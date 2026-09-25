import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { motion } from "motion/react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { spring } from "../lib/motion";
import { type ThemeChoice, useTheme } from "../lib/theme";

const OPTIONS: { id: ThemeChoice; label: string; icon: typeof SunIcon }[] = [
  { id: "system", label: "System", icon: MonitorIcon },
  { id: "light", label: "Light", icon: SunIcon },
  { id: "dark", label: "Dark", icon: MoonIcon }
];

export function ThemeToggle() {
  const [choice, setChoice] = useTheme();

  return (
    <div role="radiogroup" aria-label="Theme" className="flex rounded-full border bg-background p-0.5" data-testid="theme-toggle">
      {OPTIONS.map((o) => {
        const active = choice === o.id;
        return (
          <Tooltip key={o.id}>
            <TooltipTrigger asChild>
              <button
                type="button"
                role="radio"
                aria-checked={active}
                aria-label={o.label}
                data-testid={`theme-${o.id}`}
                onClick={() => setChoice(o.id)}
                className={cn(
                  "relative grid size-6 place-items-center rounded-full transition-colors",
                  active ? "text-foreground" : "text-subtle hover:text-foreground"
                )}
              >
                {active && (
                  <motion.span
                    layoutId="theme-pill"
                    transition={spring}
                    className="absolute inset-0 rounded-full border border-border-strong bg-card shadow-sm"
                  />
                )}
                <o.icon className="relative size-3.5" strokeWidth={1.75} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">
              {o.label}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
