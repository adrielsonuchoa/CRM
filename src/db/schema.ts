import { sqliteTable, text, integer, real, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const leads = sqliteTable('leads', {
  id: text('id').primaryKey(),
  businessName: text('business_name').notNull(),
  instagramUsername: text('instagram_username'),
  instagramUrl: text('instagram_url'),
  googlePlaceId: text('google_place_id'),
  placeId: text('place_id'),
  googleMapsUrl: text('google_maps_url'),
  phone: text('phone'),
  whatsapp: text('whatsapp'),
  email: text('email'),
  website: text('website'),
  websiteDomain: text('website_domain'),
  address: text('address'),
  neighborhood: text('neighborhood'),
  city: text('city'),
  state: text('state'),
  category: text('category'),
  subcategory: text('subcategory'),
  followers: integer('followers'),
  rating: real('rating'),
  reviewCount: integer('review_count'),
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
  prospectingCities: text('prospecting_cities'), // JSON string
  prospectingSegments: text('prospecting_segments'), // JSON string
  prospectingSearchTerms: text('prospecting_search_terms'), // JSON string
  prospectingSources: text('prospecting_sources').default('["GEOAPIFY"]'), // JSON string
  maxProfilesPerRun: integer('max_profiles_per_run').default(20),
  maxApprovedLeadsPerDay: integer('max_approved_leads_per_day').default(5),
  minActionIntervalSeconds: integer('min_action_interval_seconds').default(90),
  ignorePrivateProfiles: integer('ignore_private_profiles', { mode: 'boolean' }).default(true),
  ignoreAlreadyAnalyzed: integer('ignore_already_analyzed', { mode: 'boolean' }).default(true),
  ignoreExistingLeads: integer('ignore_existing_leads', { mode: 'boolean' }).default(true),
  ignoreAlreadyContacted: integer('ignore_already_contacted', { mode: 'boolean' }).default(true),
  ignoreDuplicates: integer('ignore_duplicates', { mode: 'boolean' }).default(true),
  prospectionDryRun: integer('prospection_dry_run', { mode: 'boolean' }).default(true),
  autoReplyEnabled: integer('auto_reply_enabled', { mode: 'boolean' }).default(false),
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

export const workerState = sqliteTable('worker_state', {
  id: text('id').primaryKey(),
  status: text('status').notNull().default('PAUSED'),
  activity: text('activity'),
  chromeConnected: integer('chrome_connected', { mode: 'boolean' }).default(false),
  instagramProfile: text('instagram_profile'),
  lastError: text('last_error'),
  pausedReason: text('paused_reason'),
  dryRun: integer('dry_run', { mode: 'boolean' }).default(true),
  startedAt: integer('started_at', { mode: 'timestamp' }),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const dailyActionCounters = sqliteTable('daily_action_counters', {
  id: text('id').primaryKey(),
  day: text('day').notNull(),
  action: text('action').notNull(),
  count: integer('count').notNull().default(0),
  limit: integer('limit').notNull().default(0),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, (table) => {
  return {
    dayActionIdx: uniqueIndex('daily_action_counters_day_action_idx').on(table.day, table.action),
  };
});

export const webhookEvents = sqliteTable('webhook_events', {
  id: text('id').primaryKey(),
  provider: text('provider').notNull().default('META'),
  eventId: text('event_id').notNull(),
  leadId: text('lead_id').references(() => leads.id, { onDelete: 'set null' }),
  payloadHash: text('payload_hash').notNull(),
  processedAt: integer('processed_at', { mode: 'timestamp' }).notNull(),
}, (table) => {
  return {
    eventIdx: uniqueIndex('webhook_events_provider_event_idx').on(table.provider, table.eventId),
  };
});
