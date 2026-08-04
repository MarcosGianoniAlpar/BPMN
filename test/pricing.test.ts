import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { estimateCost, priceLabel, MODEL_PRICES } from '../src/pricing.js';

describe('estimateCost', () => {
  test('calcula entrada e saida pelo preco por 1M de tokens', () => {
    // Sonnet 5: US$3 entrada / US$15 saida por 1M.
    const c = estimateCost('claude-sonnet-5', 1_000_000, 1_000_000);
    assert.equal(c.inputCost, 3);
    assert.equal(c.outputCost, 15);
    assert.equal(c.totalCost, 18);
    assert.equal(c.known, true);
  });

  test('escala proporcionalmente em volumes realistas', () => {
    // Ordem de grandeza de uma geracao: ~20k entrada, ~9k saida.
    const c = estimateCost('claude-sonnet-5', 20_000, 9_000);
    assert.ok(Math.abs(c.totalCost - (0.06 + 0.135)) < 1e-9);
  });

  test('modelo desconhecido nao inventa custo', () => {
    // Importa que seja explicito: um custo chutado no painel "Uso & custo" seria
    // pior do que assumir que nao da para saber.
    const c = estimateCost('modelo-que-nao-existe', 1_000_000, 1_000_000);
    assert.deepEqual(c, { inputCost: 0, outputCost: 0, totalCost: 0, known: false });
  });

  test('zero token custa zero', () => {
    assert.equal(estimateCost('claude-sonnet-5', 0, 0).totalCost, 0);
  });
});

describe('priceLabel', () => {
  test('devolve o rotulo amigavel dos modelos conhecidos', () => {
    assert.equal(priceLabel('claude-sonnet-5'), 'Sonnet 5');
  });

  test('cai para o proprio id quando o modelo e desconhecido', () => {
    assert.equal(priceLabel('claude-do-futuro'), 'claude-do-futuro');
  });
});

describe('tabela de precos', () => {
  test('o modelo padrao do projeto esta precificado', () => {
    // Se alguem trocar o default em config.ts sem precificar, o painel de custo
    // passa a mostrar US$ 0,00 em silencio — que e o pior jeito de errar aqui.
    assert.ok(MODEL_PRICES['claude-sonnet-5'], 'claude-sonnet-5 precisa estar em MODEL_PRICES');
  });

  test('nenhum preco e negativo ou zerado', () => {
    for (const [modelo, preco] of Object.entries(MODEL_PRICES)) {
      assert.ok(preco.input > 0, `${modelo}: preco de entrada invalido`);
      assert.ok(preco.output > 0, `${modelo}: preco de saida invalido`);
      assert.ok(preco.label.length > 0, `${modelo}: sem rotulo`);
    }
  });
});
