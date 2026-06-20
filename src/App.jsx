import { useState, useEffect, useCallback } from 'react'
import { getProducts, getSettings, updateExchangeRate, saveShipping, saveShippingBulk, createJob, updateJob, upsertProductsAE, deleteProducts, markNotInCatalog, unmarkNotInCatalog, markAwaitingListing, unmarkAwaitingListing, saveShippingReference, getShippingReference, saveAIShippingToReference, getPriceAlerts, markAlertsSeen, savePriceAlert, updateAEPrices, updateAEPricesWithDelivery, updateProductPrice, markRejected, saveAIShipping, upsertProductSellers, getProductSellers, checkCatalog, savePriceHistory, getPriceHistory, confirmSuspiciousShipping, rejectSuspiciousShipping, getAllSellers, getSellerProducts, addFriendSeller, removeFriendSeller, getFriendSellers, rejectProductsWithFriends } from './lib/products'
import { runScrapeAE, runScrapeSellers, getRunStatus, getRunResults } from './lib/apify'
import { parseShippingExcel, fillAmazonTemplate, exportAsins, parseProcessingSummary, parseAsinsExcel } from './lib/excel'
import { sendTelegram } from './lib/telegram'
import { calculateShipping, estimateWeight } from './lib/shipping'
import './App.css'

const STATUS = {
  all: 'كل المنتجات',
  missing: 'ناقص شحن',
  suspicious: 'مشكوك في الشحن',
  ready: 'جاهز للرفع',
  awaiting: 'في انتظار العرض',
  active: 'اشتغلت',
  lost_buybox: 'خسران الباي بوكس',
  burnt: 'محروقة',
  rejected: 'مرفوضة',
  alerts: 'تنبيهات',
}
import { OUR_SELLER, OUR_SELLER_ID } from './lib/constants'

// Interactive chart with hover tooltip + filter
function ChartWithHover({ productHistory, rate, fmt, filter, setFilter }) {
  const [hover, setHover] = useState(null)

  const allAeData = productHistory.filter(h => h.price_aed != null).map(h => ({...h, time: new Date(h.recorded_at).getTime()}))
  const allEgData = productHistory.filter(h => h.price_egp != null).map(h => ({...h, time: new Date(h.recorded_at).getTime()}))

  // Apply filter
  const showAe = filter === 'both' || filter === 'ae'
  const showEg = filter === 'both' || filter === 'eg'
  const aeData = showAe ? allAeData : []
  const egData = showEg ? allEgData : []

  if (!allAeData.length && !allEgData.length) return <div className="pd-empty">مفيش بيانات للرسم</div>

  // SVG dimensions
  const W = 860, H = 380
  const PAD = { top: 30, right: 110, bottom: 60, left: 110 }
  const innerW = W - PAD.left - PAD.right
  const innerH = H - PAD.top - PAD.bottom

  const allTimes = [...aeData, ...egData].map(d => d.time)
  // If no data after filter, use the unfiltered for time range
  const fallbackTimes = !allTimes.length ? [...allAeData, ...allEgData].map(d => d.time) : allTimes
  const tMin = Math.min(...fallbackTimes), tMax = Math.max(...fallbackTimes)

  // SEPARATE Y axes — each currency uses its own scale
  const aePrices = aeData.map(h => h.price_aed) // in AED
  const egPrices = egData.map(h => h.price_egp) // in EGP

  // Compute padded ranges per axis
  const computeRange = (prices) => {
    if (!prices.length) return { min: 0, max: 100 }
    const pMin = Math.min(...prices)
    const pMax = Math.max(...prices)
    const range = (pMax - pMin) || pMax * 0.1 || 100
    return { min: Math.max(0, pMin - range * 0.2), max: pMax + range * 0.2 }
  }
  const aeRange = computeRange(aePrices)
  const egRange = computeRange(egPrices)

  const toX = (t) => PAD.left + ((t - tMin) / ((tMax - tMin) || 1)) * innerW
  const toYae = (v) => PAD.top + (1 - (v - aeRange.min) / (aeRange.max - aeRange.min || 1)) * innerH
  const toYeg = (v) => PAD.top + (1 - (v - egRange.min) / (egRange.max - egRange.min || 1)) * innerH

  // Y ticks (5 per axis)
  const buildTicks = (range, toY) => {
    const ticks = []
    const step = (range.max - range.min) / 4
    for (let i = 0; i <= 4; i++) {
      const v = range.min + step * i
      ticks.push({ value: v, y: toY(v) })
    }
    return ticks
  }
  const aeTicks = showAe ? buildTicks(aeRange, toYae) : []
  const egTicks = showEg ? buildTicks(egRange, toYeg) : []

  const aeArea = aeData.length > 1
    ? `M${toX(aeData[0].time).toFixed(1)},${toYae(aeData[0].price_aed).toFixed(1)} ` +
      aeData.slice(1).map(h => `L${toX(h.time).toFixed(1)},${toYae(h.price_aed).toFixed(1)}`).join(' ') +
      ` L${toX(aeData[aeData.length-1].time).toFixed(1)},${H - PAD.bottom} L${toX(aeData[0].time).toFixed(1)},${H - PAD.bottom} Z`
    : ''
  const egArea = egData.length > 1
    ? `M${toX(egData[0].time).toFixed(1)},${toYeg(egData[0].price_egp).toFixed(1)} ` +
      egData.slice(1).map(h => `L${toX(h.time).toFixed(1)},${toYeg(h.price_egp).toFixed(1)}`).join(' ') +
      ` L${toX(egData[egData.length-1].time).toFixed(1)},${H - PAD.bottom} L${toX(egData[0].time).toFixed(1)},${H - PAD.bottom} Z`
    : ''

  const aePath = aeData.length > 1
    ? aeData.map((h, i) => `${i===0?'M':'L'}${toX(h.time).toFixed(1)},${toYae(h.price_aed).toFixed(1)}`).join(' ')
    : ''
  const egPath = egData.length > 1
    ? egData.map((h, i) => `${i===0?'M':'L'}${toX(h.time).toFixed(1)},${toYeg(h.price_egp).toFixed(1)}`).join(' ')
    : ''

  const fmtTime = (t) => {
    const d = new Date(t)
    return `${d.getDate()}/${d.getMonth()+1}`
  }

  return (
    <div className="pd-chart-wrap">
      {/* Filter Tabs */}
      <div className="chart-filter">
        <button className={`chart-filter-btn ${filter === 'both' ? 'active' : ''}`} onClick={() => setFilter('both')}>
          الاتنين
        </button>
        <button className={`chart-filter-btn ${filter === 'ae' ? 'active' : ''}`} onClick={() => setFilter('ae')}>
          <span className="chart-legend-dot" style={{background:'#f59e0b'}}></span>
          🇦🇪 الإمارات
        </button>
        <button className={`chart-filter-btn ${filter === 'eg' ? 'active' : ''}`} onClick={() => setFilter('eg')}>
          <span className="chart-legend-dot" style={{background:'#6366f1'}}></span>
          🇪🇬 مصر
        </button>
      </div>

      <div style={{position:'relative', width:'100%'}}>
        <svg viewBox={`0 0 ${W} ${H}`} style={{width:'100%', height:'auto', display:'block', overflow:'visible'}} preserveAspectRatio="xMidYMid meet">
          <defs>
            <linearGradient id="aeGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#f59e0b" stopOpacity="0.2"/>
              <stop offset="100%" stopColor="#f59e0b" stopOpacity="0"/>
            </linearGradient>
            <linearGradient id="egGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#6366f1" stopOpacity="0.2"/>
              <stop offset="100%" stopColor="#6366f1" stopOpacity="0"/>
            </linearGradient>
          </defs>

          {/* Grid lines (use whichever ticks are visible) */}
          {(showEg ? egTicks : aeTicks).map((t, i) => (
            <line key={`grid${i}`} x1={PAD.left} y1={t.y} x2={W - PAD.right} y2={t.y} stroke="var(--border)" strokeWidth="1" strokeDasharray={i === 0 ? "0" : "3,5"} opacity="0.6"/>
          ))}

          {/* Y-axis LEFT — Egypt (EGP) */}
          {showEg && (
            <>
              <text x={PAD.left - 14} y={PAD.top - 12} fontSize="11" fill="#6366f1" textAnchor="end" fontWeight="700">EGP</text>
              {egTicks.map((t, i) => (
                <text key={`yegL${i}`} x={PAD.left - 12} y={t.y + 4} fontSize="11" fill="#6366f1" textAnchor="end" fontFamily="ui-monospace, monospace" fontWeight="500">
                  {Math.round(t.value).toLocaleString('en')}
                </text>
              ))}
            </>
          )}

          {/* Y-axis RIGHT — UAE (AED) */}
          {showAe && (
            <>
              <text x={W - PAD.right + 14} y={PAD.top - 12} fontSize="11" fill="#f59e0b" textAnchor="start" fontWeight="700">AED</text>
              {aeTicks.map((t, i) => (
                <text key={`yaeR${i}`} x={W - PAD.right + 12} y={t.y + 4} fontSize="11" fill="#f59e0b" textAnchor="start" fontFamily="ui-monospace, monospace" fontWeight="500">
                  {Math.round(t.value).toLocaleString('en')}
                </text>
              ))}
            </>
          )}

          {/* X axis baseline */}
          <line x1={PAD.left} y1={H - PAD.bottom} x2={W - PAD.right} y2={H - PAD.bottom} stroke="var(--text-faint)" strokeWidth="1.5"/>

          {/* X axis ticks */}
          {[0, 0.25, 0.5, 0.75, 1].map((p, i) => {
            const t = tMin + (tMax - tMin) * p
            const x = toX(t)
            return (
              <g key={`x${i}`}>
                <line x1={x} y1={H - PAD.bottom} x2={x} y2={H - PAD.bottom + 5} stroke="var(--text-faint)"/>
                <text x={x} y={H - PAD.bottom + 22} fontSize="11" fill="var(--text-soft)" textAnchor="middle" fontFamily="ui-monospace, monospace">
                  {fmtTime(t)}
                </text>
              </g>
            )
          })}

          {/* Area fills */}
          {aeArea && <path d={aeArea} fill="url(#aeGradient)"/>}
          {egArea && <path d={egArea} fill="url(#egGradient)"/>}

          {/* Lines */}
          {aePath && <path d={aePath} fill="none" stroke="#f59e0b" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round"/>}
          {egPath && <path d={egPath} fill="none" stroke="#6366f1" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round"/>}

          {/* Vertical line on hover */}
          {hover && (
            <line x1={toX(hover.time)} y1={PAD.top} x2={toX(hover.time)} y2={H - PAD.bottom} stroke="var(--text-soft)" strokeWidth="1" strokeDasharray="3,3" opacity="0.5"/>
          )}

          {/* Data points - AE */}
          {aeData.map((h, i) => {
            const isHover = hover && hover.point === h && hover.kind === 'ae'
            return (
              <circle
                key={`ae-${i}`}
                cx={toX(h.time)}
                cy={toYae(h.price_aed)}
                r={isHover ? "7" : "5"}
                fill="var(--bg-elev)"
                stroke="#f59e0b"
                strokeWidth="2.5"
                style={{cursor:'pointer', transition:'r 0.15s'}}
                onMouseEnter={() => setHover({ point: h, kind: 'ae', x: toX(h.time), y: toYae(h.price_aed), time: h.time })}
                onMouseLeave={() => setHover(null)}
              />
            )
          })}

          {/* Data points - EG */}
          {egData.map((h, i) => {
            const isHover = hover && hover.point === h && hover.kind === 'eg'
            return (
              <circle
                key={`eg-${i}`}
                cx={toX(h.time)}
                cy={toYeg(h.price_egp)}
                r={isHover ? "7" : "5"}
                fill="var(--bg-elev)"
                stroke="#6366f1"
                strokeWidth="2.5"
                style={{cursor:'pointer', transition:'r 0.15s'}}
                onMouseEnter={() => setHover({ point: h, kind: 'eg', x: toX(h.time), y: toYeg(h.price_egp), time: h.time })}
                onMouseLeave={() => setHover(null)}
              />
            )
          })}
        </svg>

        {/* HTML Tooltip (positioned absolutely, uses theme vars properly) */}
        {hover && (() => {
          const point = hover.point
          const isAe = hover.kind === 'ae'
          const d = new Date(point.recorded_at)
          const dateStr = `${d.getDate()}/${d.getMonth()+1}/${d.getFullYear()} ${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`

          // SVG coords -> percentage
          const xPct = (hover.x / W) * 100
          const yPct = (hover.y / H) * 100
          const onRight = xPct > 60
          return (
            <div
              className="chart-tooltip"
              style={{
                position: 'absolute',
                left: `${xPct}%`,
                top: `${yPct}%`,
                transform: onRight ? 'translate(calc(-100% - 16px), -50%)' : 'translate(16px, -50%)',
                borderColor: isAe ? '#f59e0b' : '#6366f1',
                pointerEvents: 'none',
              }}
            >
              <div className="chart-tooltip-title" style={{color: isAe ? '#f59e0b' : '#6366f1'}}>
                {isAe ? '🇦🇪 الإمارات' : '🇪🇬 مصر'}
              </div>
              <div className="chart-tooltip-price">
                {isAe ? `${fmt(point.price_aed)} AED` : `${fmt(point.price_egp)} EGP`}
              </div>
              {isAe && (
                <div className="chart-tooltip-sub">= {fmt(point.price_aed * rate)} EGP</div>
              )}
              {!isAe && point.buy_box_seller && (
                <div className="chart-tooltip-sub">Buy Box: {(point.buy_box_seller || '—').substring(0, 24)}</div>
              )}
              <div className="chart-tooltip-date">{dateStr}</div>
            </div>
          )
        })()}
      </div>
    </div>
  )
}

export default function App() {
  const [products, setProducts] = useState([])
  const [settings, setSettings] = useState({ exchange_rate: '14.80' })
  const [tab, setTab] = useState('all')
  const [alertFilter, setAlertFilter] = useState('all')  // sub-filter inside alerts tab
  const [showSellersPage, setShowSellersPage] = useState(false)
  const [sellersData, setSellersData] = useState(null)
  const [sellersLoading, setSellersLoading] = useState(false)
  const [sellersSearch, setSellersSearch] = useState('')
  const [sellersFilter, setSellersFilter] = useState('all')  // 'all' | 'friends' | 'non_friends'
  const [sellerProductsView, setSellerProductsView] = useState(null) // { seller, products }
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'light')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)
  const [scrapeUrl, setScrapeUrl] = useState('')
  const [scraping, setScraping] = useState(false)
  const [scrapeStatus, setScrapeStatus] = useState('')
  const [progress, setProgress] = useState(0)
  const [progressItems, setProgressItems] = useState(0)
  const [exRate, setExRate] = useState('14.80')
  const [updatingRate, setUpdatingRate] = useState(false)
  const [refreshingEG, setRefreshingEG] = useState(false)
  const [notifications, setNotifications] = useState([])
  const [selected, setSelected] = useState(new Set())
  const [alerts, setAlerts] = useState([])
  const [updatingAE, setUpdatingAE] = useState(false)
  const [editProduct, setEditProduct] = useState(null)
  const [summaryTemplate, setSummaryTemplate] = useState(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [brandFilter, setBrandFilter] = useState('')
  const [sortBy, setSortBy] = useState('default')
  const [brandSearch, setBrandSearch] = useState('')
  const [showBrandDropdown, setShowBrandDropdown] = useState(false)
  const [aiShipping, setAiShipping] = useState(false)
  const [updatingSellers, setUpdatingSellers] = useState(false)
  const [checkingCatalog, setCheckingCatalog] = useState(false)
  const [productDetail, setProductDetail] = useState(null)
  const [productHistory, setProductHistory] = useState(null)
  const [chartFilter, setChartFilter] = useState('both') // 'both' | 'ae' | 'eg'

  // Auto-refresh productDetail when products list updates
  useEffect(() => {
    if (productDetail) {
      const latest = products.find(x => x.asin === productDetail.asin)
      if (latest && JSON.stringify(latest) !== JSON.stringify(productDetail)) {
        setProductDetail(latest)
      }
    }
  }, [products, productDetail])
  const [sellersModalAsin, setSellersModalAsin] = useState(null)
  const [sellersModalData, setSellersModalData] = useState(null)
  const [aiProgress, setAiProgress] = useState('')

  const load = useCallback(async () => {
    const [prods, sett, alts] = await Promise.all([getProducts(), getSettings(), getPriceAlerts()])
    setProducts(prods || [])
    setSettings(sett || {})
    setExRate(sett?.exchange_rate || '14.80')
    setAlerts(alts || [])
  }, [])

  useEffect(() => { load() }, [load])

  // Apply theme to document
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('theme', theme)
  }, [theme])

  // Reset alertFilter to 'all' if the currently-selected filter has no alerts anymore
  useEffect(() => {
    if (alertFilter !== 'all') {
      const hasAny = alerts.some(a => a.alert_type === alertFilter)
      if (!hasAny) setAlertFilter('all')
    }
  }, [alerts, alertFilter])

  useEffect(() => {
    if (!showBrandDropdown) return
    const handler = (e) => {
      if (!e.target.closest('.brand-filter')) setShowBrandDropdown(false)
    }
    document.addEventListener('click', handler)
    return () => document.removeEventListener('click', handler)
  }, [showBrandDropdown])

  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const fresh = await getProducts()
        setProducts(prev => {
          // Quick check: if length and last_scraped didn't change, skip
          if (prev.length === fresh.length) {
            const prevSig = prev.slice(0, 5).map(p => `${p.asin}|${p.last_scraped_ae}|${p.last_scraped_eg}`).join(',')
            const freshSig = fresh.slice(0, 5).map(p => `${p.asin}|${p.last_scraped_ae}|${p.last_scraped_eg}`).join(',')
            if (prevSig === freshSig) return prev
          }
          const newNotifs = []
          for (const p of fresh) {
            const old = prev.find(x => x.asin === p.asin)
            if (old && old.status !== p.status) {
              if (p.status === 'burnt' && old.status === 'ready')
                newNotifs.push({ asin: p.asin, title: p.title, type: 'burnt' })
              if (p.status === 'active')
                newNotifs.push({ asin: p.asin, title: p.title, type: 'active' })
            }
          }
          if (newNotifs.length) setNotifications(n => [...n, ...newNotifs])
          return fresh
        })
      } catch { /* skip */ }
    }, 120000)
    return () => clearInterval(interval)
  }, [])

  const handleBulkAsinsUpload = async (file) => {
    try {
      const asins = await parseAsinsExcel(file)
      if (!asins.length) {
        alert('مفيش ASINs صحيحة في الملف')
        return
      }
      if (!window.confirm(`تم العثور على ${asins.length} ASIN.\n\nهيتم سكرابهم من amazon.ae بنفس flow السكراب العادي (شحن، EG sellers، فحص الكاتالوج).\n\nنبدأ؟`)) return
      await startScrape(asins)
    } catch (err) {
      alert('خطأ في قراءة الملف: ' + err.message)
    }
  }

  const startScrape = async (bulkAsins = null) => {
    // bulkAsins: optional array of ASINs (from Excel upload)
    // If not provided, uses scrapeUrl input
    let url = null
    let asinsToScrape = null

    if (bulkAsins && bulkAsins.length) {
      asinsToScrape = bulkAsins
    } else {
      if (!scrapeUrl.trim()) return
      url = scrapeUrl.trim()

      // If input is an ASIN, treat as single-ASIN scrape
      if (/^B[A-Z0-9]{9}$/i.test(url)) {
        asinsToScrape = [url.toUpperCase()]
        url = null
      } else {
        if (!url.startsWith('http')) url = 'https://' + url
        if (!url.includes('amazon.ae')) {
          setScrapeStatus('❌ الـ URL لازم يكون من amazon.ae')
          setTimeout(() => setScrapeStatus(''), 3000)
          return
        }
      }
    }

    setScraping(true)
    setScrapeStatus(asinsToScrape ? `جاري سكراب ${asinsToScrape.length} ASIN...` : 'جاري إنشاء الـ job...')
    try {
      const jobLabel = asinsToScrape
        ? `bulk ${asinsToScrape.length} ASINs`
        : url
      const job = await createJob(jobLabel)
      let runId

      let results
      let count

      if (asinsToScrape) {
        // ASINs mode: batch into chunks of 30 (actor limit)
        const BATCH_SIZE = 30
        const batches = []
        for (let i = 0; i < asinsToScrape.length; i += BATCH_SIZE) {
          batches.push(asinsToScrape.slice(i, i + BATCH_SIZE))
        }

        // Start all batches in parallel
        const runIds = []
        for (const batch of batches) {
          const rid = await fetch('/api/scrape-start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ asins: batch, amazon_domain: 'www.amazon.ae', max_pages: 1 }),
          }).then(r => r.json()).then(d => d.data?.id).catch(() => null)
          if (rid) runIds.push(rid)
        }

        if (!runIds.length) {
          setScrapeStatus('❌ فشل بدء السكراب')
          setScraping(false)
          return
        }

        // Poll all runs until all complete
        setScrapeStatus(`جاري السكراب... (${runIds.length} job)`)
        setProgress(0)
        let allDone = false
        let waited = 0
        const allResults = []
        const doneRuns = new Set()
        while (!allDone && waited < 600000) {
          await new Promise(r => setTimeout(r, 5000))
          waited += 5000
          let completedCount = 0
          for (const rid of runIds) {
            if (doneRuns.has(rid)) {
              completedCount++
              continue
            }
            try {
              const progRes = await fetch(`/api/scrape-progress?runId=${rid}`)
              const progData = await progRes.json()
              if (progData.status === 'SUCCEEDED') {
                doneRuns.add(rid)
                completedCount++
                const resData = await fetch(`/api/scrape-results?runId=${rid}`).then(r => r.json())
                if (Array.isArray(resData)) allResults.push(...resData)
              } else if (progData.status === 'FAILED' || progData.status === 'ABORTED' || progData.status === 'TIMED-OUT') {
                doneRuns.add(rid)
                completedCount++
              }
            } catch (e) { /* ignore */ }
          }
          setScrapeStatus(`جاري السكراب... (${completedCount}/${runIds.length})`)
          setProgress(Math.round((completedCount / runIds.length) * 80))
          if (completedCount >= runIds.length) allDone = true
        }
        results = allResults
        count = await upsertProductsAE(results, job.id)
        await updateJob(job.id, { status: 'done', total_products: count, completed_at: new Date().toISOString() })
      } else {
        // URL mode
        runId = await runScrapeAE(url, 25)
        setScrapeStatus('جاري السكراب...')
        setProgress(0)
        setProgressItems(0)
        let status = 'RUNNING'
        let waited = 0
        while (status === 'RUNNING' && waited < 480000) {
          await new Promise(r => setTimeout(r, 3000))
          waited += 3000
          const progRes = await fetch(`/api/scrape-progress?runId=${runId}`)
          const progData = await progRes.json()
          status = progData.status
          const items = progData.itemCount || 0
          setProgressItems(items)
          const pct = Math.min(Math.round((items / 100) * 90), 90)
          setProgress(pct)
          setScrapeStatus(`جاري السكراب... ${items} منتج`)
        }
        if (status !== 'SUCCEEDED') throw new Error('فشل السكراب أو انتهى الوقت')
        setProgress(95)
        results = await getRunResults(runId)
        count = await upsertProductsAE(results, job.id)
        await updateJob(job.id, { status: 'done', total_products: count, completed_at: new Date().toISOString() })
      }

      // === COMMON POST-SCRAPE FLOW (both ASIN bulk and URL modes) ===
      // Auto-apply PERMANENT shipping reference to new products
      // (this cache never expires, even if products were deleted before —
      //  so re-scraping the same ASIN never costs AI tokens again)
      setScrapeStatus('جاري تطبيق الشحن التلقائي...')
      const shippingRef = await getShippingReference()
      const refAsins = new Set()
      if (Object.keys(shippingRef).length) {
        const newAsins = results.filter(p => p.availability && p.asin && shippingRef[p.asin])
        if (newAsins.length) {
          const shippingRows = newAsins.map(p => {
            const ref = shippingRef[p.asin]
            return {
              asin: p.asin,
              shipping_egp: ref.shipping_egp,
              shipping_source: ref.ai_weight ? 'ai' : 'manual',
              ai_weight: ref.ai_weight || null,
              ai_dimensions: ref.ai_dimensions || null,
              ai_status: ref.ai_status || null,
              shipping_suspicious: ref.shipping_suspicious || false,
            }
          })
          await saveShippingBulk(shippingRows)
          newAsins.forEach(p => refAsins.add(p.asin))
        }
      }

      // AI shipping estimation for products NOT in reference — cached permanently after
      const needsAI = results.filter(p => p.availability && p.asin && !refAsins.has(p.asin))
      for (let i = 0; i < needsAI.length; i++) {
        const p = needsAI[i]
        setScrapeStatus(`🤖 حساب الشحن بالـ AI ${i + 1}/${needsAI.length}`)
        try {
          const est = await estimateWeight(p.title, p.asin)
          if (est.success && est.weight_kg) {
            const calc = calculateShipping(est.weight_kg, est.length_cm, est.width_cm, est.height_cm)
            const dims = `${est.length_cm}×${est.width_cm}×${est.height_cm}`
            const statusLabel = est.status === 'CONFIRMED' ? 'CONFIRMED' : `ESTIMATED (${est.confidence || 0}%)`
            await saveAIShipping(p.asin, calc.shipping_fee, est.weight_kg, dims, statusLabel, calc.suspicious)
            // Cache permanently — survives product deletion
            await saveAIShippingToReference(p.asin, calc.shipping_fee, est.weight_kg, dims, statusLabel, calc.suspicious)
          }
        } catch {
          // skip this product, continue
        }
      }

      // EG scrape — now uses the SELLER MONITORING actor instead of the regular
      // scraper, so we get buy box position, all bidding sellers, ratings, and
      // delivery dates in one pass. Batched + timeout-protected like elsewhere.
      const asins = results.filter(p => p.availability && p.asin).map(p => p.asin)
      if (asins.length) {
        const EG_BATCH = 30
        let egAllResults = []
        for (let i = 0; i < asins.length; i += EG_BATCH) {
          const batch = asins.slice(i, i + EG_BATCH)
          setScrapeStatus(`جاري جلب بيانات مصر (البائعين)... ${Math.min(i + EG_BATCH, asins.length)}/${asins.length}`)
          const egRunId = await runScrapeSellers(batch)
          let egStatus = 'RUNNING'
          let egWaited = 0
          while (egStatus === 'RUNNING' && egWaited < 180000) {
            await new Promise(r => setTimeout(r, 4000))
            egWaited += 4000
            egStatus = await getRunStatus(egRunId)
          }
          try {
            const egResults = await getRunResults(egRunId)
            if (egResults && egResults.length) egAllResults = egAllResults.concat(egResults)
          } catch { /* skip batch */ }
        }
        if (egAllResults.length) {
          // Group seller rows by asin
          const byAsin = {}
          for (const row of egAllResults) {
            if (!byAsin[row.asin]) byAsin[row.asin] = []
            byAsin[row.asin].push(row)
          }
          // Load friend sellers
          const friendsListMain = await getFriendSellers()
          const friendsByIdMain = Object.fromEntries(friendsListMain.map(f => [f.seller_id, f.seller_name]))
          let friendRejectsMain = 0

          for (const [asin, sellers] of Object.entries(byAsin)) {
            await upsertProductSellers(asin, sellers)
            // Auto-reject if a friend is selling this product
            const friendSeller = sellers.find(s => friendsByIdMain[s.seller])
            if (friendSeller) {
              await markRejected(asin, `صديق بيبيعه (${friendsByIdMain[friendSeller.seller]})`)
              friendRejectsMain++
            }
          }
          if (friendRejectsMain > 0) {
            setScrapeStatus(`تم رفض ${friendRejectsMain} منتج لأن أصدقاء بيبيعوه`)
          }
          // If we're listed (any position), move it out of "awaiting" immediately
          const ourListings = Object.entries(byAsin)
            .filter(([, sellers]) => sellers.some(s => s.seller === OUR_SELLER_ID || s.seller_name === OUR_SELLER))
            .map(([asin]) => asin)
          if (ourListings.length) await unmarkAwaitingListing(ourListings)

          // ASINs that got 0 results from the seller actor — check if they're in catalog
          const noResults = asins.filter(a => !byAsin[a])
          if (noResults.length) {
            setScrapeStatus(`فحص الكاتالوج لـ ${noResults.length} منتج...`)
            const catalogMap = await checkCatalog(noResults)
            const notInCat = noResults.filter(a => catalogMap[a] === false)
            if (notInCat.length) await markNotInCatalog(notInCat)
          }
        } else {
          // All ASINs got 0 results — check catalog for all
          setScrapeStatus(`فحص الكاتالوج لـ ${asins.length} منتج...`)
          const catalogMap = await checkCatalog(asins)
          const notInCat = asins.filter(a => catalogMap[a] === false)
          if (notInCat.length) await markNotInCatalog(notInCat)
        }
      }
      setProgress(100)
      setScrapeStatus('✅ تم بنجاح!')
      setScrapeUrl('')
      await load()
    } catch (err) {
      setScrapeStatus('❌ ' + err.message)
    } finally {
      setScraping(false)
      setTimeout(() => { setScrapeStatus(''); setProgress(0); setProgressItems(0) }, 5000)
    }
  }

  const handleUpdateRate = async () => {
    setUpdatingRate(true)
    await updateExchangeRate(parseFloat(exRate))
    await load()
    setUpdatingRate(false)
  }

  const handleSaveShipping = async (asin, val) => {
    if (!val || isNaN(parseFloat(val))) return
    await saveShipping(asin, parseFloat(val))
    await load()
  }

  const handleExcelUpload = async (file) => {
    try {
      const rows = await parseShippingExcel(file)
      if (!rows.length) return alert('مفيش داتا في الملف')

      // Save as shipping reference for future scrapes
      await saveShippingReference(rows.map(r => ({ asin: r.asin, shipping_egp: r.shipping_egp })))

      // Only apply to products that already exist in DB
      const existingAsins = new Set(products.map(p => p.asin))
      const existingRows = rows.filter(r => existingAsins.has(r.asin))
      if (existingRows.length) await saveShippingBulk(existingRows)

      await load()
      alert(`✅ تم حفظ ${rows.length} منتج كـ reference${existingRows.length ? `، وتم تطبيق الشحن على ${existingRows.length} منتج موجود` : ''}`)
    } catch (err) {
      alert('❌ خطأ: ' + err.message)
    }
  }

  const toggleSelect = (asin) => {
    setSelected(prev => {
      const next = new Set(prev)
      next.has(asin) ? next.delete(asin) : next.add(asin)
      return next
    })
  }

  const toggleSelectAll = (list) => {
    if (list.every(p => selected.has(p.asin))) {
      setSelected(prev => { const n = new Set(prev); list.forEach(p => n.delete(p.asin)); return n })
    } else {
      setSelected(prev => { const n = new Set(prev); list.forEach(p => n.add(p.asin)); return n })
    }
  }

  const handleDelete = async () => {
    if (!selected.size) return
    if (!window.confirm(`⚠️ تحذير: هتمسح ${selected.size} منتج نهائياً من قاعدة البيانات. متأكد؟`)) return
    await deleteProducts([...selected])
    setSelected(new Set())
    await load()
  }

  const handleExportSelected = () => {
    const list = products.filter(p => selected.has(p.asin))
    exportAsins(list)
  }

  const handleProcessingSummary = async (summaryFile, templateFile) => {
    try {
      const items = await parseProcessingSummary(summaryFile, templateFile)
      if (!items.length) return alert('مفيش errors في الملف أو مقدرناش نربط الـ SKUs')
      await markRejected(items)
      await load()
      const priceFix = items.filter(i => i.needs_price_fix).length
      const rejected = items.filter(i => !i.needs_price_fix).length
      alert(`✅ تم تحديث ${items.length} منتج\n${rejected} مرفوض | ${priceFix} محتاج تعديل سعر`)
    } catch (err) {
      alert('❌ ' + err.message)
    }
  }

  const handleSaveEdit = async () => {
    if (!editProduct) return
    try {
      if (editProduct.price_aed) await updateProductPrice(editProduct.asin, parseFloat(editProduct.price_aed))
      if (editProduct.shipping_egp) await saveShipping(editProduct.asin, parseFloat(editProduct.shipping_egp))
      setEditProduct(null)
      await load()
    } catch (err) {
      alert('❌ ' + err.message)
    }
  }

  // Update seller data (all bidders, ratings, delivery, buy box) for given ASINs
  const handleUpdateSellers = async (asinsToUpdate) => {
    if (!asinsToUpdate.length) return
    setUpdatingSellers(true)
    try {
      const BATCH = 30
      let done = 0
      for (let i = 0; i < asinsToUpdate.length; i += BATCH) {
        const batch = asinsToUpdate.slice(i, i + BATCH)
        setScrapeStatus(`تحديث البائعين ${Math.min(i + BATCH, asinsToUpdate.length)}/${asinsToUpdate.length}`)
        const runId = await runScrapeSellers(batch)
        let status = 'RUNNING'
        let waited = 0
        while (status === 'RUNNING' && waited < 180000) {
          await new Promise(r => setTimeout(r, 4000))
          waited += 4000
          status = await getRunStatus(runId)
        }
        try {
          const results = await getRunResults(runId)
          if (results && results.length) {
            // Group by asin since one run can cover multiple ASINs
            const byAsin = {}
            for (const row of results) {
              if (!byAsin[row.asin]) byAsin[row.asin] = []
              byAsin[row.asin].push(row)
            }
            for (const [asin, sellers] of Object.entries(byAsin)) {
              await upsertProductSellers(asin, sellers)
              // Save EG price history
              const buyBox = sellers.find(s => s.buy_box)
              const us = sellers.find(s => s.seller === OUR_SELLER_ID || s.seller_name === OUR_SELLER)
              const egPrice = buyBox?.price ? parseFloat(String(buyBox.price).replace(/,/g, '')) : null
              const ourPrice = us?.price ? parseFloat(String(us.price).replace(/,/g, '')) : null
              await savePriceHistory(asin, null, egPrice, buyBox?.seller_name || null, ourPrice, 'eg_update')

              // Delisted alert: was active/lost_buybox, now not in sellers
              const wasListed = products.find(p => p.asin === asin && (p.status === 'active' || p.status === 'lost_buybox'))
              if (wasListed && !us) {
                await savePriceAlert(asin, 'delisted', null, null)
              }
            }
          }
        } catch { /* skip batch */ }
        done += batch.length
      }
      await load()
      alert(`✅ تم تحديث بيانات البائعين لـ ${done} منتج`)
    } catch (err) {
      alert('❌ ' + err.message)
    } finally {
      setUpdatingSellers(false)
      setScrapeStatus('')
    }
  }

  const handleOpenSellersPage = async () => {
    setShowSellersPage(true)
    setSellersLoading(true)
    try {
      const data = await getAllSellers()
      setSellersData(data)
    } catch (err) {
      alert('خطأ في تحميل البائعين: ' + err.message)
    } finally {
      setSellersLoading(false)
    }
  }

  const handleToggleFriend = async (seller) => {
    if (seller.is_friend) {
      if (!window.confirm(`إزالة "${seller.seller_name}" من قائمة الأصدقاء؟`)) return
      await removeFriendSeller(seller.seller_id)
    } else {
      const note = window.prompt(`إضافة "${seller.seller_name}" كصديق.\n\nأي منتج بيبيعه هيتم رفضه تلقائياً.\n\nملاحظة (اختياري):`, '')
      if (note === null) return // canceled
      await addFriendSeller(seller.seller_id, seller.seller_name, note)
      // Reject existing products this friend sells
      const rejectedCount = await rejectProductsWithFriends()
      if (rejectedCount > 0) {
        alert(`تم رفض ${rejectedCount} منتج لأن "${seller.seller_name}" بيبيعه`)
        await load() // reload products
      }
    }
    // Refresh sellers list
    const fresh = await getAllSellers()
    setSellersData(fresh)
  }

  const handleViewSellerProducts = async (seller) => {
    const products = await getSellerProducts(seller.seller_id)
    setSellerProductsView({ seller, products })
  }

  const exportSellersCSV = () => {
    if (!sellersData) return
    const filtered = sellersData.filter(s => {
      if (sellersFilter === 'friends' && !s.is_friend) return false
      if (sellersFilter === 'non_friends' && s.is_friend) return false
      if (sellersSearch.trim()) {
        const q = sellersSearch.trim().toLowerCase()
        return (s.seller_name || '').toLowerCase().includes(q) || (s.seller_id || '').toLowerCase().includes(q)
      }
      return true
    })
    const rows = [
      ['Seller Name', 'Seller ID', 'Products Count', 'Buy Box Count', 'Friend', 'Last Seen']
    ]
    for (const s of filtered) {
      rows.push([
        s.seller_name || '',
        s.seller_id || '',
        s.product_count,
        s.buy_box_count,
        s.is_friend ? 'YES' : '',
        s.last_seen ? new Date(s.last_seen).toLocaleString('en') : '',
      ])
    }
    const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `sellers_${new Date().toISOString().slice(0,10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const exportSellerProductsCSV = () => {
    if (!sellerProductsView) return
    const { seller, products } = sellerProductsView
    const rows = [['ASIN', 'Title', 'Brand', 'Price AED', 'Price EGP (Seller)', 'Buy Box', 'Position', 'Our Price EGP', 'Status']]
    for (const r of products) {
      rows.push([
        r.asin,
        r.product?.title || '',
        r.product?.brand || '',
        r.product?.price_aed || '',
        r.price_egp || '',
        r.is_buy_box ? 'YES' : '',
        r.position || '',
        r.product?.our_price_egp || '',
        r.product?.status || '',
      ])
    }
    const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `seller_${seller.seller_id}_products.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleViewProduct = async (p) => {
    // Always use the latest data from products list (in case it was updated)
    const latest = products.find(x => x.asin === p.asin) || p
    setProductDetail(latest)
    setProductHistory(null)
    try {
      const history = await getPriceHistory(p.asin)
      setProductHistory(history)
    } catch {
      setProductHistory([])
    }
  }

  const handleViewSellers = async (asin) => {
    setSellersModalAsin(asin)
    setSellersModalData(null)
    try {
      const data = await getProductSellers(asin)
      setSellersModalData(data)
    } catch {
      setSellersModalData([])
    }
  }

  const [scrapingSingleAsin, setScrapingSingleAsin] = useState(false)
  const handleScrapeSingleAsinEG = async (asin) => {
    setScrapingSingleAsin(true)
    try {
      const runId = await runScrapeSellers([asin])
      if (!runId) {
        alert('فشل بدء السكراب')
        return
      }
      // Poll until done (max 2 min)
      let status = 'RUNNING'
      let waited = 0
      while (status === 'RUNNING' && waited < 120000) {
        await new Promise(r => setTimeout(r, 3000))
        waited += 3000
        const progRes = await fetch(`/api/scrape-progress?runId=${runId}`)
        const progData = await progRes.json()
        status = progData.status
      }
      if (status !== 'SUCCEEDED') {
        alert('السكراب فشل أو خد وقت طويل')
        return
      }
      const results = await getRunResults(runId)
      const sellers = (results || []).filter(r => r.asin === asin)
      if (!sellers.length) {
        alert('السكراب اشتغل بس ما رجعش بائعين — يعني المنتج ده فعلاً مفيش حد بيبيعه في مصر')
        // Still mark scraped: store empty seller state
        await upsertProductSellers(asin, [])
      } else {
        await upsertProductSellers(asin, sellers)
      }
      // Refresh modal data + product list
      const fresh = await getProductSellers(asin)
      setSellersModalData(fresh)
      await load()
    } catch (err) {
      alert('خطأ: ' + err.message)
    } finally {
      setScrapingSingleAsin(false)
    }
  }

  const handleAIShippingBulk = async () => {
    const missing = products.filter(p => p.status === 'missing')
    if (!missing.length) return
    if (!window.confirm(`هتحسب الشحن بالـ AI لـ ${missing.length} منتج؟`)) return
    setAiShipping(true)
    try {
      let done = 0, success = 0
      const failed = []
      const BATCH = 3
      const processOne = async (p) => {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const est = await estimateWeight(p.title, p.asin)
            if (est.success && est.weight_kg) {
              const calc = calculateShipping(est.weight_kg, est.length_cm, est.width_cm, est.height_cm)
              const dims = `${est.length_cm}×${est.width_cm}×${est.height_cm}`
              const statusLabel = est.status === 'CONFIRMED' ? 'CONFIRMED' : `ESTIMATED (${est.confidence || 0}%)`
              await Promise.all([
                saveAIShipping(p.asin, calc.shipping_fee, est.weight_kg, dims, statusLabel, calc.suspicious),
                saveAIShippingToReference(p.asin, calc.shipping_fee, est.weight_kg, dims, statusLabel, calc.suspicious),
              ])
              return true
            }
          } catch { /* retry */ }
          if (attempt === 0) await new Promise(r => setTimeout(r, 1500))
        }
        return false
      }
      for (let i = 0; i < missing.length; i += BATCH) {
        const batch = missing.slice(i, i + BATCH)
        setAiProgress(`${Math.min(i + BATCH, missing.length)}/${missing.length}`)
        const results = await Promise.all(batch.map(processOne))
        results.forEach((ok, idx) => {
          if (ok) success++; else failed.push(batch[idx].asin)
          done++
        })
      }
      await load()
      alert(`✅ تم حساب الشحن لـ ${success} من ${missing.length} منتج${failed.length ? `\nفشل ${failed.length} منتج — جرب تاني` : ''}`)
    } finally {
      setAiShipping(false)
      setAiProgress('')
    }
  }

  const handleFillTemplate = async (file) => {
    try {
      const eligibleProds = products.filter(p => ['ready', 'active', 'awaiting'].includes(p.status))
      const { blob, filledAsins, notInCatalog } = await fillAmazonTemplate(file, eligibleProds)

      if (notInCatalog?.length) await markNotInCatalog(notInCatalog)

      // Only mark products that were actually filled in the template
      const toMark = filledAsins.filter(asin => {
        const p = products.find(x => x.asin === asin)
        return p?.status === 'ready'
      })
      if (toMark.length) await markAwaitingListing(toMark)

      await load()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `amazon_template_filled_${new Date().toISOString().slice(0,10)}.xlsm`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      alert('❌ خطأ في ملء التمبلت: ' + err.message)
    }
  }

  const parseDeliveryDays = (deliveries) => {
    if (!deliveries || !deliveries.length) return null
    // Prefer 'fastest', then 'FREE', then first
    const d = deliveries.find(x => x.type === 'fastest') ||
              deliveries.find(x => x.type === 'FREE') ||
              deliveries[0]
    if (!d || !d.date) return null
    const dateStr = d.date
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    // Handle "Today", "Tomorrow"
    if (dateStr.toLowerCase().includes('today')) return 0
    if (dateStr.toLowerCase().includes('tomorrow')) return 1
    // Handle "Saturday, 20 June" or "20 - 23 June" or "Monday, 22 June"
    const months = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11,
      january:0, february:1, march:2, april:3, june:5, july:6, august:7, september:8, october:9, november:10, december:11 }
    const match = dateStr.match(/(\d{1,2})\s*(?:-\s*\d{1,2})?\s+([A-Za-z]+)/)
    if (match) {
      const day = parseInt(match[1])
      const month = months[match[2].toLowerCase()]
      if (month !== undefined) {
        const year = today.getFullYear()
        const target = new Date(year, month, day)
        if (target < today) target.setFullYear(year + 1)
        const diff = Math.round((target - today) / 86400000)
        return diff >= 0 ? diff : null
      }
    }
    return null
  }

  const handleUpdateAE = async (specificAsins = null) => {
    setUpdatingAE(true)
    try {
      const allAsins = specificAsins && specificAsins.length
        ? specificAsins
        : products.filter(p => p.status !== 'rejected').map(p => p.asin)
      if (!allAsins.length) { setUpdatingAE(false); return }

      const prevPrices = Object.fromEntries(products.map(p => [p.asin, p.price_aed]))
      const prevDeliveryDays = Object.fromEntries(products.map(p => [p.asin, p.delivery_days_ae]))
      const BATCH = 30
      let allResults = []

      for (let i = 0; i < allAsins.length; i += BATCH) {
        const batch = allAsins.slice(i, i + BATCH)
        setScrapeStatus(`تحديث ${Math.min(i + BATCH, allAsins.length)}/${allAsins.length}`)

        const runId = await runScrapeSellers(batch, 'www.amazon.ae')
        if (!runId) continue

        let status = 'RUNNING'
        let waited = 0
        while (status === 'RUNNING' && waited < 240000) {
          await new Promise(r => setTimeout(r, 4000))
          waited += 4000
          status = await getRunStatus(runId)
          setScrapeStatus(`تحديث ${Math.min(i + BATCH, allAsins.length)}/${allAsins.length} (${Math.floor(waited/1000)}ث)`)
        }
        // Accept partial results even on timeout
        try {
          const results = await getRunResults(runId)
          if (results && results.length) allResults = allResults.concat(results)
        } catch { /* skip */ }
      }

      // Process results — group by asin, pick Buy Box row for price
      const byAsin = {}
      for (const row of allResults) {
        if (!byAsin[row.asin]) byAsin[row.asin] = []
        byAsin[row.asin].push(row)
      }

      let alertCount = 0
      const updatedAsins = []
      // Track alerts for detailed Telegram message
      const alertsData = {
        price_up: [],
        price_down: [],
        unavailable_ae: [],
        delivery_change: [],
        delisted: [],
      }

      const saveTasks = []
      for (const [asin, sellers] of Object.entries(byAsin)) {
        const buyBoxRow = sellers.find(s => s.buy_box) || sellers[0]
        const priceStr = buyBoxRow?.price?.toString().replace(/,/g, '')
        const newPrice = priceStr ? parseFloat(priceStr) : null
        const deliveryDays = parseDeliveryDays(buyBoxRow?.deliveries)
        const deliveryDate = buyBoxRow?.deliveries?.[0]?.date || null
        const available = !!buyBoxRow

        // Collect update data
        updatedAsins.push({
          asin,
          price_aed: newPrice,
          availability: available,
          delivery_days_ae: deliveryDays,
          delivery_date_ae: deliveryDate,
          last_scraped_ae: new Date().toISOString(),
        })

        // Queue price history (parallel)
        saveTasks.push(savePriceHistory(asin, newPrice, null, buyBoxRow?.seller_name || null, null, 'ae_update'))

        // Queue price alerts (parallel)
        const prev = prevPrices[asin]
        const prevDays = prevDeliveryDays[asin]
        if (!available) {
          saveTasks.push(savePriceAlert(asin, 'unavailable_ae', prev, null))
          alertsData.unavailable_ae.push({ asin, old: prev, new: null })
          alertCount++
        } else if (newPrice && prev && newPrice > prev) {
          saveTasks.push(savePriceAlert(asin, 'price_up', prev, newPrice))
          alertsData.price_up.push({ asin, old: prev, new: newPrice })
          alertCount++
        } else if (newPrice && prev && newPrice < prev) {
          saveTasks.push(savePriceAlert(asin, 'price_down', prev, newPrice))
          alertsData.price_down.push({ asin, old: prev, new: newPrice })
          alertCount++
        }

        // Delivery change alert (more than 2 days difference)
        if (deliveryDays != null && prevDays != null && Math.abs(deliveryDays - prevDays) > 2) {
          saveTasks.push(savePriceAlert(asin, 'delivery_change', prevDays, deliveryDays))
          alertsData.delivery_change.push({ asin, old: prevDays, new: deliveryDays })
          alertCount++
        }
      }
      // Save prices to DB FIRST — most important
      setScrapeStatus(`جاري حفظ الأسعار...`)
      await updateAEPricesWithDelivery(updatedAsins)

      // Then save history + alerts (parallel, errors don't block)
      setScrapeStatus(`جاري حفظ التنبيهات...`)
      await Promise.all(saveTasks)

      // Check for delisted products (only among products we requested update for)
      const requestedSet = new Set(allAsins)
      const prevListedAsins = products
        .filter(p => requestedSet.has(p.asin) && (p.status === 'active' || p.status === 'lost_buybox'))
        .map(p => p.asin)
      const returnedAsins = new Set(Object.keys(byAsin))
      const delistedTasks = []
      for (const asin of prevListedAsins) {
        if (!returnedAsins.has(asin)) {
          delistedTasks.push(savePriceAlert(asin, 'delisted', null, null))
          alertsData.delisted.push({ asin })
          alertCount++
        }
      }
      if (delistedTasks.length) await Promise.all(delistedTasks)

      if (alertCount > 0) {
        let msg = `🔔 تحديث أسعار AE\n━━━━━━━━━━━━━━━\n✅ تم تحديث ${updatedAsins.length} منتج\n\n`

        if (alertsData.price_up.length) {
          msg += `📈 سعر AE ارتفع (${alertsData.price_up.length}):\n`
          for (const a of alertsData.price_up.slice(0, 10)) {
            const pct = (((a.new - a.old) / a.old) * 100).toFixed(1)
            msg += `• ${a.asin}: ${a.old} ← ${a.new} AED (+${pct}%)\n`
          }
          if (alertsData.price_up.length > 10) msg += `  ...+${alertsData.price_up.length - 10} أكتر\n`
          msg += `\n`
        }

        if (alertsData.price_down.length) {
          msg += `📉 سعر AE نزل (${alertsData.price_down.length}):\n`
          for (const a of alertsData.price_down.slice(0, 10)) {
            const pct = (((a.new - a.old) / a.old) * 100).toFixed(1)
            msg += `• ${a.asin}: ${a.old} ← ${a.new} AED (${pct}%)\n`
          }
          if (alertsData.price_down.length > 10) msg += `  ...+${alertsData.price_down.length - 10} أكتر\n`
          msg += `\n`
        }

        if (alertsData.unavailable_ae.length) {
          msg += `🔴 مش موجود في الإمارات (${alertsData.unavailable_ae.length}):\n`
          for (const a of alertsData.unavailable_ae.slice(0, 15)) {
            msg += `• ${a.asin}\n`
          }
          if (alertsData.unavailable_ae.length > 15) msg += `  ...+${alertsData.unavailable_ae.length - 15} أكتر\n`
          msg += `\n`
        }

        if (alertsData.delivery_change.length) {
          msg += `🚚 فترة التوصيل اتغيرت (${alertsData.delivery_change.length}):\n`
          for (const a of alertsData.delivery_change.slice(0, 10)) {
            const diff = a.new - a.old
            const sign = diff > 0 ? '+' : ''
            msg += `• ${a.asin}: ${a.old}يوم ← ${a.new}يوم (${sign}${diff})\n`
          }
          if (alertsData.delivery_change.length > 10) msg += `  ...+${alertsData.delivery_change.length - 10} أكتر\n`
          msg += `\n`
        }

        if (alertsData.delisted.length) {
          msg += `🟠 مبقاش معروض في مصر (${alertsData.delisted.length}):\n`
          for (const a of alertsData.delisted.slice(0, 15)) {
            msg += `• ${a.asin}\n`
          }
          if (alertsData.delisted.length > 15) msg += `  ...+${alertsData.delisted.length - 15} أكتر\n`
        }

        await sendTelegram(msg)
      }

      await load()
      setScrapeStatus('')
      alert(`✅ تم تحديث ${updatedAsins.length} منتج${alertCount ? ` — ${alertCount} تنبيه` : ''}`)
    } catch (err) {
      alert('❌ ' + err.message)
    } finally {
      setUpdatingAE(false)
      setScrapeStatus('')
    }
  }

  const handleCheckCatalog = async () => {
    const awaitingAsins = selected.size > 0
      ? [...selected]
      : filtered('awaiting').map(p => p.asin)
    if (!awaitingAsins.length) return
    setCheckingCatalog(true)
    try {
      const BATCH = 20
      let notInCat = []
      let backInCat = []
      for (let i = 0; i < awaitingAsins.length; i += BATCH) {
        const batch = awaitingAsins.slice(i, i + BATCH)
        setScrapeStatus(`فحص الكاتالوج ${Math.min(i + BATCH, awaitingAsins.length)}/${awaitingAsins.length}`)
        const catalogMap = await checkCatalog(batch)
        for (const a of batch) {
          const inCat = catalogMap[a]
          const p = products.find(x => x.asin === a)
          if (inCat === false) notInCat.push(a)
          else if (inCat === true && p?.not_in_catalog) backInCat.push(a)
        }
      }
      const msg = []
      if (notInCat.length) {
        await markNotInCatalog(notInCat)
        // Save alerts for products that became unavailable in catalog
        await Promise.all(notInCat.map(asin => savePriceAlert(asin, 'removed_from_catalog', null, null)))
        msg.push(`${notInCat.length} منتج اتنقل لمرفوضة`)
      }
      if (backInCat.length) { await unmarkNotInCatalog(backInCat); msg.push(`${backInCat.length} منتج رجع للكاتالوج`) }
      await load()
      alert(msg.length ? `✅ ${msg.join(' · ')}` : '✅ كل المنتجات في الكاتالوج')
    } catch (err) {
      alert('❌ ' + err.message)
    } finally {
      setCheckingCatalog(false)
      setScrapeStatus('')
    }
  }

  const handleRefreshEG = async () => {
    setRefreshingEG(true)
    try {
      // Check the OLDEST 100 products in the CURRENT tab
      const allAsins = filtered(tab).slice(-100).map(p => p.asin)
      if (!allAsins.length) { setRefreshingEG(false); return }

      const BATCH = 30
      let allResults = []

      for (let i = 0; i < allAsins.length; i += BATCH) {
        const batch = allAsins.slice(i, i + BATCH)
        setScrapeStatus(`تحقق ${Math.min(i + BATCH, allAsins.length)}/${allAsins.length}`)
        const runId = await runScrapeSellers(batch)
        let status = 'RUNNING'
        let waited = 0
        while (status === 'RUNNING' && waited < 180000) {
          await new Promise(r => setTimeout(r, 4000))
          waited += 4000
          status = await getRunStatus(runId)
        }
        // Collect results even if not fully SUCCEEDED (partial is fine)
        try {
          const results = await getRunResults(runId)
          if (results && results.length) allResults = allResults.concat(results)
        } catch { /* skip batch */ }
      }

      if (allResults.length) {
        const byAsin = {}
        for (const row of allResults) {
          if (!byAsin[row.asin]) byAsin[row.asin] = []
          byAsin[row.asin].push(row)
        }
        for (const [asin, sellers] of Object.entries(byAsin)) {
          await upsertProductSellers(asin, sellers)
        }
        const ourListings = Object.entries(byAsin)
          .filter(([, sellers]) => sellers.some(s => s.seller === OUR_SELLER_ID || s.seller_name === OUR_SELLER))
          .map(([asin]) => asin)
        if (ourListings.length) await unmarkAwaitingListing(ourListings)

        // Check catalog for ASINs that got 0 results from seller actor
        const noResults = allAsins.filter(a => !byAsin[a])
        if (noResults.length) {
          setScrapeStatus(`فحص الكاتالوج لـ ${noResults.length} منتج...`)
          const catalogMap = await checkCatalog(noResults)
          const notInCat = noResults.filter(a => catalogMap[a] === false)
          if (notInCat.length) await markNotInCatalog(notInCat)
        }
        await load()
      } else {
        // All returned 0 results — check catalog for awaiting products
        if (tab === 'awaiting') {
          setScrapeStatus(`فحص الكاتالوج لـ ${allAsins.length} منتج...`)
          const catalogMap = await checkCatalog(allAsins)
          const notInCat = allAsins.filter(a => catalogMap[a] === false)
          if (notInCat.length) {
            await markNotInCatalog(notInCat)
            await load()
          }
        }
      }
    } finally {
      setRefreshingEG(false)
      setScrapeStatus('')
    }
  }

  const filtered = (s) => {
    let list = s === 'all' ? products :
      s === 'alerts' ? (
        alertFilter === 'all' ? alerts : alerts.filter(a => a.alert_type === alertFilter)
      ) :
      products.filter(p => p.status === s)
    if (brandFilter && s !== 'alerts') {
      list = list.filter(p => p.brand?.toLowerCase() === brandFilter.toLowerCase())
    }
    if (searchQuery.trim() && s !== 'alerts') {
      const q = searchQuery.trim().toLowerCase()
      list = list.filter(p =>
        p.asin?.toLowerCase().includes(q) ||
        p.title?.toLowerCase().includes(q) ||
        p.brand?.toLowerCase().includes(q)
      )
    }
    // Sort
    if (sortBy !== 'default' && !s.startsWith('alerts')) {
      const sorted = [...list]
      const num = (v) => v == null ? -Infinity : Number(v)
      const numAsc = (v) => v == null ? Infinity : Number(v)
      switch (sortBy) {
        case 'price_aed_desc': sorted.sort((a,b) => num(b.price_aed) - num(a.price_aed)); break
        case 'price_aed_asc': sorted.sort((a,b) => numAsc(a.price_aed) - numAsc(b.price_aed)); break
        case 'price_egp_desc': sorted.sort((a,b) => num(b.price_egp) - num(a.price_egp)); break
        case 'price_egp_asc': sorted.sort((a,b) => numAsc(a.price_egp) - numAsc(b.price_egp)); break
        case 'shipping_desc': sorted.sort((a,b) => num(b.shipping_egp) - num(a.shipping_egp)); break
        case 'shipping_asc': sorted.sort((a,b) => numAsc(a.shipping_egp) - numAsc(b.shipping_egp)); break
        case 'delivery_asc': sorted.sort((a,b) => numAsc(a.delivery_days_ae) - numAsc(b.delivery_days_ae)); break
        case 'delivery_desc': sorted.sort((a,b) => num(b.delivery_days_ae) - num(a.delivery_days_ae)); break
        case 'newest': sorted.sort((a,b) => new Date(b.last_scraped_ae || 0) - new Date(a.last_scraped_ae || 0)); break
        case 'oldest': sorted.sort((a,b) => new Date(a.last_scraped_ae || 0) - new Date(b.last_scraped_ae || 0)); break
        case 'gap_desc': sorted.sort((a,b) => num(b.buy_box_gap) - num(a.buy_box_gap)); break
        case 'gap_asc': sorted.sort((a,b) => numAsc(a.buy_box_gap) - numAsc(b.buy_box_gap)); break
        case 'title': sorted.sort((a,b) => (a.title || '').localeCompare(b.title || '')); break
        case 'brand': sorted.sort((a,b) => (a.brand || '').localeCompare(b.brand || '')); break
      }
      return sorted
    }
    return list
  }
  const counts = {
    all: products.length,
    missing: products.filter(p => p.status === 'missing').length,
    suspicious: products.filter(p => p.status === 'suspicious').length,
    ready: products.filter(p => p.status === 'ready').length,
    awaiting: products.filter(p => p.status === 'awaiting').length,
    active: products.filter(p => p.status === 'active').length,
    lost_buybox: products.filter(p => p.status === 'lost_buybox').length,
    burnt: products.filter(p => p.status === 'burnt').length,
    rejected: products.filter(p => p.status === 'rejected').length,
    alerts: alerts.length,
  }
  const fmt = (n) => n != null ? Number(n).toLocaleString('en') : '—'

  const rate = parseFloat(settings.exchange_rate || 14.8)
  const fullList = filtered(tab)
  const totalPages = Math.ceil(fullList.length / pageSize)
  const currentList = fullList.slice((page - 1) * pageSize, page * pageSize)
  const allSelected = currentList.length > 0 && currentList.every(p => selected.has(p.asin))

  return (
    <div className="app">
      {notifications.map((n, i) => (
        <div key={i} className={`notif notif-${n.type}`}>
          {n.type === 'burnt' ? '🔥 محروق:' : '✅ اشتغل:'} {n.title?.substring(0, 45)}...
          <button onClick={() => setNotifications(ns => ns.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}

      <div className="header">
        <h1>Amazon Pricing</h1>
        <div className="header-actions">
          <button
            className="theme-toggle"
            onClick={() => setTheme(t => t === 'light' ? 'dark' : 'light')}
            title={theme === 'light' ? 'تبديل للنايت مود' : 'تبديل للايت مود'}
          >
            {theme === 'light' ? '🌙' : '☀️'}
          </button>
          <button
            className="btn-sellers-page"
            onClick={handleOpenSellersPage}
            title="إدارة البائعين"
          >
            👥 البائعين
          </button>
          <button onClick={handleUpdateAE} disabled={updatingAE} className="btn-update-ae">
            {updatingAE ? '⏳ جاري التحديث...' : '↻ تحديث أسعار AE'}
          </button>
          <div className="rate-control">
          <span>سعر الصرف</span>
          <input type="number" value={exRate} onChange={e => setExRate(e.target.value)} step="0.01" />
          <span>EGP/AED</span>
          <button onClick={handleUpdateRate} disabled={updatingRate}>
            {updatingRate ? '...' : '↻ تحديث'}
          </button>
        </div>
        </div>
      </div>

      <div className="scrape-bar">
        <input
          className="url-input"
          value={scrapeUrl}
          onChange={e => setScrapeUrl(e.target.value)}
          placeholder="https://www.amazon.ae/s?k=... أو ASIN مثل B0XXXXXX"
          disabled={scraping}
          onKeyDown={e => e.key === 'Enter' && startScrape()}
        />
        <button onClick={() => startScrape()} disabled={scraping || !scrapeUrl.trim()} className="btn-primary">
          {scraping ? '⏳ جاري...' : '▶ سكراب'}
        </button>
        <label className={`btn-upload ${scraping ? 'disabled' : ''}`} title="ارفع ملف Excel فيه ASINs (عمود واحد) لسكرابهم كلهم">
          📂 Excel ASINs
          <input
            type="file"
            accept=".xlsx,.xls,.csv"
            style={{ display: 'none' }}
            disabled={scraping}
            onChange={e => {
              if (e.target.files[0]) {
                handleBulkAsinsUpload(e.target.files[0])
                e.target.value = ''
              }
            }}
          />
        </label>
        {scrapeStatus && <span className="scrape-msg">{scrapeStatus}</span>}
      </div>
      {scraping && (
        <div className="modal-overlay">
          <div className="modal-box">
            <div className="modal-title">جاري السكراب...</div>
            <div className="modal-items">{progressItems} منتج</div>
            <div className="modal-progress-wrap">
              <div className="modal-progress-bar" style={{width: `${progress}%`}}></div>
            </div>
            <div className="modal-pct">{progress}%</div>
            <div className="modal-status">{scrapeStatus}</div>
          </div>
        </div>
      )}

      <div className="stats-row">
        {(() => {
          const listed = products.filter(p => p.status === 'active' || p.status === 'lost_buybox')
          const holding = listed.filter(p => p.status === 'active')
          const pct = listed.length ? Math.round(holding.length / listed.length * 100) : 0
          const alertCount = alerts.length
          return (
            <>
              <div className="stat stat-total" onClick={() => { setTab('all'); setPage(1) }} style={{cursor:'pointer'}}>
                <div className="stat-val">{products.length}</div>
                <div className="stat-lbl">إجمالي المنتجات</div>
              </div>
              <div className="stat stat-active" onClick={() => { setTab('active'); setPage(1) }} style={{cursor:'pointer'}}>
                <div className="stat-val">{counts.active}</div>
                <div className="stat-lbl">معروض حالياً</div>
              </div>
              {listed.length > 0 && (
                <div className="stat stat-buybox-ratio" onClick={() => { setTab('lost_buybox'); setPage(1) }} style={{cursor:'pointer'}}>
                  <div className="stat-val">{pct}%</div>
                  <div className="stat-lbl">نسبة الباي بوكس ({holding.length}/{listed.length})</div>
                </div>
              )}
              {alertCount > 0 && (
                <div className="stat stat-alerts" onClick={() => { setTab('alerts'); setPage(1) }} style={{cursor:'pointer'}}>
                  <div className="stat-val">{alertCount}</div>
                  <div className="stat-lbl">تنبيهات جديدة</div>
                </div>
              )}
            </>
          )
        })()}
      </div>

      <div className="tabs">
        {Object.entries(STATUS).map(([k, label]) => (
          <button key={k} className={`tab ${tab===k?'active':''} ${k==='burnt'?'tab-red':''}`} onClick={() => { setTab(k); setPage(1) }}>
            {label} <span className={`bdg ${k==='burnt'?'bdg-red':''}`}>{counts[k]}</span>
          </button>
        ))}
      </div>

      <div className="search-bar">
        <input
          type="text"
          placeholder="بحث بالاسم أو ASIN..."
          value={searchQuery}
          onChange={e => { setSearchQuery(e.target.value); setPage(1) }}
          className="search-input"
        />
        {searchQuery && <button onClick={() => setSearchQuery('')} className="search-clear">✕</button>}

        <div className="brand-filter" style={{position:'relative'}}>
          <button
            className={`brand-filter-btn ${brandFilter ? 'active' : ''}`}
            onClick={() => setShowBrandDropdown(v => !v)}
          >
            {brandFilter || 'البراند'} ▾
          </button>
          {showBrandDropdown && (() => {
            const brands = [...new Set(products.map(p => p.brand).filter(Boolean))].sort()
            const filtered_brands = brandSearch
              ? brands.filter(b => b.toLowerCase().includes(brandSearch.toLowerCase()))
              : brands
            return (
              <div className="brand-dropdown" onClick={e => e.stopPropagation()}>
                <input
                  autoFocus
                  type="text"
                  placeholder="ابحث عن براند..."
                  value={brandSearch}
                  onChange={e => setBrandSearch(e.target.value)}
                  className="brand-search-input"
                />
                <div className="brand-list">
                  <div
                    className={`brand-item ${!brandFilter ? 'selected' : ''}`}
                    onClick={() => { setBrandFilter(''); setBrandSearch(''); setShowBrandDropdown(false); setPage(1) }}
                  >
                    كل البراندات
                  </div>
                  {filtered_brands.map(b => (
                    <div
                      key={b}
                      className={`brand-item ${brandFilter === b ? 'selected' : ''}`}
                      onClick={() => { setBrandFilter(b); setBrandSearch(''); setShowBrandDropdown(false); setPage(1) }}
                    >
                      {b}
                    </div>
                  ))}
                </div>
              </div>
            )
          })()}
        </div>
        {brandFilter && (
          <button onClick={() => { setBrandFilter(''); setPage(1) }} className="search-clear" style={{marginRight:4}}>
            ✕ {brandFilter}
          </button>
        )}
        <select
          value={sortBy}
          onChange={e => { setSortBy(e.target.value); setPage(1) }}
          className="sort-select"
        >
          <option value="default">↕ ترتيب افتراضي</option>
          <option value="newest">🆕 الأحدث تحديثاً</option>
          <option value="oldest">🕐 الأقدم تحديثاً</option>
          <option value="price_aed_desc">💰 السعر AE (الأعلى)</option>
          <option value="price_aed_asc">💰 السعر AE (الأقل)</option>
          <option value="price_egp_desc">💸 السعر EG (الأعلى)</option>
          <option value="price_egp_asc">💸 السعر EG (الأقل)</option>
          <option value="shipping_desc">📦 الشحن (الأعلى)</option>
          <option value="shipping_asc">📦 الشحن (الأقل)</option>
          <option value="delivery_asc">⚡ التوصيل (الأسرع)</option>
          <option value="delivery_desc">🐌 التوصيل (الأبطأ)</option>
          <option value="gap_desc">📊 فرق الباي بوكس (الأكبر)</option>
          <option value="gap_asc">📊 فرق الباي بوكس (الأصغر)</option>
          <option value="title">🔤 الاسم</option>
          <option value="brand">🏷️ البراند</option>
        </select>
      </div>

      <div className="tab-toolbar">
        {(tab === 'active' || tab === 'all' || tab === 'lost_buybox') && (
          <>
            <button
              onClick={() => handleUpdateSellers(filtered(tab).map(p => p.asin))}
              disabled={updatingSellers}
              className="btn-sellers"
            >
              {updatingSellers ? `⏳ ${scrapeStatus || '...'}` : '👥 تحديث بيانات البائعين (الكل)'}
            </button>
            {selected.size > 0 && (
              <button
                onClick={() => handleUpdateSellers([...selected])}
                disabled={updatingSellers}
                className="btn-sellers"
              >
                👥 تحديث المحدد ({selected.size})
              </button>
            )}
            <button
              onClick={() => handleUpdateSellers(products.filter(p => p.is_our_listing).map(p => p.asin))}
              disabled={updatingSellers}
              className="btn-sellers"
            >
              👥 تحديث منتجات الباي بوكس بس
            </button>
          </>
        )}
        {(tab === 'ready' || tab === 'active' || tab === 'awaiting' || tab === 'lost_buybox') && (
          <button onClick={handleRefreshEG} disabled={refreshingEG}>
            {refreshingEG ? `⏳ ${scrapeStatus || 'جاري التحقق...'}` : `↻ تحقق من العرض${fullList.length > 100 ? ` (أقدم 100 من ${fullList.length})` : ''}`}
          </button>
        )}
        {tab === 'awaiting' && (
          <button onClick={handleCheckCatalog} disabled={checkingCatalog} className="btn-catalog-check">
            {checkingCatalog ? `⏳ ${scrapeStatus || 'جاري الفحص...'}` : `🔍 فحص الكاتالوج (${selected.size > 0 ? `${selected.size} محدد` : fullList.length})`}
          </button>
        )}
        {tab === 'ready' && (
          <label className="btn-upload">
            📂 رفع تمبلت أمازون
            <input type="file" accept=".xlsm,.xlsx" style={{display:'none'}} onChange={e => e.target.files[0] && handleFillTemplate(e.target.files[0])} />
          </label>
        )}
        {tab === 'awaiting' && (
          <div className="summary-upload">
            <label className="btn-upload">
              📋 رفع التمبلت الأصلي
              <input type="file" accept=".xlsm,.xlsx" style={{display:'none'}}
                onChange={e => { if(e.target.files[0]) setSummaryTemplate(e.target.files[0]) }} />
            </label>
            {summaryTemplate && <span style={{fontSize:12, color:'#059669'}}>✅ {summaryTemplate.name}</span>}
            <label className="btn-upload">
              📊 رفع Processing Summary
              <input type="file" accept=".xlsm,.xlsx" style={{display:'none'}}
                onChange={e => {
                  if (!e.target.files[0]) return
                  if (!summaryTemplate) {
                    alert('ارفع التمبلت الأصلي الأول من الزرار اللي على شماله')
                    return
                  }
                  handleProcessingSummary(e.target.files[0], summaryTemplate)
                }} />
            </label>
          </div>
        )}
        {tab === 'missing' && (
          <>
            <label className="btn-upload">
              📂 رفع Excel شحن
              <input type="file" accept=".xlsx,.xls" style={{display:'none'}} onChange={e => e.target.files[0] && handleExcelUpload(e.target.files[0])} />
            </label>
            <button onClick={handleAIShippingBulk} disabled={aiShipping} className="btn-ai">
              {aiShipping ? `🤖 جاري الحساب... ${aiProgress}` : '🤖 احسب الشحن بالـ AI'}
            </button>
          </>
        )}
      </div>

      <div className="tbl-wrap">
        {selected.size > 0 ? (
          <div className="action-bar">
            <span className="action-count">
              {[...selected].filter(a => fullList.some(p => p.asin === a)).length}/{selected.size} محدد
            </span>
            <button onClick={() => toggleSelectAll(currentList)}>
              {allSelected ? '☑ إلغاء تحديد الكل' : '☐ تحديد الكل'}
            </button>
            <button onClick={() => handleUpdateAE([...selected])} disabled={updatingAE} className="btn-update-ae">
              {updatingAE ? '⏳' : '↻ تحديث أسعار AE للمحدد'}
            </button>
            <button onClick={handleExportSelected}>⬇ Export محدد</button>
            <button onClick={handleDelete} className="btn-delete">🗑 مسح</button>
            <button onClick={() => setSelected(new Set())} className="btn-clear">✕ إلغاء</button>
          </div>
        ) : currentList.length > 0 && tab !== 'alerts' ? (
          <div className="action-bar action-bar-idle">
            <button onClick={() => toggleSelectAll(currentList)}>☐ تحديد الكل ({currentList.length})</button>
          </div>
        ) : null}
        {currentList.length === 0 ? (
          <div className="empty">
            {tab === 'all' && 'أضف URL عشان تبدأ'}
            {tab === 'missing' && '✅ مفيش منتجات ناقصها شحن'}
            {tab === 'ready' && 'مفيش منتجات جاهزة للرفع'}
            {tab === 'awaiting' && 'مفيش منتجات في انتظار العرض'}
            {tab === 'active' && 'مفيش منتجات اشتغلت لحد دلوقتي'}
            {tab === 'burnt' && '🎉 مفيش منتجات محروقة'}
            {tab === 'suspicious' && '✅ مفيش منتجات مشكوك في شحنها'}
            {tab === 'lost_buybox' && '🎉 إنت ماسك Buy Box في كل منتجاتك المعروضة'}
            {tab === 'rejected' && 'مفيش منتجات مرفوضة'}
            {tab === 'not_in_catalog' && 'مفيش منتجات خارج الكاتالوج'}
            {tab === 'alerts' && '✅ مفيش تنبيهات'}
          </div>
        ) : tab === 'alerts' ? (
          <div className="alerts-section">
            <div className="alerts-header">
              <div className="alerts-summary">
                <div className="alerts-count">{fullList.length}</div>
                <div className="alerts-label">
                  {alertFilter === 'all' && 'كل التنبيهات'}
                  {alertFilter === 'price_up' && '📈 سعر AE ارتفع'}
                  {alertFilter === 'price_down' && '📉 سعر AE نزل'}
                  {alertFilter === 'unavailable_ae' && '🔴 مش موجود في الإمارات'}
                  {alertFilter === 'delivery_change' && '🚚 تغير في فترة التوصيل'}
                  {alertFilter === 'delisted' && '🟠 مبقاش معروض في مصر'}
                </div>
              </div>
              <button className="btn-mark-all" onClick={async () => {
                if (!window.confirm(`علّم ${fullList.length} تنبيه كمشاهد؟`)) return
                await markAlertsSeen(fullList.map(a => a.id))
                const fresh = await getPriceAlerts()
                setAlerts(fresh)
              }}>
                ✓ علّم الكل كمشاهد
              </button>
            </div>

            {/* Alert sub-filter tabs */}
            <div className="alert-subtabs">
              {(() => {
                const counts = {
                  all: alerts.length,
                  // Critical
                  buy_box_lost: alerts.filter(a => a.alert_type === 'buy_box_lost').length,
                  price_drop_below_cost: alerts.filter(a => a.alert_type === 'price_drop_below_cost').length,
                  friend_competitor: alerts.filter(a => a.alert_type === 'friend_competitor').length,
                  delisted: alerts.filter(a => a.alert_type === 'delisted').length,
                  unavailable_ae: alerts.filter(a => a.alert_type === 'unavailable_ae').length,
                  // Important
                  buy_box_regained: alerts.filter(a => a.alert_type === 'buy_box_regained').length,
                  low_profit: alerts.filter(a => a.alert_type === 'low_profit').length,
                  back_in_stock: alerts.filter(a => a.alert_type === 'back_in_stock').length,
                  price_up: alerts.filter(a => a.alert_type === 'price_up').length,
                  price_down: alerts.filter(a => a.alert_type === 'price_down').length,
                  // Info
                  delivery_change: alerts.filter(a => a.alert_type === 'delivery_change').length,
                }
                const filters = [
                  { key: 'all', label: 'الكل', icon: '🔔' },
                  // Critical - red
                  { key: 'buy_box_lost', label: 'خسرت Buy Box', icon: '👑', priority: 'critical' },
                  { key: 'price_drop_below_cost', label: 'السوق نزل تحت التكلفة', icon: '💸', priority: 'critical' },
                  { key: 'friend_competitor', label: 'صديق دخل المنتج', icon: '⚠️', priority: 'critical' },
                  { key: 'delisted', label: 'مبقاش معروض في مصر', icon: '🟠', priority: 'critical' },
                  { key: 'unavailable_ae', label: 'مش موجود في الإمارات', icon: '🔴', priority: 'critical' },
                  // Important - yellow
                  { key: 'buy_box_regained', label: 'استرجعت Buy Box', icon: '🎉', priority: 'important' },
                  { key: 'low_profit', label: 'هامش ربح قليل', icon: '📉', priority: 'important' },
                  { key: 'back_in_stock', label: 'رجع موجود', icon: '✅', priority: 'important' },
                  { key: 'price_up', label: 'سعر AE ارتفع', icon: '📈', priority: 'important' },
                  { key: 'price_down', label: 'سعر AE نزل', icon: '📉', priority: 'important' },
                  // Info - blue
                  { key: 'delivery_change', label: 'تغير التوصيل', icon: '🚚', priority: 'info' },
                ]
                return filters
                  .filter(f => f.key === 'all' || counts[f.key] > 0)
                  .map(f => (
                  <button
                    key={f.key}
                    className={`alert-subtab ${alertFilter === f.key ? 'active' : ''} ${f.priority ? 'priority-' + f.priority : ''}`}
                    onClick={() => setAlertFilter(f.key)}
                  >
                    <span className="alert-subtab-icon">{f.icon}</span>
                    <span className="alert-subtab-label">{f.label}</span>
                    {counts[f.key] > 0 && (
                      <span className="alert-subtab-count">{counts[f.key]}</span>
                    )}
                  </button>
                ))
              })()}
            </div>

            <div className="alerts-list">
              {fullList.map(a => {
                const product = products.find(p => p.asin === a.asin)
                const typeMeta = {
                  // Critical
                  buy_box_lost: { icon: '👑', color: 'danger', label: 'خسرت الـ Buy Box', action: 'البائع التاني ماسك Buy Box دلوقتي' },
                  price_drop_below_cost: { icon: '💸', color: 'danger', label: 'السوق نزل تحت التكلفة', action: 'لو بعت بسعر السوق هتخسر' },
                  friend_competitor: { icon: '⚠️', color: 'danger', label: 'صديق دخل المنتج', action: 'المنتج اتم رفضه تلقائياً' },
                  delisted: { icon: '📤', color: 'danger', label: 'مبقاش معروض في مصر', action: 'إنت مش بائع للمنتج ده دلوقتي' },
                  unavailable_ae: { icon: '🔴', color: 'danger', label: 'مش موجود في الإمارات', action: 'Amazon UAE مبقاش بيبيعه' },
                  // Important
                  buy_box_regained: { icon: '🎉', color: 'success', label: 'استرجعت الـ Buy Box', action: 'إنت ماسك Buy Box تاني' },
                  low_profit: { icon: '📉', color: 'warning', label: 'هامش ربح قليل', action: 'السعر قرب من التكلفة' },
                  back_in_stock: { icon: '✅', color: 'success', label: 'المنتج رجع موجود', action: 'متاح في Amazon UAE تاني' },
                  price_up: { icon: '📈', color: 'warning', label: 'سعر AE ارتفع', action: 'راجع التسعير في مصر' },
                  price_down: { icon: '📉', color: 'info', label: 'سعر AE نزل', action: 'فرصة لزيادة هامش الربح' },
                  // Info
                  delivery_change: { icon: '🚚', color: 'info', label: 'فترة التوصيل اتغيرت', action: 'راجع وقت الشحن' },
                  // Legacy
                  unavailable: { icon: '⛔', color: 'danger', label: 'مش متاح', action: 'راجع المنتج' },
                  removed_from_catalog: { icon: '🗑️', color: 'danger', label: 'اتشال من الكاتالوج', action: 'مش موجود في مصر' },
                }
                const meta = typeMeta[a.alert_type] || { icon: '⚪', color: 'default', label: a.alert_type, action: '' }
                const pct = (a.old_value && a.new_value)
                  ? (((Number(a.new_value) - Number(a.old_value)) / Number(a.old_value)) * 100).toFixed(1)
                  : null

                return (
                  <div key={a.id} className={`alert-card alert-card-${meta.color}`}>
                    <div className="alert-card-left">
                      {product?.image && (
                        <img
                          src={product.image}
                          className="alert-card-img"
                          onClick={() => handleViewProduct(product)}
                          alt=""
                          onError={e => e.target.style.display='none'}
                        />
                      )}
                      <div className="alert-card-icon">{meta.icon}</div>
                    </div>

                    <div className="alert-card-body">
                      <div className="alert-card-header">
                        <span className={`alert-card-type alert-card-type-${meta.color}`}>{meta.label}</span>
                        <span className="alert-card-time">
                          {new Date(a.created_at).toLocaleString('ar-EG', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' })}
                        </span>
                      </div>

                      {product?.title && (
                        <div
                          className="alert-card-title"
                          onClick={() => product && handleViewProduct(product)}
                        >
                          {product.title.substring(0, 80)}{product.title.length > 80 ? '...' : ''}
                        </div>
                      )}

                      <div className="alert-card-meta">
                        <span className="alert-card-asin">{a.asin}</span>
                        {product?.brand && <span className="alert-card-brand">· {product.brand}</span>}
                      </div>

                      {(a.alert_type === 'price_up' || a.alert_type === 'price_down') && a.old_value && a.new_value && (
                        <div className="alert-card-change">
                          <div className="alert-price-row">
                            <span className="alert-price-old">{fmt(a.old_value)} AED</span>
                            <span className="alert-price-arrow">←</span>
                            <span className={`alert-price-new alert-price-new-${meta.color}`}>
                              {fmt(a.new_value)} AED
                            </span>
                            {pct && (
                              <span className={`alert-price-pct alert-price-pct-${meta.color}`}>
                                {pct > 0 ? '+' : ''}{pct}%
                              </span>
                            )}
                          </div>
                          <div className="alert-card-action">💡 {meta.action}</div>
                        </div>
                      )}

                      {a.alert_type === 'delivery_change' && a.old_value != null && a.new_value != null && (
                        <div className="alert-card-change">
                          <div className="alert-price-row">
                            <span className="alert-price-old">{a.old_value} يوم</span>
                            <span className="alert-price-arrow">←</span>
                            <span className={`alert-price-new alert-price-new-${meta.color}`}>
                              {a.new_value} يوم
                            </span>
                            {(() => {
                              const diff = Number(a.new_value) - Number(a.old_value)
                              return (
                                <span className={`alert-price-pct alert-price-pct-${meta.color}`}>
                                  {diff > 0 ? '+' : ''}{diff} يوم
                                </span>
                              )
                            })()}
                          </div>
                          <div className="alert-card-action">💡 {meta.action}</div>
                        </div>
                      )}

                      {!['price_up', 'price_down', 'delivery_change'].includes(a.alert_type) && (
                        <div className="alert-card-action">💡 {meta.action}</div>
                      )}
                    </div>

                    <div className="alert-card-actions">
                      {product && (
                        <button className="alert-btn alert-btn-view" onClick={() => handleViewProduct(product)} title="عرض التفاصيل">
                          👁
                        </button>
                      )}
                      <a
                        href={`https://www.amazon.ae/dp/${a.asin}`}
                        target="_blank"
                        rel="noreferrer"
                        className="alert-btn alert-btn-link"
                        title="افتح في الإمارات"
                      >
                        🇦🇪
                      </a>
                      <a
                        href={`https://www.amazon.eg/dp/${a.asin}`}
                        target="_blank"
                        rel="noreferrer"
                        className="alert-btn alert-btn-link"
                        title="افتح في مصر"
                      >
                        🇪🇬
                      </a>
                      <button className="alert-btn alert-btn-done" onClick={async () => {
                        await markAlertsSeen([a.id])
                        const fresh = await getPriceAlerts()
                        setAlerts(fresh)
                      }} title="علّم كمشاهد">
                        ✓
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th style={{width:36}}>
                  <input type="checkbox" checked={allSelected} onChange={() => toggleSelectAll(currentList)} />
                </th>
                <th style={{width:40}}></th>
                <th>المنتج</th>
                <th>AED</th>
                <th>توصيل</th>
                <th>تكلفة</th>
                {tab === 'missing' && <th>شحن EGP</th>}
                {tab !== 'missing' && <th>شحن</th>}
                {tab !== 'missing' && <th>أدنى</th>}
                {tab !== 'missing' && <th>أقصى</th>}
                {tab !== 'missing' && <th>سعر مصر</th>}
                {tab === 'suspicious' && <th>وزن/أبعاد</th>}
                {tab === 'suspicious' && <th>إجراء</th>}
                {tab === 'burnt' && <th>فرق</th>}
                {tab === 'lost_buybox' && <th>الفرق للباي بوكس</th>}
                {tab === 'all' && <th>حالة</th>}
                {(tab === 'rejected') && <th>السبب</th>}
              </tr>
            </thead>
            <tbody>
              {currentList.map(p => {
                const cost = p.price_aed ? Math.round(p.price_aed * rate + (p.shipping_egp || 0)) : null
                const diff = p.price_egp && p.min_price_egp ? Math.round(p.price_egp - p.min_price_egp) : null
                return (
                  <tr key={p.asin} className={`${p.status === 'burnt' ? 'tr-burnt' : ''} ${selected.has(p.asin) ? 'tr-selected' : ''}`}>
                    <td>
                      <input type="checkbox" checked={selected.has(p.asin)} onChange={() => toggleSelect(p.asin)} />
                    </td>
                    <td>
                      {p.image && <img src={p.image} className="thumb" alt="" onError={e => e.target.style.display='none'} onClick={() => handleViewProduct(p)} style={{cursor:'pointer'}} />}
                    </td>
                    <td className="td-title">
                      <a onClick={() => handleViewProduct(p)} style={{cursor:'pointer', color:'inherit', textDecoration:'none', fontWeight:500}}>{p.title?.substring(0,55)}...</a>
                      <div className="td-links">
                        <span className="asin">{p.asin}</span>
                        <a href={p.ae_url || `https://www.amazon.ae/dp/${p.asin}`} target="_blank" rel="noreferrer" className="link-ae">🇦🇪 AE</a>
                        <a href={`https://www.amazon.eg/dp/${p.asin}`} target="_blank" rel="noreferrer" className="link-eg">🇪🇬 EG</a>
                        <button className="link-edit" onClick={() => setEditProduct({asin: p.asin, title: p.title, price_aed: p.price_aed, shipping_egp: p.shipping_egp})}>✏️</button>
                        <button className="sellers-btn" onClick={() => handleViewSellers(p.asin)} title="بيانات البائعين">
                          👥 {p.total_sellers || '—'}
                        </button>
                      </div>
                    </td>
                    <td>{fmt(p.price_aed)}</td>
                    <td className="td-delivery">
                      {p.delivery_days_ae == null ? (
                        <span style={{color:'var(--text-faint)'}}>—</span>
                      ) : (
                        <span className={`delivery-badge delivery-${
                          p.delivery_days_ae <= 1 ? 'fast' :
                          p.delivery_days_ae <= 3 ? 'medium' : 'slow'
                        }`}>
                          {p.delivery_days_ae === 0 ? 'اليوم' :
                           p.delivery_days_ae === 1 ? 'بكرا' :
                           `${p.delivery_days_ae} يوم`}
                        </span>
                      )}
                    </td>
                    <td>{cost ? fmt(cost) : '—'}</td>
                    {tab === 'missing' ? (
                      <td>
                        <input
                          type="number"
                          className="ship-in"
                          placeholder="ادخل الشحن"
                          onBlur={e => handleSaveShipping(p.asin, e.target.value)}
                          onKeyDown={e => e.key === 'Enter' && handleSaveShipping(p.asin, e.target.value)}
                        />
                      </td>
                    ) : (
                      <td>
                        {fmt(p.shipping_egp)}
                        {p.shipping_source === 'ai' && (
                          <span className="ai-badge" title={`${p.ai_status || ''} — ${p.ai_weight}kg ${p.ai_dimensions || ''}`}>🤖</span>
                        )}
                      </td>
                    )}
                    {tab !== 'missing' && <td className="td-green">{fmt(p.min_price_egp)}</td>}
                    {tab !== 'missing' && <td>{fmt(p.max_price_egp)}</td>}
                    {tab !== 'missing' && (
                      <td>
                        {p.price_egp ? fmt(p.price_egp) : '—'}
                        {p.is_our_listing && <span className="our-tag" title="إنت معروض">🏷️</span>}
                      </td>
                    )}
                    {tab === 'suspicious' && (
                      <td style={{fontSize:11, color:'var(--text-soft)'}}>
                        {p.ai_weight ? `${p.ai_weight}kg` : '—'}
                        {p.ai_dimensions ? ` · ${p.ai_dimensions}` : ''}
                      </td>
                    )}
                    {tab === 'suspicious' && (
                      <td>
                        <button className="btn-sm btn-confirm" onClick={async () => {
                          await confirmSuspiciousShipping(p.asin); await load()
                        }}>✅ تأكيد</button>
                        <button className="btn-sm btn-delete" style={{marginRight:4}} onClick={async () => {
                          await rejectSuspiciousShipping(p.asin); await load()
                        }}>🗑 رفض</button>
                      </td>
                    )}
                    {tab === 'burnt' && (
                      <td className="td-red">{diff ? fmt(diff) : '—'} {p.price_diff_pct ? `(${p.price_diff_pct}%)` : ''}</td>
                    )}
                    {tab === 'lost_buybox' && <td className="td-red">{fmt(p.buy_box_gap)} <span style={{fontSize:11, color:'#888'}}>({p.our_position}/{p.total_sellers})</span></td>}
                    {(tab === 'rejected') && (
                      <td style={{fontSize:12, color:'#dc2626', maxWidth:200}}>
                        {p.rejection_reason || '—'}
                      </td>
                    )}
                    {tab === 'all' && (
                      <td>
                        <span className={`status-badge status-${p.status}`}>
                          {p.status === 'missing' ? 'ناقص شحن' :
                           p.status === 'suspicious' ? 'مشكوك' :
                           p.status === 'ready' ? 'جاهز' :
                           p.status === 'awaiting' ? 'انتظار' :
                           p.status === 'active' ? 'اشتغل' :
                           p.status === 'lost_buybox' ? 'خسران BB' :
                           p.status === 'burnt' ? 'محروق' :
                           p.status === 'rejected' ? 'مرفوض' :
                           p.status || '—'}
                        </span>
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
        {totalPages > 1 && (
          <div className="pagination">
            <button onClick={() => setPage(1)} disabled={page === 1}>«</button>
            <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1}>‹</button>
            <span>{page} / {totalPages} ({fullList.length} منتج)</span>
            <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages}>›</button>
            <button onClick={() => setPage(totalPages)} disabled={page === totalPages}>»</button>
            <select value={pageSize} onChange={e => { setPageSize(Number(e.target.value)); setPage(1) }}>
              {[25, 50, 100, 200].map(n => <option key={n} value={n}>{n} / صفحة</option>)}
            </select>
          </div>
        )}
      </div>

      {editProduct && (
        <div className="modal-overlay" onClick={() => setEditProduct(null)}>
          <div className="modal-box" onClick={e => e.stopPropagation()}>
            <div className="modal-title">تعديل المنتج</div>
            <div style={{fontSize:12, color:'#aaa', marginBottom:'1rem'}}>{editProduct.title?.substring(0,50)}...</div>
            <div className="edit-field">
              <label>سعر AED</label>
              <input
                type="number"
                value={editProduct.price_aed || ''}
                onChange={e => setEditProduct(p => ({...p, price_aed: e.target.value}))}
                step="0.01"
              />
            </div>
            <div className="edit-field">
              <label>شحن EGP</label>
              <input
                type="number"
                value={editProduct.shipping_egp || ''}
                onChange={e => setEditProduct(p => ({...p, shipping_egp: e.target.value}))}
              />
            </div>
            <div style={{display:'flex', gap:8, marginTop:'1rem'}}>
              <button onClick={handleSaveEdit} style={{flex:1, padding:'8px', background:'#1a1a1a', color:'white', border:'none', borderRadius:8, cursor:'pointer'}}>حفظ</button>
              <button onClick={() => setEditProduct(null)} style={{flex:1, padding:'8px', border:'1px solid #ddd', borderRadius:8, cursor:'pointer', background:'white'}}>إلغاء</button>
            </div>
          </div>
        </div>
      )}

      {/* SELLERS PAGE MODAL */}
      {showSellersPage && (
        <div className="modal-overlay" onClick={() => setShowSellersPage(false)}>
          <div className="sellers-page-modal" onClick={e => e.stopPropagation()}>
            <div className="sellers-page-header">
              <div>
                <div className="sellers-page-title">👥 إدارة البائعين</div>
                <div className="sellers-page-subtitle">
                  {sellersData ? `${sellersData.length} بائع منافس` : 'جاري التحميل...'}
                  {sellersData && ` • ${sellersData.filter(s => s.is_friend).length} صديق`}
                </div>
              </div>
              <button className="pd-close" onClick={() => setShowSellersPage(false)}>✕</button>
            </div>

            <div className="sellers-page-toolbar">
              <input
                type="text"
                className="search-input"
                placeholder="ابحث عن بائع..."
                value={sellersSearch}
                onChange={e => setSellersSearch(e.target.value)}
                style={{ flex: 1 }}
              />
              <select
                className="sort-select"
                value={sellersFilter}
                onChange={e => setSellersFilter(e.target.value)}
                style={{ minWidth: 160 }}
              >
                <option value="all">الكل</option>
                <option value="friends">⭐ الأصدقاء فقط</option>
                <option value="non_friends">المنافسين فقط</option>
              </select>
              <button className="btn-upload" onClick={exportSellersCSV} disabled={!sellersData}>
                ⬇ Export CSV
              </button>
            </div>

            <div className="sellers-page-body">
              {sellersLoading && <div className="sellers-loading">جاري التحميل...</div>}
              {!sellersLoading && sellersData && (() => {
                const filtered = sellersData.filter(s => {
                  if (sellersFilter === 'friends' && !s.is_friend) return false
                  if (sellersFilter === 'non_friends' && s.is_friend) return false
                  if (sellersSearch.trim()) {
                    const q = sellersSearch.trim().toLowerCase()
                    return (s.seller_name || '').toLowerCase().includes(q) || (s.seller_id || '').toLowerCase().includes(q)
                  }
                  return true
                })
                if (!filtered.length) return <div className="sellers-loading">مفيش بائعين</div>
                return (
                  <div className="sellers-table-wrap">
                    <table className="sellers-page-table">
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>اسم البائع</th>
                          <th>المنتجات</th>
                          <th>Buy Box</th>
                          <th>آخر ظهور</th>
                          <th>إجراءات</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filtered.map((s, i) => (
                          <tr key={s.seller_id} className={s.is_friend ? 'seller-row-friend' : ''}>
                            <td>{i + 1}</td>
                            <td>
                              <div className="seller-name-cell">
                                {s.is_friend && <span className="friend-star" title="صديق">⭐</span>}
                                {s.seller_name}
                              </div>
                              <div className="seller-id-cell">{s.seller_id}</div>
                            </td>
                            <td>
                              <span className="seller-count-badge">{s.product_count}</span>
                            </td>
                            <td>
                              {s.buy_box_count > 0 ? (
                                <span className="seller-count-badge seller-count-bb">👑 {s.buy_box_count}</span>
                              ) : '—'}
                            </td>
                            <td style={{ fontSize: 11, color: 'var(--text-soft)' }}>
                              {s.last_seen ? new Date(s.last_seen).toLocaleDateString('en') : '—'}
                            </td>
                            <td>
                              <button
                                className="btn-sm"
                                onClick={() => handleViewSellerProducts(s)}
                                title="اعرض منتجاته"
                              >
                                👁 منتجات
                              </button>
                              <button
                                className={`btn-sm ${s.is_friend ? 'btn-friend-active' : 'btn-friend-add'}`}
                                onClick={() => handleToggleFriend(s)}
                                style={{ marginRight: 4 }}
                                title={s.is_friend ? 'إزالة من الأصدقاء' : 'إضافة كصديق (المنتجات بتاعته تتحط مرفوضة)'}
                              >
                                {s.is_friend ? '⭐ صديق' : '+ صديق'}
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )
              })()}
            </div>
          </div>
        </div>
      )}

      {/* SELLER PRODUCTS VIEW */}
      {sellerProductsView && (
        <div className="modal-overlay" onClick={() => setSellerProductsView(null)}>
          <div className="sellers-page-modal" onClick={e => e.stopPropagation()}>
            <div className="sellers-page-header">
              <div>
                <div className="sellers-page-title">
                  {sellerProductsView.seller.is_friend && '⭐ '}
                  منتجات {sellerProductsView.seller.seller_name}
                </div>
                <div className="sellers-page-subtitle">
                  {sellerProductsView.products.length} منتج مشترك
                </div>
              </div>
              <button className="pd-close" onClick={() => setSellerProductsView(null)}>✕</button>
            </div>
            <div className="sellers-page-toolbar">
              <div style={{ flex: 1, fontSize: 13, color: 'var(--text-soft)' }}>
                ID: <code>{sellerProductsView.seller.seller_id}</code>
              </div>
              <button className="btn-upload" onClick={exportSellerProductsCSV}>
                ⬇ Export CSV
              </button>
            </div>
            <div className="sellers-page-body">
              <div className="sellers-table-wrap">
                <table className="sellers-page-table">
                  <thead>
                    <tr>
                      <th>المنتج</th>
                      <th>سعر AED</th>
                      <th>سعره EGP</th>
                      <th>سعرك EGP</th>
                      <th>Buy Box</th>
                      <th>الحالة</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sellerProductsView.products.map((r) => (
                      <tr key={r.asin}>
                        <td style={{ maxWidth: 280 }}>
                          <a
                            onClick={() => { setSellerProductsView(null); handleViewProduct(r.product) }}
                            style={{ cursor: 'pointer', color: 'inherit', textDecoration: 'none', fontWeight: 500 }}
                          >
                            {r.product?.title?.substring(0, 60)}...
                          </a>
                          <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 2 }}>{r.asin}</div>
                        </td>
                        <td>{fmt(r.product?.price_aed)}</td>
                        <td>{fmt(r.price_egp)}</td>
                        <td>{fmt(r.product?.our_price_egp)}</td>
                        <td>{r.is_buy_box ? '👑' : '—'}</td>
                        <td>
                          <span className={`status-badge status-${r.product?.status}`}>
                            {r.product?.status === 'active' ? 'اشتغل' :
                             r.product?.status === 'lost_buybox' ? 'خسران BB' :
                             r.product?.status === 'rejected' ? 'مرفوض' :
                             r.product?.status || '—'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}

      {sellersModalAsin && (
        <div className="modal-overlay" onClick={() => setSellersModalAsin(null)}>
          <div className="sellers-modal" onClick={e => e.stopPropagation()}>
            <div className="sellers-modal-header">
              <div>
                <div className="sellers-modal-title">البائعين المنافسين</div>
                <div className="sellers-modal-asin">{sellersModalAsin}</div>
              </div>
              <button className="pd-close" onClick={() => setSellersModalAsin(null)}>✕</button>
            </div>
            {sellersModalData === null ? (
              <div className="sellers-loading">جاري التحميل...</div>
            ) : sellersModalData.length === 0 ? (
              <div className="sellers-empty-state">
                <div style={{ fontSize: 14, marginBottom: 16, color: 'var(--text-soft)' }}>
                  مفيش بيانات بائعين محفوظة للمنتج ده
                </div>
                <button
                  className="btn-primary"
                  onClick={() => handleScrapeSingleAsinEG(sellersModalAsin)}
                  disabled={scrapingSingleAsin}
                >
                  {scrapingSingleAsin ? '⏳ جاري السكراب...' : '🔄 سكراب EG لهذا المنتج'}
                </button>
                <div style={{ fontSize: 11, marginTop: 12, color: 'var(--text-faint)' }}>
                  بياخد ~1 دقيقة
                </div>
              </div>
            ) : (
              <>
                <div className="sellers-total">
                  إجمالي البائعين: <strong>{sellersModalData[0]?.asin_total_sellers || sellersModalData.length}</strong>
                </div>
                <div className="sellers-table-wrap">
                  <table className="sellers-table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>البائع</th>
                        <th>السعر</th>
                        <th>التقييم</th>
                        <th>التوصيل</th>
                        <th>Buy Box</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sellersModalData.map(s => (
                        <tr key={s.id} className={s.is_us ? 'seller-us' : ''}>
                          <td>{s.position}</td>
                          <td>
                            {s.seller_name}
                            {s.is_us && <span className="seller-us-badge">إنت</span>}
                          </td>
                          <td className="seller-price">{fmt(s.price_egp)} EGP</td>
                          <td className="seller-rating">{s.rating_text || '—'} {s.rating_count ? `(${s.rating_count})` : ''}</td>
                          <td className="seller-delivery">{s.delivery_date || '—'}</td>
                          <td>{s.is_buy_box ? '👑' : ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {productDetail && (
        <div className="modal-overlay" onClick={() => setProductDetail(null)}>
          <div className="product-detail-modal" onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div className="pd-header">
              {productDetail.image && (
                <img src={productDetail.image} className="pd-image" alt="" />
              )}
              <div className="pd-header-info">
                <div className="pd-title">{productDetail.title}</div>
                <div className="pd-meta">
                  <span className="pd-asin">{productDetail.asin}</span>
                  {productDetail.brand && <span className="pd-brand">{productDetail.brand}</span>}
                  <span className={`pd-status pd-status-${productDetail.status}`}>
                    {STATUS[productDetail.status] || productDetail.status}
                  </span>
                </div>
                <div className="pd-links">
                  <a href={productDetail.ae_url || `https://www.amazon.ae/dp/${productDetail.asin}`} target="_blank" rel="noreferrer" className="pd-link pd-link-ae">🇦🇪 افتح في الإمارات</a>
                  <a href={`https://www.amazon.eg/dp/${productDetail.asin}`} target="_blank" rel="noreferrer" className="pd-link pd-link-eg">🇪🇬 افتح في مصر</a>
                </div>
              </div>
              <button className="pd-close" onClick={() => setProductDetail(null)}>✕</button>
            </div>

            {/* Stats Grid */}
            <div className="pd-stats-grid">
              <div className="pd-stat pd-stat-primary">
                <div className="pd-stat-lbl">سعر AE الحالي</div>
                <div className="pd-stat-val">{fmt(productDetail.price_aed)} <span className="pd-stat-unit">AED</span></div>
              </div>
              <div className="pd-stat">
                <div className="pd-stat-lbl">سعر EG (Buy Box)</div>
                <div className="pd-stat-val">{productDetail.price_egp ? fmt(productDetail.price_egp) : '—'} <span className="pd-stat-unit">EGP</span></div>
              </div>
              <div className="pd-stat">
                <div className="pd-stat-lbl">سعرك في EG</div>
                <div className="pd-stat-val">{productDetail.our_price_egp ? fmt(productDetail.our_price_egp) : '—'} <span className="pd-stat-unit">EGP</span></div>
              </div>
              <div className="pd-stat">
                <div className="pd-stat-lbl">التكلفة</div>
                <div className="pd-stat-val">{productDetail.cost_egp ? fmt(productDetail.cost_egp) : (productDetail.price_aed ? fmt(productDetail.price_aed * rate + (productDetail.shipping_egp||0)) : '—')} <span className="pd-stat-unit">EGP</span></div>
              </div>
              <div className="pd-stat">
                <div className="pd-stat-lbl">أدنى سعر</div>
                <div className="pd-stat-val pd-stat-good">{fmt(productDetail.min_price_egp)} <span className="pd-stat-unit">EGP</span></div>
              </div>
              <div className="pd-stat">
                <div className="pd-stat-lbl">أقصى سعر</div>
                <div className="pd-stat-val pd-stat-good">{fmt(productDetail.max_price_egp)} <span className="pd-stat-unit">EGP</span></div>
              </div>
              <div className="pd-stat">
                <div className="pd-stat-lbl">الشحن</div>
                <div className="pd-stat-val">{fmt(productDetail.shipping_egp)} <span className="pd-stat-unit">EGP</span></div>
              </div>
              <div className="pd-stat">
                <div className="pd-stat-lbl">توصيل AE</div>
                <div className="pd-stat-val">{productDetail.delivery_days_ae != null ? `${productDetail.delivery_days_ae}` : '—'} <span className="pd-stat-unit">يوم</span></div>
              </div>
              <div className="pd-stat">
                <div className="pd-stat-lbl">بائعين EG</div>
                <div className="pd-stat-val">{productDetail.total_sellers || '—'}</div>
              </div>
            </div>

            {/* Chart */}
            <div className="pd-section">
              <div className="pd-section-title">📈 تطور الأسعار</div>
              {productHistory === null ? (
                <div className="pd-loading">جاري التحميل...</div>
              ) : productHistory.length < 2 ? (
                <div className="pd-empty">{productHistory.length === 0 ? 'مفيش تاريخ — هيتسجل مع كل تحديث' : 'محتاج تحديثين على الأقل للرسم'}</div>
              ) : (
                <ChartWithHover productHistory={productHistory} rate={rate} fmt={fmt} filter={chartFilter} setFilter={setChartFilter} />
              )}
            </div>

            {/* History Table */}
            {productHistory && productHistory.length > 0 && (
              <div className="pd-section">
                <div className="pd-section-title">📋 سجل التحديثات</div>
                <div className="pd-history-table-wrap">
                  <table className="pd-history-table">
                    <thead>
                      <tr>
                        <th>التاريخ</th>
                        <th>الوقت</th>
                        <th>المصدر</th>
                        <th>سعر AE</th>
                        <th>سعر EG</th>
                        <th>Buy Box</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...productHistory]
                        .filter(h => {
                          if (chartFilter === 'ae') return h.source === 'ae_update'
                          if (chartFilter === 'eg') return h.source === 'eg_update'
                          return true
                        })
                        .reverse().slice(0, 20).map(h => {
                        const d = new Date(h.recorded_at)
                        return (
                          <tr key={h.id}>
                            <td>{d.toLocaleDateString('ar-EG')}</td>
                            <td style={{fontVariantNumeric:'tabular-nums'}}>{d.toLocaleTimeString('ar-EG', {hour:'2-digit', minute:'2-digit'})}</td>
                            <td>
                              <span className={`pd-source pd-source-${h.source}`}>
                                {h.source === 'ae_update' ? '🇦🇪 AE' : h.source === 'eg_update' ? '🇪🇬 EG' : '—'}
                              </span>
                            </td>
                            <td>{h.price_aed ? `${fmt(h.price_aed)} AED` : '—'}</td>
                            <td>{h.price_egp ? `${fmt(h.price_egp)} EGP` : '—'}</td>
                            <td style={{fontSize:11}}>{h.buy_box_seller || '—'}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
