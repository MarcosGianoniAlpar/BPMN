import type BpmnModdle from 'bpmn-moddle';
import type { ModdleElement } from 'bpmn-moddle';
import type { NodeType, ProcessNode } from './types/process-spec.js';

/**
 * Traducao ProcessSpec.type -> BPMN, em UM lugar so.
 *
 * Antes este mapa existia duplicado em `compiler.ts` (caminho sem raias) e em
 * `laneLayout.ts` (caminho com raias). Sao os dois compiladores do projeto, e um
 * tipo novo adicionado em apenas um deles renderizaria diferente conforme o
 * documento tivesse raias ou nao — falha silenciosa e chata de achar.
 */
export const NODE_TYPE_TO_BPMN: Record<NodeType, string> = {
  start_event: 'bpmn:StartEvent',
  end_event: 'bpmn:EndEvent',
  user_task: 'bpmn:UserTask',
  service_task: 'bpmn:ServiceTask',
  exclusive_gateway: 'bpmn:ExclusiveGateway',
  parallel_gateway: 'bpmn:ParallelGateway',
  // O inclusivo existe por causa do JOIN: ele espera so os ramos que de fato
  // foram ativados. Modelar um "numero variavel de ramos" como parallel produz
  // um diagrama que parece certo e TRAVA na juncao, esperando um ramo que nunca
  // rodou — e o bpmnlint nao pega isso.
  inclusive_gateway: 'bpmn:InclusiveGateway',
  // Corrida entre esperas ("quem responder primeiro"): o proprio gateway cancela
  // os ramos perdedores. Como exclusive_gateway isso viraria uma decisao do
  // processo — que nao tem como saber quem respondeu antes.
  event_based_gateway: 'bpmn:EventBasedGateway',
  // Os dois viram o MESMO elemento BPMN; o que os distingue e o
  // eventDefinition abaixo (o relogio ou o envelope desenhado dentro).
  timer_event: 'bpmn:IntermediateCatchEvent',
  message_event: 'bpmn:IntermediateCatchEvent',
};

/**
 * Filho obrigatorio dos eventos intermediarios. Sem ele o bpmn-js desenha um
 * circulo vazio — um evento que nao diz o que esta esperando.
 */
const EVENT_DEFINITION: Partial<Record<NodeType, string>> = {
  timer_event: 'bpmn:TimerEventDefinition',
  message_event: 'bpmn:MessageEventDefinition',
};

/** Cria o elemento BPMN de um no do ProcessSpec, com o eventDefinition se houver. */
export function createFlowNode(moddle: BpmnModdle, node: ProcessNode): ModdleElement {
  const el: ModdleElement = moddle.create(NODE_TYPE_TO_BPMN[node.type], {
    id: node.id,
    ...(node.name ? { name: node.name } : {}),
  });

  // O `name` e so o rotulo curto da caixa. O texto por extenso vai para
  // `bpmn:Documentation` — que e onde o padrao manda, e por isso sobrevive ao
  // "Congelar versao" (snapshot .bpmn) e viaja para qualquer ferramenta BPMN.
  if (node.detail) {
    const docs: ModdleElement[] = el.get('documentation');
    docs.push(moddle.create('bpmn:Documentation', { text: node.detail }));
  }

  const definition = EVENT_DEFINITION[node.type];
  if (definition) {
    const defs: ModdleElement[] = el.get('eventDefinitions');
    defs.push(moddle.create(definition, { id: `${node.id}_def` }));
  }
  return el;
}
