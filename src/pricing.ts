/**
 * Precos de lista da API Anthropic, em USD por 1 milhao de tokens
 * (fonte: pricing oficial, jul/2026). Sao ESTIMATIVAS de custo — a fatura real
 * pode diferir (precos promocionais, descontos de batch/cache). Ajuste aqui se
 * os precos mudarem. Ver `claude-api` skill / platform.claude.com/pricing.
 */
export interface ModelPrice {
  /** USD por 1M tokens de entrada. */
  input: number;
  /** USD por 1M tokens de saida. */
  output: number;
  /** Rotulo amigavel. */
  label: string;
}

export const MODEL_PRICES: Record<string, ModelPrice> = {
  'claude-fable-5': { input: 10, output: 50, label: 'Fable 5' },
  'claude-opus-4-8': { input: 5, output: 25, label: 'Opus 4.8' },
  // Sonnet 5: promocional US$2/US$10 ate 2026-08-31; lista US$3/US$15.
  'claude-sonnet-5': { input: 3, output: 15, label: 'Sonnet 5' },
  'claude-haiku-4-5': { input: 1, output: 5, label: 'Haiku 4.5' },
};

export interface CostBreakdown {
  inputCost: number;
  outputCost: number;
  totalCost: number;
  known: boolean;
}

/**
 * Calcula o custo estimado (USD) de um uso de tokens para um modelo. Se o
 * modelo nao estiver na tabela, retorna custo zero com known=false.
 */
export function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): CostBreakdown {
  const price = MODEL_PRICES[model];
  if (!price) {
    return { inputCost: 0, outputCost: 0, totalCost: 0, known: false };
  }
  const inputCost = (inputTokens / 1_000_000) * price.input;
  const outputCost = (outputTokens / 1_000_000) * price.output;
  return { inputCost, outputCost, totalCost: inputCost + outputCost, known: true };
}

export function priceLabel(model: string): string {
  return MODEL_PRICES[model]?.label ?? model;
}
