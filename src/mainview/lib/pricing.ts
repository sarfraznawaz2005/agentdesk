/**
 * Approximate model pricing per 1 million tokens (input / output).
 * Prices are in USD. Values are best-effort estimates and may lag real-world changes.
 * Matching is done by substring so partial model IDs work (e.g. "claude-sonnet-4" matches
 * "claude-sonnet-4-5", "claude-sonnet-4-20250514", etc.).
 */

interface ModelPrice {
  input: number;
  output: number;
}

// Ordered from most-specific to least-specific so the first match wins.
const MODEL_PRICING: Array<{ pattern: string; price: ModelPrice }> = [
  // Anthropic
  { pattern: "claude-opus-4",        price: { input: 15,   output: 75   } },
  { pattern: "claude-sonnet-4",      price: { input: 3,    output: 15   } },
  { pattern: "claude-haiku-3-5",     price: { input: 0.80, output: 4    } },
  { pattern: "claude-haiku-3.5",     price: { input: 0.80, output: 4    } },
  { pattern: "claude-3-5-sonnet",    price: { input: 3,    output: 15   } },
  { pattern: "claude-3-5-haiku",     price: { input: 0.80, output: 4    } },
  { pattern: "claude-3-opus",        price: { input: 15,   output: 75   } },
  { pattern: "claude-3-sonnet",      price: { input: 3,    output: 15   } },
  { pattern: "claude-3-haiku",       price: { input: 0.25, output: 1.25 } },

  // OpenAI
  { pattern: "gpt-4o-mini",          price: { input: 0.15, output: 0.60 } },
  { pattern: "gpt-4o",               price: { input: 2.50, output: 10   } },
  { pattern: "gpt-4-turbo",          price: { input: 10,   output: 30   } },
  { pattern: "gpt-4",                price: { input: 30,   output: 60   } },
  { pattern: "gpt-3.5-turbo",        price: { input: 0.50, output: 1.50 } },
  { pattern: "o1-mini",              price: { input: 3,    output: 12   } },
  { pattern: "o1",                   price: { input: 15,   output: 60   } },

  // Meta / Llama (typical OpenRouter pricing)
  { pattern: "llama-3.1-70b",        price: { input: 0.52, output: 0.75 } },
  { pattern: "llama-3.1-8b",         price: { input: 0.06, output: 0.06 } },
  { pattern: "llama-3",              price: { input: 0.52, output: 0.75 } },

  // Mistral
  { pattern: "mistral-large",        price: { input: 3,    output: 9    } },
  { pattern: "mistral-small",        price: { input: 0.20, output: 0.60 } },
  { pattern: "mistral",              price: { input: 0.20, output: 0.60 } },

  // Google
  { pattern: "gemini-1.5-pro",       price: { input: 3.50, output: 10.50 } },
  { pattern: "gemini-1.5-flash",     price: { input: 0.35, output: 1.05  } },
  { pattern: "gemini-2.0-flash",     price: { input: 0.10, output: 0.40  } },
];

/** Fallback price when no pattern matches (conservative estimate). */
const DEFAULT_PRICE: ModelPrice = { input: 3, output: 15 };

function getModelPrice(modelId?: string): ModelPrice {
  if (!modelId) return DEFAULT_PRICE;
  const lower = modelId.toLowerCase();
  for (const entry of MODEL_PRICING) {
    if (lower.includes(entry.pattern)) return entry.price;
  }
  return DEFAULT_PRICE;
}

/**
 * Estimate USD cost for a given number of prompt and completion tokens.
 * @param promptTokens     - Total input / prompt tokens consumed
 * @param completionTokens - Total output / completion tokens generated
 * @param modelId          - Optional model identifier for pricing lookup
 */
export function estimateCost(
  promptTokens: number,
  completionTokens: number,
  modelId?: string,
): number {
  const price = getModelPrice(modelId);
  const inputCost  = (promptTokens     / 1_000_000) * price.input;
  const outputCost = (completionTokens / 1_000_000) * price.output;
  return inputCost + outputCost;
}

/**
 * Format a USD cost value for display.
 * - Returns "<$0.01" for sub-cent amounts to avoid showing "$0.00"
 * - Returns "$X.XX" for amounts >= $0.01
 */
export function formatCost(cost: number): string {
  if (cost <= 0)    return "$0.00";
  if (cost < 0.01)  return "<$0.01";
  if (cost < 1)     return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}
