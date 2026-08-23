import { describe, expect, it, vi } from "vitest";
import { reviewerId, usdMicros } from "../src/domain/ids.js";
import { SailModelClient } from "../src/adapters/sail-model.js";
import {
  AllowlistedToolBroker,
  type CommandSandbox,
} from "../src/adapters/sailbox-tools.js";

describe("Sail model contract", () => {
  it("uses DeepSeek V4 Flash through Sail's synchronous asap contract and accounts for usage", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "response-1",
          status: "completed",
          output: [
            {
              type: "reasoning",
              content: [{ type: "reasoning_text", text: "Inspect the line." }],
            },
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: `The changed line is inert.\n${JSON.stringify({
                    reviewer: "security",
                    readiness: 5,
                    rationale: "No reachable security defect found.",
                    examinedAreas: ["changed trust boundaries"],
                    findings: [],
                  })}`,
                },
              ],
            },
          ],
          usage: { input_tokens: 1000, output_tokens: 200 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = new SailModelClient({
      apiKey: "test-key",
      fetcher,
    });

    const result = await client.review({
      reviewer: reviewerId("security"),
      label: "Security",
      question: "Can an attacker cross a trust boundary?",
      snapshot: "src/index.ts changed on line 1",
      toolEvidence: [],
    });

    expect(result.report.readiness).toBe(5);
    expect(result.cost).toBe(usdMicros(126));
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe("https://api.sailresearch.com/v1/responses");
    if (typeof init?.body !== "string")
      throw new Error("Expected JSON request body");
    const request = JSON.parse(init.body) as Record<string, unknown>;
    expect(request).toMatchObject({
      model: "deepseek/deepseek-v4-flash-0731",
      metadata: { completion_window: "asap" },
      reasoning: { effort: "low" },
      max_output_tokens: 6000,
    });
    expect(request.background).toBeUndefined();
    expect(init.headers).toMatchObject({ Authorization: "Bearer test-key" });
    expect(new Headers(init.headers).get("Idempotency-Key")).toBeNull();
  });

  it("fails closed on a malformed model response", async () => {
    const client = new SailModelClient({
      apiKey: "test-key",
      fetcher: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: "response-1",
            status: "completed",
            output_text: JSON.stringify({ reviewer: "security" }),
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    });
    await expect(
      client.review({
        reviewer: reviewerId("security"),
        label: "Security",
        question: "Find defects.",
        snapshot: "diff",
        toolEvidence: [],
      }),
    ).rejects.toThrow("Invalid Sail reviewer response");
  });

  it("produces a structured PR-level synthesis with usage accounting", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "response-summary",
          status: "completed",
          output_text: JSON.stringify({
            headline: "One verified blocker remains",
            overview:
              "The specialists agree that the changed command execution exposes a reachable shell injection. The compatibility and documentation reviews found no separate blockers, but the security defect must be fixed before merge.",
            keyChanges: ["Changed process execution"],
            keyRisks: ["Arbitrary command execution"],
            recommendedActions: ["Use an argument-vector process API"],
          }),
          usage: { input_tokens: 500, output_tokens: 250 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = new SailModelClient({ apiKey: "test-key", fetcher });

    const result = await client.summarize({
      reports: [],
      challenges: [],
      coverageOmissions: [],
    });

    expect(result.summary.headline).toBe("One verified blocker remains");
    expect(result.summary.keyRisks).toEqual(["Arbitrary command execution"]);
    expect(result.cost).toBe(usdMicros(90));
    if (typeof fetcher.mock.calls[0]?.[1]?.body !== "string")
      throw new Error("Expected JSON request body");
    const request = JSON.parse(fetcher.mock.calls[0][1].body) as {
      metadata?: { completion_window?: string };
      text?: { format?: { name?: string } };
    };
    expect(request.metadata?.completion_window).toBe("asap");
    expect(request.text?.format?.name).toBe("review_summary");
  });

  it("retries a transient rate limit without changing models", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response('{"error":{"code":"rate_limited"}}', { status: 429 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "response-2",
            status: "completed",
            output_text: JSON.stringify({
              reviewer: "security",
              readiness: 5,
              rationale: "No reachable defect found.",
              examinedAreas: ["diff"],
              findings: [],
            }),
            usage: { input_tokens: 10, output_tokens: 10 },
          }),
          { status: 200 },
        ),
      );
    const client = new SailModelClient({
      apiKey: "test-key",
      fetcher,
      retryDelaysMs: [0],
    });
    const result = await client.review({
      reviewer: reviewerId("security"),
      label: "Security",
      question: "Find defects.",
      snapshot: "diff",
      toolEvidence: [],
    });
    expect(result.responseId).toBe("response-2");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(
      new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("Idempotency-Key"),
    ).toBeNull();
  });
});

describe("Sailbox tool broker", () => {
  it("uses argument vectors, rejects unknown commands, and truncates output", async () => {
    const calls: string[][] = [];
    const sandbox: CommandSandbox = {
      exec: (argv) => {
        calls.push([...argv]);
        return Promise.resolve({
          exitCode: 0,
          stdout: "x".repeat(20_000),
          stderr: "",
        });
      },
    };
    const broker = new AllowlistedToolBroker(sandbox, {
      checkoutDirectory: "/workspace/repo",
      maxOutputCharacters: 1000,
    });

    const result = await broker.runProjectCommand("test");
    expect(calls).toEqual([["pnpm", "test", "--", "--runInBand"]]);
    expect(result.stdout).toHaveLength(1000);
    await expect(broker.runProjectCommand("publish")).rejects.toThrow(
      "Unknown project command",
    );
  });
});
