import type { ChatStatus, FileUIPart } from "ai";
import {
  ArrowUpIcon,
  PaperclipIcon,
  SquareIcon,
  ZapOffIcon,
} from "lucide-react";
import { useState } from "react";
import {
  Attachment,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from "@/components/ai-elements/attachments";
import {
  PromptInput,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputHeader,
  type PromptInputMessage,
  PromptInputProvider,
  PromptInputSelect,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectTrigger,
  PromptInputSelectValue,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputAttachments,
} from "@/components/ai-elements/prompt-input";
import { cn } from "@/lib/utils";
import { MODELS } from "@/server/models";
import { uploadAttachments } from "../lib/upload";

type Props = {
  status: ChatStatus;
  busy: boolean;
  model: string;
  onModelChange: (model: string) => void;
  simulateError: boolean;
  onSimulateErrorChange: (value: boolean) => void;
  onSend: (message: { text: string; files?: FileUIPart[] }) => void;
  onStop: () => void;
  /** Sub-agent sessions run a fixed model, so hide the model picker and error toggle. */
  minimal?: boolean;
  placeholder?: string;
};

function PendingAttachments() {
  const attachments = usePromptInputAttachments();
  if (attachments.files.length === 0) return null;
  return (
    <Attachments variant="inline" className="px-1 pt-1">
      {attachments.files.map((file) => (
        <Attachment
          key={file.id}
          data={file}
          onRemove={() => attachments.remove(file.id)}
        >
          <AttachmentPreview />
          <AttachmentRemove />
        </Attachment>
      ))}
    </Attachments>
  );
}

function AttachButton() {
  const attachments = usePromptInputAttachments();
  return (
    <PromptInputButton
      tooltip="Attach images or files"
      onClick={() => attachments.openFileDialog()}
      className="size-8 rounded-lg text-muted-foreground hover:text-foreground"
      data-testid="attach"
    >
      <PaperclipIcon className="size-4" />
    </PromptInputButton>
  );
}

export function Composer({
  status,
  busy,
  model,
  onModelChange,
  simulateError,
  onSimulateErrorChange,
  onSend,
  onStop,
  minimal,
  placeholder,
}: Props) {
  const [uploadError, setUploadError] = useState<string | null>(null);

  const submit = async ({ text: value, files }: PromptInputMessage) => {
    if (!value.trim() && !files?.length) return;
    setUploadError(null);
    try {
      // Attachments go to R2 first; the message only carries their URLs.
      const stored = files?.length ? await uploadAttachments(files) : undefined;
      onSend({ text: value.trim() || "What is in this file?", files: stored });
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : String(error));
      throw error; // keep the attachments in the input so the user can retry
    }
  };

  return (
    // The provider keeps the input state, so submitting never calls form.reset()
    // (which would also reset the model picker back to its first option).
    <PromptInputProvider>
      <div className="relative">
        <div className="composer-glow pointer-events-none absolute -inset-x-10 -top-10 bottom-0" />
        {uploadError && (
          <div className="relative mb-2 text-xs text-destructive">
            {uploadError}
          </div>
        )}
        <PromptInput
          onSubmit={submit}
          multiple
          globalDrop
          maxFiles={4}
          maxFileSize={20 * 1024 * 1024}
          accept="image/*,application/pdf,text/*,.md,.csv,.json"
          className="relative"
        >
          <PromptInputHeader>
            <PendingAttachments />
          </PromptInputHeader>
          <PromptInputBody>
            <PromptInputTextarea
              placeholder={placeholder ?? "Ask anything, or drop an image"}
              className="min-h-[52px] px-4 pt-3.5 text-base placeholder:text-subtle"
              data-testid="prompt"
            />
          </PromptInputBody>
          <PromptInputFooter className="px-2.5 pb-2.5">
            <PromptInputTools className="gap-1">
              <AttachButton />
              {!minimal && (
                <>
                  <PromptInputSelect
                    value={model}
                    onValueChange={onModelChange}
                  >
                    <PromptInputSelectTrigger
                      data-testid="model-select"
                      className="h-8 gap-1.5 rounded-lg border-none bg-transparent px-2 text-xs text-muted-foreground shadow-none hover:bg-accent hover:text-foreground dark:bg-transparent"
                    >
                      <PromptInputSelectValue />
                    </PromptInputSelectTrigger>
                    <PromptInputSelectContent>
                      {MODELS.map((m) => (
                        <PromptInputSelectItem
                          key={m.id}
                          value={m.id}
                          className="text-xs"
                        >
                          {m.name}
                        </PromptInputSelectItem>
                      ))}
                    </PromptInputSelectContent>
                  </PromptInputSelect>
                  <button
                    type="button"
                    onClick={() => onSimulateErrorChange(!simulateError)}
                    title="Send the next message to a model that does not exist, to see error display and Retry"
                    data-testid="simulate-error"
                    data-on={simulateError}
                    className={cn(
                      "flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs transition-colors",
                      simulateError
                        ? "bg-destructive/12 text-destructive"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground",
                    )}
                  >
                    <ZapOffIcon className="size-3.5" />
                    {simulateError ? "Next send fails" : "Simulate error"}
                  </button>
                </>
              )}
            </PromptInputTools>
            <PromptInputSubmit
              status={busy && status === "ready" ? "streaming" : status}
              onStop={onStop}
              data-testid="send"
              className="size-8 rounded-full bg-foreground text-background hover:bg-foreground/90 disabled:opacity-40"
            >
              {busy ? (
                <SquareIcon className="size-3 fill-current" />
              ) : (
                <ArrowUpIcon className="size-4" strokeWidth={2.25} />
              )}
            </PromptInputSubmit>
          </PromptInputFooter>
        </PromptInput>
        <p className="relative mt-2 text-center text-2xs text-subtle">
          Runs on a Durable Object · models via Vercel AI Gateway
        </p>
      </div>
    </PromptInputProvider>
  );
}
