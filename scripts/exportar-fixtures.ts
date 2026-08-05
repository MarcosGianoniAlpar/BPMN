/**
 * Exporta as fixtures de `test/fixtures.ts` como `.bpmn` em `output/fixtures/` e
 * roda o bpmnlint em cada uma.
 *
 * POR QUE ISTO EXISTE: os dois bugs da Task L (rotulos de aresta empilhados e no
 * orfao na camada 0) passaram por `npm test`, pelo bpmnlint e pelo pipeline
 * inteiro sem um aviso. Só apareceram quando o desenho foi olhado como imagem.
 * A licao de processo foi "exportar o PNG faz parte de validar" — e a parte
 * automatizavel dessa licao e esta: gerar o arquivo e lintar a geometria sem
 * gastar um centavo de API.
 *
 * O que ele NAO faz: olhar. Os `.bpmn` ficam prontos para arrastar no app local
 * (`npm run web`) ou no bpmn.io; o julgamento visual continua sendo humano.
 *
 *   npx tsx scripts/exportar-fixtures.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { ProcessSpec } from '../src/types/process-spec.js';
import { compileToBpmn } from '../src/compiler.js';
import { applyLayout } from '../src/layout.js';
import { compileAndLayoutWithLanes } from '../src/laneLayout.js';
import { colorizeBpmn } from '../src/bpmnColor.js';
import { lintBpmn } from '../src/lintBpmn.js';
import {
  specSimples,
  specComRaias,
  specComLoop,
  specFaixaDeValor,
  specComPonteCortada,
  specTodosOsTipos,
} from '../test/fixtures.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const destino = resolve(__dirname, '../output/fixtures');

interface Caso {
  nome: string;
  spec: ProcessSpec;
  /** Fixture que modela um defeito de proposito: erro de lint nela e o esperado. */
  defeituosaDeProposito?: true;
}

const FIXTURES: Caso[] = [
  { nome: 'simples', spec: specSimples() },
  { nome: 'com-raias', spec: specComRaias() },
  { nome: 'com-loop', spec: specComLoop() },
  { nome: 'faixa-de-valor', spec: specFaixaDeValor() },
  // A ponte cortada deixa `triagem` sem saida e `conferir` sem entrada; o lint
  // reportar isso e o comportamento correto, e o desenho sai de qualquer forma.
  { nome: 'ponte-cortada', spec: specComPonteCortada(), defeituosaDeProposito: true },
  { nome: 'todos-os-tipos', spec: specTodosOsTipos() },
];

/** Mesma bifurcacao do orchestrator: com raias, geometria propria. */
async function desenhar(spec: ProcessSpec): Promise<string> {
  const comRaias = (spec.lanes?.length ?? 0) > 0;
  const xml = comRaias
    ? await compileAndLayoutWithLanes(spec)
    : await applyLayout(await compileToBpmn(spec)).then((r) => r.xml);
  return colorizeBpmn(xml);
}

mkdirSync(destino, { recursive: true });

let errosInesperados = 0;
for (const { nome, spec, defeituosaDeProposito } of FIXTURES) {
  const xml = await desenhar(spec);
  writeFileSync(resolve(destino, `${nome}.bpmn`), xml, 'utf-8');

  const { issues, errors, warnings } = await lintBpmn(xml);
  if (!defeituosaDeProposito) errosInesperados += errors;

  const raias = spec.lanes?.length ?? 0;
  const rota = raias ? `laneLayout, ${raias} raia(s)` : 'bpmn-auto-layout';
  const veredito = errors
    ? `${errors} erro(s)${defeituosaDeProposito ? ' (esperados)' : ' INESPERADO(S)'}`
    : warnings
      ? `${warnings} aviso(s)`
      : 'limpo';
  console.log(`\n${nome}.bpmn  ·  ${spec.nodes.length} nos  ·  ${rota}  ·  ${veredito}`);
  for (const i of issues) {
    console.log(`  [${i.category}] ${i.rule}${i.id ? ` (${i.id})` : ''}: ${i.message}`);
  }
}

console.log(`\nArquivos em ${destino}`);
console.log('Arraste no app (npm run web) ou no bpmn.io para olhar o desenho.');
console.log(
  'Lembrete: o bpmnlint olha FORMAS, nao rotulos de aresta — sobreposicao de\n' +
    'rotulo (o L1) nao dispara regra nenhuma aqui e so o olho pega.',
);
if (errosInesperados) {
  console.log(`\n${errosInesperados} erro(s) de lint em fixture que deveria estar limpa.`);
  process.exitCode = 1;
}
