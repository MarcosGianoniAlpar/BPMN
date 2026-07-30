import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import type { AppConfig } from './config.js';
import { AiCallError } from './aiError.js';
import { inlineSchemaRefs } from './toolSchema.js';

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
 */
export const PROCESS_SPEC_TOOL: Anthropic.Tool = {
  name: 'emit_process_spec',
  description:
    'Registra o ProcessSpec extraido do documento. Chame esta ferramenta exatamente ' +
    'uma vez, com o ProcessSpec completo (process, participants, lanes, nodes, flows e ' +
    'unresolved_questions) conforme o schema, mantendo a evidencia por elemento.',
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
    return desembrulharSpec(toolUse.input);
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

  const message = await client.messages.create({
    model: config.model,
    max_tokens: config.maxOutputTokens,
    system: loadSystemPrompt(),
    // Ver a nota em transcriptToMinutes.ts: no Sonnet 5 o thinking vem LIGADO
    // quando o campo e omitido, e divide o `max_tokens` com a resposta.
    thinking: { type: 'disabled' },
    tools: [PROCESS_SPEC_TOOL],
    tool_choice: { type: 'tool', name: PROCESS_SPEC_TOOL.name },
    messages: [
      {
        role: 'user',
        content: `Documento a analisar:\n\n<documento>\n${documentText}\n</documento>`,
      },
    ],
  });

  return {
    raw: readSpecFromMessage(message),
    usage: {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
    },
  };
}
