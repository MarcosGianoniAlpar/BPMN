# Avaliação (baseline de qualidade)

Aqui mora o conjunto de avaliação que responde a métrica mais importante do
projeto: **quanto o especialista precisou corrigir o que a IA gerou?**

## Como funciona

Para cada documento de teste, você guarda ao lado o `ProcessSpec` que considera
**correto** (revisado à mão). Depois compara a saída da LLM com esse esperado.

```
evaluations/
├── expected/
│   ├── <nome-do-doc>.process-spec.json   # o ProcessSpec CORRETO (revisado por voce)
│   └── ...
└── README.md
```

## Fluxo recomendado

1. Rode o pipeline sobre a ata real (CLI ou interface):
   ```bash
   npm run dev -- test-documents/<seu-doc>.md
   ```
   Isso gera `output/<seu-doc>.process-spec.json`.

2. **Revise à mão** esse JSON: corrija nomes, adicione o que faltou, remova o
   que sobrou, responda o que virou pergunta. O resultado corrigido é o
   "gabarito".

3. Salve o gabarito em `evaluations/expected/<seu-doc>.process-spec.json`.

4. Com alguns gabaritos prontos, rode o comparador automático:

   ```bash
   npm run eval              # roda a IA sobre cada doc e compara com o gabarito
   npm run eval -- --cached  # compara os output/*.process-spec.json já gerados (sem gastar IA)
   ```

## O que o comparador mede

A comparação é **estrutural** (não exige IDs nem texto idênticos — eles variam a
cada execução da IA). Ele alinha os nós previstos aos esperados por **tipo +
similaridade de nome** (tolerante à flexão do português) e reporta, por documento:

- **Nós** — precisão / recall / F1 (quantos nós certos a IA produziu, quantos
  faltaram, quantos inventou).
- **Fluxos** — precisão / recall / F1 das relações de ordem (source → target),
  já considerando o alinhamento de nós.
- **Perguntas** — quantas `unresolved_questions` previstas vs. esperadas.
- **bpmnlint** — erros/avisos (só no modo IA, que roda o pipeline completo).
- **faltou / sobrou** — a lista nomeada de nós que a IA errou (para inspeção).

O `score` por caso é a média dos F1 de nós e fluxos. Cada execução também grava
um relatório JSON versionável em `evaluations/reports/`, para acompanhar a
evolução ao longo do tempo e comparar modelos (Sonnet × Fable × Opus).

> O casamento por nome é uma heurística: revise as listas "faltou/sobrou" —
> perto do limiar, um sinônimo distante pode contar como nó faltando.

## Por que isso importa

Sem gabarito, "está bom o suficiente" vira opinião do dia. Com 3–5 gabaritos de
atas reais, toda troca de prompt ou de modelo (Sonnet × Fable × Opus) passa a
ser medível — é o que impede o projeto de regredir sem ninguém perceber.
