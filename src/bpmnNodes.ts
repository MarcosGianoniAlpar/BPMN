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

  const definition = EVENT_DEFINITION[node.type];
  if (definition) {
    const defs: ModdleElement[] = el.get('eventDefinitions');
    defs.push(moddle.create(definition, { id: `${node.id}_def` }));
  }
  return el;
}
