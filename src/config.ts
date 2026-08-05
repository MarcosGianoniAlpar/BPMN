import 'dotenv/config';

/** Configuracao central lida do ambiente (.env). Falha cedo se algo essencial faltar. */
export interface AppConfig {
  anthropicApiKey: string;
  model: string;
  maxOutputTokens: number;
  /** Ver src/aiThinking.ts: e uma alavanca de qualidade E de custo. */
  thinking: ThinkingMode;
  /** Ver src/aiThinking.ts: a alavanca de custo mais direta que existe. */
  effort: EffortLevel;
  rateLimit: RateLimitConfig;
}

/**
 * `disabled` = sem raciocinio (mais barato e mais rapido, mas a referencia da
 * API diz que o Sonnet 5 puxa MENOS as ferramentas assim). `adaptive` = o modelo
 * decide quanto pensar; no Sonnet 5 e o unico modo "ligado" que existe.
 */
export type ThinkingMode = 'disabled' | 'adaptive';

/**
 * Quanto o modelo se esforca — pensa e age — antes de responder. O padrao da API
 * e `high`, que e o que este projeto vinha pagando por OMISSAO desde o comeco,
 * sem nunca ter sido escolhido.
 *
 * Referencia da API para o Sonnet 5, que e o que decide os numeros aqui: `medium`
 * rende aproximadamente o que o Sonnet 4.6 rendia em `high`, e `high` rende o que
 * o 4.6 rendia em `max`. Ou seja, a escala inteira desceu um degrau com o modelo
 * novo, e continuar em `high` e pagar por um degrau que talvez nao seja preciso.
 */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Teto de chamadas de IA. A app e publica e sem login: sem isso, quem tiver a URL
 * gasta a verba da empresa a vontade.
 *
 * Sao dois limites porque protegem de coisas diferentes: o por IP contem o abuso
 * de um visitante, e o global e o que de fato limita a FATURA — trocar de IP e
 * trivial, e sem o teto global o limite por IP nao poe teto em gasto nenhum.
 */
export interface RateLimitConfig {
  perIpPerHour: number;
  globalPerDay: number;
}

/**
 * Le `AI_THINKING`. Valor desconhecido NAO cai no silencio: um typo
 * (`AI_THINKING=enabled`, que nem existe mais no Sonnet 5) viraria "disabled"
 * sem aviso, e o teste que se queria fazer nunca teria acontecido — depois de
 * pagar a geracao.
 */
function lerThinking(valor: string | undefined): ThinkingMode {
  if (valor === undefined || valor === '') return 'disabled';
  if (valor === 'disabled' || valor === 'adaptive') return valor;
  throw new Error(
    `AI_THINKING invalido: "${valor}". Use "disabled" ou "adaptive". ` +
      '(O modo "enabled"/budget_tokens foi removido no Sonnet 5 e devolve erro 400.)',
  );
}

/**
 * Le `AI_EFFORT`. Explode em valor invalido pelo mesmo motivo do `AI_THINKING`:
 * um typo (`AI_EFFORT=hight`) cairia no padrao e a rodada de teste aconteceria no
 * nivel errado, depois de paga.
 *
 * O padrao e `high` DE PROPOSITO, e nao `medium`: `high` e o que a API usa quando
 * o campo e omitido, que e exatamente o que este projeto fazia antes deste commit.
 * Ou seja, o padrao mantem o comportamento atual e o upgrade nao muda nada em
 * silencio. Descer para `medium` e uma decisao a tomar olhando o resultado, nao um
 * efeito colateral de subir o SDK.
 */
function lerEffort(valor: string | undefined): EffortLevel {
  if (valor === undefined || valor === '') return 'high';
  if ((EFFORT_LEVELS as readonly string[]).includes(valor)) return valor as EffortLevel;
  throw new Error(
    `AI_EFFORT invalido: "${valor}". Use um de: ${EFFORT_LEVELS.join(', ')}.`,
  );
}

export function loadConfig(): AppConfig {
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicApiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY nao definida. Copie .env.example para .env e preencha.',
    );
  }

  return {
    anthropicApiKey,
    model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-5',
    // O antigo teto de 21333 era do SDK, NAO do modelo: numa chamada
    // nao-streaming ele recusa na hora qualquer `max_tokens` que estime levar
    // mais de 10 min ("Streaming is required for operations that may take
    // longer than 10 minutes"). Com 32000 aqui, toda chamada morria em 2ms.
    //
    // As tres chamadas de IA agora usam `client.messages.stream()`, entao esse
    // teto sumiu — o limite passa a ser o do modelo: 128000 no Sonnet 5.
    //
    // 64000 e metade disso, de proposito. `max_tokens` so limita (paga-se pelos
    // tokens gerados), mas mais tokens = chamada mais LENTA (~130 tokens/s):
    // 64000 ja seriam ~8 min, e o Vercel Hobby corta em 60s. Documento grande
    // roda local. Ao mexer aqui, olhe o tempo no log [api].
    //
    // Referencia: a ata de PO (22965 chars) foi cortada em 20000 tokens de
    // saida; com 64000 ela cabe com folga.
    maxOutputTokens: Number(process.env.MAX_OUTPUT_TOKENS ?? '64000'),
    thinking: lerThinking(process.env.AI_THINKING),
    effort: lerEffort(process.env.AI_EFFORT),
    rateLimit: {
      // Folgado para o especialista iterando num documento, apertado para quem
      // quiser rodar a app em loop. 0 desliga o limite.
      perIpPerHour: Number(process.env.RATE_LIMIT_PER_IP_HOUR ?? '20'),
      // ~US$ 0,20 por geracao => 150/dia e da ordem de US$ 30/dia no pior caso.
      // Ajuste conforme o que a empresa aceita perder num dia ruim.
      globalPerDay: Number(process.env.RATE_LIMIT_GLOBAL_PER_DAY ?? '150'),
    },
  };
}
