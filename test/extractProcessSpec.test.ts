import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';
import { readSpecFromMessage, PROCESS_SPEC_TOOL } from '../src/extractProcessSpec.js';
import { MEETING_MINUTES_TOOL } from '../src/transcriptToMinutes.js';
import { inlineSchemaRefs } from '../src/toolSchema.js';
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

/**
 * Contrato do `strict: true`, varrido nos DOIS schemas de ferramenta.
 *
 * Por que isto e teste e nao confianca: um keyword nao suportado faz a API
 * devolver 400 — e o 400 chega na primeira geracao real, que e sempre a que
 * alguem esta olhando. O 400 em si nao cobra (a requisicao e recusada antes da
 * inferencia), mas o susto e a rodada perdida sim. Estas asserçoes sao a
 * diferenca entre "deve funcionar" e "nao ha keyword proibido em nenhum dos dois".
 *
 * A lista vem da referencia da API. `pattern`, `minItems: 1`, `enum`, `const`,
 * `format` e `additionalProperties: false` NAO estao aqui porque sao aceitos.
 */
const KEYWORDS_PROIBIDOS = [
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'maxItems',
  'uniqueItems',
] as const;

/** Caminhos (`a.b.c`) onde aparece um keyword proibido, ignorando nomes de propriedade. */
function keywordsProibidos(no: unknown, caminho = '$'): string[] {
  if (Array.isArray(no)) {
    return no.flatMap((item, i) => keywordsProibidos(item, `${caminho}[${i}]`));
  }
  if (!no || typeof no !== 'object') return [];

  const achados: string[] = [];
  for (const [chave, valor] of Object.entries(no as Record<string, unknown>)) {
    if ((KEYWORDS_PROIBIDOS as readonly string[]).includes(chave)) {
      achados.push(`${caminho}.${chave}`);
      continue;
    }
    // Dentro de `properties` as chaves sao NOMES de campo, nao keywords: um campo
    // chamado `maxLength` e legitimo e nao pode contar como violacao.
    if (chave === 'properties' && valor && typeof valor === 'object') {
      for (const [nome, sub] of Object.entries(valor as Record<string, unknown>)) {
        achados.push(...keywordsProibidos(sub, `${caminho}.properties.${nome}`));
      }
      continue;
    }
    achados.push(...keywordsProibidos(valor, `${caminho}.${chave}`));
  }
  return achados;
}

/** Objetos do schema que nao cumprem o que o `strict` exige. */
function objetosIncompletos(no: unknown, caminho = '$'): string[] {
  if (Array.isArray(no)) {
    return no.flatMap((item, i) => objetosIncompletos(item, `${caminho}[${i}]`));
  }
  if (!no || typeof no !== 'object') return [];
  const obj = no as Record<string, unknown>;

  const achados: string[] = [];
  if (obj.type === 'object') {
    if (obj.additionalProperties !== false) {
      achados.push(`${caminho}: additionalProperties precisa ser false`);
    }
    if (!Array.isArray(obj.required)) {
      achados.push(`${caminho}: falta o array required`);
    }
  }
  for (const [chave, valor] of Object.entries(obj)) {
    const proximo = chave === 'properties' ? caminho : `${caminho}.${chave}`;
    achados.push(...objetosIncompletos(valor, proximo));
  }
  return achados;
}

describe('strict: true — o contrato dos dois schemas de ferramenta', () => {
  const FERRAMENTAS = [
    ['emit_process_spec', PROCESS_SPEC_TOOL],
    ['emit_meeting_minutes', MEETING_MINUTES_TOOL],
  ] as const;

  test('as duas ferramentas declaram strict', () => {
    for (const [nome, tool] of FERRAMENTAS) {
      assert.equal((tool as { strict?: boolean }).strict, true, `${nome} sem strict`);
    }
  });

  test('nenhum keyword proibido pela saida estruturada, em nenhum dos dois', () => {
    // O que a poda em src/toolSchema.ts tirou: `minLength` (4x no ProcessSpec) e
    // o `minimum: 1` de `evidence.page`. Os arquivos de schema CONTINUAM com eles
    // — quem os usa e o Ajv, e a garantia nao se perde, so muda quem a aplica.
    for (const [nome, tool] of FERRAMENTAS) {
      assert.deepEqual(keywordsProibidos(tool.input_schema), [], `em ${nome}`);
    }
  });

  test('todo objeto tem additionalProperties: false e required', () => {
    for (const [nome, tool] of FERRAMENTAS) {
      assert.deepEqual(objetosIncompletos(tool.input_schema), [], `em ${nome}`);
    }
  });

  test('a poda NAO removeu o que a saida estruturada aceita', () => {
    // O contrapeso do teste acima: uma poda larga demais passaria nele e
    // silenciosamente jogaria fora garantias que a API aceita de bom grado.
    const spec = JSON.stringify(PROCESS_SPEC_TOOL.input_schema);
    assert.match(spec, /\^\[A-Za-z_\]\[A-Za-z0-9_\]\*\$/, 'o `pattern` do id tem de ficar');
    assert.match(spec, /"minItems":\s*1/, '`minItems: 1` e aceito e tem de ficar');
    assert.match(spec, /"enum"/, '`enum` e aceito');
  });

  test('a poda tirou o KEYWORD, nao o CAMPO', () => {
    // `evidence.page` tinha `minimum: 1`. O keyword sai; a propriedade fica, ou a
    // ferramenta perderia a pagina da citacao — rastreabilidade, nao enfeite.
    const schema = PROCESS_SPEC_TOOL.input_schema as Record<string, any>;
    const evidencia = schema.properties.nodes.items.properties.evidence.items;
    assert.ok(evidencia.properties.page, 'o campo `page` desapareceu junto com o `minimum`');
    assert.equal(evidencia.properties.page.type, 'integer');
    assert.equal(evidencia.properties.page.minimum, undefined, 'o `minimum` deveria ter saido');

    // Mesma coisa com `minLength`: `process.name` continua exigido e do tipo certo.
    const nome = schema.properties.process.properties.name;
    assert.equal(nome.type, 'string');
    assert.equal(nome.minLength, undefined);
    assert.ok(schema.properties.process.required.includes('name'));
  });

  test('um campo chamado como keyword nao e podado', () => {
    // Guarda da distincao que a poda precisa fazer: dentro de `properties` as
    // chaves sao NOMES, nao keywords. Sem isso, um dia alguem adiciona um campo
    // `maxLength` ao schema e ele desaparece da ferramenta sem aviso.
    const podado = inlineSchemaRefs({
      type: 'object',
      additionalProperties: false,
      required: ['maxLength'],
      properties: {
        maxLength: { type: 'integer', minimum: 1 },
      },
    }) as Record<string, any>;

    assert.ok(podado.properties.maxLength, 'o CAMPO maxLength foi podado como keyword');
    assert.equal(podado.properties.maxLength.minimum, undefined, 'o keyword minimum ficou');
  });
});

describe('PROCESS_SPEC_TOOL — o que a definicao da ferramenta entrega ao modelo', () => {
  const schema = PROCESS_SPEC_TOOL.input_schema as Record<string, any>;

  test('nao sobrou `$ref` nem `$defs` no schema achatado', () => {
    // Regressao que custou uma geracao paga: com os itens dos arrays atras de
    // `$ref`, o modelo chamou a ferramenta preenchida com `$PARAMETER_VALUE`.
    assert.equal(schema.$defs, undefined);
    assert.ok(!JSON.stringify(schema).includes('"$ref"'), 'sobrou um $ref no input_schema');
  });

  test('a regra de integridade referencial chega ao modelo (M1)', () => {
    // O schema E a definicao da ferramenta que o modelo le — nao basta a regra
    // estar nos prompts. Duas de duas falhas de modelagem do dia caíram no mesmo
    // lugar: gateways intermediarios referenciados em `flows` e nunca declarados
    // em `nodes`. Se um refactor do schema derrubar estes textos, a instrucao
    // desaparece sem ninguem notar — e o proximo sintoma e uma geracao paga.
    assert.match(schema.properties.flows.description, /ANTES DE EMITIR/);
    assert.match(schema.properties.flows.description, /declarado em nodes/);
    assert.match(schema.properties.nodes.description, /gateways intermediarios/);
    // E a instrucao tem de sobreviver ao achatamento do `$ref` de `flow`.
    assert.match(schema.properties.flows.items.description, /DECLARADOS em `nodes`/);
  });
});

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
