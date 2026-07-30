import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { loadConfig } from './config.js';
import { isSupportedFilename } from './documentLoader.js';
import {
  sendJson,
  rejectRequest,
  decodeFilename,
  runGenerate,
  runRefine,
  runMinutes,
  runExtractText,
  sendUsage,
  handleProjectsApi,
  runFreeze,
} from './httpHandlers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const publicDir = join(root, 'public');
const bpmnDist = join(root, 'node_modules', 'bpmn-js', 'dist');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
};

async function sendFile(res: ServerResponse, filePath: string): Promise<void> {
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'content-type': MIME[extname(filePath)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

/** Impede path traversal: resolve dentro de baseDir e recusa se escapar. */
function safeJoin(baseDir: string, urlPath: string): string | null {
  const target = normalize(join(baseDir, urlPath));
  return target.startsWith(baseDir) ? target : null;
}

async function readBody(req: IncomingMessage, limitBytes = 20 * 1024 * 1024): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('Corpo da requisicao muito grande.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

async function readBodyBuffer(
  req: IncomingMessage,
  limitBytes = 25 * 1024 * 1024,
): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('Arquivo muito grande (limite 25 MB).'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Le o upload cru (bytes + nome do header `x-filename`), valida o nome e delega a
 * extracao ao core compartilhado. O parsing de PDF/DOCX roda no Node.
 */
async function handleExtractText(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const rawName = req.headers['x-filename'];
  const filename = decodeFilename((Array.isArray(rawName) ? rawName[0] : rawName) ?? '');
  if (!filename || !isSupportedFilename(filename)) {
    return rejectRequest(res, 'POST', '/api/extract-text', 400, 'Nome de arquivo ausente ou tipo nao suportado.');
  }

  let buffer: Buffer;
  try {
    buffer = await readBodyBuffer(req);
  } catch (err) {
    return rejectRequest(res, 'POST', '/api/extract-text', 413, err instanceof Error ? err.message : 'Upload invalido.');
  }

  return runExtractText(res, buffer, filename);
}

async function handleGenerate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const config = loadConfig();
  let payload: { text?: string; filename?: string };
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return rejectRequest(res, 'POST', '/api/generate', 400, 'JSON invalido.');
  }

  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  if (!text) {
    return rejectRequest(res, 'POST', '/api/generate', 400, 'Documento vazio ou invalido.');
  }

  return runGenerate(res, config, text, payload.filename ?? 'documento');
}

async function handleMinutes(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const config = loadConfig();
  let payload: { text?: string; filename?: string };
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return rejectRequest(res, 'POST', '/api/minutes', 400, 'JSON invalido.');
  }

  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  if (!text) {
    return rejectRequest(res, 'POST', '/api/minutes', 400, 'Transcricao vazia ou invalida.');
  }

  return runMinutes(res, config, text, payload.filename ?? 'transcricao');
}

async function handleRefine(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const config = loadConfig();
  let payload: {
    text?: string;
    filename?: string;
    projectId?: string;
    spec?: unknown;
    answers?: { question_id: string; question: string; answer: string }[];
  };
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return rejectRequest(res, 'POST', '/api/refine', 400, 'JSON invalido.');
  }

  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  const spec = payload.spec;
  const answers = Array.isArray(payload.answers) ? payload.answers : [];
  if (!text || !spec || answers.length === 0) {
    return rejectRequest(res, 'POST', '/api/refine', 400, 'Faltam texto, ProcessSpec ou respostas.');
  }

  return runRefine(res, config, {
    text,
    filename: payload.filename,
    projectId: typeof payload.projectId === 'string' ? payload.projectId : undefined,
    spec,
    answers,
  });
}

async function handleFreeze(
  req: IncomingMessage,
  res: ServerResponse,
  projectId: string,
): Promise<void> {
  let payload: { bpmnXml?: string; spec?: unknown; note?: string };
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return rejectRequest(res, 'POST', `/api/projects/${projectId}/freeze`, 400, 'JSON invalido.');
  }
  return runFreeze(res, projectId, payload);
}

const server = createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0] ?? '/';
  const method = req.method ?? 'GET';
  const segments = url.split('/').filter(Boolean);

  // Nunca deixa uma requisicao ruim derrubar o processo.
  const guard = (p: Promise<void>): void => {
    p.catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) sendJson(res, 500, { error: message });
    });
  };

  if (method === 'POST' && url === '/api/extract-text') {
    guard(handleExtractText(req, res));
    return;
  }
  if (method === 'POST' && url === '/api/generate') {
    guard(handleGenerate(req, res));
    return;
  }
  if (method === 'POST' && url === '/api/refine') {
    guard(handleRefine(req, res));
    return;
  }
  if (method === 'POST' && url === '/api/minutes') {
    guard(handleMinutes(req, res));
    return;
  }
  // POST /api/projects/{id}/freeze
  if (
    method === 'POST' &&
    segments[0] === 'api' &&
    segments[1] === 'projects' &&
    segments[2] &&
    segments[3] === 'freeze' &&
    segments.length === 4
  ) {
    guard(handleFreeze(req, res, segments[2]));
    return;
  }

  // Relatorio de uso/custo
  if (method === 'GET' && url === '/api/usage') {
    guard(sendUsage(res));
    return;
  }

  // API de projetos salvos (GET/DELETE)
  if ((method === 'GET' || method === 'DELETE') && segments[0] === 'api' && segments[1] === 'projects') {
    guard(
      (async () => {
        if (!(await handleProjectsApi(method, segments, res)) && !res.headersSent) {
          sendJson(res, 404, { error: 'Rota de projeto nao encontrada.' });
        }
      })(),
    );
    return;
  }

  if (method !== 'GET') {
    res.writeHead(405);
    res.end('Method not allowed');
    return;
  }

  // Assets do bpmn-js servidos direto do node_modules (dev local).
  // No Vercel eles sao copiados para public/vendor no build (ver scripts/copy-vendor.mjs).
  if (url === '/vendor/bpmn-modeler.js') {
    void sendFile(res, join(bpmnDist, 'bpmn-modeler.production.min.js'));
    return;
  }
  if (url.startsWith('/vendor/assets/')) {
    const target = safeJoin(join(bpmnDist, 'assets'), url.slice('/vendor/assets/'.length));
    if (target) void sendFile(res, target);
    else res.writeHead(403).end('Forbidden');
    return;
  }

  // Frontend estatico
  const rel = url === '/' ? 'index.html' : url.slice(1);
  const target = safeJoin(publicDir, rel);
  if (target) void sendFile(res, target);
  else res.writeHead(403).end('Forbidden');
});

const PORT = Number(process.env.PORT ?? '3000');
// Valida a config (ANTHROPIC_API_KEY) ja na subida, com erro claro.
loadConfig();
server.listen(PORT, () => {
  console.log(`\n  BPMN Pipeline rodando em  http://localhost:${PORT}\n`);
  console.log('  Abra no navegador, arraste uma ata .txt/.md e gere o diagrama.\n');
});
