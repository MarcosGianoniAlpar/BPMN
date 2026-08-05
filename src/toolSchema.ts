/**
 * Adapta um JSON Schema do repositorio para servir de `input_schema` de uma
 * ferramenta da IA. Duas transformacoes, cada uma com sua propria historia.
 *
 * 1. ACHATA OS `$ref` LOCAIS (custou uma geracao paga para descobrir):
 * com os itens de cada array atras de `{ "$ref": "#/$defs/..." }`, o modelo NAO
 * enxergou as propriedades e chamou a ferramenta preenchida com os marcadores de
 * template — `$PARAMETER_NAME` / `$PARAMETER_VALUE` — em vez do ProcessSpec. Nao
 * houve erro em lugar nenhum: a chamada "deu certo", foi cobrada, e so quebrou
 * la na frente, na validacao, como "faltam process, nodes e flows".
 * O schema da ata, que sempre funcionou, nao tem um `$ref` sequer.
 *
 * 2. REMOVE OS KEYWORDS QUE A SAIDA ESTRUTURADA NAO ACEITA, para que o
 * `strict: true` possa ser ligado nas ferramentas. O `strict` compila o schema
 * numa gramatica e restringe a amostragem do modelo aos tokens validos — e o que
 * torna IMPOSSIVEL o defeito que o `normalizarColecoes` remenda hoje (`nodes`
 * chegando como string de JSON, como mapa por id ou agrupado por processo).
 * Um keyword nao suportado no schema devolve **400**, entao a poda nao e
 * cosmetica: sem ela o `strict` nem sobe.
 *
 * O arquivo do schema CONTINUA com `$defs` e com os keywords podados, porque
 * quem os usa e outro: o **Ajv** valida com eles (`minLength`, `minimum`) e o
 * `npm run gen:types` depende dos `$defs` para gerar tipos nomeados (NodeType,
 * ProcessNode, Flow...). Quem recebe a versao adaptada e so a API — a garantia
 * continua existindo, so muda quem a aplica.
 */

type Json = Record<string, unknown>;

// Guarda contra ciclo: um `$ref` que aponta para um ancestral entraria em loop.
const MAX_PROFUNDIDADE = 30;

/**
 * Keywords que a saida estruturada NAO aceita — a lista e da referencia da API,
 * nao de memoria. Um deles no schema devolve 400 quando `strict: true` esta
 * ligado.
 *
 * O que ficou de fora desta lista, de proposito, porque E aceito:
 * - `pattern` — regex tem suporte proprio, e `^[A-Za-z_][A-Za-z0-9_]*$` usa
 *   apenas casamento total (`^...$`), classes de caractere e `*`.
 * - `minItems: 1` — a restricao documentada e a "arrays alem de `minItems` de
 *   0 ou 1", entao 1 passa. Se algum dia alguem escrever `minItems: 2`, ai sim
 *   quebra — e o teste em test/extractProcessSpec.test.ts avisa.
 * - `enum`, `const`, `format`, `required`, `additionalProperties: false`.
 */
const KEYWORDS_NAO_SUPORTADOS: readonly string[] = [
  // Constraints numericos.
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  // Constraints de string.
  'minLength',
  'maxLength',
  // Constraints de array alem de `minItems` 0/1.
  'maxItems',
  'uniqueItems',
];

/** Resolve um ponteiro JSON local (`#/$defs/x`) dentro do proprio schema. */
function resolverRef(raiz: Json, ref: string): unknown {
  if (!ref.startsWith('#/')) {
    throw new Error(`$ref externo nao suportado no schema de ferramenta: ${ref}`);
  }
  let alvo: unknown = raiz;
  for (const parte of ref.slice(2).split('/')) {
    const chave = parte.replace(/~1/g, '/').replace(/~0/g, '~');
    alvo = (alvo as Json | undefined)?.[chave];
    if (alvo === undefined) throw new Error(`$ref nao encontrado: ${ref}`);
  }
  return alvo;
}

function percorrer(no: unknown, raiz: Json, profundidade: number): unknown {
  if (profundidade > MAX_PROFUNDIDADE) {
    throw new Error('$ref aninhado demais no schema (ciclo?).');
  }
  if (Array.isArray(no)) return no.map((item) => percorrer(item, raiz, profundidade + 1));
  if (!no || typeof no !== 'object') return no;

  const obj = no as Json;
  if (typeof obj.$ref === 'string') {
    const alvo = percorrer(resolverRef(raiz, obj.$ref), raiz, profundidade + 1) as Json;
    // Irmaos do $ref (ex.: uma `description` propria) vencem o alvo.
    const irmaos: Json = { ...obj };
    delete irmaos.$ref;
    return { ...alvo, ...irmaos };
  }

  const saida: Json = {};
  for (const [chave, valor] of Object.entries(obj)) {
    if (KEYWORDS_NAO_SUPORTADOS.includes(chave)) continue;
    // `properties` e `$defs` sao MAPAS DE NOMES, nao schemas. A distincao
    // importa: uma propriedade que por acaso se chame `minLength` seria podada
    // como se fosse keyword, e a ferramenta perderia um campo inteiro.
    saida[chave] =
      chave === 'properties' || chave === '$defs'
        ? percorrerMapaDeNomes(valor, raiz, profundidade + 1)
        : percorrer(valor, raiz, profundidade + 1);
  }
  return saida;
}

/** Percorre um mapa nome -> schema, preservando os nomes e adaptando os valores. */
function percorrerMapaDeNomes(no: unknown, raiz: Json, profundidade: number): unknown {
  if (!no || typeof no !== 'object' || Array.isArray(no)) {
    return percorrer(no, raiz, profundidade);
  }
  const saida: Json = {};
  for (const [nome, valor] of Object.entries(no as Json)) {
    saida[nome] = percorrer(valor, raiz, profundidade + 1);
  }
  return saida;
}

/**
 * Devolve o schema sem `$ref` e sem os keywords que a saida estruturada recusa,
 * pronto para virar `input_schema` de uma ferramenta com `strict: true`.
 */
export function inlineSchemaRefs(schema: unknown): Json {
  const raiz = schema as Json;
  const achatado = percorrer(raiz, raiz, 0) as Json;
  // Metadados que so servem ao arquivo; na definicao da ferramenta sao ruido.
  delete achatado.$defs;
  delete achatado.$schema;
  delete achatado.$id;
  return achatado;
}
