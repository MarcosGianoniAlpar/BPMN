import type { VercelRequest, VercelResponse } from '@vercel/node';
import { sendJson, handleProjectsApi, runFreeze } from '../../dist/httpHandlers.js';

/**
 * Catch-all das rotas de projeto. Cobre:
 *   GET    /api/projects, /api/projects/{id}, /api/projects/{id}/versions/{n}
 *   DELETE /api/projects/{id}
 *   POST   /api/projects/{id}/freeze
 * Reconstroi os `segments` no mesmo formato do dev local (`['api','projects',...]`)
 * e delega ao core compartilhado.
 */
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const raw = req.query.path;
  const path = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const segments = ['api', 'projects', ...path];

  // POST /api/projects/{id}/freeze
  if (method === 'POST' && segments.length === 4 && segments[3] === 'freeze' && segments[2]) {
    const payload = (req.body ?? {}) as { bpmnXml?: string; spec?: unknown; note?: string };
    await runFreeze(res, segments[2], payload);
    return;
  }

  if (method === 'GET' || method === 'DELETE') {
    const handled = await handleProjectsApi(method, segments, res);
    if (!handled && !res.headersSent) {
      sendJson(res, 404, { error: 'Rota de projeto nao encontrada.' });
    }
    return;
  }

  res.writeHead(405).end('Method not allowed');
}
