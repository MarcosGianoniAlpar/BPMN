import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import BpmnModdle, { type ModdleElement } from 'bpmn-moddle';
import { compileAndLayoutWithLanes } from '../src/laneLayout.js';
import {
  specComRaias,
  specComLoop,
  specTodosOsTipos,
  specFaixaDeValor,
  specComPonteCortada,
} from './fixtures.js';

interface Caixa {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Le o BPMN gerado e devolve os pedacos de DI que os testes inspecionam. */
async function layout(spec: Parameters<typeof compileAndLayoutWithLanes>[0]) {
  const xml = await compileAndLayoutWithLanes(spec);
  const moddle = new BpmnModdle();
  const { rootElement: definitions, warnings } = await moddle.fromXML(xml);

  const plane = definitions.get('diagrams')[0].get('plane');
  const planeElements: ModdleElement[] = plane.get('planeElement');

  const shapes = new Map<string, ModdleElement>();
  const edges = new Map<string, ModdleElement>();
  for (const di of planeElements) {
    const alvo = di.get('bpmnElement')?.id as string | undefined;
    if (!alvo) continue;
    if (di.$type === 'bpmndi:BPMNShape') shapes.set(alvo, di);
    else if (di.$type === 'bpmndi:BPMNEdge') edges.set(alvo, di);
  }

  const bounds = (id: string): Caixa => {
    const b = shapes.get(id)?.get('bounds');
    assert.ok(b, `sem DI para "${id}"`);
    return { x: b.get('x'), y: b.get('y'), width: b.get('width'), height: b.get('height') };
  };

  const waypoints = (flowId: string): { x: number; y: number }[] =>
    (edges.get(flowId)?.get('waypoint') ?? []).map((p: ModdleElement) => ({
      x: p.get('x'),
      y: p.get('y'),
    }));

  /** Todas as caixas de rotulo de aresta do diagrama, na ordem em que saem. */
  const rotulos = (): { flow: string; caixa: Caixa }[] => {
    const lista: { flow: string; caixa: Caixa }[] = [];
    for (const [flow, edge] of edges) {
      const b = edge.get('label')?.get('bounds');
      if (!b) continue;
      lista.push({
        flow,
        caixa: { x: b.get('x'), y: b.get('y'), width: b.get('width'), height: b.get('height') },
      });
    }
    return lista;
  };

  return { xml, definitions, warnings, shapes, edges, bounds, waypoints, plane, rotulos };
}

/** Sobreposicao estrita de duas caixas: encostar nao conta. */
function sobrepoe(a: Caixa, b: Caixa): boolean {
  return (
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
  );
}

/** Pares de rotulos que se sobrepoem — a metrica do L1: tem de dar 0. */
function paresSobrepostos(lista: { flow: string; caixa: Caixa }[]): string[] {
  const pares: string[] = [];
  for (let i = 0; i < lista.length; i++) {
    for (let j = i + 1; j < lista.length; j++) {
      if (sobrepoe(lista[i]!.caixa, lista[j]!.caixa)) pares.push(`${lista[i]!.flow}/${lista[j]!.flow}`);
    }
  }
  return pares;
}

describe('laneLayout — estrutura', () => {
  test('gera XML que o bpmn-moddle reparseia sem warnings', async () => {
    const { warnings } = await layout(specComRaias());
    assert.deepEqual(warnings, []);
  });

  test('o plano desenha a Collaboration (e nao o Process)', async () => {
    // Com pools, o BPMNPlane tem que apontar para a Collaboration; apontando
    // para o Process o bpmn-js nao desenha as faixas.
    const { plane } = await layout(specComRaias());
    assert.equal(plane.get('bpmnElement').$type, 'bpmn:Collaboration');
  });

  test('emite laneSet com cada no na sua raia', async () => {
    const { definitions } = await layout(specComRaias());
    const process = definitions
      .get('rootElements')
      .find((e: ModdleElement) => e.$type === 'bpmn:Process');
    const lanes: ModdleElement[] = process.get('laneSets')[0].get('lanes');

    assert.deepEqual(
      lanes.map((l) => l.get('name')),
      ['Solicitante', 'Gerencia'],
    );

    const gerencia = lanes.find((l) => l.get('name') === 'Gerencia')!;
    assert.deepEqual(
      gerencia.get('flowNodeRef').map((n: ModdleElement) => n.id).sort(),
      ['analisar', 'decidir'],
    );
  });

  test('participante externo vira pool caixa-preta (sem processRef)', async () => {
    const { definitions, shapes } = await layout(specComRaias());
    const collab = definitions
      .get('rootElements')
      .find((e: ModdleElement) => e.$type === 'bpmn:Collaboration');
    const externo = collab
      .get('participants')
      .find((p: ModdleElement) => p.get('name') === 'Fornecedor');

    assert.ok(externo, 'esperava um pool para o participante externo');
    assert.equal(externo.get('processRef'), undefined, 'pool externo nao tem processo');
    assert.ok(shapes.has(externo.id), 'o pool externo precisa de DI, senao nao aparece');
  });

  test('o pool interno leva o nome do participante interno', async () => {
    const { definitions } = await layout(specComRaias());
    const collab = definitions
      .get('rootElements')
      .find((e: ModdleElement) => e.$type === 'bpmn:Collaboration');
    const interno = collab
      .get('participants')
      .find((p: ModdleElement) => p.get('processRef') !== undefined);
    assert.equal(interno.get('name'), 'Alpar');
  });

  test('nos sem raia caem numa faixa "Sem raia", nao somem', async () => {
    const spec = specComRaias();
    delete spec.nodes[0].lane_id;
    const { definitions } = await layout(spec);
    const process = definitions
      .get('rootElements')
      .find((e: ModdleElement) => e.$type === 'bpmn:Process');
    const nomes = process.get('laneSets')[0]
      .get('lanes')
      .map((l: ModdleElement) => l.get('name'));
    assert.ok(nomes.includes('Sem raia'));
  });
});

describe('laneLayout — geometria', () => {
  test('X cresce com a posicao no fluxo', async () => {
    const { bounds } = await layout(specComRaias());
    assert.ok(bounds('inicio').x < bounds('analisar').x);
    assert.ok(bounds('analisar').x < bounds('decidir').x);
    assert.ok(bounds('decidir').x < bounds('fim').x);
  });

  test('Y e determinado pela raia, nao pela ordem do fluxo', async () => {
    const { bounds } = await layout(specComRaias());
    // Solicitante e a primeira raia, Gerencia a segunda.
    assert.ok(bounds('inicio').y < bounds('analisar').y, 'raia 1 acima da raia 2');
    assert.ok(bounds('fim').y < bounds('decidir').y, 'fim volta para a raia 1');
  });

  test('nos da mesma raia ficam dentro da faixa dela', async () => {
    const { bounds, shapes, definitions } = await layout(specComRaias());
    const process = definitions
      .get('rootElements')
      .find((e: ModdleElement) => e.$type === 'bpmn:Process');
    const laneGerencia = process
      .get('laneSets')[0]
      .get('lanes')
      .find((l: ModdleElement) => l.get('name') === 'Gerencia');
    const faixa = shapes.get(laneGerencia.id)!.get('bounds');
    const topo = faixa.get('y');
    const base = topo + faixa.get('height');

    for (const id of ['analisar', 'decidir']) {
      const b = bounds(id);
      assert.ok(b.y >= topo, `${id} acima da faixa`);
      assert.ok(b.y + b.height <= base, `${id} abaixo da faixa`);
    }
  });

  test('a faixa CRESCE quando dois nos caem na mesma raia e camada', async () => {
    // Regressao: a altura da faixa era a constante 130, entao dois `user_task`
    // de 80px abertos por um `parallel_gateway` na MESMA raia dividiam a faixa
    // em fatias de 65 e se sobrepunham — e ainda vazavam para fora do pool. O
    // bpmnlint acusava `no-overlapping-elements`. E o caso da secao 4 da ata de
    // PO (orcamento e estoque checados ao mesmo tempo).
    const spec = specComRaias();
    spec.nodes.push(
      { id: 'abrir', type: 'parallel_gateway', name: 'Dividir', lane_id: 'gerencia' },
      { id: 'checar_a', type: 'user_task', name: 'Checar orcamento', lane_id: 'gerencia' },
      { id: 'checar_b', type: 'user_task', name: 'Checar estoque', lane_id: 'gerencia' },
      { id: 'fechar', type: 'parallel_gateway', name: 'Juntar', lane_id: 'gerencia' },
    );
    spec.flows = [
      { id: 'f1', source: 'inicio', target: 'abrir' },
      { id: 'f2', source: 'abrir', target: 'checar_a' },
      { id: 'f3', source: 'abrir', target: 'checar_b' },
      { id: 'f4', source: 'checar_a', target: 'fechar' },
      { id: 'f5', source: 'checar_b', target: 'fechar' },
      { id: 'f6', source: 'fechar', target: 'fim' },
    ];

    const { bounds, shapes, definitions } = await layout(spec);
    const a = bounds('checar_a');
    const b = bounds('checar_b');
    const [cima, baixo] = a.y <= b.y ? [a, b] : [b, a];
    assert.ok(
      cima.y + cima.height <= baixo.y,
      `as duas tarefas se sobrepoem: ${JSON.stringify({ cima, baixo })}`,
    );

    // E as duas continuam DENTRO da faixa da propria raia.
    const process = definitions
      .get('rootElements')
      .find((e: ModdleElement) => e.$type === 'bpmn:Process');
    const laneGerencia = process
      .get('laneSets')[0]
      .get('lanes')
      .find((l: ModdleElement) => l.get('name') === 'Gerencia');
    const faixa = shapes.get(laneGerencia.id)!.get('bounds');
    assert.ok(cima.y >= faixa.get('y'), 'tarefa acima da faixa');
    assert.ok(
      baixo.y + baixo.height <= faixa.get('y') + faixa.get('height'),
      'tarefa vazando para fora da faixa',
    );
  });

  test('raia com um no so mantem a altura minima', async () => {
    // A faixa cresce sob demanda; ela nao pode encolher nem inflar sozinha.
    const { shapes, definitions } = await layout(specComRaias());
    const process = definitions
      .get('rootElements')
      .find((e: ModdleElement) => e.$type === 'bpmn:Process');
    for (const lane of process.get('laneSets')[0].get('lanes')) {
      assert.equal(shapes.get(lane.id)!.get('bounds').get('height'), 130);
    }
  });

  test('eventos sao circulos, gateways losangos e tarefas retangulos', async () => {
    const { bounds } = await layout(specTodosOsTipos());
    assert.deepEqual(
      [bounds('inicio').width, bounds('inicio').height],
      [36, 36],
      'evento de inicio',
    );
    assert.deepEqual([bounds('espera_tempo').width, bounds('espera_tempo').height], [36, 36]);
    assert.deepEqual([bounds('decisao').width, bounds('decisao').height], [50, 50]);
    assert.deepEqual([bounds('paralelo').width, bounds('paralelo').height], [50, 50]);
    // Os quatro gateways sao losangos do mesmo tamanho; o que muda e o simbolo
    // desenhado dentro. Um tipo novo esquecido no `nodeSize` cairia no default
    // (retangulo de tarefa) e sairia um losango deformado.
    assert.deepEqual(
      [bounds('inclusivo_abre').width, bounds('inclusivo_abre').height],
      [50, 50],
    );
    assert.deepEqual([bounds('corrida').width, bounds('corrida').height], [50, 50]);
    assert.deepEqual([bounds('humana').width, bounds('humana').height], [100, 80]);
  });

  test('o pool cobre todas as faixas', async () => {
    const { shapes, definitions } = await layout(specComRaias());
    const collab = definitions
      .get('rootElements')
      .find((e: ModdleElement) => e.$type === 'bpmn:Collaboration');
    const interno = collab
      .get('participants')
      .find((p: ModdleElement) => p.get('processRef') !== undefined);
    const pool = shapes.get(interno.id)!.get('bounds');

    const process = definitions
      .get('rootElements')
      .find((e: ModdleElement) => e.$type === 'bpmn:Process');
    const lanes: ModdleElement[] = process.get('laneSets')[0].get('lanes');
    const alturaDasFaixas = lanes.reduce(
      (soma, l) => soma + shapes.get(l.id)!.get('bounds').get('height'),
      0,
    );
    assert.equal(pool.get('height'), alturaDasFaixas);
  });
});

describe('laneLayout — voltas (back-edges)', () => {
  test('a volta nao empurra os nos do loop para a direita', async () => {
    // Regressao real: contar o ciclo no calculo de camadas empurrava "revisar"
    // para tao longe que a ordem do desenho invertia — e o "Sim" do gateway
    // acabava desenhado como seta de retorno, dando a volta por baixo.
    const { bounds } = await layout(specComLoop());
    assert.ok(bounds('inicio').x < bounds('revisar').x, 'revisar depois do inicio');
    assert.ok(bounds('revisar').x < bounds('aprovado').x, 'aprovado depois de revisar');
    assert.ok(bounds('aprovado').x < bounds('fim').x, 'fim depois do gateway');
  });

  test('a aresta de volta e roteada por baixo dos dois nos', async () => {
    const { bounds, waypoints } = await layout(specComLoop());
    const volta = waypoints('f4'); // aprovado -> revisar
    assert.ok(volta.length >= 4, 'a volta precisa de dobras, nao de uma reta');

    const baseMaisBaixa = Math.max(
      bounds('aprovado').y + bounds('aprovado').height,
      bounds('revisar').y + bounds('revisar').height,
    );
    const yMax = Math.max(...volta.map((p) => p.y));
    assert.ok(yMax > baseMaisBaixa, 'a volta deve passar por baixo dos nos');
  });

  test('o caminho adiante continua sendo uma seta simples', async () => {
    const { waypoints } = await layout(specComLoop());
    const adiante = waypoints('f3'); // aprovado -> fim
    assert.ok(adiante.length <= 4);
    assert.ok(
      adiante[adiante.length - 1]!.x > adiante[0]!.x,
      'o fluxo adiante vai da esquerda para a direita',
    );
  });
});

describe('laneLayout — nos orfaos (ponte cortada)', () => {
  test('o fragmento desconectado se espalha em colunas, nao empilha na coluna 0', async () => {
    // Regressao do L2: `computeLayers` semeava so pelos start events e jogava
    // todo inalcancavel na camada 0 — a coluna da extrema esquerda. Como um
    // fluxo descartado costuma ser a PONTE para o resto do processo, tudo a
    // jusante virava orfao de uma vez: ~19 nos numa coluna so.
    const { bounds } = await layout(specComPonteCortada());
    assert.ok(bounds('conferir').x < bounds('registrar').x, 'registrar depois de conferir');
    assert.ok(bounds('registrar').x < bounds('notificar').x, 'notificar depois de registrar');
    assert.ok(bounds('notificar').x < bounds('fim').x, 'fim depois de notificar');
  });

  test('nenhuma coluna concentra mais que um terco das formas', async () => {
    // A metrica do relatorio: cortando a ponte num spec salvo, a coluna mais
    // cheia saltava de 9% para 30% das formas. Aqui o fragmento tem 4 dos 6
    // nos — se caissem todos na camada 0 seriam 67%.
    const spec = specComPonteCortada();
    const { bounds } = await layout(spec);
    const porColuna = new Map<number, number>();
    for (const n of spec.nodes) {
      const x = bounds(n.id).x;
      porColuna.set(x, (porColuna.get(x) ?? 0) + 1);
    }
    const maisCheia = Math.max(...porColuna.values());
    assert.ok(
      maisCheia <= Math.ceil(spec.nodes.length / 3),
      `a coluna mais cheia tem ${maisCheia} de ${spec.nodes.length} nos`,
    );
  });

  test('orfao que APONTA para o processo fica a esquerda do seu destino', async () => {
    // O outro sentido da propagacao: o no nao e alcancavel a partir do start,
    // mas alimenta alguem que e. A camada dele vem de `sucessor - 1` — nao de 0,
    // que o mandaria para a ponta esquerda do desenho, longe do que ele alimenta.
    const spec = specComRaias();
    spec.nodes.push({
      id: 'anexo',
      type: 'user_task',
      name: 'Anexar nota fiscal',
      lane_id: 'solicitante',
    });
    spec.flows.push({ id: 'f6', source: 'anexo', target: 'fim' });

    const { bounds } = await layout(spec);
    assert.ok(bounds('anexo').x < bounds('fim').x, 'anexo antes do destino');
    assert.ok(bounds('anexo').x > bounds('inicio').x, 'anexo NAO foi jogado na coluna 0');
  });

  test('no totalmente solto (sem vizinho nenhum) continua indo para a coluna 0', async () => {
    // O caso em que nao ha de onde derivar nada. Ele nao pode sumir nem quebrar
    // o layout; a coluna 0 e o lugar honesto para ele.
    const spec = specComRaias();
    spec.nodes.push({ id: 'solto', type: 'user_task', name: 'Tarefa solta', lane_id: 'gerencia' });

    // Compara o CENTRO: as caixas sao centradas na coluna, e uma tarefa (100px)
    // e um evento de inicio (36px) na mesma coluna tem `x` diferente.
    const { bounds } = await layout(spec);
    const centro = (id: string): number => bounds(id).x + bounds(id).width / 2;
    assert.equal(centro('solto'), centro('inicio'));
  });
});

describe('laneLayout — rotulos de aresta', () => {
  test('aresta com nome ganha BPMNLabel com bounds proprios', async () => {
    // Sem BPMNLabel explicito o bpmn-js centraliza o texto NO MEIO DA SETA, por
    // cima da linha — que era exatamente o defeito relatado.
    const { edges } = await layout(specComRaias());
    const label = edges.get('f3')!.get('label');
    assert.ok(label, 'a aresta "Sim" precisa de rotulo posicionado');
    const b = label.get('bounds');
    assert.ok(b.get('width') > 0 && b.get('height') > 0);
  });

  test('aresta sem nome nao ganha rotulo', async () => {
    const { edges } = await layout(specComRaias());
    assert.equal(edges.get('f1')!.get('label'), undefined);
  });

  test('o rotulo nao fica em cima da linha', async () => {
    const { edges, waypoints } = await layout(specComRaias());
    const b = edges.get('f3')!.get('label').get('bounds');
    const rotulo = {
      topo: b.get('y') as number,
      base: (b.get('y') as number) + (b.get('height') as number),
      esq: b.get('x') as number,
      dir: (b.get('x') as number) + (b.get('width') as number),
    };

    // Nenhum ponto do primeiro trecho da aresta pode cair dentro do retangulo
    // do rotulo.
    const pontos = waypoints('f3').slice(0, 2);
    for (const p of pontos) {
      const dentro =
        p.x >= rotulo.esq && p.x <= rotulo.dir && p.y >= rotulo.topo && p.y <= rotulo.base;
      assert.ok(!dentro, `o waypoint (${p.x},${p.y}) cai dentro do rotulo`);
    }
  });

  test('tres saidas do mesmo gateway NAO imprimem uma por cima da outra', async () => {
    // Regressao do L1, achada olhando o PNG e nao o log: `npm test`, bpmnlint e o
    // pipeline inteiro passavam verdes. `routeEdge` faz toda saida partir da
    // direita da origem, na altura do centro, entao f2/f3/f4 tinham o mesmo
    // primeiro trecho — mesmo x, mesmo y, tres rotulos no mesmo lugar.
    const { rotulos } = await layout(specFaixaDeValor());
    const lista = rotulos();
    assert.equal(lista.length, 3, 'as tres saidas rotuladas precisam de rotulo');
    assert.deepEqual(paresSobrepostos(lista), []);
  });

  test('nenhuma fixture produz par de rotulos sobreposto', async () => {
    // A medida do L1 no diagrama real era 16 rotulos e 14 pares sobrepostos.
    for (const [nome, spec] of [
      ['specComRaias', specComRaias()],
      ['specComLoop', specComLoop()],
      ['specTodosOsTipos', specTodosOsTipos()],
      ['specFaixaDeValor', specFaixaDeValor()],
    ] as const) {
      const { rotulos } = await layout(spec);
      assert.deepEqual(paresSobrepostos(rotulos()), [], `${nome} tem rotulo sobreposto`);
    }
  });

  test('empilhar sobe o rotulo, nunca o joga sobre a propria linha', async () => {
    const { rotulos, waypoints } = await layout(specFaixaDeValor());
    for (const { flow, caixa } of rotulos()) {
      for (const p of waypoints(flow).slice(0, 2)) {
        const dentro =
          p.x >= caixa.x &&
          p.x <= caixa.x + caixa.width &&
          p.y >= caixa.y &&
          p.y <= caixa.y + caixa.height;
        assert.ok(!dentro, `${flow}: o waypoint (${p.x},${p.y}) caiu dentro do rotulo`);
      }
    }
  });

  test('o rotulo fica perto da origem, onde a decisao e lida', async () => {
    // "Sim"/"Nao" tem que ser lido junto do gateway, nao no meio do caminho ate
    // o destino.
    const { edges, bounds, waypoints } = await layout(specComRaias());
    const b = edges.get('f3')!.get('label').get('bounds');
    const meioDoRotuloX = (b.get('x') as number) + (b.get('width') as number) / 2;

    const gateway = bounds('decidir');
    const destino = bounds('comprar');
    const pontos = waypoints('f3');
    const distanciaTotal = Math.abs(pontos[pontos.length - 1]!.x - pontos[0]!.x);

    assert.ok(
      Math.abs(meioDoRotuloX - (gateway.x + gateway.width)) <= distanciaTotal / 2 + 1,
      'o rotulo deveria estar na primeira metade da aresta',
    );
    assert.ok(meioDoRotuloX < destino.x + destino.width, 'o rotulo nao deve passar do destino');
  });
});
