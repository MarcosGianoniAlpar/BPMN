# Relatorio final em PDF, com prints da reuniao (proposta de arquitetura)

Objetivo: ao final do trabalho, gerar **um PDF** com o BPMN no topo, o
detalhamento das etapas e, junto de cada etapa, as **capturas de tela do momento
da reuniao** em que aquilo foi dito. A gravacao vem do Teams via **Microsoft
Graph**, e tudo acontece dentro deste app.

> Status: **parado por decisao (2026-08-03)** — a arquitetura completa nao esta
> fechada, entao nada aqui vira codigo por enquanto. O documento fica como base
> da discussao.
>
> **O que fazer no meio-tempo:** os pre-requisitos de tenant da secao 4
> (consentimento de admin, permissoes, Application Access Policy) dependem do
> administrador do Microsoft 365 e levam **tempo de calendario**, nao de
> desenvolvimento. Vale abrir esses pedidos agora, mesmo com a construcao
> parada — e tambem o spike de CORS/codec da secao 5, que e o unico item capaz
> de invalidar o desenho e nao custa quase nada para responder.

## 1. A chave de tudo: o timestamp ja existe

O gancho que torna isso barato ja esta no projeto. Toda evidencia hoje segue o
formato definido em `schemas/meeting-minutes.schema.json`:

```
"trecho literal da transcricao — Speaker 2, 00:04:06"
```

Ou seja: **cada no do BPMN ja sabe em que minuto da reuniao ele foi dito.** A
juncao entre "caixa do diagrama" e "frame do video" nao precisa ser inventada —
precisa apenas deixar de ser texto solto e virar um campo.

```
ProcessNode ──▶ evidence[] ──▶ timestamp ──▶ frame da gravacao ──▶ print no PDF
```

Esse e o eixo da arquitetura inteira. Sem ele, alguem teria que casar print com
etapa na mao.

## 2. O problema que decide o desenho: onde extrair o frame

O instinto e "servidor baixa o MP4 e roda `ffmpeg -ss`". **Isso nao cabe neste
app.** As funcoes vivem no Vercel: sem binario de ffmpeg, teto de 300s no
`maxDuration`, memoria limitada e uma gravacao de reuniao facilmente passando de
centenas de MB. Seria preciso worker dedicado, fila e storage — exatamente a
Fase 3 que o `docs/architecture.md` adia de proposito.

**A saida e o navegador.** Um `<video>` consegue buscar um instante especifico
(`currentTime`) e o frame vai para um `<canvas>` com `drawImage`. Como o
streaming usa range requests, o browser **baixa so os pedacos necessarios** — nao
o arquivo inteiro. O video nunca passa pelo nosso servidor.

```
SharePoint/OneDrive ──range requests──▶ <video> no browser
                                            │ seek(t) + drawImage
                                            ▼
                                        <canvas> ──▶ PNG (dataURL)
```

Consequencia boa: **nenhuma infraestrutura nova.** Sem worker, sem fila, sem
storage de video, sem egress. E o PDF segue a mesma logica — o BPMN ja e SVG no
browser e os frames ja sao canvas, entao montar o PDF no cliente
(`pdf-lib`/`jsPDF`) evita mais uma rota serverless pesada.

## 3. Os quatro blocos

### A. Transcricao automatica via Graph  ·  *valor imediato, risco baixo*

Independente do PDF, e talvez o de maior retorno: hoje a transcricao entra por
copiar-e-colar.

```
GET /users/{userId}/onlineMeetings/{meetingId}/transcripts
GET .../transcripts/{id}/content?$format=text/vtt
```

O VTT ja vem com falante e timestamp — exatamente o que
`src/transcriptToMinutes.ts` espera. Um parser de VTT (deterministico, testavel,
sem IA) substitui o campo de colar texto.

Para saber que a gravacao ficou pronta, o Graph tem notificacao de mudanca sobre
os recursos de gravacao/transcricao do tenant, em vez de ficar consultando.

### B. Timestamp estruturado na evidencia  ·  *pre-requisito do C*

Hoje `evidence` tem `quote`, `document_id`, `page`, `chunk_id`. Falta o tempo.

```jsonc
"evidence": {
  "quote": "...",
  "speaker": "Speaker 2",     // novo
  "t_start": "00:04:06",      // novo — o que liga ao frame
  "meeting_id": "..."         // novo — de qual reuniao
}
```

Preferir campo a regex sobre a `quote`: o formato do texto e sugestao de prompt,
nao contrato. Extrair timestamp com expressao regular sobre saida de LLM e o tipo
de acoplamento que quebra em silencio meses depois.

Custo: mexer no schema, nos dois prompts e regerar tipos. **Sem chamada de IA
extra** — o modelo ja escreve o timestamp, so passa a escrever em campo proprio.

### C. Captura dos frames  ·  *o coracao*

Para cada no com `t_start`, buscar o instante e capturar. Refinamentos que valem:

- capturar em `t_start - 2s` (a fala costuma vir depois do que se mostra na tela);
- deixar o especialista **reposicionar** o frame de uma etapa (um seletor de
  tempo), porque o instante automatico as vezes pega a transicao errada;
- redimensionar para ~1280px e exportar em JPEG antes de embutir — senao o PDF
  passa de 100 MB.

### D. O PDF

```
┌───────────────────────────────────┐
│  [logo Alpar]   Nome do processo  │
│  ┌─────────────────────────────┐  │
│  │   BPMN renderizado (SVG)    │  │  ← pagina 1
│  └─────────────────────────────┘  │
├───────────────────────────────────┤
│  Como foi feito                   │  ← origem, data, participantes,
│                                   │    modelo usado, custo
├───────────────────────────────────┤
│  1. Iniciar clone de producao     │  ← `name` (rotulo curto)
│     <detail por extenso>          │  ← `detail`
│     "citacao — Speaker 2, 00:00:28"│  ← evidence
│     ┌───────────┐                 │
│     │  print    │                 │  ← frame em t_start
│     └───────────┘                 │
└───────────────────────────────────┘
```

O ajuste `name`/`detail` (ja implementado) e o que faz esta pagina funcionar: o
rotulo curto vira titulo do item e o `detail` vira o paragrafo. Sem essa
separacao, o relatorio repetiria a mesma frase longa no diagrama e no texto.

## 4. Pre-requisitos de tenant (o que costuma travar)

Nao sao detalhes de implementacao — sao **bloqueios de infraestrutura** que
dependem do admin do Microsoft 365 e devem ser resolvidos antes de escrever
codigo:

1. **Registro de app no Entra ID** com consentimento do administrador.
2. **Permissoes de aplicacao** para transcricao e gravacao de reunioes online, e
   leitura do arquivo no OneDrive/SharePoint.
3. **Application Access Policy**: para acesso app-only a reunioes, o Teams exige
   uma politica configurada por PowerShell pelo admin, autorizando o app a agir
   sobre as reunioes de determinados usuarios. **Este e o passo que mais
   surpreende** — sem ele, a permissao concedida no portal ainda retorna 403.
4. **Gravacao e transcricao ligadas** por politica de reuniao no tenant.
5. **Consentimento dos participantes / LGPD**: a gravacao vira material anexado a
   um documento de processo. Vale definir retencao e quem pode ver o PDF.

## 5. Riscos e o que precisa de spike

| risco | por que importa | como resolver |
| --- | --- | --- |
| CORS no download do video | se a URL pre-autenticada do SharePoint nao permitir leitura cross-origin, a captura no browser **nao funciona** e o desenho muda | **spike primeiro** — e a premissa de que tudo depende |
| Application Access Policy | 403 mesmo com permissao concedida | validar com o admin cedo |
| Latencia da gravacao | o arquivo demora a ficar disponivel apos a reuniao | notificacao de mudanca, nao polling |
| Tamanho do PDF | dezenas de prints em PNG estouram o arquivo | reamostrar + JPEG |
| Codec do MP4 | o browser precisa saber decodificar para buscar o frame | verificar no mesmo spike do CORS |

## 6. Ordem sugerida

**A** (transcricao automatica) entrega valor sozinha e nao depende de nada do
resto — comeca por ela. **B** e barato e destrava **C**. **C** so comeca depois
do spike de CORS/codec. **D** e o ultimo e o mais previsivel.

O unico item que pode invalidar o desenho e o spike do bloco C. Se o browser nao
puder ler o video, a alternativa e um worker com ffmpeg em container (o
`Dockerfile` do projeto ja serviria de base) — o que antecipa parte da Fase 3 e
muda a conta de infraestrutura.

---

**Nota de verificacao:** os nomes exatos de endpoints e permissoes do Graph acima
vieram de conhecimento previo e **devem ser conferidos na documentacao atual da
Microsoft** antes da implementacao — essa area muda de nome com frequencia
(varios recursos de reuniao ja passaram por beta). A arquitetura nao depende dos
nomes; depende de existir acesso a transcricao, a gravacao e ao timestamp.
