import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import type { AppConfig } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const promptPath = resolve(__dirname, '../prompts/extract-process.md');

function loadSystemPrompt(): string {
  return readFileSync(promptPath, 'utf-8');
}

/**
 * Extrai o primeiro objeto JSON de uma resposta que pode vir cercada por
 * texto ou blocos de codigo. Fase 1 pede JSON puro, mas seguramos os dois casos.
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

export interface ExtractionResult {
  /** ProcessSpec bruto, ainda nao validado contra o schema. */
  raw: unknown;
  usage: { inputTokens: number; outputTokens: number };
}

/**
 * Fase 1: uma unica chamada. Passa o documento inteiro e pede o ProcessSpec
 * com evidencia obrigatoria. Chunking e consolidacao em duas etapas ficam para
 * a Fase 2 (multiplos documentos).
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
    messages: [
      {
        role: 'user',
        content: `Documento a analisar:\n\n<documento>\n${documentText}\n</documento>`,
      },
    ],
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
