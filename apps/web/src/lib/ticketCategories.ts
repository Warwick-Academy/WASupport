import type { SupabaseClient } from '@supabase/supabase-js';
import { DEPARTMENT_CATEGORY_ROOT, type Category, type Department, type Ticket, type UserRole } from './types';

export const OTHER_CATEGORY = '__other__';

export function canEditTicketCategory(role: UserRole | null): boolean {
  return role !== null && ['admin', 'manager', 'it_tech', 'fac_tech', 'hs_officer', 'av_admin'].includes(role);
}

export function categoryRoot(categories: Category[], department: Department): Category | undefined {
  const normalize = (name: string) => name.toLowerCase().replace(/&/g, 'and').replace(/\s+/g, ' ').trim();
  const name = department === 'AV' ? '' : DEPARTMENT_CATEGORY_ROOT[department];
  return categories.find((category) => category.department === department && !category.parent_id &&
    normalize(category.name) === normalize(name));
}

export function ticketCategoryLabel(
  ticket: Pick<Ticket, 'category_id' | 'subcategory_id' | 'legacy_subcategory'>,
  categories: Category[],
): string {
  const selected = categories.find((category) => category.id === ticket.subcategory_id);
  if (selected) return selected.name;
  if (ticket.legacy_subcategory?.trim()) return ticket.legacy_subcategory.trim();
  const category = categories.find((value) => value.id === ticket.category_id);
  return category?.parent_id ? category.name : 'Uncategorised';
}

export function hasTicketCategory(
  ticket: Pick<Ticket, 'category_id' | 'subcategory_id' | 'legacy_subcategory'>,
  categories: Category[],
): boolean {
  return !!ticket.subcategory_id || !!ticket.legacy_subcategory?.trim() ||
    categories.some((category) => category.id === ticket.category_id && !!category.parent_id);
}

export async function resolveTicketCategory(
  client: SupabaseClient,
  rootId: string,
  selection: string,
  otherName: string,
  canCreate: boolean,
): Promise<string> {
  if (!selection) throw new Error('Select a category.');
  if (selection !== OTHER_CATEGORY) return selection;
  if (!canCreate) throw new Error('Only department members, managers, and administrators can add categories.');
  if (!otherName.trim()) throw new Error('Enter a category name.');
  if (otherName.trim().length > 200) throw new Error('Category names must be 200 characters or fewer.');
  const { data, error } = await client.rpc('create_ticket_category', {
    p_parent_id: rootId,
    p_name: otherName.trim(),
  });
  if (error) throw error;
  if (typeof data !== 'string') throw new Error('The new category was not returned.');
  return data;
}
