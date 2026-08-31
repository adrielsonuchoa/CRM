import type { ApproachLead } from '../src/lib/approach-message';

export type MessageFixture = { id: string; lead: ApproachLead };
const base = (businessName: string, extra: Partial<ApproachLead> = {}): ApproachLead => ({ businessName, city: 'Maceió', state: 'AL', ...extra });

export const messageFixtures: MessageFixture[] = [
  { id: 'restaurant-delivery', lead: base('Manguezal', { category: 'Restaurante', hasDelivery: true }) },
  { id: 'restaurant-generic', lead: base('Sabor da Casa', { category: 'Restaurante' }) },
  { id: 'pizza-whatsapp', lead: base('Bella Pizza', { category: 'Pizzaria', notes: 'Pedidos pelo WhatsApp' }) },
  { id: 'burger-delivery', lead: base('Burger Central', { category: 'Hamburgueria', hasDelivery: true }) },
  { id: 'bar-generic', lead: base('Bar do Porto', { category: 'Bar' }) },
  { id: 'coffee-generic', lead: base('Café da Praça', { category: 'Cafeteria' }) },
  { id: 'reservations', lead: base('Bistrô Lagoa', { category: 'Restaurante', profileSnippet: 'Faça sua reserva de mesa' }) },
  { id: 'multiple-units', lead: base('Rede Sabor', { hasMultipleUnits: true }) },
  { id: 'digital-menu', lead: base('Cantina 21', { hasOnlineOrdering: true }) },
  { id: 'pickup', lead: base('Massa Rápida', { notes: 'Opção de retirada no balcão' }) },
  { id: 'many-followers-only', lead: base('Popular Grill', { category: 'Restaurante', followers: 120000, postsCount: 2400 }) },
  { id: 'few-followers-only', lead: base('Cantinho Bom', { followers: 80 }) },
  { id: 'many-data', lead: base('Operação Mix', { hasDelivery: true, hasDiningRoom: true, hasOnlineOrdering: true, hasMultipleUnits: true, notes: 'Reservas e retirada', followers: 45000 }) },
  { id: 'few-data', lead: { businessName: 'Casa Azul' } },
  { id: 'contradictory', lead: base('Sem Entrega', { hasDelivery: false, notes: 'Não fazemos delivery' }) },
  { id: 'unknown-null', lead: base('Ponto Certo', { hasDelivery: null, hasDiningRoom: null, hasOnlineOrdering: null }) },
  { id: 'instagram-metrics-only', lead: base('Perfil Métricas', { followers: 34000, postsCount: 900, profileScore: 92, leadScore: 88 }) },
  { id: 'category-only', lead: base('Pizza Norte', { category: 'Pizzaria' }) },
  { id: 'delivery-and-whatsapp', lead: base('Expresso Food', { hasDelivery: true, notes: 'Pedidos via WhatsApp' }) },
  { id: 'salon', lead: base('Mesa 12', { hasDiningRoom: true, hasWaiters: true }) },
  { id: 'buffet', lead: base('Celebrare', { notes: 'Buffet para eventos' }) },
  { id: 'rodizio', lead: base('Brasa Viva', { notes: 'Rodízio todos os dias' }) },
  { id: 'drive-thru', lead: base('Fast Grill', { profileSnippet: 'Drive-thru aberto até 23h' }) },
];
