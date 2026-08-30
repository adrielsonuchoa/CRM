import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import path from 'path';

// Load environment
require('dotenv').config({ path: path.join(__dirname, '../../.env.local') });

const db = new Database(process.env.DATABASE_URL || 'file:./sqlite.db');

// Get all DESCOBERTO leads
const descobertoLeads = db.prepare(`
  SELECT id, businessName, followers, hasDelivery, hasDiningRoom, hasWaiters, rating, category
  FROM leads
  WHERE pipelineStage = 'DESCOBERTO'
  LIMIT 8
`).all();

console.log(`Found ${descobertoLeads.length} leads in DESCOBERTO status`);

descobertoLeads.forEach((lead: any) => {
  // Apply fallback scoring logic
  let score = 30;
  const reasons: string[] = ['Análise de IA indisponível; score baseado em dados básicos.'];

  if (lead.followers && lead.followers > 5000) {
    score += 20;
    reasons.push('Presença digital forte (5k+ seguidores).');
  }
  if (lead.hasDelivery) {
    score += 15;
    reasons.push('Operações de delivery aumentam complexidade operacional.');
  }
  if (lead.hasDiningRoom) {
    score += 10;
    reasons.push('Salão exige gestão de mesas e comandas.');
  }
  if (lead.hasWaiters) {
    score += 10;
    reasons.push('Presença de garçons sugere operações complexas.');
  }
  if (lead.rating && lead.rating >= 4.5) {
    score += 5;
    reasons.push('Alta avaliação (reputação consolidada).');
  }

  score = Math.min(100, score);
  const qualification = score >= 70 ? 'ALTA PRIORIDADE' : score >= 50 ? 'BOA OPORTUNIDADE' : score >= 30 ? 'MÉDIA PRIORIDADE' : 'BAIXA PRIORIDADE';
  const possibleNeeds = lead.category?.toLowerCase().includes('pizzaria') ? ['PDV', 'comandas'] : ['PDV', 'estoque'];
  const now = new Date();

  // Update lead with fallback analysis
  db.prepare(`
    UPDATE leads
    SET 
      leadScore = ?,
      qualificationStatus = ?,
      painPoints = ?,
      pipelineStage = ?,
      updatedAt = ?
    WHERE id = ?
  `).run(
    score,
    qualification,
    JSON.stringify(possibleNeeds),
    score >= 50 ? 'QUALIFICADO' : 'DESCARTADO',
    now.toISOString(),
    lead.id
  );

  // Insert activity record
  db.prepare(`
    INSERT INTO activities (id, leadId, type, content, metadata, createdAt)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    uuid(),
    lead.id,
    'AI_ANALYSIS',
    `[FALLBACK] Score: ${score}/100 (${qualification})\n\nMotivos: ${reasons.join(', ')}\n\nNecessidades: ${possibleNeeds.join(', ')}`,
    JSON.stringify({ score, qualification, confidence: 0.3, reasons, possibleNeeds, fallback: true }),
    now.toISOString()
  );

  console.log(`✓ ${lead.businessName}: score=${score}, qualification=${qualification}`);
});

console.log('\n✅ All leads processed with fallback scoring');
process.exit(0);
