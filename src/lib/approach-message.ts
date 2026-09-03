import OpenAI from 'openai';

export type ApproachLead = {
  businessName: string;
  category?: string | null;
  subcategory?: string | null;
  neighborhood?: string | null;
  city?: string | null;
  state?: string | null;
  currentSystem?: string | null;
  estimatedSize?: string | null;
  estimatedOperationComplexity?: string | null;
  notes?: string | null;
  profileSnippet?: string | null;
  hasDelivery?: boolean | null;
  hasDiningRoom?: boolean | null;
  hasWaiters?: boolean | null;
  hasOnlineOrdering?: boolean | null;
  hasMultipleUnits?: boolean | null;
  followers?: number | null;
  postsCount?: number | null;
  leadScore?: number | null;
  profileScore?: number | null;
};

export type PersonalizationSignal = {
  kind: 'delivery' | 'whatsapp' | 'reservations' | 'dining_room' | 'pickup' | 'digital_menu' | 'multiple_units' | 'buffet' | 'rodizio' | 'drive_thru';
  description: string;
};

export type ClassifiedApproachData = {
  strong: PersonalizationSignal[];
  weak: string[];
  internal: string[];
};

function readableNotes(lead: ApproachLead) {
  const raw = [lead.notes, lead.profileSnippet].filter(Boolean).join(' ');
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    return JSON.stringify(parsed);
  } catch {
    return raw;
  }
}

export function classifyPersonalizationSignals(lead: ApproachLead): ClassifiedApproachData {
  const strong: PersonalizationSignal[] = [];
  const add = (kind: PersonalizationSignal['kind'], description: string) => {
    if (!strong.some((signal) => signal.kind === kind)) strong.push({ kind, description });
  };

  if (lead.hasDelivery === true) add('delivery', 'trabalha com delivery');
  const evidence = readableNotes(lead).toLowerCase();
  if (/pedidos?\s+(pelo|via|no)\s+whatsapp|whatsapp\s+para\s+pedidos?/.test(evidence)) add('whatsapp', 'recebe pedidos pelo WhatsApp');
  if (/reservas?|reserve\s+(sua|uma)\s+mesa/.test(evidence)) add('reservations', 'trabalha com reservas');
  if (lead.hasDiningRoom === true) add('dining_room', 'atende no salão');
  if (/retirada|retire\s+(na|no)|take\s?away|pickup/.test(evidence)) add('pickup', 'oferece retirada');
  if (lead.hasOnlineOrdering === true || /card[aá]pio\s+digital|pedidos?\s+online/.test(evidence)) add('digital_menu', 'usa cardápio digital ou pedidos online');
  if (lead.hasMultipleUnits === true) add('multiple_units', 'possui múltiplas unidades');
  if (/buffet/.test(evidence)) add('buffet', 'trabalha com buffet');
  if (/rod[ií]zio/.test(evidence)) add('rodizio', 'trabalha com rodízio');
  if (/drive[- ]?thru/.test(evidence)) add('drive_thru', 'opera com drive-thru');

  const weak = [lead.category, lead.subcategory, lead.city, lead.neighborhood].filter((value): value is string => !!value);
  const internal = [
    lead.followers != null ? 'followers' : null,
    lead.postsCount != null ? 'postsCount' : null,
    lead.leadScore != null ? 'leadScore' : null,
    lead.profileScore != null ? 'profileScore' : null,
  ].filter((value): value is string => !!value);
  return { strong, weak, internal };
}

const strategyGuides: Record<string, string> = {
  Consultiva: 'Tom leve, humano e curioso, normalmente em 2 ou 3 frases. Busque entender a operação atual com uma pergunta simples e pouca pressão.',
  Local: 'Crie proximidade mencionando naturalmente a atuação local, sem alegar pesquisa detalhada.',
  Problema: 'Explore com cuidado uma única dor operacional compatível com o sinal escolhido.',
  Direta: 'Apresente-se objetivamente e faça uma pergunta simples, sem tentar fechar a venda.',
};

export function buildApproachPrompt(lead: ApproachLead, institutionalText: string, strategy = 'Consultiva') {
  const signals = classifyPersonalizationSignals(lead);
  const selectedSignal = signals.strong[0] ?? null;
  const structureIndex = [...lead.businessName].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 4;
  const structures = [
    'saudação → apresentação curta → contexto operacional → pergunta',
    'saudação → contexto operacional → apresentação curta → pergunta; não use a expressão "vi que"',
    'saudação → apresentação curta → pergunta contextualizada; não use a expressão "vi que"',
    'saudação → referência operacional direta → pergunta → identificação breve; não use a expressão "vi que"',
  ];
  const system = 'Você escreve primeiras DMs humanas para a Sirrus. O objetivo é obter uma resposta, não fechar uma venda. Use somente o sinal forte selecionado quando existir. Produza exatamente um ponto de interrogação na mensagem inteira. Nunca mencione seguidores, posts, scoring ou métricas internas. Nunca transforme categoria, cidade ou presença no Instagram em falsa personalização e nunca invente características, produtos ou cardápio.';
  const user = `Escreva uma primeira mensagem para Instagram Direct em português brasileiro.

CONTEXTO INSTITUCIONAL (somente contexto; não copie trechos longos):
${institutionalText.slice(0, 1200) || 'Não configurado.'}

DADOS PERMITIDOS:
- Nome: ${lead.businessName}
- Contexto fraco, apenas para compreensão: ${signals.weak.join(', ') || 'nenhum'}
- Sinal forte selecionado: ${selectedSignal?.description ?? 'nenhum'}
- Sistema atual: ${lead.currentSystem ?? 'não informado'}

ESTILO: ${strategy}
${strategyGuides[strategy] ?? strategyGuides.Consultiva}
ESTRUTURA DESTA MENSAGEM: ${structures[structureIndex]}

REGRAS:
1. Escreva de 2 a 4 frases curtas e termine com uma única pergunta fácil de responder. A mensagem inteira deve conter EXATAMENTE UM "?"; portanto, não use "Tudo bem?" nem qualquer pergunta adicional na saudação ou no contexto.
2. Se houver sinal forte selecionado, use-o uma única vez e de forma natural. Não liste outros dados.
3. Se não houver sinal forte, use uma abordagem simples; não diga que "viu" categoria, cidade, Instagram ou outra informação óbvia. Não invente cardápio, produtos, movimento, equipe, clientes ou características do negócio.
4. O nome pode aparecer na saudação, mas nunca encaixado no fim da pergunta.
5. É proibido usar "Gostaria de saber". Evite elogios genéricos, linguagem de e-mail, reunião, demonstração, preço ou pressão comercial.
6. Não invente nem troque o sinal selecionado por outro: retirada não é delivery; cardápio digital não confirma delivery; categoria não confirma salão. Não mencione delivery, WhatsApp, reservas, salão, retirada, cardápio, unidades ou outro fato que não seja o sinal selecionado.
7. Siga a estrutura indicada para esta mensagem com naturalidade. Ela existe para evitar repetição no conjunto e não é um template textual.
8. Retorne somente a mensagem final, sem aspas nem explicações.`;
  return { system, user, signals, selectedSignal };
}

export function isReasoningModel(model: string) {
  return /gemini-3|gemini-2\.5|gpt-oss|o1|o3|reasoning/i.test(model);
}

// Modelos Gemini (e outros modelos "reasoning") gastam parte do orçamento de
// tokens de saída com "thinking" interno antes de escrever a resposta final.
// Sem controlar isso, o modelo pode consumir quase todo o max_tokens só
// pensando e devolver a mensagem cortada no meio da frase (e demorar mais
// para responder). reasoning_effort limita esse gasto.
// Gemini 2.5 aceita 'none' (desliga o thinking); Gemini 3.x exige no mínimo 'low'.
export function getReasoningEffort(model: string): 'none' | 'low' | undefined {
  if (!isReasoningModel(model)) return undefined;
  if (/gemini-2\.5/i.test(model)) return 'none';
  return 'low';
}

export function isApproachMessageComplete(message: string) {
  const trimmed = message.trim();
  if (trimmed.length < 80) return false;
  if (!trimmed.endsWith('?')) return false;
  return (trimmed.match(/\?/g) ?? []).length === 1;
}

export function buildFallbackApproachMessage(lead: ApproachLead, selectedSignal?: PersonalizationSignal | null) {
  const greeting = lead.businessName ? `Oi, ${lead.businessName}!` : 'Oi!';
  return selectedSignal
    ? `${greeting} Sou da Sirrus aqui em Maceió. Sei que vocês ${selectedSignal.description} e queria entender melhor essa rotina. Como vocês organizam essa operação hoje?`
    : `${greeting} Sou da Sirrus aqui em Maceió. Queria entender como vocês fazem hoje a parte de pedidos, comandas e caixa. Vocês usam algum sistema para centralizar essa operação?`;
}

export function normalizeApproachMessage(message: string, lead?: ApproachLead, selectedSignal?: PersonalizationSignal | null) {
  let normalized = message.trim()
    .replace(/gostaria de saber/gi, 'queria entender')
    .replace(/\n{3,}/g, '\n\n');
  const lastQuestion = normalized.lastIndexOf('?');
  if (lastQuestion >= 0) {
    normalized = normalized.slice(0, lastQuestion).replace(/\?/g, '.') + normalized.slice(lastQuestion);
  }
  if (lead) {
    const lower = normalized.toLowerCase();
    const allowed = selectedSignal?.kind;
    const unsupported = [
      [allowed !== 'delivery', /delivery|entrega em casa/],
      [allowed !== 'whatsapp', /whatsapp/],
      [allowed !== 'reservations', /reservas?/],
      [allowed !== 'pickup', /retirada/],
      [allowed !== 'digital_menu', /card[aá]pio|pedidos? online/],
      [allowed !== 'multiple_units', /m[uú]ltiplas unidades|mais de uma unidade/],
      [true, /bem movimentad[oa]|muitos clientes|card[aá]pio (variado|diversificado)/],
    ].some(([invalid, pattern]) => invalid && (pattern as RegExp).test(lower));
    if (unsupported) {
      return buildFallbackApproachMessage(lead, selectedSignal);
    }
  }
  return normalized;
}

async function requestApproachCompletion(args: {
  client: OpenAI;
  model: string;
  system: string;
  user: string;
  maxOutputTokens: number;
}) {
  const createParams: Record<string, unknown> = {
    model: args.model,
    messages: [{ role: 'system', content: args.system }, { role: 'user', content: args.user }],
    temperature: 0.8,
  };
  const reasoningEffort = getReasoningEffort(args.model);
  if (reasoningEffort) {
    createParams.reasoning_effort = reasoningEffort;
  }
  if (isReasoningModel(args.model)) {
    createParams.max_completion_tokens = args.maxOutputTokens;
  } else {
    createParams.max_tokens = args.maxOutputTokens;
  }
  return args.client.chat.completions.create(createParams as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming);
}

export async function generateApproachMessage(args: {
  client: OpenAI;
  model: string;
  lead: ApproachLead;
  institutionalText: string;
  strategy?: string;
  fallbackModel?: string;
}) {
  const prompt = buildApproachPrompt(args.lead, args.institutionalText, args.strategy);
  const models = [...new Set([
    args.model,
    ...(args.fallbackModel && args.fallbackModel !== args.model ? [args.fallbackModel] : []),
  ])];

  let lastUsage: OpenAI.Completions.CompletionUsage | undefined;
  for (const model of models) {
    const maxOutputTokens = isReasoningModel(model) ? 4096 : 512;
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await requestApproachCompletion({
        client: args.client,
        model,
        system: prompt.system,
        user: prompt.user,
        maxOutputTokens: attempt === 0 ? maxOutputTokens : maxOutputTokens * 2,
      });
      const choice = response.choices[0];
      lastUsage = response.usage;
      const finishReason = choice?.finish_reason;
      if (finishReason && finishReason !== 'stop') {
        console.warn('[AI] generateApproachMessage finish_reason:', finishReason, 'model:', model, 'attempt:', attempt + 1);
      }
      const rawMessage = choice?.message.content?.trim();
      const message = rawMessage ? normalizeApproachMessage(rawMessage, args.lead, prompt.selectedSignal) : '';
      if (message && isApproachMessageComplete(message) && finishReason === 'stop') {
        return { message, prompt, usage: response.usage };
      }
      if (message && isApproachMessageComplete(message)) {
        return { message, prompt, usage: response.usage };
      }
    }
  }

  const fallbackMessage = buildFallbackApproachMessage(args.lead, prompt.selectedSignal);
  console.warn('[AI] generateApproachMessage using fallback template after incomplete generations');
  return { message: fallbackMessage, prompt, usage: lastUsage };
}
