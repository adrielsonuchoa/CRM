import { normalizeWhatsAppNumber } from '@/lib/phone';

// Estagio usado quando um candidato nao tem nenhum contato verificavel
// (nem Instagram validado, nem telefone/WhatsApp) - fica fora da fila de
// Prospeccao e do Kanban pelo mesmo mecanismo ja usado por DESCARTADO
// (simplesmente nao esta nas listas de inArray dessas telas), e nunca volta
// a ser recriado porque o lead continua existindo como linha em `leads`
// (o indice de duplicidade do Geoapify enxerga ele).
export const NO_CONTACT_STAGE = 'DESCARTADO_SEM_CONTATO';

// Mesma lista que ja existia duplicada em dois pontos de browser-worker.ts
// (o loop de descoberta e a resolucao pos-enriquecimento) - centralizada
// aqui pra so ter uma fonte de verdade.
export const PRE_CONTACT_STAGES = [
  'DESCOBERTO',
  'ANALISANDO',
  'NOVO',
  'PESQUISANDO',
  'QUALIFICADO',
  'AGUARDANDO_CONTATO',
  'PRONTO PARA CONTATO',
] as const;

export type ContactCandidate = {
  instagramUsername?: string | null;
  profileAccepted?: boolean | null;
  whatsapp?: string | null;
  phone?: string | null;
};

// Regra central: um lead so pode seguir no fluxo se tiver pelo menos um
// canal de contato verificavel - Instagram validado com confianca
// (profileAccepted, gravado por instagram-enrichment.ts) OU um
// telefone/WhatsApp que normalize pra um numero valido.
export function hasVerifiableContact(lead: ContactCandidate): boolean {
  const instagramOk = lead.profileAccepted === true && !!lead.instagramUsername;
  const whatsappOk = normalizeWhatsAppNumber(lead.whatsapp ?? lead.phone) !== null;
  return instagramOk || whatsappOk;
}
