# To-do / Handoff — BPMN Pipeline

> **Cole este arquivo inteiro no início do chat novo.** Ele dá todo o contexto pra
> retomar sem reler o histórico. As **regras de trabalho** também estão no
> `CLAUDE.md` na raiz (carregado automaticamente).

---

## Regras de trabalho (seguir sempre)

1. **Fluxo git `dev` → `main`.** Nunca commitar/pushar direto no `main` (é PROD no
   Vercel, deploy automático). Trabalhar no branch **`dev`** (push gera Preview).
   Ir pra PROD (merge `dev`→`main`) **só com aprovação explícita**.
2. **Mostrar o diff/resumo ANTES de commitar.** Só commitar no `dev` após o ok.
3. **Consultar antes de gastar a API** (key é da **empresa**). Geração/refino/eval
   gastam (`npm run dev`, `npm run eval`, `/api/generate`, `/api/minutes`,
   `/api/refine`). Testes determinísticos (`npm test`, typecheck, lint, build)
   **não gastam** e podem rodar livres.

---

## Onde estamos

- **App no ar no Vercel**, repo `MarcosGianoniAlpar/BPMN` (time Alpar, plano
  **Hobby**). Arquitetura: estático (`public/`) + funções serverless (`api/`),
  banco **Supabase/Postgres**.
- Node/TypeScript, ESM (NodeNext). **Fonte da verdade = `ProcessSpec`** (Opção A).
  Dois caminhos de layout: com raias → `src/laneLayout.ts`; sem raias →
  `src/compiler.ts` + `bpmn-auto-layout` (orchestrator escolhe por `hasLanes`).
- **`dev` está à frente do `main`**: tem tool use, modo transcrição, rótulos,
  tipos de nó, teto de uso, custo à vista, e a suíte de testes + CI. Nada disso
  foi pra PROD ainda.

## Decisões travadas

- **Sem plano Pro no Vercel** por ora. Hobby capa em **60s** (`maxDuration=300` é
  capado; sobe sozinho se ativarem Pro).
- **Modelo fixo `claude-sonnet-5`** (sem evals / sem troca de modelo por ora).
- **Cadastro/login: NÃO agora** — o dono vai confirmar com o chefe.
- **O destino é sempre ServiceNow.** Os processos modelados aqui viram Flow
  Designer. Isso define a prioridade das features de BPMN (Task F): o que tem
  contraparte no ServiceNow vem primeiro. Ver a tabela de equivalência na Task G.
- **Idioma da saída SEGUE o documento de entrada** (decidido 2026-08-03). Não
  traduzir. Um seletor de idioma para exportação ficou **em aberto** — ver
  Backlog; a recomendação é traduzir na exportação, não guardar uma segunda
  versão, para não criar duas fontes da verdade.
- ~~Sem features novas de BPMN por enquanto~~ — **revertido em 2026-08-03**: a
  ata real de PO (`~/Downloads/ata_teste_automacao_PO.md`) mostrou que o subset
  atual não cobre um processo de verdade. Ver Task F.

---

## ✅ Concluído (não refazer)

- **SDK `@anthropic-ai/sdk` 0.68 → 0.115 + `AI_EFFORT`** (2026-08-05) — o salto de
  47 versões **não quebrou nada**: typecheck, typecheck:test, lint, 157 testes e
  `typecheck:vercel` passaram sem uma única mudança de código forçada.
  **Por que foi indolor** (conferido no código antes de subir, não depois): as três
  quebras que a versão nova traz são `temperature`/`top_p`/`top_k` (400 no
  Sonnet 5), `budget_tokens` (400) e prefill de turno `assistant` (400) — e o
  projeto **não usava nenhuma das três**. O cast de `adaptive` em
  `src/aiThinking.ts` saiu: o SDK novo tipa o modo.
  **O ganho:** `output_config: { effort }` nas três chamadas, configurável por
  `AI_EFFORT` (mesmo padrão do `AI_THINKING`: valor inválido **explode**).
  **O padrão é `high` de propósito, não `medium`** — `high` é o que a API assume
  quando o campo é omitido, ou seja, é o que o projeto já vinha pagando sem nunca
  ter escolhido. O padrão preserva o comportamento atual; descer é decisão de quem
  paga, não efeito colateral de um upgrade.
  **Onde procurar economia:** pela referência da API, `medium` no Sonnet 5 rende
  aproximadamente o que o Sonnet 4.6 rendia em `high` — a escala desceu um degrau
  com o modelo novo. **1 geração em `medium` decide.** E o ganho é multiplicado
  por ~7 quando a Task K chegar.
  Coberto por 5 testes novos, incluindo um que fixa que o `effort` vai **dentro**
  de `output_config`: na raiz da requisição ele é ignorado em silêncio e a chamada
  roda em `high` como se nada tivesse sido pedido.

- **Bug: o relatório do bpmnlint dependia de quantas vezes tinha rodado**
  (2026-08-05) — **achado por acidente**, escrevendo o teste de lint das
  fixtures. `src/lintBpmn.ts` guardava a instância de `Linter` num cache de
  módulo, e as regras do bpmnlint acumulam estado por instância. Lintando o
  **mesmo** diagrama de 2 fluxos quatro vezes saíam **0, 6, 2 e 2** achados de
  `no-duplicate-sequence-flows` — todos de categoria `error`. Com um `Linter`
  novo por chamada: 0 nas quatro. Isolado: o estado é do Linter, não do moddle.
  **Não era bug de teste, era de produção.** O CLI escapava (um lint por
  processo), mas `npm run web` é processo longo e a lambda do Vercel fica quente:
  **da 2ª geração em diante** o especialista via erros de fluxo duplicado que não
  existem — e como um `error` de lint aqui é o sinal de "bug no compilador, vá
  olhar", o aviso mandava caçar um defeito inexistente.
  Correção: o cache guarda uma **fábrica**, não o Linter; o módulo continua
  carregado uma vez só (o custo real está no cache do `require`) e a config é
  reparseada por chamada. Dois testes guardam: lintar o mesmo XML 4× dá o mesmo
  resultado, e a ordem das fixtures não muda o relatório de nenhuma.

- **Lint das fixtures + `npm run fixtures:bpmn`** (2026-08-05) — a parte
  automatizável da lição "exportar o PNG faz parte de validar".
  `test/lintFixtures.test.ts` roda o bpmnlint sobre o BPMN que o pipeline
  realmente produz — compilado, posicionado e colorido, **pelas duas rotas de
  layout** — e o script grava os mesmos diagramas em `output/fixtures/` para
  serem abertos.
  **O que ele provou:** `no-overlapping-elements` não dispara em nenhuma fixture
  (foi ele que acusou o bug da altura fixa de raia), e só a `ponte-cortada`
  produz erro — `no-implicit-end` em `triagem` e `no-implicit-start` em
  `conferir`, que é o **comportamento correto** para uma fixture que modela uma
  ponte descartada de propósito.
  **O que ele NÃO cobre, e é importante saber:** o bpmnlint olha **formas**, não
  `bpmndi:BPMNLabel`. Sobreposição de rótulo de aresta — o L1 — não dispara regra
  nenhuma; a única rede ali continua sendo `paresSobrepostos` em
  `laneLayout.test.ts`, e o olho.

- **M1 · integridade referencial** (2026-08-05) — a regra foi para **três**
  lugares, não só para os prompts: `schemas/process-spec.schema.json` (nas
  `description` de `nodes`, de `flows` e do `$defs.flow`), `extract-process.md`
  (regra 6 nova + a última linha, que é o que o modelo lê por último) e
  `refine-process.md` (regra 9 nova).
  **Por que também no schema:** o schema **é** a definição da ferramenta que o
  modelo lê, e este projeto já se queimou duas vezes com prompt e schema dizendo
  coisas diferentes (o verbo "-ar/-er/-ir", o `meeting.language`). Confirmado no
  código: `src/toolSchema.ts` inlina os `$ref` e faz os irmãos vencerem o alvo,
  então a `description` chega íntegra ao `input_schema`.
  **O que NÃO fazer:** `description` irmã de `$ref` em `source`/`target`. Testei —
  o `json2ts` inlina o tipo (`source: Id` vira `source: string`) e ainda descarta
  o texto em favor do `description` do próprio `Id`. Perde o tipo nomeado e não
  ganha nada; a `description` de `flows` já diz a mesma coisa.
  Coberto por 2 testes que guardam o **mecanismo** (o `input_schema` não tem
  `$ref` sobrando, e a instrução sobrevive ao achatamento) — não a prosa.
  **148 testes verdes.** Falta o que só uma rodada real diz: se o escorregão
  para de acontecer.

- **Os 5 blocos de 2026-08-04 foram commitados** (2026-08-05, commit `01d5990`) —
  eram ~1950 linhas em 35 arquivos modificados e 8 novos (`test/`, `.github/`,
  `src/aiThinking.ts`, `src/sizing.ts`, `scripts/backup-db.mjs`, `public/brand/`)
  vivendo só no disco. Antes do commit: typecheck + typecheck:test + lint +
  **139 testes verdes**. Era o item 0 da ordem recomendada: risco puro.

- **L1 · Rótulos de aresta empilhados** (2026-08-05) — `edgeLabel` em
  `src/laneLayout.ts` posicionava o rótulo no primeiro trecho depois da origem,
  e `routeEdge` faz **toda** saída partir da direita da origem na altura do
  centro. Ou seja: o primeiro trecho de todas as saídas de um mesmo gateway é
  idêntico. Com 2 ramos ainda dava certo; com 3+, os rótulos caíam exatamente
  uns sobre os outros — 16 rótulos e **14 pares sobrepostos** num diagrama sem
  defeito nenhum.
  **A correção:** os rótulos já colocados viajam numa lista, e quem colide sobe
  até acima do mais alto que ele encosta. Sobe, e não desce, porque logo abaixo
  está a própria linha da seta. Só quando a pilha chega ao topo do pool a direção
  inverte, para nada sair do desenho. Cada passo pula acima de todos os que tocou
  (não um degrau fixo), então nenhum já resolvido volta a colidir e o laço termina
  em no máximo um passo por rótulo posto.
  **Por que não foi resolvido "na rota":** deslocar ao longo do trecho não cabe —
  metade da coluna são ~80px e `"$5,000.01–$50,000"` mede ~117px. Levar o rótulo
  para o trecho vertical (onde os destinos se separam) o jogaria para o meio da
  aresta, que é justamente o que a decisão anterior tirou dali.
  Coberto por 3 testes + a fixture `specFaixaDeValor()` (a §3.1 da ata de PO, em
  inglês de propósito), e por um teste que varre **todas** as fixtures contando
  pares sobrepostos: tem de dar 0.

- **L2 · Nó órfão fora da camada 0** (2026-08-05) — `computeLayers` semeava só
  pelos `start_event` e jogava todo inalcançável na camada 0, a coluna da ponta
  esquerda. Como o fluxo que a validação reparável descarta costuma ser a
  **ponte** para o resto do processo, tudo a jusante virava órfão de uma vez:
  na rodada real, ~19 nós empilhados numa coluna só. **O estrago visual é ~3× o
  semântico.**
  **A correção,** em três camadas: (1) propaga a camada dos vizinhos que
  sobraram — `predecessor + 1`, e só na falta dele `sucessor − 1` —, iterando
  até estabilizar; (2) um fragmento **inteiramente** solto ganha um início
  próprio (sobe pelos predecessores sem camada) e se espalha em colunas, em vez
  de virar pilha na 0; (3) `sucessor − 1` pode dar camada negativa, então no fim
  tudo é deslocado para que a menor volte a ser 0 — a camada é relativa.
  A (2) é o que interessa ao **chunking**: com N chamadas, pedaço desconectado
  passa a ser comum, não excepcional.
  Só quem não tem vizinho nenhum continua indo para a coluna 0 — e isso está
  testado, junto com os outros três casos, e com a fixture
  `specComPonteCortada()`. **146 testes verdes.**

- **Validação reparável: defeito consertável deixou de abortar** (2026-08-04) —
  a mudança de maior impacto do dia. `validateProcessSpec` passou a devolver
  **`errors` (fatais) + `warnings` (reparados/tolerados)**, e muta `spec.flows`
  descartando os que apontam para nós inexistentes.
  **O caso:** o mesmo recorte rodou duas vezes; uma saiu perfeita, a outra veio
  com 8 fluxos apontando para 2 gateways que a IA esqueceu de declarar. 33 nós
  bons, e a geração inteira foi para o lixo por causa de 2 nós faltando. Das 5
  gerações do dia, **1 virou diagrama**; ~US$ 0,57 em abortos.
  **A régua:** fatal = quebra o XML (`SCHEMA`, `DUPLICATE_ID`). Reparável = o
  bpmn-js desenha assim mesmo e o especialista corrige no painel — fluxo órfão
  (descartado; o `compiler.ts` explodiria nele), nó solto, raia/participante
  inexistente, rótulo faltando em gateway condicional, e os dois do
  `event_based_gateway` — **revertendo** a decisão que eu mesmo tinha tomado
  horas antes de fazê-los fatais: BPMN inválido pelo padrão, sim, mas *renderiza*,
  e abortar troca um diagrama defeituoso por diagrama nenhum ao preço de uma
  geração.
  Os avisos chegam à tela (mesma caixa do bpmnlint) e ao CLI — reparo em silêncio
  seria pior que o aborto: o desenho pareceria fiel ao documento.
  Junto: `NODE_DISCONNECTED` virou **um** aviso resumido. Com `flows` vazio ele
  cuspia 56 linhas idênticas que enterravam o único fato que importava.
  Verificado reproduzindo os 11 defeitos exatos da rodada real: **sai diagrama
  com 11 avisos**.

- **`AI_THINKING` configurável + idioma da saída** (2026-08-04) — duas coisas que
  precisavam existir **antes** da próxima geração paga.
  **(a) Flag `AI_THINKING=disabled|adaptive`** (`src/aiThinking.ts`, um lugar só
  para as 3 chamadas). O `disabled` fixo foi decidido quando `MAX_OUTPUT_TOKENS`
  era 20000 e o thinking comia o orçamento; com 64000 a conta mudou, e decidir
  entre os dois custa duas gerações — então virou flag. Um valor inválido
  **explode** em vez de cair no padrão (`AI_THINKING=enabled`, o modo removido no
  Sonnet 5, faria a rodada de teste acontecer no modo errado sem ninguém saber).
  O modo aparece na confirmação do CLI e no `> Modelo:` do log.
  **(b) Bug de idioma:** a ata de PO está em inglês e os rótulos saíram em
  português. A regra 5 do prompt manda seguir o documento, mas **o prompt inteiro
  está escrito em português** e o modelo seguiu o idioma da instrução. Agora os
  três prompts dizem explicitamente que o idioma *deles* não define o da saída, e
  a extração repete o lembrete **depois** do `<documento>` — última coisa que o
  modelo lê antes de responder.
  **Confirmado na referência da API** (não de memória): no Sonnet 5 `adaptive` é
  o único modo "ligado" (`budget_tokens` devolve 400); `tool_choice` forçado
  **+ thinking é válido na API direta** — só o Bedrock exige `disabled`; e o SDK
  0.68 não tipa `adaptive`, daí o cast confinado em `src/aiThinking.ts`.

- **Altura da raia deixou de ser fixa** (2026-08-04) — bug **pré-existente**,
  achado ao lintar o diagrama da F4/F6. `LANE_H = 130` não crescia com o número
  de nós que caem no mesmo par (raia, camada): duas tarefas de 80px dividiam a
  faixa em fatias de 65 e **se sobrepunham**, vazando para fora do pool. Reproduz
  com qualquer `parallel_gateway` que abra dois ramos na **mesma** raia — que é
  exatamente a §4 da ata de PO (orçamento e estoque checados juntos). Agora a
  altura de cada faixa vem do bucket mais cheio dela (`LANE_H_MIN = 130`,
  `NODE_SLOT_H = 100`) e o topo é acumulado, não `i * LANE_H`. No diagrama de
  teste: de 13 avisos do bpmnlint para 2 (e os 2 são forma da fixture, não
  geometria). Coberto por dois testes em `test/laneLayout.test.ts`.
- **F4 · `inclusive_gateway` e F6 · `event_based_gateway`** (2026-08-04) — as duas
  construções da tabela da Task F que **não dependem da Task I** e não custam
  geometria nova: gateway é losango 50×50 como os outros, o que muda é o símbolo
  desenhado dentro. Schema + `gen:types` + `bpmnNodes.ts` + `nodeSize` +
  `bpmnColor` + os dois prompts + `validate.ts` + fixtures. Duas regras novas de
  validação: (a) `inclusive_gateway` passou a exigir `condition`/`name` nas
  saídas, como o exclusivo — nos dois o caminho é condicional, o que muda é
  quantos seguem; (b) `event_based_gateway` exige ≥2 saídas apontando **direto**
  para `timer_event`/`message_event` (`EVENT_GATEWAY_SEM_CORRIDA` e
  `EVENT_GATEWAY_ALVO_INVALIDO`) — sem isso o BPMN sai inválido, que não é algo
  que o especialista conserte no painel.
  **`no-inclusive-gateway` foi desligado no `.bpmnlintrc`**: a regra vem do
  `bpmnlint:recommended` porque *motores de execução* BPMN tropeçam no join
  inclusivo. O destino aqui é o ServiceNow, e a ata de PO (§4) pede número
  variável de ramos explicitamente — deixar ligada seria o app avisar que o
  modelo certo está errado.
  Corrigido de quebra: o `description` do `name` no schema ainda mandava verbo
  "terminado em -ar/-er/-ir". Os prompts já tinham sido neutralizados em
  2026-08-03, o schema não — e o schema **é a definição da ferramenta que o
  modelo lê**, então com a ata em inglês as duas instruções se contradiziam.
  E `src/types/meeting-minutes.ts` estava **desatualizado** em relação ao schema
  (faltava `meeting.language`); o `gen:types` regenerou.
- **Rótulo curto na caixa + detalhe no painel** (2026-08-03) — `ProcessNode`
  ganhou `detail`. O `name` é o rótulo curto (verbo na forma infinitiva, ~30
  chars); o `detail` é a frase completa, lida no painel de elementos junto de
  **todas** as evidências. O `detail` também vira `bpmn:Documentation`, então
  sobrevive ao "Congelar versão" e viaja para outras ferramentas BPMN.
  Regra nos **dois** prompts (extração e refino) e no `description` do schema —
  que é o que vira a definição da ferramenta que o modelo lê.
  **Sem `maxLength` no schema de propósito:** o Ajv usa o mesmo arquivo, então um
  rótulo longo demais reprovaria uma geração já paga.
- **Idioma segue o documento** (2026-08-03) — antes, `transcript-to-minutes.md`
  forçava português e `extract-process.md` não dizia nada (indefinido). Agora
  ambos seguem a entrada. Como os títulos da ata são escritos por código,
  `MeetingMinutes` ganhou `meeting.language` (ISO 639-1) e
  `src/minutesMarkdown.ts` tem dicionários PT/EN, **com fallback para PT** —
  atas antigas sem o campo renderizam idênticas. A regra do verbo ficou neutra
  de idioma (a 1ª versão dizia "-ar/-er/-ir", que quebraria em inglês).
- **Logos oficiais da Alpar** (2026-08-03) — `public/brand/alpar-colorido.png`
  (fundo claro) e `alpar-branco.png` (fundo escuro), cropados do padding.
  O antigo `public/alpar-colorido.png` era **fora da marca** (círculos teal
  `#17a99b` em vez do ciano oficial `#009fe3`) e foi removido. Cores oficiais:
  marinho `#153f71`, ciano `#009fe3`. `.png` faltava no mapa MIME do dev server.
- **Rótulos do diagrama** — `bpmndi:BPMNLabel` com bounds próprios; o "Sim"/"Não"
  sai de cima da linha e fica junto do gateway. Coberto por teste.
- **Tipos de nó mais ricos** — `parallel_gateway`, `timer_event`, `message_event`
  no schema + `NODE_TYPE_TO_BPMN` (centralizado em `src/bpmnNodes.ts`) + prompt.
- **Custo sempre à vista** — badge no header + custo da geração no resultado.
- **Teto de uso / rate limit** — `RATE_LIMIT_PER_IP_HOUR` e
  `RATE_LIMIT_GLOBAL_PER_DAY`, contador na tabela `rate_limit` do Postgres
  (em serverless não dá contador em memória). O global é o que limita a fatura.
- **Extração/refino via tool use forçado** — some o erro de JSON malformado.
- **Modo transcrição** — transcrição crua → ata estruturada (IA) → Markdown
  (determinístico) → pipeline normal. **Duas chamadas separadas** de propósito:
  o especialista revisa a ata antes da segunda, e cada uma cabe nos 60s do Hobby.
- **Suíte de testes determinística + CI** — `npm test` (`node:test`, sem
  dependência nova) cobrindo validação, os dois compiladores, geometria do layout
  de raias, colorização, render da ata, limpeza de texto e custo. GitHub Actions
  roda typecheck + lint + testes + build em push e em PR pro `main`.
- **`npm run backup`** — `pg_dump` pela `DATABASE_URL` em `backups/` (o Supabase
  free não tem backup automático).
- **README, Dockerfile e docs atualizados** — o README dizia SQLite e listava
  como "fora de escopo" coisas já entregues.

---

## 🎯 As duas falhas da ata de PO — causa e estado

| # | erro | causa | estado |
|---|---|---|---|
| 1 | `/nodes must be array` (US$ 0,19) | o modelo devolveu `nodes` **num formato errado**. O bloco `tool_use` veio certo — o log confirma. A hipótese mais forte: o documento tem **6 processos** e o schema só aceita 1, então em vez de escolher um ele **agrupou** (`{aprovacao: [...], sourcing: [...]}`) | **contornado** — `normalizarColecoes` conserta as 3 formas erradas conhecidas e avisa. Correção de verdade = **Task I** |
| 2 | `max_tokens` (US$ 0,34) | `MAX_OUTPUT_TOKENS` era 20000 porque acima de ~21333 o **SDK** recusa chamada não-streaming. Não era limite do modelo: o Sonnet 5 faz **128000** | **resolvido** — as 3 chamadas usam `client.messages.stream()`; teto agora 64000 |

**A ata de PO cabe:** ~26k estimados contra 64000. O `sizing.ts` não emite mais aviso para ela.

**O que ainda não está resolvido** (nenhum é erro — são escopo e custo):

1. **Task I** — decidir (a) um spec com `processes[]` ou (b) uma versão por
   processo. Enquanto não decidir, um documento multi-processo continua saindo
   como um diagrama só, achatado. Trava F1/F2.
2. ~~**Subir o SDK 0.68 → 0.115**~~ — **✅ feito em 2026-08-05** (ver Concluído).
   O `effort` agora é `AI_EFFORT`, com padrão `high` = o comportamento anterior.
3. Só então **1 geração** com a ata de PO — e vale fazê-la já em `AI_EFFORT=medium`,
   para a mesma chamada responder as duas perguntas (qualidade da extração e se
   `medium` basta).

**Gasto até aqui:** US$ 2,26 em 22 chamadas, das quais **US$ 0,53 (≈23%) foram as
duas falhas** com a ata de PO — uma por forma, outra por teto. Ambas agora têm
guarda: `src/sizing.ts` avisa antes de gastar, e `normalizarColecoes` conserta as
formas erradas conhecidas.

**Nota de custo:** `src/pricing.ts` usa o preço de lista do Sonnet 5 (US$3/US$15).
O promocional (US$2/US$10) vale até **2026-08-31**, então a fatura real está
~33% abaixo do que o painel mostra. Conservador de propósito — não "consertar"
sem decidir.

---

## 🔢 Ordem recomendada (atualizada 2026-08-05)

O critério é **impacto ÷ custo**, com um desempate: o que melhora *todo* diagrama
vem antes do que melhora *um caso*.

| # | o que | custo | por que aqui |
|---|---|---|---|
| ~~0~~ | ~~Commitar os 5 blocos prontos no `dev`~~ | — | **✅ 2026-08-05** (`01d5990`) |
| ~~1~~ | ~~L1 · rótulos empilhados~~ | — | **✅ 2026-08-05** |
| ~~2~~ | ~~L2 · órfão fora da camada 0~~ | — | **✅ 2026-08-05** |
| ~~3~~ | ~~M1 · integridade referencial~~ | — | **✅ 2026-08-05**, e também no schema |
| ~~—~~ | ~~Task A · repo privado~~ | — | **Descartada em 2026-08-05:** decisão do dono é manter público ("preciso que o povo veja") |
| ~~4~~ | ~~SDK 0.68 → 0.115 + `AI_EFFORT`~~ | — | **✅ 2026-08-05**, sem uma quebra |
| **1** | **Olhar** os `.bpmn` do L1/L2 | ~15min, sem API | **Meio caminho andado:** `npm run fixtures:bpmn` já gravou os 6 diagramas em `output/fixtures/` e lintou. Falta o olho — arrastar `faixa-de-valor.bpmn` e `ponte-cortada.bpmn` no app, porque rótulo sobreposto o lint não pega |
| **2** | **Task N · `strict: true` no tool use** | ~1h + 1 geração | **Novo, e pode aposentar o `normalizarColecoes`.** Ver abaixo |
| **3** | **Ratificar a Task I** = `processes[]` no mesmo spec | decisão | Já é a recomendação escrita; falta o "sim". Trava K, F1 e F2 |
| **4** | **Task K · chunking** | dias | O que faz documento gigante funcionar. Ler antes "a forma da K", abaixo |
| **5** | **M2 · realimentar avisos no refino** | ~meio dia + 1 chamada | Conserta de verdade o que o M1 não evitar |
| 6 | F3 (boundary events), F5 (multi-instância), F1/F7 | — | Depois do K, na ordem da Task F |
| 7 | Task G (vocabulário ServiceNow), H, B, C, D, E | — | Como já estavam |

**Por que o SDK subiu na lista.** Estava classificado como "otimização de custo,
não corrige erro" — e isso era verdade **com uma chamada por documento**. A Task K
faz ~7 chamadas por documento, então o `effort: high` (que roda hoje por omissão,
o mais caro) passa a ser multiplicado por 7. Não gasta API para fazer, e agora há
148 testes guardando o salto de 47 versões.

**Por que o M1 antes da K não era só "é barato".** Hoje uma chamada erra e você
perde uma chamada. Com chunking, sair um conjunto completo é o **produto** das
taxas de acerto: a 80% cada, 6 extrações dão **26%**. Confiabilidade por chamada
deixa de ser incremental e passa a decidir se a K funciona.

### A forma da Task K — decidir ANTES da primeira linha de código

`/api/generate` hoje é **1 requisição = 1 pipeline = 1 chamada de IA** (conferido
em `src/httpHandlers.ts` e `api/generate.ts`). Se as N extrações rodarem dentro de
um `/api/generate`, são 6 × ~50s ≈ 300s e o Hobby corta em **60s** — mesmo com
cada chunk cabendo sozinho. Ou seja: o ganho principal da K (a ata de PO sair do
"só roda local") **só existe** se o chunking for N requisições dirigidas pelo
cliente:

```
POST /api/process-index   → lista de processos + faixas de seção  (~500 tokens)
POST /api/generate  ×N    → um processo por requisição
merge determinístico      → concatena, deduplica lanes/participants por nome
```

Isso muda a `store` (um projeto passa a ter **progresso parcial** — 4 de 6
processos prontos, e o que acontece se a 5ª falhar) e muda a tela. Desenhar depois
custa retrabalho nas duas.

**Duas coisas que a K cria e não estavam no plano:**
- **Agregar avisos e `unresolved_questions` das N chamadas.** 6× perguntas numa
  caixa só afoga o especialista — e o volume vai ser alto **de propósito**, porque
  muita pergunta em aberto é o comportamento certo.
- **Teto de custo por projeto**, não por chamada. Hoje o rate limit é por IP/hora
  e global/dia; quando um documento dispara 7 chamadas, a unidade de gasto deixa
  de ser a chamada.

**Ainda não validado no desenho:** L1 e L2 passam em 157 testes determinísticos e
o bpmnlint não acusa forma sobreposta em nenhuma fixture, mas **o desenho não foi
olhado como imagem** — e a própria Task L nasceu de dois bugs que nenhum log
pegou. Os arquivos já estão prontos: `npm run fixtures:bpmn` grava os 6 em
`output/fixtures/`; arraste `faixa-de-valor.bpmn` (gateway de 3 ramos, é o teste do
L1) e `ponte-cortada.bpmn` (o do L2) no app local ou no bpmn.io. Não gasta API.
**O bpmnlint não substitui esse olho:** ele valida FORMAS, não `bpmndi:BPMNLabel`
— rótulo sobreposto não dispara regra nenhuma lá.

---

## 📍 Onde paramos — 2026-08-05, fim do dia

**Estado do git:** branch `dev`, árvore limpa, **tudo empurrado** para
`origin/dev`. O `main` (PROD) continua parado em `b5e191b` — nada disso foi para
produção, e ir precisa de aprovação explícita.

Cinco commits no dia, nesta ordem:

| commit | o quê |
|---|---|
| `01d5990` | Os 5 blocos de 2026-08-04 que estavam **fora do git** (~1950 linhas) |
| `c66ea66` | **L1** rótulos de aresta empilhados + **L2** órfão fora da camada 0 |
| `4281122` | **M1** integridade referencial — no schema **e** nos dois prompts |
| `1d4f9e8` | Lint das fixtures + `npm run fixtures:bpmn`, **e o bug que ele achou no próprio lint** |
| `d2f5425` | **SDK 0.68 → 0.115** + `AI_EFFORT` (padrão `high` = comportamento anterior) |

Suíte: **139 → 157 testes**, 0 falhas. `typecheck`, `typecheck:test`, `lint` e
`typecheck:vercel` limpos em todos os commits.

**Nada gastou API hoje.** O gasto acumulado segue em US$ 2,26 / 22 chamadas.

**Retomar por aqui**, na ordem da tabela acima:

1. **Olhar os `.bpmn`** (~15min, grátis) — fecha o L1/L2. Arquivos já gerados.
2. **Task N · `strict: true`** (~1h grátis + 1 geração) — a metade grátis é podar
   `minLength`/`minItems`/`pattern` do schema que vai para a ferramenta, em
   `src/toolSchema.ts`, com teste fixando isso. **Antes de escrever código,
   resolver as duas incertezas de leitura** listadas na Task N — em especial se
   `strict` conversa com `tool_choice` forçado, porque se não, a task morre ali.
3. **Ratificar a Task I** — decisão do dono, e é o que destrava K, F1 e F2.
4. **Task K · chunking** — ler "a forma da K" antes da primeira linha de código.

**Se for gastar uma geração**, faça a da ata de PO já com `AI_EFFORT=medium`: uma
chamada responde duas perguntas de uma vez — se o M1 parou o escorregão dos
gateways intermediários, e se `medium` basta para este trabalho.

**Decisão pequena ainda aberta:** idioma das `unresolved_questions`. Hoje o
diagrama sai 100% no idioma do documento e as perguntas saem em português. Ou é
bug (a regra diz "tudo no idioma do documento") ou é o comportamento certo (as
perguntas são para o especialista, não para o cliente). A recomendação é
**mudar a regra**, não a saída — o que incomoda é a contradição.

## Pendências

> **As letras são só rótulos, não ordem.** A→E são as pendências antigas
> (pequenas e independentes). **I, F, G e H nascem da ata de PO** e estão nessa
> ordem de propósito: a **I** é decisão de formato e precisa vir antes da **F**.
> Juntas elas são **escopo de uma fase nova**, não o fim da Fase 2 — vale tratar
> como conversa de prazo, não como algo que entra no meio das outras.

### 💸 Validações reais (as únicas que gastam API) — **fazer antes de ir pra PROD**
Tudo abaixo já passou em validação determinística; falta a rodada real.

1. **Tool use na extração** — 1 geração com a **ata de mudanças emergenciais**
   (fluxo feliz) e 1 com a **transcrição bagunçada** (o caso que quebrava).
2. **Modo transcrição** — 1 rodada com a transcrição do chefe
   (`test-documents/07-24 Reunião Semanal...-transcript.txt`): conferir a
   qualidade da ata e o diagrama que sai dela.
3. **Rótulo curto + idioma** — 1 geração com a ata de PO em inglês
   (`~/Downloads/ata_teste_automacao_PO.md`). Já verificado sem gastar API:
   arquivo **sem mojibake**, `looksLikeTranscript: false` (usar **modo normal**,
   não `--transcricao`), ~6,5k tokens de entrada.
   **Rodar LOCAL** (`npm run dev -- <arquivo>`): a saída pode passar de 100s a
   ~130 tokens/s e o Hobby corta em 60s. Olho no teto de `maxOutputTokens`
   (20000) — se estourar, a chamada falha **depois** de queimar os tokens.
   **Como ler o resultado:** muitas `unresolved_questions` são **sucesso** — é o
   comportamento correto para o que a Task F ainda não cobre. Um diagrama limpo
   *sem* perguntas em aberto seria o sinal ruim (lacunas silenciadas).
   Bom resultado = rótulos em inglês, verbo primeiro, curtos (`Check budget`);
   eventos como substantivo; gateways como pergunta; valores e SLAs no `detail`.

### ~~Task A — Repo privado~~  ·  **descartada em 2026-08-05**
`MarcosGianoniAlpar/BPMN` fica **público**, por decisão do dono: "preciso que o
povo veja mesmo". Não reabrir sem ele pedir. Consequência a ter em mente: nada de
segredo no repo — as chaves continuam só em `.env` local e nas env vars do Vercel.

### Task B — Message flows entre pools  ·  sem API pra desenhar, +1 geração pra validar
Setas tracejadas entre o processo interno e os pools externos. O `ProcessSpec`
**não liga nó ↔ participante externo** hoje (flows são só nó→nó). Precisa:
- `message_flows` no `schemas/process-spec.schema.json` (`{ id, source, target, name }`)
  + `npm run gen:types`;
- ensinar `prompts/extract-process.md` e `refine-process.md` a preenchê-los;
- desenhar `bpmn:MessageFlow` no `src/laneLayout.ts`.

**Validar:** desenho com spec sintético em `test/fixtures.ts` (grátis) primeiro;
extração real só com aprovação.

### Task J — Streaming nas chamadas de IA  ·  sem API pra escrever

**Sintoma real (2026-08-03):** a ata de PO estourou `max_tokens` —
`14104 + 20000 tokens · US$ 0,34 COBRADOS · resposta cortada`. Estourar o teto é
a **pior** falha possível: cobra tudo e devolve nada, porque o JSON da ferramenta
vem partido no meio. Duas rodadas nesse documento custaram ~US$ 0,53 sem sair
diagrama.

**De onde vem cada limite** (confirmado na referência da API, não de memória):

| limite | valor | origem |
|---|---|---|
| `MAX_OUTPUT_TOKENS` | 20000 | **escolha nossa**, em `src/config.ts` |
| teto sem streaming | ~21333 | **do SDK**, não do modelo: ele recusa chamadas não-streaming que estima levarem >10 min |
| **máximo real do Sonnet 5** | **128 000** | do modelo |
| janela de contexto | 1M | do modelo |

Ou seja: **o modelo aguenta 6,4× o que estamos pedindo.** O que trava é a chamada
ser não-streaming. Subir `MAX_OUTPUT_TOKENS` sem streaming não adianta (ganha 6%);
**com** streaming o teto vai a 128k e a ata de PO (~28k estimados) passa folgada.
A recomendação oficial para requisições com saída longa é justamente streaming —
ele existe para evitar o timeout de HTTP, não só para mostrar progresso.

Precisa: migrar `extractProcessSpec`, `refineProcessSpec` e `transcriptToMinutes`
para `client.messages.stream()` + `.finalMessage()`, que devolve a mensagem
completa — não é preciso tratar evento por evento nem remontar o `tool_use` na
mão. Atenção: o handler HTTP já faz streaming NDJSON do **progresso** para o
navegador — são coisas diferentes e não se misturam.

**Não resolve o tempo de parede:** 148s numa rodada, e o Vercel Hobby corta em
60s. Streaming destrava o tamanho, não o relógio — documento grande continua
exigindo execução local (ou plano Pro).

**Dois achados vizinhos, da mesma consulta:**

1. **`thinking: 'disabled'` tem um modo de falha documentado**, mas ele **NÃO
   explica o erro de 21:01.** Com o thinking desligado o modelo às vezes escreve
   a chamada da ferramenta **como texto**, sem emitir o bloco `tool_use` — é o
   que `src/extractProcessSpec.ts` já comenta ter visto. Mas o log de 21:01 diz
   `veio por tool_use`, ou seja, o bloco **existia**; o problema era o tipo de
   `nodes` dentro dele. São falhas diferentes. (A referência documenta esse modo
   para o Opus 5; no Sonnet 5 `disabled` é aceito sem ressalva.)
2. **`effort` nunca foi configurado**, e o padrão é `high`. Existe
   `low`/`medium`/`high`/`xhigh`/`max`; `low` e `medium` rendem bem no Sonnet 5.
   É a alavanca de **custo** mais direta que temos e está intocada — mas é
   otimização, não correção de erro.

**Ambos exigem subir o SDK.** O instalado é `@anthropic-ai/sdk@0.68.0`, que não
conhece `adaptive` nem `output_config`/`effort` (nem nos tipos nem no código); o
mais recente é 0.115.0. O streaming, esse, já existe no 0.68 — foi feito sem
upgrade.

**Mitigação já no ar:** `src/sizing.ts` estima a saída antes de gastar e avisa na
confirmação (CLI e app) quando o documento provavelmente estoura. É aviso, não
bloqueio.

### Task C — Migrations  ·  sem API
Hoje não há migration formal: o schema nasce de `CREATE TABLE IF NOT EXISTS` no
`src/store.ts` + `ALTER` pontuais. Montar esquema leve: pasta `migrations/` com
SQL numerado (`001_init.sql`), tabela `schema_migrations` e `npm run migrate`.
**Bom momento:** quando a Task B precisar mexer no banco.

### Task D — Agendar o backup  ·  sem API
`npm run backup` existe, mas ninguém o executa sozinho. Agendar no PC do dono
(Agendador de Tarefas do Windows) e guardar uma cópia fora do Supabase.
**Nota:** o script ainda **não foi executado ponta a ponta** — falta o `pg_dump`
instalado na máquina (o script detecta e diz como instalar).

### Task E — Prettier  ·  sem API
`npm run format:check` reprova ~33 arquivos: o script existe mas nunca foi
enforçado. Rodar `npm run format` **num commit isolado** (o diff é grande e
ruidoso) e só então adicionar `format:check` ao CI.

### Task N — `strict: true` no tool use  ·  ~1h + 1 geração para confirmar

**Achado ao consultar a referência da API para o upgrade do SDK, não procurando por
isso.** Existe `strict: true` como campo de raiz da definição da ferramenta (não do
`tool_choice`), **GA, sem beta header**, e o Sonnet 5 está na lista de suportados.
O que ele garante: **`tool_use.input` valida exatamente contra o `input_schema`.**

**Por que isso importa aqui mais que em qualquer outro projeto:** é exatamente a
classe de falha que o `normalizarColecoes` existe para remendar — `nodes` vindo
como string de JSON, como mapa por id, agrupado por processo, ou cortado no meio.
Foram ~US$ 0,57 em gerações perdidas por essa família de defeitos, e o remendo
atual conserta *as formas erradas conhecidas*. Com `strict`, elas deixam de ser
possíveis. O `normalizarColecoes` não sai no mesmo commit — vira rede de segurança
até uma rodada real confirmar.

**O trabalho real não é o `strict: true`, é o schema.** A saída estruturada
**não aceita** vários keywords que o nosso schema usa:

| keyword | onde está hoje | o que fazer |
|---|---|---|
| `minLength` | `process.name` e outros | tirar **só** da versão que vai para a ferramenta |
| `minItems` | `nodes` | idem |
| `pattern` | `$defs.id` | **não está na lista de suportados** — conferir antes |

O lugar certo para isso já existe: **`src/toolSchema.ts`**, que hoje achata os
`$ref` e remove `$defs`/`$schema`/`$id` justamente porque *"quem recebe a versão
achatada é só a API"*. O Ajv continua lendo o arquivo com os keywords intactos, e
`npm run gen:types` também — nada de tipo muda.

**Duas incertezas a resolver antes de gastar, ambas de leitura, não de teste:**
1. **`strict` + `tool_choice` forçado.** A referência lista incompatibilidades de
   `strict` numa frase que fala de *programmatic tool calling*; a leitura natural é
   que a restrição é da PTC, não do `strict`. Mas nós usamos `tool_choice` forçado
   nas três chamadas — confirmar na doc antes, porque se forem incompatíveis a task
   morre aqui.
2. **`pattern` é suportado?** Se não, o `^[A-Za-z_][A-Za-z0-9_]*$` sai do schema da
   ferramenta e a garantia de id válido passa a ser só do Ajv — que já é onde ela
   é fatal hoje (`SCHEMA`), então não se perde nada.

**Como validar sem gastar:** o schema achatado é testável (`test/extractProcessSpec.test.ts`
já inspeciona o `input_schema`) — dá para fixar que os keywords proibidos
desapareceram e que `additionalProperties: false` + `required` estão em todo objeto,
que é o que o `strict` exige. Só a garantia em si precisa de 1 geração.

### ~~Task L — Dois bugs de layout~~  ·  **✅ os dois feitos em 2026-08-05**

Ver os detalhes em **Concluído**. O que vale guardar como lição de processo:
nenhum dos dois aparecia em log nenhum — `npm test`, bpmnlint e o pipeline todo
passavam verdes. Só apareceram quando o desenho foi olhado como imagem.
**Exportar o PNG faz parte de validar**, não é enfeite. E vale para a própria
correção: ela está coberta por teste, mas o PNG ainda não foi olhado.

### Task M — Fechar o laço: integridade referencial e refino  ·  M1 sem API

**~~M1 · Regra de integridade no prompt~~ — ✅ feito em 2026-08-05** (ver
Concluído; foi para os dois prompts **e** para o schema).
O erro que ele mira, para referência: duas de duas falhas de modelagem caíram no
MESMO lugar, a cadeia de aprovação por faixa de valor (§3.1). O modelo tenta
encadear ("precisa do Finance? precisa do CFO?"), cria gateways intermediários,
escreve os fluxos para eles e **não os declara** em `nodes`
(`gw_finance_needed`/`gw_cfo_needed` numa rodada, `gw_value_tier_check`/`check2`
na outra). Não é ruído: é um ponto sistematicamente ambíguo do documento.
**Se voltar a acontecer**, o próximo passo não é mais prompt — é o M2.

**M2 · Realimentar os avisos no refino.** Os avisos da validação já são
perguntas bem-formadas ("você referenciou `X` mas não o declarou"). O
`refineProcessSpec` já sabe receber esclarecimento e devolver o spec revisado —
falta ligar uma coisa na outra. Transforma um diagrama com 9 erros num diagrama
correto, com uma chamada pequena e cirúrgica. **Custa 1 chamada quando dispara.**

### Task K — Chunking: uma extração por processo  ·  **decidida e validada em 2026-08-04**

**Nasce da Task I e é o que faz a ata de PO funcionar.** Só existia na conversa;
registrado aqui para não se perder.

**A evidência que decidiu:** a ata inteira (6 processos) falhou **3/3** — sempre
com `nodes` virando string e `flows` vazio, e com o modelo desistindo cada vez
mais cedo (13.255 → 9.036 → 5.972 tokens de saída, contra um teto de 64.000). O
recorte das §2–5 (**um** processo, `test-documents/ata-PO-secoes-2-5.md`) saiu
inteiro: 33 nós, 39 fluxos, 7 raias, 0 erros de lint, **9.935 tokens** — *mais*
saída que qualquer uma das falhas. Não é volume de tokens: é o modelo perdendo a
saída estruturada quando tem seis processos para segurar num spec singular.

**O corte é por processo, não por tamanho.** Fatiar por bytes cria o problema
difícil (fluxos atravessando o corte, ids colidindo). Por processo, as
referências cruzadas viram **call activity** — uma referência por id, não uma
costura de geometria. Na ata: §2–5 / §6,8,9 / §7 / §10–12 / §13 / §14.

Ordem, e o que gasta:

1. `processes[]` no schema + `gen:types` — sem API, sem migração (`jsonb`)
2. `call_activity` como tipo de nó (é a **F2**) — sem API, **zero geometria**:
   caixa de tarefa com `isExpanded: false` na DI
3. Merge determinístico — concatena por processo, deduplica `lanes` e
   `participants` por nome. Sem API, testável em `test/fixtures.ts`
4. **Chamada de índice**: documento → lista de processos com faixas de seção.
   Saída de ~500 tokens, sem risco de degradar. **1 chamada pequena**
5. Uma extração por processo, cada uma com seu trecho + os ids das outras. **N chamadas**
6. Tela: navegação entre diagramas; "Congelar versão" congela o conjunto

**Pré-requisito, não polimento:** a validação reparável (ver Concluído). Com 6
chamadas em vez de 1, se qualquer escorregão abortar tudo, a chance de todas
passarem despenca — chunking com validação fatal fica **pior** que hoje.

**Ganho além de funcionar:** a chamada única leva 50–97s e o Hobby corta em 60.
Este documento hoje **só roda local**. Com chunks de ~25 nós, cada chamada cabe.

**Não resolve:** F3 (boundary events — os SLAs da §3.3 continuam virando
pergunta) nem F5 (multi-instância). E `unresolved_questions` vão continuar
aparecendo — é o comportamento certo.

### Task I — Um documento → VÁRIOS processos  ·  sem API  ·  **a mais estrutural**

**O problema que a Task F não resolve.** F trata de tipos de nó que faltam. Este
é o formato do spec: o `ProcessSpec` é **singular** — um `process`, um conjunto
de `nodes`, um de `flows`. **Um documento = um diagrama.**

A ata de PO descreve **seis** processos distintos, cada um com gatilho e estados
terminais próprios: (1) requisição→aprovação, (2) sourcing→emissão do PO,
(3) compras internacionais, (4) entrega→three-way match→pagamento,
(5) auditoria de compliance, (6) logística reversa/RMA. A §15 lista **sete**
estados terminais só para um item de linha.

Como o prompt manda "exatamente um `start_event`" (o validador é mais frouxo:
`src/validate.ts` exige só **pelo menos um**), o modelo vai espremer tudo numa
raiz só. Resultado esperado: ou escolhe uma linha e ignora o resto, ou funde
tudo num diagrama monstruoso. **Isso não se conserta adicionando tipo de nó.**

Precisa decidir a forma:
- **(a) Um spec com `processes[]`** — o principal referencia os demais via
  chamada (é o mesmo mecanismo do subflow da F2). **Recomendado:** cabe no
  `jsonb`, então **migração no banco: nenhuma**, e mantém "um documento = um
  projeto = uma versão congelável".
- **(b) Cada processo vira sua própria versão/diagrama** — aí sim mexe no banco
  e no modelo projeto→versões, e "congelar versão" fica ambíguo (congela qual?).

Ramificações além do schema: qual diagrama a tela mostra e como se navega entre
eles; o que o "Congelar versão" congela; e como o relatório PDF (Backlog) pagina
vários diagramas. **Decidir (a) vs (b) antes de F1/F2** — a escolha muda as duas.

### Task F — Cobertura BPMN que um processo real exige  ·  sem API pra desenhar

**Por que existe:** a ata de PO em inglês (`~/Downloads/ata_teste_automacao_PO.md`,
gerada para teste) pede cinco construções que o subset atual não tem. Hoje o
prompt manda registrar em `unresolved_questions` e "modelar o que der" — o
resultado é degradação **silenciosa**:

| o documento pede | o que sai hoje | risco | estado |
|---|---|---|---|
| sub-processo | achatado inline | diagrama gigante, some a hierarquia | F2 — **trava na Task I** |
| timer de fronteira ("sem resposta em 4h → escala") | `tarefa → gateway → timer` | **muda a semântica**: interrupção virou verificação sequencial | F3 — pendente |
| gateway inclusivo (nº variável de ramos) | `parallel` ou `exclusive` | se paralelo, **o join trava**; o bpmnlint não pega | **✅ F4 (2026-08-04)** |
| multi-instância (1 requisição → N POs filhos) | achatado num caminho só | perde "fecha o pai quando todos terminarem" | F5 — **trava na Task I** |
| "first response wins" | provavelmente `exclusive` | perde a corrida e o cancelamento | **✅ F6 (2026-08-04)** |

O pior é o **inclusivo**: sai um diagrama que parece certo e está errado.

**Reordenação (2026-08-04), depois de ler o código com a ata na mão.** O critério
que separa os itens não é "schema vs. layout", é **se mexem na geometria**:

- **Sem geometria nova** (gateway é losango, `call activity` é caixa de tarefa,
  multi-instância é só um marcador `|||` que o bpmn-js desenha sozinho a partir
  de `bpmn:MultiInstanceLoopCharacteristics`): F4, F6 — feitos —, e F2/F5, que
  só esperam a decisão da Task I. **A F5 é bem mais barata do que esta lista
  dizia**: o caro nela é a semântica pai→filho, que é a mesma coisa da F2.
- **Com geometria nova**: só a **F3**, que precisa ancorar o evento na borda da
  tarefa e é a única que exige mexer no `laneLayout`. Continua sendo a mais cara.

Dois achados que baixam o custo estimado da F3 e da F2:

1. O **`bpmn-auto-layout` já sabe** posicionar boundary events e desenha
   sub-processo colapsado (confirmado no `dist` e nas "Limitations" do README).
   Ou seja, o **caminho sem raias sai de graça** nas duas — só o `laneLayout.ts`
   precisa de código.
2. A F3 vai esbarrar numa regra de validação existente: `src/validate.ts` exige
   fluxo de entrada para **todo** nó que não seja `start_event`, e um boundary
   event **não tem** fluxo de entrada. Sem isentá-lo, toda geração com boundary
   reprova **depois de paga**. É o gotcha mais caro de esquecer nessa task.

Ordem sugerida — por valor no ServiceNow (Task G) dividido pelo custo:

1. **F1 · Trigger no start event** — hoje `start_event` é só um nome. Ganhar
   `trigger: { type, condition }` (`record_created`, `record_updated`,
   `scheduled`, `catalog_request`, `inbound_email`). É o conceito **mais central
   do Flow Designer** e o mais barato: schema + prompt, desenho não muda.
2. **F2 · Subprocesso — começar pelo COLAPSADO.** Uma caixa com `+` que aponta
   para outro diagrama. Bem mais barato que expandido (não mexe no `laneLayout`,
   que teria de aninhar geometria) e é **exatamente** o que um Subflow é: um
   fluxo separado. Expandido, se um dia precisar, vem depois.
3. **F3 · Boundary events (timer e erro) na tarefa** — os SLAs da ata (4h, 8h,
   24h, 48h, 30 dias) são todos isso. Exige âncora do evento na borda da tarefa
   no layout — o item mais caro em geometria desta task.
4. ~~**F4 · `inclusive_gateway`**~~ — **feito em 2026-08-04.**
5. **F5 · Multi-instância (pai → filhos)** — o padrão REQ→RITM→SCTASK. O de maior
   valor de negócio. Em BPMN é `bpmn:MultiInstanceLoopCharacteristics` como filho
   da atividade, e o marcador `|||` é desenhado pelo bpmn-js — **zero geometria**.
   O que custa é a semântica pai→filho, que é a mesma da F2: faça as duas juntas,
   depois da Task I.
6. ~~**F6 · Gateway baseado em evento**~~ — **feito em 2026-08-04.** Foi junto da
   F4 por ser do mesmo lote barato, e não por ter aparecido de novo.

Faltavam na 1ª versão desta lista, e a ata de PO pede os quatro:

7. **F7 · `business_rule_task`** — a matriz de aprovação ($5k/$50k), o algoritmo
   de ranking de fornecedor (preço 60% / prazo 30% / qualidade 10%) e a
   tolerância de ±2% do three-way match **não são tarefas humanas nem de
   sistema**: são regras. No ServiceNow isso é **Decision Table**, então tem
   contraparte direta — deveria subir na ordem, provavelmente logo após F1.
8. **F8 · Data objects** — PO, Goods Receipt Note, Supplier Invoice, RMA, pacote
   de documentação de importação. O three-way match é **literalmente** reconciliar
   três documentos; sem objeto de dado, o diagrama não mostra o que é conciliado.
9. **F9 · Contadores de laço** — "máximo de duas revisões", "até três tentativas
   de sourcing", "três falhas de compliance em 12 meses". O laço em si já é
   desenhável; o **contador** não é expressável hoje.
10. **F10 · End events tipados** (terminate / error / cancel) — a §15 lista sete
    estados terminais de naturezas diferentes (cumprido, cancelado pelo
    solicitante, rejeitado por orçamento, sourcing falhou...), e ainda um
    **não-terminal** ("Blocked — Compliance Hold"). Hoje todos viram o mesmo
    círculo, e a diferença some.

**Cada item precisa dos mesmos 4 passos:** `schemas/process-spec.schema.json` +
`npm run gen:types` → os dois prompts → `src/bpmnNodes.ts` **e** os dois
compiladores (`compiler.ts` e `laneLayout.ts`) → teste em `test/fixtures.ts`.
O teste "todo tipo do schema tem tradução para BPMN" (`test/compiler.test.ts`)
já guarda contra ensinar o tipo ao prompt e esquecer de desenhá-lo.

**Validar:** desenho com spec sintético (grátis) antes de qualquer geração real.

### Task G — Vocabulário ServiceNow no prompt  ·  sem API pra escrever

**O destino é sempre o ServiceNow**, então o extrator deveria reconhecer os
conceitos da plataforma em vez de tratá-los como texto qualquer. Equivalência:

| BPMN | ServiceNow |
|---|---|
| trigger do start event | **Trigger** (record created/updated, scheduled, catalog request, inbound email) |
| subprocesso | **Subflow** |
| boundary timer + escalonamento | **SLA / Wait for duration** + escalation |
| multi-instância pai→filhos | **REQ → RITM → SCTASK** |
| user task / aprovação | **Approval** (com delegação = o caso "out-of-office") |
| service task | **Action** (Integration Hub / spoke) |

Não é da ata do PO por acaso: ela descreve o modelo de request do ServiceNow —
requisição pai com vários itens, cada um no seu caminho, o pai fechando quando
todos terminam.

**É a melhor relação valor/custo do momento:** é edição de `.md`, sem mexer em
schema nem em layout. Fazer **antes** ou junto de F1/F2, para que o vocabulário
já esteja lá quando os tipos novos chegarem.

**Em aberto:** manter o `ProcessSpec` puro-BPMN (recomendado — a plataforma é
detalhe de destino, não de modelagem) ou dar a ele um campo de anotação
ServiceNow por nó. Decidir antes de F1.

### Task H — `language` no `ProcessSpec`  ·  sem API
A `MeetingMinutes` registra o idioma; o `ProcessSpec` **não**. No modo normal
(documento → diagrama direto) nada diz em que idioma o spec está. Isso trava a
exportação traduzida do Backlog: sem o campo, você gastaria uma chamada só para
descobrir que o spec já estava em inglês. Schema + `gen:types` + regra no prompt.
**Migração no banco: nenhuma** — `process_spec` é `jsonb`.

---

## Backlog (quando der)

- **Seletor de idioma na exportação** — gerar o diagrama em inglês pro cliente e
  em português pro time. **Em aberto.** A recomendação: traduzir **na
  exportação**, não guardar uma segunda versão. Motivo: duas extrações
  independentes do mesmo documento produzem processos *estruturalmente*
  diferentes (contagem de nós, decisões), e você mostraria ao cliente um processo
  diferente do que o time executa — em silêncio. Traduzir depois da extração
  mantém `id`, fluxos e geometria idênticos: duas renderizações de **um** processo.
  Ruim mesmo assim: a `evidence` **não** pode ser traduzida (é rastreabilidade
  literal), então um diagrama em inglês carrega citações no idioma original.
  Depende da Task H. Só precisaria de tabela nova se quisermos **cache** da
  tradução — otimização, não requisito.
- **Relatório final em PDF (BPMN + etapas + prints da reunião via Microsoft
  Graph)** — proposta escrita em `docs/relatorio-pdf-graph.md`, **parada por
  decisão**: arquitetura não fechada. Dois itens valem começar mesmo parados,
  porque são tempo de calendário e não de desenvolvimento: (a) pré-requisitos de
  tenant (consentimento de admin, permissões, **Application Access Policy** — dá
  403 mesmo com tudo concedido no portal) e (b) o spike de CORS/codec, único item
  capaz de invalidar o desenho.
- **`fake-join`: decidir se é ruído ou se é para modelar** — o lint das fixtures
  mostrou `fake-join` em **5 das 6** ("Incoming flows do not join"): um nó com
  várias entradas e nenhum gateway de junção explícito, tipicamente vários
  caminhos desembocando no mesmo `end_event`. Vem do `bpmnlint:recommended` e é
  `warn`, não erro. Vai aparecer em **todo** diagrama real, então é decisão de
  postura, não bug: (a) ensinar o prompt a fechar com gateway quando o documento
  diz que o processo só segue depois que todos terminarem — o que já é regra para
  `parallel_gateway` e poderia valer para a convergência em geral; ou (b) desligar
  a regra, como foi feito com `no-inclusive-gateway`, porque ela existe para
  *motores de execução* e o destino aqui é documentação → ServiceNow. Sem decidir,
  a caixa de avisos vira barulho constante e o especialista para de ler.
- **`/api/health`** — checar banco + config sem disparar uma geração paga.
- **Link compartilhável de projeto** (`/?project=<id>`) — duas pessoas
  contribuindo no mesmo diagrama via versões. É o passo (a), leve, e encaixa no
  modelo projeto→versões que já existe. (Co-edição em tempo real é pesada demais
  pro Vercel: serverless não mantém WebSocket.)
- **Otimizar geração pra folga no timeout** (se aparecer 504 em doc grande):
  baixar `MAX_OUTPUT_TOKENS`, enxugar prompt.
- **Limpar caracteres estranhos** da extração de PDF (`documentLoader.ts`).
- **Confirmar streaming NDJSON** no Vercel (a barra de progresso ao vivo funciona
  ou o Vercel bufferiza? — o diagrama chega de qualquer forma).
- **Restaurar lint no serverless** (hoje pulado; `min-dash` só-ESM quebra o
  `require` no runtime do Vercel — fixar via `overrides`).
- **OCR** para PDF escaneado (fase futura).

---

## Referência

### Limites de timeout do Vercel
| Plano | Máx. por função |
|---|---|
| Hobby (atual) | **60s** (teto rígido; `maxDuration=300` é capado a 60) |
| Pro | 300s |

### Arquivos-chave
- `src/orchestrator.ts` — pipeline (extração→validação→compilação→layout→cor→lint).
- `src/httpHandlers.ts` — núcleo HTTP compartilhado (dev local + funções Vercel).
- `src/server.ts` — servidor do dev local (`npm run web`).
- `api/*.ts` — funções serverless do Vercel (importam de `../dist/*.js`).
- `src/store.ts` — persistência Postgres; `getUsageReport()`, `reserveAiCall()`.
- `src/config.ts` — config via `.env` (modelo, tokens, rate limit).
- `src/laneLayout.ts` — layout com raias/pools (onde fica a Task B).
- `src/bpmnNodes.ts` — tipo do spec → elemento BPMN, **em um lugar só**.
- `src/bpmnColor.ts` — colorização da DI (paleta Alpar).
- `schemas/*.schema.json` — ProcessSpec e MeetingMinutes (fonte da verdade).
- `test/fixtures.ts` — specs sintéticos; **valide desenho aqui antes de gastar API**.
- `.github/workflows/ci.yml` — CI.
- `scripts/backup-db.mjs` — backup do Postgres.

### Comandos
```bash
npm run web                             # app local (http://localhost:3000)
npm test                                # suíte determinística — NÃO gasta API
npm run dev -- <arquivo>                # CLI — GASTA API (pedir ok antes)
npm run dev -- <arquivo> --transcricao  # transcrição → ata → diagrama (2 chamadas 💸)
npm run dev -- <arquivo> --so-ata       # para na ata (1 chamada 💸)
npm run typecheck && npm run typecheck:test && npm run lint && npm test
npm run typecheck:vercel                # valida as funções serverless em api/
npm run gen:types                       # regenera tipos dos schemas
npm run fixtures:bpmn                   # grava as fixtures em output/fixtures/ e linta
npm run backup                          # dump do Postgres em backups/
```

## Histórico do deploy (gotchas já resolvidos — não repetir)
- **Sonnet 5 pensa por padrão** (mudou em relação ao 4.6): omitir o campo `thinking`
  liga o *adaptive thinking*, e o `max_tokens` limita **thinking + resposta juntos**.
  Como `thinking.display` é `"omitted"` por padrão, os blocos vêm vazios e o gasto
  fica invisível. Sintoma: a chamada "dá certo", consome milhares de tokens de saída
  e devolve um objeto quase vazio — ou estoura `max_tokens` sem produzir nada.
  Solução: `thinking: { type: 'disabled' }` nas chamadas de extração estruturada.
- **`MAX_OUTPUT_TOKENS` tem teto duro de 21333**: acima disso o SDK recusa a
  chamada não-streaming na hora ("Streaming is required for operations that may
  take longer than 10 minutes"). Com 32000, toda chamada morria em 2ms.
- Preset "Node" rodava `public/app.js` como função (`document is not defined`) →
  `"framework": null` no `vercel.json` (preset Other).
- Upload com acento no nome (`non ISO-8859-1`) → `encodeURIComponent` no cliente +
  `decodeFilename` no servidor.
- `/api/generate` 500 `ERR_REQUIRE_ESM` (bpmnlint→min-dash só-ESM) → lint carregado
  por import dinâmico e **pulado** se falhar (best-effort).
- PDF `DOMMatrix is not defined` → dep `@napi-rs/canvas` + `includeFiles`.
- PDF `Cannot find module pdf.worker.mjs` → `includeFiles` do build legacy do pdfjs.
- Colorização: NÃO usar `xml:{tagAlias:'lowerCase'}` na extensão moddle de cor
  (serializa `bpmndi:bPMNShape` com case errado e quebra o render). **Coberto por
  teste agora** (`test/bpmnColor.test.ts`).
- `pg_dump` **não opera no pooler de transação (6543)** — o `npm run backup` troca
  para 5432 (pooler de sessão) sozinho.
