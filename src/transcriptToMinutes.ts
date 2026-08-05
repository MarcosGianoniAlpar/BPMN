import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import type { AppConfig } from './config.js';
import type { MeetingMinutes } from './types/meeting-minutes.js';
import { cleanText } from './textCleanup.js';
import { AiCallError } from './aiError.js';
import { validateMeetingMinutes } from './validate.js';
import { thinkingParam, outputConfigParam } from './aiThinking.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const promptPath = resolve(__dirname, '../prompts/transcript-to-minutes.md');
const schemaPath = resolve(__dirname, '../schemas/meeting-minutes.schema.json');

// ATENCAO: este schema e todo INLINE, sem um `$ref` sequer — e e por isso que
// funciona. Se um dia alguem introduzir `$defs`/`$ref` aqui, passe por
// `inlineSchemaRefs()` (src/toolSchema.ts) antes de mandar como input_schema:
// com os itens atras de `$ref`, o modelo devolve a ferramenta preenchida com
// marcadores de template em vez do conteudo.
const minutesSchema = JSON.parse(readFileSync(schemaPath, 'utf-8')) as unknown;

/**
 * Ferramenta que a IA chama para emitir a ata. Mesmo padrao da extracao do
 * ProcessSpec: `tool_choice` forcado garante saida estruturada (o SDK entrega
 * `tool_use.input` ja como objeto), o que importa ainda mais aqui — transcricao
 * e justamente o tipo de documento que quebrava o JSON em texto livre.
 */
export const MEETING_MINUTES_TOOL: Anthropic.Tool = {
  name: 'emit_meeting_minutes',
  description:
    'Registra a ata estruturada extraida da transcricao. Chame esta ferramenta ' +
    'exatamente uma vez, com a ata completa (meeting, participants, topics, ' +
    'decisions, action_items, process_flow e open_questions) conforme o schema, ' +
    'mantendo a evidencia (citacao literal da transcricao) por item.',
  input_schema: minutesSchema as Anthropic.Tool.InputSchema,
};

export interface MinutesResult {
  /** Ata bruta, como a IA emitiu (ainda nao normalizada). */
  minutes: MeetingMinutes;
  usage: { inputTokens: number; outputTokens: number };
}

/**
 * Radiografia do que a IA devolveu, para o log. So ESTRUTURA — nomes de campo,
 * contagens e tipos de bloco; nunca o conteudo da reuniao.
 */
function describeResponse(message: Anthropic.Message, input: unknown): string {
  const blocos = message.content.map((b) => b.type).join('+') || 'nenhum';
  const toolBlocks = message.content.filter((b) => b.type === 'tool_use').length;
  const chaves =
    input && typeof input === 'object' ? Object.keys(input).join(',') || '(vazio)' : typeof input;
  return `blocos=${blocos} · tool_use=${toolBlocks} · stop=${message.stop_reason} · chaves=[${chaves}]`;
}

function readMinutesFromMessage(message: Anthropic.Message): MeetingMinutes {
  // Os erros abaixo levam o `usage` junto: a chamada falhou, mas foi cobrada.
  const usage = {
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
  };

  if (message.stop_reason === 'max_tokens') {
    throw new AiCallError(
      'A ata foi cortada por limite de tokens (max_tokens). ' +
        'Aumente MAX_OUTPUT_TOKENS ou divida a transcricao em partes.',
      usage,
    );
  }

  const toolUse = message.content.find(
    (b): b is Anthropic.ToolUseBlock =>
      b.type === 'tool_use' && b.name === MEETING_MINUTES_TOOL.name,
  );
  if (!toolUse) {
    throw new AiCallError(
      `A IA nao retornou a ata (nenhuma ferramenta chamada). ${describeResponse(message, undefined)}`,
      usage,
    );
  }

  // Validar aqui e o que impede a falha SILENCIOSA: sem isto, um objeto com a
  // forma errada passava direto e virava uma ata em branco na tela do usuario.
  const validation = validateMeetingMinutes(toolUse.input);
  if (!validation.valid) {
    const problemas = validation.errors
      .slice(0, 5)
      .map((e) => e.message)
      .join('; ');
    throw new AiCallError(
      `A ata veio fora do formato esperado: ${problemas}. ` +
        `[diagnostico: ${describeResponse(message, toolUse.input)}]`,
      usage,
    );
  }

  return toolUse.input as MeetingMinutes;
}

/**
 * Passo 1 do modo transcricao: transcricao crua -> ata estruturada.
 *
 * NAO gera BPMN. A saida vira Markdown (ver `minutesMarkdown.ts`) e esse
 * Markdown e que alimenta o pipeline de diagrama — em uma SEGUNDA chamada,
 * depois que o especialista revisar a ata. Separar as duas chamadas tambem
 * mantem cada invocacao dentro do teto de 60s do Vercel Hobby.
 */
export async function transcriptToMinutes(
  transcriptText: string,
  config: AppConfig,
): Promise<MinutesResult> {
  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const cleaned = cleanText(transcriptText);

  // Streaming pelo mesmo motivo da extracao (ver `extractProcessSpec.ts`): sem
  // ele o SDK capa o `max_tokens` em ~21333. A ata de uma reuniao de 1h ja
  // consumiu ~8600 tokens de saida; uma reuniao longa chega perto do teto.
  const message = await client.messages
    .stream({
      model: config.model,
      max_tokens: config.maxOutputTokens,
      system: readFileSync(promptPath, 'utf-8'),
      // OBRIGATORIO passar o campo no Sonnet 5: omitir `thinking` faz o modelo
      // pensar por padrao (mudou em relacao ao 4.6), e `max_tokens` limita
      // thinking + resposta JUNTOS. Foi isso que esvaziou a ata: os tokens de
      // saida foram gastos pensando e sobrou quase nada para a ferramenta.
      //
      // O MODO e configuravel (`AI_THINKING`) — ver src/aiThinking.ts. Aqui o
      // padrao `disabled` custa menos e, das tres chamadas, esta e a mais
      // proxima do teto de 60s do Vercel: pensar tambem gasta relogio.
      thinking: thinkingParam(config),
      // `effort`, configuravel por `AI_EFFORT` — ver src/aiThinking.ts.
      output_config: outputConfigParam(config),
      tools: [MEETING_MINUTES_TOOL],
      tool_choice: { type: 'tool', name: MEETING_MINUTES_TOOL.name },
      messages: [
        {
          role: 'user',
          content: `Transcricao da reuniao:\n\n<transcricao>\n${cleaned}\n</transcricao>`,
        },
      ],
    })
    .finalMessage();

  return {
    minutes: readMinutesFromMessage(message),
    usage: {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
    },
  };
}
