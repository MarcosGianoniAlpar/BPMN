import 'dotenv/config';

/** Configuracao central lida do ambiente (.env). Falha cedo se algo essencial faltar. */
export interface AppConfig {
  anthropicApiKey: string;
  model: string;
  maxOutputTokens: number;
}

export function loadConfig(): AppConfig {
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicApiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY nao definida. Copie .env.example para .env e preencha.',
    );
  }

  return {
    anthropicApiKey,
    model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5',
    // 32000: medido — a ata de 10% da transcricao de 1h deu ~4000 tokens, entao a
    // transcricao inteira projeta ~40000. O teto e so um limite: paga-se pelos
    // tokens gerados, nao pelo limite, entao folga aqui e barata.
    // ATENCAO: mais tokens de saida = chamada mais LENTA (~130 tokens/s), e o
    // Vercel Hobby corta em 60s. Ao mexer aqui, olhe o tempo no log [api].
    maxOutputTokens: Number(process.env.MAX_OUTPUT_TOKENS ?? '32000'),
  };
}
