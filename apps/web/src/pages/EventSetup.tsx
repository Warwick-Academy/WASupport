import { useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Download, MoveHorizontal } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const REQUEST_STATUSES = ['pending', 'scheduled', 'declined', 'completed'] as const;
type SetupType = 'exam' | 'event' | 'assembly' | 'custom';
type RequestStatus = (typeof REQUEST_STATUSES)[number];
type LayoutPosition = { x: number; y: number };
type EventSetupEquipment = 'Laptop' | 'Screen';
const EVENT_SETUP_EQUIPMENT: EventSetupEquipment[] = ['Laptop', 'Screen'];
type EventSetupRequest = {
  id: string;
  requester_id: string;
  requester_name: string;
  requester_email: string;
  event_title: string;
  setup_type: SetupType;
  event_date: string;
  setup_time: string;
  location: string;
  exam_front_rows: number | null;
  exam_front_columns: number | null;
  exam_back_rows: number | null;
  exam_back_columns: number | null;
  total_seats: number | null;
  seat_rows: number | null;
  seat_sections: number | null;
  seats_per_section_row: number | null;
  seat_back_row_chairs: number;
  seat_placement: 'left' | 'right' | 'center' | 'outside';
  seat_section_offsets: Record<string, number> | null;
  layout_element_positions: Record<string, LayoutPosition> | null;
  round_table_count: number | null;
  table_type: 'round' | 'long';
  chairs_per_table: number | null;
  tables_on_stage: boolean;
  risers_required: boolean;
  riser_rows: number | null;
  podium_required: boolean;
  recurrence_days: number[];
  recurrence_end_date: string | null;
  fast_turnaround: boolean;
  special_instructions: string | null;
  status: RequestStatus;
  created_at: string;
  recurrence_dates: string[];
  ticket_id: string | null;
  equipment: EventSetupEquipment[];
};

function dateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function displayDate(value: string) {
  return new Date(`${value}T12:00:00`).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function localDate() {
  return dateKey(new Date());
}

function recurringDatesForMonth(request: EventSetupRequest, month: Date) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1, 12);
  const last = new Date(month.getFullYear(), month.getMonth() + 1, 0, 12);
  const firstAllowed = request.event_date > dateKey(first) ? request.event_date : dateKey(first);
  const lastAllowed =
    request.recurrence_end_date && request.recurrence_end_date < dateKey(last)
      ? request.recurrence_end_date
      : dateKey(last);
  if (firstAllowed > lastAllowed) return [];

  const current = new Date(`${firstAllowed}T12:00:00`);
  const end = new Date(`${lastAllowed}T12:00:00`);
  const dates: string[] = [];
  while (current <= end) {
    if (request.recurrence_days.includes(current.getDay())) dates.push(dateKey(current));
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

function requestDatesForMonth(request: EventSetupRequest, month: Date) {
  if (request.recurrence_days.length) return recurringDatesForMonth(request, month);
  const prefix = `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}`;
  return [request.event_date, ...(request.recurrence_dates ?? [])]
    .filter((date, index, dates) => dates.indexOf(date) === index)
    .filter((date) => date.startsWith(`${prefix}-`))
    .sort();
}

function hasUpcomingOccurrence(request: EventSetupRequest, today: string) {
  if (!request.recurrence_days.length) {
    return [request.event_date, ...(request.recurrence_dates ?? [])].some((date) => date >= today);
  }
  if (!request.recurrence_end_date || request.recurrence_end_date < today) return false;
  const current = new Date(`${today}T12:00:00`);
  for (let offset = 0; offset < 7; offset += 1) {
    const occurrence = new Date(current);
    occurrence.setDate(occurrence.getDate() + offset);
    const key = dateKey(occurrence);
    if (
      key >= request.event_date &&
      key <= request.recurrence_end_date &&
      request.recurrence_days.includes(occurrence.getDay())
    ) {
      return true;
    }
  }
  return false;
}

function numeric(value: string) {
  return value.trim() ? Number(value) : 0;
}

function setupTypeLabel(value: SetupType) {
  if (value === 'exam') return 'Exam';
  if (value === 'event') return 'Event';
  if (value === 'assembly') return 'Assembly';
  return 'Custom';
}

function configurationSummary(request: EventSetupRequest) {
  const details: string[] = [];
  if (request.setup_type === 'exam') {
    if (request.exam_front_rows)
      details.push(`Front: ${request.exam_front_rows} × ${request.exam_front_columns} desks`);
    if (request.exam_back_rows)
      details.push(`Back: ${request.exam_back_rows} × ${request.exam_back_columns} desks`);
  }
  if (
    (request.setup_type === 'custom' ||
      request.setup_type === 'assembly' ||
      request.setup_type === 'event') &&
    request.total_seats
  ) {
    const quantityLabel = request.setup_type === 'event' ? 'chairs' : 'seats';
    details.push(
      `${request.total_seats} ${quantityLabel} · ${request.seat_rows} rows × ${request.seats_per_section_row} ${quantityLabel} per row × ${request.seat_sections} sections`,
    );
    if (request.seat_sections !== null && request.seat_sections <= 2) {
      const placement =
        request.seat_placement === 'center'
          ? 'center of hall'
          : request.seat_placement === 'outside'
            ? 'outside edges of hall'
            : `${request.seat_placement} side of hall`;
      details.push(`Placement: ${placement}`);
    }
  }
  if (request.seat_back_row_chairs > 0) {
    details.push(`Balcony: ${request.seat_back_row_chairs} chairs requested`);
  }
  if (request.equipment.length) details.push(`Equipment: ${request.equipment.join(', ')}`);
  if (request.round_table_count) {
    details.push(
      `${request.round_table_count} ${request.table_type} tables${request.chairs_per_table ? ` · ${request.chairs_per_table} chairs each` : ''}`,
    );
  }
  if (request.tables_on_stage) details.push('Tables on stage');
  if (request.risers_required) details.push(`${request.riser_rows} rows of risers`);
  return details.length ? details.join(' · ') : 'No seating or table layout details';
}

function SeatBlock({
  section,
  rows,
  seatsPerRow,
  align,
  itemType = 'chair',
  offset = 0,
  onMovePointerDown,
  onMovePointerMove,
  onMovePointerUp,
  onMovePointerCancel,
  onMoveKeyDown,
}: {
  section: string;
  rows: number;
  seatsPerRow: number;
  align: 'left' | 'right';
  itemType?: 'chair' | 'desk';
  offset?: number;
  onMovePointerDown?: React.PointerEventHandler<HTMLButtonElement>;
  onMovePointerMove?: React.PointerEventHandler<HTMLButtonElement>;
  onMovePointerUp?: React.PointerEventHandler<HTMLButtonElement>;
  onMovePointerCancel?: React.PointerEventHandler<HTMLButtonElement>;
  onMoveKeyDown?: React.KeyboardEventHandler<HTMLButtonElement>;
}) {
  const isDesk = itemType === 'desk';
  return (
    <div
      data-seat-section
      style={{ transform: `translateX(${offset}px)` }}
      className={`w-fit max-w-full rounded border border-slate-200 bg-white p-1 ${align === 'left' ? 'text-left' : 'text-right'}`}
    >
      <h3 className="mb-1 flex items-center justify-between gap-1 text-[10px] font-semibold uppercase tracking-wide text-slate-600">
        <span>{section}</span>
        {onMovePointerDown && (
          <button
            type="button"
            aria-label={`Move ${section} left or right`}
            title="Drag left or right to move this section"
            onPointerDown={onMovePointerDown}
            onPointerMove={onMovePointerMove}
            onPointerUp={onMovePointerUp}
            onPointerCancel={onMovePointerCancel}
            onKeyDown={onMoveKeyDown}
            className="cursor-ew-resize rounded p-0.5 text-slate-500 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600"
            style={{ touchAction: 'none' }}
          >
            <MoveHorizontal size={14} aria-hidden="true" />
          </button>
        )}
      </h3>
      {Array.from({ length: rows }, (_, rowIndex) => (
        <div
          key={rowIndex}
          className={`flex flex-nowrap items-center ${isDesk ? 'gap-3 py-1.5' : 'gap-1 py-0.5'} ${align === 'left' ? 'justify-start' : 'justify-end'}`}
          aria-label={`${section}, row ${rowIndex + 1}`}
        >
          <span className="mr-1 w-6 shrink-0 text-left text-[10px] text-slate-500">
            R{rowIndex + 1}
          </span>
          {Array.from({ length: seatsPerRow }, (_, seatIndex) => (
            <span
              key={seatIndex}
              className={`${isDesk ? 'h-12 w-12 rounded-md' : 'h-4 w-4 rounded-[3px]'} shrink-0 bg-[#1a2744]`}
              aria-hidden="true"
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function HallSeatMap({
  sections,
  rows,
  seatsPerRow,
  backRowChairs = 0,
  placement,
  offsets = {},
  onOffsetsChange,
  interactive = true,
}: {
  sections: number;
  rows: number;
  seatsPerRow: number;
  backRowChairs?: number;
  placement: 'left' | 'right' | 'center' | 'outside';
  offsets?: Record<string, number>;
  onOffsetsChange?: (offsets: Record<string, number>) => void;
  interactive?: boolean;
}) {
  const mapRef = useRef<HTMLDivElement>(null);
  const activeDrag = useRef<{
    section: string;
    pointerId: number;
    startX: number;
    startOffset: number;
    minOffset: number;
    maxOffset: number;
  } | null>(null);
  const setOffset = (section: string, offset: number) => {
    onOffsetsChange?.({ ...offsets, [section]: offset });
  };
  const startDrag: React.PointerEventHandler<HTMLButtonElement> = (event) => {
    const card = event.currentTarget.closest<HTMLElement>('[data-seat-section]');
    const map = mapRef.current;
    if (!card || !map || !onOffsetsChange) return;
    const cardRect = card.getBoundingClientRect();
    const mapRect = map.getBoundingClientRect();
    const section = card.querySelector('h3 span')?.textContent;
    if (!section) return;
    const startOffset = offsets[section] ?? 0;
    activeDrag.current = {
      section,
      pointerId: event.pointerId,
      startX: event.clientX,
      startOffset,
      minOffset: startOffset - (cardRect.left - mapRect.left),
      maxOffset: startOffset + (mapRect.right - cardRect.right),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const moveDrag: React.PointerEventHandler<HTMLButtonElement> = (event) => {
    const drag = activeDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setOffset(
      drag.section,
      Math.max(
        drag.minOffset,
        Math.min(drag.maxOffset, drag.startOffset + event.clientX - drag.startX),
      ),
    );
  };
  const stopDrag: React.PointerEventHandler<HTMLButtonElement> = (event) => {
    if (activeDrag.current?.pointerId === event.pointerId) activeDrag.current = null;
  };
  const moveWithKeyboard: React.KeyboardEventHandler<HTMLButtonElement> = (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const card = event.currentTarget.closest<HTMLElement>('[data-seat-section]');
    const section = card?.querySelector('h3 span')?.textContent;
    if (!card || !section || !mapRef.current) return;
    event.preventDefault();
    const mapRect = mapRef.current.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const currentOffset = offsets[section] ?? 0;
    const minOffset = currentOffset - (cardRect.left - mapRect.left);
    const maxOffset = currentOffset + (mapRect.right - cardRect.right);
    setOffset(
      section,
      Math.max(
        minOffset,
        Math.min(maxOffset, currentOffset + (event.key === 'ArrowRight' ? 16 : -16)),
      ),
    );
  };
  const movableProps = (section: string) => ({
    offset: offsets[section] ?? 0,
    ...(interactive && onOffsetsChange
      ? {
          onMovePointerDown: startDrag,
          onMovePointerMove: moveDrag,
          onMovePointerUp: stopDrag,
          onMovePointerCancel: stopDrag,
          onMoveKeyDown: moveWithKeyboard,
        }
      : {}),
  });
  const leftCount =
    placement === 'right'
      ? 0
      : placement === 'center' || placement === 'outside'
        ? Math.ceil(sections / 2)
        : sections;
  const rightCount =
    placement === 'left'
      ? 0
      : placement === 'center' || placement === 'outside'
        ? Math.floor(sections / 2)
        : sections;
  const sectionBlock = (
    sectionNumber: number,
    align: 'left' | 'right',
    label = `Section ${sectionNumber}`,
  ) => (
    <SeatBlock
      key={sectionNumber}
      section={label}
      rows={rows}
      seatsPerRow={seatsPerRow}
      align={align}
      {...movableProps(label)}
    />
  );
  const leftSections = Array.from({ length: leftCount }, (_, index) =>
    sectionBlock(leftCount - index, placement === 'outside' ? 'left' : 'right'),
  );
  const rightSections = Array.from({ length: rightCount }, (_, index) =>
    sectionBlock(
      placement === 'right' ? index + 1 : leftCount + index + 1,
      placement === 'outside' ? 'right' : 'left',
    ),
  );
  const aisle = (
    <div
      aria-label="Center aisle"
      className="flex items-center justify-center rounded bg-amber-100 px-1 text-[9px] font-semibold text-amber-900 [writing-mode:vertical-rl]"
    >
      CENTER AISLE
    </div>
  );
  const backRow = backRowChairs > 0 && (
    <div className="mx-auto mt-3 flex w-fit justify-center">
      <SeatBlock
        section={`Balcony · ${backRowChairs} chairs requested`}
        rows={1}
        seatsPerRow={backRowChairs}
        align="left"
      />
    </div>
  );

  if (sections === 1 && placement === 'center') {
    return (
      <div className="space-y-2">
        <div
          ref={mapRef}
          className="mx-auto grid w-full min-w-[36rem] grid-cols-[1fr_auto_1fr] items-stretch gap-1"
        >
          <SeatBlock
            section="Section 1 · Left"
            rows={rows}
            seatsPerRow={Math.ceil(seatsPerRow / 2)}
            align="right"
            {...movableProps('Section 1 · Left')}
          />
          {aisle}
          <SeatBlock
            section="Section 1 · Right"
            rows={rows}
            seatsPerRow={Math.floor(seatsPerRow / 2)}
            align="left"
            {...movableProps('Section 1 · Right')}
          />
        </div>
        {backRow}
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <div
        ref={mapRef}
        className="mx-auto grid w-full min-w-[36rem] grid-cols-[1fr_auto_1fr] items-stretch gap-1"
      >
        {leftCount === 0 ? (
          <div />
        ) : (
          <div
            className={`flex items-start gap-1 ${placement === 'outside' ? 'justify-start' : 'justify-end'}`}
          >
            {leftSections}
          </div>
        )}
        {aisle}
        {rightCount === 0 ? (
          <div />
        ) : (
          <div
            className={`flex items-start gap-1 ${placement === 'outside' ? 'justify-end' : 'justify-start'}`}
          >
            {rightSections}
          </div>
        )}
      </div>
      {backRow}
    </div>
  );
}

type LayoutElementKind = 'round-table' | 'long-table' | 'riser' | 'podium';
type LayoutElement = {
  id: string;
  kind: LayoutElementKind;
  label: string;
  position: LayoutPosition;
};

function createLayoutElements(
  tableCount: number,
  tableType: 'round' | 'long',
  riserCount: number,
  podiumRequired: boolean,
  positions: Record<string, LayoutPosition>,
): LayoutElement[] {
  const elements: LayoutElement[] = [];
  for (let index = 0; index < tableCount; index += 1) {
    const id = `table-${index + 1}`;
    elements.push({
      id,
      kind: tableType === 'round' ? 'round-table' : 'long-table',
      label: `Table ${index + 1}`,
      position: positions[id] ?? {
        x: 12 + (index % 5) * 18,
        y: 12 + Math.floor(index / 5) * 58,
      },
    });
  }
  for (let index = 0; index < riserCount; index += 1) {
    const id = `riser-${index + 1}`;
    elements.push({
      id,
      kind: 'riser',
      label: `Riser row ${index + 1}`,
      position: positions[id] ?? { x: 50, y: 12 + index * 22 },
    });
  }
  if (podiumRequired) {
    const id = 'podium';
    elements.push({
      id,
      kind: 'podium',
      label: 'Podium',
      position: positions[id] ?? { x: 50, y: 12 },
    });
  }
  return elements;
}

function elementDimensions(kind: LayoutElementKind) {
  if (kind === 'round-table') return { width: 56, height: 48 };
  if (kind === 'long-table') return { width: 96, height: 42 };
  if (kind === 'riser') return { width: 230, height: 18 };
  return { width: 74, height: 38 };
}

function EventLayoutElements({
  elements,
  onPositionsChange,
  interactive = true,
}: {
  elements: LayoutElement[];
  onPositionsChange?: (positions: Record<string, LayoutPosition>) => void;
  interactive?: boolean;
}) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const activeDrag = useRef<{
    id: string;
    pointerId: number;
    startX: number;
    startY: number;
    position: LayoutPosition;
  } | null>(null);
  const height = Math.max(
    104,
    ...elements.map((element) => element.position.y + elementDimensions(element.kind).height + 18),
  );
  const startDrag: React.PointerEventHandler<HTMLButtonElement> = (event) => {
    const canvas = canvasRef.current;
    const id = event.currentTarget.dataset.layoutItem;
    const item = elements.find((element) => element.id === id);
    if (!canvas || !item || !onPositionsChange) return;
    activeDrag.current = {
      id: item.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      position: item.position,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };
  const moveDrag: React.PointerEventHandler<HTMLButtonElement> = (event) => {
    const drag = activeDrag.current;
    const canvas = canvasRef.current;
    const item = elements.find((element) => element.id === drag?.id);
    if (!drag || !canvas || !item || !onPositionsChange || drag.pointerId !== event.pointerId)
      return;
    const canvasWidth = canvas.getBoundingClientRect().width;
    const dimensions = elementDimensions(item.kind);
    const xChange = ((event.clientX - drag.startX) / canvasWidth) * 100;
    const nextPosition = {
      x: Math.max(
        (dimensions.width / canvasWidth) * 50,
        Math.min(100 - (dimensions.width / canvasWidth) * 50, drag.position.x + xChange),
      ),
      y: Math.max(0, drag.position.y + event.clientY - drag.startY),
    };
    const nextPositions = Object.fromEntries(
      elements.map((element) => [
        element.id,
        element.id === item.id ? nextPosition : element.position,
      ]),
    );
    onPositionsChange(nextPositions);
  };
  const stopDrag: React.PointerEventHandler<HTMLButtonElement> = (event) => {
    if (activeDrag.current?.pointerId === event.pointerId) activeDrag.current = null;
  };
  const moveWithKeyboard: React.KeyboardEventHandler<HTMLButtonElement> = (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    const id = event.currentTarget.dataset.layoutItem;
    const item = elements.find((element) => element.id === id);
    const canvas = canvasRef.current;
    if (!item || !canvas || !onPositionsChange) return;
    event.preventDefault();
    const dimensions = elementDimensions(item.kind);
    const width = canvas.getBoundingClientRect().width;
    const xStep = (12 / width) * 100;
    const x =
      item.position.x +
      (event.key === 'ArrowLeft' ? -xStep : event.key === 'ArrowRight' ? xStep : 0);
    const y = Math.max(
      0,
      item.position.y + (event.key === 'ArrowUp' ? -12 : event.key === 'ArrowDown' ? 12 : 0),
    );
    onPositionsChange({
      ...Object.fromEntries(elements.map((element) => [element.id, element.position])),
      [item.id]: {
        x: Math.max(
          (dimensions.width / width) * 50,
          Math.min(100 - (dimensions.width / width) * 50, x),
        ),
        y,
      },
    });
  };
  const renderElement = (element: LayoutElement) => {
    const dimensions = elementDimensions(element.kind);
    const shapeClass =
      element.kind === 'round-table'
        ? 'rounded-full bg-amber-200'
        : element.kind === 'long-table'
          ? 'rounded-md bg-amber-200'
          : element.kind === 'riser'
            ? 'rounded-sm bg-violet-200'
            : 'rounded-md bg-emerald-200';
    const className = `absolute flex items-center justify-center border border-slate-500 px-1 text-center text-[10px] font-semibold text-slate-800 ${shapeClass} ${
      interactive ? 'cursor-move shadow-sm hover:ring-2 hover:ring-blue-400' : ''
    }`;
    const style = {
      left: `${element.position.x}%`,
      top: `${element.position.y}px`,
      width: `${dimensions.width}px`,
      height: `${dimensions.height}px`,
      transform: 'translateX(-50%)',
      touchAction: 'none' as const,
    };
    return interactive && onPositionsChange ? (
      <button
        key={element.id}
        type="button"
        data-layout-item={element.id}
        aria-label={`Move ${element.label} on the layout map`}
        title={`${element.label} · drag to move`}
        onPointerDown={startDrag}
        onPointerMove={moveDrag}
        onPointerUp={stopDrag}
        onPointerCancel={stopDrag}
        onKeyDown={moveWithKeyboard}
        className={className}
        style={style}
      >
        {element.label}
      </button>
    ) : (
      <div key={element.id} className={className} style={style} aria-label={element.label}>
        {element.label}
      </div>
    );
  };
  return (
    <div className="overflow-x-auto">
      <div
        ref={canvasRef}
        className="relative mx-auto min-w-[720px] rounded border border-dashed border-slate-300 bg-white"
        style={{ height: `${height}px` }}
        aria-label="Draggable tables, risers, and podium layout"
      >
        <p className="absolute left-2 top-1 text-[10px] text-slate-500">
          Drag each element to position it. Seating moves back as this area grows.
        </p>
        {elements.map(renderElement)}
      </div>
    </div>
  );
}

async function downloadEventRequestPdf(request: EventSetupRequest, occurrenceDate: string) {
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 14;
  const contentWidth = pageWidth - margin * 2;
  const date = displayDate(occurrenceDate);
  const details = [
    `Event: ${request.event_title}`,
    `Date: ${date}${request.recurrence_days.length ? ` (first occurrence: ${displayDate(request.event_date)})` : ''}`,
    `Setup by: ${request.setup_time.slice(0, 5)}`,
    `Location: ${request.location}`,
    `Setup type: ${setupTypeLabel(request.setup_type)}`,
    `Status: ${request.status}`,
    `Requester: ${request.requester_name} (${request.requester_email})`,
  ];
  if (request.equipment.length) details.push(`Equipment: ${request.equipment.join(', ')}`);
  if (request.recurrence_days.length) {
    details.push(
      `Repeats weekly: ${request.recurrence_days.map((day) => WEEKDAYS[day]).join(', ')} through ${request.recurrence_end_date ?? 'not specified'}`,
    );
  } else if (request.recurrence_dates?.length) {
    details.push(
      `Event dates: ${[request.event_date, ...request.recurrence_dates]
        .filter((value, index, dates) => dates.indexOf(value) === index)
        .sort()
        .map(displayDate)
        .join(', ')}`,
    );
  }
  if (request.setup_type === 'exam') {
    if (request.exam_front_rows) {
      details.push(
        `Exam desks — front: ${request.exam_front_rows} rows × ${request.exam_front_columns} columns`,
      );
    }
    if (request.exam_back_rows) {
      details.push(
        `Exam desks — back: ${request.exam_back_rows} rows × ${request.exam_back_columns} columns`,
      );
    }
  }
  if (request.total_seats) {
    const quantityLabel = request.setup_type === 'event' ? 'Chairs' : 'Seats';
    details.push(
      `${quantityLabel}: ${request.total_seats} · ${request.seat_sections} sections · ${request.seat_rows} rows · ${request.seats_per_section_row} per section per row · placement ${request.seat_placement}`,
    );
  }
  if (request.seat_back_row_chairs > 0) {
    details.push(`Balcony: ${request.seat_back_row_chairs} chairs requested`);
  }
  if (request.round_table_count) {
    details.push(
      `Tables: ${request.round_table_count} ${request.table_type} · ${request.chairs_per_table ?? 0} chairs per table${request.tables_on_stage ? ' · on stage' : ''}`,
    );
  }
  if (request.risers_required) details.push(`Risers: ${request.riser_rows ?? 0} rows`);
  if (request.podium_required) details.push('Podium: required');
  if (request.fast_turnaround) details.push('Fast turnaround / standby: requested');
  if (request.special_instructions) {
    details.push(`Special instructions: ${request.special_instructions}`);
  }
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(20);
  pdf.text('Event Setup', margin, 18);
  pdf.setFontSize(15);
  pdf.text(request.event_title, margin, 28);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(10);
  let lineY = 38;
  for (const detail of details) {
    const lines = pdf.splitTextToSize(detail, contentWidth);
    for (const line of lines) {
      if (lineY > pageHeight - margin) {
        pdf.addPage();
        lineY = margin;
      }
      pdf.text(line, margin, lineY);
      lineY += 6;
    }
  }

  pdf.addPage();
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(16);
  pdf.text('Room layout · Stage at front', margin, 16);
  const mapLeft = margin;
  const mapWidth = contentWidth;
  const stageY = 23;
  const stageWidth = mapWidth * 0.62;
  pdf.setFillColor(26, 39, 68);
  pdf.roundedRect(mapLeft + (mapWidth - stageWidth) / 2, stageY, stageWidth, 8, 2, 2, 'F');
  pdf.setTextColor(255, 255, 255);
  pdf.setFontSize(9);
  pdf.text('STAGE · FRONT', pageWidth / 2, stageY + 5.5, { align: 'center' });
  pdf.setTextColor(20, 30, 48);
  const elements = createLayoutElements(
    request.round_table_count ?? 0,
    request.table_type,
    request.risers_required ? (request.riser_rows ?? 0) : 0,
    request.podium_required,
    request.layout_element_positions ?? {},
  );
  const tables = elements.filter(
    (element) => element.kind === 'round-table' || element.kind === 'long-table',
  );
  const frontElements = elements.filter(
    (element) =>
      !request.tables_on_stage || (element.kind !== 'round-table' && element.kind !== 'long-table'),
  );
  const drawElement = (element: LayoutElement, baseY: number) => {
    const dimensions = elementDimensions(element.kind);
    const elementWidth = dimensions.width * 0.22;
    const elementHeight = dimensions.height * 0.22;
    const centerX = mapLeft + (element.position.x / 100) * mapWidth;
    const top = baseY + element.position.y * 0.18;
    if (element.kind === 'round-table') {
      pdf.setFillColor(253, 230, 138);
      pdf.circle(centerX, top + elementHeight / 2, elementHeight / 2, 'F');
    } else {
      const colors: Record<LayoutElementKind, [number, number, number]> = {
        'round-table': [253, 230, 138],
        'long-table': [253, 230, 138],
        riser: [221, 214, 254],
        podium: [167, 243, 208],
      };
      pdf.setFillColor(...colors[element.kind]);
      pdf.roundedRect(centerX - elementWidth / 2, top, elementWidth, elementHeight, 1, 1, 'F');
    }
    pdf.setFontSize(6);
    pdf.text(element.label, centerX, top + elementHeight / 2 + 1, { align: 'center' });
  };
  const stageElementHeight = request.tables_on_stage
    ? Math.max(
        14,
        ...tables.map(
          (element) => element.position.y + elementDimensions(element.kind).height + 12,
        ),
      )
    : 0;
  if (request.tables_on_stage) tables.forEach((element) => drawElement(element, stageY + 12));
  const floorY = stageY + 12 + stageElementHeight;
  frontElements.forEach((element) => drawElement(element, floorY));
  const floorHeight = Math.max(
    18,
    ...frontElements.map(
      (element) => element.position.y + elementDimensions(element.kind).height + 12,
    ),
  );
  const seatsTop = floorY + floorHeight + 8;
  const availableBottom = pageHeight - 12;
  const roomWidth = mapWidth;
  const rows = request.seat_rows ?? 0;
  const sections = request.seat_sections ?? 0;
  const seatsPerRow = request.seats_per_section_row ?? 0;
  const seatMapValid = rows > 0 && sections > 0 && seatsPerRow > 0;
  const drawSeatBlock = (
    label: string,
    left: number,
    top: number,
    rowCount: number,
    countPerRow: number,
  ) => {
    const cell = Math.min(2, (roomWidth * 0.46 - 8) / Math.max(countPerRow, 1));
    const blockWidth = Math.min(roomWidth * 0.47, countPerRow * cell + 12);
    const rowHeight = Math.min(3.5, (availableBottom - top - 12) / Math.max(rowCount, 1));
    pdf.setDrawColor(190, 200, 215);
    pdf.roundedRect(
      left,
      top,
      blockWidth,
      Math.min(rowCount * rowHeight + 10, availableBottom - top),
      1,
      1,
    );
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(7);
    pdf.text(label, left + 2, top + 4);
    pdf.setFillColor(26, 39, 68);
    for (let row = 0; row < rowCount; row += 1) {
      for (let col = 0; col < countPerRow; col += 1) {
        pdf.rect(
          left + 4 + col * cell,
          top + 7 + row * rowHeight,
          Math.max(0.7, cell - 0.35),
          Math.max(0.7, Math.min(2, rowHeight - 0.3)),
          'F',
        );
      }
    }
  };
  if (seatMapValid) {
    const centerX = pageWidth / 2;
    const aisleWidth = 8;
    const perSectionWidth = Math.min(
      mapWidth * 0.45,
      Math.max(25, seatsPerRow * Math.min(2, (mapWidth * 0.45 - 8) / seatsPerRow) + 12),
    );
    if (sections === 1 && request.seat_placement === 'center') {
      const leftHalf = Math.ceil(seatsPerRow / 2);
      const leftOffset = request.seat_section_offsets?.['Section 1 · Left'] ?? 0;
      const rightOffset = request.seat_section_offsets?.['Section 1 · Right'] ?? 0;
      drawSeatBlock(
        'SECTION 1 · LEFT',
        centerX - aisleWidth / 2 - perSectionWidth + leftOffset * 0.22,
        seatsTop,
        rows,
        leftHalf,
      );
      drawSeatBlock(
        'SECTION 1 · RIGHT',
        centerX + aisleWidth / 2 + rightOffset * 0.22,
        seatsTop,
        rows,
        Math.floor(seatsPerRow / 2),
      );
    } else {
      const leftCount =
        request.seat_placement === 'right'
          ? 0
          : request.seat_placement === 'center' || request.seat_placement === 'outside'
            ? Math.ceil(sections / 2)
            : sections;
      const rightCount =
        request.seat_placement === 'left'
          ? 0
          : request.seat_placement === 'center' || request.seat_placement === 'outside'
            ? Math.floor(sections / 2)
            : sections;
      const aisleLeft = centerX - aisleWidth / 2;
      const leftStart =
        request.seat_placement === 'outside'
          ? mapLeft
          : request.seat_placement === 'left'
            ? centerX - aisleWidth / 2 - leftCount * perSectionWidth
            : aisleLeft - leftCount * perSectionWidth;
      const rightStart =
        request.seat_placement === 'outside'
          ? mapLeft + mapWidth - perSectionWidth
          : centerX + aisleWidth / 2;
      for (let index = 0; index < leftCount; index += 1) {
        const section = request.seat_placement === 'left' ? index + 1 : leftCount - index;
        const offset = request.seat_section_offsets?.[`Section ${section}`] ?? 0;
        drawSeatBlock(
          `SECTION ${section}`,
          leftStart + index * perSectionWidth + offset * 0.22,
          seatsTop,
          rows,
          seatsPerRow,
        );
      }
      for (let index = 0; index < rightCount; index += 1) {
        const section = request.seat_placement === 'right' ? index + 1 : leftCount + index + 1;
        const offset = request.seat_section_offsets?.[`Section ${section}`] ?? 0;
        drawSeatBlock(
          `SECTION ${section}`,
          rightStart + index * perSectionWidth + offset * 0.22,
          seatsTop,
          rows,
          seatsPerRow,
        );
      }
    }
    pdf.setFillColor(255, 247, 204);
    pdf.roundedRect(
      centerX - aisleWidth / 2,
      seatsTop,
      aisleWidth,
      Math.max(10, rows * 2.5),
      1,
      1,
      'F',
    );
    pdf.setFontSize(5);
    pdf.text('AISLE', centerX, seatsTop + 4, { align: 'center' });
    if (request.seat_back_row_chairs > 0) {
      const sideRowHeight = Math.min(3.5, (availableBottom - seatsTop - 12) / Math.max(rows, 1));
      const backRowWidth = Math.min(roomWidth * 0.47, request.seat_back_row_chairs * 2 + 12);
      drawSeatBlock(
        `BALCONY · ${request.seat_back_row_chairs} CHAIRS REQUESTED`,
        centerX - backRowWidth / 2,
        Math.min(seatsTop + rows * sideRowHeight + 16, availableBottom - 12),
        1,
        request.seat_back_row_chairs,
      );
    }
  } else if (request.setup_type === 'exam') {
    const frontCount = request.exam_front_rows ?? 0;
    const frontColumns = request.exam_front_columns ?? 0;
    const backCount = request.exam_back_rows ?? 0;
    const backColumns = request.exam_back_columns ?? 0;
    if (frontCount > 0 && frontColumns > 0) {
      drawSeatBlock('FRONT OF HALL · DESKS', mapLeft, seatsTop, frontCount, frontColumns);
    }
    if (backCount > 0 && backColumns > 0) {
      drawSeatBlock(
        'BACK OF HALL · DESKS',
        mapLeft,
        seatsTop + Math.min(frontCount * 3.5 + 14, availableBottom - seatsTop - 10),
        backCount,
        backColumns,
      );
    }
  }
  const filename = `${request.event_title.replace(/[<>:"/\\|?*]+/g, '-').trim() || 'event-setup'}.pdf`;
  pdf.save(filename);
}

export default function EventSetup() {
  const { user, role, isManager } = useAuth();
  const queryClient = useQueryClient();
  const canManage = role === 'fac_tech' || isManager;
  const [eventTitle, setEventTitle] = useState('');
  const [selectedPreset, setSelectedPreset] = useState('');
  const [setupType, setSetupType] = useState<SetupType>('event');
  const [eventDate, setEventDate] = useState('');
  const [setupTime, setSetupTime] = useState('');
  const [location, setLocation] = useState('');
  const [frontRows, setFrontRows] = useState('0');
  const [frontColumns, setFrontColumns] = useState('0');
  const [backRows, setBackRows] = useState('0');
  const [backColumns, setBackColumns] = useState('0');
  const [seatRows, setSeatRows] = useState('');
  const [seatSections, setSeatSections] = useState('');
  const [seatsPerRow, setSeatsPerRow] = useState('');
  const [seatBackRowChairs, setSeatBackRowChairs] = useState('0');
  const [seatPlacement, setSeatPlacement] = useState<'left' | 'right' | 'center' | 'outside'>(
    'center',
  );
  const [seatSectionOffsets, setSeatSectionOffsets] = useState<Record<string, number>>({});
  const [eventChairsRequired, setEventChairsRequired] = useState(false);
  const [equipment, setEquipment] = useState<EventSetupEquipment[]>([]);
  const [layoutElementPositions, setLayoutElementPositions] = useState<
    Record<string, LayoutPosition>
  >({});
  const [tableCount, setTableCount] = useState('0');
  const [tableType, setTableType] = useState<'round' | 'long'>('round');
  const [chairsPerTable, setChairsPerTable] = useState('0');
  const [tablesOnStage, setTablesOnStage] = useState(false);
  const [risersRequired, setRisersRequired] = useState(false);
  const [riserRows, setRiserRows] = useState('');
  const [podiumRequired, setPodiumRequired] = useState(false);
  const [repeatEnabled, setRepeatEnabled] = useState(false);
  const [repeatMode, setRepeatMode] = useState<'weekly' | 'specific_dates'>('weekly');
  const [repeatDays, setRepeatDays] = useState<number[]>([]);
  const [repeatEndDate, setRepeatEndDate] = useState('');
  const [specificDates, setSpecificDates] = useState(['']);
  const [fastTurnaround, setFastTurnaround] = useState(false);
  const [specialInstructions, setSpecialInstructions] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [month, setMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1, 12);
  });
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const [selectedOccurrenceDate, setSelectedOccurrenceDate] = useState<string | null>(null);

  const requests = useQuery({
    queryKey: ['event-setup-requests', user?.id],
    enabled: !!user && !!supabase && canManage,
    queryFn: async (): Promise<EventSetupRequest[]> => {
      if (!supabase) throw new Error('Supabase is not configured.');
      const records: EventSetupRequest[] = [];
      for (let offset = 0; ; offset += 500) {
        const { data, error } = await supabase
          .from('event_setup_requests')
          .select('*')
          .order('event_date', { ascending: true })
          .order('setup_time', { ascending: true })
          .order('id')
          .range(offset, offset + 499);
        if (error) throw error;
        const batch = (data ?? []) as EventSetupRequest[];
        records.push(...batch);
        if (batch.length < 500) return records;
      }
    },
  });

  const seatingLayout = useMemo(() => {
    const rows = numeric(seatRows);
    const sections = numeric(seatSections);
    const perRow = numeric(seatsPerRow);
    if (rows < 1 || sections < 1 || perRow < 1) return null;
    return {
      rows,
      sections,
      perRow,
      total: rows * sections * perRow + numeric(seatBackRowChairs),
    };
  }, [seatRows, seatSections, seatsPerRow, seatBackRowChairs]);
  const layoutElements = useMemo(
    () =>
      createLayoutElements(
        numeric(tableCount),
        tableType,
        risersRequired ? numeric(riserRows) : 0,
        podiumRequired,
        layoutElementPositions,
      ),
    [tableCount, tableType, risersRequired, riserRows, podiumRequired, layoutElementPositions],
  );
  const tableElements = layoutElements.filter(
    (element) => element.kind === 'round-table' || element.kind === 'long-table',
  );
  const frontElements = layoutElements.filter(
    (element) =>
      !tablesOnStage || (element.kind !== 'round-table' && element.kind !== 'long-table'),
  );
  const updateLayoutElementPositions = (positions: Record<string, LayoutPosition>) => {
    setLayoutElementPositions((current) => ({ ...current, ...positions }));
  };

  const requestsByDate = useMemo(() => {
    const grouped = new Map<string, EventSetupRequest[]>();
    for (const request of requests.data ?? []) {
      for (const date of requestDatesForMonth(request, month)) {
        const onDate = grouped.get(date) ?? [];
        onDate.push(request);
        grouped.set(date, onDate);
      }
    }
    return grouped;
  }, [month, requests.data]);

  const firstWeekday = month.getDay();
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cellCount = Math.ceil((firstWeekday + daysInMonth) / 7) * 7;
  const cells = Array.from({ length: cellCount }, (_, index) => {
    const day = index - firstWeekday + 1;
    return day > 0 && day <= daysInMonth
      ? new Date(month.getFullYear(), month.getMonth(), day, 12)
      : null;
  });
  const selectedRequest =
    (requests.data ?? []).find((request) => request.id === selectedRequestId) ?? null;
  const selectedLayoutElements = selectedRequest
    ? createLayoutElements(
        selectedRequest.round_table_count ?? 0,
        selectedRequest.table_type,
        selectedRequest.risers_required ? (selectedRequest.riser_rows ?? 0) : 0,
        selectedRequest.podium_required,
        selectedRequest.layout_element_positions ?? {},
      )
    : [];
  const selectedTableElements = selectedLayoutElements.filter(
    (element) => element.kind === 'round-table' || element.kind === 'long-table',
  );
  const selectedFrontElements = selectedLayoutElements.filter(
    (element) =>
      !selectedRequest?.tables_on_stage ||
      (element.kind !== 'round-table' && element.kind !== 'long-table'),
  );
  const hasUpcomingFastTurnaround = (requests.data ?? []).some(
    (request) =>
      request.fast_turnaround &&
      request.status !== 'completed' &&
      request.status !== 'declined' &&
      hasUpcomingOccurrence(request, localDate()),
  );
  const monthLabel = month.toLocaleDateString('en', { month: 'long', year: 'numeric' });

  function resetForm() {
    setEventTitle('');
    setSelectedPreset('');
    setEventDate('');
    setSetupTime('');
    setLocation('');
    setFrontRows('0');
    setFrontColumns('0');
    setBackRows('0');
    setBackColumns('0');
    setSeatRows('');
    setSeatSections('');
    setSeatsPerRow('');
    setSeatBackRowChairs('0');
    setSeatPlacement('center');
    setSeatSectionOffsets({});
    setLayoutElementPositions({});
    setTableCount('0');
    setTableType('round');
    setChairsPerTable('0');
    setTablesOnStage(false);
    setRisersRequired(false);
    setRiserRows('');
    setPodiumRequired(false);
    setRepeatEnabled(false);
    setRepeatMode('weekly');
    setRepeatDays([]);
    setRepeatEndDate('');
    setSpecificDates(['']);
    setFastTurnaround(false);
    setSpecialInstructions('');
    setEquipment([]);
  }

  function applyPreset(preset: string) {
    setSelectedPreset(preset);
    if (preset !== 'primary-assembly') return;
    setEventTitle('Primary Assembly');
    setSetupType('assembly');
    setLocation('PPMH');
    setSeatSections('2');
    setSeatRows('16');
    setSeatsPerRow('1');
    setSeatBackRowChairs('25');
    setSeatPlacement('outside');
    setSeatSectionOffsets({});
    setLayoutElementPositions({});
    setTableCount('0');
    setTableType('round');
    setChairsPerTable('0');
    setTablesOnStage(false);
    setRisersRequired(false);
    setRiserRows('');
    setPodiumRequired(false);
    setRepeatEnabled(false);
    setRepeatMode('weekly');
    setRepeatDays([]);
    setRepeatEndDate('');
    setSpecificDates(['']);
    setFastTurnaround(false);
    setSpecialInstructions('');
    setEquipment(['Laptop', 'Screen']);
  }

  async function submitRequest(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !user) {
      setError('Sign in before submitting an Event Setup request.');
      return;
    }
    setError(null);
    setSuccess(null);
    const frontRowCount = numeric(frontRows);
    const frontColumnCount = numeric(frontColumns);
    const backRowCount = numeric(backRows);
    const backColumnCount = numeric(backColumns);
    const tableTotal = numeric(tableCount);
    const chairCount = numeric(chairsPerTable);

    if (frontRowCount > 0 !== frontColumnCount > 0 || backRowCount > 0 !== backColumnCount > 0) {
      setError('Enter both rows and columns for each exam desk area, or leave both as zero.');
      return;
    }
    if (setupType === 'exam' && frontRowCount + backRowCount === 0) {
      setError('Enter a front-of-hall or back-of-hall desk layout for the exam.');
      return;
    }
    if (
      setupType === 'exam' &&
      frontRowCount * frontColumnCount + backRowCount * backColumnCount > 2000
    ) {
      setError(
        'Exam desk preview is limited to 2,000 desks. Reduce the requested rows or columns.',
      );
      return;
    }
    const needsSeatLayout =
      setupType === 'custom' ||
      setupType === 'assembly' ||
      (setupType === 'event' && eventChairsRequired);
    if (needsSeatLayout && (!seatingLayout || seatingLayout.total > 2000)) {
      setError(
        setupType === 'event'
          ? 'Enter a chair layout of no more than 2,000 chairs.'
          : 'Enter rows, sections, and seats per row for a layout of no more than 2,000 seats.',
      );
      return;
    }
    if (numeric(seatBackRowChairs) < 0 || numeric(seatBackRowChairs) > 100) {
      setError('The additional back row must contain between 0 and 100 chairs.');
      return;
    }
    if (repeatEnabled && repeatMode === 'weekly' && repeatDays.length === 0) {
      setError('Choose at least one day for the weekly repeat.');
      return;
    }
    if (repeatEnabled && repeatMode === 'weekly' && (!repeatEndDate || repeatEndDate < eventDate)) {
      setError('Choose a recurrence end date on or after the first event date.');
      return;
    }
    if (
      repeatEnabled &&
      repeatMode === 'weekly' &&
      !repeatDays.includes(new Date(`${eventDate}T12:00:00`).getDay())
    ) {
      setError('The first event date must match one of the selected weekly repeat days.');
      return;
    }
    const additionalDates = specificDates.filter(Boolean);
    if (repeatEnabled && repeatMode === 'specific_dates' && additionalDates.length === 0) {
      setError('Add at least one more event date to repeat this event.');
      return;
    }
    if (
      repeatEnabled &&
      repeatMode === 'specific_dates' &&
      (new Set([eventDate, ...additionalDates]).size !== additionalDates.length + 1 ||
        additionalDates.some((date) => date < eventDate))
    ) {
      setError('Additional event dates must be unique and on or after the first event date.');
      return;
    }
    if (risersRequired && numeric(riserRows) < 1) {
      setError('Enter the number of rows of risers required.');
      return;
    }

    setSubmitting(true);
    try {
      const { error: insertError } = await supabase.from('event_setup_requests').insert({
        requester_id: user.id,
        event_title: eventTitle.trim(),
        setup_type: setupType,
        event_date: eventDate,
        setup_time: setupTime,
        location: location.trim(),
        exam_front_rows: setupType === 'exam' && frontRowCount ? frontRowCount : null,
        exam_front_columns: setupType === 'exam' && frontRowCount ? frontColumnCount : null,
        exam_back_rows: setupType === 'exam' && backRowCount ? backRowCount : null,
        exam_back_columns: setupType === 'exam' && backRowCount ? backColumnCount : null,
        total_seats: needsSeatLayout ? seatingLayout?.total : null,
        seat_rows: needsSeatLayout ? seatingLayout?.rows : null,
        seat_sections: needsSeatLayout ? seatingLayout?.sections : null,
        seats_per_section_row: needsSeatLayout ? seatingLayout?.perRow : null,
        seat_back_row_chairs: needsSeatLayout ? numeric(seatBackRowChairs) : 0,
        equipment,
        seat_placement:
          seatingLayout?.sections !== undefined && seatingLayout.sections <= 2
            ? seatPlacement
            : 'center',
        seat_section_offsets: needsSeatLayout ? seatSectionOffsets : {},
        layout_element_positions: Object.fromEntries(
          layoutElements.map((element) => [element.id, element.position]),
        ),
        round_table_count: tableTotal,
        table_type: tableType,
        chairs_per_table: tableTotal ? chairCount : 0,
        tables_on_stage: tablesOnStage,
        risers_required: risersRequired,
        riser_rows: risersRequired ? numeric(riserRows) : null,
        podium_required: podiumRequired,
        recurrence_days: repeatEnabled && repeatMode === 'weekly' ? repeatDays : [],
        recurrence_end_date: repeatEnabled && repeatMode === 'weekly' ? repeatEndDate : null,
        recurrence_dates: repeatEnabled && repeatMode === 'specific_dates' ? additionalDates : [],
        fast_turnaround: fastTurnaround,
        special_instructions: specialInstructions.trim() || null,
      });
      if (insertError) throw insertError;
      await queryClient.invalidateQueries({ queryKey: ['event-setup-requests', user.id] });
      setSuccess('Your Event Setup request was submitted to the Facilities team.');
      resetForm();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : 'Could not submit the Event Setup request.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  async function changeStatus(request: EventSetupRequest, status: RequestStatus) {
    if (!supabase || !canManage || updatingId) return;
    setError(null);
    setSuccess(null);
    setUpdatingId(request.id);
    try {
      const { data, error: updateError } = await supabase
        .from('event_setup_requests')
        .update({ status })
        .eq('id', request.id)
        .select('id')
        .maybeSingle();
      if (updateError) throw updateError;
      if (!data)
        throw new Error(
          'The request was not updated. It may have changed or your role may not have access.',
        );
      await queryClient.invalidateQueries({ queryKey: ['event-setup-requests', user?.id] });
      setSuccess(`Request marked ${status}.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not update the request status.');
    } finally {
      setUpdatingId(null);
    }
  }

  function toggleRepeatDay(day: number) {
    setRepeatDays((current) =>
      current.includes(day)
        ? current.filter((value) => value !== day)
        : [...current, day].sort((left, right) => left - right),
    );
  }

  function updateSpecificDate(index: number, value: string) {
    setSpecificDates((current) => {
      const next = [...current];
      next[index] = value;
      while (next.length > 1 && next.at(-1) === '' && next.at(-2) === '') next.pop();
      if (next.at(-1) !== '') next.push('');
      return next;
    });
  }

  return (
    <section className="space-y-5">
      <header>
        <h1 className="page-title">Event Setup</h1>
        <p className="page-subtitle">Request a room setup from the Facilities team.</p>
      </header>

      {error && (
        <p role="alert" className="alert-error">
          {error}
        </p>
      )}
      {success && (
        <p role="status" className="alert-success">
          {success}
        </p>
      )}

      <form
        onSubmit={submitRequest}
        className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5"
      >
        <div>
          <h2 className="text-base font-semibold text-brand-navy">Request setup</h2>
          <p className="mt-0.5 text-xs text-slate-600">
            Choose a setup and see the layout preview below.
          </p>
        </div>

        <div className="max-w-sm">
          <label htmlFor="event-setup-preset" className="field-label">
            Start from a preset
          </label>
          <select
            id="event-setup-preset"
            value={selectedPreset}
            onChange={(event) => applyPreset(event.target.value)}
            className="field-select"
          >
            <option value="">Choose a preset…</option>
            <option value="primary-assembly">Primary Assembly</option>
          </select>
        </div>

        <div className="grid grid-cols-1 gap-x-3 gap-y-2 sm:grid-cols-2 lg:grid-cols-4">
          <div className="sm:col-span-2">
            <label htmlFor="event-title" className="field-label">
              Event name
            </label>
            <input
              id="event-title"
              required
              maxLength={160}
              value={eventTitle}
              onChange={(event) => setEventTitle(event.target.value)}
              className="field"
            />
          </div>
          <div>
            <label htmlFor="setup-type" className="field-label">
              Setup choice
            </label>
            <select
              id="setup-type"
              value={setupType}
              onChange={(event) => {
                const value = event.target.value as SetupType;
                setSetupType(value);
                if (value === 'assembly' && !seatRows && !seatSections && !seatsPerRow) {
                  setSeatSections('2');
                  setSeatsPerRow('10');
                  setSeatRows('20');
                }
              }}
              className="field-select"
            >
              <option value="exam">Exam</option>
              <option value="event">Event</option>
              <option value="assembly">Assembly</option>
              <option value="custom">Custom layout</option>
            </select>
          </div>
          <div>
            <label htmlFor="event-date" className="field-label">
              {repeatEnabled && repeatMode === 'specific_dates'
                ? 'Date 1 · Event date'
                : 'Event date'}
            </label>
            <input
              id="event-date"
              required
              type="date"
              min={localDate()}
              value={eventDate}
              onChange={(event) => setEventDate(event.target.value)}
              className="field"
            />
          </div>
          <div>
            <label htmlFor="setup-time" className="field-label">
              Setup by
            </label>
            <input
              id="setup-time"
              required
              type="time"
              value={setupTime}
              onChange={(event) => setSetupTime(event.target.value)}
              className="field"
            />
          </div>
          <div className="sm:col-span-2 lg:col-span-2">
            <label htmlFor="event-location" className="field-label">
              Venue / location
            </label>
            <input
              id="event-location"
              required
              maxLength={160}
              value={location}
              onChange={(event) => setLocation(event.target.value)}
              className="field"
              placeholder="Hall, room, or outdoor area"
            />
          </div>
        </div>

        <fieldset className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <legend className="w-full text-sm font-semibold text-slate-800">
            Equipment requested
          </legend>
          {EVENT_SETUP_EQUIPMENT.map((item) => (
            <label key={item} className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={equipment.includes(item)}
                onChange={(event) =>
                  setEquipment((current) =>
                    event.target.checked
                      ? [...current, item]
                      : current.filter((selected) => selected !== item),
                  )
                }
              />
              {item}
            </label>
          ))}
        </fieldset>

        {setupType === 'exam' && (
          <>
            <fieldset className="space-y-2">
              <legend className="mb-1 text-sm font-semibold text-slate-800">
                Exam desks (rows × columns)
              </legend>
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="rounded-lg border border-slate-200 p-2">
                  <h3 className="mb-1 text-xs font-medium">Front of hall</h3>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="field-label">
                      Rows
                      <input
                        aria-label="Front of hall rows"
                        type="number"
                        min="0"
                        max="100"
                        value={frontRows}
                        onChange={(event) => setFrontRows(event.target.value)}
                        className="field mt-1"
                      />
                    </label>
                    <label className="field-label">
                      Columns
                      <input
                        aria-label="Front of hall columns"
                        type="number"
                        min="0"
                        max="100"
                        value={frontColumns}
                        onChange={(event) => setFrontColumns(event.target.value)}
                        className="field mt-1"
                      />
                    </label>
                  </div>
                </div>
                <div className="rounded-lg border border-slate-200 p-2">
                  <h3 className="mb-1 text-xs font-medium">Back of hall</h3>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="field-label">
                      Rows
                      <input
                        aria-label="Back of hall rows"
                        type="number"
                        min="0"
                        max="100"
                        value={backRows}
                        onChange={(event) => setBackRows(event.target.value)}
                        className="field mt-1"
                      />
                    </label>
                    <label className="field-label">
                      Columns
                      <input
                        aria-label="Back of hall columns"
                        type="number"
                        min="0"
                        max="100"
                        value={backColumns}
                        onChange={(event) => setBackColumns(event.target.value)}
                        className="field mt-1"
                      />
                    </label>
                  </div>
                </div>
              </div>
            </fieldset>
            {(numeric(frontRows) > 0 || numeric(backRows) > 0) && (
              <details open className="rounded-lg border border-slate-200 bg-slate-50 p-2">
                <summary className="cursor-pointer text-sm font-semibold text-slate-800">
                  Setup preview
                </summary>
                <div className="pt-2">
                  <p className="mb-2 text-xs font-medium text-slate-700">
                    Exam desks · Stage at front ·{' '}
                    {numeric(frontRows) * numeric(frontColumns) +
                      numeric(backRows) * numeric(backColumns)}{' '}
                    desks
                  </p>
                  <div className="mx-auto mb-1 max-w-xl rounded-md bg-[#1a2744] px-3 py-1 text-center text-xs font-semibold uppercase tracking-widest text-white">
                    Stage · Front
                  </div>
                  {tablesOnStage && tableElements.length > 0 && (
                    <EventLayoutElements
                      elements={tableElements}
                      onPositionsChange={updateLayoutElementPositions}
                    />
                  )}
                  {frontElements.length > 0 && (
                    <EventLayoutElements
                      elements={frontElements}
                      onPositionsChange={updateLayoutElementPositions}
                    />
                  )}
                  <div className="max-h-[28rem] overflow-auto">
                    <div className="mx-auto flex w-fit min-w-fit flex-col items-center gap-3">
                      {numeric(frontRows) > 0 && (
                        <SeatBlock
                          section="Front of hall"
                          rows={numeric(frontRows)}
                          seatsPerRow={numeric(frontColumns)}
                          align="left"
                          itemType="desk"
                        />
                      )}
                      {numeric(backRows) > 0 && (
                        <SeatBlock
                          section="Back of hall"
                          rows={numeric(backRows)}
                          seatsPerRow={numeric(backColumns)}
                          align="left"
                          itemType="desk"
                        />
                      )}
                    </div>
                  </div>
                </div>
              </details>
            )}
          </>
        )}

        {(setupType === 'custom' || setupType === 'assembly') && (
          <fieldset className="space-y-2">
            <legend className="text-sm font-semibold text-slate-800">
              {setupType === 'assembly' ? 'Assembly seating layout' : 'Custom seat layout'}
            </legend>
            <div className="grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-5">
              <label className="field-label">
                Sections
                <input
                  required
                  type="number"
                  min="1"
                  max="20"
                  value={seatSections}
                  onChange={(event) => {
                    setSeatSections(event.target.value);
                    if (Number(event.target.value) > 2) {
                      setSeatPlacement('center');
                      setSeatSectionOffsets({});
                      setEventChairsRequired(false);
                    }
                  }}
                  className="field mt-1"
                />
              </label>
              <label className="field-label">
                Seats per row (each section)
                <input
                  required
                  type="number"
                  min="1"
                  max="100"
                  value={seatsPerRow}
                  onChange={(event) => setSeatsPerRow(event.target.value)}
                  className="field mt-1"
                />
              </label>
              <label className="field-label">
                Balcony chairs (away from stage)
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={seatBackRowChairs}
                  onChange={(event) => setSeatBackRowChairs(event.target.value)}
                  className="field mt-1"
                />
              </label>
              <label className="field-label">
                Total rows
                <input
                  required
                  type="number"
                  min="1"
                  max="100"
                  value={seatRows}
                  onChange={(event) => setSeatRows(event.target.value)}
                  className="field mt-1"
                />
              </label>
              <div>
                <span className="field-label">Total seats</span>
                <output className="field flex items-center bg-slate-50" aria-live="polite">
                  {seatingLayout?.total ?? 0}
                </output>
              </div>
            </div>
            {seatingLayout && seatingLayout.sections <= 2 && (
              <div className="max-w-md">
                <label htmlFor="seat-placement" className="field-label">
                  Placement
                </label>
                <select
                  id="seat-placement"
                  value={seatPlacement}
                  onChange={(event) => {
                    setSeatPlacement(event.target.value as 'left' | 'right' | 'center' | 'outside');
                    setSeatSectionOffsets({});
                  }}
                  className="field-select"
                >
                  <option value="left">Left side of hall</option>
                  <option value="right">Right side of hall</option>
                  <option value="center">Center of hall</option>
                  <option value="outside">Outside edges of hall</option>
                </select>
              </div>
            )}
            {seatingLayout && seatingLayout.total <= 2000 ? (
              <details open className="rounded-lg border border-slate-200 bg-slate-50 p-2">
                <summary className="cursor-pointer text-sm font-semibold text-slate-800">
                  Setup preview
                </summary>
                <div className="pt-2">
                  <p className="mb-2 text-xs font-medium text-slate-700">
                    Stage at front · {seatingLayout.sections} sections × {seatingLayout.rows} rows ×{' '}
                    {seatingLayout.perRow} seats per section per row · {seatingLayout.total} seats
                  </p>
                  <div className="mx-auto mb-1 max-w-xl rounded-md bg-[#1a2744] px-3 py-1 text-center text-xs font-semibold uppercase tracking-widest text-white">
                    Stage · Front
                  </div>
                  {tablesOnStage && tableElements.length > 0 && (
                    <EventLayoutElements
                      elements={tableElements}
                      onPositionsChange={updateLayoutElementPositions}
                    />
                  )}
                  {frontElements.length > 0 && (
                    <EventLayoutElements
                      elements={frontElements}
                      onPositionsChange={updateLayoutElementPositions}
                    />
                  )}
                  <p className="mb-2 text-xs text-slate-600">
                    Drag each section left or right using its move handle. You can also focus a
                    handle and use the arrow keys.
                  </p>
                  <div className="max-h-[28rem] overflow-auto">
                    <HallSeatMap
                      sections={seatingLayout.sections}
                      rows={seatingLayout.rows}
                      seatsPerRow={seatingLayout.perRow}
                      backRowChairs={numeric(seatBackRowChairs)}
                      placement={seatPlacement}
                      offsets={seatSectionOffsets}
                      onOffsetsChange={setSeatSectionOffsets}
                    />
                  </div>
                </div>
              </details>
            ) : seatingLayout && seatingLayout.total > 2000 ? (
              <p role="alert" className="text-sm text-rose-700">
                The seat map is limited to 2,000 seats. Reduce the number of sections, rows, or
                seats per row.
              </p>
            ) : null}
          </fieldset>
        )}

        <details className="rounded-lg border border-slate-200 p-3">
          <summary className="cursor-pointer text-sm font-semibold text-slate-800">
            Additional elements
          </summary>
          <div className="mt-3 space-y-3">
            {setupType === 'event' && (
              <fieldset className="space-y-2">
                <legend className="text-sm font-semibold text-slate-800">Event chairs</legend>
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={eventChairsRequired}
                    onChange={(event) => {
                      setEventChairsRequired(event.target.checked);
                      if (!event.target.checked) setSeatSectionOffsets({});
                    }}
                  />
                  Chairs required
                </label>
                {eventChairsRequired && (
                  <>
                    <div className="grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-5">
                      <label className="field-label">
                        Sections
                        <input
                          required
                          type="number"
                          min="1"
                          max="20"
                          value={seatSections}
                          onChange={(event) => {
                            setSeatSections(event.target.value);
                            if (Number(event.target.value) > 2) {
                              setSeatPlacement('center');
                              setSeatSectionOffsets({});
                            }
                          }}
                          className="field mt-1"
                        />
                      </label>
                      <label className="field-label">
                        Chairs per row (each section)
                        <input
                          required
                          type="number"
                          min="1"
                          max="100"
                          value={seatsPerRow}
                          onChange={(event) => setSeatsPerRow(event.target.value)}
                          className="field mt-1"
                        />
                      </label>
                      <label className="field-label">
                        Balcony chairs (away from stage)
                        <input
                          type="number"
                          min="0"
                          max="100"
                          value={seatBackRowChairs}
                          onChange={(event) => setSeatBackRowChairs(event.target.value)}
                          className="field mt-1"
                        />
                      </label>
                      <label className="field-label">
                        Total rows
                        <input
                          required
                          type="number"
                          min="1"
                          max="100"
                          value={seatRows}
                          onChange={(event) => setSeatRows(event.target.value)}
                          className="field mt-1"
                        />
                      </label>
                      <div>
                        <span className="field-label">Total chairs</span>
                        <output className="field flex items-center bg-slate-50" aria-live="polite">
                          {seatingLayout?.total ?? 0}
                        </output>
                      </div>
                    </div>
                    {seatingLayout && seatingLayout.sections <= 2 && (
                      <label className="field-label block max-w-md">
                        Placement
                        <select
                          value={seatPlacement}
                          onChange={(event) => {
                            setSeatPlacement(
                              event.target.value as 'left' | 'right' | 'center' | 'outside',
                            );
                            setSeatSectionOffsets({});
                          }}
                          className="field-select mt-1"
                        >
                          <option value="left">Left side of hall</option>
                          <option value="right">Right side of hall</option>
                          <option value="center">Center of hall</option>
                          <option value="outside">Outside edges of hall</option>
                        </select>
                      </label>
                    )}
                    {seatingLayout && seatingLayout.total > 2000 && (
                      <p role="alert" className="text-sm text-rose-700">
                        The chair map is limited to 2,000 chairs. Reduce the number of sections,
                        rows, or chairs per row.
                      </p>
                    )}
                  </>
                )}
              </fieldset>
            )}
            <fieldset className="grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-4">
              <legend className="col-span-full text-sm font-semibold text-slate-800">Tables</legend>
              <label className="field-label">
                Table type
                <select
                  value={tableType}
                  onChange={(event) => setTableType(event.target.value as 'round' | 'long')}
                  className="field-select mt-1"
                >
                  <option value="round">Round tables</option>
                  <option value="long">Long tables</option>
                </select>
              </label>
              <label className="field-label">
                Number of tables
                <input
                  type="number"
                  min="0"
                  max="200"
                  value={tableCount}
                  onChange={(event) => setTableCount(event.target.value)}
                  className="field mt-1"
                />
              </label>
              <label className="field-label">
                Chairs per table
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={chairsPerTable}
                  onChange={(event) => setChairsPerTable(event.target.value)}
                  className="field mt-1"
                />
              </label>
            </fieldset>

            <fieldset className="flex flex-wrap items-center gap-x-5 gap-y-2">
              <legend className="w-full text-sm font-semibold text-slate-800">
                Stage and floor elements
              </legend>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={tablesOnStage}
                  onChange={(event) => setTablesOnStage(event.target.checked)}
                />
                Set tables on the stage
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={risersRequired}
                  onChange={(event) => setRisersRequired(event.target.checked)}
                />
                Risers required
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={podiumRequired}
                  onChange={(event) => setPodiumRequired(event.target.checked)}
                />
                Podium required
              </label>
              {risersRequired && (
                <label className="field-label block w-40">
                  Number of riser rows
                  <input
                    required
                    type="number"
                    min="1"
                    max="30"
                    value={riserRows}
                    onChange={(event) => setRiserRows(event.target.value)}
                    className="field mt-1"
                  />
                </label>
              )}
            </fieldset>
          </div>
        </details>

        {setupType === 'event' &&
          (layoutElements.length > 0 || (eventChairsRequired && seatingLayout)) && (
            <details open className="rounded-lg border border-slate-200 bg-slate-50 p-2">
              <summary className="cursor-pointer text-sm font-semibold text-slate-800">
                Setup preview
              </summary>
              <div className="pt-2">
                <p className="mb-2 text-xs text-slate-600">
                  Drag each element to position it. Adding elements in front of the seating area
                  pushes the chairs back.
                </p>
                <div className="mx-auto mb-1 max-w-xl rounded-md bg-[#1a2744] px-3 py-1 text-center text-xs font-semibold uppercase tracking-widest text-white">
                  Stage · Front
                </div>
                {tablesOnStage && tableElements.length > 0 && (
                  <EventLayoutElements
                    elements={tableElements}
                    onPositionsChange={updateLayoutElementPositions}
                  />
                )}
                {frontElements.length > 0 && (
                  <EventLayoutElements
                    elements={frontElements}
                    onPositionsChange={updateLayoutElementPositions}
                  />
                )}
                {eventChairsRequired && seatingLayout && seatingLayout.total <= 2000 && (
                  <div className="max-h-[28rem] overflow-auto">
                    <p className="mb-2 text-xs font-medium text-slate-700">
                      {seatingLayout.total} chairs · {seatingLayout.sections} sections ×{' '}
                      {seatingLayout.rows} rows × {seatingLayout.perRow} chairs per row
                      {numeric(seatBackRowChairs) > 0 &&
                        ` + ${numeric(seatBackRowChairs)} balcony chairs`}
                    </p>
                    <HallSeatMap
                      sections={seatingLayout.sections}
                      rows={seatingLayout.rows}
                      seatsPerRow={seatingLayout.perRow}
                      backRowChairs={numeric(seatBackRowChairs)}
                      placement={seatPlacement}
                      offsets={seatSectionOffsets}
                      onOffsetsChange={setSeatSectionOffsets}
                    />
                  </div>
                )}
              </div>
            </details>
          )}

        <fieldset className="space-y-2">
          <legend className="text-sm font-semibold text-slate-800">
            Repeat schedule (optional)
          </legend>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={repeatEnabled}
              onChange={(event) => {
                setRepeatEnabled(event.target.checked);
                if (!event.target.checked) {
                  setRepeatDays([]);
                  setRepeatEndDate('');
                  setSpecificDates(['']);
                }
              }}
            />
            Repeat this event
          </label>
          {repeatEnabled && (
            <div className="space-y-3 rounded-md bg-slate-50 p-3">
              <div className="flex flex-wrap gap-4">
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="radio"
                    name="repeat-mode"
                    value="weekly"
                    checked={repeatMode === 'weekly'}
                    onChange={() => setRepeatMode('weekly')}
                  />
                  Weekly
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="radio"
                    name="repeat-mode"
                    value="specific_dates"
                    checked={repeatMode === 'specific_dates'}
                    onChange={() => setRepeatMode('specific_dates')}
                  />
                  Specific dates
                </label>
              </div>
              {repeatMode === 'weekly' ? (
                <>
                  <div className="flex flex-wrap gap-x-3 gap-y-1">
                    {WEEKDAYS.map((day, index) => (
                      <label key={day} className="flex items-center gap-2 text-sm text-slate-700">
                        <input
                          type="checkbox"
                          checked={repeatDays.includes(index)}
                          onChange={() => toggleRepeatDay(index)}
                        />
                        {day}
                      </label>
                    ))}
                  </div>
                  <label className="field-label inline-flex items-center gap-2">
                    Repeat through
                    <input
                      required
                      type="date"
                      min={eventDate || localDate()}
                      value={repeatEndDate}
                      onChange={(event) => setRepeatEndDate(event.target.value)}
                      className="field w-40"
                    />
                  </label>
                </>
              ) : (
                <div className="space-y-2">
                  <p className="text-xs text-slate-600">
                    The event date above is Date 1. Add dates below; a new blank appears after each
                    date you enter.
                  </p>
                  {specificDates.map((date, index) => (
                    <label key={index} className="field-label flex max-w-sm items-center gap-3">
                      <span className="w-20">Date {index + 2}</span>
                      <input
                        type="date"
                        min={eventDate || localDate()}
                        value={date}
                        required={index < specificDates.length - 1}
                        onChange={(event) => updateSpecificDate(index, event.target.value)}
                        className="field"
                      />
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}
        </fieldset>

        <div className="space-y-2">
          <label className="flex items-start gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={fastTurnaround}
              onChange={(event) => setFastTurnaround(event.target.checked)}
              className="mt-0.5"
            />
            <span>
              <strong>Fast turnaround / standby needed.</strong> Flag this request for Facilities
              attention when the room needs a quick reconfiguration.
            </span>
          </label>
          <div>
            <label htmlFor="event-instructions" className="field-label">
              Special instructions
            </label>
            <textarea
              id="event-instructions"
              rows={2}
              maxLength={4000}
              value={specialInstructions}
              onChange={(event) => setSpecialInstructions(event.target.value)}
              className="field"
              placeholder="For example: brew coffee, put out flags, or note access requirements."
            />
          </div>
        </div>

        <button
          type="submit"
          disabled={submitting}
          className="btn-primary disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? 'Submitting…' : 'Submit Event Setup request'}
        </button>
      </form>

      {canManage && (
        <section
          aria-labelledby="event-calendar-title"
          className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
        >
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 id="event-calendar-title" className="text-lg font-semibold text-brand-navy">
                Event Setup calendar
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                Facilities view: all requests. This request calendar does not reserve venues or
                check availability.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <button
                type="button"
                aria-label="Previous month"
                onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1, 12))}
                className="rounded-md border border-slate-300 p-2 hover:bg-slate-50"
              >
                <ChevronLeft size={18} />
              </button>
              <h3 className="min-w-36 text-center font-semibold text-slate-800">{monthLabel}</h3>
              <button
                type="button"
                aria-label="Next month"
                onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1, 12))}
                className="rounded-md border border-slate-300 p-2 hover:bg-slate-50"
              >
                <ChevronRight size={18} />
              </button>
            </div>
          </div>
          {requests.isPending && <p className="text-sm text-slate-500">Loading requests…</p>}
          {requests.error && (
            <p role="alert" className="alert-error">
              {requests.error instanceof Error
                ? requests.error.message
                : 'Could not load Event Setup requests.'}
            </p>
          )}
          {!requests.isPending && !requests.error && (
            <div className="grid grid-cols-7 overflow-hidden rounded-lg border border-slate-200">
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => (
                <div
                  key={day}
                  className="border-b border-r border-slate-200 bg-slate-50 p-2 text-center text-xs font-semibold text-slate-600"
                >
                  {day}
                </div>
              ))}
              {cells.map((date, index) => {
                const key = date ? dateKey(date) : `empty-${index}`;
                const dayRequests = date ? (requestsByDate.get(key) ?? []) : [];
                return (
                  <div
                    key={key}
                    className={`min-h-24 border-b border-r border-slate-200 p-1.5 sm:min-h-28 sm:p-2 ${date ? 'bg-white' : 'bg-slate-50'}`}
                  >
                    {date && (
                      <>
                        <span
                          className={`text-xs ${key === dateKey(new Date()) ? 'font-bold text-blue-700' : 'text-slate-600'}`}
                        >
                          {date.getDate()}
                        </span>
                        <div className="mt-1 space-y-1">
                          {dayRequests.slice(0, 3).map((request) => (
                            <button
                              key={request.id}
                              type="button"
                              onClick={() => {
                                setSelectedRequestId(request.id);
                                setSelectedOccurrenceDate(key);
                              }}
                              className={`block w-full truncate rounded px-1.5 py-1 text-left text-[10px] sm:text-xs ${request.fast_turnaround ? 'bg-amber-100 text-amber-950' : 'bg-blue-50 text-blue-900'}`}
                              title={`${request.event_title} · ${request.setup_time.slice(0, 5)}${request.fast_turnaround ? ' · Fast turnaround' : ''}`}
                            >
                              {request.fast_turnaround && (
                                <span className="font-bold">Alert · </span>
                              )}
                              {request.setup_time.slice(0, 5)} {request.event_title}
                            </button>
                          ))}
                          {dayRequests.length > 3 && (
                            <p className="px-1 text-[10px] text-slate-500">
                              +{dayRequests.length - 3} more
                            </p>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {selectedRequest && (
            <article className="mt-5 rounded-lg border border-slate-200 bg-slate-50 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="font-semibold text-slate-900">{selectedRequest.event_title}</h3>
                  <p className="mt-1 text-sm text-slate-600">
                    {displayDate(selectedOccurrenceDate ?? selectedRequest.event_date)} · Setup by{' '}
                    {selectedRequest.setup_time.slice(0, 5)} · {selectedRequest.location}
                  </p>
                  <p className="mt-1 text-sm text-slate-600">
                    {setupTypeLabel(selectedRequest.setup_type)} ·{' '}
                    {configurationSummary(selectedRequest)}
                  </p>
                  {selectedRequest.recurrence_days.length > 0 && (
                    <p className="mt-1 text-sm text-slate-600">
                      Repeats weekly:{' '}
                      {selectedRequest.recurrence_days.map((day) => WEEKDAYS[day]).join(', ')}{' '}
                      through {selectedRequest.recurrence_end_date}
                    </p>
                  )}
                  {selectedRequest.equipment.length > 0 && (
                    <p className="mt-2 text-sm text-slate-700">
                      Equipment: {selectedRequest.equipment.join(', ')}
                    </p>
                  )}
                  {!selectedRequest.recurrence_days.length &&
                    selectedRequest.recurrence_dates?.length > 0 && (
                      <p className="mt-1 text-sm text-slate-600">
                        Event dates:{' '}
                        {[selectedRequest.event_date, ...selectedRequest.recurrence_dates]
                          .filter((date, index, dates) => dates.indexOf(date) === index)
                          .sort()
                          .map(displayDate)
                          .join(', ')}
                      </p>
                    )}
                  {selectedRequest.ticket_id && (
                    <p className="mt-1 text-sm text-slate-600">
                      Facilities ticket:{' '}
                      <Link
                        to={`/tickets/${selectedRequest.ticket_id}`}
                        className="text-blue-800 underline"
                      >
                        Open linked ticket
                      </Link>
                    </p>
                  )}
                  {canManage && (
                    <p className="mt-1 text-sm text-slate-600">
                      Requested by {selectedRequest.requester_name} ·{' '}
                      {selectedRequest.requester_email}
                    </p>
                  )}
                  {selectedRequest.fast_turnaround && (
                    <p className="mt-2 text-sm font-semibold text-amber-800">
                      Fast turnaround / standby requested
                    </p>
                  )}
                  {selectedRequest.special_instructions && (
                    <p className="mt-2 whitespace-pre-wrap text-sm text-slate-700">
                      {selectedRequest.special_instructions}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        await downloadEventRequestPdf(
                          selectedRequest,
                          selectedOccurrenceDate ?? selectedRequest.event_date,
                        );
                      } catch (caught) {
                        setError(
                          caught instanceof Error
                            ? `Could not generate the PDF: ${caught.message}`
                            : 'Could not generate the PDF.',
                        );
                      }
                    }}
                    className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                  >
                    <Download size={16} aria-hidden="true" />
                    Download PDF
                  </button>
                  <span className="rounded-full bg-white px-2.5 py-1 text-xs font-medium capitalize text-slate-700">
                    {selectedRequest.status}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedRequestId(null);
                      setSelectedOccurrenceDate(null);
                    }}
                    className="text-sm text-slate-500 underline"
                  >
                    Close
                  </button>
                </div>
              </div>
              {(selectedLayoutElements.length > 0 ||
                selectedRequest.seat_sections ||
                selectedRequest.setup_type === 'exam') && (
                <div className="mt-4 overflow-auto rounded-md border border-slate-200 bg-white p-3">
                  <h4 className="mb-2 text-sm font-semibold text-slate-800">Event layout</h4>
                  <div className="mx-auto mb-1 max-w-xl rounded-md bg-[#1a2744] px-3 py-1 text-center text-xs font-semibold uppercase tracking-widest text-white">
                    Stage · Front
                  </div>
                  {selectedRequest.tables_on_stage && selectedTableElements.length > 0 && (
                    <EventLayoutElements elements={selectedTableElements} interactive={false} />
                  )}
                  {selectedFrontElements.length > 0 && (
                    <EventLayoutElements elements={selectedFrontElements} interactive={false} />
                  )}
                  {(selectedRequest.setup_type === 'custom' ||
                    selectedRequest.setup_type === 'assembly' ||
                    selectedRequest.setup_type === 'event') &&
                    selectedRequest.seat_sections &&
                    selectedRequest.seat_rows &&
                    selectedRequest.seats_per_section_row && (
                      <HallSeatMap
                        sections={selectedRequest.seat_sections}
                        rows={selectedRequest.seat_rows}
                        seatsPerRow={selectedRequest.seats_per_section_row}
                        backRowChairs={selectedRequest.seat_back_row_chairs}
                        placement={selectedRequest.seat_placement}
                        offsets={selectedRequest.seat_section_offsets ?? {}}
                        interactive={false}
                      />
                    )}
                  {selectedRequest.setup_type === 'exam' && (
                    <div className="mx-auto flex w-fit min-w-[720px] flex-col items-center gap-3 overflow-x-auto">
                      {!!selectedRequest.exam_front_rows && (
                        <SeatBlock
                          section="Front of hall"
                          rows={selectedRequest.exam_front_rows}
                          seatsPerRow={selectedRequest.exam_front_columns ?? 0}
                          align="left"
                          itemType="desk"
                        />
                      )}
                      {!!selectedRequest.exam_back_rows && (
                        <SeatBlock
                          section="Back of hall"
                          rows={selectedRequest.exam_back_rows}
                          seatsPerRow={selectedRequest.exam_back_columns ?? 0}
                          align="left"
                          itemType="desk"
                        />
                      )}
                    </div>
                  )}
                </div>
              )}
            </article>
          )}
        </section>
      )}

      {canManage && (
        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-brand-navy">Facilities request review</h2>
          {hasUpcomingFastTurnaround && (
            <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-900">
              Fast-turnaround requests need standby attention. Review the flagged entries below and
              on the calendar.
            </p>
          )}
          {!requests.data?.length && (
            <p className="mt-3 text-sm text-slate-600">No Event Setup requests yet.</p>
          )}
          {!!requests.data?.length && (
            <div className="mt-4 overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Event</th>
                    <th>Date / setup by</th>
                    <th>Requester</th>
                    <th>Layout</th>
                    <th>Alert</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {requests.data.map((request) => (
                    <tr key={request.id}>
                      <td>
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedRequestId(request.id);
                            setSelectedOccurrenceDate(request.event_date);
                          }}
                          className="font-medium text-blue-800 underline"
                        >
                          {request.event_title}
                        </button>
                        <br />
                        <span className="text-xs text-slate-500">{request.location}</span>
                      </td>
                      <td>
                        {displayDate(request.event_date)}
                        <br />
                        <span className="text-xs text-slate-500">
                          Setup by {request.setup_time.slice(0, 5)}
                        </span>
                      </td>
                      <td>
                        {request.requester_name}
                        <br />
                        <span className="text-xs text-slate-500">{request.requester_email}</span>
                      </td>
                      <td>
                        {setupTypeLabel(request.setup_type)}
                        <br />
                        <span className="text-xs text-slate-500">
                          {configurationSummary(request)}
                        </span>
                      </td>
                      <td>
                        {request.fast_turnaround ? (
                          <span className="font-semibold text-amber-800">Standby</span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td>
                        <select
                          aria-label={`Status for ${request.event_title}`}
                          value={request.status}
                          disabled={updatingId === request.id}
                          onChange={(event) =>
                            void changeStatus(request, event.target.value as RequestStatus)
                          }
                          className="field-select min-w-32"
                        >
                          {REQUEST_STATUSES.map((status) => (
                            <option key={status} value={status}>
                              {status.charAt(0).toUpperCase() + status.slice(1)}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </section>
  );
}
