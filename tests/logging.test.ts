import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "../src/logging.js";

describe("production logging", () => {
  it("redacts webhook bodies, signatures, authorization, and cookies", () => {
    let output = "";
    const destination = new Writable({
      write(
        chunk: unknown,
        _encoding: BufferEncoding,
        callback: (error?: Error | null) => void,
      ) {
        if (typeof chunk !== "string" && !Buffer.isBuffer(chunk)) {
          callback(new TypeError("Expected a string or Buffer log chunk"));
          return;
        }
        output += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        callback();
      },
    });
    const logger = createLogger(destination);

    logger.error({
      err: {
        event: {
          event: {
            payload: '{"secret":"webhook-body"}',
            signature: "sha256=webhook-signature",
          },
        },
        aggregateErrors: [
          {
            event: {
              payload: '{"secret":"aggregate-body"}',
              signature: "sha256=aggregate-signature",
            },
          },
        ],
      },
      req: {
        headers: {
          authorization: "Bearer installation-token",
          cookie: "session=browser-cookie",
          "x-hub-signature-256": "sha256=request-signature",
        },
      },
    });

    expect(output).toContain("[REDACTED]");
    expect(output).not.toMatch(
      /webhook-body|webhook-signature|aggregate-body|aggregate-signature|installation-token|browser-cookie|request-signature/,
    );
  });
});
