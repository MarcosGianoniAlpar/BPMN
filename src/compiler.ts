import BpmnModdle, { type ModdleElement } from 'bpmn-moddle';
import type { NodeType, ProcessSpec } from './types/process-spec.js';

/** Mapeamento deterministico ProcessSpec.type -> tipo BPMN. */
const NODE_TYPE_TO_BPMN: Record<NodeType, string> = {
  start_event: 'bpmn:StartEvent',
  end_event: 'bpmn:EndEvent',
  user_task: 'bpmn:UserTask',
  service_task: 'bpmn:ServiceTask',
  exclusive_gateway: 'bpmn:ExclusiveGateway',
};

const TARGET_NAMESPACE = 'https://alpar.local/bpmn';

/**
 * Este compilador cuida do caminho SEM raias (processo plano), cujo layout fica
 * a cargo do bpmn-auto-layout. Quando o ProcessSpec tem `lanes`, o orquestrador
 * usa src/laneLayout.ts, que emite laneSet + collaboration + DI proprio. Por
 * isso aqui nao emitimos laneSet: um laneSet sem DI quebraria o bpmn-auto-layout
 * e a regra `no-bpmndi` do bpmnlint. A info de lane segue preservada no
 * ProcessSpec.
 */
const EMIT_LANE_SET = false;

/**
 * Compila um ProcessSpec (ja validado) em BPMN 2.0 XML *sem* DI (diagram
 * interchange). As posicoes ficam por conta do bpmn-auto-layout, executado
 * depois. Ver src/layout.ts.
 */
export async function compileToBpmn(spec: ProcessSpec): Promise<string> {
  const moddle = new BpmnModdle();

  const processId = `Process_${spec.process.id}`;
  const process: ModdleElement = moddle.create('bpmn:Process', {
    id: processId,
    name: spec.process.name,
    isExecutable: false,
  });

  const flowElements: ModdleElement[] = process.get('flowElements');

  // 1. Nos
  const nodeById = new Map<string, ModdleElement>();
  for (const node of spec.nodes) {
    const el = moddle.create(NODE_TYPE_TO_BPMN[node.type], {
      id: node.id,
      ...(node.name ? { name: node.name } : {}),
    });
    nodeById.set(node.id, el);
    flowElements.push(el);
  }

  // 2. Sequence flows (com referencias de objeto e incoming/outgoing)
  for (const flow of spec.flows) {
    const source = nodeById.get(flow.source);
    const target = nodeById.get(flow.target);
    if (!source || !target) {
      // A validacao (nivel 1) ja teria barrado; guarda defensiva.
      throw new Error(
        `Flow ${flow.id} referencia no inexistente (${flow.source} -> ${flow.target}).`,
      );
    }

    const seqFlow: ModdleElement = moddle.create('bpmn:SequenceFlow', {
      id: flow.id,
      sourceRef: source,
      targetRef: target,
      ...(flow.name ? { name: flow.name } : {}),
    });

    if (flow.condition) {
      seqFlow.set(
        'conditionExpression',
        moddle.create('bpmn:FormalExpression', { body: flow.condition }),
      );
    }

    source.get('outgoing').push(seqFlow);
    target.get('incoming').push(seqFlow);
    flowElements.push(seqFlow);
  }

  // 3. Lanes (laneSet dentro do processo) — desligado na Fase 1 (ver EMIT_LANE_SET)
  if (EMIT_LANE_SET && spec.lanes && spec.lanes.length > 0) {
    const lanes = spec.lanes.map((lane) => {
      const laneEl: ModdleElement = moddle.create('bpmn:Lane', {
        id: lane.id,
        ...(lane.name ? { name: lane.name } : {}),
      });
      const refs: ModdleElement[] = laneEl.get('flowNodeRef');
      for (const node of spec.nodes) {
        if (node.lane_id === lane.id) {
          const el = nodeById.get(node.id);
          if (el) refs.push(el);
        }
      }
      return laneEl;
    });

    const laneSet: ModdleElement = moddle.create('bpmn:LaneSet', {
      id: `LaneSet_${spec.process.id}`,
      lanes,
    });
    process.get('laneSets').push(laneSet);
  }

  // 4. Definitions + (opcional) Collaboration com pools
  const definitions: ModdleElement = moddle.create('bpmn:Definitions', {
    id: `Definitions_${spec.process.id}`,
    targetNamespace: TARGET_NAMESPACE,
  });

  const rootElements: ModdleElement[] = definitions.get('rootElements');
  rootElements.push(process);

  // NOTA (Fase 1): emitimos um unico Process. As lanes ficam no laneSet
  // (lane membership preservada e valida), mas o bpmn-auto-layout atual (1.x)
  // NAO desenha faixas de raia nem pools — ele so posiciona o fluxo do
  // processo. Pools/participants e faixas visuais de lane sao Fase 2 (exigem
  // DI de lane gerado a mao ou layout ciente de raias). Por isso NAO criamos
  // Collaboration/Participant aqui: um pool sem DI quebraria a renderizacao no
  // bpmn-js. Organizacoes externas continuam registradas no ProcessSpec.

  const { xml } = await moddle.toXML(definitions, { format: true });
  return xml;
}
