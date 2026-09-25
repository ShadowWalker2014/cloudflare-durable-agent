import { useAgent } from "agents/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Session, Thread, ThreadIndexState } from "@/server/thread-index";
import { Chat } from "./chat";
import { Sidebar } from "./components/sidebar";

/**
 * Demo only: each browser gets its own anonymous workspace (a random id kept in
 * localStorage); `?user=` picks one explicitly. A real app takes this from its auth session.
 */
export const USER_ID = new URL(window.location.href).searchParams.get("user") ?? anonymousId();

function anonymousId() {
  try {
    const saved = localStorage.getItem("workspace");
    if (saved) return saved;
    const id = crypto.randomUUID();
    localStorage.setItem("workspace", id);
    return id;
  } catch (error) {
    console.error("localStorage unavailable; using a per-tab workspace", error);
    return crypto.randomUUID();
  }
}

type Route = { threadId: string | null; sessionId: string | null };

function readRoute(): Route {
  const params = new URL(window.location.href).searchParams;
  return { threadId: params.get("t"), sessionId: params.get("s") };
}

export function App() {
  const [threads, setThreads] = useState<Thread[] | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [route, setRoute] = useState<Route>(readRoute);
  const creating = useRef(false);

  // The per-user index. Its state (threads + sub-agent sessions) syncs live to every tab.
  const index = useAgent<ThreadIndexState>({
    agent: "ThreadIndex",
    name: USER_ID,
    onStateUpdate: (state) => {
      setThreads(state.threads);
      setSessions(state.sessions ?? []);
    }
  });

  const navigate = useCallback((threadId: string, sessionId: string | null = null) => {
    setRoute({ threadId, sessionId });
    const url = new URL(window.location.href);
    url.searchParams.set("t", threadId);
    if (sessionId) url.searchParams.set("s", sessionId);
    else url.searchParams.delete("s");
    window.history.pushState(null, "", url);
  }, []);

  const createThread = useCallback(async () => {
    try {
      const thread = await index.call<Thread>("createThread", []);
      navigate(thread.id);
    } catch (error) {
      console.error("createThread failed", error);
    }
  }, [index, navigate]);

  // First visit: pick the newest thread, or create one.
  useEffect(() => {
    if (!threads) return;
    if (route.threadId && threads.some((t) => t.id === route.threadId)) return;
    if (threads.length > 0) {
      navigate(threads[0].id);
      return;
    }
    if (creating.current) return;
    creating.current = true;
    createThread().finally(() => {
      creating.current = false;
    });
  }, [threads, route.threadId, navigate, createThread]);

  useEffect(() => {
    const onPop = () => setRoute(readRoute());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const branch = useCallback(
    async (messageId: string) => {
      if (!route.threadId) return;
      try {
        const thread = await index.call<Thread>("branchThread", [route.threadId, messageId]);
        navigate(thread.id);
      } catch (error) {
        console.error("fork failed", error);
      }
    },
    [index, route.threadId, navigate]
  );

  const remove = useCallback(
    async (id: string) => {
      try {
        await index.call("deleteThread", [id]);
        if (id === route.threadId) setRoute({ threadId: null, sessionId: null });
      } catch (error) {
        console.error("deleteThread failed", error);
      }
    },
    [index, route.threadId]
  );

  const thread = threads?.find((t) => t.id === route.threadId);
  const session = sessions.find((s) => s.runId === route.sessionId && s.threadId === route.threadId);

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-background">
      <Sidebar
        threads={threads ?? []}
        sessions={sessions}
        activeThreadId={route.threadId}
        activeSessionId={route.sessionId}
        onSelect={navigate}
        onCreate={createThread}
        onDelete={remove}
      />
      <main className="flex min-w-0 flex-1">
        {thread ? (
          <Chat
            key={`${thread.id}/${session?.runId ?? ""}`}
            thread={thread}
            session={session}
            onBranch={branch}
            onNavigate={navigate}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Connecting…</div>
        )}
      </main>
    </div>
  );
}
