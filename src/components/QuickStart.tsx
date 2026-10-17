import { Terminal } from "lucide-react";

import type { AgentKind } from "../../shared/protocol.ts";
import { AgentMark } from "./AgentMark.tsx";

/** The quick starts, in key order (1, 2…); "" is a plain shell. Fixed, so a key always means the same thing. */
const QUICK_KINDS = ["claude", ""] as const;

/** The kind key N starts (index N-1), or undefined when that one is not on offer: herdr may not list the agent, or not yet. */
export function quickStartKinds(agents: readonly AgentKind[]): (string | undefined)[] {
  return QUICK_KINDS.map((kind) => (kind === "" || agents.some((agent) => agent.kind === kind) ? kind : undefined));
}

export interface QuickStartProps {
  agents: readonly AgentKind[];
  disabled: boolean;
  onStart: (kind: string) => void;
}

/** One click (or its number key) starts a New tab with that agent, without the picker and Start. */
export function QuickStart({ agents, disabled, onStart }: QuickStartProps) {
  const offered = quickStartKinds(agents);
  return (
    <div className="new-session-quick">
      {QUICK_KINDS.map((kind, index) => {
        // the shell entry is a program name like the agents beside it, so it stays in English (AgentPicker)
        const label = kind ? agents.find((agent) => agent.kind === kind)?.label ?? "Claude Code" : "Shell";
        return (
          <button key={kind || "shell"} type="button" className="new-session-quick-block" disabled={disabled || offered[index] === undefined}
            aria-keyshortcuts={String(index + 1)} onClick={() => onStart(kind)}>
            {kind ? <AgentMark agent={kind} size={20} /> : <span className="agent-picker-shell"><Terminal aria-hidden="true" /></span>}
            <span className="new-session-quick-label">{label}</span>
            <kbd className="kbd">{index + 1}</kbd>
          </button>
        );
      })}
    </div>
  );
}
