import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import AjvDefault from 'ajv';
import addFormatsDefault from 'ajv-formats';
import type { Options, ValidateFunction } from 'ajv';
import type { ProcessSpec } from './types/process-spec.js';

// ajv e ajv-formats sao CJS; sob NodeNext o interop de default nao expoe a
// classe/funcao real no nivel de tipo (embora funcione em runtime). Fixamos os
// tipos que realmente usamos.
const Ajv = AjvDefault as unknown as new (opts?: Options) => {
  compile: (schema: unknown) => ValidateFunction;
};
const addFormats = addFormatsDefault as unknown as (ajv: unknown) => void;

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(__dirname, '../schemas/process-spec.schema.json');
const minutesSchemaPath = resolve(__dirname, '../schemas/meeting-minutes.schema.json');

export interface ValidationIssue {
  code: string;
  message: string;
  path?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
}

let cachedValidator: ValidateFunction | undefined;

function getValidator(): ValidateFunction {
  if (cachedValidator) return cachedValidator;
  // removeAdditional: descarta campos fora do schema (ex.: a LLM as vezes
  // inventa uma propriedade num flow) em vez de falhar a validacao inteira.
  const ajv = new Ajv({ allErrors: true, strict: false, removeAdditional: true });
  addFormats(ajv);
  const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));
  cachedValidator = ajv.compile(schema);
  return cachedValidator;
}

let cachedMinutesValidator: ValidateFunction | undefined;

function getMinutesValidator(): ValidateFunction {
  if (cachedMinutesValidator) return cachedMinutesValidator;
  const ajv = new Ajv({ allErrors: true, strict: false, removeAdditional: true });
  addFormats(ajv);
  const schema = JSON.parse(readFileSync(minutesSchemaPath, 'utf-8'));
  cachedMinutesValidator = ajv.compile(schema);
  return cachedMinutesValidator;
}

/**
 * Valida a ata que veio da IA contra o schema.
 *
 * Existe porque a ata falhava em SILENCIO: se a IA devolvia um objeto com forma
 * diferente da esperada, nada quebrava — o renderizador simplesmente pulava as
 * secoes e o usuario recebia uma ata quase vazia, sem saber por que. Aqui o
 * problema vira erro explicito.
 */
export function validateMeetingMinutes(minutes: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];
  const validate = getMinutesValidator();

  if (!validate(minutes)) {
    for (const err of validate.errors ?? []) {
      errors.push({
        code: 'SCHEMA',
        message: `${err.instancePath || '/'} ${err.message ?? 'invalido'}`,
        path: err.instancePath,
      });
    }
    return { valid: false, errors };
  }

  // Guarda semantica: uma reuniao de verdade nao produz ata vazia. Se veio sem
  // topico E sem etapa de fluxo, a extracao falhou — melhor dizer isso do que
  // entregar um documento em branco como se fosse resultado.
  const m = minutes as {
    topics?: unknown[];
    process_flow?: { steps?: unknown[] };
    participants?: unknown[];
  };
  const topics = m.topics?.length ?? 0;
  const steps = m.process_flow?.steps?.length ?? 0;
  if (topics === 0 && steps === 0) {
    errors.push({
      code: 'ATA_VAZIA',
      message:
        'A IA devolveu uma ata sem nenhum tópico e sem nenhuma etapa de fluxo ' +
        `(${m.participants?.length ?? 0} participante(s)). A extração falhou.`,
    });
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Nivel 1 de validacao: schema JSON + regras semanticas do ProcessSpec.
 * Roda ANTES de qualquer compilacao para BPMN — e mais barato achar erro aqui.
 */
export function validateProcessSpec(spec: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];

  // As chaves ANTES de validar: o Ajv roda com `removeAdditional`, entao ele
  // APAGA do objeto o que nao esta no schema. Se a IA devolver o spec embrulhado
  // (ex.: { process_spec: {...} }), o que sobra e um objeto vazio e o erro vira
  // "faltam process, nodes e flows" — sem dizer que veio algo, so que nao veio o
  // esperado. Guardar as chaves aqui e a diferenca entre diagnosticar na hora e
  // pagar outra geracao para descobrir.
  const chavesRecebidas =
    spec && typeof spec === 'object' && !Array.isArray(spec) ? Object.keys(spec) : [];

  // 1. Schema JSON
  const validate = getValidator();
  if (!validate(spec)) {
    for (const err of validate.errors ?? []) {
      errors.push({
        code: 'SCHEMA',
        message: `${err.instancePath || '/'} ${err.message ?? 'invalido'}`,
        path: err.instancePath,
      });
    }
    errors.push({
      code: 'FORMA_RECEBIDA',
      message:
        `A IA devolveu um objeto com as chaves: ` +
        (chavesRecebidas.length ? chavesRecebidas.join(', ') : '(nenhuma)') +
        '. O esperado na raiz e: process, nodes, flows.',
    });
    // Se falhou no schema, os checks semanticos abaixo nao sao confiaveis.
    return { valid: false, errors };
  }

  const s = spec as ProcessSpec;

  // 2. Regras semanticas
  const nodeIds = new Set(s.nodes.map((n) => n.id));
  const seenIds = new Set<string>();

  for (const n of s.nodes) {
    if (seenIds.has(n.id)) {
      errors.push({ code: 'DUPLICATE_ID', message: `ID de no duplicado: ${n.id}` });
    }
    seenIds.add(n.id);
  }

  const laneIds = new Set((s.lanes ?? []).map((l) => l.id));
  const participantIds = new Set((s.participants ?? []).map((p) => p.id));

  // Flows apontam para nos existentes
  for (const f of s.flows) {
    if (!nodeIds.has(f.source)) {
      errors.push({
        code: 'FLOW_BAD_SOURCE',
        message: `Flow ${f.id} referencia source inexistente: ${f.source}`,
      });
    }
    if (!nodeIds.has(f.target)) {
      errors.push({
        code: 'FLOW_BAD_TARGET',
        message: `Flow ${f.id} referencia target inexistente: ${f.target}`,
      });
    }
  }

  // Lanes referenciadas pelos nos precisam existir
  for (const n of s.nodes) {
    if (n.lane_id && !laneIds.has(n.lane_id)) {
      errors.push({
        code: 'NODE_BAD_LANE',
        message: `No ${n.id} referencia lane inexistente: ${n.lane_id}`,
      });
    }
  }

  // Toda lane deve pertencer a um participant existente (quando ha participants)
  for (const l of s.lanes ?? []) {
    if (l.participant_id && !participantIds.has(l.participant_id)) {
      errors.push({
        code: 'LANE_BAD_PARTICIPANT',
        message: `Lane ${l.id} referencia participant inexistente: ${l.participant_id}`,
      });
    }
  }

  // Deve haver exatamente um... pelo menos um start event
  const starts = s.nodes.filter((n) => n.type === 'start_event');
  if (starts.length === 0) {
    errors.push({ code: 'NO_START', message: 'Processo sem start event.' });
  }
  const ends = s.nodes.filter((n) => n.type === 'end_event');
  if (ends.length === 0) {
    errors.push({ code: 'NO_END', message: 'Processo sem end event.' });
  }

  // Conectividade: todo no (exceto start) deve ter entrada; todo no (exceto end) deve ter saida
  const hasIncoming = new Set(s.flows.map((f) => f.target));
  const hasOutgoing = new Set(s.flows.map((f) => f.source));
  for (const n of s.nodes) {
    if (n.type !== 'start_event' && !hasIncoming.has(n.id)) {
      errors.push({
        code: 'NODE_DISCONNECTED',
        message: `No ${n.id} nao tem fluxo de entrada.`,
      });
    }
    if (n.type !== 'end_event' && !hasOutgoing.has(n.id)) {
      errors.push({
        code: 'NODE_DISCONNECTED',
        message: `No ${n.id} nao tem fluxo de saida.`,
      });
    }
  }

  // Saidas de exclusive_gateway com mais de um caminho precisam de condicao.
  //
  // Vale SO para o exclusivo, de proposito: no parallel_gateway os caminhos
  // acontecem todos juntos e nao ha o que condicionar — exigir condicao la
  // estaria errado. A regra inversa (saida de parallel_gateway NAO deve ter
  // condicao) fica no prompt e nao aqui porque um erro de validacao aborta o
  // pipeline inteiro, jogando fora uma chamada de IA ja paga; uma condicao
  // sobrando vira um rotulo a mais no desenho, que o especialista corrige no
  // loop de revisao.
  for (const n of s.nodes) {
    if (n.type !== 'exclusive_gateway') continue;
    const out = s.flows.filter((f) => f.source === n.id);
    if (out.length > 1) {
      for (const f of out) {
        if (!f.condition && !f.name) {
          errors.push({
            code: 'EXCLUSIVE_FLOW_WITHOUT_CONDITION',
            message: `Saida ${f.id} do gateway ${n.id} sem condicao/rotulo.`,
          });
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
