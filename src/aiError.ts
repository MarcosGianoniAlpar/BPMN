export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * Erro de uma chamada de IA que JA CONSUMIU TOKENS — tipicamente `max_tokens`
 * (a resposta foi gerada ate o teto e cortada) ou a IA nao ter chamado a
 * ferramenta.
 *
 * Carrega o `usage` de proposito: a chamada falhou para o usuario, mas foi
 * cobrada da empresa. Sem isto o painel de custo mentiria justamente nos casos
 * caros — uma ata cortada em 16000 tokens custa igual a uma ata que deu certo.
 */
export class AiCallError extends Error {
  constructor(
    message: string,
    public readonly usage: AiUsage,
  ) {
    super(message);
    this.name = 'AiCallError';
  }
}
