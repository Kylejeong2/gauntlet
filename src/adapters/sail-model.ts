import { z } from "zod";
import { estimateModelRequest } from "../domain/budget.js";
import { findingId, usdMicros, type ReviewerId } from "../domain/ids.js";
import {
  challengeVerdictSchema,
  reviewSummarySchema,
  reviewerReportSchema,
} from "../domain/schemas.js";
import type {
  CandidateFinding,
  ChallengeVerdict,
  ReviewSummary,
  ReviewerReport,
} from "../domain/types.js";

export const SAIL_MODEL = "deepseek/deepseek-v4-flash-0731";
export const SAIL_API_URL = "https://api.sailresearch.com/v1/responses";
export const SAIL_INPUT_USD_PER_MILLION = 0.09;
export const SAIL_OUTPUT_USD_PER_MILLION = 0.18;
export const SAIL_REQUEST_TIMEOUT_MS = 600_000;

const responseEnvelopeSchema = z.looseObject({
  id: z.string().min(1),
  status: z.string().min(1),
  output_text: z.string().optional(),
  output: z.array(z.unknown()).optional(),
  usage: z
    .object({
      input_tokens: z.number().int().nonnegative(),
      output_tokens: z.number().int().nonnegative(),
    })
    .loose(),
});

const challengeOutputSchema = z
  .object({
    outcome: z.enum(["confirmed", "rejected", "inconclusive"]),
    reason: z.string().trim().min(1).max(2_000),
  })
  .strict();

type ModelResult<T> = Readonly<{
  value: T;
  cost: ReturnType<typeof usdMicros>;
  responseId: string;
}>;

export type ReviewerRequest = Readonly<{
  reviewer: ReviewerId;
  label: string;
  question: string;
  snapshot: string;
  toolEvidence: readonly string[];
}>;

export type ChallengeRequest = Readonly<{
  finding: CandidateFinding;
  snapshot: string;
  toolEvidence: readonly string[];
}>;

export type SummaryRequest = Readonly<{
  reports: readonly ReviewerReport[];
  challenges: readonly ChallengeVerdict[];
  coverageOmissions: readonly string[];
}>;

export type SailModelAuditEvent =
  | Readonly<{
      kind: "model_request_started";
      operation: "review" | "challenge" | "summary";
      correlationId: string;
      model: string;
    }>
  | Readonly<{
      kind: "model_request_retry";
      operation: "review" | "challenge" | "summary";
      correlationId: string;
      status: number;
      attempt: number;
    }>
  | Readonly<{
      kind: "model_request_completed";
      operation: "review" | "challenge" | "summary";
      correlationId: string;
      responseId: string;
      inputTokens: number;
      outputTokens: number;
      cost: ReturnType<typeof usdMicros>;
    }>;

export class SailModelClient {
  readonly #apiKey: string;
  readonly #fetcher: typeof fetch;
  readonly #apiUrl: string;
  readonly #retryDelaysMs: readonly number[];
  readonly #requestTimeoutMs: number;
  readonly #audit: (event: SailModelAuditEvent) => void;

  public constructor(
    options: Readonly<{
      apiKey: string;
      fetcher?: typeof fetch;
      apiUrl?: string;
      retryDelaysMs?: readonly number[];
      requestTimeoutMs?: number;
      audit?: (event: SailModelAuditEvent) => void;
    }>,
  ) {
    if (options.apiKey.length === 0)
      throw new Error("SAIL_API_KEY is required");
    this.#apiKey = options.apiKey;
    this.#fetcher = options.fetcher ?? fetch;
    this.#apiUrl = options.apiUrl ?? SAIL_API_URL;
    this.#retryDelaysMs = options.retryDelaysMs ?? [
      15_000, 30_000, 60_000, 120_000, 240_000,
    ];
    this.#requestTimeoutMs =
      options.requestTimeoutMs ?? SAIL_REQUEST_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.#requestTimeoutMs) ||
      this.#requestTimeoutMs <= 0
    )
      throw new Error("requestTimeoutMs must be a positive integer");
    this.#audit =
      options.audit ??
      ((event) => {
        void event;
      });
  }

  public async review(request: ReviewerRequest): Promise<
    Readonly<{
      report: ReviewerReport;
      cost: ReturnType<typeof usdMicros>;
      responseId: string;
    }>
  > {
    const result = await this.#request(
      [
        `You are Gauntlet's ${request.label} reviewer.`,
        request.question,
        "Inspect only the supplied immutable pull-request snapshot.",
        "Return a 1-to-5 readiness score and at most three concrete defects.",
        "Keep the rationale under 120 words and every finding field under 80 words.",
        "Return only the JSON object required by the response schema.",
        "Do not report style preferences, praise, or speculative risks.",
        "Every finding must name an exact changed right-side line.",
        `Snapshot:\n${request.snapshot}`,
        request.toolEvidence.length === 0
          ? "Sandbox evidence: none requested."
          : `Sandbox evidence:\n${request.toolEvidence.join("\n\n")}`,
      ].join("\n\n"),
      "reviewer_report",
      reviewerReportJsonSchema(request.reviewer),
      { operation: "review", correlationId: request.reviewer },
    );
    const parsed = reviewerReportSchema.safeParse(
      parseJsonObject(result.value),
    );
    if (!parsed.success)
      throw new Error(
        `Invalid Sail reviewer response: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ")}`,
      );
    if (parsed.data.reviewer !== request.reviewer)
      throw new Error(
        "Invalid Sail reviewer response: reviewer identity mismatch",
      );
    return {
      report: parsed.data,
      cost: result.cost,
      responseId: result.responseId,
    };
  }

  public async challenge(request: ChallengeRequest): Promise<
    Readonly<{
      verdict: ChallengeVerdict;
      cost: ReturnType<typeof usdMicros>;
      responseId: string;
    }>
  > {
    const result = await this.#request(
      [
        "You are an independent verification reviewer.",
        "Try to disprove the candidate finding using only the supplied snapshot and evidence.",
        "Confirm only when the trigger is reachable and the evidence supports the claimed impact.",
        "Use rejected for false positives and inconclusive when proof is insufficient.",
        `Candidate finding:\n${JSON.stringify(request.finding)}`,
        `Snapshot:\n${request.snapshot}`,
        request.toolEvidence.length === 0
          ? "Sandbox evidence: none requested."
          : `Sandbox evidence:\n${request.toolEvidence.join("\n\n")}`,
      ].join("\n\n"),
      "challenge_verdict",
      challengeJsonSchema,
      { operation: "challenge", correlationId: request.finding.id },
    );
    const output = challengeOutputSchema.safeParse(
      parseJsonObject(result.value),
    );
    if (!output.success) throw new Error("Invalid Sail challenge response");
    const verdict = challengeVerdictSchema.parse({
      kind: output.data.outcome,
      findingId: findingId(request.finding.id),
      reason: output.data.reason,
    });
    return { verdict, cost: result.cost, responseId: result.responseId };
  }

  public async summarize(request: SummaryRequest): Promise<
    Readonly<{
      summary: ReviewSummary;
      cost: ReturnType<typeof usdMicros>;
      responseId: string;
    }>
  > {
    const result = await this.#request(
      [
        "You are Gauntlet's final pull-request review editor.",
        "Synthesize the specialist reports and independent challenge verdicts into a useful PR-level briefing.",
        "Write one short headline for the pull request description, a compact overview, the single most important risk, and the single next action.",
        "Treat confirmed challenge verdicts as verified, rejected verdicts as disproved, and inconclusive or failed verdicts as unresolved rather than facts.",
        "Do not invent repository changes, test results, dependencies, or findings.",
        "Keep the overview between 30 and 70 words. Keep every field concise and avoid repeating the same fact.",
        "Return only the JSON object required by the response schema.",
        `Specialist reports:\n${JSON.stringify(request.reports)}`,
        `Challenge verdicts:\n${JSON.stringify(request.challenges)}`,
        request.coverageOmissions.length === 0
          ? "Coverage omissions: none."
          : `Coverage omissions:\n${request.coverageOmissions.join("\n")}`,
      ].join("\n\n"),
      "review_summary",
      reviewSummaryJsonSchema,
      { operation: "summary", correlationId: "final-summary" },
    );
    const parsed = reviewSummarySchema.safeParse(parseJsonObject(result.value));
    if (!parsed.success)
      throw new Error(
        `Invalid Sail summary response: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ")}`,
      );
    return {
      summary: parsed.data,
      cost: result.cost,
      responseId: result.responseId,
    };
  }

  async #request(
    prompt: string,
    schemaName: string,
    schema: Record<string, unknown>,
    correlation: Readonly<{
      operation: "review" | "challenge" | "summary";
      correlationId: string;
    }>,
  ): Promise<ModelResult<string>> {
    this.#audit({
      kind: "model_request_started",
      ...correlation,
      model: SAIL_MODEL,
    });
    const body = JSON.stringify({
      model: SAIL_MODEL,
      metadata: { completion_window: "asap" },
      reasoning: { effort: "low" },
      max_output_tokens: 6000,
      input: [{ role: "user", content: prompt }],
      text: {
        format: {
          type: "json_schema",
          name: schemaName,
          strict: true,
          schema,
        },
      },
    });
    let rawBody = "";
    let responseStatus = 0;
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.#fetcher(this.#apiUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          "Content-Type": "application/json",
        },
        body,
        signal: AbortSignal.timeout(this.#requestTimeoutMs),
      });
      rawBody = await response.text();
      responseStatus = response.status;
      if (response.ok) break;
      const delay = this.#retryDelaysMs[attempt];
      const retryable = response.status === 429;
      if (!retryable || delay === undefined)
        throw new Error(
          `Sail request failed (${String(response.status)}): ${rawBody.slice(0, 500)}`,
        );
      this.#audit({
        kind: "model_request_retry",
        ...correlation,
        status: response.status,
        attempt: attempt + 1,
      });
      await wait(delay);
    }
    if (responseStatus < 200 || responseStatus >= 300)
      throw new Error(`Sail request failed (${String(responseStatus)})`);
    const envelope = responseEnvelopeSchema.parse(JSON.parse(rawBody));
    if (envelope.status !== "completed")
      throw new Error(`Sail response did not complete: ${envelope.status}`);
    const outputText =
      envelope.output_text ?? extractOutputText(envelope.output);
    if (outputText === undefined || outputText.length === 0)
      throw new Error("Sail response contained no output text");
    const cost = estimateModelRequest({
      inputTokens: envelope.usage.input_tokens,
      outputTokens: envelope.usage.output_tokens,
      inputUsdPerMillion: SAIL_INPUT_USD_PER_MILLION,
      outputUsdPerMillion: SAIL_OUTPUT_USD_PER_MILLION,
    });
    this.#audit({
      kind: "model_request_completed",
      ...correlation,
      responseId: envelope.id,
      inputTokens: envelope.usage.input_tokens,
      outputTokens: envelope.usage.output_tokens,
      cost,
    });
    return {
      value: outputText,
      responseId: envelope.id,
      cost,
    };
  }
}

const extractOutputText = (
  output: readonly unknown[] | undefined,
): string | undefined => {
  if (output === undefined) return undefined;
  for (const item of output) {
    const parsed = z
      .looseObject({
        content: z.array(
          z.looseObject({
            type: z.string().optional(),
            text: z.string().optional(),
          }),
        ),
      })
      .safeParse(item);
    if (parsed.success) {
      const text = parsed.data.content.find(
        (content) =>
          content.type === "output_text" && content.text !== undefined,
      )?.text;
      if (text !== undefined) return text;
    }
  }
  return undefined;
};

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

const parseJsonObject = (value: string): unknown => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    const end = value.lastIndexOf("}");
    for (let start = value.indexOf("{"); start >= 0 && start < end;) {
      try {
        return JSON.parse(value.slice(start, end + 1)) as unknown;
      } catch {
        start = value.indexOf("{", start + 1);
      }
    }
    throw new Error("Sail response contained no valid JSON object");
  }
};

const findingProperties = (reviewer: ReviewerId) => ({
  id: { type: "string", minLength: 1 },
  reviewer: { type: "string", const: reviewer },
  location: {
    type: "object",
    additionalProperties: false,
    required: ["path", "line"],
    properties: {
      path: { type: "string", minLength: 1 },
      line: { type: "integer", minimum: 1 },
    },
  },
  severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
  confidence: { type: "number", minimum: 0, maximum: 1 },
  title: { type: "string", minLength: 1 },
  trigger: { type: "string", minLength: 1 },
  evidence: { type: "string", minLength: 1 },
  proposedAction: { type: "string", minLength: 1 },
  stableIdentity: { type: "string", minLength: 1 },
});

const reviewerReportJsonSchema = (reviewer: ReviewerId) => {
  const properties = findingProperties(reviewer);
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "reviewer",
      "readiness",
      "rationale",
      "examinedAreas",
      "findings",
    ],
    properties: {
      reviewer: { type: "string", const: reviewer },
      readiness: { type: "integer", minimum: 1, maximum: 5 },
      rationale: { type: "string", minLength: 1 },
      examinedAreas: { type: "array", minItems: 1, items: { type: "string" } },
      findings: {
        type: "array",
        maxItems: 3,
        items: {
          type: "object",
          additionalProperties: false,
          required: Object.keys(properties),
          properties,
        },
      },
    },
  };
};

const challengeJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["outcome", "reason"],
  properties: {
    outcome: {
      type: "string",
      enum: ["confirmed", "rejected", "inconclusive"],
    },
    reason: { type: "string", minLength: 1 },
  },
};

const reviewSummaryJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["headline", "overview", "topRisk", "nextAction"],
  properties: {
    headline: { type: "string", minLength: 1, maxLength: 160 },
    overview: { type: "string", minLength: 1, maxLength: 600 },
    topRisk: { type: "string", minLength: 1, maxLength: 300 },
    nextAction: { type: "string", minLength: 1, maxLength: 300 },
  },
};
