import type Anthropic from '@anthropic-ai/sdk';
import type { AppConfig } from './config.js';

/**
 * Monta o campo `thinking` das chamadas de IA, em UM lugar so.
 *
 * Por que existe um cast aqui: o SDK instalado e o 0.68.0, cujo
 * `ThinkingConfigParam` so conhece `enabled | disabled` — o modo `adaptive` e
 * mais novo que ele. A API ACEITA `adaptive` (e no Sonnet 5 e o unico modo
 * "ligado"; `budget_tokens` foi removido e devolve 400); quem nao conhece e o
 * pacote de tipos. O cast e a ponte ate o upgrade do SDK, e fica confinado a
 * esta funcao em vez de espalhado pelas tres chamadas.
 *
 * Por que isto e configuravel e nao fixo:
 *
 * - `disabled` foi escolhido quando `MAX_OUTPUT_TOKENS` era 20000. O motivo era
 *   concreto: no Sonnet 5 o thinking vem LIGADO se o campo for omitido, e o
 *   `max_tokens` limita **thinking + resposta juntos** — com 20000 o thinking
 *   comia o orcamento e a resposta saia cortada. Com 64000 essa conta mudou.
 * - Mas `disabled` tem custo proprio: a referencia da API registra que, com o
 *   thinking desligado, o Sonnet 5 **puxa menos as ferramentas**, e o Opus 5
 *   chega a escrever a chamada da ferramenta como TEXTO em vez de emitir o bloco
 *   `tool_use`. As duas falhas que tivemos com a ata de PO sao dessa familia: o
 *   bloco `tool_use` veio, mas o array `nodes` dentro dele veio como string.
 * - Nao ha teste barato que decida isso: sao duas geracoes pagas. Entao a
 *   escolha vira uma flag, e quem paga a conta inverte sem precisar de commit.
 *
 * Nota para quem for rodar em Bedrock um dia: la o `tool_choice` FORCADO exige
 * `thinking: disabled`. Na API direta da Anthropic (que e a nossa) e na Vertex
 * nao exige — por isso `adaptive` + tool use forcado e valido aqui.
 */
export function thinkingParam(config: AppConfig): Anthropic.ThinkingConfigParam {
  if (config.thinking === 'disabled') return { type: 'disabled' };
  return { type: 'adaptive' } as unknown as Anthropic.ThinkingConfigParam;
}

/**
 * Aviso unico no log, para o custo do thinking nao ficar invisivel.
 *
 * Com `display` em "omitted" (o padrao no Sonnet 5) os blocos de thinking voltam
 * VAZIOS — o texto nao aparece, mas os tokens sao gerados e COBRADOS. Sem esta
 * linha, ligar a flag pareceria de graca ate a fatura chegar.
 */
export function descreverThinking(config: AppConfig): string {
  return config.thinking === 'adaptive'
    ? 'thinking: adaptive (os tokens de raciocinio contam no max_tokens e na fatura)'
    : 'thinking: disabled';
}
