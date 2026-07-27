// Empacota os assets do bpmn-js dentro de public/vendor para o Vercel servir como
// estatico. No dev local o server.ts serve /vendor/* direto do node_modules, mas
// no Vercel nao ha servidor: os arquivos precisam existir no diretorio publico.
//
// Rode via `npm run copy:vendor` (chamado tambem pelo `npm run vercel-build`).
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bpmnDist = join(root, 'node_modules', 'bpmn-js', 'dist');
const vendorDir = join(root, 'public', 'vendor');

async function main() {
  // Comeca limpo para nao deixar assets antigos.
  await rm(vendorDir, { recursive: true, force: true });
  await mkdir(vendorDir, { recursive: true });

  // O index.html referencia /vendor/bpmn-modeler.js -> build de producao minificado.
  await cp(
    join(bpmnDist, 'bpmn-modeler.production.min.js'),
    join(vendorDir, 'bpmn-modeler.js'),
  );

  // CSS + fontes (bpmn-font, bpmn-js.css, diagram-js.css) -> /vendor/assets/*.
  await cp(join(bpmnDist, 'assets'), join(vendorDir, 'assets'), { recursive: true });

  console.log('[copy-vendor] bpmn-js copiado para public/vendor/');
}

main().catch((err) => {
  console.error('[copy-vendor] falhou:', err);
  process.exit(1);
});
