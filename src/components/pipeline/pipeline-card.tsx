'use client';

import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { AtSign, Globe2, MapPin, Phone, Star } from 'lucide-react';
import Link from 'next/link';

export type PipelineLead = {
  id: string;
  businessName: string;
  pipelineStage: string;
  leadScore: number | null;
  neighborhood: string | null;
  city: string | null;
  instagramUsername: string | null;
  followers: number | null;
  phone: string | null;
  website: string | null;
  websiteDomain: string | null;
  rating: number | null;
  reviewCount: number | null;
  category: string | null;
  hasDelivery: boolean | null;
  hasDiningRoom: boolean | null;
};

export function PipelineCard({ lead }: { lead: PipelineLead }) {
  const {
    setNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: lead.id,
    data: {
      type: 'Lead',
      lead,
    }
  });

  const style = {
    transition,
    transform: CSS.Transform.toString(transform),
  };

  if (isDragging) {
    return (
      <div 
        ref={setNodeRef} 
        style={style} 
        className="opacity-40 border-2 border-blue-500 rounded-lg h-32 w-full"
      />
    );
  }

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners} className="touch-none cursor-grab">
      <Card className="hover:border-blue-500/50 transition-colors shadow-sm bg-white dark:bg-neutral-900 border-neutral-200 dark:border-neutral-800">
        <CardHeader className="p-3 pb-2 flex flex-row justify-between items-start">
          <Link href={`/leads/${lead.id}`} className="hover:underline">
            <CardTitle className="text-sm font-semibold leading-tight line-clamp-1">{lead.businessName}</CardTitle>
          </Link>
          <Badge variant={lead.leadScore != null && lead.leadScore > 80 ? 'default' : 'secondary'} className="text-[10px] px-1 py-0 ml-2">
            {lead.leadScore ?? '—'}
          </Badge>
        </CardHeader>
        <CardContent className="p-3 pt-0 flex flex-col gap-2">
          <div className="flex items-center gap-2 text-xs text-neutral-500">
            <MapPin className="w-3 h-3" />
            <span className="line-clamp-1">{lead.neighborhood || lead.city || 'Não informado'}</span>
          </div>

          {lead.instagramUsername && (
            <div className="flex items-center gap-2 text-xs text-neutral-500">
              <AtSign className="w-3 h-3 shrink-0" />
              <span className="truncate">@{lead.instagramUsername.replace(/^@/, '')}</span>
              {lead.followers != null && <span className="ml-auto shrink-0">{lead.followers.toLocaleString('pt-BR')} seg.</span>}
            </div>
          )}
          {lead.phone && (
            <div className="flex items-center gap-2 text-xs text-neutral-500">
              <Phone className="w-3 h-3 shrink-0" />
              <span className="truncate">{lead.phone}</span>
            </div>
          )}
          {lead.website && (
            <div className="flex items-center gap-2 text-xs text-neutral-500">
              <Globe2 className="w-3 h-3 shrink-0" />
              <span className="truncate">{lead.websiteDomain || lead.website}</span>
            </div>
          )}
          {lead.rating != null && (
            <div className="flex items-center gap-1 text-xs text-amber-600">
              <Star className="w-3 h-3 fill-current" />
              <span>{lead.rating.toLocaleString('pt-BR')}{lead.reviewCount != null ? ` (${lead.reviewCount} avaliações)` : ''}</span>
            </div>
          )}
          
          <div className="flex flex-wrap gap-1 mt-1">
            {lead.category && <Badge variant="outline" className="text-[10px] px-1 py-0">{lead.category}</Badge>}
            {lead.hasDelivery && <Badge variant="outline" className="text-[10px] px-1 py-0">Delivery</Badge>}
            {lead.hasDiningRoom && <Badge variant="outline" className="text-[10px] px-1 py-0">Salão</Badge>}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
