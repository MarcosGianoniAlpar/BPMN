import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import BpmnModdle from 'bpmn-moddle';
import { compileToBpmn } from '../src/compiler.js';
import { NODE_TYPE_TO_BPMN } from '../src/bpmnNodes.js';
import { specSimples, specTodosOsTipos } from './fixtures.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(__dirname, '../schemas/process-spec.schema.json');

/** Reparse do XML gerado — o teste checa o resultado, nao a string. */
async function parse(xml: string) {
  const moddle = new BpmnModdle();
  const { rootElement, warnings } = await moddle.fromXML(xml);
  return { definitions: rootElement, warnings };
}

describe('NODE_TYPE_TO_BPMN', () => {
  test('todo tipo do schema tem traducao para BPMN', () => {
    // Este e o teste que evita o erro classico: adicionar um tipo novo ao
    // schema, ensinar o prompt a usa-lo, e descobrir so no diagrama do usuario
    // que nenhum dos dois compiladores sabe desenha-lo.
    const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));
    const tiposDoSchema: string[] = schema.$defs.nodeType.enum;

    for (const tipo of tiposDoSchema) {
      assert.ok(
        NODE_TYPE_TO_BPMN[tipo as keyof typeof NODE_TYPE_TO_BPMN],
        `tipo "${tipo}" esta no schema mas nao em NODE_TYPE_TO_BPMN`,
      );
    }
    assert.equal(Object.keys(NODE_TYPE_TO_BPMN).length, tiposDoSchema.length);
  });
});

describe('compileToBpmn — estrutura', () => {
  test('gera XML que o bpmn-moddle reparseia sem warnings', async () => {
    const xml = await compileToBpmn(specSimples());
    const { warnings } = await parse(xml);
    assert.deepEqual(warnings, []);
  });

  test('emite um Process nao executavel com o nome do spec', async () => {
    const spec = specSimples();
    const { definitions } = await parse(await compileToBpmn(spec));
    const process = definitions.get('rootElements').find((e: { $type: string }) => e.$type === 'bpmn:Process');

    assert.ok(process, 'esperava um bpmn:Process');
    assert.equal(process.get('name'), spec.process.name);
    assert.equal(process.get('isExecutable'), false);
  });

  test('NAO emite DI — a geometria vem depois, do bpmn-auto-layout', async () => {
    // Um laneSet ou pool sem DI quebra o bpmn-auto-layout e a regra `no-bpmndi`
    // do bpmnlint; por isso este caminho e deliberadamente so semantico.
    const xml = await compileToBpmn(specSimples());
    assert.ok(!xml.includes('BPMNDiagram'), 'o caminho sem raias nao deve emitir DI');
  });

  test('nao emite Collaboration nem laneSet', async () => {
    const xml = await compileToBpmn(specSimples());
    assert.ok(!xml.includes('bpmn:collaboration') && !xml.includes('Collaboration'));
    assert.ok(!xml.includes('LaneSet'));
  });
});

describe('compileToBpmn — nos e fluxos', () => {
  test('traduz cada tipo de no para o elemento BPMN certo', async () => {
    const spec = specTodosOsTipos();
    const { definitions } = await parse(await compileToBpmn(spec));
    const process = definitions.get('rootElements')[0];
    const porId = new Map<string, { $type: string }>(
      process.get('flowElements').map((e: { id: string }) => [e.id, e]),
    );

    for (const node of spec.nodes) {
      assert.equal(
        porId.get(node.id)?.$type,
        NODE_TYPE_TO_BPMN[node.type],
        `no "${node.id}" (${node.type})`,
      );
    }
  });

  test('eventos intermediarios levam o eventDefinition que os distingue', async () => {
    // timer_event e message_event viram o MESMO elemento BPMN; sem o
    // eventDefinition o bpmn-js desenha um circulo vazio, um evento que nao diz
    // o que espera.
    const { definitions } = await parse(await compileToBpmn(specTodosOsTipos()));
    const elementos = definitions.get('rootElements')[0].get('flowElements');
    const buscar = (id: string) => elementos.find((e: { id: string }) => e.id === id);

    assert.equal(buscar('espera_tempo').get('eventDefinitions')[0].$type, 'bpmn:TimerEventDefinition');
    assert.equal(buscar('espera_msg').get('eventDefinitions')[0].$type, 'bpmn:MessageEventDefinition');
  });

  test('o `detail` vira bpmn:Documentation, e o `name` continua o rotulo curto', async () => {
    // A caixa no desenho mostra so o `name`. O texto por extenso tem de
    // sobreviver no .bpmn — e o que o "Congelar versao" salva, e e de la que o
    // detalhamento sai para qualquer outra ferramenta BPMN.
    const spec = specSimples();
    const detalheEsperado = spec.nodes.find((n) => n.id === 'preencher')?.detail;
    assert.ok(detalheEsperado, 'a fixture precisa ter um no com `detail`');

    const { definitions } = await parse(await compileToBpmn(spec));
    const elementos = definitions.get('rootElements')[0].get('flowElements');
    const preencher = elementos.find((e: { id: string }) => e.id === 'preencher');

    assert.equal(preencher.get('name'), 'Preencher solicitacao');
    assert.equal(preencher.get('documentation')[0].text, detalheEsperado);

    // Sem `detail` nao inventamos documentacao vazia.
    const semDetalhe = elementos.find((e: { id: string }) => e.id === 'fim');
    assert.equal(semDetalhe.get('documentation').length, 0);
  });

  test('liga sourceRef/targetRef e preenche incoming/outgoing', async () => {
    const { definitions } = await parse(await compileToBpmn(specSimples()));
    const elementos = definitions.get('rootElements')[0].get('flowElements');
    const f1 = elementos.find((e: { id: string }) => e.id === 'f1');

    assert.equal(f1.get('sourceRef').id, 'inicio');
    assert.equal(f1.get('targetRef').id, 'preencher');

    const preencher = elementos.find((e: { id: string }) => e.id === 'preencher');
    assert.deepEqual(
      preencher.get('incoming').map((f: { id: string }) => f.id),
      ['f1'],
    );
    assert.deepEqual(
      preencher.get('outgoing').map((f: { id: string }) => f.id),
      ['f2'],
    );
  });

  test('condicao textual vira conditionExpression', async () => {
    const { definitions } = await parse(await compileToBpmn(specTodosOsTipos()));
    const elementos = definitions.get('rootElements')[0].get('flowElements');
    const f16 = elementos.find((e: { id: string }) => e.id === 'f16');

    assert.equal(f16.get('name'), 'Sim');
    assert.equal(f16.get('conditionExpression').get('body'), 'ok');
  });

  test('flow sem condicao nao ganha conditionExpression vazia', async () => {
    const { definitions } = await parse(await compileToBpmn(specSimples()));
    const elementos = definitions.get('rootElements')[0].get('flowElements');
    const f1 = elementos.find((e: { id: string }) => e.id === 'f1');
    assert.equal(f1.get('conditionExpression'), undefined);
  });
});

describe('compileToBpmn — guardas', () => {
  test('falha alto se um flow referenciar no inexistente', async () => {
    // A validacao (nivel 1) ja teria barrado; se chegou aqui, e bug nosso e o
    // certo e explodir, nao emitir um BPMN silenciosamente incompleto.
    const spec = specSimples();
    spec.flows[0]!.target = 'nao_existe';
    await assert.rejects(() => compileToBpmn(spec), /nao existe|inexistente/i);
  });
});
