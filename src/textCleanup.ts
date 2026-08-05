/**
 * Limpeza cosmetica de texto extraido de documentos/transcricoes, ANTES de gastar
 * tokens com a IA. Tudo aqui e deterministico e conservador: na duvida, deixa como
 * esta — corromper o texto e pior do que deixar um caractere feio passar.
 *
 * Os caracteres invisiveis (espaco nao separavel, hifen condicional, zero-width
 * space) sao construidos por `chr()` de proposito: escritos direto numa regex
 * eles somem no editor e o lint os rejeita.
 */

const chr = (code: number): string => String.fromCharCode(code);

const REPLACEMENT_CHAR = '�'; // o "?" losango que sobra quando a extracao perde o mapeamento
const NBSP = chr(0xa0); // espaco nao separavel
const SOFT_HYPHEN = chr(0xad); // hifen condicional
const ZERO_WIDTH = chr(0x200b); // zero-width space

/**
 * Mojibake classico: UTF-8 lido como Latin-1/CP1252 — "ReuniA~o" em vez de
 * "Reuniao". Detecta pelo par caracteristico (A-circunflexo/A-til seguido de um
 * byte de continuacao, 0x80-0xBF) e reinterpreta os bytes.
 */
const MOJIBAKE_PAIR = new RegExp(`[${chr(0xc2)}${chr(0xc3)}][${chr(0x80)}-${chr(0xbf)}]`);

function fixMojibake(text: string): string {
  if (!MOJIBAKE_PAIR.test(text)) return text;
  // So da para reinterpretar se TODO o texto couber em bytes (code points <= 0xFF);
  // se ja houver caractere fora disso, a releitura destruiria o resto.
  const points = [...text];
  if (points.some((c) => c.charCodeAt(0) > 0xff)) return text;
  const bytes = Uint8Array.from(points.map((c) => c.charCodeAt(0)));
  const decoded = new TextDecoder('utf-8').decode(bytes);
  // Se a releitura introduziu U+FFFD, ela piorou o texto -> mantem o original.
  return decoded.includes(REPLACEMENT_CHAR) ? text : decoded;
}

/**
 * Substituicoes pontuais de caracteres que extratores de PDF costumam emitir
 * (ligaduras, aspas tipograficas, espacos exoticos). Nao mexe em acentuacao.
 */
const CHAR_FIXES: [RegExp, string][] = [
  [new RegExp(NBSP, 'g'), ' '],
  [new RegExp(`[${SOFT_HYPHEN}${ZERO_WIDTH}]`, 'g'), ''],
  [/[‘’‛]/g, "'"], // aspas simples tipograficas
  [/[“”‟]/g, '"'], // aspas duplas tipograficas
  [/–/g, '-'], // en dash
  [/ﬁ/g, 'fi'], // ligadura fi
  [/ﬂ/g, 'fl'], // ligadura fl
];

/**
 * Blocos de 3+ replacement chars so poluem — viram um espaco. Ocorrencias
 * isoladas ficam: a IA reconstroi a palavra pelo contexto (ex.: "Reuni??o").
 */
const REPLACEMENT_RUN = new RegExp(`${REPLACEMENT_CHAR}{3,}`, 'g');

/** Aplica as correcoes cosmeticas e normaliza quebras/espacos. */
export function cleanText(text: string): string {
  let out = fixMojibake(text);
  for (const [pattern, replacement] of CHAR_FIXES) out = out.replace(pattern, replacement);
  out = out.replace(REPLACEMENT_RUN, ' ');
  return out
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Heuristica: o texto parece uma transcricao (marcas de tempo + rotulos de
 * speaker)? Usada so para SUGERIR o modo transcricao no frontend — a escolha
 * final e sempre do usuario.
 */
export function looksLikeTranscript(text: string): boolean {
  const head = text.slice(0, 8000);
  const timestamps = head.match(/^\s*\d{1,2}:\d{2}(:\d{2})?\b/gm)?.length ?? 0;
  const speakers = head.match(/\b(Speaker|Falante|Participante)\s*\d+/gi)?.length ?? 0;
  return timestamps >= 5 || speakers >= 5;
}
