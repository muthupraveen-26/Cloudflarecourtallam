import { PDFDocument, rgb, StandardFonts } from 'pdf-lib'

export async function generateInvoicePdf(booking, settings, supabase) {
  const pdfDoc = await PDFDocument.create()
  const page = pdfDoc.addPage([595.28, 841.89]) // A4 size
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold)
  
  const { width, height } = page.getSize()
  
  const companyName = settings.invoice_company_name || 'COURTALLAM HOLIDAYS'
  const termsText = settings.invoice_terms || '1. All bookings subject to availability.\n2. Please carry Govt photo ID.'
  
  page.drawText(companyName, {
    x: 50,
    y: height - 50,
    size: 20,
    font: boldFont,
    color: rgb(0.13, 0.44, 0.36) // #22705d
  })
  
  page.drawText('INVOICE / RECEIPT', {
    x: width - 200,
    y: height - 50,
    size: 14,
    font: boldFont,
    color: rgb(0.4, 0.4, 0.4)
  })
  
  page.drawText(`Booking ID: ${booking.unique_booking_id || booking.id}`, {
    x: 50,
    y: height - 100,
    size: 12,
    font: boldFont
  })
  
  page.drawText(`Name: ${booking.customer_name}`, { x: 50, y: height - 120, size: 10, font })
  page.drawText(`Item: ${booking.item_type}`, { x: 50, y: height - 135, size: 10, font })
  page.drawText(`Dates: ${booking.check_in} to ${booking.check_out || ''}`, { x: 50, y: height - 150, size: 10, font })
  
  page.drawText(`Total Amount: Rs. ${booking.amount}`, { x: 50, y: height - 200, size: 12, font: boldFont })
  page.drawText(`Advance Paid: Rs. ${booking.advance_amount || 0}`, { x: 50, y: height - 220, size: 12, font })
  page.drawText(`Balance Pending: Rs. ${booking.balance_amount || 0}`, { x: 50, y: height - 240, size: 12, font: boldFont, color: rgb(0.8, 0.2, 0.2) })
  
  page.drawText('Terms & Conditions:', { x: 50, y: height - 300, size: 10, font: boldFont })
  page.drawText(termsText, { x: 50, y: height - 315, size: 8, font, lineHeight: 12 })
  
  const pdfBytes = await pdfDoc.save()
  const filename = `invoices/invoice_${booking.unique_booking_id || booking.id}_${Date.now()}.pdf`
  
  // Upload to supabase
  const { data, error } = await supabase.storage.from('gallery').upload(filename, pdfBytes, {
    contentType: 'application/pdf',
    upsert: true
  })
  
  if (error) {
    console.error("PDF upload error:", error)
    throw error
  }
  
  const { data: publicUrlData } = supabase.storage.from('gallery').getPublicUrl(filename)
  return publicUrlData.publicUrl
}
