import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';

/**
 * Extensoes aceitas para ingestao. Mantido em um so lugar para o CLI, o
 * servidor e o frontend concordarem sobre o que e suportado.
 */
export const SUPPORTED_EXTENSIONS = ['.txt', '.md', '.markdown', '.pdf', '.docx'] as const;

export function isSupportedFilename(filename: string): boolean {
  return (SUPPORTED_EXTENSIONS as readonly string[]).includes(extname(filename).toLowerCase());
}

/** Normaliza espacos em branco excessivos que parsers de PDF/DOCX costumam gerar. */
function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n') // CRLF -> LF
    .replace(/[ \t]+\n/g, '\n') // espacos no fim de linha
    .replace(/\n{3,}/g, '\n\n') // no maximo uma linha em branco
    .trim();
}

/** Extrai texto de um .docx via mammoth (ignora estilos, pega o conteudo). */
async function extractDocx(buffer: Buffer): Promise<string> {
  const mammoth = await import('mammoth');
  const { value } = await mammoth.extractRawText({ buffer });
  return normalizeWhitespace(value);
}

/**
 * Extrai texto de um .pdf via pdfjs-dist (build "legacy", que roda em Node sem
 * worker de navegador). Junta o texto pagina a pagina, marcando os limites de
 * pagina para que a IA possa citar o numero da pagina na `evidence`.
 */
async function extractPdf(buffer: Buffer): Promise<string> {
  // Build legacy: API estavel para Node, sem depender de Web Worker.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(buffer);
  const loadingTask = pdfjs.getDocument({ data, useSystemFonts: true });

  try {
    const doc = await loadingTask.promise;
    const pages: string[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const pageText = content.items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' ');
      pages.push(`[Página ${n}]\n${normalizeWhitespace(pageText)}`);
    }
    return pages.join('\n\n');
  } finally {
    // Encerra worker/recursos mesmo em caso de erro.
    await loadingTask.destroy();
  }
}

/**
 * Nucleo compartilhado: dado o conteudo bruto de um arquivo e seu nome (para
 * inferir o tipo), devolve o texto plano pronto para a extracao pela IA.
 * Usado tanto pelo CLI (le do disco) quanto pelo servidor (recebe upload).
 */
export async function extractTextFromBuffer(buffer: Buffer, filename: string): Promise<string> {
  const ext = extname(filename).toLowerCase();

  switch (ext) {
    case '.txt':
    case '.md':
    case '.markdown':
      return normalizeWhitespace(buffer.toString('utf-8'));

    case '.docx':
      return extractDocx(buffer);

    case '.pdf':
      return extractPdf(buffer);

    default:
      throw new Error(
        `Tipo de arquivo nao suportado: ${ext || basename(filename)}. ` +
          `Aceitos: ${SUPPORTED_EXTENSIONS.join(', ')}.`,
      );
  }
}

/**
 * Le e extrai o texto de um documento em disco. Wrapper fino sobre
 * extractTextFromBuffer para o CLI.
 */
export async function loadDocumentText(filePath: string): Promise<string> {
  const buffer = await readFile(filePath);
  const text = await extractTextFromBuffer(buffer, filePath);
  if (!text.trim()) {
    throw new Error(
      `O documento ${basename(filePath)} foi lido mas nao contem texto extraivel. ` +
        `Se for um PDF escaneado (imagem), sera preciso OCR (previsto para fase futura).`,
    );
  }
  return text;
}
