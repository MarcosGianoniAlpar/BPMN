import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, type EffortLevel, type ThinkingMode } from '../src/config.js';
import { thinkingParam, outputConfigParam, descreverThinking } from '../src/aiThinking.js';

/**
 * As flags `AI_THINKING` e `AI_EFFORT` existem para trocar as duas alavancas de
 * custo sem commit — quem paga a conta inverte e roda. Estes testes existem
 * porque o custo de um erro aqui e uma geracao paga: um typo que caisse no
 * silencio faria a rodada de teste acontecer no nivel errado, e ninguem saberia.
 */

const ORIGINAL_THINKING = process.env.AI_THINKING;
const ORIGINAL_EFFORT = process.env.AI_EFFORT;
const TINHA_CHAVE = 'ANTHROPIC_API_KEY' in process.env;

beforeEach(() => {
  // loadConfig() falha cedo sem a chave; aqui so interessa o parsing das flags.
  process.env.ANTHROPIC_API_KEY ??= 'sk-ant-teste';
});

afterEach(() => {
  if (ORIGINAL_THINKING === undefined) delete process.env.AI_THINKING;
  else process.env.AI_THINKING = ORIGINAL_THINKING;
  if (ORIGINAL_EFFORT === undefined) delete process.env.AI_EFFORT;
  else process.env.AI_EFFORT = ORIGINAL_EFFORT;
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

describe('AI_EFFORT', () => {
  test('sem a variavel, o padrao e high', () => {
    // `high` e o que a API assume quando o campo e omitido — que era o
    // comportamento do projeto antes de `output_config` existir aqui. O padrao
    // preserva isso: subir o SDK nao muda o custo em silencio.
    delete process.env.AI_EFFORT;
    assert.equal(loadConfig().effort, 'high');
  });

  test('variavel vazia tambem cai no padrao', () => {
    process.env.AI_EFFORT = '';
    assert.equal(loadConfig().effort, 'high');
  });

  test('aceita os cinco niveis da API', () => {
    for (const nivel of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
      process.env.AI_EFFORT = nivel;
      assert.equal(loadConfig().effort, nivel);
    }
  });

  test('valor invalido EXPLODE em vez de virar o padrao em silencio', () => {
    // Um typo cairia em `high` — o nivel mais caro dos usados — e a rodada de
    // teste que se queria fazer em `medium` nunca teria acontecido, depois de paga.
    process.env.AI_EFFORT = 'hight';
    assert.throws(() => loadConfig(), /AI_EFFORT invalido.*hight/s);
  });
});

describe('thinkingParam e outputConfigParam', () => {
  const config = (thinking: ThinkingMode, effort: EffortLevel = 'high') =>
    ({ thinking, effort }) as unknown as Parameters<typeof thinkingParam>[0];

  test('disabled vira { type: "disabled" }', () => {
    assert.deepEqual(thinkingParam(config('disabled')), { type: 'disabled' });
  });

  test('adaptive vira { type: "adaptive" }', () => {
    // O SDK 0.115 tipa `adaptive`; ate o 0.68 isto passava por um cast.
    assert.deepEqual(thinkingParam(config('adaptive')), { type: 'adaptive' });
  });

  test('o effort vai DENTRO de output_config, nao na raiz', () => {
    // Na raiz da requisicao o campo e ignorado em silencio e a chamada roda em
    // `high` como se nada tivesse sido pedido — o pior tipo de erro aqui.
    assert.deepEqual(outputConfigParam(config('disabled', 'medium')), { effort: 'medium' });
  });

  test('o modo adaptive avisa que gasta tokens, e o log mostra o effort', () => {
    // Com `display: "omitted"` (o padrao) os blocos de thinking voltam vazios: o
    // gasto e invisivel. O aviso no log e a unica pista antes da fatura.
    assert.match(descreverThinking(config('adaptive')), /fatura/);
    assert.doesNotMatch(descreverThinking(config('disabled')), /fatura/);
    assert.match(descreverThinking(config('disabled', 'low')), /effort: low/);
  });
});
