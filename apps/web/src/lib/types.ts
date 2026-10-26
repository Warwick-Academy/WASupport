/** Database row types — replace with `supabase gen types` output in Phase 2. */

export type Department = 'IT' | 'FAC' | 'AV' | 'HS';
export const TICKET_DEPARTMENTS = ['IT', 'FAC', 'HS'] as const satisfies readonly Department[];
export type TicketDepartment = (typeof TICKET_DEPARTMENTS)[number];
export const DEPARTMENT_CATEGORY_ROOT: Record<TicketDepartment, string> = {
  IT: 'IT',
  FAC: 'Facilities',
  HS: 'Health and Safety',
};
export type TicketStatus =
  | 'awaiting_triage'
  | 'open'
  | 'in_progress'
  | 'on_hold'
  | 'resolved'
  | 'closed';
export type TicketPriority = 'low' | 'normal' | 'high' | 'critical' | 'urgent';
export type UserRole =
  | 'submitter'
  | 'it_tech'
  | 'fac_tech'
  | 'hs_officer'
  | 'av_admin'
  | 'support'
  | 'manager'
  | 'admin'
  | 'leadership';

export interface Profile {
  id: string;
  email: string;
  full_name: string | null;
  role: UserRole;
  department: Department | null;
  show_event_setup: boolean;
  created_at: string;
}

export interface Ticket {
  id: string;
  ref: string;
  department: Department;
  category_id: string | null;
  subcategory_id: string | null;
  subject: string;
  description: string;
  requested_for: string | null;
  time_spent_minutes: number;
  status: TicketStatus;
  priority: TicketPriority;
  submitter_id: string | null;
  assignee_id: string | null;
  location_id: string | null;
  building: string | null;
  room: string | null;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  closed_at: string | null;
  triaged_at: string | null;
  triaged_by: string | null;
  sla_due_at: string | null;
  sla_reminder_approaching_sent: boolean;
  sla_reminder_overdue_sent: boolean;
  legacy_ref: string | null;
  legacy_submitter_name: string | null;
  legacy_assignee_name: string | null;
  legacy_subcategory: string | null;
  legacy_location: string | null;
  imported_from: string | null;
}

export interface TicketMessage {
  id: string;
  ticket_id: string;
  author_id: string;
  body: string;
  is_internal: boolean;
  created_at: string;
}

export interface Category {
  id: string;
  department: Department;
  name: string;
  parent_id: string | null;
  is_active: boolean;
  default_assignee_id: string | null;
}

export interface Location {
  id: string;
  building: string;
  floor: string | null;
  room: string | null;
  label: string;
  is_active: boolean;
}

export const DEPARTMENT_LABEL: Record<Department, string> = {
  IT: 'IT Support',
  FAC: 'Facilities',
  AV: 'Audio Visual',
  HS: 'Health & Safety',
};

/** Team-member roles imply their department (mirrors SQL role_department()). */
export const ROLE_DEPARTMENT: Partial<Record<UserRole, Department>> = {
  it_tech: 'IT',
  fac_tech: 'FAC',
  av_admin: 'AV',
  hs_officer: 'HS',
};

export const PRIORITY_LABEL: Record<TicketPriority, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  critical: 'Critical',
  urgent: 'Urgent',
};

export const STATUS_LABEL: Record<TicketStatus, string> = {
  awaiting_triage: 'Needs review',
  open: 'Open',
  in_progress: 'In progress',
  on_hold: 'On hold',
  resolved: 'Resolved',
  closed: 'Closed',
};

export const ROLE_LABEL: Record<UserRole, string> = {
  submitter: 'Submitter',
  it_tech: 'IT Technician',
  fac_tech: 'Facilities Technician',
  hs_officer: 'H&S Officer',
  av_admin: 'AV Technician / Admin',
  support: 'Support (close only)',
  manager: 'Department Manager',
  admin: 'Administrator',
  leadership: 'Leadership (read only)',
};

export const STATUS_BADGE: Record<TicketStatus, string> = {
  awaiting_triage: 'badge-triage',
  open: 'badge-open',
  in_progress: 'badge-progress',
  on_hold: 'badge-hold',
  resolved: 'badge-resolved',
  closed: 'badge-closed',
};

export const PRIORITY_BADGE: Record<TicketPriority, string> = {
  low: 'badge-low',
  normal: 'badge-normal',
  high: 'badge-high',
  critical: 'badge-critical',
  urgent: 'badge-urgent',
};

export type KbStatus = 'draft' | 'published';

export interface KbArticle {
  id: string;
  slug: string;
  title: string;
  body_md: string;
  summary: string | null;
  department: Department | null;
  tags: string[];
  status: KbStatus;
  author_id: string | null;
  view_count: number;
  created_at: string;
  updated_at: string;
  published_at: string | null;
}
