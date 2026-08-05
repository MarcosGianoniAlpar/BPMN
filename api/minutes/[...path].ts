import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sendJson, handleMinutesApi, runUpdateMinutes } from '../../dist/httpHandlers.js';

/**
 * Catch-all das atas por id. Cobre:
 *   GET    /api/minutes/{id}   -> ata completa
 *   PUT    /api/minutes/{id}   -> salva o texto revisado
 *   DELETE /api/minutes/{id}   -> apaga
 * Reconstroi os `segments` no mesmo formato do dev local (`['api','minutes',...]`)
 * e delega ao core compartilhado. A rota exata /api/minutes fica em `minutes.ts`.
 */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const raw = req.query.path;
  const path = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const segments = ['api', 'minutes', ...path];
  const id = segments[2];

  if (method === 'PUT' && segments.length === 3 && id) {
    const payload = (req.body ?? {}) as { markdown?: string };
    await runUpdateMinutes(res, id, payload);
    return;
  }

  if (method === 'GET' || method === 'DELETE') {
    const handled = await handleMinutesApi(method, segments, res);
    if (!handled && !res.headersSent) {
      sendJson(res, 404, { error: 'Rota de ata nao encontrada.' });
    }
    return;
  }

  res.writeHead(405).end('Method not allowed');
}
