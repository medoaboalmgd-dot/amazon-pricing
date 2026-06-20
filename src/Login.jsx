import { useState } from 'react'

export default function Login({ onLogin }) {
  const [pass, setPass] = useState('')
  const [error, setError] = useState(false)

  const handleSubmit = () => {
    if (pass === '135') {
      localStorage.setItem('auth', '135')
      onLogin()
    } else {
      setError(true)
      setTimeout(() => setError(false), 2000)
    }
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      minHeight: '100vh', background: '#f8f8f7'
    }}>
      <div style={{
        background: 'white', borderRadius: 14, padding: '2rem',
        border: '1px solid #eee', width: 300, textAlign: 'center'
      }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: '1.5rem' }}>Amazon Pricing</h2>
        <input
          type="password"
          placeholder="كلمة المرور"
          value={pass}
          onChange={e => setPass(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSubmit()}
          style={{
            width: '100%', padding: '10px 12px', border: `1px solid ${error ? '#fca5a5' : '#ddd'}`,
            borderRadius: 8, fontSize: 14, textAlign: 'center', direction: 'ltr',
            outline: 'none', marginBottom: '1rem'
          }}
          autoFocus
        />
        {error && <div style={{ color: '#dc2626', fontSize: 13, marginBottom: '0.75rem' }}>كلمة المرور غلط</div>}
        <button
          onClick={handleSubmit}
          style={{
            width: '100%', padding: '10px', background: '#1a1a1a', color: 'white',
            border: 'none', borderRadius: 8, fontSize: 14, cursor: 'pointer'
          }}
        >دخول</button>
      </div>
    </div>
  )
}
