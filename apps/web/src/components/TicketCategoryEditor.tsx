import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { categoryRoot, OTHER_CATEGORY, ticketCategoryLabel } from '../lib/ticketCategories';
import type { Category, Ticket } from '../lib/types';

export default function TicketCategoryEditor({ ticket, categories, onSaved, initialOther = false, onOtherSelected }: {
  ticket: Ticket;
  categories: Category[];
  onSaved: () => void;
  initialOther?: boolean;
  onOtherSelected?: () => void;
}) {
  const queryClient = useQueryClient();
  const root = categoryRoot(categories, ticket.department);
  const current = ticket.subcategory_id ||
    (categories.find((category) => category.id === ticket.category_id)?.parent_id ? ticket.category_id : '') || '';
  const [selection, setSelection] = useState(
    initialOther || categories.find((category) => category.id === current)?.name.trim().toLowerCase() === 'other'
      ? OTHER_CATEGORY : current,
  );
  const [otherName, setOtherName] = useState('');
  const categoryOptions = categories.filter((category) => category.parent_id === root?.id &&
    category.name.trim().toLowerCase() !== 'other' &&
    (category.is_active || category.id === current)).map((category) =>
    <option key={category.id} value={category.id}>{category.name}{!category.is_active ? ' (retired)' : ''}</option>,
  );
  const save = useMutation({
    mutationFn: async (categorySelection: string = selection) => {
      if (!supabase || !root) throw new Error('Department categories are not available.');
      const { error } = await supabase.rpc('set_ticket_category', {
        p_ticket_id: ticket.id,
        p_category_id: categorySelection === OTHER_CATEGORY ? null : categorySelection,
        p_other_name: categorySelection === OTHER_CATEGORY ? otherName.trim() : null,
      });
      if (error) throw error;
    },
    onSuccess: async () => {
      onSaved();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['ticket', ticket.id] }),
        queryClient.invalidateQueries({ queryKey: ['tickets'] }),
        queryClient.invalidateQueries({ queryKey: ['ticket-categories'] }),
        queryClient.invalidateQueries({ queryKey: ['categories'] }),
        queryClient.invalidateQueries({ queryKey: ['ticket-search-report-categories'] }),
        queryClient.invalidateQueries({ queryKey: ['ticket-search-report'] }),
        queryClient.invalidateQueries({ queryKey: ['department-ticket-report'] }),
        queryClient.invalidateQueries({ queryKey: ['department-kpis'] }),
        queryClient.invalidateQueries({ queryKey: ['admin-categories'] }),
      ]);
    },
  });
  if (onOtherSelected) {
    return (
      <div>
        <select aria-label={`Category for ${ticket.ref}`} className="field-select-sm w-44 py-1 text-xs disabled:opacity-60"
          value={selection === OTHER_CATEGORY ? '' : current} disabled={!root || save.isPending}
          onChange={(event) => {
            save.reset();
            if (event.target.value === OTHER_CATEGORY) onOtherSelected();
            else save.mutate(event.target.value);
          }}>
          <option value="" disabled>{ticketCategoryLabel(ticket, categories)}</option>
          {categoryOptions}
          {root && <option value={OTHER_CATEGORY}>Other</option>}
        </select>
        {!root && <p role="alert" className="text-xs text-rose-700">Department categories are not available.</p>}
        {save.error && <p role="alert" className="text-xs text-rose-700">Could not save category: {save.error.message}</p>}
      </div>
    );
  }
  return (
    <form id="ticket-category-editor" className="mt-6 space-y-3 border-t border-slate-100 pt-5" onSubmit={(event) => {
      event.preventDefault();
      save.mutate(selection);
    }}>
      <p className="text-sm text-slate-600">
        Select and save a category before resolving or closing this ticket.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <label>
          <span className="field-label">Category</span>
          <select className="field-select-sm" value={selection} disabled={!root || save.isPending}
            required onChange={(event) => { setSelection(event.target.value); setOtherName(''); save.reset(); }}>
            <option value="">Select a category</option>
            {categoryOptions}
            {root && <option value={OTHER_CATEGORY}>Other</option>}
          </select>
        </label>
        {selection === OTHER_CATEGORY && <label>
          <span className="field-label">Other category</span>
          <input className="field-sm" required autoFocus={initialOther} maxLength={200} value={otherName}
            onChange={(event) => { setOtherName(event.target.value); save.reset(); }} placeholder="Enter a category" />
        </label>}
        <button type="submit" className="btn-primary px-4 py-2"
          disabled={!root || !selection || save.isPending || (selection === OTHER_CATEGORY && !otherName.trim())}>
          {save.isPending ? 'Saving...' : 'Save category'}
        </button>
      </div>
      {!root && <p role="alert" className="alert-error">No category root is configured for this department.</p>}
      {save.error && <p role="alert" className="alert-error">Could not save category: {save.error.message}</p>}
      {save.isSuccess && <p role="status" className="text-sm text-emerald-700">Category saved.</p>}
    </form>
  );
}
