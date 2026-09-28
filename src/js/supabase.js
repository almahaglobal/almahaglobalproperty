import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://jmeflfczmkxepzyxbeum.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_N_NYroECiY_c0KymCbpQiQ_QP-94NPg';

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
