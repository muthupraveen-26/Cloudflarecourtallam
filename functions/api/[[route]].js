import { Hono } from 'hono'
import { handle } from 'hono/cloudflare-pages'
import { createClient } from '@supabase/supabase-js'
import { generateInvoicePdf } from './helpers/invoice.js'
import { secureHeaders } from 'hono/secure-headers'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { sign, verify } from 'hono/jwt'

const app = new Hono().basePath('/api')

// JWT Secret Key (should be in env, fallback for migration)
const JWT_SECRET = 'super-secret-admin-key-2026'

// --- Global Security Middleware ---

// 1. Strict Security Headers
app.use('*', secureHeaders({
  xFrameOptions: 'DENY',
  xContentTypeOptions: 'nosniff',
  strictTransportSecurity: 'max-age=31536000; includeSubDomains; preload',
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com"],
    styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
    fontSrc: ["'self'", "https://fonts.gstatic.com"],
    imgSrc: ["'self'", "data:", "https://gywikppuosljysbomblu.supabase.co"],
    connectSrc: ["'self'", "https://gywikppuosljysbomblu.supabase.co"]
  }
}))

// 2. CSRF Origin Verification for POST/PUT/DELETE
app.use('*', async (c, next) => {
  if (['POST', 'PUT', 'DELETE'].includes(c.req.method)) {
    const origin = c.req.header('Origin') || c.req.header('Referer')
    const host = c.req.header('Host')
    if (origin && !origin.includes(host)) {
      return c.json({ error: 'CSRF Token Missing or Origin Mismatch' }, 403)
    }
  }
  await next()
})

// Helper to get supabase client
const getSupabase = (c) => {
  return createClient(c.env.SUPABASE_URL, c.env.SUPABASE_SERVICE_KEY)
}

// Global Error Handler
app.onError((err, c) => {
  console.error(`[API ERROR] ${err}`)
  return c.json({ error: 'Internal Server Error' }, 500)
})

// Crypto helper to match Python hashlib.sha256((password + salt).encode('utf-8')).hexdigest()
async function verifyPassword(password, storedHash) {
  if (!storedHash.includes('$')) return false
  const [salt, hash] = storedHash.split('$')
  
  const encoder = new TextEncoder()
  const data = encoder.encode(password + salt)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
  
  return hashHex === hash
}

// WhatsApp Helper
async function sendInvoiceWhatsapp(booking, pdfUrl, env) {
  const phone = booking.customer_phone.replace(/\D/g, '')
  const msgText = `Hi ${booking.customer_name}! Your booking is confirmed. Booking ID: ${booking.unique_booking_id}. Click here to download your invoice: ${pdfUrl}`
  
  let sent = false
  
  if (env.N8N_WEBHOOK_URL) {
    try {
      const res = await fetch(env.N8N_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone,
          message: msgText,
          pdf_url: pdfUrl,
          booking_id: booking.unique_booking_id,
          customer_name: booking.customer_name
        })
      })
      if (res.ok) sent = true
    } catch(e) { console.error("N8N WhatsApp failed", e) }
  }
  
  if (env.EVOLUTION_API_URL && !sent) {
    try {
      const mediaEndpoint = `${env.EVOLUTION_API_URL}/message/sendMedia/${env.EVOLUTION_INSTANCE}`
      await fetch(mediaEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': env.EVOLUTION_API_KEY },
        body: JSON.stringify({
          number: phone,
          media: pdfUrl,
          mediaType: "document",
          fileName: `invoice_${booking.unique_booking_id}.pdf`,
          caption: msgText
        })
      })
    } catch(e) { console.error("Evolution WhatsApp failed", e) }
  }
}

// --- Public Data Endpoints ---

app.get('/settings', async (c) => {
  const supabase = getSupabase(c)
  const { data, error } = await supabase.from('settings').select('*')
  if (error) return c.json({}, 500)
  
  const settings = {}
  data.forEach(row => {
    settings[row.key] = row.value
  })
  return c.json(settings)
})

app.get('/packages', async (c) => {
  const supabase = getSupabase(c)
  const { data, error } = await supabase.from('packages').select('*').order('display_order', { ascending: true })
  if (error) return c.json([], 500)
  
  const parsedData = data.map(item => {
    try { if (typeof item.images === 'string') item.images = JSON.parse(item.images) } catch(e){}
    try { if (typeof item.inclusions === 'string') item.inclusions = JSON.parse(item.inclusions) } catch(e){}
    try { if (typeof item.itinerary === 'string') item.itinerary = JSON.parse(item.itinerary) } catch(e){}
    return item
  })
  return c.json(parsedData)
})

app.get('/rooms', async (c) => {
  const supabase = getSupabase(c)
  const { data, error } = await supabase.from('rooms').select('*')
  if (error) return c.json([], 500)
  
  const parsedData = data.map(item => {
    try { if (typeof item.images === 'string') item.images = JSON.parse(item.images) } catch(e){}
    try { if (typeof item.amenities === 'string') item.amenities = JSON.parse(item.amenities) } catch(e){}
    // Convert integer available to boolean for frontend compatibility
    if (item.available !== undefined) item.available = Boolean(item.available)
    return item
  })
  return c.json(parsedData)
})

app.get('/transport', async (c) => {
  const supabase = getSupabase(c)
  const { data, error } = await supabase.from('transport').select('*')
  if (error) return c.json([], 500)
  
  const parsedData = data.map(item => {
    try { if (typeof item.images === 'string') item.images = JSON.parse(item.images) } catch(e){}
    return item
  })
  return c.json(parsedData)
})

app.get('/banners', async (c) => {
  const supabase = getSupabase(c)
  const { data, error } = await supabase.from('banners').select('*').order('display_order', { ascending: true })
  if (error) return c.json([], 500)
  return c.json(data)
})

app.get('/glimpses', async (c) => {
  const supabase = getSupabase(c)
  const { data, error } = await supabase.from('glimpses').select('*').order('display_order', { ascending: true })
  if (error) return c.json([], 500)
  return c.json(data)
})

app.get('/view-count', async (c) => {
  const supabase = getSupabase(c)
  // Only valid if logged in, but we return a generic count for now
  const { count: total } = await supabase.from('page_views').select('*', { count: 'exact', head: true })
  return c.json({ total: total || 0, today: 0, by_page: [] })
})

// --- Input Sanitization Helper ---
const sanitizeHtml = (str) => {
  if (typeof str !== 'string') return str
  return str.replace(/</g, '&lt;').replace(/>/g, '&gt;').trim()
}

// --- Public POST Endpoints ---
app.post('/inquiries', async (c) => {
  const body = await c.req.json()
  const supabase = getSupabase(c)
  
  const { error } = await supabase.from('inquiries').insert([{
    name: sanitizeHtml(body.name),
    email: sanitizeHtml(body.email),
    subject: sanitizeHtml(body.subject),
    message: sanitizeHtml(body.message)
  }])
  
  if (error) return c.json({ status: 'error', message: error.message }, 500)
  return c.json({ status: 'success' })
})

app.post('/bookings', async (c) => {
  const body = await c.req.json()
  const supabase = getSupabase(c)
  
  const payload = {
    customer_name: sanitizeHtml(body.customer_name),
    customer_email: sanitizeHtml(body.customer_email),
    customer_phone: sanitizeHtml(body.customer_phone),
    item_type: sanitizeHtml(body.item_type),
    item_id: sanitizeHtml(body.item_id),
    check_in: sanitizeHtml(body.check_in),
    check_out: sanitizeHtml(body.check_out) || null,
    guests: parseInt(body.guests || 1),
    status: 'New Request'
  }
  
  const { error } = await supabase.from('bookings').insert([payload])
  if (error) return c.json({ status: 'error', message: error.message }, 500)
  return c.json({ status: 'success' })
})

// --- Auth Endpoints ---

app.post('/login', async (c) => {
  const body = await c.req.json()
  const { email, password, remember_device } = body
  
  const supabase = getSupabase(c)
  
  const { data: user, error } = await supabase.from('users').select('*').eq('email', email).single()
  
  if (error || !user) {
    // Avoid user enumeration
    return c.json({ status: 'error', message: 'Invalid credentials.' }, 401)
  }
  
  // 1. Brute Force Check
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    return c.json({ status: 'error', message: 'Account locked due to too many failed attempts. Try again later.' }, 401)
  }
  
  // 2. Hash verification
  const isValid = await verifyPassword(password, user.password_hash)
  
  if (!isValid) {
    const attempts = (user.failed_login_attempts || 0) + 1
    const updates = { failed_login_attempts: attempts }
    if (attempts >= 5) {
      // Lock for 15 minutes
      updates.locked_until = new Date(Date.now() + 15 * 60000).toISOString()
    }
    await supabase.from('users').update(updates).eq('email', email)
    return c.json({ status: 'error', message: 'Invalid credentials.' }, 401)
  }
  
  // 3. Reset failed attempts on success
  if (user.failed_login_attempts > 0) {
    await supabase.from('users').update({ failed_login_attempts: 0, locked_until: null }).eq('email', email)
  }
  
  // 4. Generate JWT Session
  const token = await sign({
    email: user.email,
    role: user.role,
    name: user.name,
    exp: Math.floor(Date.now() / 1000) + (remember_device ? 2592000 : 86400) // 30 days or 1 day
  }, c.env.JWT_SECRET || JWT_SECRET)
  
  // 5. Set hardened cookie
  setCookie(c, 'session_token', token, {
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'Strict',
    maxAge: remember_device ? 2592000 : undefined
  })
  
  return c.json({ status: 'success', role: user.role, name: user.name })
})

app.get('/logout', async (c) => {
  c.header('Set-Cookie', 'session_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0')
  return c.json({ status: 'success' })
})

// --- Admin Authentication Middleware ---
const adminAuth = async (c, next) => {
  const token = getCookie(c, 'session_token')
  if (!token) return c.json({ error: 'Unauthorized. No token provided.' }, 401)
  
  try {
    const payload = await verify(token, c.env.JWT_SECRET || JWT_SECRET)
    c.set('user', payload)
    await next()
  } catch (e) {
    return c.json({ error: 'Unauthorized. Invalid or expired session.' }, 401)
  }
}

// Generic Upsert Handler for common tables
const handleUpsert = async (c, table) => {
  const body = await c.req.json()
  const supabase = getSupabase(c)
  
  // Auto-generate ID if missing for new records
  if (!body.id) {
    body.id = crypto.randomUUID()
  }
  
  const { data, error } = await supabase.from(table).upsert(body).select()
  
  if (error) {
    return c.json({ status: 'error', message: error.message }, 500)
  }
  
  return c.json({ status: 'success', message: 'Item saved successfully!', data })
}

app.post('/packages', adminAuth, (c) => handleUpsert(c, 'packages'))
app.post('/rooms', adminAuth, (c) => handleUpsert(c, 'rooms'))
app.post('/transport', adminAuth, (c) => handleUpsert(c, 'transport'))
app.post('/banners', adminAuth, (c) => handleUpsert(c, 'banners'))
app.post('/glimpses', adminAuth, (c) => handleUpsert(c, 'glimpses'))
app.post('/settings', adminAuth, async (c) => {
  const body = await c.req.json()
  const supabase = getSupabase(c)
  
  const updates = Object.keys(body).map(key => ({
    key: key,
    value: String(body[key])
  }))
  
  const { error } = await supabase.from('settings').upsert(updates)
  if (error) return c.json({ status: 'error', message: error.message }, 500)
  
  return c.json({ status: 'success' })
})

app.post('/bookings/update', adminAuth, async (c) => {
  const body = await c.req.json()
  const supabase = getSupabase(c)
  
  const { data: booking, error: fetchErr } = await supabase.from('bookings').select('*').eq('id', body.id).single()
  if (fetchErr) return c.json({ status: 'error', message: 'Booking not found' }, 404)
  
  let newStatus = body.status
  let bookingIdGen = booking.unique_booking_id
  
  if (['Payment Confirmed', 'Booking Confirmed'].includes(newStatus) && !bookingIdGen) {
    const d = new Date(booking.check_in)
    const dStr = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`
    bookingIdGen = `CH-${dStr}-${booking.id}`
  }
  
  let invoiceNum = body.invoice_number || booking.invoice_number
  if (!invoiceNum && ['Payment Confirmed', 'Booking Confirmed'].includes(newStatus)) {
    invoiceNum = `INV-${bookingIdGen || booking.id}`
  }
  
  const updatePayload = {
    status: newStatus,
    amount: parseInt(body.amount || booking.amount || 0),
    provider_name: body.provider_name,
    provider_phone: body.provider_phone,
    payment_notes: body.payment_notes,
    unique_booking_id: bookingIdGen,
    advance_amount: parseInt(body.advance_amount || booking.advance_amount || 0),
    balance_amount: parseInt(body.balance_amount || booking.balance_amount || 0),
    invoice_number: invoiceNum,
    is_duplicate: Boolean(body.is_duplicate)
  }
  
  await supabase.from('bookings').update(updatePayload).eq('id', body.id)
  
  // Refetch
  const { data: updatedBooking } = await supabase.from('bookings').select('*').eq('id', body.id).single()
  
  // Trigger PDF Generation
  if (['Payment Confirmed', 'Booking Confirmed'].includes(newStatus) && !booking.invoice_pdf_url) {
    // Get settings for PDF
    const { data: settingsData } = await supabase.from('settings').select('*')
    const settings = {}
    if (settingsData) settingsData.forEach(r => settings[r.key] = r.value)
    
    try {
      const pdfUrl = await generateInvoicePdf(updatedBooking, settings, supabase)
      await supabase.from('bookings').update({ invoice_pdf_url: pdfUrl }).eq('id', body.id)
      
      // WhatsApp notification
      await sendInvoiceWhatsapp(updatedBooking, pdfUrl, c.env)
    } catch (err) {
      console.error("PDF generation failed:", err)
    }
  }
  
  return c.json({ status: 'success', booking_id: bookingIdGen })
})

// --- File Upload Endpoint ---
app.post('/upload', adminAuth, async (c) => {
  try {
    const body = await c.req.parseBody()
    const file = body['file']
    const bucket = body['bucket'] || 'gallery'

    if (!file || typeof file === 'string') {
      return c.json({ status: 'error', message: 'No file uploaded' }, 400)
    }

    const supabase = getSupabase(c)
    const ext = file.name.split('.').pop().toLowerCase()
    const filename = `${Date.now()}_${Math.random().toString(36).substring(7)}.${ext}`
    
    // Cloudflare Workers File object implements the Blob interface
    const { data, error } = await supabase.storage.from(bucket).upload(filename, file, {
      cacheControl: '3600',
      upsert: false
    })
    
    if (error) {
      return c.json({ status: 'error', message: error.message }, 500)
    }
    
    const { data: publicUrlData } = supabase.storage.from(bucket).getPublicUrl(filename)
    
    return c.json({ status: 'success', file_url: publicUrlData.publicUrl })
  } catch (err) {
    return c.json({ status: 'error', message: err.message }, 500)
  }
})

// Catch-all for missing routes
app.all('*', (c) => c.json({ error: 'Endpoint not implemented yet.' }, 404))

export const onRequest = handle(app)
