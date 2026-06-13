import { useState, useEffect, useCallback } from 'react'
import { getProducts, getSettings, updateExchangeRate, saveShipping, saveShippingBulk, createJob, updateJob, upsertProductsAE, upsertProductsEG } from './lib/products'
import { runScrapeAE, runScrapeEG, getRunStatus, getRunResults } from './lib/apify'
import { parseShippingExcel, exportAmazonTemplate, exportAsins } from './lib/excel'
import './App.css'

const STATUS = {
  all: 'كل المنتجات',
  missing: 'ناقص شحن',
  ready: 'جاهز للرفع',
  active: 'اشتغلت',
  burnt: 'محروقة',
}
const OUR_SELLER = 'BestQualityBestPrice'

export default function App() {
  const [products, setProducts] = useState([])
  const [settings, setSettings] = useState({ exchange_rate: '14.80' })
  const [tab, setTab] = useState('all')
  const [scrapeUrl, setScrapeUrl] = useState('')
  const [scraping, setScraping] = useState(false)
  const [scrapeStatus, setScrapeStatus] = useState('')
  const [exRate, setExRate] = useState('14.80')
  const [updatingRate, setUpdatingRate] = useState(false)
  const [refreshingEG, setRefreshingEG] = useState(false)
  const [notifications, setNotifications] = useState([])

  const load = useCallback(async () => {
    const [prods, sett] = await Promise.all([getProducts(), getSettings()])
    setProducts(prods || [])
    setSettings(sett || {})
    setExRate(sett?.exchange_rate || '14.80')
  }, [])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    const interval = setInterval(async () => {
      if (products.length) {
        const fresh = await getProducts()
        const newNotifs = []
        for (const p of fresh) {
          const old = products.find(x => x.asin === p.asin)
          if (old && old.status !== p.status) {
            if (p.status === 'burnt' && old.status === 'ready')
              newNotifs.push({ asin: p.asin, title: p.title, type: 'burnt' })
            if (p.status === 'active')
              newNotifs.push({ asin: p.asin, title: p.title, type: 'active' })
          }
        }
        if (newNotifs.length) setNotifications(n => [...n, ...newNotifs])
        setProducts(fresh)
      }
    }, 60000)
    return () => clearInterval(interval)
  }, [products])

  const startScrape = async () => {
    if (!scrapeUrl.trim()) return
    setScraping(true)
    setScrapeStatus('جاري إنشاء الـ job...')
    try {
      const job = await createJob(scrapeUrl)
      const runId = await runScrapeAE(scrapeUrl, 5)
      setScrapeStatus('جاري السكراب...')
      let status = 'RUNNING'
      while (status === 'RUNNING') {
        await new Promise(r => setTimeout(r, 4000))
        status = await getRunStatus(runId)
      }
      if (status !== 'SUCCEEDED') throw new Error('فشل السكراب')
      const results = await getRunResults(runId)
      const count = await upsertProductsAE(results, job.id)
      await updateJob(job.id, { status: 'done', total_products: count, completed_at: new Date().toISOString() })
      setScrapeStatus('جاري جلب بيانات مصر...')
      const asins = results.filter(p => p.availability && p.asin).map(p => p.asin)
      if (asins.length) {
        const egRunId = await runScrapeEG(asins)
        let egStatus = 'RUNNING'
        while (egStatus === 'RUNNING') {
          await new Promise(r => setTimeout(r, 4000))
          egStatus = await getRunStatus(egRunId)
        }
        if (egStatus === 'SUCCEEDED') {
          const egResults = await getRunResults(egRunId)
          await upsertProductsEG(egResults)
        }
      }
      setScrapeStatus('✅ تم بنجاح!')
      setScrapeUrl('')
      await load()
    } catch (err) {
      setScrapeStatus('❌ ' + err.message)
    } finally {
      setScraping(false)
      setTimeout(() => setScrapeStatus(''), 5000)
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
      await saveShippingBulk(rows)
      await load()
      alert(`✅ تم تحديث الشحن لـ ${rows.length} منتج`)
    } catch (err) {
      alert('❌ خطأ: ' + err.message)
    }
  }

  const handleRefreshEG = async () => {
    setRefreshingEG(true)
    try {
      const asins = products.filter(p => p.status === 'ready' || p.status === 'active').map(p => p.asin)
      if (!asins.length) return
      const runId = await runScrapeEG(asins)
      let status = 'RUNNING'
      while (status === 'RUNNING') {
        await new Promise(r => setTimeout(r, 4000))
        status = await getRunStatus(runId)
      }
      if (status === 'SUCCEEDED') {
        const results = await getRunResults(runId)
        await upsertProductsEG(results)
        await load()
      }
    } finally {
      setRefreshingEG(false)
    }
  }

  const filtered = (s) => s === 'all' ? products : products.filter(p => p.status === s)
  const counts = Object.fromEntries(Object.keys(STATUS).map(k => [k, filtered(k).length]))
  const fmt = (n) => n != null ? Number(n).toLocaleString('en') : '—'
  const rate = parseFloat(settings.exchange_rate || 14.8)

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
        <div className="rate-control">
          <span>سعر الصرف</span>
          <input type="number" value={exRate} onChange={e => setExRate(e.target.value)} step="0.01" />
          <span>EGP/AED</span>
          <button onClick={handleUpdateRate} disabled={updatingRate}>
            {updatingRate ? '...' : '↻ تحديث'}
          </button>
        </div>
      </div>

      <div className="scrape-bar">
        <input
          className="url-input"
          value={scrapeUrl}
          onChange={e => setScrapeUrl(e.target.value)}
          placeholder="https://www.amazon.ae/s?k=..."
          disabled={scraping}
          onKeyDown={e => e.key === 'Enter' && startScrape()}
        />
        <button onClick={startScrape} disabled={scraping || !scrapeUrl.trim()} className="btn-primary">
          {scraping ? '⏳ جاري...' : '▶ سكراب'}
        </button>
        <label className="btn-upload">
          📂 Excel شحن
          <input type="file" accept=".xlsx,.xls" style={{display:'none'}} onChange={e => e.target.files[0] && handleExcelUpload(e.target.files[0])} />
        </label>
        {scrapeStatus && <span className="scrape-msg">{scrapeStatus}</span>}
      </div>

      <div className="stats-row">
        {Object.entries(STATUS).map(([k, label]) => (
          <div key={k} className={`stat stat-${k}`} onClick={() => setTab(k)} style={{cursor:'pointer'}}>
            <div className="stat-val">{counts[k]}</div>
            <div className="stat-lbl">{label}</div>
          </div>
        ))}
      </div>

      <div className="tabs">
        {Object.entries(STATUS).map(([k, label]) => (
          <button key={k} className={`tab ${tab===k?'active':''} ${k==='burnt'?'tab-red':''}`} onClick={() => setTab(k)}>
            {label} <span className={`bdg ${k==='burnt'?'bdg-red':''}`}>{counts[k]}</span>
          </button>
        ))}
      </div>

      <div className="tab-toolbar">
        {(tab === 'ready' || tab === 'active') && (
          <button onClick={handleRefreshEG} disabled={refreshingEG}>
            {refreshingEG ? '⏳ جاري التحقق...' : '↻ تحقق من العرض'}
          </button>
        )}
        {tab === 'ready' && (
          <>
            <button onClick={() => exportAmazonTemplate(filtered('ready'))}>⬇ تمبلت أمازون</button>
            <button onClick={() => exportAsins(filtered('ready'))}>⬇ ASINs فقط</button>
          </>
        )}
        {tab === 'missing' && (
          <label className="btn-upload">
            📂 رفع Excel شحن
            <input type="file" accept=".xlsx,.xls" style={{display:'none'}} onChange={e => e.target.files[0] && handleExcelUpload(e.target.files[0])} />
          </label>
        )}
      </div>

      <div className="tbl-wrap">
        {filtered(tab).length === 0 ? (
          <div className="empty">
            {tab === 'all' && 'أضف URL عشان تبدأ'}
            {tab === 'missing' && '✅ مفيش منتجات ناقصها شحن'}
            {tab === 'ready' && 'مفيش منتجات جاهزة للرفع'}
            {tab === 'active' && 'مفيش منتجات اشتغلت لحد دلوقتي'}
            {tab === 'burnt' && '🎉 مفيش منتجات محروقة'}
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th style={{width:40}}></th>
                <th>المنتج</th>
                <th>AED</th>
                <th>تكلفة</th>
                {tab === 'missing' && <th>شحن EGP</th>}
                {tab !== 'missing' && <th>شحن</th>}
                {tab !== 'missing' && <th>أدنى</th>}
                {tab !== 'missing' && <th>أقصى</th>}
                {tab !== 'missing' && <th>مصر</th>}
                {tab !== 'missing' && <th>Buy Box</th>}
                {tab === 'burnt' && <th>فرق</th>}
                {tab === 'active' && <th>حالة</th>}
                {tab === 'all' && <th>حالة</th>}
              </tr>
            </thead>
            <tbody>
              {filtered(tab).map(p => {
                const cost = p.price_aed ? Math.round(p.price_aed * rate) : null
                const diff = p.price_egp && p.min_price_egp ? Math.round(p.price_egp - p.min_price_egp) : null
                return (
                  <tr key={p.asin} className={p.status === 'burnt' ? 'tr-burnt' : ''}>
                    <td>
                      {p.image && <img src={p.image} className="thumb" alt="" onError={e => e.target.style.display='none'} />}
                    </td>
                    <td className="td-title">
                      <a href={p.ae_url} target="_blank" rel="noreferrer">{p.title?.substring(0,55)}...</a>
                      <span className="asin">{p.asin}</span>
                    </td>
                    <td>{fmt(p.price_aed)}</td>
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
                      <td>{fmt(p.shipping_egp)}</td>
                    )}
                    {tab !== 'missing' && <td className="td-green">{fmt(p.min_price_egp)}</td>}
                    {tab !== 'missing' && <td>{fmt(p.max_price_egp)}</td>}
                    {tab !== 'missing' && <td>{fmt(p.price_egp)}</td>}
                    {tab !== 'missing' && (
                      <td>
                        <span className={p.buy_box_seller === OUR_SELLER ? 'our-seller' : ''}>
                          {p.buy_box_seller || '—'}
                        </span>
                      </td>
                    )}
                    {tab === 'burnt' && (
                      <td className="td-red">{diff ? fmt(diff) : '—'} {p.price_diff_pct ? `(${p.price_diff_pct}%)` : ''}</td>
                    )}
                    {tab === 'active' && <td><span className="badge-active">معروض ✅</span></td>}
                    {tab === 'all' && (
                      <td>
                        <span className={`status-badge status-${p.status}`}>
                          {p.status === 'missing' ? 'ناقص شحن' : p.status === 'ready' ? 'جاهز' : p.status === 'active' ? 'اشتغل' : 'محروق'}
                        </span>
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
