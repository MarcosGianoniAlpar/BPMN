import type { VercelRequest, VercelResponse } from '@vercel/node';
import { isSupportedFilename } from '../dist/documentLoader.js';
import { rejectRequest, decodeFilename, runExtractText } from '../dist/httpHandlers.js';

// Parsing de PDF/DOCX grande pode demorar; folga sobre o default.
export const maxDuration = 60;

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.writeHead(405).end('Method not allowed');
    return;
  }

  const rawName = req.headers['x-filename'];
  const filename = decodeFilename((Array.isArray(rawName) ? rawName[0] : rawName) ?? '');
  if (!filename || !isSupportedFilename(filename)) {
    rejectRequest(res, 'POST', '/api/extract-text', 400, 'Nome de arquivo ausente ou tipo nao suportado.');
    return;
  }

  // Body de octet-stream chega como Buffer em req.body.
  const body: unknown = req.body;
  const buffer = Buffer.isBuffer(body)
    ? body
    : typeof body === 'string'
      ? Buffer.from(body)
      : null;
  if (!buffer) {
    rejectRequest(res, 'POST', '/api/extract-text', 400, 'Upload invalido (esperado bytes do arquivo).');
    return;
  }

  await runExtractText(res, buffer, filename);
}
