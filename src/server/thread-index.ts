import { Agent, callable, getAgentByName } from "agents";

export type Thread = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Set when this thread was branched from another one. */
  parentId?: string;
  branchedFromMessageId?: string;
};

/** A sub-agent run, listed under the thread that started it. */
export type Session = {
  runId: string;
  threadId: string;
  agentClass: string;
  subagentType: string;
  description: string;
  background: boolean;
  status: string;
  startedAt: number;
  completedAt?: number;
};

export type ThreadIndexState = { threads: Thread[]; sessions: Session[] };

/**
 * One ThreadIndex per user: the list of their conversations and the branch
 * tree. Each conversation is its own ChatAgent Durable Object; this index only
 * keeps metadata, so listing never wakes the chats. The state syncs to every
 * open tab automatically (useAgent → onStateUpdate).
 * https://developers.cloudflare.com/agents/api-reference/store-and-sync-state/
 */
export class ThreadIndex extends Agent<Env, ThreadIndexState> {
  initialState: ThreadIndexState = { threads: [], sessions: [] };

  @callable()
  createThread(title = "New chat"): Thread {
    const now = Date.now();
    const thread: Thread = { id: crypto.randomUUID(), title, createdAt: now, updatedAt: now };
    this.setState({ ...this.state, threads: [thread, ...this.state.threads] });
    return thread;
  }

  @callable()
  renameThread(id: string, title: string) {
    this.update(id, { title });
  }

  @callable()
  async deleteThread(id: string) {
    const chat = await getAgentByName(this.env.ChatAgent, id);
    await chat.destroy(); // wipes that conversation's Durable Object storage
    this.setState({
      threads: this.state.threads.filter((t) => t.id !== id),
      sessions: (this.state.sessions ?? []).filter((s) => s.threadId !== id)
    });
  }

  /**
   * Branch: copy a thread's history up to one message into a new thread.
   * The original is untouched, so both conversations can continue.
   */
  @callable()
  async branchThread(sourceId: string, messageId: string): Promise<Thread> {
    const source = await getAgentByName(this.env.ChatAgent, sourceId);
    const history = await source.exportUntil(messageId);
    const parent = this.state.threads.find((t) => t.id === sourceId);
    const thread = this.createThread(`${parent?.title ?? "Chat"} (branch)`);
    const target = await getAgentByName(this.env.ChatAgent, thread.id);
    await target.importHistory(history);
    this.update(thread.id, { parentId: sourceId, branchedFromMessageId: messageId });
    return { ...thread, parentId: sourceId, branchedFromMessageId: messageId };
  }

  /** Called by a ChatAgent on every turn: keeps the title and sort order fresh. */
  async touch(id: string, firstMessage: string) {
    const thread = this.state.threads.find((t) => t.id === id);
    if (!thread) return;
    const title = thread.title === "New chat" ? firstMessage : thread.title;
    this.update(id, { title, updatedAt: Date.now() });
  }

  /** Called by a ChatAgent when a sub-agent run starts or finishes. */
  async recordSession(session: Session) {
    const sessions = (this.state.sessions ?? []).filter((s) => s.runId !== session.runId);
    this.setState({ ...this.state, sessions: [session, ...sessions].slice(0, 500) });
  }

  private update(id: string, patch: Partial<Thread>) {
    this.setState({ ...this.state, threads: this.state.threads.map((t) => (t.id === id ? { ...t, ...patch } : t)) });
  }
}
