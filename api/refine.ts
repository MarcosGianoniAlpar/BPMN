import type { VercelRequest, VercelResponse } from '@vercel/node';
import { loadConfig } from '../dist/config.js';
import { rejectRequest, runRefine } from '../dist/httpHandlers.js';

// A revisao (IA) leva ~1 min. Exige plano Vercel Pro (Hobby capa em 60s).
export const maxDuration = 300;

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(405).end('Method not allowed');
    return;
  }
  const config = loadConfig();
  const payload = (req.body ?? {}) as {
    text?: string;
    filename?: string;
    projectId?: string;
    spec?: unknown;
    answers?: { question_id: string; question: string; answer: string }[];
  };
  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  const spec = payload.spec;
  const answers = Array.isArray(payload.answers) ? payload.answers : [];
  if (!text || !spec || answers.length === 0) {
    rejectRequest(res, 'POST', '/api/refine', 400, 'Faltam texto, ProcessSpec ou respostas.');
    return;
  }
  await runRefine(res, config, {
    text,
    filename: payload.filename,
    projectId: typeof payload.projectId === 'string' ? payload.projectId : undefined,
    spec,
    answers,
  });
}
