# Regras de mapeamento ProcessSpec → BPMN

Referencia das transformacoes aplicadas por `src/compiler.ts`. O mapeamento e
**deterministico**: dado o mesmo ProcessSpec, o mesmo BPMN sai. A LLM nunca
decide estrutura BPMN — no maximo sugere um `type`, que a validacao confere.

## Nos (`node.type` → elemento BPMN)

| ProcessSpec | BPMN | Observacao |
|---|---|---|
| `start_event` | `bpmn:StartEvent` | exatamente um por processo |
| `end_event` | `bpmn:EndEvent` | ao menos um |
| `user_task` | `bpmn:UserTask` | acao humana |
| `service_task` | `bpmn:ServiceTask` | acao automatica de sistema |
| `exclusive_gateway` | `bpmn:ExclusiveGateway` | decisao mutuamente exclusiva |

## Fluxos

| ProcessSpec | BPMN |
|---|---|
| `flow` | `bpmn:SequenceFlow` (`sourceRef`/`targetRef` por referencia de objeto) |
| `flow.name` | atributo `name` do sequence flow |
| `flow.condition` | `bpmn:FormalExpression` em `conditionExpression` |

Cada no recebe `incoming`/`outgoing` apontando para os sequence flows — ajuda o
auto-layout e mantem o XML consistente.

## Organizacao e raias (Fase 1)

Decisao importante do MVP: **nao emitimos lanes nem pools no BPMN.** O
`bpmn-auto-layout` atual (1.x) nao gera DI para lanes/pools; um `laneSet` sem DI
falha na regra `no-bpmndi` do bpmnlint e atrapalha o bpmn-js. Entao:

| ProcessSpec | BPMN (Fase 1) | Observacao |
|---|---|---|
| `lanes[]` | — (nao emitido) | membership preservada no `*.process-spec.json` |
| `node.lane_id` | — (nao emitido) | idem; disponivel para a UI e para a Fase 2 |
| `participants` (internos/externos) | — (nao emitido) | registrados so no ProcessSpec |

O diagrama da Fase 1 e um **processo plano**, valido e lint-clean. Faixas de
raia e pools entram na Fase 2 — exigem DI de lane gerado a mao ou um layout
ciente de raias. No compilador, isso esta atras da flag `EMIT_LANE_SET`
(`src/compiler.ts`), hoje `false`.

## Geometria

O compilador **nao** gera DI (posicoes). Isso e responsabilidade do
`bpmn-auto-layout` (`src/layout.ts`), que roda uma unica vez, logo apos a
compilacao. Ver a nota sobre modo greenfield em `layout.ts`.
