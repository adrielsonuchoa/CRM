'use client';

import React, { useState, useRef } from 'react';
import {
  DndContext,
  closestCorners,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragOverlay,
  defaultDropAnimationSideEffects,
  type DragStartEvent,
  type DragOverEvent,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable';
import { updateLeadStage } from '@/app/actions';
import { PipelineColumn } from './pipeline-column';
import { PipelineCard } from './pipeline-card';

export const STAGES = [
  'NOVO',
  'PESQUISANDO',
  'QUALIFICADO',
  'PRONTO PARA CONTATO',
  'CONTATO REALIZADO',
  'RESPONDEU',
  'CONVERSANDO',
  'INTERESSADO',
  'WHATSAPP',
  'DEMONSTRAÇÃO AGENDADA',
  'DEMONSTRAÇÃO REALIZADA',
  'PROPOSTA',
  'NEGOCIAÇÃO',
  'CLIENTE',
];

type Lead = { id: string; pipelineStage: string; [key: string]: any };

export function PipelineBoard({ initialLeads }: { initialLeads: Lead[] }) {
  const [leads, setLeads] = useState<Lead[]>(initialLeads);
  const [activeId, setActiveId] = useState<string | null>(null);
  // Track original stage at drag start to detect real changes
  const stageAtDragStart = useRef<string>('');

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragStart = (event: DragStartEvent) => {
    const id = event.active.id as string;
    setActiveId(id);
    const lead = leads.find((l) => l.id === id);
    stageAtDragStart.current = lead?.pipelineStage ?? '';
  };

  const handleDragOver = (event: DragOverEvent) => {
    const { active, over } = event;
    if (!over) return;

    const activeId = active.id as string;
    const overId = over.id as string;
    if (activeId === overId) return;

    const isActiveALead = active.data.current?.type === 'Lead';
    const isOverALead = over.data.current?.type === 'Lead';
    const isOverAColumn = over.data.current?.type === 'Column';
    if (!isActiveALead) return;

    // Drop over another lead → move into that lead's column
    if (isActiveALead && isOverALead) {
      setLeads((prev) => {
        const activeIndex = prev.findIndex((l) => l.id === activeId);
        const overIndex = prev.findIndex((l) => l.id === overId);
        if (activeIndex === -1 || overIndex === -1) return prev;

        const newLeads = [...prev];
        if (newLeads[activeIndex].pipelineStage !== newLeads[overIndex].pipelineStage) {
          newLeads[activeIndex] = { ...newLeads[activeIndex], pipelineStage: newLeads[overIndex].pipelineStage };
          return arrayMove(newLeads, activeIndex, overIndex - 1);
        }
        return arrayMove(newLeads, activeIndex, overIndex);
      });
    }

    // Drop over column header/empty area
    if (isActiveALead && isOverAColumn) {
      setLeads((prev) => {
        const activeIndex = prev.findIndex((l) => l.id === activeId);
        if (activeIndex === -1) return prev;
        const newLeads = [...prev];
        newLeads[activeIndex] = { ...newLeads[activeIndex], pipelineStage: overId };
        return newLeads;
      });
    }
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const currentActiveId = activeId;
    setActiveId(null);

    const { active } = event;
    if (!active) return;

    const movedLead = leads.find((l) => l.id === active.id);
    if (!movedLead) return;

    const newStage = movedLead.pipelineStage;
    const oldStage = stageAtDragStart.current;

    if (oldStage !== newStage) {
      await updateLeadStage(movedLead.id, newStage);
    }
  };

  const activeLead = activeId ? leads.find((l) => l.id === activeId) : null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
    >
      <div className="flex gap-3 h-full items-start min-w-max pb-4">
        {STAGES.map((stage) => (
          <PipelineColumn
            key={stage}
            stage={stage}
            leads={leads.filter((l) => l.pipelineStage === stage)}
          />
        ))}
      </div>

      <DragOverlay
        dropAnimation={{
          sideEffects: defaultDropAnimationSideEffects({
            styles: { active: { opacity: '0.4' } },
          }),
        }}
      >
        {activeLead ? <PipelineCard lead={activeLead} /> : null}
      </DragOverlay>
    </DndContext>
  );
}
