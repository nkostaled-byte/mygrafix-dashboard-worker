CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE public.clients (
    client_id TEXT NOT NULL,
    auth_user_id TEXT NULL,
    business_name TEXT NOT NULL,
    owner_email TEXT NOT NULL,
    reply_email TEXT NULL,
    active BOOLEAN NOT NULL DEFAULT true,
    logo_url TEXT NULL,
    primary_color TEXT NULL DEFAULT '#111111',
    secondary_color TEXT NULL DEFAULT '#f5f5f5',
    hero_title TEXT NULL DEFAULT '',
    hero_subtitle TEXT NULL DEFAULT '',
    phone TEXT NULL DEFAULT '',
    address TEXT NULL DEFAULT '',
    opening_hours TEXT NULL DEFAULT '',
    business_type TEXT NULL DEFAULT 'general',
    claim_code TEXT NULL,
    bank_name TEXT NULL,
    bank_account_name TEXT NULL,
    bank_account_number TEXT NULL,
    bank_branch_code TEXT NULL,
    payment_instructions TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT clients_pkey PRIMARY KEY (client_id),
    CONSTRAINT clients_auth_user_id_key UNIQUE (auth_user_id),
    CONSTRAINT clients_claim_code_key UNIQUE (claim_code)
);

CREATE TABLE public.categories (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    client_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT categories_pkey PRIMARY KEY (id),
    CONSTRAINT categories_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(client_id) ON DELETE CASCADE,
    CONSTRAINT categories_client_id_name_key UNIQUE (client_id, name)
);

CREATE TABLE public.products (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    client_id TEXT NOT NULL,
    category_id UUID NULL,
    name TEXT NOT NULL,
    sku TEXT NOT NULL,
    barcode TEXT NULL,
    price NUMERIC(10,2) NOT NULL DEFAULT 0,
    cost_price NUMERIC(10,2) NOT NULL DEFAULT 0,
    stock_qty INTEGER NOT NULL DEFAULT 0,
    low_stock_warning INTEGER NOT NULL DEFAULT 5,
    image_url TEXT NULL,
    variants JSONB NULL DEFAULT '[]'::jsonb,
    is_hidden BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT products_pkey PRIMARY KEY (id),
    CONSTRAINT products_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(client_id) ON DELETE CASCADE,
    CONSTRAINT products_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(id) ON DELETE SET NULL,
    CONSTRAINT products_client_id_sku_key UNIQUE (client_id, sku),
    CONSTRAINT products_price_check CHECK (price >= 0),
    CONSTRAINT products_stock_qty_check CHECK (stock_qty >= 0)
);

CREATE TABLE public.services (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    client_id TEXT NOT NULL,
    name TEXT NOT NULL,
    duration_minutes INTEGER NOT NULL,
    price NUMERIC(10,2) NOT NULL DEFAULT 0,
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT services_pkey PRIMARY KEY (id),
    CONSTRAINT services_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(client_id) ON DELETE CASCADE,
    CONSTRAINT services_duration_check CHECK (duration_minutes > 0),
    CONSTRAINT services_price_check CHECK (price >= 0)
);

CREATE TABLE public.staff (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    client_id TEXT NOT NULL,
    name TEXT NOT NULL,
    full_name TEXT NULL,
    role TEXT NULL,
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT staff_pkey PRIMARY KEY (id),
    CONSTRAINT staff_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(client_id) ON DELETE CASCADE
);

CREATE TABLE public.customers (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    client_id TEXT NOT NULL,
    name TEXT NOT NULL,
    email TEXT NULL,
    phone TEXT NULL,
    notes TEXT NULL,
    tags JSONB NULL DEFAULT '[]'::jsonb,
    total_orders INTEGER NOT NULL DEFAULT 0,
    total_spent NUMERIC(10,2) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT customers_pkey PRIMARY KEY (id),
    CONSTRAINT customers_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(client_id) ON DELETE CASCADE,
    CONSTRAINT customers_client_id_email_key UNIQUE (client_id, email)
);

CREATE TABLE public.bookings (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    client_id TEXT NOT NULL,
    customer_id UUID NOT NULL,
    service_id UUID NOT NULL,
    staff_id UUID NULL,
    start_time TIMESTAMPTZ NOT NULL,
    end_time TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL DEFAULT 'confirmed',
    notes TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT bookings_pkey PRIMARY KEY (id),
    CONSTRAINT bookings_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(client_id) ON DELETE CASCADE,
    CONSTRAINT bookings_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE,
    CONSTRAINT bookings_service_id_fkey FOREIGN KEY (service_id) REFERENCES public.services(id) ON DELETE CASCADE,
    CONSTRAINT bookings_staff_id_fkey FOREIGN KEY (staff_id) REFERENCES public.staff(id) ON DELETE SET NULL,
    CONSTRAINT bookings_status_check CHECK (status IN ('confirmed', 'upcoming', 'completed', 'cancelled', 'no-show')),
    CONSTRAINT bookings_time_check CHECK (end_time > start_time)
);

CREATE TABLE public.orders (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    client_id TEXT NOT NULL,
    customer_id UUID NOT NULL,
    order_number TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    subtotal NUMERIC(10,2) NOT NULL DEFAULT 0,
    tax NUMERIC(10,2) NOT NULL DEFAULT 0,
    total NUMERIC(10,2) NOT NULL DEFAULT 0,
    notes TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT orders_pkey PRIMARY KEY (id),
    CONSTRAINT orders_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(client_id) ON DELETE CASCADE,
    CONSTRAINT orders_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE,
    CONSTRAINT orders_order_number_key UNIQUE (order_number),
    CONSTRAINT orders_status_check CHECK (status IN ('pending', 'new', 'paid', 'cancelled', 'refunded')),
    CONSTRAINT orders_total_check CHECK (total >= 0)
);

CREATE TABLE public.order_items (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    order_id UUID NOT NULL,
    product_id UUID NOT NULL,
    name_snapshot TEXT NOT NULL,
    unit_price NUMERIC(10,2) NOT NULL DEFAULT 0,
    qty INTEGER NOT NULL DEFAULT 1,
    line_total NUMERIC(10,2) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT order_items_pkey PRIMARY KEY (id),
    CONSTRAINT order_items_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE,
    CONSTRAINT order_items_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE,
    CONSTRAINT order_items_qty_check CHECK (qty > 0)
);

CREATE TABLE public.invoices (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    client_id TEXT NOT NULL,
    customer_id UUID NOT NULL,
    order_id UUID NULL,
    invoice_number TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    subtotal NUMERIC(10,2) NOT NULL DEFAULT 0,
    tax NUMERIC(10,2) NOT NULL DEFAULT 0,
    total NUMERIC(10,2) NOT NULL DEFAULT 0,
    issued_at TIMESTAMPTZ NULL DEFAULT now(),
    due_at TIMESTAMPTZ NULL,
    pdf_url TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT invoices_pkey PRIMARY KEY (id),
    CONSTRAINT invoices_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(client_id) ON DELETE CASCADE,
    CONSTRAINT invoices_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE CASCADE,
    CONSTRAINT invoices_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE SET NULL,
    CONSTRAINT invoices_invoice_number_key UNIQUE (invoice_number),
    CONSTRAINT invoices_status_check CHECK (status IN ('draft', 'sent', 'paid', 'pending', 'cancelled', 'overdue')),
    CONSTRAINT invoices_total_check CHECK (total >= 0)
);

CREATE TABLE public.invoice_items (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    invoice_id UUID NOT NULL,
    product_id UUID NULL,
    description TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    unit_price NUMERIC(10,2) NOT NULL DEFAULT 0,
    line_total NUMERIC(10,2) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT invoice_items_pkey PRIMARY KEY (id),
    CONSTRAINT invoice_items_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES public.invoices(id) ON DELETE CASCADE,
    CONSTRAINT invoice_items_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE SET NULL,
    CONSTRAINT invoice_items_quantity_check CHECK (quantity > 0)
);

CREATE TABLE public.submissions (
    submission_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    form_name TEXT NOT NULL,
    customer_name TEXT NOT NULL,
    customer_email TEXT NOT NULL,
    submission_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'received',
    ip_address TEXT NULL,
    user_agent TEXT NULL,
    customer_email_id TEXT NULL,
    owner_email_id TEXT NULL,
    assigned_staff_id UUID NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT submissions_pkey PRIMARY KEY (submission_id),
    CONSTRAINT submissions_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(client_id) ON DELETE CASCADE,
    CONSTRAINT submissions_assigned_staff_fkey FOREIGN KEY (assigned_staff_id) REFERENCES public.staff(id) ON DELETE SET NULL,
    CONSTRAINT submissions_status_check CHECK (status IN ('received', 'new', 'replied', 'archived', 'pending', 'confirmed', 'cancelled', 'completed'))
);

CREATE TABLE public.inventory_movements (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    client_id TEXT NOT NULL,
    product_id UUID NOT NULL,
    change_qty INTEGER NOT NULL,
    reason TEXT NOT NULL,
    note TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT inventory_movements_pkey PRIMARY KEY (id),
    CONSTRAINT inventory_movements_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(client_id) ON DELETE CASCADE,
    CONSTRAINT inventory_movements_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE CASCADE
);

CREATE TABLE public.email_log (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    client_id TEXT NOT NULL,
    related_type TEXT NOT NULL,
    related_id UUID NULL,
    recipient TEXT NOT NULL,
    subject TEXT NOT NULL,
    resend_id TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT email_log_pkey PRIMARY KEY (id),
    CONSTRAINT email_log_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(client_id) ON DELETE CASCADE,
    CONSTRAINT email_log_related_type_check CHECK (related_type IN ('submission', 'order', 'booking', 'invoice'))
);

CREATE TABLE public.team_members (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    client_id TEXT NOT NULL,
    auth_user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'staff',
    active BOOLEAN NOT NULL DEFAULT true,
    permissions JSONB NULL DEFAULT '{"manage_billing":false,"manage_inventory":false,"manage_team":false}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT team_members_pkey PRIMARY KEY (id),
    CONSTRAINT team_members_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(client_id) ON DELETE CASCADE,
    CONSTRAINT team_members_client_id_auth_user_id_key UNIQUE (client_id, auth_user_id),
    CONSTRAINT team_members_client_id_email_key UNIQUE (client_id, email),
    CONSTRAINT team_members_role_check CHECK (role IN ('owner', 'admin', 'staff'))
);

CREATE TABLE public.reviews (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    client_id TEXT NOT NULL,
    name TEXT NOT NULL,
    rating NUMERIC(2,1) NOT NULL DEFAULT 5.0,
    text TEXT NOT NULL,
    service TEXT NULL,
    avatar TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT reviews_pkey PRIMARY KEY (id),
    CONSTRAINT reviews_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(client_id) ON DELETE CASCADE,
    CONSTRAINT reviews_rating_check CHECK (rating >= 0 AND rating <= 5)
);

CREATE TABLE public.gallery (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    client_id TEXT NOT NULL,
    title TEXT NULL,
    before_url TEXT NULL,
    after_url TEXT NULL,
    barber_name TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT gallery_pkey PRIMARY KEY (id),
    CONSTRAINT gallery_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(client_id) ON DELETE CASCADE
);

CREATE TABLE public.settings (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    client_id TEXT NOT NULL,
    setting_key TEXT NOT NULL,
    setting_value JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT settings_pkey PRIMARY KEY (id),
    CONSTRAINT settings_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(client_id) ON DELETE CASCADE,
    CONSTRAINT settings_client_id_key_key UNIQUE (client_id, setting_key)
);

CREATE INDEX idx_clients_auth_user_id ON public.clients (auth_user_id) WHERE auth_user_id IS NOT NULL;
CREATE INDEX idx_clients_owner_email ON public.clients (owner_email);
CREATE INDEX idx_clients_claim_code ON public.clients (claim_code) WHERE claim_code IS NOT NULL;
CREATE INDEX idx_categories_client_id ON public.categories (client_id);
CREATE INDEX idx_products_client_id ON public.products (client_id);
CREATE INDEX idx_products_created_at ON public.products (created_at DESC);
CREATE INDEX idx_products_category ON public.products (client_id, category_id);
CREATE INDEX idx_products_stock_qty ON public.products (client_id, stock_qty);
CREATE INDEX idx_products_is_hidden ON public.products (client_id, is_hidden);
CREATE INDEX idx_services_client_id ON public.services (client_id);
CREATE INDEX idx_services_active ON public.services (client_id, active);
CREATE INDEX idx_staff_client_id ON public.staff (client_id);
CREATE INDEX idx_staff_active ON public.staff (client_id, active);
CREATE INDEX idx_customers_client_id ON public.customers (client_id);
CREATE INDEX idx_customers_email ON public.customers (client_id, email);
CREATE INDEX idx_customers_created_at ON public.customers (created_at DESC);
CREATE INDEX idx_bookings_client_id ON public.bookings (client_id);
CREATE INDEX idx_bookings_customer_id ON public.bookings (customer_id);
CREATE INDEX idx_bookings_service_id ON public.bookings (service_id);
CREATE INDEX idx_bookings_staff_id ON public.bookings (staff_id);
CREATE INDEX idx_bookings_start_time ON public.bookings (start_time);
CREATE INDEX idx_bookings_status ON public.bookings (client_id, status);
CREATE INDEX idx_bookings_staff_time ON public.bookings (staff_id, start_time);
CREATE INDEX idx_bookings_date_range ON public.bookings (client_id, start_time, end_time);
CREATE INDEX idx_orders_client_id ON public.orders (client_id);
CREATE INDEX idx_orders_customer_id ON public.orders (customer_id);
CREATE INDEX idx_orders_created_at ON public.orders (created_at DESC);
CREATE INDEX idx_orders_status ON public.orders (client_id, status);
CREATE INDEX idx_orders_date ON public.orders (client_id, created_at);
CREATE INDEX idx_orders_order_number ON public.orders (order_number);
CREATE INDEX idx_order_items_order_id ON public.order_items (order_id);
CREATE INDEX idx_order_items_product_id ON public.order_items (product_id);
CREATE INDEX idx_invoices_client_id ON public.invoices (client_id);
CREATE INDEX idx_invoices_customer_id ON public.invoices (customer_id);
CREATE INDEX idx_invoices_order_id ON public.invoices (order_id);
CREATE INDEX idx_invoices_status ON public.invoices (client_id, status);
CREATE INDEX idx_invoices_created_at ON public.invoices (created_at DESC);
CREATE INDEX idx_invoices_issued_at ON public.invoices (issued_at DESC);
CREATE INDEX idx_invoices_invoice_number ON public.invoices (invoice_number);
CREATE INDEX idx_invoice_items_invoice_id ON public.invoice_items (invoice_id);
CREATE INDEX idx_invoice_items_product_id ON public.invoice_items (product_id);
CREATE INDEX idx_submissions_client_id ON public.submissions (client_id);
CREATE INDEX idx_submissions_created_at ON public.submissions (created_at DESC);
CREATE INDEX idx_submissions_status ON public.submissions (client_id, status);
CREATE INDEX idx_submissions_form_name ON public.submissions (client_id, form_name);
CREATE INDEX idx_email_log_client_id ON public.email_log (client_id);
CREATE INDEX idx_email_log_related ON public.email_log (client_id, related_type, related_id);
CREATE INDEX idx_email_log_created_at ON public.email_log (created_at DESC);
CREATE INDEX idx_team_members_client_id ON public.team_members (client_id);
CREATE INDEX idx_team_members_auth_user_id ON public.team_members (auth_user_id);
CREATE INDEX idx_team_members_active ON public.team_members (client_id, active);
CREATE INDEX idx_inventory_movements_client_id ON public.inventory_movements (client_id);
CREATE INDEX idx_inventory_movements_product_id ON public.inventory_movements (product_id, created_at DESC);
CREATE INDEX idx_inventory_movements_reason ON public.inventory_movements (client_id, reason);
CREATE INDEX idx_reviews_client_id ON public.reviews (client_id);
CREATE INDEX idx_gallery_client_id ON public.gallery (client_id);
CREATE INDEX idx_settings_client_id ON public.settings (client_id);

CREATE OR REPLACE FUNCTION public.set_claim_code()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.claim_code IS NULL THEN
        NEW.claim_code := upper(substr(md5(random()::text || clock_timestamp()::text), 1, 8));
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_clients_set_claim_code
    BEFORE INSERT ON public.clients
    FOR EACH ROW
    EXECUTE FUNCTION public.set_claim_code();

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_clients_updated_at BEFORE UPDATE ON public.clients FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_categories_updated_at BEFORE UPDATE ON public.categories FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_products_updated_at BEFORE UPDATE ON public.products FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_services_updated_at BEFORE UPDATE ON public.services FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_staff_updated_at BEFORE UPDATE ON public.staff FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_customers_updated_at BEFORE UPDATE ON public.customers FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_bookings_updated_at BEFORE UPDATE ON public.bookings FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_orders_updated_at BEFORE UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_invoices_updated_at BEFORE UPDATE ON public.invoices FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_submissions_updated_at BEFORE UPDATE ON public.submissions FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_team_members_updated_at BEFORE UPDATE ON public.team_members FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_settings_updated_at BEFORE UPDATE ON public.settings FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE FUNCTION public.set_invoice_issued_at()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status = 'sent' AND (OLD.status IS NULL OR OLD.status != 'sent') THEN
        NEW.issued_at = now();
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_invoices_issued_at
    BEFORE UPDATE ON public.invoices
    FOR EACH ROW
    WHEN (NEW.status = 'sent' AND (OLD.status IS NULL OR OLD.status != 'sent'))
    EXECUTE FUNCTION public.set_invoice_issued_at();

CREATE OR REPLACE FUNCTION public.auth_client_id()
RETURNS TEXT
LANGUAGE SQL STABLE AS $$
    SELECT client_id FROM public.clients WHERE auth_user_id = auth.uid()::TEXT
    UNION
    SELECT client_id FROM public.team_members WHERE auth_user_id = auth.uid()::TEXT AND active = true
    LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.search_all(p_client_id TEXT, q TEXT)
RETURNS TABLE(result_type TEXT, id TEXT, title TEXT, subtitle TEXT, created_at TIMESTAMPTZ)
LANGUAGE plpgsql STABLE AS $$
DECLARE
    search_pattern TEXT;
BEGIN
    search_pattern := '%' || q || '%';
    RETURN QUERY
    SELECT 'customer'::TEXT, c.id::TEXT, c.name, c.email, c.created_at
    FROM public.customers c WHERE c.client_id = p_client_id AND (c.name ILIKE search_pattern OR c.email ILIKE search_pattern)
    UNION ALL
    SELECT 'product'::TEXT, p.id::TEXT, p.name, p.sku, p.created_at
    FROM public.products p WHERE p.client_id = p_client_id AND (p.name ILIKE search_pattern OR p.sku ILIKE search_pattern OR COALESCE(p.barcode,'') ILIKE search_pattern)
    UNION ALL
    SELECT 'submission'::TEXT, s.submission_id, s.customer_name, s.customer_email, s.created_at
    FROM public.submissions s WHERE s.client_id = p_client_id AND (s.customer_name ILIKE search_pattern OR s.customer_email ILIKE search_pattern)
    UNION ALL
    SELECT 'invoice'::TEXT, i.id::TEXT, i.invoice_number, c2.name, i.created_at
    FROM public.invoices i JOIN public.customers c2 ON c2.id = i.customer_id
    WHERE i.client_id = p_client_id AND (i.invoice_number ILIKE search_pattern OR c2.name ILIKE search_pattern)
    UNION ALL
    SELECT 'booking'::TEXT, b.id::TEXT, c3.name, srv.name, b.created_at
    FROM public.bookings b JOIN public.customers c3 ON c3.id = b.customer_id JOIN public.services srv ON srv.id = b.service_id
    WHERE b.client_id = p_client_id AND (c3.name ILIKE search_pattern OR c3.email ILIKE search_pattern)
    UNION ALL
    SELECT 'order'::TEXT, o.id::TEXT, o.order_number, c4.name, o.created_at
    FROM public.orders o JOIN public.customers c4 ON c4.id = o.customer_id
    WHERE o.client_id = p_client_id AND (o.order_number ILIKE search_pattern OR c4.name ILIKE search_pattern)
    ORDER BY created_at DESC LIMIT 50;
END;
$$;

ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.services ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.email_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gallery ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "clients_anon_select_active" ON public.clients FOR SELECT TO anon USING (active = true);
CREATE POLICY "clients_auth_all_own" ON public.clients FOR ALL TO authenticated USING (auth_user_id = auth.uid()::TEXT OR client_id IN (SELECT client_id FROM public.team_members WHERE auth_user_id = auth.uid()::TEXT AND active = true)) WITH CHECK (auth_user_id = auth.uid()::TEXT OR client_id IN (SELECT client_id FROM public.team_members WHERE auth_user_id = auth.uid()::TEXT AND active = true));
CREATE POLICY "clients_service_role_all" ON public.clients FOR ALL TO service_role USING (true) WITH CHECK (true);

DO $$
DECLARE
    tbl TEXT;
BEGIN
    FOREACH tbl IN ARRAY ARRAY['categories', 'products', 'services', 'staff', 'customers', 'bookings', 'orders', 'order_items', 'invoices', 'invoice_items', 'submissions', 'email_log', 'inventory_movements', 'reviews', 'gallery', 'settings']
    LOOP
        EXECUTE format('CREATE POLICY "anon_select_public_%s" ON public.%I FOR SELECT TO anon USING (client_id IN (SELECT client_id FROM public.clients WHERE active = true));', tbl, tbl);
        EXECUTE format('CREATE POLICY "auth_select_own_%s" ON public.%I FOR SELECT TO authenticated USING (client_id = public.auth_client_id());', tbl, tbl);
        EXECUTE format('CREATE POLICY "auth_insert_own_%s" ON public.%I FOR INSERT TO authenticated WITH CHECK (client_id = public.auth_client_id());', tbl, tbl);
        EXECUTE format('CREATE POLICY "auth_update_own_%s" ON public.%I FOR UPDATE TO authenticated USING (client_id = public.auth_client_id()) WITH CHECK (client_id = public.auth_client_id());', tbl, tbl);
        EXECUTE format('CREATE POLICY "auth_delete_own_%s" ON public.%I FOR DELETE TO authenticated USING (client_id = public.auth_client_id());', tbl, tbl);
        EXECUTE format('CREATE POLICY "service_role_all_%s" ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true);', tbl, tbl);
    END LOOP;
END;
$$;

CREATE POLICY "team_members_anon_no_access" ON public.team_members FOR ALL TO anon USING (false);
CREATE POLICY "team_members_auth_select" ON public.team_members FOR SELECT TO authenticated USING (client_id = public.auth_client_id());
CREATE POLICY "team_members_auth_insert" ON public.team_members FOR INSERT TO authenticated WITH CHECK (client_id = public.auth_client_id());
CREATE POLICY "team_members_auth_update" ON public.team_members FOR UPDATE TO authenticated USING (client_id = public.auth_client_id()) WITH CHECK (client_id = public.auth_client_id());
CREATE POLICY "team_members_auth_delete" ON public.team_members FOR DELETE TO authenticated USING (client_id = public.auth_client_id());
CREATE POLICY "team_members_service_role_all" ON public.team_members FOR ALL TO service_role USING (true) WITH CHECK (true);

INSERT INTO public.clients (client_id, business_name, owner_email, active, business_type, primary_color, secondary_color, hero_title, hero_subtitle, phone, address, opening_hours, bank_name, bank_account_name, bank_account_number, bank_branch_code, payment_instructions) VALUES ('client-barbershop-1', 'Luxury Barbershop', 'owner@luxurybarbershop.com', true, 'barbershop', '#1a1a2e', '#e2b616', 'Where Style Meets Precision', 'Premium grooming for the modern gentleman', '+27123456789', '123 Main Street, Cape Town, 8001', 'Mon-Fri: 8am-6pm | Sat: 8am-3pm | Sun: Closed', 'First National Bank', 'Luxury Barbershop Pty Ltd', '62819283746', '255005', 'Please use invoice number as reference');

INSERT INTO public.categories (client_id, name, description, sort_order) VALUES ('client-barbershop-1', 'Styling', 'Hair styling products', 1);
INSERT INTO public.categories (client_id, name, description, sort_order) VALUES ('client-barbershop-1', 'Beard Care', 'Beard maintenance products', 2);
INSERT INTO public.categories (client_id, name, description, sort_order) VALUES ('client-barbershop-1', 'Shaving', 'Shaving essentials', 3);

INSERT INTO public.products (client_id, category_id, name, sku, price, cost_price, stock_qty, low_stock_warning, variants) SELECT 'client-barbershop-1', id, 'Classic Hair Clay Wax', 'POM-SL-01', 24.99, 8.50, 45, 10, '["Small","Medium","Large"]' FROM public.categories WHERE client_id = 'client-barbershop-1' AND name = 'Styling';
INSERT INTO public.products (client_id, category_id, name, sku, price, cost_price, stock_qty, low_stock_warning, variants) SELECT 'client-barbershop-1', id, 'Sandalwood Beard Balm', 'BRD-SB-02', 19.99, 6.00, 28, 10, '["50ml","100ml"]' FROM public.categories WHERE client_id = 'client-barbershop-1' AND name = 'Beard Care';
INSERT INTO public.products (client_id, category_id, name, sku, price, cost_price, stock_qty, low_stock_warning, variants) SELECT 'client-barbershop-1', id, 'Premium Shaving Cream', 'SHAV-PR-03', 14.99, 5.00, 60, 15, '["150ml","300ml"]' FROM public.categories WHERE client_id = 'client-barbershop-1' AND name = 'Shaving';
INSERT INTO public.products (client_id, category_id, name, sku, price, cost_price, stock_qty, low_stock_warning, variants) SELECT 'client-barbershop-1', id, 'Pomade Strong Hold', 'POM-SH-04', 29.99, 10.00, 12, 10, '["100ml","200ml"]' FROM public.categories WHERE client_id = 'client-barbershop-1' AND name = 'Styling';

INSERT INTO public.services (client_id, name, duration_minutes, price, active) VALUES ('client-barbershop-1', 'Premium Haircut', 45, 35.00, true);
INSERT INTO public.services (client_id, name, duration_minutes, price, active) VALUES ('client-barbershop-1', 'Beard Trim & Shape', 30, 20.00, true);
INSERT INTO public.services (client_id, name, duration_minutes, price, active) VALUES ('client-barbershop-1', 'Hot Towel Shave', 60, 45.00, true);
INSERT INTO public.services (client_id, name, duration_minutes, price, active) VALUES ('client-barbershop-1', 'Hair & Beard Combo', 60, 50.00, true);
INSERT INTO public.services (client_id, name, duration_minutes, price, active) VALUES ('client-barbershop-1', 'Kids Haircut', 30, 20.00, true);
INSERT INTO public.services (client_id, name, duration_minutes, price, active) VALUES ('client-barbershop-1', 'Royal Grooming Package', 90, 75.00, true);

INSERT INTO public.staff (client_id, name, full_name, role, active) VALUES ('client-barbershop-1', 'James Wilson', 'James Wilson', 'Master Barber', true);
INSERT INTO public.staff (client_id, name, full_name, role, active) VALUES ('client-barbershop-1', 'Marcus Johnson', 'Marcus Johnson', 'Senior Barber', true);
INSERT INTO public.staff (client_id, name, full_name, role, active) VALUES ('client-barbershop-1', 'Sarah Blake', 'Sarah Blake', 'Barber', true);

INSERT INTO public.customers (client_id, name, email, phone) VALUES ('client-barbershop-1', 'Alexander Sterling', 'alex@example.com', '+27831234567');
INSERT INTO public.customers (client_id, name, email, phone) VALUES ('client-barbershop-1', 'Benjamin Cruz', 'ben@example.com', '+27839876543');
INSERT INTO public.customers (client_id, name, email, phone) VALUES ('client-barbershop-1', 'Michael Brown', 'michael@example.com', '+27837778899');

INSERT INTO public.submissions (submission_id, client_id, form_name, customer_name, customer_email, submission_json, status) VALUES ('SUB-DEMO01', 'client-barbershop-1', 'contact', 'Michael Brown', 'michael@example.com', '{"message":"I would like to book a premium haircut for Saturday.","preferred_time":"10:00"}', 'new');

INSERT INTO public.reviews (client_id, name, rating, text, service) VALUES ('client-barbershop-1', 'Alexander S.', 5.0, 'Best haircut I have ever had. James is a true artist.', 'Premium Haircut');
INSERT INTO public.reviews (client_id, name, rating, text, service) VALUES ('client-barbershop-1', 'Marcus T.', 4.5, 'Great atmosphere and professional service.', 'Beard Trim & Shape');

INSERT INTO public.gallery (client_id, title, before_url, after_url, barber_name) VALUES ('client-barbershop-1', 'Classic Pompadour', 'https://placehold.co/400x500/1a1a2e/e2b616?text=Before', 'https://placehold.co/400x500/1a1a2e/e2b616?text=After', 'James Wilson');

INSERT INTO public.settings (client_id, setting_key, setting_value) VALUES ('client-barbershop-1', 'business_hours', '{"monday":{"open":"08:00","close":"18:00"},"tuesday":{"open":"08:00","close":"18:00"},"wednesday":{"open":"08:00","close":"18:00"},"thursday":{"open":"08:00","close":"18:00"},"friday":{"open":"08:00","close":"18:00"},"saturday":{"open":"08:00","close":"15:00"},"sunday":{"open":null,"close":null}}'::jsonb);
INSERT INTO public.settings (client_id, setting_key, setting_value) VALUES ('client-barbershop-1', 'email_templates', '{"booking_confirmation":"Your booking has been confirmed.","contact_reply":"Thank you for reaching out."}'::jsonb);
INSERT INTO public.settings (client_id, setting_key, setting_value) VALUES ('client-barbershop-1', 'notification_preferences', '{"customer_confirmation":true,"owner_notification":true,"sms_reminders":false}'::jsonb);

