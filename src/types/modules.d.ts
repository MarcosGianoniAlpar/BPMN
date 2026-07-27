/**
 * Declaracoes minimas para bibliotecas do ecossistema bpmn.io que nao
 * publicam tipos completos. Mantemos o suficiente para o uso na Fase 1.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

declare module 'bpmn-moddle' {
  export interface ModdleElement {
    [key: string]: any;
    get(name: string): any;
    set(name: string, value: unknown): void;
  }

  export interface ToXmlOptions {
    format?: boolean;
    preamble?: boolean;
  }

  export default class BpmnModdle {
    constructor(packages?: Record<string, unknown>, options?: Record<string, unknown>);
    create(type: string, attrs?: Record<string, unknown>): ModdleElement;
    toXML(
      element: ModdleElement,
      options?: ToXmlOptions,
    ): Promise<{ xml: string }>;
    fromXML(
      xml: string,
      typeName?: string,
    ): Promise<{ rootElement: ModdleElement; warnings: unknown[] }>;
  }
}

declare module 'bpmn-auto-layout' {
  // v0.4.x retorna o XML ja com layout como string.
  export function layoutProcess(xml: string): Promise<string>;
}
