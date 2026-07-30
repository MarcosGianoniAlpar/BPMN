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
   gastam (`npm run dev`, `npm run eval`, `/api/generate`, `/api/refine`). Testes
   determinísticos (compilador, layout, cor, lint, rótulos) **não gastam** e podem
   rodar livres.

---

## Onde estamos

- **App no ar no Vercel**, repo `MarcosGianoniAlpar/BPMN` (time Alpar, plano
  **Hobby**). Arquitetura: estático (`public/`) + funções serverless (`api/`),
  banco **Supabase/Postgres**. Geração de `.txt`/`.pdf`/`.docx` funciona ponta a
  ponta na PROD.
- **Colorização** com a paleta Alpar entregue (`src/bpmnColor.ts`).
- **Branch `dev`** já existe no GitHub (Preview no Vercel). `dev` == `main` no
  momento (nada novo mergeado pra PROD).
- Node/TypeScript, ESM (NodeNext). **Fonte da verdade = `ProcessSpec`** (Opção A).
  Dois caminhos de layout: com raias → `src/laneLayout.ts`; sem raias →
  `src/compiler.ts` + `bpmn-auto-layout` (orchestrator escolhe por `hasLanes`).

## Decisões travadas

- **Sem plano Pro no Vercel** por ora. Geração leva ~1 min; Hobby capa em **60s**.
  Hoje está **abaixo de 60s → funciona**, mas é borderline (doc muito grande pode
  estourar 504). `maxDuration=300` já no código, sobe sozinho se ativarem Pro.
- **Modelo fixo `claude-sonnet-5`** (sem evals / sem troca de modelo por ora).
- **Cadastro/login: NÃO agora** — o dono vai confirmar com o chefe. (Ver Task 2.)

---

## Feito nesta sessão — validar no próximo chat

**Robustez da extração (tool use / saída estruturada) — implementado no `dev`,
falta 1 teste real.** A extração e o refino agora usam **tool use forçado**
(`emit_process_spec`, `tool_choice` forçado) em vez de pedir JSON em texto: o SDK
entrega `tool_use.input` já como objeto, então some o erro
`Expected ',' or ']' ... in JSON` que aparecia com documentos bagunçados
(transcrições, encoding ruim). Truncamento por tokens vira erro claro
(`max_tokens`). `vercel.json` empacota `schemas/**` e `prompts/**` (a ferramenta lê
o schema em runtime). Arquivos: `src/extractProcessSpec.ts`, `src/refineProcessSpec.ts`,
`vercel.json`. Validado só deterministicamente (typecheck/lint/build/typecheck:vercel
+ carga do schema). **Falta:** 1 geração real (💸) — testar com a **ata de mudanças
emergenciais** (fluxo feliz) e com a **transcrição bagunçada** (o caso que quebrava).
SDK `@anthropic-ai/sdk` é 0.68.0 e NÃO tem structured outputs/`strict`; por isso
tool use "normal" (não-strict), que já resolve. Se um dia subir o SDK, dá pra
endurecer com `strict: true`.

## TASKS

Ordem sugerida: **1 → 6**. Todas as Tasks 1–5 são **determinísticas (não gastam
API)**; a validação real dos message flows (Task 4) precisa de 1 geração aprovada.

### Task 1 — Rótulos do diagrama (texto em cima da linha)  ·  sem API
**Problema:** nomes de fluxo (ex.: "Sim"/"Não" nos gateways) e às vezes nomes de nós
ficam **em cima da linha** ou mal posicionados.
**Causa:** no `src/laneLayout.ts` a gente emite os `bpmndi:BPMNEdge`/`BPMNShape` sem
`di:BPMNLabel`, então o bpmn-js coloca o rótulo no meio da seta por padrão.
**Fazer:**
- Emitir `bpmndi:BPMNLabel` com `dc:Bounds` próprio pros edges com nome — deslocar o
  rótulo pra **cima/ao lado** da linha (não em cima).
- Conferir posição dos rótulos de nós (dentro/abaixo).
- (Ver também o caminho sem raias: o `bpmn-auto-layout` posiciona rótulos sozinho;
  checar se precisa de ajuste lá.)
**Validar:** visualmente no navegador local (`npm run web`), sem gerar via IA — dá
pra abrir um `.bpmn` salvo ou usar um spec sintético.

### Task 2 — Segurança / proteção contra gasto indevido  ·  sem API
A app é **pública e sem login**: quem tiver a URL pode gerar e **queimar a verba da
empresa**.
- **Rate limit (VAMOS FAZER):** limitar `/api/generate` (e `/api/refine`) por IP/janela.
  Em serverless **não dá contador em memória** → usar **contador compartilhado no
  Supabase** (tabela de contagem por IP+janela). (Alternativa: Upstash Redis free —
  não escolhido, evita dependência nova.)
- **Cadastro/login: aguardando o chefe.** Se aprovado, avaliar **Supabase Auth**.
- **Repo privado:** `MarcosGianoniAlpar/BPMN` está **público** (código da empresa) —
  tornar privado.

### Task 3 — Custo sempre à vista  ·  sem API
Hoje o custo só aparece no painel "Uso & custo" da **home**. Deixar visível o tempo
todo (key é da empresa).
- **Badge fixo no header** (home + workspace): total acumulado em US$, atualiza a
  cada geração (puxa de `GET /api/usage`).
- **Custo da geração atual** inline no resultado: "esta geração: US$ X · N tokens".
- Só frontend + rota existente (`src/store.ts` já tem `getUsageReport()`).

### Task 4 — Message flows entre pools  ·  precisa extensão de modelo (+1 geração p/ validar)
Desenhar as setas tracejadas entre o processo interno e os pools externos.
**Porém o `ProcessSpec` NÃO liga nó ↔ participante externo hoje** (flows são só
nó→nó). Precisa:
- Adicionar `message_flows` no schema (`schemas/process-spec.schema.json`) — ex.:
  `{ id, source, target, name }` ligando um nó a um participante externo — e
  **regenerar tipos** (`npm run gen:types`).
- Ensinar o **prompt de extração** a preenchê-los (`prompts/extract-process.md` e
  `refine-process.md`).
- Desenhar `bpmn:MessageFlow` no `src/laneLayout.ts` (interno ↔ pool externo).
- **1ª migration real** (ver Task 6) se envolver mudança de tabela — aqui é só schema
  JSON do spec, mas vale alinhar.
**Validar:** desenho com **spec sintético** (sem API) primeiro; extração real com
**1 geração** só quando aprovado.

### Task 5 — Tipos de nó mais ricos  ·  sem API (mas +1 geração p/ validar extração)
Hoje só: `start_event, end_event, user_task, service_task, exclusive_gateway`.
Falta principalmente o **gateway paralelo (AND)** — processos reais têm caminhos
simultâneos; e eventos intermediários (timer/mensagem), subprocessos.
- Mexer no schema + `NODE_TYPE_TO_BPMN` (`laneLayout.ts`/`compiler.ts`) + prompt.
- Validar desenho com spec sintético; extração real com geração aprovada.

### Task 6 — Estrutura de dados: backup + migrations  ·  sem API
**Backup:** Supabase **free não tem backup automático**. Criar script
`npm run backup` que roda `pg_dump` pela `DATABASE_URL` e salva `.sql` datado;
guardar fora do Supabase. (Agendar no PC/cron do dono.)
**Migrations:** hoje **não há migration formal** — o schema é criado por
`CREATE TABLE IF NOT EXISTS` no `src/store.ts` (bootstrap idempotente) + `ALTER`
pontuais. Montar esquema **leve**: pasta `migrations/` com SQL numerado
(`001_init.sql`, `002_...`) + tabela `schema_migrations` + script `npm run migrate`.
Bom momento: quando a Task 4/5 precisar mudar o banco.

---

### Task 7 — Modo transcrição (transcrição → ata limpa → diagrama)  ·  IMPLEMENTADO no `dev`, falta 1 validação real 💸
Transcrições de reunião (fala solta, ruído, encoding ruim) geram diagramas fracos.
Agora existe um passo de **pré-processamento**: a IA lê a transcrição crua e emite
uma **ata estruturada** (`MeetingMinutes`, via tool use forçado), que um
renderizador **determinístico** transforma em Markdown — e é esse Markdown que
alimenta o pipeline de diagrama.

**Como ficou (2 chamadas de IA, uma por requisição):**
1. `POST /api/minutes` — transcrição → ata (JSON + Markdown). **Não gera diagrama.**
2. O especialista **revisa/corrige a ata** na tela (textarea) e clica em
   "Gerar diagrama a partir desta ata" → `POST /api/generate` com o Markdown.

Separar as duas chamadas é de propósito: o humano revisa antes de gastar a segunda,
e cada invocação cabe no **teto de 60s do Hobby** (encadear as duas estouraria).

- **UX:** duas abas na home ("Ata ou documento → diagrama" / "Transcrição → ata →
  diagrama"), como o dono sugeriu, + tela intermediária da ata com resumo lateral
  (fluxo detectado, contagens, pontos em aberto) e botão de baixar `.md`.
- **Rastreabilidade:** cada item da ata carrega citação literal da transcrição
  (com timestamp/speaker), e essas citações são renderizadas junto de cada etapa
  do fluxo — assim a `evidence` do ProcessSpec continua apontando para a fala real.
- **Encoding:** `src/textCleanup.ts` conserta mojibake (`ReuniÃ£o` → `Reunião`),
  ligaduras, aspas tipográficas e caracteres invisíveis antes de gastar tokens.
- **Custo:** a chamada da ata não vira versão de projeto, então foi criada a tabela
  `ai_calls` no Supabase; o `GET /api/usage` agora soma versões + `ai_calls`
  (senão o painel subestimaria o gasto da empresa).
- **CLI:** `npm run dev -- <arquivo> --transcricao` (ata + diagrama) e `--so-ata`
  (para na ata, 1 chamada só). Grava `<nome>.ata.md` e `<nome>.ata.json`.

**Arquivos:** `schemas/meeting-minutes.schema.json`, `prompts/transcript-to-minutes.md`,
`src/transcriptToMinutes.ts`, `src/minutesMarkdown.ts`, `src/textCleanup.ts`,
`src/types/meeting-minutes.ts` (gerado), `api/minutes.ts`, + orchestrator,
httpHandlers, server, store, index (CLI) e frontend.

**Validado só deterministicamente** (typecheck / lint / build / typecheck:vercel +
render da ata a partir de um objeto sintético + rota `/api/minutes` respondendo).
**Falta:** 1 rodada real 💸 com a transcrição do chefe
(`test-documents/07-24 Reunião Semanal...-transcript.txt`) — conferir a qualidade
da ata e o diagrama que sai dela.

## Backlog (quando der)

- **Otimizar geração pra folga no timeout** (se aparecer 504 em doc grande): baixar
  `MAX_OUTPUT_TOKENS`, enxugar prompt.
- **Limpar caracteres estranhos** da extração de PDF (ex.: `Ata de Reuni��o` — fonte
  do título sem mapeamento Unicode; pós-processamento cosmético em `documentLoader.ts`).
- **Confirmar streaming NDJSON** no Vercel (a barra de progresso ao vivo funciona ou
  o Vercel bufferiza? — o diagrama chega de qualquer forma).
- **Restaurar lint no serverless** (hoje pulado; `min-dash` só-ESM quebra o `require`
  no runtime do Vercel — fixar `min-dash` numa versão com build CJS via `overrides`).
- **Validar visual completo:** raias limpas, edição + "Congelar versão", export
  PNG/SVG colorido.
- **OCR** para PDF escaneado (fase futura).

## Ideia maior — Diagrama compartilhado / colaborativo (discutir alvo antes)
Objetivo: **duas pessoas contribuírem** no mesmo diagrama. Níveis:
- **(a) Link compartilhável de projeto salvo** — URL `/?project=<id>` que abre um
  projeto do Supabase; ambos veem/editam e salvam **versões**. Leve, encaixa no
  modelo projeto→versões que já existe. **Recomendado começar por aqui.**
- **(b) Colaboração por versões com identidade** — registrar **quem** fez cada versão.
- **(c) Co-edição em tempo real** — presença + merge simultâneo. **Pesado e com
  atrito no Vercel** (serverless não mantém WebSocket): exigiria Supabase Realtime /
  Liveblocks / Ably + CRDT (Yjs) no bpmn-js. Provavelmente fora do escopo atual.

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
- `src/store.ts` — persistência Supabase/Postgres (async); `getUsageReport()`.
- `src/laneLayout.ts` — layout com raias/pools (onde ficam Tasks 1, 4).
- `src/bpmnColor.ts` — colorização da DI (paleta Alpar).
- `schemas/process-spec.schema.json` — schema do ProcessSpec (Tasks 4, 5).
- `schemas/meeting-minutes.schema.json` — schema da ata estruturada (Task 7).
- `src/transcriptToMinutes.ts` / `src/minutesMarkdown.ts` — modo transcrição
  (chamada de IA e render determinístico da ata).
- `src/textCleanup.ts` — mojibake e caracteres invisíveis.
- `prompts/` — prompts da IA (extract-process.md, refine-process.md,
  transcript-to-minutes.md).
- `public/` — frontend (index.html, app.js, styles.css).
- `vercel.json` — `framework:null`, `outputDirectory:public`, `includeFiles`
  (empacota `@napi-rs/canvas` e o build do `pdfjs`).

### Comandos
```bash
npm run web                             # app local (http://localhost:3000)
npm run dev -- <arquivo>                # CLI — GASTA API (pedir ok antes)
npm run dev -- <arquivo> --transcricao  # transcrição → ata → diagrama (2 chamadas 💸)
npm run dev -- <arquivo> --so-ata       # para na ata (1 chamada 💸)
npm run eval                            # avaliação — GASTA API (pedir ok antes)
npm run typecheck && npm run lint && npm run build
npm run typecheck:vercel                # valida as funções serverless em api/
npm run gen:types                       # regenera tipos dos schemas (Tasks 4, 5, 7)
```

## Histórico do deploy (gotchas já resolvidos — não repetir)
- **Sonnet 5 pensa por padrão** (mudou em relação ao 4.6): omitir o campo `thinking`
  liga o *adaptive thinking*, e o `max_tokens` limita **thinking + resposta juntos**.
  Como `thinking.display` é `"omitted"` por padrão, os blocos vêm vazios e o gasto
  fica invisível. Sintoma: a chamada "dá certo", consome milhares de tokens de saída
  e devolve um objeto quase vazio — ou estoura `max_tokens` sem produzir nada.
  Solução: `thinking: { type: 'disabled' }` nas chamadas de extração estruturada
  (ata, extração e refino do ProcessSpec) — são tool use forçado, pensar só consome
  orçamento e tempo. Se um dia quiser thinking de volta, dimensione o `max_tokens`
  para os dois.
- Preset "Node" rodava `public/app.js` como função (`document is not defined`) →
  `"framework": null` no `vercel.json` (preset Other).
- Upload com acento no nome (`non ISO-8859-1`) → `encodeURIComponent` no cliente +
  `decodeFilename` no servidor.
- `/api/generate` 500 `ERR_REQUIRE_ESM` (bpmnlint→min-dash só-ESM) → lint carregado
  por import dinâmico e **pulado** se falhar (best-effort).
- PDF `DOMMatrix is not defined` → dep `@napi-rs/canvas` + `includeFiles`.
- PDF `Cannot find module pdf.worker.mjs` → `includeFiles` do build legacy do pdfjs.
- Colorização: NÃO usar `xml:{tagAlias:'lowerCase'}` na extensão moddle de cor
  (serializa `bpmndi:bPMNShape` com case errado e quebra o render).
