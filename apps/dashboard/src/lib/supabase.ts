import { createClient } from "@supabase/supabase-js";

// Public production defaults — safe to commit. The anon key is a public token
// that already ships inside every client bundle; RLS and the separate
// service-role key (never committed) protect the data. These act as a fallback
// so a missing/misconfigured build env (e.g. a Vercel env var dropped) can not
// throw at startup and blank the entire app. A real VITE_SUPABASE_URL /
// VITE_SUPABASE_ANON_KEY still takes precedence (local dev, a future project).
const FALLBACK_URL = "https://lvoqvkbydbkyyaxonzmp.supabase.co";
const FALLBACK_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx2b3F2a2J5ZGJreXlheG9uem1wIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM5OTMyMTksImV4cCI6MjA5OTU2OTIxOX0.VXp65c7mUuOYcqJmc51FxxAIFHW5pWjcxGQiNN2U_mU";

const url = (import.meta.env.VITE_SUPABASE_URL as string | undefined) || FALLBACK_URL;
const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) || FALLBACK_ANON_KEY;

export const supabase = createClient(url, anonKey);

// Resolved URL + anon key (env or fallback) for callers that hit the REST/Edge
// endpoints directly with a plain fetch — e.g. the kiosk terminal, which has no
// personal session and posts to the kiosk-punch Edge Function with the anon key.
export const supabaseUrl = url;
export const supabaseAnonKey = anonKey;
