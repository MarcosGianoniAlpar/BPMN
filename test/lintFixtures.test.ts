import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
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
} from './fixtures.js';

/**
 * Nivel 2 de validacao (bpmnlint) sobre o BPMN que o pipeline realmente produz —
 * compilado, posicionado e colorido, pelas duas rotas de layout.
 *
 * POR QUE ISTO EXISTE: os testes de `laneLayout` conferem geometria peca por
 * peca; este confere o desenho inteiro com as regras do BPMN. Um `error` de lint
 * aqui normalmente significa bug no compilador, e e o tipo de coisa que passava
 * batido — os dois bugs da Task L atravessaram a suite toda sem um aviso.
 *
 * O que ele NAO cobre: sobreposicao de ROTULO de aresta. O bpmnlint olha formas,
 * nao `bpmndi:BPMNLabel` — o L1 nao dispara regra nenhuma aqui, e a rede dele
 * continua sendo `paresSobrepostos` em `laneLayout.test.ts`.
 *
 * Companheiro deste arquivo: `npm run fixtures:bpmn`, que grava os mesmos
 * diagramas em `output/fixtures/` para serem olhados como imagem.
 */

/** Mesma bifurcacao do orchestrator: com raias, geometria propria. */
async function desenhar(spec: ProcessSpec): Promise<string> {
  const comRaias = (spec.lanes?.length ?? 0) > 0;
  const xml = comRaias
    ? await compileAndLayoutWithLanes(spec)
    : await applyLayout(await compileToBpmn(spec)).then((r) => r.xml);
  return colorizeBpmn(xml);
}

const TODAS: [string, ProcessSpec][] = [
  ['simples', specSimples()],
  ['com-raias', specComRaias()],
  ['com-loop', specComLoop()],
  ['faixa-de-valor', specFaixaDeValor()],
  ['ponte-cortada', specComPonteCortada()],
  ['todos-os-tipos', specTodosOsTipos()],
];

describe('lintBpmn — o relatorio nao pode depender de quantas vezes rodou', () => {
  test('lintar o MESMO XML quatro vezes da o mesmo resultado', async () => {
    // Bug real, achado por acidente ao escrever o teste seguinte: `lintBpmn`
    // guardava a instancia de `Linter` num cache de modulo, e as regras do
    // bpmnlint acumulam estado por instancia. Lintando o mesmo diagrama de 2
    // fluxos quatro vezes saiam 0, 6, 2 e 2 achados de
    // `no-duplicate-sequence-flows` — todos de categoria `error`.
    //
    // O CLI escapava (um lint por processo), mas `npm run web` e um processo
    // longo e a lambda do Vercel fica quente: da SEGUNDA geracao em diante o
    // especialista via erros de fluxo duplicado inexistentes, e um `error` de
    // lint aqui e justamente o sinal de "bug no compilador, va olhar".
    const xml = await desenhar(specSimples());

    const primeiro = await lintBpmn(xml);
    for (let i = 2; i <= 4; i++) {
      const atual = await lintBpmn(xml);
      assert.deepEqual(atual, primeiro, `a ${i}a passada divergiu da 1a`);
    }
    // E o diagrama simples nao tem defeito nenhum a reportar.
    assert.deepEqual(primeiro.issues, []);
  });

  test('a ordem das fixtures nao muda o resultado de nenhuma', async () => {
    // O mesmo bug por outro angulo: se sobrar estado entre chamadas, lintar
    // outros diagramas ANTES muda o relatorio deste.
    const alvo = await desenhar(specFaixaDeValor());
    const sozinho = await lintBpmn(alvo);

    for (const [, spec] of TODAS) await lintBpmn(await desenhar(spec));
    const depoisDeTodos = await lintBpmn(alvo);

    assert.deepEqual(depoisDeTodos, sozinho);
  });
});

describe('bpmnlint sobre as fixtures', () => {
  test('nenhuma forma se sobrepoe em nenhuma fixture', async () => {
    // `no-overlapping-elements` foi quem acusou o bug da altura fixa de raia
    // (duas tarefas de 80px dividindo uma faixa de 130 em fatias de 65). E a
    // unica regra do bpmnlint que fala de geometria, e por isso vale sozinha.
    for (const [nome, spec] of TODAS) {
      const { issues } = await lintBpmn(await desenhar(spec));
      const sobreposicoes = issues.filter((i) => i.rule === 'no-overlapping-elements');
      assert.deepEqual(sobreposicoes, [], `${nome} tem forma sobreposta`);
    }
  });

  test('so a fixture da ponte cortada produz erro de lint — e sao os dois esperados', async () => {
    // `specComPonteCortada` modela DE PROPOSITO um processo em que a validacao
    // reparavel descartou a ponte: `triagem` fica sem saida e `conferir` sem
    // entrada. O lint reportar isso e o comportamento correto, e o desenho
    // continua saindo — que e o ponto de reparar em vez de abortar.
    //
    // Este teste tambem serve de canario: `lintBpmn` e best-effort e devolve
    // vazio se o bpmnlint nao carregar. Exigir estes dois erros garante que o
    // linter ROUDOU, senao o teste de sobreposicao acima passaria vazio e mudo.
    const esperados = new Map([
      ['ponte-cortada', ['no-implicit-end/triagem', 'no-implicit-start/conferir']],
    ]);

    for (const [nome, spec] of TODAS) {
      const { issues } = await lintBpmn(await desenhar(spec));
      const erros = issues
        .filter((i) => i.category === 'error')
        .map((i) => `${i.rule}/${i.id}`)
        .sort();
      assert.deepEqual(erros, esperados.get(nome) ?? [], `erros de lint em ${nome}`);
    }
  });
});
