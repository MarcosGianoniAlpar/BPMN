# Arquitetura — visao de destino e fases

Este repositorio implementa a **Fase 1 (MVP)** de um sistema maior. Aqui fica o
mapa de onde ela se encaixa. A arquitetura completa e a motivacao detalhada
estao no documento original `arquitetura_projeto_llm_bpmn.md` (fora do repo).

## Principio central (vale em todas as fases)

A LLM funciona como **analista de processos**, nunca como desenhista nem
serializador de XML. Ela produz o `ProcessSpec` — modelo intermediario com
evidencias e ambiguidades. Codigo deterministico faz o resto. Isso desacopla a
interpretacao probabilistica da geracao, e permite validar, testar, auditar e
trocar de modelo.

## Fase 1 — MVP (este repositorio)

Um unico runtime Node/TypeScript. Um documento por vez. Sem fila, sem OCR, sem
banco vetorial, sem Python. Elementos: start/end, user/service task, exclusive
gateway, sequence flow, lanes simples, pool caixa-preta externo. Perguntas de
esclarecimento resolvidas por humano.

Objetivo: **provar que a extracao e boa o suficiente para ser util**, barato.

## Fase 2 — Intermediario

Multiplos documentos (exige resolver contradicao entre fontes), pools reais,
parallel/inclusive gateways, timers, boundary events, message flows,
subprocessos, interface de perguntas amigavel, correcao automatica via JSON
Patch em vez de reenviar XML.

## Fase 3 — Completo

Separar API (Python/FastAPI) do BPMN Service (Node), fila (Cloud Tasks/Pub-Sub)
e workers, OCR, banco vetorial (se muitos documentos historicos), infra GCP
completa, observabilidade, comparacao de versoes e aprovacao colaborativa.

## Estados do processo (destino)

```
DRAFT_EXTRACTED → NEEDS_CLARIFICATION → SEMANTICALLY_VALID
  → BPMN_GENERATED → HUMAN_REVIEW → APPROVED
```

## Referencias

- `arquitetura_projeto_llm_bpmn.md` — arquitetura completa (documento original).
- Drakopoulos et al., "Do LLMs Speak BPMN?", Computation 2026, 14(1), 10.
- bpmn-moddle: https://github.com/bpmn-io/bpmn-moddle
- bpmn-auto-layout: https://github.com/bpmn-io/bpmn-auto-layout
- bpmnlint: https://github.com/bpmn-io/bpmnlint
