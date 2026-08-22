import { reviewerId, type ReviewerId } from "./ids.js";

export type ReviewerDefinition = Readonly<{
  id: ReviewerId;
  label: string;
  question: string;
  optional: boolean;
}>;

const definitions = [
  [
    "security",
    "Security",
    "Can an attacker cross a trust boundary or control a sensitive operation?",
    false,
  ],
  [
    "performance",
    "Performance",
    "Can the change cause material latency, memory, I/O, or algorithmic growth?",
    false,
  ],
  [
    "api-compatibility",
    "API compatibility",
    "Does the change break a public caller, wire format, or persisted contract?",
    false,
  ],
  [
    "adversarial-testing",
    "Adversarial testing",
    "Which hostile or malformed input breaks the new behavior?",
    false,
  ],
  [
    "documentation",
    "Documentation",
    "Do the docs match implementation and required migration steps?",
    false,
  ],
  [
    "new-user-simulation",
    "New-user simulation",
    "Can a new contributor follow setup from a clean checkout?",
    false,
  ],
  [
    "dependency-history",
    "Dependency history",
    "Does a dependency change reintroduce a known problem or violate version policy?",
    false,
  ],
  [
    "edge-cases",
    "Edge cases",
    "Which boundary value, lifecycle state, platform, or ordering is missing?",
    false,
  ],
  [
    "test-quality",
    "Test quality",
    "Do tests prove the changed contract and fail for the intended reason?",
    true,
  ],
  [
    "concurrency",
    "Concurrency",
    "Can retries, parallel calls, or crashes corrupt shared state?",
    true,
  ],
] satisfies readonly (readonly [string, string, string, boolean])[];

export const REVIEWER_REGISTRY: readonly ReviewerDefinition[] = definitions.map(
  ([id, label, question, optional]) => ({
    id: reviewerId(id),
    label,
    question,
    optional,
  }),
);

export const CORE_REVIEWERS = REVIEWER_REGISTRY.filter(
  (reviewer) => !reviewer.optional,
);
export const OPTIONAL_REVIEWERS = REVIEWER_REGISTRY.filter(
  (reviewer) => reviewer.optional,
);

export const selectReviewers = (
  requestedOptionalIds: readonly string[],
): readonly ReviewerDefinition[] => {
  const requested = new Set(requestedOptionalIds);
  const optional = OPTIONAL_REVIEWERS.filter((reviewer) =>
    requested.has(reviewer.id),
  );
  return [...CORE_REVIEWERS, ...optional].slice(0, 10);
};
