UPDATE public.properties
SET price = price / 0.75;

UPDATE public.projects
SET starting_price = starting_price / 0.75
WHERE starting_price IS NOT NULL;

UPDATE public.project_unit_types
SET starting_price = starting_price / 0.75
WHERE starting_price IS NOT NULL;