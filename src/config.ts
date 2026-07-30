import 'dotenv/config';

/** Configuracao central lida do ambiente (.env). Falha cedo se algo essencial faltar. */
export interface AppConfig {
  anthropicApiKey: string;
  model: string;
  maxOutputTokens: number;
  rateLimit: RateLimitConfig;
}

/**
 * Teto de chamadas de IA. A app e publica e sem login: sem isso, quem tiver a URL
 * gasta a verba da empresa a vontade.
 *
 * Sao dois limites porque protegem de coisas diferentes: o por IP contem o abuso
 * de um visitante, e o global e o que de fato limita a FATURA — trocar de IP e
 * trivial, e sem o teto global o limite por IP nao poe teto em gasto nenhum.
 */
export interface RateLimitConfig {
  perIpPerHour: number;
  globalPerDay: number;
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
    // TETO DURO DE 21333: acima disso o SDK RECUSA a chamada nao-streaming, na
    // hora, com "Streaming is required for operations that may take longer than
    // 10 minutes" (ele estima 60min * max_tokens / 128000 e barra se passar de
    // 10 min). Ja aconteceu: com 32000 aqui, toda chamada de IA morria em 2ms.
    // Para passar disso seria preciso migrar as chamadas para streaming.
    //
    // 20000 fica logo abaixo do teto e sobra: a ata da transcricao inteira de 1h
    // consumiu ~8600 tokens de saida. O limite so limita — paga-se pelos tokens
    // gerados —, mas mais tokens = chamada mais LENTA (~130 tokens/s) e o Vercel
    // Hobby corta em 60s. Ao mexer aqui, olhe o tempo no log [api].
    maxOutputTokens: Number(process.env.MAX_OUTPUT_TOKENS ?? '20000'),
    rateLimit: {
      // Folgado para o especialista iterando num documento, apertado para quem
      // quiser rodar a app em loop. 0 desliga o limite.
      perIpPerHour: Number(process.env.RATE_LIMIT_PER_IP_HOUR ?? '20'),
      // ~US$ 0,20 por geracao => 150/dia e da ordem de US$ 30/dia no pior caso.
      // Ajuste conforme o que a empresa aceita perder num dia ruim.
      globalPerDay: Number(process.env.RATE_LIMIT_GLOBAL_PER_DAY ?? '150'),
    },
  };
}
