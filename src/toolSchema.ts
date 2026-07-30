/**
 * Achata os `$ref` locais de um JSON Schema, para uso como `input_schema` de uma
 * ferramenta da IA.
 *
 * POR QUE ISTO EXISTE (custou uma geracao paga para descobrir):
 * com os itens de cada array atras de `{ "$ref": "#/$defs/..." }`, o modelo NAO
 * enxergou as propriedades e chamou a ferramenta preenchida com os marcadores de
 * template — `$PARAMETER_NAME` / `$PARAMETER_VALUE` — em vez do ProcessSpec. Nao
 * houve erro em lugar nenhum: a chamada "deu certo", foi cobrada, e so quebrou
 * la na frente, na validacao, como "faltam process, nodes e flows".
 * O schema da ata, que sempre funcionou, nao tem um `$ref` sequer.
 *
 * O arquivo do schema CONTINUA com `$defs`, porque o Ajv resolve `$ref` sem
 * problema e o `npm run gen:types` depende deles para gerar tipos nomeados
 * (NodeType, ProcessNode, Flow...). Quem recebe a versao achatada e so a API.
 */

type Json = Record<string, unknown>;

// Guarda contra ciclo: um `$ref` que aponta para um ancestral entraria em loop.
const MAX_PROFUNDIDADE = 30;

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
    saida[chave] = percorrer(valor, raiz, profundidade + 1);
  }
  return saida;
}

/** Devolve o schema sem nenhum `$ref`, pronto para virar `input_schema`. */
export function inlineSchemaRefs(schema: unknown): Json {
  const raiz = schema as Json;
  const achatado = percorrer(raiz, raiz, 0) as Json;
  // Metadados que so servem ao arquivo; na definicao da ferramenta sao ruido.
  delete achatado.$defs;
  delete achatado.$schema;
  delete achatado.$id;
  return achatado;
}
