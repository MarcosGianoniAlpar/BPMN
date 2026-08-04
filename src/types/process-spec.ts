/* GERADO por 'npm run gen:types' a partir de schemas/process-spec.schema.json. Nao editar a mao. */

/**
 * Identificador estavel, seguro para virar ID BPMN.
 */
export type Id = string;
/**
 * Gateways: exclusive = caminhos alternativos (so UM segue); parallel = caminhos simultaneos (TODOS seguem, saidas sem condicao); inclusive = cada saida tem sua condicao e seguem TODAS as que forem verdadeiras (uma, varias ou todas) — use quando o numero de ramos ativos varia por caso; event_based = a decisao nao e do processo, e de quem responder PRIMEIRO (corrida entre esperas; os ramos perdedores sao cancelados). Eventos intermediarios: timer_event = espera por tempo; message_event = espera por mensagem/resposta externa.
 */
export type NodeType =
  | "start_event"
  | "end_event"
  | "user_task"
  | "service_task"
  | "exclusive_gateway"
  | "parallel_gateway"
  | "inclusive_gateway"
  | "event_based_gateway"
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
  /**
   * Rotulo curto que aparece DENTRO da caixa no diagrama, escrito no idioma do documento. Comece SEMPRE com o verbo na forma de dicionario, sem sujeito e sem tempo conjugado (PT 'Confirmar', EN 'Confirm'), e mantenha ate ~30 caracteres: verbo + objeto, sem artigos, subordinadas ou nomes de pessoas. Ex.: 'Confirmar template do clone', nao 'Confirmar com Henrique se o clone seguiu o template solicitado'. Excecoes: start_event/end_event usam substantivo (descrevem um estado) e gateways de decisao usam pergunta curta terminada em '?'. O contexto completo vai em `detail`, nao aqui.
   */
  name: string;
  /**
   * A frase completa do que acontece nesta etapa: quem executa, sobre o que, com quais condicoes e ressalvas. Uma a duas frases. E o que o especialista le no painel ao clicar na caixa, entao aqui NAO se economiza palavra — todo o contexto que nao coube em `name` vem para ca.
   */
  detail?: string;
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
   * Condicao textual. Obrigatoria em saidas de exclusive_gateway e de inclusive_gateway (nos dois o caminho depende de uma condicao). NAO use em saidas de parallel_gateway nem de event_based_gateway: no paralelo tudo segue junto, e no event_based quem decide e o evento que ocorrer primeiro.
   */
  condition?: string;
}
export interface UnresolvedQuestion {
  id: Id;
  question: string;
  reason?: string;
  affected_nodes?: Id[];
}
