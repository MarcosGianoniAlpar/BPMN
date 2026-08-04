import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import type { AppConfig } from './config.js';
import type { ProcessSpec } from './types/process-spec.js';
import { PROCESS_SPEC_TOOL, readSpecFromMessage } from './extractProcessSpec.js';
import { thinkingParam } from './aiThinking.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const promptPath = resolve(__dirname, '../prompts/refine-process.md');

export interface ClarificationAnswer {
  question_id: string;
  question: string;
  answer: string;
}

export interface RefinementResult {
  /** ProcessSpec revisado, ainda nao validado. */
  raw: unknown;
  usage: { inputTokens: number; outputTokens: number };
}

/**
 * Segunda passada: recebe o ProcessSpec atual + respostas do especialista e
 * pede a LLM um ProcessSpec revisado que incorpore essas decisoes. A geometria
 * NAO entra aqui — quem recompila e aplica o layout e o orquestrador.
 */
export async function refineProcessSpec(
  documentText: string,
  currentSpec: ProcessSpec,
  answers: ClarificationAnswer[],
  config: AppConfig,
): Promise<RefinementResult> {
  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const system = readFileSync(promptPath, 'utf-8');

  const answersText = answers
    .map(
      (a, i) =>
        `${i + 1}. Pergunta: ${a.question}\n   Resposta do especialista: ${a.answer}`,
    )
    .join('\n\n');

  const userContent = [
    `<documento>\n${documentText}\n</documento>`,
    `<process_spec_atual>\n${JSON.stringify(currentSpec, null, 2)}\n</process_spec_atual>`,
    `<respostas_do_especialista>\n${answersText}\n</respostas_do_especialista>`,
  ].join('\n\n');

  // Streaming pelo mesmo motivo da extracao (ver `extractProcessSpec.ts`): sem
  // ele o SDK capa o `max_tokens` em ~21333, muito abaixo dos 128000 do modelo.
  // O refino devolve o ProcessSpec INTEIRO, entao e tao grande quanto a extracao.
  const message = await client.messages
    .stream({
      model: config.model,
      max_tokens: config.maxOutputTokens,
      system,
      // Configuravel por `AI_THINKING` — ver src/aiThinking.ts. Nunca omitir:
      // omitir LIGA o thinking, que dividiria o `max_tokens` com o spec revisado.
      thinking: thinkingParam(config),
      tools: [PROCESS_SPEC_TOOL],
      tool_choice: { type: 'tool', name: PROCESS_SPEC_TOOL.name },
      messages: [{ role: 'user', content: userContent }],
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
