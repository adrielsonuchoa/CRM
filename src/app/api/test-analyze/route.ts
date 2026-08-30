import { analyzeLeadAction } from '@/app/actions/ai';
import { db } from '@/db';
import { leads, activities } from '@/db/schema';
import { eq } from 'drizzle-orm';
import crypto from 'crypto';

/**
 * Quick test endpoint to force analyze a specific lead
 * GET /api/test-analyze?leadId=UUID
 * GET /api/test-analyze?mode=fallback  (Process all DESCOBERTO leads with fallback)
 */
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const leadId = searchParams.get('leadId');
    const mode = searchParams.get('mode');

    if (mode === 'fallback') {
      // Apply fallback scoring to all DESCOBERTO leads
      console.log('[TEST-ANALYZE] Mode: FALLBACK - applying fallback scoring...');
      
      const descobertoLeads = await db
        .select()
        .from(leads)
        .where(eq(leads.pipelineStage, 'DESCOBERTO'));

      const results = [];
      const now = new Date();

      for (const lead of descobertoLeads) {
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
        const newStage = score >= 50 ? 'QUALIFICADO' : 'DESCARTADO';

        await db
          .update(leads)
          .set({
            leadScore: score,
            qualificationStatus: qualification,
            painPoints: JSON.stringify(possibleNeeds),
            pipelineStage: newStage,
            updatedAt: now,
          })
          .where(eq(leads.id, lead.id));

        await db.insert(activities).values({
          id: crypto.randomUUID(),
          leadId: lead.id,
          type: 'AI_ANALYSIS',
          content: `[FALLBACK] Score: ${score}/100 (${qualification})\n\nMotivos: ${reasons.join(', ')}\n\nNecessidades: ${possibleNeeds.join(', ')}`,
          metadata: JSON.stringify({ score, qualification, confidence: 0.3, reasons, possibleNeeds, fallback: true }),
          createdAt: now,
        });

        results.push({
          id: lead.id,
          name: lead.businessName,
          score,
          qualification,
          stage: newStage,
        });
      }

      return Response.json({ success: true, processed: results.length, results }, { status: 200 });
    }

    if (!leadId) {
      return Response.json({ error: 'leadId parameter or mode=fallback required' }, { status: 400 });
    }

    console.log(`[TEST-ANALYZE] Starting analysis for lead: ${leadId}`);
    const result = await analyzeLeadAction(leadId);
    console.log(`[TEST-ANALYZE] Result:`, result);

    return Response.json(result, { status: 200 });
  } catch (error: any) {
    console.error('[TEST-ANALYZE] Error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}
