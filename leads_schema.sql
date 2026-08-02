-- ==================================================
-- LEAD GENERATION & CRM SCHEMA
-- ==================================================
-- All tables are multi-tenant and scoped by client_id,
-- following the existing My Grafix OS pattern
-- (FK -> clients(client_id) ON DELETE CASCADE, RLS policies).

-- ==================================================
-- LEAD COMPANIES (Company profiles)
-- ==================================================
create table if not exists public.lead_companies (
  id uuid not null default gen_random_uuid(),
  client_id text not null,
  name text not null,
  industry text null,
  website text null,
  domain text null,
  phone text null,
  email text null,
  address text null,
  city text null,
  country text null,
  size_bucket text null,
  description text null,
  logo_url text null,
  social_links jsonb not null default '{}'::jsonb,
  tags jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lead_companies_pkey primary key (id),
  constraint lead_companies_client_id_fkey foreign key (client_id) references public.clients (client_id) on delete cascade
);

create index if not exists idx_lead_companies_client on public.lead_companies (client_id);
create index if not exists idx_lead_companies_name on public.lead_companies (client_id, name);
create index if not exists idx_lead_companies_domain on public.lead_companies (client_id, domain);

-- ==================================================
-- LEAD CONTACTS (Contacts / People)
-- ==================================================
create table if not exists public.lead_contacts (
  id uuid not null default gen_random_uuid(),
  client_id text not null,
  company_id uuid null,
  first_name text null,
  last_name text null,
  email text null,
  phone text null,
  job_title text null,
  avatar_url text null,
  primary_contact boolean not null default false,
  notes text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lead_contacts_pkey primary key (id),
  constraint lead_contacts_client_id_fkey foreign key (client_id) references public.clients (client_id) on delete cascade,
  constraint lead_contacts_company_fkey foreign key (company_id) references public.lead_companies (id) on delete set null
);

create index if not exists idx_lead_contacts_client on public.lead_contacts (client_id);
create index if not exists idx_lead_contacts_company on public.lead_contacts (company_id);
create index if not exists idx_lead_contacts_email on public.lead_contacts (client_id, email);

-- ==================================================
-- LEAD STAGES (Pipeline columns / Kanban)
-- ==================================================
create table if not exists public.lead_stages (
  id uuid not null default gen_random_uuid(),
  client_id text not null,
  name text not null,
  position integer not null default 0,
  color text not null default 'violet',
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  constraint lead_stages_pkey primary key (id),
  constraint lead_stages_client_id_fkey foreign key (client_id) references public.clients (client_id) on delete cascade
);

create index if not exists idx_lead_stages_client on public.lead_stages (client_id);

-- ==================================================
-- LEADS (the opportunity / activity record)
-- ==================================================
create table if not exists public.leads (
  id uuid not null default gen_random_uuid(),
  client_id text not null,
  company_id uuid null,
  contact_id uuid null,
  stage text not null default 'Untapped',
  status text not null default 'new',
  priority text not null default 'medium',
  source text not null default 'manual',
  score integer not null default 0,
  score_breakdown jsonb not null default '{}'::jsonb,
  opportunity_level text null,
  recommended_services jsonb not null default '[]'::jsonb,
  ai_summary jsonb not null default '{}'::jsonb,
  website text null,
  website_url text null,
  social_links jsonb not null default '{}'::jsonb,
  emails jsonb not null default '[]'::jsonb,
  phones jsonb not null default '[]'::jsonb,
  address text null,
  estimated_value numeric(10,2) null,
  assigned_to text null,
  assigned_name text null,
  tags jsonb not null default '[]'::jsonb,
  custom_fields jsonb not null default '{}'::jsonb,
  notes text null,
  next_followup_at timestamptz null,
  last_contacted_at timestamptz null,
  won_at timestamptz null,
  loss_reason text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint leads_pkey primary key (id),
  constraint leads_client_id_fkey foreign key (client_id) references public.clients (client_id) on delete cascade,
  constraint leads_company_fkey foreign key (company_id) references public.lead_companies (id) on delete set null,
  constraint leads_contact_fkey foreign key (contact_id) references public.lead_contacts (id) on delete set null
);

create index if not exists idx_leads_client on public.leads (client_id);
create index if not exists idx_leads_company on public.leads (company_id);
create index if not exists idx_leads_stage on public.leads (client_id, stage);
create index if not exists idx_leads_status on public.leads (client_id, status);
create index if not exists idx_leads_score on public.leads (client_id, score);
create index if not exists idx_leads_created on public.leads (created_at desc);

-- ==================================================
-- LEAD NOTES
-- ==================================================
create table if not exists public.lead_notes (
  id uuid not null default gen_random_uuid(),
  client_id text not null,
  lead_id uuid not null,
  author text null,
  body text not null,
  created_at timestamptz not null default now(),
  constraint lead_notes_pkey primary key (id),
  constraint lead_notes_client_id_fkey foreign key (client_id) references public.clients (client_id) on delete cascade,
  constraint lead_notes_lead_fkey foreign key (lead_id) references public.leads (id) on delete cascade
);

create index if not exists idx_lead_notes_lead on public.lead_notes (lead_id);

-- ==================================================
-- LEAD TASKS (task manager / to-dos)
-- ==================================================
create table if not exists public.lead_tasks (
  id uuid not null default gen_random_uuid(),
  client_id text not null,
  lead_id uuid null,
  title text not null,
  description text null,
  due_date timestamptz null,
  status text not null default 'pending',
  assigned_to text null,
  created_at timestamptz not null default now(),
  completed_at timestamptz null,
  constraint lead_tasks_pkey primary key (id),
  constraint lead_tasks_client_id_fkey foreign key (client_id) references public.clients (client_id) on delete cascade,
  constraint lead_tasks_lead_fkey foreign key (lead_id) references public.leads (id) on delete cascade
);

create index if not exists idx_lead_tasks_client on public.lead_tasks (client_id);
create index if not exists idx_lead_tasks_lead on public.lead_tasks (lead_id);

-- ==================================================
-- LEAD ACTIVITIES (timeline events)
-- ==================================================
create table if not exists public.lead_activities (
  id uuid not null default gen_random_uuid(),
  client_id text not null,
  lead_id uuid not null,
  type text not null,
  title text not null,
  description text null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint lead_activities_pkey primary key (id),
  constraint lead_activities_client_id_fkey foreign key (client_id) references public.clients (client_id) on delete cascade,
  constraint lead_activities_lead_fkey foreign key (lead_id) references public.leads (id) on delete cascade
);

create index if not exists idx_lead_activities_lead on public.lead_activities (lead_id);
create index if not exists idx_lead_activities_created on public.lead_activities (created_at desc);

-- ==================================================
-- LEAD TAGS (definitions + links)
-- ==================================================
create table if not exists public.lead_tags (
  id uuid not null default gen_random_uuid(),
  client_id text not null,
  name text not null,
  color text not null default 'violet',
  created_at timestamptz not null default now(),
  constraint lead_tags_pkey primary key (id),
  constraint lead_tags_client_id_fkey foreign key (client_id) references public.clients (client_id) on delete cascade,
  constraint lead_tags_client_name_key unique (client_id, name)
);

create index if not exists idx_lead_tags_client on public.lead_tags (client_id);

create table if not exists public.lead_tag_links (
  id uuid not null default gen_random_uuid(),
  client_id text not null,
  lead_id uuid not null,
  tag_id uuid not null,
  created_at timestamptz not null default now(),
  constraint lead_tag_links_pkey primary key (id),
  constraint lead_tag_links_client_id_fkey foreign key (client_id) references public.clients (client_id) on delete cascade,
  constraint lead_tag_links_lead_fkey foreign key (lead_id) references public.leads (id) on delete cascade,
  constraint lead_tag_links_tag_fkey foreign key (tag_id) references public.lead_tags (id) on delete cascade,
  constraint lead_tag_links_unique unique (lead_id, tag_id)
);

create index if not exists idx_lead_tag_links_lead on public.lead_tag_links (lead_id);

-- ==================================================
-- LEAD FOLLOW-UPS (reminders)
-- ==================================================
create table if not exists public.lead_followups (
  id uuid not null default gen_random_uuid(),
  client_id text not null,
  lead_id uuid not null,
  due_at timestamptz not null,
  note text null,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  constraint lead_followups_pkey primary key (id),
  constraint lead_followups_client_id_fkey foreign key (client_id) references public.clients (client_id) on delete cascade,
  constraint lead_followups_lead_fkey foreign key (lead_id) references public.leads (id) on delete cascade
);

create index if not exists idx_lead_followups_lead on public.lead_followups (lead_id);
create index if not exists idx_lead_followups_due on public.lead_followups (lead_id, due_at);

-- ==================================================
-- DEFAULT PIPELINE STAGES
-- ==================================================
-- seeded per-client when the CRM is first used (see leads handler)
-- Untapped -> New -> Contacted -> Qualified -> Proposal -> Won -> Lost

-- ==================================================
-- ENABLE ROW LEVEL SECURITY
-- ==================================================
alter table public.lead_companies enable row level security;
alter table public.lead_contacts enable row level security;
alter table public.leads enable row level security;
alter table public.lead_stages enable row level security;
alter table public.lead_notes enable row level security;
alter table public.lead_tasks enable row level security;
alter table public.lead_activities enable row level security;
alter table public.lead_tags enable row level security;
alter table public.lead_tag_links enable row level security;
alter table public.lead_followups enable row level security;

-- ==================================================
-- RLS POLICIES (tenant scoped via auth_client_id())
-- ==================================================
do $$
declare
  tbl text;
begin
  foreach tbl in array array[
    'lead_companies','lead_contacts','leads','lead_stages','lead_notes',
    'lead_tasks','lead_activities','lead_tags','lead_tag_links','lead_followups'
  ]
  loop
    execute format('create policy "auth_select_own_%s" on public.%I for select to authenticated using (client_id = public.auth_client_id());', tbl, tbl);
    execute format('create policy "auth_insert_own_%s" on public.%I for insert to authenticated with check (client_id = public.auth_client_id());', tbl, tbl);
    execute format('create policy "auth_update_own_%s" on public.%I for update to authenticated using (client_id = public.auth_client_id()) with check (client_id = public.auth_client_id());', tbl, tbl);
    execute format('create policy "auth_delete_own_%s" on public.%I for delete to authenticated using (client_id = public.auth_client_id());', tbl, tbl);
    execute format('create policy "service_role_all_%s" on public.%I for all to service_role using (true) with check (true);', tbl, tbl);
  end loop;
end;
$$;