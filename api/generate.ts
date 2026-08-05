import type { VercelRequest, VercelResponse } from '@vercel/node';
import { loadConfig } from '../dist/config.js';
import { rejectRequest, runGenerate, clientIp } from '../dist/httpHandlers.js';

// A extracao (IA) leva ~1 min. Exige plano Vercel Pro (Hobby capa em 60s).
export const maxDuration = 300;

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(405).end('Method not allowed');
    return;
  }
  const config = loadConfig();
  const payload = (req.body ?? {}) as { text?: string; filename?: string; minutesId?: string };
  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  if (!text) {
    rejectRequest(res, 'POST', '/api/generate', 400, 'Documento vazio ou invalido.');
    return;
  }
  await runGenerate(res, config, {
    text,
    filename: payload.filename ?? 'documento',
    minutesId: payload.minutesId,
    ip: clientIp(req.headers, req.socket?.remoteAddress),
  });
}
