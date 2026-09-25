import type { useAgentToolEvents } from "agents/react";
import { getToolName, isStaticToolUIPart, type ToolUIPart, type UIMessage } from "ai";
import { CheckIcon, CopyIcon, GitBranchIcon, RotateCcwIcon, XIcon } from "lucide-react";
import { motion } from "motion/react";
import { useState } from "react";
import { Attachment, AttachmentInfo, AttachmentPreview, Attachments } from "@/components/ai-elements/attachments";
import {
  Confirmation,
  ConfirmationAccepted,
  ConfirmationAction,
  ConfirmationActions,
  ConfirmationRejected,
  ConfirmationRequest
} from "@/components/ai-elements/confirmation";
import { Message, MessageAction, MessageActions, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "@/components/ai-elements/tool";
import { cn } from "@/lib/utils";
import { SUBAGENT_LABELS } from "@/server/subagent-labels";
import { spring } from "../lib/motion";
import { SubagentRuns } from "./subagent-runs";

type AgentTools = ReturnType<typeof useAgentToolEvents<UIMessage["parts"][number]>>;

type Props = {
  message: UIMessage;
  isStreaming: boolean;
  isLast: boolean;
  canRetry: boolean;
  agentTools: AgentTools;
  onApprove: (approvalId: string, approved: boolean) => void;
  onBranch?: () => void;
  onOpenSession: (runId: string) => void;
  onRetry: () => void;
};

const TOOL_TITLES: Record<string, string> = {
  getWeather: "Weather",
  agent: "Sub-agent",
  sendEmail: "Send email",
  startReport: "Background report"
};

export function MessageView({ message, isStreaming, isLast, canRetry, agentTools, onApprove, onBranch, onOpenSession, onRetry }: Props) {
  const [copied, setCopied] = useState(false);
  const files = message.parts.filter((p) => p.type === "file");
  const text = message.parts
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n\n");
  const source = (message.metadata as { source?: string } | undefined)?.source;
  const fromTask = source === "background-task";
  const fromSubagent = source === "subagent";

  return (
    <motion.div
      // Transform only: a stalled animation must never leave a message invisible.
      initial={{ y: 14, scale: 0.985 }}
      animate={{ y: 0, scale: 1 }}
      transition={spring}
      data-testid={`message-${message.role}`}
      data-message-id={message.id}
    >
      <Message from={message.role} className="max-w-full">
        <MessageContent className="gap-3 text-base group-[.is-user]:max-w-[80%] group-[.is-user]:rounded-2xl group-[.is-user]:bg-muted group-[.is-user]:px-4 group-[.is-user]:py-2.5">
          {fromTask && (
            <div className="inline-flex w-fit items-center gap-1.5 rounded-full border border-brand/30 bg-brand/10 px-2 py-0.5 text-2xs font-medium text-brand">
              Delivered by a background task
            </div>
          )}
          {fromSubagent && (
            <div className="inline-flex w-fit items-center gap-1.5 rounded-full border px-2 py-0.5 text-2xs font-medium text-muted-foreground" data-testid="subagent-notice">
              Background sub-agent finished
            </div>
          )}

          {files.length > 0 && (
            <Attachments variant={message.role === "user" ? "grid" : "list"} className="mb-1">
              {files.map((file, i) => (
                <Attachment key={`${message.id}-f${i}`} data={{ ...file, id: `${message.id}-f${i}` }}>
                  <AttachmentPreview />
                  {!file.mediaType.startsWith("image/") && <AttachmentInfo />}
                </Attachment>
              ))}
            </Attachments>
          )}

          {message.parts.map((part, i) => {
            const key = `${message.id}-${i}`;
            if (part.type === "text") return <MessageResponse key={key} className="prose-chat">{part.text}</MessageResponse>;
            if (part.type === "reasoning") {
              const streamingThis = isStreaming && i === message.parts.length - 1;
              return (
                <Reasoning key={key} isStreaming={streamingThis} className="mb-0 w-full text-muted-foreground">
                  <ReasoningTrigger />
                  <ReasoningContent>{part.text}</ReasoningContent>
                </Reasoning>
              );
            }
            if (isStaticToolUIPart(part)) {
              return <ToolPartView key={key} part={part} agentTools={agentTools} onApprove={onApprove} onOpenSession={onOpenSession} />;
            }
            return null;
          })}
        </MessageContent>

        {!isStreaming && (text || message.role === "user") && (
          <MessageActions className={cn("-mt-1 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100", message.role === "user" ? "justify-end" : "-ml-2", isLast && "opacity-100")}>
            {text && (
              <MessageAction
                tooltip={copied ? "Copied" : "Copy"}
                onClick={() => {
                  navigator.clipboard.writeText(text);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1200);
                }}
              >
                {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
              </MessageAction>
            )}
            {onBranch && (
              <MessageAction tooltip="Branch from here" onClick={onBranch} data-testid="branch">
                <GitBranchIcon className="size-3.5" />
              </MessageAction>
            )}
            {isLast && message.role === "assistant" && (
              <MessageAction tooltip="Regenerate" onClick={onRetry} disabled={!canRetry} data-testid="regenerate">
                <RotateCcwIcon className="size-3.5" />
              </MessageAction>
            )}
          </MessageActions>
        )}
      </Message>
    </motion.div>
  );
}

function ToolPartView({
  part,
  agentTools,
  onApprove,
  onOpenSession
}: {
  part: ToolUIPart;
  agentTools: AgentTools;
  onApprove: (approvalId: string, approved: boolean) => void;
  onOpenSession: (runId: string) => void;
}) {
  const name = getToolName(part);
  const agentInput = name === "agent" ? (part.input as { description?: string; subagent_type?: string } | undefined) : undefined;
  const title = agentInput?.description
    ? `${SUBAGENT_LABELS[agentInput.subagent_type ?? ""] ?? "Sub-agent"} · ${agentInput.description}`
    : (TOOL_TITLES[name] ?? name);

  // Human in the loop: render an approval card instead of a tool card.
  if (part.approval) {
    const input = (part.input ?? {}) as { to?: string; subject?: string; body?: string };
    return (
      <Confirmation approval={part.approval} state={part.state} className="w-full rounded-xl border-border-strong bg-card p-4" data-testid="approval">
        <ConfirmationRequest>
          <div className="space-y-1">
            <div className="font-medium">Send this email?</div>
            <div className="text-muted-foreground">
              To <span className="font-mono text-foreground">{input.to}</span> — “{input.subject}”
            </div>
            {input.body && <div className="whitespace-pre-wrap rounded-md bg-muted/60 p-2 text-xs">{input.body}</div>}
          </div>
        </ConfirmationRequest>
        <ConfirmationAccepted>
          <CheckIcon className="size-4 text-success" /> <span>Approved — email sent</span>
        </ConfirmationAccepted>
        <ConfirmationRejected>
          <XIcon className="size-4 text-destructive" /> <span>Rejected — nothing was sent</span>
        </ConfirmationRejected>
        <ConfirmationActions>
          <ConfirmationAction variant="outline" onClick={() => onApprove(part.approval!.id, false)} data-testid="reject">
            Reject
          </ConfirmationAction>
          <ConfirmationAction onClick={() => onApprove(part.approval!.id, true)} data-testid="approve">
            Approve
          </ConfirmationAction>
        </ConfirmationActions>
      </Confirmation>
    );
  }

  const runs = name === "agent" ? agentTools.getRunsForToolCall(part.toolCallId) : [];

  return (
    <Tool defaultOpen={name === "agent"} className="mb-0 overflow-hidden rounded-xl bg-card" data-testid={`tool-${name}`}>
      <ToolHeader type={part.type} state={part.state} title={title} className="px-3.5 py-2.5 [&_span]:text-sm" />
      <ToolContent className="space-y-3 border-t px-3.5 py-3">
        {name !== "agent" && <ToolInput input={part.input} />}
        {runs.length > 0 ? (
          // The sub-agent's own live timeline replaces the raw tool output.
          <SubagentRuns runs={runs} onOpen={onOpenSession} />
        ) : (
          <ToolOutput output={part.output} errorText={part.errorText} />
        )}
      </ToolContent>
    </Tool>
  );
}
