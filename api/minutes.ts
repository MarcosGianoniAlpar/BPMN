import type { VercelRequest, VercelResponse } from '@vercel/node';
import { loadConfig } from '../dist/config.js';
import { rejectRequest, runMinutes } from '../dist/httpHandlers.js';

// Transcricao -> ata e uma unica chamada de IA (~1 min em transcricoes longas).
// Exige plano Vercel Pro para usar os 300s; no Hobby o teto real e 60s.
export const maxDuration = 300;

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(405).end('Method not allowed');
    return;
  }
  const config = loadConfig();
  const payload = (req.body ?? {}) as { text?: string; filename?: string };
  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  if (!text) {
    rejectRequest(res, 'POST', '/api/minutes', 400, 'Transcricao vazia ou invalida.');
    return;
  }
  await runMinutes(res, config, text, payload.filename ?? 'transcricao');
}
