import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateProcessSpec, validateMeetingMinutes } from '../src/validate.js';
import { compileToBpmn } from '../src/compiler.js';
import { specSimples, specComRaias, specComLoop, specTodosOsTipos } from './fixtures.js';

/** Os codigos FATAIS emitidos, para asserts legiveis. */
function codigos(spec: unknown): string[] {
  return validateProcessSpec(spec).errors.map((e) => e.code);
}

/**
 * Os codigos de AVISO: defeitos que a validacao conserta ou tolera para o
 * diagrama poder sair. Ate 2026-08-04 quase todos estes eram fatais; a troca
 * veio da economia do passo (extracao paga e nao-deterministica) — ver o
 * comentario de `ValidationResult`. O que os testes garantem e que o defeito
 * continua sendo DETECTADO, so que sem abortar.
 */
function avisos(spec: unknown): string[] {
  return validateProcessSpec(spec).warnings.map((w) => w.code);
}

describe('validateProcessSpec — specs validos', () => {
  test('aceita o spec minimo', () => {
    const r = validateProcessSpec(specSimples());
    assert.equal(r.valid, true, JSON.stringify(r.errors));
  });

  test('aceita spec com raias, participantes e gateway rotulado', () => {
    const r = validateProcessSpec(specComRaias());
    assert.equal(r.valid, true, JSON.stringify(r.errors));
  });

  test('aceita spec com volta (back-edge)', () => {
    const r = validateProcessSpec(specComLoop());
    assert.equal(r.valid, true, JSON.stringify(r.errors));
  });

  test('aceita spec usando todos os tipos de no do schema', () => {
    const r = validateProcessSpec(specTodosOsTipos());
    assert.equal(r.valid, true, JSON.stringify(r.errors));
  });
});

describe('validateProcessSpec — schema', () => {
  test('rejeita objeto vazio e diz quais chaves chegaram', () => {
    const r = validateProcessSpec({});
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.code === 'FORMA_RECEBIDA'));
  });

  test('spec embrulhado ({ process_spec: ... }) reporta as chaves originais', () => {
    // Regressao: o Ajv roda com removeAdditional, entao ele ESVAZIA o objeto
    // antes de a mensagem ser montada. Sem capturar as chaves antes, o erro
    // dizia so "faltam process, nodes e flows" e escondia o que a IA devolveu.
    const r = validateProcessSpec({ process_spec: specSimples() });
    const forma = r.errors.find((e) => e.code === 'FORMA_RECEBIDA');
    assert.ok(forma, 'esperava o erro FORMA_RECEBIDA');
    assert.match(forma.message, /process_spec/);
  });

  test('rejeita id que nao serve como id BPMN', () => {
    const spec = specSimples();
    spec.nodes[0].id = 'inicio-com-hifen';
    spec.flows[0]!.source = 'inicio-com-hifen';
    assert.ok(codigos(spec).includes('SCHEMA'));
  });

  test('rejeita tipo de no inexistente', () => {
    // Um tipo plausivel mas ainda nao suportado: a IA precisa cair no schema, e
    // nao passar direto e quebrar so na compilacao. (Ate 2026-08-04 este teste
    // usava `inclusive_gateway`, que hoje existe de verdade.)
    const spec = specSimples() as unknown as { nodes: { type: string }[] };
    spec.nodes[1]!.type = 'call_activity';
    assert.ok(codigos(spec).includes('SCHEMA'));
  });
});

describe('validateProcessSpec — referencias', () => {
  test('avisa flow apontando para no inexistente (e descarta o flow)', () => {
    const spec = specSimples();
    spec.flows[1]!.target = 'nao_existe';
    assert.ok(avisos(spec).includes('FLOW_DESCARTADO'));
  });

  test('avisa flow saindo de no inexistente (e descarta o flow)', () => {
    const spec = specSimples();
    spec.flows[0]!.source = 'nao_existe';
    assert.ok(avisos(spec).includes('FLOW_DESCARTADO'));
  });

  test('avisa no em lane inexistente (cai em "Sem raia")', () => {
    const spec = specComRaias();
    spec.nodes[0].lane_id = 'lane_fantasma';
    assert.ok(avisos(spec).includes('NODE_BAD_LANE'));
  });

  test('avisa lane em participante inexistente', () => {
    const spec = specComRaias();
    spec.lanes![0]!.participant_id = 'participante_fantasma';
    assert.ok(avisos(spec).includes('LANE_BAD_PARTICIPANT'));
  });

  test('acusa id de no duplicado', () => {
    const spec = specSimples();
    spec.nodes[1]!.id = spec.nodes[0].id;
    assert.ok(codigos(spec).includes('DUPLICATE_ID'));
  });
});

describe('validateProcessSpec — estrutura do processo', () => {
  test('avisa processo sem start event', () => {
    const spec = specSimples();
    spec.nodes[0].type = 'user_task';
    assert.ok(avisos(spec).includes('NO_START'));
  });

  test('avisa processo sem end event', () => {
    const spec = specSimples();
    spec.nodes[2]!.type = 'user_task';
    assert.ok(avisos(spec).includes('NO_END'));
  });

  test('avisa no solto (sem entrada nem saida)', () => {
    const spec = specSimples();
    spec.nodes.push({ id: 'orfao', type: 'user_task', name: 'Tarefa solta' });
    assert.ok(avisos(spec).includes('NODE_DISCONNECTED'));
  });
});

describe('validateProcessSpec — gateways', () => {
  test('exige condicao ou rotulo nas saidas de gateway exclusivo', () => {
    const spec = specComRaias();
    for (const f of spec.flows) {
      if (f.source === 'decidir') {
        delete f.condition;
        delete f.name;
      }
    }
    assert.ok(avisos(spec).includes('EXCLUSIVE_FLOW_WITHOUT_CONDITION'));
  });

  test('rotulo sozinho ja basta (sem condition)', () => {
    const spec = specComRaias();
    for (const f of spec.flows) if (f.source === 'decidir') delete f.condition;
    assert.equal(validateProcessSpec(spec).valid, true);
  });

  test('gateway PARALELO nao exige condicao nas saidas', () => {
    // Regra deliberada: no paralelo todos os caminhos seguem juntos, nao ha o
    // que condicionar. Exigir condicao aqui abortaria o pipeline e jogaria fora
    // uma chamada de IA ja paga.
    const spec = specTodosOsTipos();
    for (const f of spec.flows) {
      if (f.source === 'paralelo') {
        delete f.condition;
        delete f.name;
      }
    }
    const r = validateProcessSpec(spec);
    assert.equal(r.valid, true, JSON.stringify(r.errors));
  });

  test('gateway exclusivo com saida unica nao exige condicao', () => {
    const spec = specSimples();
    spec.nodes.splice(1, 0, { id: 'porta', type: 'exclusive_gateway', name: 'Segue?' });
    spec.flows = [
      { id: 'f1', source: 'inicio', target: 'porta' },
      { id: 'f2', source: 'porta', target: 'preencher' },
      { id: 'f3', source: 'preencher', target: 'fim' },
    ];
    const r = validateProcessSpec(spec);
    assert.equal(r.valid, true, JSON.stringify(r.errors));
  });

  test('gateway INCLUSIVO tambem exige condicao nas saidas', () => {
    // O inclusivo e condicional como o exclusivo — o que muda e quantos ramos
    // seguem. Sem condicao ninguem sabe quais ramos rodam, e o join inclusivo
    // deixa de ter sentido.
    const spec = specTodosOsTipos();
    for (const f of spec.flows) {
      if (f.source === 'inclusivo_abre') {
        delete f.condition;
        delete f.name;
      }
    }
    assert.ok(avisos(spec).includes('EXCLUSIVE_FLOW_WITHOUT_CONDITION'));
  });

  test('gateway inclusivo de FECHAMENTO (uma saida so) nao exige condicao', () => {
    const r = validateProcessSpec(specTodosOsTipos());
    assert.equal(r.valid, true, JSON.stringify(r.errors));
  });
});

describe('validateProcessSpec — defeitos reparaveis', () => {
  test('fluxo apontando para no inexistente e DESCARTADO, nao fatal', () => {
    // O caso real de 2026-08-04 no recorte da ata de PO: 8 fluxos apontando para
    // 2 gateways que a IA esqueceu de declarar. 33 nos bons iam para o lixo.
    const spec = specComRaias();
    spec.flows.push({ id: 'f_orfao', source: 'decidir', target: 'gw_nao_declarado' });

    const r = validateProcessSpec(spec);
    assert.equal(r.valid, true, JSON.stringify(r.errors));
    assert.ok(r.warnings.some((w) => w.code === 'FLOW_DESCARTADO'));
    assert.ok(
      !spec.flows.some((f) => f.id === 'f_orfao'),
      'o fluxo orfao tem de sair do spec, senao o compilador explode nele',
    );
  });

  test('o spec reparado COMPILA — e o ponto de descartar em vez de abortar', async () => {
    const spec = specComRaias();
    spec.flows.push({ id: 'f_orfao', source: 'decidir', target: 'gw_nao_declarado' });
    validateProcessSpec(spec);
    const xml = await compileToBpmn(spec);
    assert.ok(xml.includes('bpmn:definitions') || xml.includes('bpmn:Definitions'));
  });

  test('rotulo faltando em gateway condicional vira aviso, nao erro', () => {
    const spec = specComRaias();
    for (const f of spec.flows) {
      if (f.source === 'decidir') {
        delete f.condition;
        delete f.name;
      }
    }
    const r = validateProcessSpec(spec);
    assert.equal(r.valid, true, JSON.stringify(r.errors));
    assert.ok(r.warnings.some((w) => w.code === 'EXCLUSIVE_FLOW_WITHOUT_CONDITION'));
  });

  test('spec SEM fluxo nenhum vira UM aviso, nao 56', () => {
    // Regressao do log de 2026-08-04: `flows` veio vazio e o usuario recebeu 56
    // linhas de NODE_DISCONNECTED que enterravam o unico fato que importava.
    const spec = specComRaias();
    spec.flows = [];
    const r = validateProcessSpec(spec);
    const soltos = r.warnings.filter((w) => w.code === 'NODE_DISCONNECTED');
    assert.equal(soltos.length, 1, 'era para ser um aviso resumido');
    assert.match(soltos[0]!.message, /NENHUM no esta conectado/);
  });

  test('ID duplicado CONTINUA fatal — nao da para consertar sem inventar', () => {
    const spec = specComRaias();
    spec.nodes.push({ ...spec.nodes[1]! });
    const r = validateProcessSpec(spec);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.code === 'DUPLICATE_ID'));
  });

  test('spec bom nao produz aviso nenhum', () => {
    const r = validateProcessSpec(specComRaias());
    assert.equal(r.valid, true);
    assert.deepEqual(r.warnings, []);
  });
});

describe('validateProcessSpec — event_based_gateway', () => {
  test('aceita a corrida quando os alvos sao esperas', () => {
    const r = validateProcessSpec(specTodosOsTipos());
    assert.equal(r.valid, true, JSON.stringify(r.errors));
  });

  test('acusa alvo que nao e evento de captura', () => {
    // O caso real: "vence quem responder primeiro" modelado como se fosse uma
    // decisao do processo. Sem corrida entre esperas o BPMN sai invalido — nao e
    // algo que o especialista conserte no painel depois.
    const spec = specTodosOsTipos();
    const f = spec.flows.find((x) => x.id === 'f12')!;
    f.target = 'humana';
    assert.ok(avisos(spec).includes('EVENT_GATEWAY_ALVO_INVALIDO'));
  });

  test('acusa corrida com um caminho so', () => {
    const spec = specTodosOsTipos();
    // Sobra `corrida -> espera_msg`; o timer passa a vir direto do inclusivo.
    spec.flows.find((x) => x.id === 'f13')!.source = 'inclusivo_fecha';
    assert.ok(avisos(spec).includes('EVENT_GATEWAY_SEM_CORRIDA'));
  });
});

describe('validateMeetingMinutes', () => {
  test('aceita uma ata com fluxo', () => {
    const r = validateMeetingMinutes({
      meeting: { title: 'Reuniao semanal' },
      participants: [{ name: 'Marcos', role: 'Gerente' }],
      topics: [{ title: 'Compras', summary: 'Revisamos o fluxo de compras.' }],
      process_flow: {
        name: 'Compras',
        steps: [{ actor: 'Solicitante', action: 'Abre o pedido' }],
      },
    });
    assert.equal(r.valid, true, JSON.stringify(r.errors));
  });

  test('acusa ata sem topico e sem etapa de fluxo', () => {
    // Regressao: isso falhava em SILENCIO — o renderizador pulava as secoes e o
    // usuario recebia uma ata quase vazia sem saber por que.
    const r = validateMeetingMinutes({
      meeting: { title: 'Reuniao semanal' },
      participants: [{ name: 'Marcos' }],
      topics: [],
      process_flow: { name: 'Nenhum', steps: [] },
    });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.code === 'ATA_VAZIA'));
  });

  test('acusa ata a que falta uma secao obrigatoria', () => {
    const r = validateMeetingMinutes({ meeting: { title: 'Reuniao semanal' } });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.code === 'SCHEMA'));
  });

  test('acusa forma completamente errada', () => {
    const r = validateMeetingMinutes({ meeting: 'so uma string' });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.code === 'SCHEMA'));
  });
});
