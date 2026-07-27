/* GERADO por 'npm run gen:types' a partir de schemas/process-spec.schema.json. Nao editar a mao. */

export type Id = string;
export type Confidence = 'low' | 'medium' | 'high';

export interface Evidence {
  quote: string;
  document_id?: string;
  page?: number;
  chunk_id?: string;
}

export type NodeType =
  | 'start_event'
  | 'end_event'
  | 'user_task'
  | 'service_task'
  | 'exclusive_gateway';

export interface ProcessNode {
  id: Id;
  type: NodeType;
  name: string;
  lane_id?: Id;
  evidence?: Evidence[];
  confidence?: Confidence;
}

export interface Flow {
  id: Id;
  source: Id;
  target: Id;
  name?: string;
  condition?: string;
}

export interface Participant {
  id: Id;
  name: string;
  type: 'internal' | 'external';
}

export interface Lane {
  id: Id;
  name: string;
  participant_id?: Id;
}

export interface UnresolvedQuestion {
  id: Id;
  question: string;
  reason?: string;
  affected_nodes?: Id[];
}

export interface ProcessSpec {
  process: {
    id: Id;
    name: string;
    description?: string;
  };
  participants?: Participant[];
  lanes?: Lane[];
  nodes: ProcessNode[];
  flows: Flow[];
  unresolved_questions?: UnresolvedQuestion[];
}
