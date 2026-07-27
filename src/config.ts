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
    maxOutputTokens: Number(process.env.MAX_OUTPUT_TOKENS ?? '8000'),
  };
}
