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
  /** Fatais: sem conserto possivel, o pipeline para. */
  errors: ValidationIssue[];
  /**
   * Defeitos que NAO impedem o desenho — consertados ou tolerados. O diagrama
   * sai, com ressalva visivel.
   *
   * Existe por causa da economia deste passo: a extracao e paga e NAO e
   * deterministica. Rodando o mesmo documento duas vezes, uma saiu perfeita e a
   * outra veio com 8 fluxos apontando para 2 gateways que o modelo esqueceu de
   * declarar — 33 nos bons, e a geracao inteira ia para o lixo por causa de 2
   * nos faltando. Tratar defeito reparavel como fatal custa dinheiro de verdade.
   *
   * Isso fica mais grave, nao menos, quando o chunking chegar: com 6 chamadas em
   * vez de 1, a chance de TODAS passarem despenca se qualquer escorregao zerar
   * tudo.
   */
  warnings: ValidationIssue[];
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
  // A ata nao tem defeito reparavel: ou a forma esta certa, ou o renderizador
  // pula secoes em silencio (foi o bug que originou esta funcao). `warnings`
  // sai sempre vazio aqui, e existe so para os dois validadores terem a mesma
  // forma de retorno.
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const validate = getMinutesValidator();

  if (!validate(minutes)) {
    for (const err of validate.errors ?? []) {
      errors.push({
        code: 'SCHEMA',
        message: `${err.instancePath || '/'} ${err.message ?? 'invalido'}`,
        path: err.instancePath,
      });
    }
    return { valid: false, errors, warnings };
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

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Descreve o TIPO de cada chave da raiz, nao so o nome.
 *
 * Existe porque saber que veio "nodes" nao ajuda quando o erro e
 * "/nodes must be array": a pergunta que importa e *o que* nodes era. Ja custou
 * uma geracao paga sem resposta — o log dizia que a chave estava la, e o
 * problema era o valor.
 */
function descreverForma(spec: unknown): string {
  const obj = spec as Record<string, unknown>;
  return Object.entries(obj)
    .map(([chave, valor]) => `${chave}: ${descreverValor(valor)}`)
    .join(', ');
}

function descreverValor(valor: unknown): string {
  if (valor === null) return 'null';
  if (Array.isArray(valor)) return `array[${valor.length}]`;
  if (typeof valor === 'object') return `objeto{${Object.keys(valor).length} chave(s)}`;
  if (typeof valor === 'string') {
    // Uma string onde se esperava array costuma ser JSON serializado por engano.
    const inicio = valor.trimStart()[0];
    const pista = inicio === '[' || inicio === '{' ? ', parece JSON em string' : '';
    return `string(${valor.length} chars${pista})`;
  }
  return typeof valor;
}

/**
 * Lista de ids legivel: mostra os primeiros e conta o resto.
 *
 * Existe porque o aviso tem de caber numa linha. Um caso real despejou 56
 * mensagens de "no X sem fluxo" — a informacao util (quantos, e alguns exemplos
 * para procurar no painel) cabe em uma.
 */
function resumirIds(ids: string[], limite = 5): string {
  if (ids.length <= limite) return ids.join(', ');
  return `${ids.slice(0, limite).join(', ')} e mais ${ids.length - limite}`;
}

/**
 * Nivel 1 de validacao: schema JSON + regras semanticas do ProcessSpec.
 * Roda ANTES de qualquer compilacao para BPMN — e mais barato achar erro aqui.
 *
 * Devolve DUAS listas: `errors` (fatais) e `warnings` (defeitos reparaveis, ja
 * consertados no spec). Ver o comentario de `ValidationResult` para o porque —
 * em resumo: este passo e pago e nao e deterministico, entao abortar por
 * defeito consertavel joga dinheiro fora.
 *
 * ATENCAO: esta funcao MUTA `spec.flows`, descartando os fluxos que apontam
 * para nos inexistentes. E o mesmo padrao do `removeAdditional` do Ajv logo
 * acima, e e o que permite ao compilador seguir sem explodir.
 */
export function validateProcessSpec(spec: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  // As chaves ANTES de validar: o Ajv roda com `removeAdditional`, entao ele
  // APAGA do objeto o que nao esta no schema. Se a IA devolver o spec embrulhado
  // (ex.: { process_spec: {...} }), o que sobra e um objeto vazio e o erro vira
  // "faltam process, nodes e flows" — sem dizer que veio algo, so que nao veio o
  // esperado. Guardar as chaves aqui e a diferenca entre diagnosticar na hora e
  // pagar outra geracao para descobrir.
  // A forma tem de ser descrita AQUI, antes de `validate()`: o `removeAdditional`
  // apaga as chaves desconhecidas do objeto, e descrever depois mostraria um
  // objeto ja esvaziado. (Coberto por teste de regressao.)
  const ehObjeto = Boolean(spec) && typeof spec === 'object' && !Array.isArray(spec);
  const chavesRecebidas = ehObjeto ? Object.keys(spec as object) : [];
  const formaRecebida = ehObjeto ? descreverForma(spec) : '';

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
        `A IA devolveu um objeto com: ` +
        (chavesRecebidas.length ? formaRecebida : '(nenhuma chave)') +
        '. O esperado na raiz e: process (objeto), nodes (array), flows (array).',
    });
    // Se falhou no schema, os checks semanticos abaixo nao sao confiaveis.
    return { valid: false, errors, warnings };
  }

  const s = spec as ProcessSpec;

  // 2. Regras semanticas
  const nodeIds = new Set(s.nodes.map((n) => n.id));
  const seenIds = new Set<string>();

  // FATAL: dois nos com o mesmo id produzem XML invalido — as referencias de
  // fluxo passam a apontar para dois elementos e nao ha conserto sem escolher
  // um deles, o que seria inventar.
  for (const n of s.nodes) {
    if (seenIds.has(n.id)) {
      errors.push({ code: 'DUPLICATE_ID', message: `ID de no duplicado: ${n.id}` });
    }
    seenIds.add(n.id);
  }

  const laneIds = new Set((s.lanes ?? []).map((l) => l.id));
  const participantIds = new Set((s.participants ?? []).map((p) => p.id));

  // REPARAVEL: fluxo apontando para no que nao existe.
  //
  // O conserto e DESCARTAR o fluxo, e nao inventar o no que falta. Um fluxo
  // solto nao e desenhavel de jeito nenhum — `compiler.ts` explode nele de
  // proposito — entao descartar nao perde desenho, perde uma seta que nunca
  // existiu. Caso real (2026-08-04): 8 fluxos apontando para 2 gateways que o
  // modelo esqueceu de declarar. Antes disto, os outros ~32 fluxos e 33 nos
  // iam junto para o lixo.
  const flowsValidos = s.flows.filter((f) => {
    const semOrigem = !nodeIds.has(f.source);
    const semDestino = !nodeIds.has(f.target);
    if (!semOrigem && !semDestino) return true;
    warnings.push({
      code: 'FLOW_DESCARTADO',
      message:
        `Flow ${f.id} descartado: aponta para no inexistente ` +
        `(${semOrigem ? `source ${f.source}` : ''}${semOrigem && semDestino ? ' e ' : ''}` +
        `${semDestino ? `target ${f.target}` : ''}). A IA referenciou um no que ` +
        'nao declarou; confira este trecho do diagrama.',
    });
    return false;
  });
  if (flowsValidos.length !== s.flows.length) s.flows = flowsValidos;

  // REPARAVEL: `laneOf()` em laneLayout.ts ja joga o no na faixa "Sem raia"
  // quando a lane nao existe. O desenho sai; so a raia fica errada.
  for (const n of s.nodes) {
    if (n.lane_id && !laneIds.has(n.lane_id)) {
      warnings.push({
        code: 'NODE_BAD_LANE',
        message: `No ${n.id} referencia lane inexistente (${n.lane_id}); vai para "Sem raia".`,
      });
    }
  }

  // REPARAVEL: puramente cosmetico — o pool desenha do mesmo jeito.
  for (const l of s.lanes ?? []) {
    if (l.participant_id && !participantIds.has(l.participant_id)) {
      warnings.push({
        code: 'LANE_BAD_PARTICIPANT',
        message: `Lane ${l.id} referencia participant inexistente: ${l.participant_id}`,
      });
    }
  }

  // REPARAVEL: sem start event o layout de raias semeia pelo primeiro no e
  // desenha assim mesmo; o bpmnlint ja acusa depois, com destaque proprio.
  const starts = s.nodes.filter((n) => n.type === 'start_event');
  if (starts.length === 0) {
    warnings.push({ code: 'NO_START', message: 'Processo sem start event.' });
  }
  const ends = s.nodes.filter((n) => n.type === 'end_event');
  if (ends.length === 0) {
    warnings.push({ code: 'NO_END', message: 'Processo sem end event.' });
  }

  // Conectividade: todo no (exceto start) deve ter entrada; todo no (exceto end) deve ter saida
  const hasIncoming = new Set(s.flows.map((f) => f.target));
  const hasOutgoing = new Set(s.flows.map((f) => f.source));
  // REPARAVEL: um no solto DESENHA — fica uma caixa sem seta, que o
  // especialista ve e liga no painel. Antes isto abortava o pipeline, e como
  // cada fluxo descartado acima desconecta dois nos, um punhado de referencias
  // quebradas virava dezenas de linhas de erro escondendo a causa real.
  //
  // Resumido de proposito: com `flows` vindo vazio da IA, TODOS os nos ficam
  // soltos, e 56 linhas dizendo a mesma coisa enterram o unico fato que
  // importa — que nao veio fluxo nenhum.
  const soltos: string[] = [];
  for (const n of s.nodes) {
    const semEntrada = n.type !== 'start_event' && !hasIncoming.has(n.id);
    const semSaida = n.type !== 'end_event' && !hasOutgoing.has(n.id);
    if (semEntrada || semSaida) soltos.push(n.id);
  }
  if (soltos.length > 0) {
    const todos = soltos.length === s.nodes.length;
    warnings.push({
      code: 'NODE_DISCONNECTED',
      message: todos
        ? `NENHUM no esta conectado (${soltos.length} de ${soltos.length}): a IA nao ` +
          'devolveu fluxos utilizaveis. O desenho sai como caixas soltas.'
        : `${soltos.length} no(s) sem fluxo de entrada ou saida: ${resumirIds(soltos)}.`,
    });
  }

  // Saidas de gateway CONDICIONAL com mais de um caminho precisam de condicao.
  //
  // Vale para exclusive e inclusive, de proposito: nos dois o caminho depende de
  // uma condicao — o que muda e quantos seguem (um so, ou todos os verdadeiros).
  // No parallel_gateway os caminhos acontecem todos juntos e nao ha o que
  // condicionar; exigir condicao la estaria errado. A regra inversa (saida de
  // parallel_gateway NAO deve ter condicao) fica no prompt e nao aqui.
  //
  // REPARAVEL: rotulo faltando e cosmetico — a seta desenha, so sai sem o
  // "Sim"/"Nao" em cima. E exatamente o tipo de coisa que o especialista
  // conserta no painel em dois segundos, e que nao justifica jogar fora uma
  // geracao paga.
  const GATEWAYS_CONDICIONAIS: ReadonlySet<string> = new Set([
    'exclusive_gateway',
    'inclusive_gateway',
  ]);
  for (const n of s.nodes) {
    if (!GATEWAYS_CONDICIONAIS.has(n.type)) continue;
    const out = s.flows.filter((f) => f.source === n.id);
    if (out.length > 1) {
      for (const f of out) {
        if (!f.condition && !f.name) {
          warnings.push({
            code: 'EXCLUSIVE_FLOW_WITHOUT_CONDITION',
            message: `Saida ${f.id} do gateway ${n.id} sem condicao/rotulo.`,
          });
        }
      }
    }
  }

  // Um event_based_gateway so faz sentido apontando para ESPERAS: ele e uma
  // corrida, e quem vence e o evento que ocorrer primeiro. Se os alvos forem
  // tarefas, nao ha corrida nenhuma — o modelo quis dizer exclusive_gateway e
  // errou o tipo.
  //
  // REPARAVEL, revendo a decisao de mais cedo hoje: escrevi estas duas regras
  // como fatais argumentando "o BPMN sairia invalido". Invalido pelo PADRAO,
  // sim — mas renderiza: o bpmn-js desenha o losango e as setas do mesmo jeito.
  // Como o desenho aparece e o especialista consegue ver e corrigir o tipo do
  // gateway, abortar so troca um diagrama defeituoso por diagrama nenhum, ao
  // preco de uma geracao.
  const EVENTOS_DE_CAPTURA: ReadonlySet<string> = new Set(['timer_event', 'message_event']);
  const tipoPorId = new Map(s.nodes.map((n) => [n.id, n.type]));
  for (const n of s.nodes) {
    if (n.type !== 'event_based_gateway') continue;
    const out = s.flows.filter((f) => f.source === n.id);
    if (out.length < 2) {
      warnings.push({
        code: 'EVENT_GATEWAY_SEM_CORRIDA',
        message:
          `Gateway ${n.id} e event_based mas tem ${out.length} saida(s). ` +
          'Uma corrida precisa de pelo menos dois caminhos concorrentes.',
      });
    }
    for (const f of out) {
      const alvo = tipoPorId.get(f.target);
      if (alvo && !EVENTOS_DE_CAPTURA.has(alvo)) {
        warnings.push({
          code: 'EVENT_GATEWAY_ALVO_INVALIDO',
          message:
            `Saida ${f.id} do gateway event_based ${n.id} aponta para ${f.target} ` +
            `(${alvo}). Os alvos tem de ser timer_event ou message_event.`,
        });
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}
