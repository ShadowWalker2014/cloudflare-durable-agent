import { ArrowUpRightIcon, BotIcon, CloudSunIcon, FileTextIcon, MailIcon, ScrollTextIcon } from "lucide-react";
import { motion } from "motion/react";
import { spring } from "../lib/motion";
import { Logo } from "./sidebar";

const SUGGESTIONS = [
  { icon: CloudSunIcon, title: "Call a tool", text: "What's the weather in London right now?" },
  { icon: BotIcon, title: "Run sub-agents in parallel", text: "Use two researcher sub-agents in parallel: one on Cloudflare Durable Objects, one on Vercel Workflow. Then compare them." },
  { icon: MailIcon, title: "Ask for approval", text: "Email kai@example.com a two-line haiku about resumable streams" },
  { icon: FileTextIcon, title: "Run a background task", text: "Write me a report on edge computing" },
  { icon: ScrollTextIcon, title: "Stream, then refresh", text: "Write a 500-word story about a lighthouse keeper" }
];

export function EmptyState({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="flex flex-col items-center pt-[12vh] pb-10">
      <motion.div
        initial={{ scale: 0.7, opacity: 0, rotate: -12 }}
        animate={{ scale: 1, opacity: 1, rotate: 0 }}
        transition={spring}
        className="mb-6 grid size-11 place-items-center rounded-xl border border-border-strong bg-card"
      >
        <Logo className="size-5 text-foreground" />
      </motion.div>
      <motion.h1
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ ...spring, delay: 0.04 }}
        className="text-[28px] leading-9 font-medium tracking-[-0.025em]"
      >
        What should your agent do?
      </motion.h1>
      <motion.p
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ ...spring, delay: 0.08 }}
        className="mt-2 max-w-md text-center text-sm text-muted-foreground"
      >
        Every chat is a Durable Object on Cloudflare. Close the tab, refresh, or redeploy — the work keeps going.
      </motion.p>

      <div className="mt-9 grid w-full max-w-2xl grid-cols-2 gap-2">
        {SUGGESTIONS.map((s, i) => (
          <motion.button
            key={s.text}
            type="button"
            onClick={() => onPick(s.text)}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ ...spring, delay: 0.12 + 0.04 * i }}
            whileHover={{ y: -2 }}
            whileTap={{ scale: 0.98 }}
            data-testid="suggestion"
            className={`group relative flex flex-col gap-1.5 rounded-xl border bg-card p-3.5 text-left transition-colors hover:border-border-strong hover:bg-muted ${i === 4 ? "col-span-2" : ""}`}
          >
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <s.icon className="size-3.5" />
              {s.title}
              <ArrowUpRightIcon className="ml-auto size-3.5 opacity-0 transition-opacity group-hover:opacity-100" />
            </div>
            <div className="text-sm text-foreground">{s.text}</div>
          </motion.button>
        ))}
      </div>
    </div>
  );
}
