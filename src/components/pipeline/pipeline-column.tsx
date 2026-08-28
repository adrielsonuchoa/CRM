'use client';

import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { PipelineCard } from './pipeline-card';
import { Badge } from '@/components/ui/badge';

export function PipelineColumn({ stage, leads }: { stage: string; leads: any[] }) {
  const { setNodeRef, isOver } = useDroppable({
    id: stage,
    data: {
      type: 'Column',
      stage,
    },
  });

  return (
    <div className="flex flex-col flex-shrink-0 w-80 bg-neutral-200/50 dark:bg-neutral-800/50 rounded-lg h-full overflow-hidden">
      <div className="p-3 border-b border-neutral-200 dark:border-neutral-800 flex items-center justify-between bg-neutral-200/80 dark:bg-neutral-800">
        <h3 className="font-semibold text-sm">{stage}</h3>
        <Badge variant="secondary" className="text-xs">{leads.length}</Badge>
      </div>

      <div 
        ref={setNodeRef} 
        className={`flex-1 p-3 overflow-y-auto flex flex-col gap-3 transition-colors ${isOver ? 'bg-neutral-300/50 dark:bg-neutral-700/50' : ''}`}
      >
        <SortableContext items={leads.map(l => l.id)} strategy={verticalListSortingStrategy}>
          {leads.map(lead => (
            <PipelineCard key={lead.id} lead={lead} />
          ))}
        </SortableContext>
      </div>
    </div>
  );
}
