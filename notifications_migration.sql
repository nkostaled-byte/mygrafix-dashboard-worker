-- ============================================================
-- Notifications System Migration
-- ============================================================
-- Creates a real-time notifications table with:
--   - Multi-tenant RLS (client_id scoped)
--   - Automatic notification creation via triggers
--   - Read state tracking (read_at)
--   - Optimized indexes for unread queries
-- ============================================================

-- 1. Create the notifications table
CREATE TABLE IF NOT EXISTS public.notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id TEXT NOT NULL REFERENCES public.clients(client_id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    entity_type TEXT NULL,
    entity_id UUID NULL,
    read_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- 2. Indexes
CREATE INDEX IF NOT EXISTS idx_notifications_client_created
    ON public.notifications (client_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notifications_client_unread
    ON public.notifications (client_id, created_at DESC)
    WHERE read_at IS NULL;

-- 3. Enable RLS
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

-- 4. RLS Policies
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'notifications_auth_select_own' AND tablename = 'notifications') THEN
        CREATE POLICY "notifications_auth_select_own"
            ON public.notifications FOR SELECT TO authenticated
            USING (client_id = public.auth_client_id());
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'notifications_auth_update_own' AND tablename = 'notifications') THEN
        CREATE POLICY "notifications_auth_update_own"
            ON public.notifications FOR UPDATE TO authenticated
            USING (client_id = public.auth_client_id())
            WITH CHECK (client_id = public.auth_client_id());
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'notifications_auth_insert_own' AND tablename = 'notifications') THEN
        CREATE POLICY "notifications_auth_insert_own"
            ON public.notifications FOR INSERT TO authenticated
            WITH CHECK (client_id = public.auth_client_id());
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'notifications_service_role_all' AND tablename = 'notifications') THEN
        CREATE POLICY "notifications_service_role_all"
            ON public.notifications FOR ALL TO service_role
            USING (true) WITH CHECK (true);
END IF;
END $$;

-- 5. Enable Realtime for the notifications table
ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;

-- ============================================================
-- 6. Trigger functions for automatic notification creation
-- ============================================================

-- Helper: insert a notification row (skips duplicates via metadata dedup key)
CREATE OR REPLACE FUNCTION public.fn_create_notification(
    p_client_id TEXT,
    p_type TEXT,
    p_title TEXT,
    p_message TEXT,
    p_entity_type TEXT DEFAULT NULL,
    p_entity_id UUID DEFAULT NULL,
    p_metadata JSONB DEFAULT '{}'::jsonb
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    INSERT INTO public.notifications (client_id, type, title, message, entity_type, entity_id, metadata)
    VALUES (p_client_id, p_type, p_title, p_message, p_entity_type, p_entity_id, p_metadata);
END;
$$;

-- 6a. Bookings trigger — new booking created
CREATE OR REPLACE FUNCTION public.trg_notify_booking_insert()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_customer_name TEXT;
    v_service_name TEXT;
    v_start_time TIMESTAMPTZ;
    v_display_time TEXT;
    v_display_date TEXT;
BEGIN
    SELECT name INTO v_customer_name FROM public.customers WHERE id = NEW.customer_id;
    SELECT name INTO v_service_name FROM public.services WHERE id = NEW.service_id;

    v_start_time := COALESCE(NEW.start_time, now());
    v_display_date := TO_CHAR(v_start_time AT TIME ZONE 'UTC', 'Month DD, YYYY');
    v_display_time := TO_CHAR(v_start_time AT TIME ZONE 'UTC', 'HH24:MI');

    PERFORM public.fn_create_notification(
        NEW.client_id,
        'booking',
        'New booking received',
        COALESCE(v_customer_name, 'A customer') || ' booked ' || COALESCE(v_service_name, 'a service') || ' for ' || v_display_date || ' at ' || v_display_time || '.',
        'booking',
        NEW.id,
        jsonb_build_object('customerName', v_customer_name, 'serviceName', v_service_name, 'date', v_display_date, 'time', v_display_time)
    );
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_booking_insert ON public.bookings;
CREATE TRIGGER trg_notify_booking_insert
    AFTER INSERT ON public.bookings
    FOR EACH ROW EXECUTE FUNCTION public.trg_notify_booking_insert();

-- 6b. Bookings trigger — booking cancelled
CREATE OR REPLACE FUNCTION public.trg_notify_booking_cancelled()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_customer_name TEXT;
BEGIN
    IF NEW.status = 'cancelled' AND (OLD.status IS NULL OR OLD.status != 'cancelled') THEN
        SELECT name INTO v_customer_name FROM public.customers WHERE id = NEW.customer_id;
        PERFORM public.fn_create_notification(
            NEW.client_id,
            'booking_cancelled',
            'Booking cancelled',
            COALESCE(v_customer_name, 'A customer') || '''s booking has been cancelled.',
            'booking',
            NEW.id,
            jsonb_build_object('customerName', v_customer_name)
        );
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_booking_cancelled ON public.bookings;
CREATE TRIGGER trg_notify_booking_cancelled
    AFTER UPDATE ON public.bookings
    FOR EACH ROW EXECUTE FUNCTION public.trg_notify_booking_cancelled();

-- 6c. Orders trigger — new order created
CREATE OR REPLACE FUNCTION public.trg_notify_order_insert()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_customer_name TEXT;
    v_order_number TEXT;
BEGIN
    SELECT name INTO v_customer_name FROM public.customers WHERE id = NEW.customer_id;
    v_order_number := COALESCE(NEW.order_number, 'an order');

    PERFORM public.fn_create_notification(
        NEW.client_id,
        'order',
        'New order received',
        'Order ' || v_order_number || ' has been placed' || CASE WHEN v_customer_name IS NOT NULL THEN ' by ' || v_customer_name ELSE '' END || '.',
        'order',
        NEW.id,
        jsonb_build_object('orderNumber', v_order_number, 'customerName', v_customer_name, 'total', NEW.total)
    );
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_order_insert ON public.orders;
CREATE TRIGGER trg_notify_order_insert
    AFTER INSERT ON public.orders
    FOR EACH ROW EXECUTE FUNCTION public.trg_notify_order_insert();

-- 6d. Invoices trigger — invoice paid
CREATE OR REPLACE FUNCTION public.trg_notify_invoice_paid()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_invoice_number TEXT;
BEGIN
    IF NEW.status = 'paid' AND (OLD.status IS NULL OR OLD.status != 'paid') THEN
        v_invoice_number := COALESCE(NEW.invoice_number, 'An invoice');
        PERFORM public.fn_create_notification(
            NEW.client_id,
            'invoice_paid',
            'Invoice paid',
            v_invoice_number || ' has been paid.',
            'invoice',
            NEW.id,
            jsonb_build_object('invoiceNumber', v_invoice_number, 'total', NEW.total)
        );
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_invoice_paid ON public.invoices;
CREATE TRIGGER trg_notify_invoice_paid
    AFTER UPDATE ON public.invoices
    FOR EACH ROW EXECUTE FUNCTION public.trg_notify_invoice_paid();

-- 6e. Invoices trigger — new invoice created
CREATE OR REPLACE FUNCTION public.trg_notify_invoice_insert()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_invoice_number TEXT;
BEGIN
    v_invoice_number := COALESCE(NEW.invoice_number, 'An invoice');
    PERFORM public.fn_create_notification(
        NEW.client_id,
        'invoice',
        'New invoice created',
        v_invoice_number || ' has been created.',
        'invoice',
        NEW.id,
        jsonb_build_object('invoiceNumber', v_invoice_number, 'total', NEW.total)
    );
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_invoice_insert ON public.invoices;
CREATE TRIGGER trg_notify_invoice_insert
    AFTER INSERT ON public.invoices
    FOR EACH ROW EXECUTE FUNCTION public.trg_notify_invoice_insert();

-- 6f. Submissions trigger — new form submission
CREATE OR REPLACE FUNCTION public.trg_notify_submission_insert()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    PERFORM public.fn_create_notification(
        NEW.client_id,
        'form',
        'New form submission',
        'You received a new ' || COALESCE(NEW.form_name, 'contact') || ' submission from ' || COALESCE(NEW.customer_name, 'someone') || '.',
        'form',
        NULL,
        jsonb_build_object('formName', NEW.form_name, 'customerName', NEW.customer_name, 'customerEmail', NEW.customer_email)
    );
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_submission_insert ON public.submissions;
CREATE TRIGGER trg_notify_submission_insert
    AFTER INSERT ON public.submissions
    FOR EACH ROW EXECUTE FUNCTION public.trg_notify_submission_insert();

-- 6g. Customers trigger — new customer created
CREATE OR REPLACE FUNCTION public.trg_notify_customer_insert()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
    PERFORM public.fn_create_notification(
        NEW.client_id,
        'customer',
        'New customer added',
        COALESCE(NEW.name, 'A new customer') || ' has been added to your customers.',
        'customer',
        NEW.id,
        jsonb_build_object('customerName', NEW.name)
    );
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_customer_insert ON public.customers;
CREATE TRIGGER trg_notify_customer_insert
    AFTER INSERT ON public.customers
    FOR EACH ROW EXECUTE FUNCTION public.trg_notify_customer_insert();
