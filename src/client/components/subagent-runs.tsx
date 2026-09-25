import type { AgentToolRunState } from "agents/agent-tools";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import { ArrowUpRightIcon, BookOpenIcon, BotIcon, CheckCircle2Icon, CircleAlertIcon, GlobeIcon, LoaderIcon, SearchIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { MessageResponse } from "@/components/ai-elements/message";
import { spring } from "../lib/motion";

type Run = AgentToolRunState<UIMessage["parts"][number]>;

/**
 * The live timeline of a sub-agent run. The child streams its own message parts
 * (text, tool calls) to the parent's socket as `agent-tool-event` frames;
 * `useAgentToolEvents` rebuilds them into `run.parts`. After a refresh the
 * parent replays them, so the timeline survives reloads too.
 */
const TOOL_VIEW: Record<string, { icon: typeof BookOpenIcon; label: (input: Record<string, string>, done: boolean) => string }> = {
  wikipedia_search: { icon: SearchIcon, label: (i, d) => `${d ? "Searched" : "Searching"} Wikipedia for “${i.query ?? "…"}”` },
  wikipedia_page: { icon: BookOpenIcon, label: (i, d) => `${d ? "Read" : "Reading"} “${i.title ?? "…"}”` },
  fetch_url: { icon: GlobeIcon, label: (i, d) => `${d ? "Fetched" : "Fetching"} ${hostname(i.url)}` }
};

function hostname(url?: string) {
  try {
    return url ? new URL(url).hostname : "…";
  } catch {
    return url ?? "…"; // input is still streaming in
  }
}

export function SubagentRuns({ runs, onOpen }: { runs: Run[]; onOpen: (runId: string) => void }) {
  return (
    <div className="space-y-2" data-testid="subagent-runs">
      {runs.map((run) => (
        <div key={run.runId} className="rounded-lg border bg-background p-3">
          <div className="mb-2 flex items-center gap-2 text-xs">
            <BotIcon className="size-3.5 text-muted-foreground" />
            <span className="font-medium">{run.display?.name ?? run.agentType}</span>
            <span className="text-subtle">sub-agent · own Durable Object</span>
            <span className="ml-auto flex items-center gap-1" data-testid="subagent-status" data-status={run.status}>
              {run.status === "running" && <LoaderIcon className="size-3.5 animate-spin" />}
              {run.status === "completed" && <CheckCircle2Icon className="size-3.5 text-success" />}
              {(run.status === "error" || run.status === "aborted" || run.status === "interrupted") && (
                <CircleAlertIcon className="size-3.5 text-destructive" />
              )}
              <span className="text-muted-foreground capitalize">{run.status}</span>
            </span>
            <button
              type="button"
              onClick={() => onOpen(run.runId)}
              data-testid="open-session"
              className="flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              Open session
              <ArrowUpRightIcon className="size-3" />
            </button>
          </div>

          {run.status === "running" && run.progress?.message && (
            <div className="mb-2 text-xs text-muted-foreground">{run.progress.message}</div>
          )}

          <div className="space-y-1.5">
            <AnimatePresence initial={false}>
              {run.parts.map((part, i) => {
                if (!part || typeof part.type !== "string") return null;
                const view = isToolUIPart(part) ? TOOL_VIEW[getToolName(part)] : undefined;
                if (view && isToolUIPart(part)) {
                  const done = part.state === "output-available";
                  const Icon = view.icon;
                  return (
                    <motion.div
                      key={`${run.runId}-${i}`}
                      initial={{ opacity: 0, x: -8 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={spring}
                      className="flex items-center gap-2 text-xs"
                      data-testid="subagent-tool"
                    >
                      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{view.label((part.input ?? {}) as Record<string, string>, done)}</span>
                      {!done && <LoaderIcon className="size-3 animate-spin text-muted-foreground" />}
                    </motion.div>
                  );
                }
                if (part.type === "text" && part.text.trim()) {
                  return (
                    <motion.div
                      key={`${run.runId}-${i}`}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={spring}
                      className="prose-chat text-xs! text-muted-foreground [&_p]:my-1 [&_ul]:my-1"
                    >
                      <MessageResponse className="text-xs">{part.text}</MessageResponse>
                    </motion.div>
                  );
                }
                return null;
              })}
            </AnimatePresence>
          </div>

          {run.error && <div className="mt-2 text-xs text-destructive">{run.error}</div>}
        </div>
      ))}
    </div>
  );
}
