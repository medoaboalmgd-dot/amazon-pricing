import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import Login from './Login.jsx'

function Root() {
  const [auth, setAuth] = useState(localStorage.getItem('auth') === '135')
  if (!auth) return <Login onLogin={() => setAuth(true)} />
  return <App />
}

createRoot(document.getElementById('root')).render(
  <StrictMode><Root /></StrictMode>
)
