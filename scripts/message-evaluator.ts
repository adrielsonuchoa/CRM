import { classifyPersonalizationSignals, type ApproachLead } from '../src/lib/approach-message';

export type Evaluation = { score: number; status: 'APROVADO' | 'REVISAR' | 'REPROVADO'; penalties: string[]; details: Record<string, number> };
const includes = (text: string, pattern: RegExp) => pattern.test(text.toLowerCase());

export function evaluateMessage(lead: ApproachLead, message: string): Evaluation {
  const text = message.trim();
  const signals = classifyPersonalizationSignals(lead);
  const penalties: string[] = [];
  const questionCount = (text.match(/\?/g) ?? []).length;
  const words = text.split(/\s+/).length;
  const hasStrongReference = signals.strong.some((s) => {
    const patterns: Record<string, RegExp> = { delivery: /delivery|entrega/, whatsapp: /whatsapp/, reservations: /reserva/, dining_room: /sal[aã]o|mesa|comanda/, pickup: /retirada|retirar/, digital_menu: /card[aá]pio|pedido online/, multiple_units: /unidades?|lojas?/, buffet: /buffet/, rodizio: /rod[ií]zio/, drive_thru: /drive[-‑–— ]?thru/ };
    return includes(text, patterns[s.kind]);
  });
  const forbiddenInvented: Array<[boolean, RegExp, string]> = [
    [!signals.strong.some(s => s.kind === 'delivery'), /delivery|entrega em casa|fazem? entrega/, 'delivery inventado'],
    [!signals.strong.some(s => s.kind === 'whatsapp'), /whatsapp/, 'WhatsApp inventado'],
    [!signals.strong.some(s => s.kind === 'reservations'), /reserva/, 'reservas inventadas'],
    [lead.hasDiningRoom !== true, /atendem? no sal[aã]o/, 'salão inventado'],
    [lead.hasMultipleUnits !== true, /m[uú]ltiplas unidades|mais de uma unidade/, 'unidades inventadas'],
    [!signals.strong.some(s => s.kind === 'pickup'), /retirada|retirar no local/, 'retirada inventada'],
    [!signals.strong.some(s => s.kind === 'digital_menu'), /card[aá]pio digital|pedidos? online/, 'cardápio digital inventado'],
    [!signals.strong.some(s => s.kind === 'buffet'), /buffet/, 'buffet inventado'],
    [!signals.strong.some(s => s.kind === 'rodizio'), /rod[ií]zio/, 'rodízio inventado'],
    [!signals.strong.some(s => s.kind === 'drive_thru'), /drive[-‑–— ]?thru/, 'drive-thru inventado'],
  ];
  let hallucination = false;
  for (const [invalid, pattern, label] of forbiddenInvented) if (invalid && includes(text, pattern)) { penalties.push(label); hallucination = true; }
  if (/\b\d+[.,]?\d*\s*(k|mil)?\s*seguidores|seguidores|alcance do perfil/.test(text.toLowerCase())) penalties.push('seguidores mencionados');
  if (/n[uú]mero de posts|publica[cç][oõ]es/.test(text.toLowerCase())) penalties.push('posts mencionados');
  if (/vi que voc[eê]s s[aã]o (um|uma)|percebi que voc[eê]s s[aã]o/.test(text.toLowerCase())) penalties.push('personalização óbvia');
  if (/gostaria de saber|venho por meio|solu[cç][oõ]es inovadoras/.test(text.toLowerCase())) penalties.push('linguagem formal/corporativa');
  if (signals.strong.length === 0 && /vi que|percebi que|notei que/.test(text.toLowerCase())) penalties.push('alegação de observação sem sinal forte');
  if (signals.strong.length === 0 && /bem movimentad[oa]|muitos clientes|card[aá]pio (variado|diversificado)/.test(text.toLowerCase())) {
    penalties.push('característica inventada');
    hallucination = true;
  }
  if (/reuni[aã]o|demonstra[cç][aã]o|agendar/.test(text.toLowerCase())) penalties.push('tentativa de reunião imediata');
  if (questionCount !== 1) penalties.push(`${questionCount} perguntas`);
  if (words > 85) penalties.push('mensagem longa');
  if (signals.strong.length > 0 && !hasStrongReference) penalties.push('sinal forte ignorado');

  const naturality = Math.max(0, 25 - (penalties.some(p => p.includes('formal')) ? 12 : 0) - (words > 85 ? 8 : 0));
  const personalization = signals.strong.length ? (hasStrongReference ? 25 : 8) : (penalties.includes('personalização óbvia') ? 8 : 23);
  const objectivity = words <= 65 ? 15 : words <= 85 ? 10 : 4;
  const question = questionCount === 1 ? 15 : questionCount === 0 ? 3 : 7;
  const context = /sirrus/i.test(text) ? 10 : 5;
  const variation = 8;
  let score = naturality + personalization + objectivity + question + context + variation;
  score -= penalties.filter(p => !p.includes('sinal forte') && !p.includes('perguntas') && p !== 'mensagem longa').length * 8;
  if (hallucination) score = Math.min(score, 49);
  if (penalties.includes('seguidores mencionados')) score = Math.min(score, 69);
  score = Math.max(0, Math.min(100, score));
  return { score, status: hallucination || score < 70 ? 'REPROVADO' : score < 85 ? 'REVISAR' : 'APROVADO', penalties, details: { naturalidade: naturality, personalizacao: personalization, objetividade: objectivity, pergunta: question, contexto: context, variacao: variation } };
}
