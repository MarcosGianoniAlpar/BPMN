import type Anthropic from '@anthropic-ai/sdk';
import type { AppConfig } from './config.js';

/**
 * As duas alavancas das chamadas de IA — quanto o modelo pensa (`thinking`) e
 * quanto ele se esforca (`output_config.effort`) — em UM lugar so, para as tres
 * chamadas (extracao, refino, ata).
 *
 * Historico: ate o SDK 0.68 havia um cast aqui, porque o `ThinkingConfigParam`
 * daquela versao so conhecia `enabled | disabled` e o modo `adaptive` era mais
 * novo que o pacote de tipos. O SDK 0.115 tipa `adaptive`, e o cast saiu.
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
  return { type: 'adaptive' };
}

/**
 * Monta o `output_config` das chamadas. O `effort` vai DENTRO dele — nao e campo
 * de raiz da requisicao, e mandar na raiz e um erro silencioso: o campo e
 * ignorado e a chamada roda no padrao `high` como se nada tivesse sido pedido.
 *
 * A alavanca de custo mais direta do projeto, e a unica que estava intocada: sem
 * este campo a API assume `high`, entao todas as chamadas pagas ate hoje foram no
 * segundo nivel mais caro sem ninguem ter escolhido isso.
 */
export function outputConfigParam(config: AppConfig): Anthropic.MessageCreateParams['output_config'] {
  return { effort: config.effort };
}

/**
 * Aviso unico no log, para o custo do thinking nao ficar invisivel.
 *
 * Com `display` em "omitted" (o padrao no Sonnet 5) os blocos de thinking voltam
 * VAZIOS — o texto nao aparece, mas os tokens sao gerados e COBRADOS. Sem esta
 * linha, ligar a flag pareceria de graca ate a fatura chegar.
 */
export function descreverThinking(config: AppConfig): string {
  const modo =
    config.thinking === 'adaptive'
      ? 'thinking: adaptive (os tokens de raciocinio contam no max_tokens e na fatura)'
      : 'thinking: disabled';
  return `${modo} · effort: ${config.effort}`;
}
