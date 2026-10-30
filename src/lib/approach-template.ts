// Mensagem de abordagem a partir de um modelo fixo - sem IA, sem custo. A IA
// do CRM fica so na busca/qualificacao de leads; o texto de abordagem e
// escrito pelo usuario ou parte deste modelo, e sempre pode ser editado.

export type ApproachLead = {
  businessName: string;
  notes?: string | null;
  profileSnippet?: string | null;
  hasDelivery?: boolean | null;
  hasDiningRoom?: boolean | null;
  hasOnlineOrdering?: boolean | null;
  hasMultipleUnits?: boolean | null;
};

// Descricoes ja na 3a pessoa do plural: "Sei que vocês <descricao>".
const SIGNALS: { test: (lead: ApproachLead, evidence: string) => boolean; description: string }[] = [
  { test: (lead) => lead.hasDelivery === true, description: 'trabalham com delivery' },
  { test: (_, e) => /pedidos?\s+(pelo|via|no)\s+whatsapp|whatsapp\s+para\s+pedidos?/.test(e), description: 'recebem pedidos pelo WhatsApp' },
  { test: (_, e) => /reservas?|reserve\s+(sua|uma)\s+mesa/.test(e), description: 'trabalham com reservas' },
  { test: (lead) => lead.hasDiningRoom === true, description: 'atendem no salão' },
  { test: (_, e) => /retirada|retire\s+(na|no)|take\s?away|pickup/.test(e), description: 'oferecem retirada no local' },
  { test: (lead, e) => lead.hasOnlineOrdering === true || /card[aá]pio\s+digital|pedidos?\s+online/.test(e), description: 'usam cardápio digital ou pedidos online' },
  { test: (lead) => lead.hasMultipleUnits === true, description: 'têm mais de uma unidade' },
  { test: (_, e) => /buffet/.test(e), description: 'trabalham com buffet' },
  { test: (_, e) => /rod[ií]zio/.test(e), description: 'trabalham com rodízio' },
  { test: (_, e) => /drive[- ]?thru/.test(e), description: 'operam com drive-thru' },
];

export function findPersonalizationSignal(lead: ApproachLead): string | null {
  const evidence = [lead.notes, lead.profileSnippet].filter(Boolean).join(' ').toLowerCase();
  return SIGNALS.find((signal) => signal.test(lead, evidence))?.description ?? null;
}

export function buildApproachTemplate(lead: ApproachLead): string {
  const greeting = lead.businessName ? `Oi, ${lead.businessName}!` : 'Oi!';
  const signal = findPersonalizationSignal(lead);
  return signal
    ? `${greeting} Sou da Sirrus aqui em Maceió. Sei que vocês ${signal} e queria entender melhor essa rotina. Como vocês organizam essa operação hoje?`
    : `${greeting} Sou da Sirrus aqui em Maceió. Queria entender como vocês fazem hoje a parte de pedidos, comandas e caixa. Vocês usam algum sistema para centralizar essa operação?`;
}
