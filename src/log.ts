/**
 * Log de requisicoes do backend. Uma linha por chamada, no stdout — que e o que
 * o `npm run web` mostra no terminal e o que o Vercel coleta em Runtime Logs.
 *
 * REGRA: nunca logar CONTEUDO. O que passa por aqui e ata de reuniao da empresa,
 * transcricao de gente falando e ProcessSpec de processo interno. O log registra
 * VOLUME (tamanho, contagem) e TEMPO, nunca o texto em si.
 *
 * O tempo e o dado mais util: e ele que diz quao perto do teto de 60s do Vercel
 * Hobby cada chamada de IA esta chegando, em vez de a gente supor.
 */

/** 200/404/... para respostas JSON; 'ok'/'erro' para respostas em streaming. */
export type ApiStatus = number | 'ok' | 'erro';

export interface ApiLogInput {
  method: string;
  route: string;
  status: ApiStatus;
  /** `Date.now()` do inicio da requisicao. */
  startedAt: number;
  /** Volume/contagem — nunca conteudo. Ex.: '30618 chars · 12 nós'. */
  detail?: string;
}

function humanizeMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

export function logApi({ method, route, status, startedAt, detail }: ApiLogInput): void {
  const parts = [
    '[api]',
    new Date().toISOString(),
    method,
    route,
    String(status),
    humanizeMs(Date.now() - startedAt),
  ];
  if (detail) parts.push(`· ${detail}`);
  console.log(parts.join(' '));
}

/** Atalho para as rotas que respondem JSON: mede, responde e loga. */
export function timed(method: string, route: string): {
  startedAt: number;
  done: (status: ApiStatus, detail?: string) => void;
} {
  const startedAt = Date.now();
  return {
    startedAt,
    done: (status, detail) => logApi({ method, route, status, startedAt, detail }),
  };
}
