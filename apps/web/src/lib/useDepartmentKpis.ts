import { useQuery } from '@tanstack/react-query';
import { supabase } from './supabase';
import type { Department } from './types';

export type DepartmentKpis = {
  department: Department;
  new_tickets: number;
  new_tickets_prev: number;
  open_tickets: number;
  unassigned: number;
  resolved_tickets: number;
  resolved_prev: number;
  uncategorized_tickets: number;
};

export function useDepartmentKpis(
  from: string,
  to: string,
  enabled = true,
  userId?: string,
) {
  return useQuery({
    queryKey: ['department-kpis', userId, from, to],
    enabled,
    queryFn: async (): Promise<DepartmentKpis[]> => {
      if (!supabase) throw new Error('Supabase not configured');
      const { data, error } = await supabase.rpc('dashboard_department_kpis', {
        from_date: from,
        to_date: to,
      });
      if (error) throw error;
      return (data ?? []) as DepartmentKpis[];
    },
  });
}