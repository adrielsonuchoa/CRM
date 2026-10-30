-- Ciclo de vida do enriquecimento de Instagram por lead. Serve a dois
-- propositos: (1) cache - nao refazer uma busca externa que ja tem
-- resultado gravado; (2) recuperacao - um lead deixado em IN_PROGRESS por
-- um crash volta pra fila quando enrichment_attempted_at ficar velho o
-- suficiente. Valores: PENDING | IN_PROGRESS | DONE | FAILED
ALTER TABLE `leads` ADD `enrichment_status` text DEFAULT 'PENDING';
--> statement-breakpoint
ALTER TABLE `leads` ADD `enrichment_attempted_at` integer;
--> statement-breakpoint
-- Leads que ja foram enriquecidos com sucesso antes desta migracao
-- (profile_accepted = 1) nao podem voltar a ser pesquisados do zero.
UPDATE `leads` SET `enrichment_status` = 'DONE' WHERE `profile_accepted` = 1;
--> statement-breakpoint
-- Progresso de uma "busca direcionada" (quantidade desejada de leads pedida
-- na tela de Prospeccao). progress_run_id nulo = nenhuma busca direcionada
-- ativa; e isso que o cliente usa pra decidir se mostra o modal de
-- progresso.
ALTER TABLE `worker_state` ADD `progress_run_id` text;
--> statement-breakpoint
ALTER TABLE `worker_state` ADD `progress_target` integer;
--> statement-breakpoint
ALTER TABLE `worker_state` ADD `progress_found` integer DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `worker_state` ADD `progress_instagram_found` integer DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `worker_state` ADD `progress_validated` integer DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `worker_state` ADD `progress_discarded` integer DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `worker_state` ADD `progress_pending` integer DEFAULT 0;
