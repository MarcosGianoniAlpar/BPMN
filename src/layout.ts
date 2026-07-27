import { layoutProcess } from 'bpmn-auto-layout';

export interface LayoutResult {
  xml: string;
  warnings: unknown[];
}

/**
 * Aplica layout automatico (posicoes, dimensoes, waypoints) ao BPMN XML.
 *
 * IMPORTANTE: o bpmn-auto-layout trabalha em modo greenfield — ele SUBSTITUI
 * qualquer geometria existente. Por isso roda uma unica vez, logo apos a
 * compilacao e ANTES de qualquer edicao manual no bpmn-js. Regerar o layout
 * depois apagaria os ajustes do usuario: nesse caso, crie uma nova versao.
 */
export async function applyLayout(semanticXml: string): Promise<LayoutResult> {
  // v0.4.x devolve o XML como string; se falhar, lanca LayoutError.
  const xml = await layoutProcess(semanticXml);
  return { xml, warnings: [] };
}
