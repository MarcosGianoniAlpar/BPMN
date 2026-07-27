/**
 * Declaracoes minimas para o bpmnlint (o pacote nao publica tipos). Cobre so o
 * que usamos em src/lintBpmn.ts: a classe Linter e o node-resolver.
 */
declare module 'bpmnlint' {
  interface LinterOptions {
    config: unknown;
    resolver: unknown;
  }
  export class Linter {
    constructor(options: LinterOptions);
    lint(moddleRoot: unknown): Promise<Record<string, unknown[]>>;
  }
}

declare module 'bpmnlint/lib/resolver/node-resolver.js' {
  export default class NodeResolver {
    constructor();
  }
}
