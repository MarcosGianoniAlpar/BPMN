import BpmnModdle, { type ModdleElement } from 'bpmn-moddle';

/**
 * Colorizacao do BPMN com a paleta da Alpar, aplicada na DI (geometria) por um
 * passo unico pos-layout. Vantagens de colorir na DI (e nao via CSS no front):
 * a cor persiste no `.bpmn`/SVG exportado e vale para os DOIS caminhos de
 * geracao (com raias via laneLayout e sem raias via bpmn-auto-layout).
 *
 * Usa o namespace padrao "BPMN in Color" (OMG), que o bpmn-js le nativamente:
 * atributos `color:background-color` e `color:border-color` na BPMNShape/BPMNEdge.
 * Como usamos o bpmn-moddle "cru", registramos a extensao do namespace abaixo.
 */

const COLOR_NS = 'http://www.omg.org/spec/BPMN/non-normative/color/1.0';

// Extensao moddle minima para o namespace de cor (senao os atributos nao
// serializam). Espelha o que o bpmn-js usa internamente.
const colorModdle = {
  name: 'BpmnInColor',
  prefix: 'color',
  uri: COLOR_NS,
  types: [
    {
      name: 'ColoredShape',
      isAbstract: true,
      extends: ['bpmndi:BPMNShape'],
      properties: [
        { name: 'background-color', isAttr: true, type: 'String' },
        { name: 'border-color', isAttr: true, type: 'String' },
      ],
    },
    {
      name: 'ColoredEdge',
      isAbstract: true,
      extends: ['bpmndi:BPMNEdge'],
      properties: [{ name: 'border-color', isAttr: true, type: 'String' }],
    },
  ],
};

interface Fill {
  fill: string;
  stroke: string;
}

// Paleta alinhada ao CSS do app: azul #124e80, teal #17a99b, amber #b7791f.
// `fill` e um tom claro do `stroke` para o preenchimento das formas.
// Exportado para o teste: todo elemento produzido por NODE_TYPE_TO_BPMN precisa
// ter cor aqui. Sem isso, um tipo novo sai preto-e-branco no meio de um diagrama
// colorido — nada quebra, so fica feio, e ninguem percebe ate o chefe ver.
export const SHAPE_COLORS: Record<string, Fill> = {
  'bpmn:StartEvent': { fill: '#e6f6f4', stroke: '#17a99b' }, // teal — inicio
  'bpmn:EndEvent': { fill: '#e2e9f2', stroke: '#124e80' }, // azul — fim
  'bpmn:UserTask': { fill: '#eaf1f8', stroke: '#124e80' }, // azul — tarefa humana
  'bpmn:ServiceTask': { fill: '#e6f6f4', stroke: '#17a99b' }, // teal — automatico
  'bpmn:Task': { fill: '#eaf1f8', stroke: '#124e80' }, // azul — tarefa generica
  // Gateways: todos amber, porque todos sao pontos de desvio. O que os separa e
  // o simbolo dentro do losango (X, +, O, pentagono) — dar cor diferente a cada
  // um faria o leitor procurar significado onde nao ha.
  'bpmn:ExclusiveGateway': { fill: '#fdf3e3', stroke: '#b7791f' }, // amber — decisao
  'bpmn:ParallelGateway': { fill: '#fdf3e3', stroke: '#b7791f' }, // amber — desvio de fluxo
  'bpmn:InclusiveGateway': { fill: '#fdf3e3', stroke: '#b7791f' }, // amber — ramos condicionais
  'bpmn:EventBasedGateway': { fill: '#fdf3e3', stroke: '#b7791f' }, // amber — corrida
  // Espera (timer/mensagem): mesma familia dos demais eventos; o que muda e o
  // simbolo dentro do circulo, nao a cor.
  'bpmn:IntermediateCatchEvent': { fill: '#e6f6f4', stroke: '#17a99b' },
};

// Arestas (fluxos): um cinza-azulado discreto, mais suave que o preto padrao.
const EDGE_STROKE = '#5b6b7a';

/** Aplica cor a um elemento de DI conforme o tipo do elemento BPMN que ele desenha. */
function applyColor(di: ModdleElement): void {
  const type = (di.get('bpmnElement') as ModdleElement | undefined)?.$type;

  if (di.$type === 'bpmndi:BPMNShape' && type) {
    const c = SHAPE_COLORS[type];
    if (c) {
      di.set('color:background-color', c.fill);
      di.set('color:border-color', c.stroke);
    }
  } else if (di.$type === 'bpmndi:BPMNEdge') {
    di.set('color:border-color', EDGE_STROKE);
  }
}

/**
 * Recebe o BPMN final (ja com DI) e devolve o mesmo XML com as cores da paleta
 * aplicadas por tipo de elemento. Best-effort: se o parse/serializacao falhar,
 * devolve o XML original (a cor e cosmetica, nao vale derrubar a geracao).
 */
export async function colorizeBpmn(xml: string): Promise<string> {
  const moddle = new BpmnModdle({ color: colorModdle });
  try {
    const { rootElement: definitions } = await moddle.fromXML(xml);
    const diagrams: ModdleElement[] = definitions.get('diagrams') ?? [];
    for (const diagram of diagrams) {
      const plane = diagram.get('plane') as ModdleElement | undefined;
      if (!plane) continue;
      const planeElements: ModdleElement[] = plane.get('planeElement') ?? [];
      for (const di of planeElements) applyColor(di);
    }
    const { xml: out } = await moddle.toXML(definitions, { format: true });
    return out;
  } catch {
    return xml;
  }
}
