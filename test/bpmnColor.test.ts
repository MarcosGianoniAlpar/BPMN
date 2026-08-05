import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { colorizeBpmn, SHAPE_COLORS } from '../src/bpmnColor.js';
import { NODE_TYPE_TO_BPMN } from '../src/bpmnNodes.js';
import { compileAndLayoutWithLanes } from '../src/laneLayout.js';
import { specComRaias } from './fixtures.js';

const COLOR_NS = 'http://www.omg.org/spec/BPMN/non-normative/color/1.0';

async function bpmnColorido(): Promise<string> {
  return colorizeBpmn(await compileAndLayoutWithLanes(specComRaias()));
}

describe('SHAPE_COLORS', () => {
  test('todo elemento que o compilador gera tem cor na paleta', () => {
    // Irmao do teste "todo tipo do schema tem traducao para BPMN": la se garante
    // que o tipo novo e DESENHADO, aqui que ele e desenhado COLORIDO. Um tipo
    // sem cor nao quebra nada — so aparece preto-e-branco no meio da paleta.
    for (const elemento of new Set(Object.values(NODE_TYPE_TO_BPMN))) {
      assert.ok(SHAPE_COLORS[elemento], `"${elemento}" nao tem cor em SHAPE_COLORS`);
    }
  });
});

describe('colorizeBpmn', () => {
  test('declara o namespace padrao "BPMN in Color"', async () => {
    // Precisa ser o namespace da OMG, que o bpmn-js le nativamente — cor via CSS
    // no front nao sobreviveria ao .bpmn/SVG exportado.
    assert.ok((await bpmnColorido()).includes(COLOR_NS));
  });

  test('pinta as formas e as arestas', async () => {
    const xml = await bpmnColorido();
    assert.match(xml, /color:background-color=/);
    assert.match(xml, /color:border-color=/);
  });

  test('nao quebra a estrutura do diagrama', async () => {
    const antes = await compileAndLayoutWithLanes(specComRaias());
    const depois = await colorizeBpmn(antes);

    for (const marca of ['BPMNDiagram', 'BPMNPlane', 'BPMNShape', 'BPMNEdge']) {
      assert.ok(depois.includes(marca), `sumiu ${marca} depois de colorir`);
    }
    // O mesmo numero de formas entra e sai.
    const conta = (s: string, re: RegExp) => s.match(re)?.length ?? 0;
    assert.equal(
      conta(depois, /<bpmndi:BPMNShape/g),
      conta(antes, /<bpmndi:BPMNShape/g),
    );
  });

  test('preserva o case das tags de DI', async () => {
    // Regressao: usar xml:{tagAlias:'lowerCase'} na extensao moddle de cor
    // serializava "bpmndi:bPMNShape" e quebrava o render inteiro no bpmn-js.
    const xml = await bpmnColorido();
    assert.ok(!/bpmndi:b[A-Z]/.test(xml), 'tag de DI serializada com case errado');
    assert.match(xml, /<bpmndi:BPMNShape/);
  });

  test('XML invalido devolve a entrada intacta (a cor e cosmetica)', async () => {
    // Nao vale derrubar uma geracao ja paga por causa de cor.
    const lixo = 'isto nao e xml <<<';
    assert.equal(await colorizeBpmn(lixo), lixo);
  });

  test('e idempotente', async () => {
    const uma = await bpmnColorido();
    const duas = await colorizeBpmn(uma);
    assert.equal(duas, uma);
  });
});
