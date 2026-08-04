import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { thinkingParam, descreverThinking } from '../src/aiThinking.js';

/**
 * A flag `AI_THINKING` existe para trocar o modo de raciocinio sem commit — quem
 * paga a conta inverte e roda. Estes testes existem porque o custo de um erro
 * aqui e uma geracao paga: um typo que caisse no silencio faria a rodada de
 * teste acontecer no modo errado, e ninguem saberia.
 */

const ORIGINAL = process.env.AI_THINKING;
const TINHA_CHAVE = 'ANTHROPIC_API_KEY' in process.env;

beforeEach(() => {
  // loadConfig() falha cedo sem a chave; aqui so interessa o parsing da flag.
  process.env.ANTHROPIC_API_KEY ??= 'sk-ant-teste';
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.AI_THINKING;
  else process.env.AI_THINKING = ORIGINAL;
  if (!TINHA_CHAVE) delete process.env.ANTHROPIC_API_KEY;
});

describe('AI_THINKING', () => {
  test('sem a variavel, o padrao e disabled', () => {
    delete process.env.AI_THINKING;
    assert.equal(loadConfig().thinking, 'disabled');
  });

  test('variavel vazia tambem cai no padrao', () => {
    // `AI_THINKING=` no .env chega como string vazia, nao como undefined.
    process.env.AI_THINKING = '';
    assert.equal(loadConfig().thinking, 'disabled');
  });

  test('aceita adaptive', () => {
    process.env.AI_THINKING = 'adaptive';
    assert.equal(loadConfig().thinking, 'adaptive');
  });

  test('valor invalido EXPLODE em vez de virar o padrao em silencio', () => {
    // `enabled` e o caso realista: era o modo antigo, foi removido no Sonnet 5 e
    // hoje devolve 400. Cair no padrao aqui seria pior do que falhar — a rodada
    // de teste rodaria com o thinking desligado sem ninguem perceber.
    process.env.AI_THINKING = 'enabled';
    assert.throws(() => loadConfig(), /AI_THINKING invalido.*enabled/s);
  });
});

describe('thinkingParam', () => {
  const config = (thinking: 'disabled' | 'adaptive') =>
    ({ thinking }) as unknown as Parameters<typeof thinkingParam>[0];

  test('disabled vira { type: "disabled" }', () => {
    assert.deepEqual(thinkingParam(config('disabled')), { type: 'disabled' });
  });

  test('adaptive vira { type: "adaptive" } apesar do tipo antigo do SDK', () => {
    // O SDK 0.68 so tipa `enabled | disabled`; `adaptive` passa por um cast em
    // src/aiThinking.ts. Este teste garante que o cast nao vira outra coisa.
    assert.deepEqual(thinkingParam(config('adaptive')), { type: 'adaptive' });
  });

  test('o modo adaptive avisa que gasta tokens', () => {
    // Com `display: "omitted"` (o padrao) os blocos voltam vazios: o gasto e
    // invisivel. O aviso no log e a unica pista antes da fatura.
    assert.match(descreverThinking(config('adaptive')), /fatura/);
    assert.doesNotMatch(descreverThinking(config('disabled')), /fatura/);
  });
});
