import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import type { AppConfig } from './config.js';
import type { ProcessSpec } from './types/process-spec.js';
import { extractJson } from './extractProcessSpec.js';

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

  const message = await client.messages.create({
    model: config.model,
    max_tokens: config.maxOutputTokens,
    system,
    messages: [{ role: 'user', content: userContent }],
  });

  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

  return {
    raw: extractJson(text),
    usage: {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
    },
  };
}
