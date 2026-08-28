import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const leads = sqliteTable('leads', {
  id: text('id').primaryKey(),
  businessName: text('business_name').notNull(),
  instagramUsername: text('instagram_username'),
  instagramUrl: text('instagram_url'),
  phone: text('phone'),
  whatsapp: text('whatsapp'),
  email: text('email'),
  address: text('address'),
  neighborhood: text('neighborhood'),
  city: text('city'),
  state: text('state'),
  category: text('category'),
  subcategory: text('subcategory'),
  followers: integer('followers'),
  instagramActive: integer('instagram_active', { mode: 'boolean' }),
  hasDelivery: integer('has_delivery', { mode: 'boolean' }),
  hasDiningRoom: integer('has_dining_room', { mode: 'boolean' }),
  hasWaiters: integer('has_waiters', { mode: 'boolean' }),
  hasMultipleUnits: integer('has_multiple_units', { mode: 'boolean' }),
  hasOnlineOrdering: integer('has_online_ordering', { mode: 'boolean' }),
  estimatedSize: text('estimated_size'),
  estimatedOperationComplexity: text('estimated_operation_complexity'),
  currentSystem: text('current_system'),
  painPoints: text('pain_points'), // JSON string
  notes: text('notes'),
  source: text('source'),
  leadScore: integer('lead_score'),
  qualificationStatus: text('qualification_status'),
  pipelineStage: text('pipeline_stage').notNull().default('NOVO'),
  firstContactAt: integer('first_contact_at', { mode: 'timestamp' }),
  lastContactAt: integer('last_contact_at', { mode: 'timestamp' }),
  nextFollowUpAt: integer('next_follow_up_at', { mode: 'timestamp' }),
  doNotContact: integer('do_not_contact', { mode: 'boolean' }).default(false),
  conversationProvider: text('conversation_provider').default('BROWSER'), // BROWSER | META_API | MANUAL
  metaPsid: text('meta_psid'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, (table) => {
  return {
    instagramIdx: uniqueIndex('instagram_idx').on(table.instagramUsername),
    phoneIdx: uniqueIndex('phone_idx').on(table.phone),
  };
});

export const settings = sqliteTable('settings', {
  id: text('id').primaryKey(),
  name: text('name'),
  commercialName: text('commercial_name'),
  instagram: text('instagram'),
  whatsapp: text('whatsapp'),
  phone: text('phone'),
  email: text('email'),
  city: text('city'),
  territory: text('territory'),
  representedCompany: text('represented_company').default('Sirrus'),
  role: text('role'),
  institutionalText: text('institutional_text'),
  // AI config
  aiAnalysisModel: text('ai_analysis_model').default('gpt-4o-mini'),
  aiMessageModel: text('ai_message_model').default('gpt-4o-mini'),
  // Prospecting config
  dailyQueueSize: integer('daily_queue_size').default(10),
  minScoreForQueue: integer('min_score_for_queue').default(0),
  followUpDays: integer('follow_up_days').default(3),
  maxFollowUps: integer('max_follow_ups').default(2),
  operationalMode: text('operational_mode').default('ASSISTIDO'),
});

export const activities = sqliteTable('activities', {
  id: text('id').primaryKey(),
  leadId: text('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
  type: text('type').notNull(), // LEAD_CREATED | AI_ANALYSIS | MESSAGE_GENERATED | MESSAGE_SENT | MESSAGE_RECEIVED | NOTE | WHATSAPP_MOVED | DEMO_SCHEDULED | PROPOSAL | PIPELINE_CHANGED
  channel: text('channel'),    // INSTAGRAM | WHATSAPP | EMAIL | MANUAL
  direction: text('direction'), // INBOUND | OUTBOUND
  content: text('content'),
  metadata: text('metadata'), // JSON string
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  leadId: text('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  title: text('title').notNull(),
  dueAt: integer('due_at', { mode: 'timestamp' }),
  completedAt: integer('completed_at', { mode: 'timestamp' }),
  status: text('status').notNull().default('PENDING'),
  notes: text('notes'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});

export const demos = sqliteTable('demos', {
  id: text('id').primaryKey(),
  leadId: text('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
  scheduledAt: integer('scheduled_at', { mode: 'timestamp' }).notNull(),
  type: text('type').notNull(),
  status: text('status').notNull().default('AGENDADA'),
  notes: text('notes'),
  result: text('result'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
});
