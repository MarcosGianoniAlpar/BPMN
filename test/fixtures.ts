/**
 * Fixtures de ProcessSpec para os testes. Nada aqui chama a IA: sao specs
 * sinteticos escritos a mao, que e justamente o ponto — a metade determinista do
 * pipeline (validacao, compilacao, layout, cor) tem que ser testavel sem gastar
 * um centavo de API.
 *
 * Lembrete ao editar: o schema exige que todo `id` case com
 * `^[A-Za-z_][A-Za-z0-9_]*$` — sem hifen, sem acento.
 */

import type { ProcessSpec } from '../src/types/process-spec.js';

/**
 * O menor spec que passa em `validateProcessSpec`: inicio -> tarefa -> fim.
 * Ponto de partida para os testes que querem mudar UMA coisa e ver o efeito.
 */
export function specSimples(): ProcessSpec {
  return {
    process: { id: 'Compra', name: 'Solicitacao de compra' },
    nodes: [
      { id: 'inicio', type: 'start_event', name: 'Necessidade identificada' },
      {
        id: 'preencher',
        type: 'user_task',
        // Rotulo curto na caixa; o texto por extenso fica em `detail`.
        name: 'Preencher solicitacao',
        detail:
          'O solicitante preenche o formulario de compra com item, quantidade e ' +
          'centro de custo, antes de enviar para aprovacao.',
      },
      { id: 'fim', type: 'end_event', name: 'Compra concluida' },
    ],
    flows: [
      { id: 'f1', source: 'inicio', target: 'preencher' },
      { id: 'f2', source: 'preencher', target: 'fim' },
    ],
  };
}

/**
 * Spec com raias, participante externo e um gateway exclusivo com dois rotulos
 * ("Sim"/"Nao"). Este e o caso que exercita o `laneLayout`: pool interno com
 * faixas, pool caixa-preta externo e rotulo de aresta.
 */
export function specComRaias(): ProcessSpec {
  return {
    process: { id: 'Aprovacao', name: 'Aprovacao de compra' },
    participants: [
      { id: 'alpar', name: 'Alpar', type: 'internal' },
      { id: 'fornecedor', name: 'Fornecedor', type: 'external' },
    ],
    lanes: [
      { id: 'solicitante', name: 'Solicitante', participant_id: 'alpar' },
      { id: 'gerencia', name: 'Gerencia', participant_id: 'alpar' },
    ],
    nodes: [
      { id: 'inicio', type: 'start_event', name: 'Pedido recebido', lane_id: 'solicitante' },
      { id: 'analisar', type: 'user_task', name: 'Analisar pedido', lane_id: 'gerencia' },
      { id: 'decidir', type: 'exclusive_gateway', name: 'Aprovado?', lane_id: 'gerencia' },
      { id: 'comprar', type: 'service_task', name: 'Emitir ordem', lane_id: 'solicitante' },
      { id: 'fim', type: 'end_event', name: 'Processo encerrado', lane_id: 'solicitante' },
    ],
    flows: [
      { id: 'f1', source: 'inicio', target: 'analisar' },
      { id: 'f2', source: 'analisar', target: 'decidir' },
      { id: 'f3', source: 'decidir', target: 'comprar', name: 'Sim', condition: 'aprovado' },
      { id: 'f4', source: 'decidir', target: 'fim', name: 'Nao', condition: 'reprovado' },
      { id: 'f5', source: 'comprar', target: 'fim' },
    ],
  };
}

/**
 * Spec com uma volta (back-edge): reprovado volta para revisar. Existe porque o
 * calculo de camadas ja quebrou exatamente aqui — contar o ciclo empurrava os
 * nos do loop para a direita ate inverter a ordem do desenho.
 */
export function specComLoop(): ProcessSpec {
  return {
    process: { id: 'Revisao', name: 'Revisao de documento' },
    lanes: [{ id: 'analista', name: 'Analista' }],
    nodes: [
      { id: 'inicio', type: 'start_event', name: 'Documento recebido', lane_id: 'analista' },
      { id: 'revisar', type: 'user_task', name: 'Revisar documento', lane_id: 'analista' },
      { id: 'aprovado', type: 'exclusive_gateway', name: 'Aprovado?', lane_id: 'analista' },
      { id: 'fim', type: 'end_event', name: 'Documento aprovado', lane_id: 'analista' },
    ],
    flows: [
      { id: 'f1', source: 'inicio', target: 'revisar' },
      { id: 'f2', source: 'revisar', target: 'aprovado' },
      { id: 'f3', source: 'aprovado', target: 'fim', name: 'Sim', condition: 'sem ressalvas' },
      // A volta: reprovado retorna para a revisao.
      { id: 'f4', source: 'aprovado', target: 'revisar', name: 'Nao', condition: 'com ressalvas' },
    ],
  };
}

/**
 * Gateway com TRES saidas rotuladas — a cadeia de aprovacao por faixa de valor
 * da secao 3.1 da ata de PO. Existe por causa do L1: `routeEdge` faz toda saida
 * partir do mesmo ponto, entao com dois ramos os rotulos ainda se separavam pelo
 * destino, mas com tres eles caiam exatamente uns por cima dos outros —
 * "$5,000.01-$50,000" impresso sobre "Above $50,000".
 *
 * Em ingles de proposito: e o idioma do documento que revelou o caso, e rotulo
 * longo (17 caracteres) e justamente o que torna a sobreposicao ilegivel.
 */
export function specFaixaDeValor(): ProcessSpec {
  return {
    process: { id: 'Aprovacao_por_faixa', name: 'Approval by value tier' },
    lanes: [
      { id: 'requester', name: 'Requester' },
      { id: 'approvals', name: 'Approvals' },
    ],
    nodes: [
      { id: 'inicio', type: 'start_event', name: 'Requisition submitted', lane_id: 'requester' },
      { id: 'faixa', type: 'exclusive_gateway', name: 'Which value tier?', lane_id: 'approvals' },
      { id: 'gestor', type: 'user_task', name: 'Approve as manager', lane_id: 'approvals' },
      { id: 'financeiro', type: 'user_task', name: 'Approve as finance', lane_id: 'approvals' },
      { id: 'cfo', type: 'user_task', name: 'Approve as CFO', lane_id: 'approvals' },
      { id: 'fim', type: 'end_event', name: 'Requisition approved', lane_id: 'requester' },
    ],
    flows: [
      { id: 'f1', source: 'inicio', target: 'faixa' },
      {
        id: 'f2',
        source: 'faixa',
        target: 'gestor',
        name: 'Up to $5,000',
        condition: 'total <= 5000',
      },
      {
        id: 'f3',
        source: 'faixa',
        target: 'financeiro',
        name: '$5,000.01-$50,000',
        condition: 'total > 5000 and total <= 50000',
      },
      {
        id: 'f4',
        source: 'faixa',
        target: 'cfo',
        name: 'Above $50,000',
        condition: 'total > 50000',
      },
      { id: 'f5', source: 'gestor', target: 'fim' },
      { id: 'f6', source: 'financeiro', target: 'fim' },
      { id: 'f7', source: 'cfo', target: 'fim' },
    ],
  };
}

/**
 * Spec com a PONTE cortada: o fluxo `triagem -> conferir` apontava para um
 * gateway que a IA esqueceu de declarar, e a validacao reparavel o descartou.
 * Com uma seta a menos, TODO o resto do processo deixou de ser alcancavel a
 * partir do start. Este e o L2 — na rodada real foram ~19 nos empilhados numa
 * coluna so, e o estrago visual ficou ~3x maior que o semantico.
 */
export function specComPonteCortada(): ProcessSpec {
  return {
    process: { id: 'Ponte', name: 'Processo com a ponte cortada' },
    lanes: [{ id: 'time', name: 'Time' }],
    nodes: [
      { id: 'inicio', type: 'start_event', name: 'Pedido recebido', lane_id: 'time' },
      { id: 'triagem', type: 'user_task', name: 'Triar pedido', lane_id: 'time' },
      // Daqui para a frente, nada e alcancavel a partir do start.
      { id: 'conferir', type: 'user_task', name: 'Conferir dados', lane_id: 'time' },
      { id: 'registrar', type: 'service_task', name: 'Registrar pedido', lane_id: 'time' },
      { id: 'notificar', type: 'service_task', name: 'Notificar solicitante', lane_id: 'time' },
      { id: 'fim', type: 'end_event', name: 'Pedido concluido', lane_id: 'time' },
    ],
    flows: [
      { id: 'f1', source: 'inicio', target: 'triagem' },
      // f2 (triagem -> conferir) e o fluxo que a validacao descartou.
      { id: 'f3', source: 'conferir', target: 'registrar' },
      { id: 'f4', source: 'registrar', target: 'notificar' },
      { id: 'f5', source: 'notificar', target: 'fim' },
    ],
  };
}

/**
 * Spec que usa TODOS os tipos de no do schema. Serve para garantir que cada tipo
 * tem traducao BPMN e sobrevive a compilacao — um tipo novo adicionado ao schema
 * sem mapeamento quebra aqui, e nao no diagrama do usuario.
 */
export function specTodosOsTipos(): ProcessSpec {
  return {
    process: { id: 'Completo', name: 'Processo com todos os tipos' },
    nodes: [
      { id: 'inicio', type: 'start_event', name: 'Inicio' },
      { id: 'humana', type: 'user_task', name: 'Tarefa humana' },
      { id: 'automatica', type: 'service_task', name: 'Tarefa automatica' },
      { id: 'paralelo', type: 'parallel_gateway', name: 'Dividir' },
      { id: 'juntar', type: 'parallel_gateway', name: 'Juntar' },
      // Inclusivo: os dois ramos sao condicionados e o de cambio so roda em
      // parte dos casos — e por isso que o fechamento tambem tem de ser
      // inclusivo. Um `parallel_gateway` aqui esperaria para sempre pelo ramo
      // que nao rodou.
      { id: 'inclusivo_abre', type: 'inclusive_gateway', name: 'Quais checagens?' },
      { id: 'checar_orcamento', type: 'service_task', name: 'Checar orcamento' },
      { id: 'checar_cambio', type: 'service_task', name: 'Checar cambio' },
      { id: 'inclusivo_fecha', type: 'inclusive_gateway', name: 'Checagens concluidas?' },
      // Corrida: vale o que vier primeiro, a resposta ou o prazo.
      { id: 'corrida', type: 'event_based_gateway', name: 'Aguardar resposta ou prazo' },
      { id: 'espera_msg', type: 'message_event', name: 'Aguardar resposta' },
      { id: 'espera_tempo', type: 'timer_event', name: 'Aguardar 2 dias' },
      { id: 'escalar', type: 'user_task', name: 'Escalar por falta de resposta' },
      { id: 'decisao', type: 'exclusive_gateway', name: 'Segue?' },
      { id: 'fim', type: 'end_event', name: 'Fim' },
    ],
    flows: [
      { id: 'f1', source: 'inicio', target: 'paralelo' },
      { id: 'f2', source: 'paralelo', target: 'humana' },
      { id: 'f3', source: 'paralelo', target: 'automatica' },
      { id: 'f4', source: 'humana', target: 'juntar' },
      { id: 'f5', source: 'automatica', target: 'juntar' },
      { id: 'f6', source: 'juntar', target: 'inclusivo_abre' },
      {
        id: 'f7',
        source: 'inclusivo_abre',
        target: 'checar_orcamento',
        name: 'Sempre',
        condition: 'todo pedido passa pelo orcamento',
      },
      {
        id: 'f8',
        source: 'inclusivo_abre',
        target: 'checar_cambio',
        name: 'Se internacional',
        condition: 'fornecedor fora do pais',
      },
      { id: 'f9', source: 'checar_orcamento', target: 'inclusivo_fecha' },
      { id: 'f10', source: 'checar_cambio', target: 'inclusivo_fecha' },
      { id: 'f11', source: 'inclusivo_fecha', target: 'corrida' },
      // Saidas de event_based nao levam condicao: quem decide e o evento.
      { id: 'f12', source: 'corrida', target: 'espera_msg' },
      { id: 'f13', source: 'corrida', target: 'espera_tempo' },
      // O ramo que perde a corrida some; por isso os dois caminhos seguem
      // separados em vez de reconvergirem num gateway (que, alem de forkar e
      // juntar de uma vez so, e o que o bpmnlint acusa como erro).
      { id: 'f14', source: 'espera_msg', target: 'decisao' },
      { id: 'f15', source: 'espera_tempo', target: 'escalar' },
      { id: 'f16', source: 'decisao', target: 'fim', name: 'Sim', condition: 'ok' },
      { id: 'f17', source: 'decisao', target: 'humana', name: 'Nao', condition: 'refazer' },
      { id: 'f18', source: 'escalar', target: 'fim' },
    ],
  };
}
