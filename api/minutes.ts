import type { VercelRequest, VercelResponse } from '@vercel/node';
import { loadConfig } from '../dist/config.js';
import {
  rejectRequest,
  runMinutes,
  handleMinutesApi,
  sendJson,
  clientIp,
} from '../dist/httpHandlers.js';

// Transcricao -> ata e uma unica chamada de IA (~1 min em transcricoes longas).
// Exige plano Vercel Pro para usar os 300s; no Hobby o teto real e 60s.
export const maxDuration = 300;

/**
 * Rota exata /api/minutes:
 *   POST -> transcricao vira ata (gasta IA)
 *   GET  -> lista as atas salvas
 * As rotas por id (/api/minutes/{id}) ficam no catch-all `minutes/[...path].ts`.
 */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const method = req.method ?? 'GET';

  if (method === 'GET') {
    const handled = await handleMinutesApi('GET', ['api', 'minutes'], res);
    if (!handled && !res.headersSent) sendJson(res, 404, { error: 'Rota de ata nao encontrada.' });
    return;
  }

  if (method !== 'POST') {
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
  await runMinutes(res, config, {
    transcript: text,
    filename: payload.filename ?? 'transcricao',
    ip: clientIp(req.headers, req.socket?.remoteAddress),
  });
}
