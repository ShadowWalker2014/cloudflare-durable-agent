import { useAgentChat } from "@cloudflare/ai-chat/react";
import { useAgent, useAgentToolEvents } from "agents/react";
import type { UIMessage } from "ai";
import { BotIcon, PanelRightCloseIcon, PanelRightOpenIcon, RotateCcwIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useRef, useState } from "react";
import { Conversation, ConversationContent, ConversationScrollButton } from "@/components/ai-elements/conversation";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Button } from "@/components/ui/button";
import type { ChatBody, ChatState, ReportView } from "@/server/chat-agent";
import type { LogEntry } from "@/server/logs";
import { DEFAULT_MODEL } from "@/server/models";
import { SUBAGENT_LABELS } from "@/server/subagent-labels";
import type { Session, Thread } from "@/server/thread-index";
import { USER_ID } from "./app";
import { Composer } from "./components/composer";
import { EmptyState } from "./components/empty-state";
import { Inspector } from "./components/inspector";
import { MessageView } from "./components/message-view";
import { StatusDot } from "./components/sidebar";
import { spring } from "./lib/motion";

type Props = {
  thread: Thread;
  /** When set, this view is a sub-agent session inside `thread`. */
  session?: Session;
  onBranch: (messageId: string) => void;
  onNavigate: (threadId: string, sessionId?: string | null) => void;
};

/**
 * One view for both a chat thread and a sub-agent session. A session is the
 * same kind of agent, reached through its parent's URL:
 * /agents/chat-agent/<thread>/sub/sub-agent/<runId>
 */
export function Chat({ thread, session, onBranch, onNavigate }: Props) {
  const [model, setModel] = useState<string>(DEFAULT_MODEL);
  const [simulateError, setSimulateError] = useState(false);
  const [reports, setReports] = useState<ReportView[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [showInspector, setShowInspector] = useState(true);
  const [connected, setConnected] = useState(false);

  // Read the latest values when a request is sent (body is a function).
  const bodyRef = useRef<ChatBody>({});
  bodyRef.current = { model, simulateError, userId: USER_ID };

  // One WebSocket to this thread's ChatAgent Durable Object (or to one of its sub-agents).
  const agent = useAgent<ChatState>({
    agent: "ChatAgent",
    name: thread.id,
    sub: session ? [{ agent: "SubAgent", name: session.runId }] : undefined,
    onStateUpdate: (state) => setReports(state.reports ?? []),
    onOpen: () => {
      setConnected(true);
      agent.call<LogEntry[]>("getLogs", []).then(setLogs).catch(console.error);
    },
    onClose: () => setConnected(false),
    // Custom frames from the server: live log lines.
    onMessage: (event: MessageEvent) => {
      if (typeof event.data !== "string" || !event.data.includes('"app:log"')) return;
      const frame = JSON.parse(event.data) as { type: string; entry: LogEntry };
      if (frame.type === "app:log") setLogs((prev) => [...prev.slice(-499), frame.entry]);
    }
  });

  // Messages, streaming, resume, approvals — all over that same socket.
  const chat = useAgentChat({ agent, body: () => bodyRef.current });
  const { messages, sendMessage, status, error, regenerate, stop, clearError, addToolApprovalResponse, isRecovering } = chat;

  // Live timelines of sub-agent runs, keyed by the parent tool call.
  const agentTools = useAgentToolEvents<UIMessage["parts"][number]>({ agent });

  const busy = status === "submitted" || status === "streaming" || chat.isServerStreaming;
  const lastAssistantId = [...messages].reverse().find((m) => m.role === "assistant")?.id;

  const retry = useCallback(() => {
    clearError();
    setSimulateError(false);
    bodyRef.current = { ...bodyRef.current, simulateError: false };
    regenerate();
  }, [clearError, regenerate]);

  return (
    <div className="flex min-w-0 flex-1" data-testid="chat" data-thread={thread.id} data-session={session?.runId ?? ""}>
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-3 border-b px-4">
          <div className="flex min-w-0 flex-1 items-center gap-1.5 text-sm">
            <span className="text-subtle">Chats</span>
            <span className="text-subtle">/</span>
            {session ? (
              <>
                <button
                  type="button"
                  onClick={() => onNavigate(thread.id)}
                  className="max-w-[220px] truncate text-muted-foreground transition-colors hover:text-foreground"
                  data-testid="session-parent"
                >
                  {thread.title}
                </button>
                <span className="text-subtle">/</span>
                <BotIcon className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="shrink-0 text-muted-foreground">{SUBAGENT_LABELS[session.subagentType] ?? "Sub-agent"}</span>
                <span className="truncate font-medium" data-testid="thread-title">
                  {session.description}
                </span>
                <StatusDot status={session.status} />
              </>
            ) : (
              <span className="truncate font-medium" data-testid="thread-title">
                {thread.title}
              </span>
            )}
          </div>
          <span
            className="flex h-6 items-center gap-1.5 rounded-full border px-2 text-2xs text-muted-foreground"
            data-testid="connection"
          >
            <span className={`size-1.5 rounded-full ${connected ? "bg-success shadow-[0_0_8px] shadow-success/60" : "animate-pulse bg-warning"}`} />
            {connected ? "Live" : "Reconnecting"}
          </span>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Toggle inspector"
            className="size-8 text-muted-foreground hover:text-foreground"
            onClick={() => setShowInspector((v) => !v)}
          >
            {showInspector ? <PanelRightCloseIcon className="size-4" /> : <PanelRightOpenIcon className="size-4" />}
          </Button>
        </header>

        <Conversation className="flex-1">
          <ConversationContent className="mx-auto w-full max-w-[760px] gap-7 px-6 pt-8 pb-10">
            {messages.length === 0 && session ? (
              <Shimmer className="text-sm text-muted-foreground">Loading the sub-agent session…</Shimmer>
            ) : messages.length === 0 ? (
              <EmptyState onPick={(text) => sendMessage({ text })} />
            ) : (
              messages.map((message, i) => (
                <MessageView
                  key={message.id}
                  message={message}
                  isStreaming={busy && i === messages.length - 1}
                  isLast={message.id === lastAssistantId}
                  agentTools={agentTools}
                  onApprove={(id, approved) => addToolApprovalResponse({ id, approved })}
                  onBranch={session ? undefined : () => onBranch(message.id)}
                  onOpenSession={(runId) => onNavigate(thread.id, runId)}
                  onRetry={retry}
                  canRetry={!busy}
                />
              ))
            )}

            {status === "submitted" && (
              <Shimmer className="text-sm text-muted-foreground" duration={1.4}>
                Thinking…
              </Shimmer>
            )}

            <AnimatePresence>
              {isRecovering && (
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={spring}
                  className="rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning"
                  data-testid="recovering"
                >
                  Recovering the interrupted turn… it picks up where it stopped.
                </motion.div>
              )}
              {error && (
                <motion.div
                  key="error"
                  initial={{ opacity: 0, y: 8, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.98 }}
                  transition={spring}
                  role="alert"
                  data-testid="chat-error"
                  className="flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/[0.06] px-4 py-3 text-sm"
                >
                  <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-foreground">The model call failed</div>
                    <div className="mt-0.5 font-mono text-xs break-words text-muted-foreground">{error.message}</div>
                  </div>
                  <Button size="sm" onClick={retry} data-testid="retry" className="h-8 rounded-lg">
                    <RotateCcwIcon className="size-3.5" /> Retry
                  </Button>
                  <Button size="icon" variant="ghost" className="size-8" aria-label="Dismiss" onClick={clearError}>
                    <XIcon className="size-4" />
                  </Button>
                </motion.div>
              )}
            </AnimatePresence>
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>

        <div className="mx-auto w-full max-w-[760px] px-6 pb-4">
          <Composer
            minimal={Boolean(session)}
            placeholder={session ? "Message this sub-agent directly" : undefined}
            status={status}
            busy={busy}
            model={model}
            onModelChange={setModel}
            simulateError={simulateError}
            onSimulateErrorChange={setSimulateError}
            onSend={(message) => sendMessage(message)}
            onStop={stop}
          />
        </div>
      </section>

      <AnimatePresence initial={false}>
        {showInspector && (
          <motion.div
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: 360, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={spring}
            className="shrink-0 overflow-hidden border-l bg-sidebar"
          >
            <Inspector
              logs={logs}
              reports={reports}
              onClearLogs={() => {
                agent.call("clearLogs", []).then(() => setLogs([]));
              }}
              onCancelReport={(runId) => agent.call("cancelReport", [runId])}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
