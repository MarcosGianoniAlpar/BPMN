import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import type { AppConfig } from './config.js';
import { AiCallError } from './aiError.js';
import { inlineSchemaRefs } from './toolSchema.js';
import { thinkingParam, outputConfigParam } from './aiThinking.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const promptPath = resolve(__dirname, '../prompts/extract-process.md');
const schemaPath = resolve(__dirname, '../schemas/process-spec.schema.json');

function loadSystemPrompt(): string {
  return readFileSync(promptPath, 'utf-8');
}

// Schema do ProcessSpec, usado como input_schema da ferramenta (saida estruturada).
// ACHATADO de proposito: ver src/toolSchema.ts — com os itens dos arrays atras de
// `$ref`, o modelo devolvia a ferramenta preenchida com marcadores de template.
const processSpecSchema = inlineSchemaRefs(JSON.parse(readFileSync(schemaPath, 'utf-8')));

/**
 * Ferramenta que a IA chama para emitir o ProcessSpec. Forcar `tool_choice` nesta
 * ferramenta garante que a saida venha pelo canal estruturado de tool use — o SDK
 * entrega `tool_use.input` ja como OBJETO, eliminando o `JSON.parse` de texto livre
 * que quebrava com documentos baguncados (transcricoes, encoding ruim).
 *
 * `strict: true` e o passo seguinte, e ataca o defeito que sobrou depois disso.
 * O canal estruturado garantia que vinha um OBJETO; nao garantia a FORMA dele — e
 * era exatamente ali que doia: `nodes` chegando como string de JSON, como mapa por
 * id, ou agrupado por processo. Com `strict`, a API compila este schema numa
 * gramatica e restringe a amostragem do modelo aos tokens validos, o que torna
 * essas formas impossiveis em vez de remendaveis.
 *
 * Duas coisas conferidas na referencia da API antes de ligar, porque as duas
 * poderiam matar isto em silencio:
 * - `strict` + `tool_choice` FORCADO e valido; a propria doc recomenda a
 *   combinacao para garantir "que a ferramenta sera chamada E que a entrada segue
 *   o schema". (Cuidado adjacente: `thinking: enabled` — o modo manual, removido
 *   no Sonnet 5 — e que era incompativel com tool_choice forcado. `adaptive` nao.)
 * - o schema precisa passar por `inlineSchemaRefs()`, que poda os keywords que a
 *   saida estruturada recusa. Um deles aqui devolve 400.
 *
 * O `normalizarColecoes` NAO sai junto: fica como rede ate uma rodada real
 * confirmar. Se ele parar de disparar, ai sim vira codigo morto.
 */
export const PROCESS_SPEC_TOOL: Anthropic.Tool = {
  name: 'emit_process_spec',
  description:
    'Registra o ProcessSpec extraido do documento. Chame esta ferramenta exatamente ' +
    'uma vez, com o ProcessSpec completo (process, participants, lanes, nodes, flows e ' +
    'unresolved_questions) conforme o schema, mantendo a evidencia por elemento.',
  strict: true,
  input_schema: processSpecSchema as Anthropic.Tool.InputSchema,
};

/**
 * Extrai o primeiro objeto JSON de uma resposta que pode vir cercada por texto ou
 * blocos de codigo. Mantido como FALLBACK: com tool use o caminho normal nao usa
 * isto, mas se a IA responder em texto (raro sob tool_choice forcado) ainda tentamos.
 */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('Nenhum objeto JSON encontrado na resposta da LLM.');
  }
  const json = candidate.slice(start, end + 1);
  return JSON.parse(json);
}

/**
 * Le o ProcessSpec (bruto, ainda nao validado) da mensagem: prioriza o bloco
 * `tool_use` da nossa ferramenta; se a resposta foi cortada por limite de tokens,
 * lanca um erro claro (em vez do JSON malformado que o usuario via antes).
 */
/**
 * Tira o ProcessSpec de um envelope de um nivel, se ele vier embrulhado
 * (`{ parameters: {...} }`, `{ input: {...} }`, `{ process_spec: {...} }`).
 *
 * Nao e paranoia: aconteceu duas vezes em producao. E o estrago era invisivel —
 * o Ajv roda com `removeAdditional`, entao ele APAGA a chave desconhecida, sobra
 * um objeto vazio, e o erro que chega ao usuario e "faltam process, nodes e
 * flows", como se a IA nao tivesse extraido nada. Uma geracao paga no lixo por
 * causa de uma camada a mais.
 *
 * O aviso e barulhento de proposito: desembrulhar e um remendo, o conserto de
 * verdade e o prompt dizer para preencher os campos na raiz da ferramenta.
 */
function desembrulharSpec(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const obj = input as Record<string, unknown>;
  if ('process' in obj || 'nodes' in obj || 'flows' in obj) return obj;

  const chaves = Object.keys(obj);
  if (chaves.length !== 1) return obj;
  const dentro = obj[chaves[0]!];
  if (!dentro || typeof dentro !== 'object' || Array.isArray(dentro)) return obj;

  const interno = dentro as Record<string, unknown>;
  if (!('process' in interno) && !('nodes' in interno)) return obj;

  console.log(
    `  [extracao] AVISO: o ProcessSpec veio embrulhado em "${chaves[0]}" — ` +
      `desembrulhando. Se isto se repetir, o prompt precisa ser mais explicito.`,
  );
  return interno;
}

/** Coleções do ProcessSpec que o schema exige como array. */
const COLECOES = ['nodes', 'flows', 'participants', 'lanes', 'unresolved_questions'] as const;

/** Quantos pontos de corte tentar, do fim para o começo, antes de desistir. */
const MAX_TENTATIVAS_DE_CORTE = 50;

/**
 * Recupera os itens COMPLETOS de um array JSON que não parseia inteiro.
 *
 * São duas avarias, e as duas aconteceram de verdade com a ata de PO:
 *
 *   1. **cortado** — o modelo escreve `[{...},{...},{...` e para;
 *   2. **fim malformado** — ele escreve 43 itens bons, desiste, e fecha o array
 *      com um item lixo (`{"id": "x": null}]`). O array *fecha*, mas não parseia.
 *
 * Nos dois casos os itens anteriores estão perfeitos, e cada tentativa dessas
 * custa uma geração paga. Salvar 43 de 44 é muito melhor do que zero.
 *
 * Varre caractere a caractere respeitando literais de string (um `}` dentro de
 * uma citação de `evidence` não fecha nada), guarda TODOS os pontos onde um item
 * de primeiro nível fechou, e tenta do último para trás. Tentar só o último não
 * basta: na avaria nº 2 o último ponto é justamente o do item lixo.
 */
export function salvarItensCompletos(texto: string): unknown[] | undefined {
  const inicio = texto.indexOf('[');
  if (inicio === -1) return undefined;

  let profundidade = 0;
  let dentroDeString = false;
  let escapado = false;
  const fimDeItem: number[] = [];

  for (let i = inicio; i < texto.length; i++) {
    const c = texto[i]!;
    if (escapado) {
      escapado = false;
      continue;
    }
    if (c === '\\') {
      if (dentroDeString) escapado = true;
      continue;
    }
    if (c === '"') {
      dentroDeString = !dentroDeString;
      continue;
    }
    if (dentroDeString) continue;

    if (c === '[' || c === '{') profundidade++;
    else if (c === ']' || c === '}') {
      profundidade--;
      // Voltar para 1 significa que um item do primeiro nivel acabou de fechar.
      if (profundidade === 1) fimDeItem.push(i);
    }
  }

  const tentativas = Math.min(fimDeItem.length, MAX_TENTATIVAS_DE_CORTE);
  for (let n = 0; n < tentativas; n++) {
    const corte = fimDeItem[fimDeItem.length - 1 - n]!;
    try {
      const parsed: unknown = JSON.parse(`${texto.slice(inicio, corte + 1)}]`);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch {
      // Este ponto de corte ainda pega o item avariado; tenta o anterior.
    }
  }
  return undefined;
}

/**
 * Conserta coleções que vieram na forma errada. Duas acontecem de verdade com
 * documentos grandes, e ambas custam a geração inteira:
 *
 *   1. **array serializado em string** — `"nodes": "[{...}]"` em vez de `[{...}]`;
 *   2. **mapa por id** — `"nodes": { "abrir_chamado": {...} }` em vez de lista.
 *
 * O sintoma é sempre `/nodes must be array`, e antes disto o usuário pagava a
 * chamada e recebia só isso. Como a estrutura extraída está inteira nos dois
 * casos, jogá-la fora é desperdício — o conserto é mecânico e não inventa nada.
 *
 * Barulhento de propósito, como o `desembrulharSpec`: remendo aqui significa
 * prompt/schema a ajustar lá.
 */
function normalizarColecoes(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const obj = input as Record<string, unknown>;

  for (const chave of COLECOES) {
    const valor = obj[chave];
    if (valor === undefined || Array.isArray(valor)) continue;

    if (typeof valor === 'string') {
      try {
        const parsed: unknown = JSON.parse(valor);
        if (Array.isArray(parsed)) {
          obj[chave] = parsed;
          console.log(
            `  [extracao] AVISO: "${chave}" veio como STRING de JSON (${valor.length} chars) — ` +
              `parseado para array de ${parsed.length}.`,
          );
          continue;
        }
      } catch (erro) {
        // O parse inteiro falhou. Antes isto era um `catch` vazio, e o motivo
        // morria aqui: o usuario pagava a geracao e recebia so
        // "/nodes must be array", sem saber que a string era JSON cortado.
        const motivo = erro instanceof Error ? erro.message : String(erro);
        const salvos = salvarItensCompletos(valor);
        if (salvos && salvos.length > 0) {
          obj[chave] = salvos;
          console.log(
            `  [extracao] AVISO: "${chave}" veio como STRING de JSON AVARIADA ` +
              `(${valor.length} chars; ${motivo}) — recuperados ${salvos.length} item(ns) ` +
              `completo(s); o resto foi descartado.`,
          );
          continue;
        }
        console.log(
          `  [extracao] AVISO: "${chave}" e uma STRING de ${valor.length} chars que nao ` +
            `parseia como JSON (${motivo}) e da qual nao deu para salvar nenhum item.\n` +
            `    inicio: ${JSON.stringify(valor.slice(0, 200))}\n` +
            `    fim:    ${JSON.stringify(valor.slice(-200))}`,
        );
      }
    }

    if (valor && typeof valor === 'object') {
      const itens = Object.values(valor as Record<string, unknown>);
      if (itens.length === 0) continue;

      // AGRUPADO: `{ "aprovacao": [...], "sourcing": [...] }`. Acontece quando o
      // documento descreve VARIOS processos e o schema so aceita um — o modelo
      // agrupa em vez de escolher. Achatar e a unica leitura possivel; a
      // separacao real dos processos e a Task I, nao um remendo aqui.
      if (itens.every(Array.isArray)) {
        const achatado = (itens as unknown[][]).flat();
        obj[chave] = achatado;
        console.log(
          `  [extracao] AVISO: "${chave}" veio AGRUPADO em ${itens.length} grupo(s) ` +
            `(${Object.keys(valor).join(', ')}) — achatado para ${achatado.length} item(ns). ` +
            `Sinal de que o documento tem mais de um processo.`,
        );
        continue;
      }

      // MAPA por id: `{ "abrir_chamado": {...} }`. Só converte se TODO valor for
      // objeto — senão isto não era um mapa de itens.
      if (itens.every((i) => i !== null && typeof i === 'object')) {
        obj[chave] = itens;
        console.log(
          `  [extracao] AVISO: "${chave}" veio como MAPA por id — ` +
            `convertido para array de ${itens.length}.`,
        );
      }
    }
  }
  return obj;
}

export function readSpecFromMessage(message: Anthropic.Message): unknown {
  // Os erros abaixo levam o `usage` junto: a chamada falhou, mas foi cobrada.
  const usage = {
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
  };

  if (message.stop_reason === 'max_tokens') {
    throw new AiCallError(
      'A resposta da IA foi cortada por limite de tokens (max_tokens). ' +
        'Aumente MAX_OUTPUT_TOKENS ou reduza/enxugue o documento.',
      usage,
    );
  }

  const toolUse = message.content.find(
    (b): b is Anthropic.ToolUseBlock =>
      b.type === 'tool_use' && b.name === PROCESS_SPEC_TOOL.name,
  );
  if (toolUse) {
    console.log(
      `  [extracao] veio por tool_use · chaves na raiz: ` +
        `${Object.keys((toolUse.input as Record<string, unknown>) ?? {}).join(', ') || '(nenhuma)'}`,
    );
    return normalizarColecoes(desembrulharSpec(toolUse.input));
  }

  // Fallback: a IA respondeu em TEXTO apesar do tool_choice forcado. Acontece —
  // e um modo de falha conhecido quando o thinking esta desligado: o modelo
  // escreve a chamada da ferramenta na resposta visivel em vez de emitir o bloco
  // tool_use. O aviso abaixo separa esse caso de um erro de modelagem.
  console.log(
    `  [extracao] AVISO: nenhum bloco tool_use — a IA respondeu em texto ` +
      `(stop_reason=${message.stop_reason}). Usando o extrator de JSON como plano B.`,
  );
  const text = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  if (!text.trim()) {
    throw new AiCallError('A IA nao retornou o ProcessSpec (nenhuma ferramenta chamada).', usage);
  }
  return extractJson(text);
}

export interface ExtractionResult {
  /** ProcessSpec bruto, ainda nao validado contra o schema. */
  raw: unknown;
  usage: { inputTokens: number; outputTokens: number };
}

/**
 * Fase 1: uma unica chamada. Passa o documento inteiro e pede o ProcessSpec com
 * evidencia obrigatoria, via tool use forcado (saida estruturada).
 */
export async function extractProcessSpec(
  documentText: string,
  config: AppConfig,
): Promise<ExtractionResult> {
  const client = new Anthropic({ apiKey: config.anthropicApiKey });

  // STREAMING, nao `create`. O `max_tokens` que da para pedir depende disto:
  // numa chamada NAO-streaming o SDK recusa na hora qualquer valor que ele
  // estime levar mais de 10 minutos (~21333), enquanto o Sonnet 5 aceita ate
  // 128000. Foi esse teto artificial que cortou a extracao da ata de PO em
  // 20000 tokens de saida — cobrados, e sem devolver nada aproveitavel, porque
  // o JSON da ferramenta veio partido no meio.
  //
  // `.finalMessage()` devolve a mensagem ja remontada: nao ha evento a tratar
  // nem `tool_use` a reconstruir a partir dos deltas.
  const message = await client.messages
    .stream({
      model: config.model,
      max_tokens: config.maxOutputTokens,
      system: loadSystemPrompt(),
      // Configuravel por `AI_THINKING` — ver src/aiThinking.ts para o porque.
      // NUNCA omitir o campo: no Sonnet 5 omitir LIGA o thinking, e ele divide
      // o `max_tokens` com a resposta.
      thinking: thinkingParam(config),
      // `effort`, configuravel por `AI_EFFORT`. Sem este campo a API assume
      // `high` — o que estava acontecendo por omissao. Ver src/aiThinking.ts.
      output_config: outputConfigParam(config),
      tools: [PROCESS_SPEC_TOOL],
      tool_choice: { type: 'tool', name: PROCESS_SPEC_TOOL.name },
      messages: [
        {
          role: 'user',
          // O lembrete de idioma vem DEPOIS do documento de proposito: e a
          // ultima coisa que o modelo le antes de responder, e o ponto onde a
          // regra 5 do prompt estava sendo perdida. Sem ele, uma ata em ingles
          // saia com rotulos em portugues — o modelo seguia o idioma das
          // instrucoes (que sao em portugues) em vez do idioma do documento.
          content:
            `Documento a analisar:\n\n<documento>\n${documentText}\n</documento>\n\n` +
            'Lembrete: escreva `name`, `detail` e as perguntas no MESMO IDIOMA do ' +
            'documento acima — nao no idioma destas instrucoes.',
        },
      ],
    })
    .finalMessage();

  return {
    raw: readSpecFromMessage(message),
    usage: {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
    },
  };
}
