import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm'

const SUPABASE_URL = 'https://ihwpcecorhpjxgxwqpcv.supabase.co';

const SUPABASE_KEY = 'sb_publishable_8sMw2nx0rbfj1Em7YEHnzA_2tIg-7zN';

export const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_KEY
);
