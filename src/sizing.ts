/**
 * Estimativa do tamanho da RESPOSTA antes de gastar a chamada.
 *
 * Por que existe: estourar `max_tokens` e a pior falha possivel — a chamada e
 * cobrada por inteiro (uma rodada real: 14104 entrada + 20000 saida = US$ 0,34)
 * e nao devolve nada aproveitavel, porque o JSON da ferramenta vem cortado no
 * meio. Diferente de um documento dificil, isto e previsivel: da para avisar.
 *
 * Tudo aqui e regra de bolso deliberada. Serve para AVISAR, nunca para bloquear:
 * errar para mais e barato (o usuario confirma assim mesmo), errar para menos so
 * repete o prejuizo.
 */

/** ~3,5 caracteres por token em pt/en. Bom o bastante para ordem de grandeza. */
const CHARS_POR_TOKEN = 3.5;

/**
 * Quantos tokens de SAIDA cada token de documento tende a gerar.
 *
 * Calibrado em rodadas reais com a ata de PO (22965 chars = ~6560 tokens de
 * documento): a extracao bateu em 20000 tokens de saida E FOI CORTADA — ou seja,
 * o necessario era MAIOR que 20000, o que da um fator > 3,05. Como nao da para
 * saber quanto faltava, arredondamos para cima: subestimar repete o prejuizo,
 * superestimar so faz o usuario confirmar assim mesmo.
 *
 * Cada no custa caro em saida porque leva `name` + `detail` (uma frase inteira)
 * + `evidence` (que REPETE trecho do documento) — o `detail`, em particular,
 * subiu esse fator quando foi introduzido.
 *
 * Documentos pouco densos em processo (relatorio, contrato) ficam bem abaixo;
 * por isso o aviso e um piso de suspeita, nao uma previsao.
 */
const SAIDA_POR_TOKEN_DE_DOCUMENTO = 4;

/** Acima desta fracao do teto, avisar: a margem ja nao e confortavel. */
const FRACAO_DE_ALERTA = 0.8;

export interface OutputEstimate {
  /** Tokens do documento (so o texto, sem prompt nem schema da ferramenta). */
  documentTokens: number;
  /** Tokens de saida que a extracao provavelmente vai querer. */
  estimatedOutputTokens: number;
  /** O teto configurado (`MAX_OUTPUT_TOKENS`). */
  maxOutputTokens: number;
  /** A estimativa passa do teto? Aqui a falha e provavel. */
  exceeds: boolean;
  /** Passa de 80% do teto? Margem apertada. */
  tight: boolean;
}

export function estimateOutput(documentText: string, maxOutputTokens: number): OutputEstimate {
  const documentTokens = Math.round(documentText.length / CHARS_POR_TOKEN);
  const estimatedOutputTokens = Math.round(documentTokens * SAIDA_POR_TOKEN_DE_DOCUMENTO);
  return {
    documentTokens,
    estimatedOutputTokens,
    maxOutputTokens,
    exceeds: estimatedOutputTokens > maxOutputTokens,
    tight: estimatedOutputTokens > maxOutputTokens * FRACAO_DE_ALERTA,
  };
}

/** Aviso pronto para exibir, ou `undefined` quando a margem esta confortavel. */
export function outputWarning(e: OutputEstimate): string | undefined {
  if (e.exceeds) {
    return (
      `RISCO ALTO de estourar o limite de saida: o documento (~${e.documentTokens} tokens) ` +
      `deve pedir ~${e.estimatedOutputTokens} tokens de resposta, e o teto e ${e.maxOutputTokens}. ` +
      `Se estourar, a chamada e COBRADA e nao devolve nada. ` +
      `Suba MAX_OUTPUT_TOKENS (as chamadas usam streaming; o maximo do Sonnet 5 e 128000) ` +
      `ou divida o documento por processo.`
    );
  }
  if (e.tight) {
    return (
      `Margem apertada: ~${e.estimatedOutputTokens} tokens de resposta estimados ` +
      `para um teto de ${e.maxOutputTokens}.`
    );
  }
  return undefined;
}
