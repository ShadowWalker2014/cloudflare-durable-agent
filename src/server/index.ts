import { routeAgentRequest } from "agents";
import { handleFiles } from "./files";

// Every Durable Object class must be exported from the Worker entry.
export { ChatAgent } from "./chat-agent";
export { SubAgent } from "./subagent";
export { ThreadIndex } from "./thread-index";

/**
 * One Worker serves everything: the React app (static assets), the agents'
 * WebSockets and HTTP (/agents/<class>/<name>), and file uploads (/api/files).
 * https://developers.cloudflare.com/agents/api-reference/routing/
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/files")) return handleFiles(request, env);

    // A real app authenticates here (or in onBeforeConnect) before routing.
    return (await routeAgentRequest(request, env)) ?? new Response("Not found", { status: 404 });
  }
} satisfies ExportedHandler<Env>;
