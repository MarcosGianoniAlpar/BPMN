import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';
import { readSpecFromMessage, PROCESS_SPEC_TOOL } from '../src/extractProcessSpec.js';
import { AiCallError } from '../src/aiError.js';

/**
 * Leitura da resposta da IA. Nada aqui chama a API: montamos a `Message` a mao,
 * que e justamente o ponto — os modos de falha abaixo custaram geracoes pagas
 * para aparecer, e nenhum deles deveria precisar de outra para ser testado.
 */

/** Monta uma Message com um bloco tool_use da nossa ferramenta. */
function mensagemComToolUse(input: unknown, stopReason = 'tool_use'): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5',
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 200 },
    content: [{ type: 'tool_use', id: 'tu_1', name: PROCESS_SPEC_TOOL.name, input }],
  } as unknown as Anthropic.Message;
}

const NO = { id: 'inicio', type: 'start_event', name: 'Pedido recebido' };
const FLUXO = { id: 'f1', source: 'inicio', target: 'fim' };

describe('readSpecFromMessage — colecoes na forma errada', () => {
  test('array serializado em STRING vira array', () => {
    // Sintoma real: `/nodes must be array`, com a chave presente na raiz. A
    // estrutura extraida esta inteira — jogar a geracao paga fora seria desperdicio.
    const spec = readSpecFromMessage(
      mensagemComToolUse({
        process: { id: 'P', name: 'Compra' },
        nodes: JSON.stringify([NO]),
        flows: JSON.stringify([FLUXO]),
      }),
    ) as Record<string, unknown>;

    assert.ok(Array.isArray(spec.nodes), 'nodes deveria ter virado array');
    assert.deepEqual(spec.nodes, [NO]);
    assert.deepEqual(spec.flows, [FLUXO]);
  });

  test('MAPA por id vira array, preservando os itens', () => {
    const spec = readSpecFromMessage(
      mensagemComToolUse({
        process: { id: 'P', name: 'Compra' },
        nodes: { inicio: NO },
        flows: [FLUXO],
      }),
    ) as Record<string, unknown>;

    assert.deepEqual(spec.nodes, [NO]);
  });

  test('AGRUPADO por processo vira uma lista so, achatada', () => {
    // A hipotese mais provavel para a ata de PO: ela descreve SEIS processos e o
    // schema so aceita um, entao o modelo agrupa em vez de escolher. Sem este
    // caso, o `Object.values` produziria um array DE ARRAYS — outro erro, so que
    // mais adiante e mais confuso.
    const outro = { id: 'fim', type: 'end_event', name: 'Pedido pago' };
    const spec = readSpecFromMessage(
      mensagemComToolUse({
        process: { id: 'P', name: 'Compra' },
        nodes: { aprovacao: [NO], pagamento: [outro] },
        flows: [FLUXO],
      }),
    ) as Record<string, unknown>;

    assert.deepEqual(spec.nodes, [NO, outro]);
  });

  test('array FECHADO com um item lixo no fim salva os itens bons', () => {
    // O caso real da 2a rodada da ata de PO (2026-08-04): 43 nos corretos e, no
    // lugar do 44o, `{"id": "gw_rush_fastpath": null}]`. O array FECHA — nao e
    // corte, e um item avariado. Tentar so o ultimo ponto de corte pegava
    // justamente o lixo e jogava os 43 fora.
    const outro = { id: 'fim', type: 'end_event', name: 'Pedido pago' };
    const avariada = JSON.stringify([NO, outro]).slice(0, -1) + ',{"id": "gw_rush": null}]';
    const spec = readSpecFromMessage(
      mensagemComToolUse({ process: { id: 'P', name: 'C' }, nodes: avariada, flows: [FLUXO] }),
    ) as Record<string, unknown>;

    assert.deepEqual(spec.nodes, [NO, outro]);
  });

  test('STRING de JSON CORTADA salva os itens que fecharam', () => {
    // O caso real da ata de PO (2026-08-04): `nodes` veio como string de 32138
    // chars e o `JSON.parse` inteiro estourou. Os itens completos estavam la —
    // e a geracao inteira ia para o lixo por causa do ultimo, pela metade.
    const outro = { id: 'fim', type: 'end_event', name: 'Pedido pago' };
    const cortada = JSON.stringify([NO, outro]).slice(0, -1) + ',{"id":"meio","type":"user_';
    const spec = readSpecFromMessage(
      mensagemComToolUse({ process: { id: 'P', name: 'C' }, nodes: cortada, flows: [FLUXO] }),
    ) as Record<string, unknown>;

    assert.deepEqual(spec.nodes, [NO, outro]);
  });

  test('chave `}` dentro de uma citacao nao conta como fim de item', () => {
    // A `evidence` carrega trecho literal do documento, que pode ter chaves e
    // aspas. Uma varredura ingenua cortaria o array no meio de uma citacao.
    const comChave = {
      id: 'x',
      type: 'user_task',
      name: 'Tarefa',
      evidence: [{ quote: 'o gestor aprova {ou nao} e diz "ok"' }],
    };
    const cortada = JSON.stringify([comChave]).slice(0, -1) + ',{"id":"y","typ';
    const spec = readSpecFromMessage(
      mensagemComToolUse({ process: { id: 'P', name: 'C' }, nodes: cortada }),
    ) as Record<string, unknown>;

    assert.deepEqual(spec.nodes, [comChave]);
  });

  test('array correto passa intacto', () => {
    const spec = readSpecFromMessage(
      mensagemComToolUse({ process: { id: 'P', name: 'C' }, nodes: [NO], flows: [FLUXO] }),
    ) as Record<string, unknown>;

    assert.deepEqual(spec.nodes, [NO]);
  });

  test('string que NAO e JSON fica como esta (a validacao reporta a forma real)', () => {
    // Consertar o que nao da para consertar seria inventar dados.
    const spec = readSpecFromMessage(
      mensagemComToolUse({ process: { id: 'P', name: 'C' }, nodes: 'nao consegui extrair' }),
    ) as Record<string, unknown>;

    assert.equal(spec.nodes, 'nao consegui extrair');
  });

  test('objeto de escalares NAO vira array', () => {
    // `{ total: 3 }` nao e um mapa de nos; converter produziria lixo silencioso.
    const spec = readSpecFromMessage(
      mensagemComToolUse({ process: { id: 'P', name: 'C' }, nodes: { total: 3 } }),
    ) as Record<string, unknown>;

    assert.deepEqual(spec.nodes, { total: 3 });
  });
});

describe('readSpecFromMessage — guardas', () => {
  test('resposta cortada por max_tokens vira erro claro, com o usage junto', () => {
    // A chamada foi cobrada mesmo cortada; sem o usage o custo sumiria do painel.
    try {
      readSpecFromMessage(mensagemComToolUse({ process: {} }, 'max_tokens'));
      assert.fail('deveria ter lancado');
    } catch (err) {
      assert.ok(err instanceof AiCallError);
      assert.match(err.message, /max_tokens/);
      assert.deepEqual(err.usage, { inputTokens: 100, outputTokens: 200 });
    }
  });

  test('spec embrulhado em um nivel e desembrulhado', () => {
    const spec = readSpecFromMessage(
      mensagemComToolUse({ process_spec: { process: { id: 'P', name: 'C' }, nodes: [NO] } }),
    ) as Record<string, unknown>;

    assert.ok('process' in spec, 'o envelope deveria ter sido removido');
    assert.deepEqual(spec.nodes, [NO]);
  });
});
