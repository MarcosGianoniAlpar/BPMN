/* GERADO por 'npm run gen:types' a partir de schemas/meeting-minutes.schema.json. Nao editar a mao. */

/**
 * Ata de reuniao estruturada, extraida de uma transcricao crua. A IA le a fala solta e produz este objeto; um renderizador deterministico o transforma em Markdown, que por sua vez pode alimentar o pipeline de BPMN.
 */
export interface MeetingMinutes {
  meeting: {
    /**
     * Titulo curto da reuniao.
     */
    title: string;
    /**
     * Codigo ISO 639-1 do idioma em que VOCE escreveu esta ata, que e o mesmo da transcricao: "pt", "en", "es"... Serve para o renderizador escolher os titulos das secoes; se vier vazio ou desconhecido, ele usa portugues.
     */
    language?: string;
    /**
     * Data como aparece na transcricao. Vazio se nao houver.
     */
    date?: string;
    /**
     * Um paragrafo de pano de fundo.
     */
    context?: string;
    /**
     * Objetivo declarado da reuniao.
     */
    objective?: string;
  };
  /**
   * Quem falou. Use o nome quando o dialogo identificar a pessoa; senao mantenha o rotulo do transcritor (ex.: 'Speaker 2').
   */
  participants: {
    name: string;
    /**
     * Papel, cargo ou area, se dito.
     */
    role?: string;
  }[];
  /**
   * Discussao organizada por assunto — o corpo da ata. Prefira poucos topicos densos.
   */
  topics: {
    title: string;
    /**
     * Resumo em prosa limpa, 2 a 4 frases, fiel ao que foi dito.
     */
    summary: string;
    /**
     * Citacoes literais e curtas da transcricao. Formato: 'trecho literal — Speaker N, 00:12:34'.
     */
    evidence?: string[];
  }[];
  /**
   * Apenas o que foi DECIDIDO. 'Vamos avaliar' nao e decisao.
   */
  decisions?: {
    description: string;
    /**
     * Motivo declarado.
     */
    rationale?: string;
    /**
     * Nome de quem decidiu ou responde por ela.
     */
    owner?: string;
    /**
     * Citacoes literais e curtas. Formato: 'trecho — Speaker N, 00:12:34'.
     */
    evidence?: string[];
  }[];
  /**
   * Compromissos: quem faz o que, ate quando.
   */
  action_items?: {
    description: string;
    /**
     * Nome do responsavel.
     */
    owner?: string;
    /**
     * Prazo como foi dito, ex.: 'hoje a tarde'.
     */
    due?: string;
  }[];
  /**
   * O fluxo de trabalho acordado, em ordem. E esta secao que vira o diagrama BPMN.
   */
  process_flow: {
    /**
     * Nome do processo.
     */
    name: string;
    /**
     * O que o processo entrega ao final.
     */
    objective?: string;
    /**
     * O que dispara o processo (vira o evento de inicio).
     */
    trigger?: string;
    /**
     * Como o processo termina (vira o evento de fim).
     */
    outcome?: string;
    /**
     * Uma etapa por item, em ordem de execucao.
     */
    steps: {
      /**
       * Quem executa. Vira raia no diagrama — use sempre o mesmo rotulo para o mesmo executor.
       */
      actor: string;
      /**
       * A acao, comecando por verbo. Ex.: 'Clonar a instancia de producao'.
       */
      action: string;
      /**
       * 'sistema' quando quem executa e um software; 'externo' quando e uma organizacao de fora.
       */
      actor_type?: "pessoa" | "sistema" | "externo";
      /**
       * Pre-condicao para a etapa acontecer.
       */
      condition?: string;
      /**
       * Bifurcacoes, quando a etapa e uma decisao. Uma por item, no formato 'Se <condicao> entao <consequencia>'.
       */
      outcomes?: string[];
      /**
       * Citacoes literais e curtas. Formato: 'trecho — Speaker N, 00:12:34'.
       */
      evidence?: string[];
    }[];
  };
  /**
   * O que ficou sem definicao. NUNCA preencha uma lacuna com suposicao — registre aqui.
   */
  open_questions?: {
    question: string;
    /**
     * Por que ficou em aberto.
     */
    reason?: string;
  }[];
}
