export async function sendTelegram(message) {
  try {
    await fetch('/api/send-telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    })
  } catch (err) {
    console.error('Telegram error:', err)
  }
}

export function priceUpMessage(asin, title, oldPrice, newPrice) {
  return `🟡 <b>ارتفع السعر في AE</b>\n\n` +
    `<b>${title?.substring(0, 50)}...</b>\n` +
    `ASIN: <code>${asin}</code>\n` +
    `السعر القديم: ${oldPrice} AED\n` +
    `السعر الجديد: <b>${newPrice} AED</b>\n\n` +
    `⚠️ راجع السعر في مصر`
}

export function unavailableMessage(asin, title) {
  return `🔴 <b>منتج مش موجود في الإمارات</b>\n\n` +
    `<b>${title?.substring(0, 50)}...</b>\n` +
    `ASIN: <code>${asin}</code>\n\n` +
    `قرر هتعمل إيه بيه`
}
