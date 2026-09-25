import { BotIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "@/lib/utils";
import type { Session, Thread } from "@/server/thread-index";
import { spring } from "../lib/motion";
import { ThemeToggle } from "./theme-toggle";

type Props = {
  threads: Thread[];
  sessions: Session[];
  activeThreadId: string | null;
  activeSessionId: string | null;
  onSelect: (threadId: string, sessionId?: string | null) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
};


const FORK_SUFFIX = " (Forked)";

/** The name truncates; a fork's "(Forked)" suffix always stays visible. */
function ThreadTitle({ title }: { title: string }) {
  const forked = title.endsWith(FORK_SUFFIX);
  return (
    <span className="relative flex min-w-0 flex-1 items-center gap-1 pr-5">
      <span className="min-w-0 truncate">{forked ? title.slice(0, -FORK_SUFFIX.length) : title}</span>
      {forked && <span className="shrink-0 text-subtle">(Forked)</span>}
    </span>
  );
}

export function StatusDot({ status }: { status: string }) {
  const color =
    status === "running" ? "bg-brand animate-pulse" : status === "completed" ? "bg-success" : status === "error" ? "bg-destructive" : "bg-subtle";
  return <span className={cn("relative size-1.5 shrink-0 rounded-full", color)} title={status} />;
}

export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" aria-hidden>
      <path d="M12 2.5 20.5 7.25v9.5L12 21.5l-8.5-4.75v-9.5L12 2.5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M12 12 20.5 7.25M12 12v9.5M12 12 3.5 7.25" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

export function Sidebar({ threads, sessions, activeThreadId, activeSessionId, onSelect, onCreate, onDelete }: Props) {
  // Newest first. A fork is an ordinary chat; its title carries "(Forked)".
  const rows = [...threads].sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <aside className="flex w-[248px] shrink-0 flex-col border-r bg-sidebar">
      <div className="flex h-12 items-center gap-2.5 px-4">
        <Logo className="size-[18px] text-foreground" />
        <span className="text-sm font-semibold tracking-[-0.01em]">Durable Agent</span>
        <span className="ml-auto rounded-full border px-1.5 py-px text-2xs text-muted-foreground">Cloudflare</span>
      </div>

      <div className="px-2.5 pt-1 pb-3">
        <button
          type="button"
          onClick={onCreate}
          data-testid="new-chat"
          className="group flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <PlusIcon className="size-4" />
          New chat
        </button>
      </div>

      <div className="px-4 pb-1.5 text-2xs font-medium tracking-wide text-subtle uppercase">Chats</div>

      <nav className="flex-1 overflow-y-auto px-2.5 pb-3 [overflow-anchor:none]" data-testid="thread-list">
        <AnimatePresence initial={false}>
          {rows.map((thread) => {
            const active = thread.id === activeThreadId && !activeSessionId;
            const ancestor = thread.id === activeThreadId && Boolean(activeSessionId);
            const children = sessions.filter((x) => x.threadId === thread.id).sort((a, b) => a.startedAt - b.startedAt);
            return (
              <motion.div
                key={thread.id}
                layout="position"
                initial={{ opacity: 0, y: -6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, height: 0 }}
                transition={spring}
                className="group relative"
              >
                <button
                  type="button"
                  onClick={() => onSelect(thread.id)}
                  data-testid="thread-item"
                  data-active={active}
                  className={cn(
                    "relative flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm transition-colors",
                    active || ancestor ? "text-foreground" : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {active && (
                    <motion.span layoutId="thread-active" transition={spring} className="absolute inset-0 rounded-md bg-accent" />
                  )}
                  <ThreadTitle title={thread.title} />
                </button>
                <button
                  type="button"
                  aria-label="Delete chat"
                  onClick={() => onDelete(thread.id)}
                  className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-1 text-subtle opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive"
                >
                  <Trash2Icon className="size-3.5" />
                </button>
                {children.map((sub) => {
                  const subActive = sub.runId === activeSessionId;
                  return (
                    <button
                      key={sub.runId}
                      type="button"
                      onClick={() => onSelect(thread.id, sub.runId)}
                      data-testid="session-item"
                      data-status={sub.status}
                      data-background={sub.background}
                      className={cn(
                        "relative ml-4 flex h-7 w-[calc(100%-1rem)] min-w-0 items-center gap-2 rounded-md pr-2 pl-3 text-left text-xs transition-colors",
                        subActive ? "text-foreground" : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      <span className="absolute top-0 bottom-1/2 left-0 w-px bg-border-strong" />
                      {subActive && (
                        <motion.span layoutId="thread-active" transition={spring} className="absolute inset-0 rounded-md bg-accent" />
                      )}
                      <BotIcon className="relative size-3.5 shrink-0" />
                      <span className="relative min-w-0 flex-1 truncate">{sub.description}</span>
                      <StatusDot status={sub.status} />
                    </button>
                  );
                })}
              </motion.div>
            );
          })}
        </AnimatePresence>
      </nav>

      <div className="flex items-center gap-3 border-t px-4 py-3">
        <a
          href="https://developers.cloudflare.com/agents/"
          target="_blank"
          rel="noreferrer"
          className="min-w-0 flex-1 truncate text-2xs text-subtle transition-colors hover:text-foreground"
        >
          Cloudflare Agents SDK
        </a>
        <ThemeToggle />
      </div>
    </aside>
  );
}
