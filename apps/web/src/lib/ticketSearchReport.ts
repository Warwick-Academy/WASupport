import type { SupabaseClient } from '@supabase/supabase-js';
import { DEPARTMENT_LABEL, PRIORITY_LABEL, STATUS_LABEL, type Category, type Ticket, type TicketDepartment } from './types';

export type SearchReportFilters = {
  department: TicketDepartment | 'all';
  categoryId: string;
  keywords: string;
};

export type SearchReportTicket = Pick<Ticket,
  'id' | 'ref' | 'legacy_ref' | 'department' | 'category_id' | 'subcategory_id' |
  'subject' | 'description' | 'status' | 'priority' | 'created_at' | 'closed_at' |
  'resolved_at' | 'submitter_id' | 'assignee_id' | 'legacy_submitter_name' |
  'legacy_assignee_name' | 'legacy_subcategory' | 'time_spent_minutes'
>;

export type SearchReportRow = {
  ticket: SearchReportTicket;
  category: string;
  subcategory: string;
  submitter: string;
  assignee: string;
};

const PAGE_SIZE = 500;
const FIELDS = 'id,ref,legacy_ref,department,category_id,subcategory_id,subject,description,status,priority,created_at,closed_at,resolved_at,submitter_id,assignee_id,legacy_submitter_name,legacy_assignee_name,legacy_subcategory,time_spent_minutes';

export function matchesReportKeywords(ticket: SearchReportTicket, keywords: string): boolean {
  const text = [ticket.ref, ticket.legacy_ref, ticket.subject, ticket.description]
    .filter(Boolean).join(' ').toLocaleLowerCase();
  return keywords.toLocaleLowerCase().split(/\s+/).filter(Boolean).every((word) => text.includes(word));
}

export async function loadReportCategories(client: SupabaseClient, signal: AbortSignal): Promise<Category[]> {
  const categories: Category[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await client.from('categories').select('*')
      .order('name').order('id').range(offset, offset + PAGE_SIZE - 1)
      .abortSignal(signal).returns<Category[]>();
    if (error) throw error;
    categories.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) return categories;
  }
}

export async function loadTicketSearchReport(
  client: SupabaseClient,
  filters: SearchReportFilters,
  categories: Category[],
  signal: AbortSignal,
): Promise<SearchReportRow[]> {
  const tickets: SearchReportTicket[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    let query = client.from('tickets').select(FIELDS)
      .order('created_at', { ascending: false }).order('id')
      .range(offset, offset + PAGE_SIZE - 1);
    if (filters.department !== 'all') query = query.eq('department', filters.department);
    if (filters.categoryId) {
      query = query.or(`category_id.eq.${filters.categoryId},subcategory_id.eq.${filters.categoryId}`);
    }
    const { data, error } = await query.abortSignal(signal).returns<SearchReportTicket[]>();
    if (error) throw error;
    // Match literal words locally, so punctuation cannot change PostgREST filters.
    tickets.push(...(data ?? []).filter((ticket) => matchesReportKeywords(ticket, filters.keywords)));
    if (!data || data.length < PAGE_SIZE) break;
  }

  const profileIds = [...new Set(tickets.flatMap((ticket) =>
    [ticket.submitter_id, ticket.assignee_id].filter((id): id is string => !!id),
  ))];
  const people = new Map<string, string>();
  for (let offset = 0; offset < profileIds.length; offset += 200) {
    const { data, error } = await client.from('profiles').select('id,full_name,email')
      .in('id', profileIds.slice(offset, offset + 200)).abortSignal(signal)
      .returns<{ id: string; full_name: string | null; email: string }[]>();
    if (error) throw error;
    for (const person of data ?? []) people.set(person.id, person.full_name || person.email);
  }
  const names = new Map(categories.map((category) => [category.id, category.name]));
  return tickets.map((ticket) => ({
    ticket,
    category: ticket.category_id ? names.get(ticket.category_id) ?? 'Category unavailable' : 'Uncategorised',
    subcategory: (ticket.subcategory_id ? names.get(ticket.subcategory_id) : null) ?? ticket.legacy_subcategory ?? '',
    submitter: (ticket.submitter_id ? people.get(ticket.submitter_id) : null) ?? ticket.legacy_submitter_name ?? 'Unknown',
    assignee: (ticket.assignee_id ? people.get(ticket.assignee_id) : null) ?? ticket.legacy_assignee_name ?? 'Unassigned',
  }));
}

export function searchReportCsvRows(rows: SearchReportRow[]): (string | number | null)[][] {
  return [
    ['Reference', 'Legacy reference', 'Subject', 'Department', 'Category', 'Subcategory', 'Status',
      'Priority', 'Created', 'Resolved', 'Closed', 'Submitter', 'Assignee', 'Description', 'Time spent (minutes)'],
    ...rows.map(({ ticket, category, subcategory, submitter, assignee }) => [
      ticket.ref, ticket.legacy_ref, ticket.subject, DEPARTMENT_LABEL[ticket.department], category,
      subcategory, STATUS_LABEL[ticket.status], PRIORITY_LABEL[ticket.priority], ticket.created_at,
      ticket.resolved_at, ticket.closed_at, submitter, assignee, ticket.description, ticket.time_spent_minutes,
    ]),
  ];
}
