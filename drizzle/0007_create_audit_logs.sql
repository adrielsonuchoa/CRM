-- Correção: a migração 0006_redundant_hawkeye.sql criou as tabelas `users`
-- e `user_permissions`, mas por causa de um histórico de migrações
-- inconsistente neste projeto (faltam os snapshots 0002-0005 em
-- drizzle/meta/, então o drizzle-kit não conseguiu calcular o diff
-- corretamente), a tabela `audit_logs` do schema.ts nunca foi de fato
-- incluída em nenhuma migração aplicada. Sem isso, toda chamada de
-- logAudit() (login, criação de usuário, mudança de pipeline, etc.) falharia
-- com "no such table: audit_logs" assim que o banco novo do Turso fosse
-- usado. `IF NOT EXISTS` deixa este arquivo seguro de rodar mesmo se, por
-- algum motivo, a tabela já existir.
CREATE TABLE IF NOT EXISTS `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`user_name` text,
	`action` text NOT NULL,
	`category` text NOT NULL,
	`entity_type` text,
	`entity_id` text,
	`description` text NOT NULL,
	`metadata` text,
	`ip_address` text,
	`user_agent` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
