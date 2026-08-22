import type { RunView } from "./types.js";

export type NextWork =
  | Readonly<{ kind: "snapshot"; key: string }>
  | Readonly<{ kind: "plan"; key: string }>
  | Readonly<{ kind: "prepare_sailbox"; key: string }>
  | Readonly<{ kind: "review"; key: string }>
  | Readonly<{ kind: "challenge"; key: string }>
  | Readonly<{ kind: "reduce"; key: string }>
  | Readonly<{ kind: "publish"; key: string }>
  | Readonly<{ kind: "cleanup"; key: string }>
  | Readonly<{ kind: "none"; reason: "terminal" | "already_scheduled" }>;

export const deriveNextWork = (view: RunView, nowMs: number): NextWork => {
  void nowMs;
  const candidate = ((): NextWork => {
    switch (view.state.kind) {
      case "accepted":
      case "snapshotting":
        return { kind: "snapshot", key: `${view.runId}:snapshot` };
      case "planning":
        return { kind: "plan", key: `${view.runId}:plan` };
      case "preparing_sailbox":
        return { kind: "prepare_sailbox", key: `${view.runId}:sailbox` };
      case "reviewing":
        return { kind: "review", key: `${view.runId}:review` };
      case "challenging":
        return { kind: "challenge", key: `${view.runId}:challenge` };
      case "reducing":
        return { kind: "reduce", key: `${view.runId}:reduce` };
      case "publishing":
        return { kind: "publish", key: `${view.runId}:publish` };
      case "cleaning_up":
        return { kind: "cleanup", key: `${view.runId}:cleanup` };
      case "completed":
      case "failed":
        return { kind: "none", reason: "terminal" };
      default: {
        const exhaustive: never = view.state;
        return exhaustive;
      }
    }
  })();
  if (candidate.kind !== "none" && view.pendingWorkKeys.includes(candidate.key))
    return { kind: "none", reason: "already_scheduled" };
  return candidate;
};
