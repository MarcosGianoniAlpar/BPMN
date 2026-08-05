import BpmnModdle, { type ModdleElement } from 'bpmn-moddle';
import type { NodeType, ProcessSpec, ProcessNode } from './types/process-spec.js';
import { createFlowNode } from './bpmnNodes.js';

/**
 * Layout ciente de raias (Fase 2). O `bpmn-auto-layout` NAO desenha lanes/pools,
 * entao aqui geramos a geometria (DI) por conta propria quando o ProcessSpec tem
 * lanes: a posicao X vem da camada do no no fluxo (ordem topologica) e a posicao
 * Y vem da raia a que o no pertence. Emitimos um pool (participante interno) com
 * faixas horizontais, alem de participantes externos como pools caixa-preta.
 *
 * Escopo: um pool interno com lanes (caso comum destas atas). Message flows entre
 * pools ainda nao sao desenhados (proximo passo). Para processos SEM lanes, o
 * caminho continua sendo compiler.ts + bpmn-auto-layout.
 */

const TARGET_NAMESPACE = 'https://alpar.local/bpmn';

// Geometria (px).
const POOL_X = 160;
const POOL_Y = 80;
const POOL_HEADER_W = 30; // faixa vertical do nome do pool
const LANE_HEADER_W = 30; // faixa vertical do nome da lane
const CONTENT_PAD_L = 30; // respiro apos os cabecalhos
const COL_W = 160; // distancia horizontal entre camadas
// Altura da faixa: MINIMA, nao fixa. Quando dois nos caem na mesma raia E na
// mesma camada (o caso comum: um `parallel_gateway` abrindo dois ramos dentro do
// mesmo departamento), a faixa cresce para caber os dois. Com altura fixa, duas
// tarefas de 80px dividiam 130px em fatias de 65 e se sobrepunham — o bpmnlint
// acusava `no-overlapping-elements` e "Element is outside of parent boundary".
const LANE_H_MIN = 130;
const NODE_SLOT_H = 100; // espaco vertical por no empilhado: 80 da tarefa + respiro
const RIGHT_PAD = 60;
const EXTERNAL_POOL_H = 80;
const EXTERNAL_POOL_GAP = 40;

// Rotulo de aresta (o "Sim"/"Nao" dos gateways).
const EDGE_LABEL_H = 14; // uma linha na fonte padrao do bpmn-js
const EDGE_LABEL_CHAR_W = 6.5; // largura media por caractere, ~11px Arial
const EDGE_LABEL_MIN_W = 30;
const EDGE_LABEL_GAP = 6; // afastamento da linha, para o texto nao ficar em cima
const EDGE_LABEL_STACK_GAP = 4; // folga entre dois rotulos empilhados

function nodeSize(type: NodeType): { w: number; h: number } {
  switch (type) {
    // Eventos (inicio, fim e os intermediarios de espera) sao circulos.
    case 'start_event':
    case 'end_event':
    case 'timer_event':
    case 'message_event':
      return { w: 36, h: 36 };
    // Gateways sao losangos — todos do mesmo tamanho; o que muda e o simbolo
    // desenhado dentro (X, +, O, pentagono), que vem do tipo do elemento BPMN.
    case 'exclusive_gateway':
    case 'parallel_gateway':
    case 'inclusive_gateway':
    case 'event_based_gateway':
      return { w: 50, h: 50 };
    default:
      return { w: 100, h: 80 };
  }
}

/**
 * Camada (coluna) de cada no: maior caminho a partir de um start event,
 * DESCONSIDERANDO as voltas (back-edges) — senao um loop de reprovacao empurra
 * os proprios nos para a direita a cada volta contada.
 *
 * Quem nao e alcancavel a partir do start NAO vai mais para a camada 0. Isso
 * importa porque a validacao reparavel descarta os fluxos que apontam para nos
 * inexistentes: quando o fluxo descartado era a PONTE para o resto do processo,
 * tudo a jusante vira inalcancavel de uma vez. Numa rodada real foram ~19 nos
 * empilhados na coluna da extrema esquerda — 6 setas a menos, e um desenho
 * irreconhecivel. A camada do orfao passa a vir dos vizinhos que sobraram
 * (predecessor + 1, ou sucessor - 1); so um fragmento inteiramente solto ganha
 * um inicio proprio.
 */
function computeLayers(spec: ProcessSpec): Map<string, number> {
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const n of spec.nodes) {
    outgoing.set(n.id, []);
    incoming.set(n.id, []);
  }
  for (const f of spec.flows) {
    outgoing.get(f.source)?.push(f.target);
    incoming.get(f.target)?.push(f.source);
  }

  const layer = new Map<string, number>();

  // `path` = nos no caminho atual da busca. Uma seta que aponta para alguem que
  // JA esta nesse caminho e uma volta (o "reprovado -> revisar" dos processos de
  // aprovacao). Ela continua sendo desenhada, mas NAO entra na conta da camada.
  //
  // Sem isso o contador percorria o ciclo repetidamente ate bater num limite de
  // profundidade e empurrava os nos do loop para a direita — a ponto de inverter
  // a ordem, e um passo adiante (o "Sim" de um gateway) acabava desenhado como
  // seta de retorno, dando a volta por baixo. Ignorar back-edges e o
  // comportamento normal de um layout em camadas.
  const path = new Set<string>();
  const visit = (id: string, depth: number): void => {
    const cur = layer.get(id);
    if (cur !== undefined && cur >= depth) return;
    layer.set(id, depth);
    path.add(id);
    for (const t of outgoing.get(id) ?? []) {
      if (path.has(t)) continue;
      visit(t, depth + 1);
    }
    path.delete(id);
  };

  const starts = spec.nodes.filter((n) => n.type === 'start_event').map((n) => n.id);
  const seeds = starts.length ? starts : spec.nodes.length ? [spec.nodes[0]!.id] : [];
  for (const s of seeds) visit(s, 0);

  // Deriva a camada de quem sobrou a partir dos vizinhos ja posicionados, ate
  // estabilizar. Predecessor tem prioridade sobre sucessor: um orfao que ALIMENTA
  // o processo pertence a esquerda de quem ele alimenta, mas um orfao alimentado
  // por alguem pertence a direita — e a segunda leitura e a que preserva a ordem
  // de leitura do desenho.
  const propagarDosVizinhos = (): void => {
    for (let mudou = true; mudou; ) {
      mudou = false;
      for (const n of spec.nodes) {
        if (layer.has(n.id)) continue;
        let alvo: number | undefined;
        for (const p of incoming.get(n.id)!) {
          const l = layer.get(p);
          if (l !== undefined) alvo = alvo === undefined ? l + 1 : Math.max(alvo, l + 1);
        }
        if (alvo === undefined) {
          for (const s of outgoing.get(n.id)!) {
            const l = layer.get(s);
            if (l !== undefined) alvo = alvo === undefined ? l - 1 : Math.min(alvo, l - 1);
          }
        }
        if (alvo !== undefined) {
          layer.set(n.id, alvo);
          mudou = true;
        }
      }
    }
  };

  // Comeco de um fragmento solto: sobe pelos predecessores que tambem estao sem
  // camada, para o fragmento ser desenhado da sua propria origem em diante.
  const inicioDoFragmento = (id: string): string => {
    const visto = new Set([id]);
    let atual = id;
    for (;;) {
      const anterior = incoming.get(atual)!.find((p) => !layer.has(p) && !visto.has(p));
      if (!anterior) return atual;
      visto.add(anterior);
      atual = anterior;
    }
  };

  for (;;) {
    propagarDosVizinhos();
    const solto = spec.nodes.find((n) => !layer.has(n.id));
    if (!solto) break;
    // Fragmento sem ligacao nenhuma com o que ja foi posicionado — o caso do
    // chunking, em que cada chamada devolve um pedaco. Ele ganha um inicio
    // proprio e se espalha em colunas, em vez de virar uma pilha na coluna 0.
    visit(inicioDoFragmento(solto.id), 0);
  }

  // `sucessor - 1` pode gerar camada negativa. A camada e relativa, entao basta
  // deslocar tudo para que a menor volte a ser 0.
  const menor = Math.min(...layer.values());
  if (menor < 0) for (const [id, l] of layer) layer.set(id, l - menor);
  return layer;
}

interface Placed {
  node: ProcessNode;
  x: number;
  y: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
}

/** Ordena as lanes: as declaradas no spec, e uma lane implicita para nos sem lane. */
function orderedLaneIds(spec: ProcessSpec): { ids: string[]; names: Map<string, string> } {
  const names = new Map<string, string>();
  const ids: string[] = [];
  for (const l of spec.lanes ?? []) {
    ids.push(l.id);
    names.set(l.id, l.name);
  }
  const hasUnlaned = spec.nodes.some((n) => !n.lane_id || !names.has(n.lane_id));
  if (hasUnlaned) {
    ids.push('__default__');
    names.set('__default__', 'Sem raia');
  }
  return { ids, names };
}

function laneOf(node: ProcessNode, laneIds: string[]): string {
  if (node.lane_id && laneIds.includes(node.lane_id)) return node.lane_id;
  return '__default__';
}

/** Faixa horizontal de uma raia: onde comeca e quanto ocupa. */
interface Faixa {
  top: number;
  height: number;
}

/**
 * Posiciona os nos: X pela camada, Y pela raia. Se varios nos caem na mesma
 * (raia, camada), distribui verticalmente dentro da faixa — e a faixa cresce
 * para caber todos, em vez de espremer.
 */
function placeNodes(
  spec: ProcessSpec,
  laneIds: string[],
  layers: Map<string, number>,
): {
  placed: Map<string, Placed>;
  faixas: Map<string, Faixa>;
  maxLayer: number;
  contentLeft: number;
  poolHeight: number;
} {
  const contentLeft = POOL_X + POOL_HEADER_W + LANE_HEADER_W + CONTENT_PAD_L;

  // 1. Agrupa por (lane, layer) para tratar colisoes, guardando de passagem o
  //    bucket mais cheio de cada raia — e ele que define a altura da faixa.
  const buckets = new Map<string, ProcessNode[]>();
  const maxPorFaixa = new Map<string, number>();
  let maxLayer = 0;
  for (const n of spec.nodes) {
    const lane = laneOf(n, laneIds);
    const lyr = layers.get(n.id) ?? 0;
    maxLayer = Math.max(maxLayer, lyr);
    const key = `${lane}|${lyr}`;
    const group = buckets.get(key) ?? buckets.set(key, []).get(key)!;
    group.push(n);
    maxPorFaixa.set(lane, Math.max(maxPorFaixa.get(lane) ?? 1, group.length));
  }

  // 2. Altura e topo de cada faixa. As faixas sao empilhadas, entao o topo de
  //    uma depende da altura de todas as anteriores — nao da mais para calcular
  //    por indice (`i * LANE_H`).
  const faixas = new Map<string, Faixa>();
  let top = POOL_Y;
  for (const laneId of laneIds) {
    const height = Math.max(LANE_H_MIN, (maxPorFaixa.get(laneId) ?? 1) * NODE_SLOT_H);
    faixas.set(laneId, { top, height });
    top += height;
  }

  // 3. Posicao de cada no dentro da sua faixa.
  const placed = new Map<string, Placed>();
  for (const [key, group] of buckets) {
    const [lane, lyrStr] = key.split('|');
    const faixa = faixas.get(lane!)!;
    const colCx = contentLeft + Number(lyrStr) * COL_W + 50; // 50 = meia largura de task

    group.forEach((n, idx) => {
      const { w, h } = nodeSize(n.type);
      // Distribui os nos do bucket verticalmente dentro da faixa.
      const slotH = faixa.height / group.length;
      const cy = faixa.top + slotH * (idx + 0.5);
      const cx = colCx;
      placed.set(n.id, { node: n, x: cx - w / 2, y: cy - h / 2, w, h, cx, cy });
    });
  }
  return { placed, faixas, maxLayer, contentLeft, poolHeight: top - POOL_Y };
}

export async function compileAndLayoutWithLanes(spec: ProcessSpec): Promise<string> {
  const moddle = new BpmnModdle();
  const { ids: laneIds, names: laneNames } = orderedLaneIds(spec);
  const layers = computeLayers(spec);
  const { placed, faixas, maxLayer, contentLeft, poolHeight } = placeNodes(spec, laneIds, layers);

  const processId = `Process_${spec.process.id}`;

  // --- Semantica: process com flowElements + laneSet ---
  const process: ModdleElement = moddle.create('bpmn:Process', {
    id: processId,
    name: spec.process.name,
    isExecutable: false,
  });
  const flowElements: ModdleElement[] = process.get('flowElements');

  const nodeById = new Map<string, ModdleElement>();
  for (const node of spec.nodes) {
    const el = createFlowNode(moddle, node);
    nodeById.set(node.id, el);
    flowElements.push(el);
  }

  const flowById = new Map<string, ModdleElement>();
  for (const flow of spec.flows) {
    const source = nodeById.get(flow.source)!;
    const target = nodeById.get(flow.target)!;
    const seqFlow: ModdleElement = moddle.create('bpmn:SequenceFlow', {
      id: flow.id,
      sourceRef: source,
      targetRef: target,
      ...(flow.name ? { name: flow.name } : {}),
    });
    if (flow.condition) {
      seqFlow.set('conditionExpression', moddle.create('bpmn:FormalExpression', { body: flow.condition }));
    }
    source.get('outgoing').push(seqFlow);
    target.get('incoming').push(seqFlow);
    flowElements.push(seqFlow);
    flowById.set(flow.id, seqFlow);
  }

  // laneSet
  const laneEls = new Map<string, ModdleElement>();
  const lanes: ModdleElement[] = [];
  for (const laneId of laneIds) {
    const laneEl: ModdleElement = moddle.create('bpmn:Lane', {
      id: `Lane_${laneId}`,
      name: laneNames.get(laneId),
    });
    const refs: ModdleElement[] = laneEl.get('flowNodeRef');
    for (const n of spec.nodes) {
      if (laneOf(n, laneIds) === laneId) refs.push(nodeById.get(n.id)!);
    }
    laneEls.set(laneId, laneEl);
    lanes.push(laneEl);
  }
  const laneSet: ModdleElement = moddle.create('bpmn:LaneSet', {
    id: `LaneSet_${spec.process.id}`,
    lanes,
  });
  process.get('laneSets').push(laneSet);

  // --- Collaboration: pool interno + pools externos (caixa-preta) ---
  const internalPart: ModdleElement = moddle.create('bpmn:Participant', {
    id: `Participant_${spec.process.id}`,
    name: internalPoolName(spec),
    processRef: process,
  });
  const externalParts = (spec.participants ?? [])
    .filter((p) => p.type === 'external')
    .map((p) => moddle.create('bpmn:Participant', { id: `Participant_${p.id}`, name: p.name }));

  const collaboration: ModdleElement = moddle.create('bpmn:Collaboration', {
    id: `Collaboration_${spec.process.id}`,
    participants: [internalPart, ...externalParts],
  });

  const definitions: ModdleElement = moddle.create('bpmn:Definitions', {
    id: `Definitions_${spec.process.id}`,
    targetNamespace: TARGET_NAMESPACE,
    rootElements: [collaboration, process],
  });

  // --- DI (geometria) ---
  const poolWidth = contentLeft + (maxLayer + 1) * COL_W + RIGHT_PAD - POOL_X;

  const planeElements: ModdleElement[] = [];

  // Pool
  planeElements.push(
    moddle.create('bpmndi:BPMNShape', {
      id: `${internalPart.id}_di`,
      bpmnElement: internalPart,
      isHorizontal: true,
      bounds: moddle.create('dc:Bounds', { x: POOL_X, y: POOL_Y, width: poolWidth, height: poolHeight }),
    }),
  );

  // Lanes
  for (const laneId of laneIds) {
    const laneEl = laneEls.get(laneId)!;
    const faixa = faixas.get(laneId)!;
    planeElements.push(
      moddle.create('bpmndi:BPMNShape', {
        id: `${laneEl.id}_di`,
        bpmnElement: laneEl,
        isHorizontal: true,
        bounds: moddle.create('dc:Bounds', {
          x: POOL_X + POOL_HEADER_W,
          y: faixa.top,
          width: poolWidth - POOL_HEADER_W,
          height: faixa.height,
        }),
      }),
    );
  }

  // Nodes
  for (const p of placed.values()) {
    planeElements.push(
      moddle.create('bpmndi:BPMNShape', {
        id: `${p.node.id}_di`,
        bpmnElement: nodeById.get(p.node.id),
        bounds: moddle.create('dc:Bounds', { x: p.x, y: p.y, width: p.w, height: p.h }),
      }),
    );
  }

  // Edges. Os rotulos ja colocados viajam junto para que o proximo possa
  // desviar deles em vez de imprimir por cima (ver `edgeLabel`).
  const rotulosPostos: Retangulo[] = [];
  for (const flow of spec.flows) {
    const s = placed.get(flow.source);
    const t = placed.get(flow.target);
    if (!s || !t) continue;
    const waypoints = routeEdge(moddle, s, t);
    planeElements.push(
      moddle.create('bpmndi:BPMNEdge', {
        id: `${flow.id}_di`,
        bpmnElement: flowById.get(flow.id),
        waypoint: waypoints,
        // Sem BPMNLabel explicito o bpmn-js centraliza o texto NO MEIO DA SETA,
        // por cima da linha. Com bounds proprios ele fica ao lado dela.
        ...(flow.name ? { label: edgeLabel(moddle, flow.name, waypoints, rotulosPostos) } : {}),
      }),
    );
  }

  // Pools externos, empilhados abaixo do pool interno.
  let extY = POOL_Y + poolHeight + EXTERNAL_POOL_GAP;
  for (const ep of externalParts) {
    planeElements.push(
      moddle.create('bpmndi:BPMNShape', {
        id: `${ep.id}_di`,
        bpmnElement: ep,
        isHorizontal: true,
        bounds: moddle.create('dc:Bounds', { x: POOL_X, y: extY, width: poolWidth, height: EXTERNAL_POOL_H }),
      }),
    );
    extY += EXTERNAL_POOL_H + EXTERNAL_POOL_GAP;
  }

  const plane: ModdleElement = moddle.create('bpmndi:BPMNPlane', {
    id: `BPMNPlane_${spec.process.id}`,
    bpmnElement: collaboration,
    planeElement: planeElements,
  });
  const diagram: ModdleElement = moddle.create('bpmndi:BPMNDiagram', {
    id: `BPMNDiagram_${spec.process.id}`,
    plane,
  });
  definitions.get('diagrams').push(diagram);

  const { xml } = await moddle.toXML(definitions, { format: true });
  return xml;
}

function internalPoolName(spec: ProcessSpec): string {
  const internal = (spec.participants ?? []).find((p) => p.type === 'internal');
  return internal?.name ?? spec.process.name;
}

/** Caixa em coordenadas de diagrama, para testar sobreposicao de rotulos. */
interface Retangulo {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Sobreposicao estrita: encostar nao conta. */
function sobrepoe(a: Retangulo, b: Retangulo): boolean {
  return (
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
  );
}

/**
 * Rotulo de uma aresta, posicionado no PRIMEIRO trecho depois da origem — que e
 * onde o "Sim"/"Nao" de um gateway precisa ser lido, junto da decisao e nao no
 * meio do caminho ate o destino.
 *
 * Trecho horizontal: o rotulo vai ACIMA da linha. Trecho vertical: vai ao LADO
 * (direita). Nos dois casos afastado de EDGE_LABEL_GAP, porque o problema
 * original era exatamente o texto impresso em cima da seta.
 *
 * `postos` sao os rotulos ja colocados, e existem porque a posicao acima nao
 * basta sozinha: `routeEdge` faz TODA saida partir da direita da origem, na
 * altura do centro, entao o primeiro trecho de todas as saidas de um mesmo
 * gateway e identico. Com dois ramos ainda dava certo; com tres, os rotulos
 * caem exatamente uns sobre os outros — num diagrama sem defeito nenhum eram
 * 16 rotulos e 14 pares sobrepostos, com "$5,000.01-$50,000" impresso por cima
 * de "Above $50,000". Quem colide sobe um degrau ate achar espaco.
 */
function edgeLabel(
  moddle: BpmnModdle,
  name: string,
  waypoints: ModdleElement[],
  postos: Retangulo[],
): ModdleElement {
  const width = Math.max(EDGE_LABEL_MIN_W, Math.round(name.length * EDGE_LABEL_CHAR_W));
  const [p0, p1] = waypoints;
  const x0 = p0?.get('x') as number;
  const y0 = p0?.get('y') as number;
  const x1 = (p1?.get('x') as number) ?? x0;
  const y1 = (p1?.get('y') as number) ?? y0;

  // Vertical quando o X nao muda; nesse caso o texto cabe melhor ao lado.
  const vertical = Math.abs(x1 - x0) < Math.abs(y1 - y0);
  const caixa: Retangulo = vertical
    ? {
        x: Math.round(x0 + EDGE_LABEL_GAP),
        y: Math.round((y0 + y1) / 2 - EDGE_LABEL_H / 2),
        width,
        height: EDGE_LABEL_H,
      }
    : {
        x: Math.round((x0 + x1) / 2 - width / 2),
        y: Math.round(y0 - EDGE_LABEL_GAP - EDGE_LABEL_H),
        width,
        height: EDGE_LABEL_H,
      };

  // Empilha para CIMA: logo abaixo esta a propria linha da seta, e tirar o
  // rotulo de cima dela foi o motivo de existir esta funcao. Cada passo pula
  // acima do mais alto dos rotulos que ele encosta — assim os ja resolvidos nao
  // voltam a colidir, e o laco termina em no maximo um passo por rotulo posto.
  // So quando a pilha chega ao topo do pool a direcao inverte, para nada sair
  // do desenho.
  const teto = POOL_Y + EDGE_LABEL_GAP;
  const yBase = caixa.y;
  let paraBaixo = false;
  for (let tentativas = 0; tentativas <= 2 * postos.length + 1; tentativas++) {
    const colidem = postos.filter((p) => sobrepoe(p, caixa));
    if (!colidem.length) break;
    if (!paraBaixo) {
      const acima = Math.min(...colidem.map((p) => p.y)) - EDGE_LABEL_STACK_GAP - caixa.height;
      if (acima >= teto) {
        caixa.y = acima;
        continue;
      }
      paraBaixo = true;
      caixa.y = yBase;
      continue;
    }
    caixa.y = Math.max(...colidem.map((p) => p.y + p.height)) + EDGE_LABEL_STACK_GAP;
  }
  postos.push(caixa);

  return moddle.create('bpmndi:BPMNLabel', {
    bounds: moddle.create('dc:Bounds', { ...caixa }),
  });
}

/**
 * Roteia uma aresta ortogonalmente: sai pela direita da origem, entra pela
 * esquerda do destino, com uma dobra no X medio quando ha desnivel vertical.
 * Para arestas que voltam (destino a esquerda), roteia por baixo.
 */
function routeEdge(moddle: BpmnModdle, s: Placed, t: Placed): ModdleElement[] {
  const wp = (x: number, y: number): ModdleElement =>
    moddle.create('dc:Point', { x: Math.round(x), y: Math.round(y) });

  const forward = t.x > s.x + s.w;
  if (forward) {
    const sx = s.x + s.w;
    const tx = t.x;
    if (Math.abs(s.cy - t.cy) < 1) return [wp(sx, s.cy), wp(tx, t.cy)];
    const midX = (sx + tx) / 2;
    return [wp(sx, s.cy), wp(midX, s.cy), wp(midX, t.cy), wp(tx, t.cy)];
  }
  // Aresta de retorno (loop): desce da origem, volta por baixo, sobe ao destino.
  const sy = s.y + s.h;
  const ty = t.y + t.h;
  const belowY = Math.max(sy, ty) + 30;
  return [
    wp(s.cx, sy),
    wp(s.cx, belowY),
    wp(t.cx, belowY),
    wp(t.cx, ty),
  ];
}
