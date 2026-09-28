-- Off-plan projects extend the existing developer, project, property, lead, and favorite model.
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS agent_id UUID REFERENCES public.agents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS community_id UUID REFERENCES public.communities(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS currency VARCHAR(10) NOT NULL DEFAULT 'AED',
  ADD COLUMN IF NOT EXISTS formatted_address TEXT,
  ADD COLUMN IF NOT EXISTS latitude DECIMAL(10, 8),
  ADD COLUMN IF NOT EXISTS longitude DECIMAL(11, 8),
  ADD COLUMN IF NOT EXISTS construction_progress SMALLINT NOT NULL DEFAULT 0 CHECK (construction_progress BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS approval_status VARCHAR(30) NOT NULL DEFAULT 'draft' CHECK (approval_status IN ('draft', 'pending_review', 'approved', 'rejected', 'suspended')),
  ADD COLUMN IF NOT EXISTS is_verified BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_featured BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS project_unit_type_id UUID;

CREATE TABLE IF NOT EXISTS public.project_unit_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  bedrooms SMALLINT,
  bathrooms SMALLINT,
  min_area_sqft DECIMAL(12, 2),
  max_area_sqft DECIMAL(12, 2),
  starting_price DECIMAL(15, 2),
  available_units INTEGER NOT NULL DEFAULT 0,
  description TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE public.properties
  DROP CONSTRAINT IF EXISTS properties_project_unit_type_id_fkey;
ALTER TABLE public.properties
  ADD CONSTRAINT properties_project_unit_type_id_fkey
  FOREIGN KEY (project_unit_type_id) REFERENCES public.project_unit_types(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS public.project_payment_plan_stages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  stage VARCHAR(120) NOT NULL,
  percentage DECIMAL(5, 2) NOT NULL CHECK (percentage >= 0 AND percentage <= 100),
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.project_media (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  media_type VARCHAR(30) NOT NULL CHECK (media_type IN ('image', 'video', 'floorplan', 'brochure', 'masterplan')),
  storage_path TEXT NOT NULL,
  title VARCHAR(255),
  is_primary BOOLEAN NOT NULL DEFAULT false,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.project_amenities (
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  amenity_name VARCHAR(100) NOT NULL,
  icon_key VARCHAR(60),
  description TEXT,
  PRIMARY KEY (project_id, amenity_name)
);

CREATE TABLE IF NOT EXISTS public.project_assignments (
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  assignment_role VARCHAR(30) NOT NULL DEFAULT 'sales_agent',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (project_id, agent_id)
);

CREATE TABLE IF NOT EXISTS public.developer_members (
  developer_id UUID NOT NULL REFERENCES public.developers(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  member_role VARCHAR(30) NOT NULL DEFAULT 'manager',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (developer_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.project_construction_updates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  progress SMALLINT NOT NULL CHECK (progress BETWEEN 0 AND 100),
  update_note TEXT,
  media_path TEXT,
  update_date DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE public.property_inquiries
  ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES public.projects(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS project_unit_type_id UUID REFERENCES public.project_unit_types(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS budget DECIMAL(15, 2),
  ADD COLUMN IF NOT EXISTS consent BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.property_favorites
  ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES public.projects(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS projects_public_browse_idx ON public.projects(approval_status, is_featured, city, starting_price, handover_date);
CREATE INDEX IF NOT EXISTS project_unit_types_project_idx ON public.project_unit_types(project_id, bedrooms, starting_price);
CREATE INDEX IF NOT EXISTS project_media_project_idx ON public.project_media(project_id, display_order);
CREATE INDEX IF NOT EXISTS project_payment_plan_project_idx ON public.project_payment_plan_stages(project_id, sort_order);
CREATE INDEX IF NOT EXISTS property_inquiries_project_idx ON public.property_inquiries(project_id, created_at DESC);

ALTER TABLE public.property_inquiries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS project_inquiries_public_insert ON public.property_inquiries;
CREATE POLICY project_inquiries_public_insert ON public.property_inquiries
  FOR INSERT TO anon, authenticated
  WITH CHECK (project_id IS NOT NULL AND consent = true);

DROP POLICY IF EXISTS project_inquiries_manager_read ON public.property_inquiries;
CREATE POLICY project_inquiries_manager_read ON public.property_inquiries
  FOR SELECT TO authenticated
  USING (project_id IS NOT NULL AND public.can_manage_project(project_id));

ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_unit_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_payment_plan_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_amenities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.developer_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_construction_updates ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.can_manage_project(target_project_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.is_admin()
    OR EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = target_project_id AND p.created_by = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.projects p
      JOIN public.developer_members dm ON dm.developer_id = p.developer_id
      WHERE p.id = target_project_id AND dm.user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.projects p
      JOIN public.project_assignments pa ON pa.project_id = p.id
      JOIN public.agents a ON a.id = pa.agent_id
      WHERE p.id = target_project_id AND a.user_id = auth.uid()
    );
$$;

DROP POLICY IF EXISTS projects_public_read ON public.projects;
CREATE POLICY projects_public_read ON public.projects FOR SELECT USING (approval_status = 'approved' OR public.can_manage_project(id));
DROP POLICY IF EXISTS projects_manager_write ON public.projects;
CREATE POLICY projects_manager_write ON public.projects FOR UPDATE TO authenticated USING (public.can_manage_project(id)) WITH CHECK (public.can_manage_project(id));
DROP POLICY IF EXISTS projects_creator_insert ON public.projects;
CREATE POLICY projects_creator_insert ON public.projects FOR INSERT TO authenticated WITH CHECK (
  created_by = auth.uid()
  AND (
    public.is_admin()
    OR EXISTS (SELECT 1 FROM public.developer_members dm WHERE dm.developer_id = projects.developer_id AND dm.user_id = auth.uid())
    OR EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.role IN ('owner', 'agent') AND u.verification_status = 'approved')
  )
);

DROP POLICY IF EXISTS project_unit_types_public_read ON public.project_unit_types;
CREATE POLICY project_unit_types_public_read ON public.project_unit_types FOR SELECT USING (EXISTS (SELECT 1 FROM public.projects p WHERE p.id = project_id AND (p.approval_status = 'approved' OR public.can_manage_project(p.id))));
DROP POLICY IF EXISTS project_unit_types_manager_write ON public.project_unit_types;
CREATE POLICY project_unit_types_manager_write ON public.project_unit_types FOR ALL TO authenticated USING (public.can_manage_project(project_id)) WITH CHECK (public.can_manage_project(project_id));

DROP POLICY IF EXISTS project_payment_public_read ON public.project_payment_plan_stages;
CREATE POLICY project_payment_public_read ON public.project_payment_plan_stages FOR SELECT USING (EXISTS (SELECT 1 FROM public.projects p WHERE p.id = project_id AND (p.approval_status = 'approved' OR public.can_manage_project(p.id))));
DROP POLICY IF EXISTS project_payment_manager_write ON public.project_payment_plan_stages;
CREATE POLICY project_payment_manager_write ON public.project_payment_plan_stages FOR ALL TO authenticated USING (public.can_manage_project(project_id)) WITH CHECK (public.can_manage_project(project_id));

DROP POLICY IF EXISTS project_media_public_read ON public.project_media;
CREATE POLICY project_media_public_read ON public.project_media FOR SELECT USING (EXISTS (SELECT 1 FROM public.projects p WHERE p.id = project_id AND (p.approval_status = 'approved' OR public.can_manage_project(p.id))));
DROP POLICY IF EXISTS project_media_manager_write ON public.project_media;
CREATE POLICY project_media_manager_write ON public.project_media FOR ALL TO authenticated USING (public.can_manage_project(project_id)) WITH CHECK (public.can_manage_project(project_id));

DROP POLICY IF EXISTS project_amenities_public_read ON public.project_amenities;
CREATE POLICY project_amenities_public_read ON public.project_amenities FOR SELECT USING (EXISTS (SELECT 1 FROM public.projects p WHERE p.id = project_id AND (p.approval_status = 'approved' OR public.can_manage_project(p.id))));
DROP POLICY IF EXISTS project_amenities_manager_write ON public.project_amenities;
CREATE POLICY project_amenities_manager_write ON public.project_amenities FOR ALL TO authenticated USING (public.can_manage_project(project_id)) WITH CHECK (public.can_manage_project(project_id));

DROP POLICY IF EXISTS project_assignments_member_read ON public.project_assignments;
CREATE POLICY project_assignments_member_read ON public.project_assignments FOR SELECT TO authenticated USING (public.can_manage_project(project_id));
DROP POLICY IF EXISTS developer_members_self_or_admin ON public.developer_members;
CREATE POLICY developer_members_self_or_admin ON public.developer_members FOR SELECT TO authenticated USING (user_id = auth.uid() OR public.is_admin());

INSERT INTO storage.buckets (id, name, public)
VALUES ('project-media', 'project-media', true)
ON CONFLICT (id) DO UPDATE SET public = true;

DROP POLICY IF EXISTS project_media_storage_read ON storage.objects;
CREATE POLICY project_media_storage_read ON storage.objects FOR SELECT USING (bucket_id = 'project-media');
DROP POLICY IF EXISTS project_media_storage_insert ON storage.objects;
CREATE POLICY project_media_storage_insert ON storage.objects FOR INSERT TO authenticated WITH CHECK (
  bucket_id = 'project-media'
  AND (storage.foldername(name))[1] = auth.uid()::text
);
DROP POLICY IF EXISTS project_media_storage_delete ON storage.objects;
CREATE POLICY project_media_storage_delete ON storage.objects FOR DELETE TO authenticated USING (
  bucket_id = 'project-media'
  AND (storage.foldername(name))[1] = auth.uid()::text
);
