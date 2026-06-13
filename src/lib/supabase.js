import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://jjaycfydrcyupwasokni.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpqYXljZnlkcmN5dXB3YXNva25pIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEzNzUwMzYsImV4cCI6MjA5Njk1MTAzNn0.v9IbITj_WDxCUIrCmV36UVHxx6u1IRFC-7ZqMdtgRjU'

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
