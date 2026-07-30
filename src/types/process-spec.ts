/* GERADO por 'npm run gen:types' a partir de schemas/process-spec.schema.json. Nao editar a mao. */

/**
 * Identificador estavel, seguro para virar ID BPMN.
 */
export type Id = string;
/**
 * Gateways: exclusive = caminhos alternativos (so um segue); parallel = caminhos simultaneos (todos seguem, saidas sem condicao). Eventos intermediarios: timer_event = espera por tempo; message_event = espera por mensagem/resposta externa.
 */
export type NodeType =
  | "start_event"
  | "end_event"
  | "user_task"
  | "service_task"
  | "exclusive_gateway"
  | "parallel_gateway"
  | "timer_event"
  | "message_event";
export type Confidence = "low" | "medium" | "high";

/**
 * Modelo intermediario entre a LLM e a geracao de BPMN. A LLM produz este objeto; o compilador deterministico o transforma em BPMN 2.0.
 */
export interface ProcessSpec {
  process: {
    id: Id;
    name: string;
    description?: string;
  };
  /**
   * Organizacoes envolvidas. Organizacoes externas viram pool caixa-preta.
   */
  participants?: Participant[];
  /**
   * Raias (departamentos/papeis) dentro de um participante.
   */
  lanes?: Lane[];
  /**
   * @minItems 1
   */
  nodes: [ProcessNode, ...ProcessNode[]];
  flows: Flow[];
  /**
   * Ambiguidades que o documento nao resolveu. A IA nunca deve inventar o fluxo; deve perguntar.
   */
  unresolved_questions?: UnresolvedQuestion[];
}
export interface Participant {
  id: Id;
  name: string;
  type: "internal" | "external";
}
export interface Lane {
  id: Id;
  name: string;
  participant_id?: Id;
}
export interface ProcessNode {
  id: Id;
  type: NodeType;
  name: string;
  lane_id?: Id;
  /**
   * De onde no documento este no foi extraido. Obrigatorio para nos gerados pela IA.
   */
  evidence?: Evidence[];
  confidence?: Confidence;
}
export interface Evidence {
  /**
   * Trecho literal do documento que sustenta o elemento.
   */
  quote: string;
  document_id?: string;
  page?: number;
  /**
   * Reservado para a Fase 2 (chunking). Na Fase 1 pode ficar ausente.
   */
  chunk_id?: string;
}
export interface Flow {
  id: Id;
  source: Id;
  target: Id;
  /**
   * Rotulo do fluxo, ex.: 'Sim' / 'Nao' na saida de um gateway.
   */
  name?: string;
  /**
   * Condicao textual. Obrigatoria em saidas de exclusive_gateway.
   */
  condition?: string;
}
export interface UnresolvedQuestion {
  id: Id;
  question: string;
  reason?: string;
  affected_nodes?: Id[];
}
