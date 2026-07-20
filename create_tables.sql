-- ==================================================
-- REVIEWS TABLE
-- Stores customer reviews/testimonials displayed on
-- the luxury barbershop public site.
-- ==================================================
create table public.reviews (
  id uuid not null default gen_random_uuid(),
  client_id text not null,
  name text not null,
  rating numeric(2, 1) not null default 5.0,
  text text not null,
  service text null,
  avatar text null,
  created_at timestamp with time zone not null default now(),
  constraint reviews_pkey primary key (id),
  constraint reviews_client_id_fkey foreign key (client_id) references clients (client_id) on delete cascade
) tablespace pg_default;

create index if not exists idx_reviews_client on public.reviews using btree (client_id) tablespace pg_default;

-- ==================================================
-- GALLERY TABLE
-- Stores before/after image pairs for the "Before &
-- After" slider on the luxury barbershop public site.
-- ==================================================
create table public.gallery (
  id uuid not null default gen_random_uuid(),
  client_id text not null,
  title text null,
  before_url text null,
  after_url text null,
  barber_name text null,
  created_at timestamp with time zone not null default now(),
  constraint gallery_pkey primary key (id),
  constraint gallery_client_id_fkey foreign key (client_id) references clients (client_id) on delete cascade
) tablespace pg_default;

create index if not exists idx_gallery_client on public.gallery using btree (client_id) tablespace pg_default;

