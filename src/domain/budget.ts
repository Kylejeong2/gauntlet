import { usdMicros, type UsdMicros } from "./ids.js";

export const BUDGET_LIMIT = usdMicros(250_000);

export const estimateModelRequest = (
  input: Readonly<{
    inputTokens: number;
    outputTokens: number;
    inputUsdPerMillion: number;
    outputUsdPerMillion: number;
  }>,
): UsdMicros => {
  const inputMicros = input.inputTokens * input.inputUsdPerMillion;
  const outputMicros = input.outputTokens * input.outputUsdPerMillion;
  return usdMicros(Math.ceil(inputMicros + outputMicros));
};

type ReservationResult =
  | Readonly<{ kind: "reserved"; amount: UsdMicros }>
  | Readonly<{ kind: "already_reserved"; amount: UsdMicros }>
  | Readonly<{ kind: "denied"; available: UsdMicros }>;

export class BudgetLedger {
  readonly #limit: UsdMicros;
  readonly #reservations = new Map<string, UsdMicros>();

  public constructor(limit: UsdMicros = BUDGET_LIMIT) {
    this.#limit = limit;
  }

  public reserve(
    request: Readonly<{ key: string; amount: UsdMicros }>,
  ): ReservationResult {
    const existing = this.#reservations.get(request.key);
    if (existing !== undefined)
      return { kind: "already_reserved", amount: existing };
    const available = this.available();
    if (request.amount > available) return { kind: "denied", available };
    this.#reservations.set(request.key, request.amount);
    return { kind: "reserved", amount: request.amount };
  }

  public available(): UsdMicros {
    const reserved = [...this.#reservations.values()].reduce(
      (sum, amount) => sum + amount,
      0,
    );
    return usdMicros(this.#limit - reserved);
  }
}
