import { ChevronRightIcon, CircleStopIcon, ListTreeIcon, ScrollTextIcon, Trash2Icon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ReportView } from "@/server/chat-agent";
import type { LogEntry } from "@/server/logs";
import { spring } from "../lib/motion";

type Props = {
  logs: LogEntry[];
  reports: ReportView[];
  onClearLogs: () => void;
  onCancelReport: (runId: string) => void;
};

type Tab = "logs" | "tasks";

export function Inspector({ logs, reports, onClearLogs, onCancelReport }: Props) {
  const [tab, setTab] = useState<Tab>("logs");
  const running = reports.filter((r) => r.status === "running" || r.status === "sleeping").length;

  // Jump to Tasks the moment a background job starts.
  const lastCount = useRef(reports.length);
  useEffect(() => {
    if (reports.length > lastCount.current) setTab("tasks");
    lastCount.current = reports.length;
  }, [reports.length]);

  return (
    <div className="flex h-full w-[360px] flex-col">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <div className="flex rounded-lg bg-muted p-0.5">
        {(
          [
            { id: "logs", label: "Logs", icon: ScrollTextIcon, count: logs.length },
            { id: "tasks", label: "Tasks", icon: ListTreeIcon, count: running }
          ] as const
        ).map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            data-testid={`tab-${t.id}`}
            className={cn(
              "relative flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors",
              tab === t.id ? "text-foreground" : "text-muted-foreground hover:text-foreground"
            )}
          >
            {tab === t.id && (
              <motion.span layoutId="inspector-tab" transition={spring} className="absolute inset-0 rounded-md border border-border-strong bg-card shadow-sm" />
            )}
            <t.icon className="relative size-3.5" />
            <span className="relative">{t.label}</span>
            {t.count > 0 && (
              <span className="relative min-w-4 rounded-full bg-accent px-1 text-center text-[10px] leading-4 text-muted-foreground tabular-nums">{t.count}</span>
            )}
          </button>
        ))}
        </div>
        {tab === "logs" && logs.length > 0 && (
          <Button variant="ghost" size="icon" className="ml-auto size-7 text-muted-foreground hover:text-foreground" aria-label="Clear logs" onClick={onClearLogs}>
            <Trash2Icon className="size-3.5" />
          </Button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "logs" ? <LogList logs={logs} /> : <TaskList reports={reports} onCancel={onCancelReport} />}
      </div>
    </div>
  );
}

const LEVEL_COLOR = { info: "bg-subtle", warn: "bg-warning", error: "bg-destructive" } as const;

const FILTERS = [
  { id: "app", label: "App", match: (l: LogEntry) => l.source !== "sdk" },
  { id: "all", label: "All", match: () => true },
  { id: "errors", label: "Errors", match: (l: LogEntry) => l.level !== "info" }
] as const;

function LogList({ logs: all }: { logs: LogEntry[] }) {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["id"]>("app");
  const logs = all.filter(FILTERS.find((f) => f.id === filter)!.match);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Scroll only the log pane; scrollIntoView would also scroll the page and sidebar.
    const pane = end.current?.closest(".overflow-y-auto");
    if (pane) pane.scrollTop = pane.scrollHeight;
  }, [logs.length]);

  const bar = (
    <div className="sticky top-0 z-10 flex gap-1 border-b bg-sidebar/95 px-3 py-2 backdrop-blur">
      {FILTERS.map((f) => (
        <button
          key={f.id}
          type="button"
          onClick={() => setFilter(f.id)}
          data-testid={`log-filter-${f.id}`}
          className={cn(
            "h-6 rounded-md px-2 text-2xs font-medium transition-colors",
            filter === f.id ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"
          )}
        >
          {f.label}
          <span className="ml-1 text-subtle tabular-nums">{all.filter(f.match).length}</span>
        </button>
      ))}
    </div>
  );

  if (logs.length === 0) {
    return (
      <>
        {bar}
        <p className="p-4 text-xs leading-5 text-muted-foreground">Every event from this agent — turns, model steps, tool calls, SDK lifecycle — appears here live. The same lines go to <code className="font-mono">wrangler tail</code> and Workers Logs.</p>
      </>
    );
  }
  return (
    <div className="pb-1.5 font-mono text-[11px] leading-4" data-testid="log-list">
      {bar}
      {logs.map((log) => (
        <LogRow key={log.id} log={log} />
      ))}
      <div ref={end} />
    </div>
  );
}

function LogRow({ log }: { log: LogEntry }) {
  const [open, setOpen] = useState(false);
  const hasData = log.data !== undefined && log.data !== null;
  return (
    <motion.div initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} transition={spring} data-testid="log-row" data-level={log.level}>
      <button
        type="button"
        onClick={() => hasData && setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-[5px] text-left transition-colors hover:bg-accent/60"
      >
        <span className={cn("size-1.5 shrink-0 rounded-full", LEVEL_COLOR[log.level])} />
        <span className="shrink-0 text-subtle tabular-nums">{new Date(log.ts).toLocaleTimeString([], { hour12: false })}</span>
        <span className="w-16 shrink-0 truncate text-muted-foreground">{log.source}</span>
        <span className={cn("min-w-0 flex-1 truncate text-foreground/85", log.level === "error" && "text-destructive")}>{log.event}</span>
        {hasData && <ChevronRightIcon className={cn("size-3 shrink-0 text-subtle transition-transform", open && "rotate-90")} />}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.pre
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={spring}
            className="mx-3 mb-1.5 overflow-hidden rounded-md border bg-card p-2 text-muted-foreground whitespace-pre-wrap break-all"
          >
            {JSON.stringify(log.data, null, 2)}
          </motion.pre>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function TaskList({ reports, onCancel }: { reports: ReportView[]; onCancel: (runId: string) => void }) {
  if (reports.length === 0) {
    return (
      <p className="p-4 text-xs leading-5 text-muted-foreground">
        Background tasks run in the agent itself. Ask for a report, close the tab, and come back — it keeps going.
      </p>
    );
  }
  return (
    <div className="space-y-2 p-3" data-testid="task-list">
      {reports.map((r) => {
        const active = r.status === "running" || r.status === "sleeping";
        const pct = r.sections ? Math.round((r.done / r.sections) * 100) : 5;
        return (
          <motion.div
            key={r.runId}
            layout
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={spring}
            className="rounded-xl border bg-card p-3.5"
            data-testid="task-card"
            data-status={r.status}
          >
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium capitalize">{r.topic}</div>
                <div className="mt-0.5 truncate text-xs text-muted-foreground">{r.step}</div>
              </div>
              <span
                className={cn(
                  "shrink-0 rounded-full px-2 py-0.5 text-2xs font-medium capitalize",
                  r.status === "completed" && "bg-success/12 text-success",
                  active && "bg-brand/12 text-brand",
                  (r.status === "failed" || r.status === "cancelled") && "bg-muted text-muted-foreground"
                )}
              >
                {r.status}
              </span>
            </div>
            <div className="mt-3 h-1 overflow-hidden rounded-full bg-accent">
              <motion.div
                className={cn("h-full rounded-full", r.status === "completed" ? "bg-success" : "bg-brand")}
                animate={{ width: `${r.status === "completed" ? 100 : pct}%` }}
                transition={spring}
              />
            </div>
            <div className="mt-2 flex items-center justify-between text-2xs text-subtle tabular-nums">
              <span>
                {r.done}/{r.sections || "?"} sections · started {new Date(r.startedAt).toLocaleTimeString()}
              </span>
              {active && (
                <button type="button" onClick={() => onCancel(r.runId)} className="flex items-center gap-1 hover:text-destructive">
                  <CircleStopIcon className="size-3" /> Cancel
                </button>
              )}
            </div>
          </motion.div>
        );
      })}
    </div>
  );
}
