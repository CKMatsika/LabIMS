import { useCallback, useEffect, useMemo, useState, type Dispatch, type FormEvent, type ReactNode, type SetStateAction } from 'react'

type Role = 'Lab Technician' | 'Lab Supervisor' | 'Station Chemist' | 'Plant Management'
type Status = 'Received' | 'In Progress' | 'Approved' | 'Rejected'
type Page = 'Overview' | 'Sample Registry' | 'Test Methods' | 'Instrument Interface' | 'Compliance' | 'Reports' | 'User Management'
type User = { id: number; fullName: string; email: string; role: Role }
type Parameter = {
  id: number
  name: string
  unit: string
  lower_limit?: number | null
  upper_limit?: number | null
  lowerLimit?: number | null
  upperLimit?: number | null
  decimal_places?: number
  decimalPlaces?: number
  formula?: string | null
  variable_name?: string
  numeric_value?: number | null
  calculated?: boolean
  withinLimits?: boolean
}
type Method = {
  id: number
  name: string
  module: string
  standard: string
  description: string
  parameters: Parameter[]
}
type Sample = {
  id: number
  sample_code: string
  location: string
  material: string
  status: Status
  collected_at: string
  due_at: string | null
  chemist: string
  method_name: string
  module: string
  result_count: number
  parameter_count: number
}
type SampleDetail = {
  sample: Sample & { method_id: number; standard: string; notes: string }
  parameters: Parameter[]
  events: { action: string; created_at: string; actor: string | null; details: Record<string, unknown> }[]
  signatures: { action: string; meaning: string; reason: string; signed_at: string; signer: string }[]
}
type Dashboard = {
  compliance: number
  activeSamples: number
  coaIssued: number
  rejectedSamples: number
  totalSamples: number
  instrumentUptime: number | null
  instrumentsConnected: number
  instrumentsTotal: number
  trend: { label: string; compliance: number }[]
}
type Connector = { connector_type: string; endpoint: string; tag_mapping: Record<string, string>; enabled: boolean; updated_at: string }
type Instrument = { id: number; name: string; module: string; protocol: string; endpoint: string; status: string; last_reading: string | null }
type InstrumentReading = { id: number; tag: string; value: number; unit: string; quality: string; observed_at: string; instrument_name: string | null; sample_code: string | null; recorded_by: string | null }
type TrendPoint = { tested_at: string; numeric_value: number; calculated: boolean; sample_code: string; location: string; parameter: string; unit: string; lower_limit: number | null; upper_limit: number | null }
type ComplianceData = {
  audit: { id: number; action: string; entity_type: string; entity_id: string; details: Record<string, unknown>; created_at: string; actor: string | null }[]
  exceptions: { sample_code: string; location: string; method_name: string; parameter: string; numeric_value: number; unit: string; lower_limit: number | null; upper_limit: number | null; tested_at: string }[]
  signatures: { sample_id: number; sample_code: string; action: string; meaning: string; reason: string; signed_at: string; signer: string }[]
}
type ComplianceReadiness = {
  status: 'Ready' | 'At Risk' | 'Blocked'
  checks: { id: string; label: string; ok: boolean; value: string }[]
  checklist: { id: string; requirement: string; status: 'pass' | 'warning' | 'fail'; detail: string }[]
}

const navigation: Page[] = ['Overview', 'Sample Registry', 'Test Methods', 'Instrument Interface', 'Compliance', 'Reports', 'User Management']
const modules = ['Water Chemistry', 'Coal / Combustion', 'Oil & Fuel', 'Gas Analysis', 'Reporting & Dashboards', 'ERP / DCS Integration']
const sampleTemplates = [
  { id: 'boiler-feedwater', label: 'Boiler Feedwater Routine', methodName: 'Boiler Feedwater', location: 'Unit 2 Boiler Feedwater', material: 'Boiler Feedwater', chemist: 'N. Moyo', notes: 'Routine chemistry check for boiler feedwater. Monitor conductivity, silica and dissolved oxygen.' },
  { id: 'coal-intake', label: 'Coal Intake Check', methodName: 'Coal Proximate Analysis', location: 'Coal Yard Intake', material: 'Coal', chemist: 'T. Ncube', notes: 'Incoming coal quality verification. Check moisture, ash and volatile matter.' },
  { id: 'transformer-oil', label: 'Transformer Oil DGA', methodName: 'Transformer Oil DGA', location: 'Transformer Bay 3', material: 'Transformer Oil', chemist: 'S. Chuma', notes: 'Dissolved gas analysis for transformer oil integrity monitoring.' },
  { id: 'hydrogen-purity', label: 'Hydrogen Purity Check', methodName: 'Hydrogen Purity', location: 'Hydrogen Plant', material: 'Hydrogen', chemist: 'R. Banda', notes: 'Gas purity and dew-point verification for the hydrogen plant.' }
] as const
const statusTone: Record<Status, string> = {
  Received: 'received',
  'In Progress': 'progress',
  Approved: 'approved',
  Rejected: 'rejected'
}

async function api<T>(url: string, options: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem('labims-token')
  const headers = new Headers(options.headers)
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  if (token) headers.set('Authorization', `Bearer ${token}`)
  const response = await fetch(`/api${url}`, { ...options, headers })
  if (response.status === 401 && url !== '/auth/login' && url !== '/bootstrap') {
    localStorage.removeItem('labims-token')
    localStorage.removeItem('labims-user')
    window.dispatchEvent(new Event('labims-session-expired'))
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(payload.error || `Request failed (${response.status}).`)
  }
  if (response.headers.get('content-type')?.includes('text/csv')) return response.text() as Promise<T>
  return response.json() as Promise<T>
}

function formatDate(value: string | null | undefined, withTime = false) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat(undefined, withTime
    ? { dateStyle: 'medium', timeStyle: 'short' }
    : { dateStyle: 'medium' }).format(date)
}

function todayInput() {
  const now = new Date()
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

function isInRange(value: number, parameter: Parameter) {
  const lower = parameter.lower_limit ?? parameter.lowerLimit
  const upper = parameter.upper_limit ?? parameter.upperLimit
  return (lower == null || value >= Number(lower)) && (upper == null || value <= Number(upper))
}

export default function App() {
  const [user, setUser] = useState<User | null>(() => {
    try {
      return JSON.parse(localStorage.getItem('labims-user') || 'null') as User | null
    } catch {
      return null
    }
  })
  const [needsAdmin, setNeedsAdmin] = useState(false)
  const [checkingAuth, setCheckingAuth] = useState(true)
  const [page, setPage] = useState<Page>('Overview')
  const [dashboard, setDashboard] = useState<Dashboard | null>(null)
  const [samples, setSamples] = useState<Sample[]>([])
  const [methods, setMethods] = useState<Method[]>([])
  const [instruments, setInstruments] = useState<Instrument[]>([])
  const [readings, setReadings] = useState<InstrumentReading[]>([])
  const [connectors, setConnectors] = useState<Connector[]>([])
  const [compliance, setCompliance] = useState<ComplianceData>({ audit: [], exceptions: [], signatures: [] })
  const [complianceReadiness, setComplianceReadiness] = useState<ComplianceReadiness | null>(null)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [selectedSample, setSelectedSample] = useState<SampleDetail | null>(null)
  const [showNewSample, setShowNewSample] = useState(false)
  const [showNewMethod, setShowNewMethod] = useState(false)
  const [showNewInstrument, setShowNewInstrument] = useState(false)
  const [showNewUser, setShowNewUser] = useState(false)
  const [auditIntegrity, setAuditIntegrity] = useState<boolean | null>(null)
  const [trendParameterId, setTrendParameterId] = useState('')
  const [trendPoints, setTrendPoints] = useState<TrendPoint[]>([])
  const [authForm, setAuthForm] = useState({ fullName: '', email: '', password: '' })
  const [sampleTemplateId, setSampleTemplateId] = useState('')
  const [sampleForm, setSampleForm] = useState({ sampleCode: '', location: '', material: '', methodId: '', collectedAt: todayInput(), dueAt: '', chemist: '', notes: '' })
  const [resultForm, setResultForm] = useState<Record<number, string>>({})
  const [signForm, setSignForm] = useState({ action: 'Approved', reason: '', password: '' })
  const [methodForm, setMethodForm] = useState({
    name: '', module: 'Water Chemistry', standard: 'Site Standard', description: '',
    parameters: [{ name: '', unit: '', lowerLimit: '', upperLimit: '', decimalPlaces: 2, formula: '' }]
  })
  const [instrumentForm, setInstrumentForm] = useState({ name: '', module: 'Water Chemistry', protocol: 'TCP/IP', endpoint: '' })
  const [readingForm, setReadingForm] = useState({ instrumentId: '', tag: '', value: '', unit: '', sampleId: '' })
  const [connectorForms, setConnectorForms] = useState<Record<string, { endpoint: string; mapping: string; enabled: boolean }>>({})
  const [userForm, setUserForm] = useState({ fullName: '', email: '', password: '', role: 'Lab Technician' as Role })

  const run = useCallback(async (operation: () => Promise<void>, successMessage?: string) => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await operation()
      if (successMessage) setNotice(successMessage)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The request could not be completed.')
    } finally {
      setBusy(false)
    }
  }, [])

  const loadWorkspace = useCallback(async () => {
    const [dashboardResponse, sampleResponse, methodResponse, instrumentResponse, complianceResponse, readinessResponse] = await Promise.all([
      api<Dashboard>('/dashboard'),
      api<{ samples: Sample[] }>('/samples'),
      api<{ methods: Method[] }>('/methods'),
      api<{ instruments: Instrument[]; connectors: Connector[]; readings: InstrumentReading[] }>('/instruments'),
      api<ComplianceData>('/compliance'),
      api<ComplianceReadiness>('/compliance/readiness')
    ])
    setDashboard(dashboardResponse)
    setSamples(sampleResponse.samples)
    setMethods(methodResponse.methods)
    setInstruments(instrumentResponse.instruments)
    setReadings(instrumentResponse.readings)
    setCompliance(complianceResponse)
    setComplianceReadiness(readinessResponse)
    setConnectors(instrumentResponse.connectors)
    setConnectorForms(Object.fromEntries(instrumentResponse.connectors.map((connector) => [
      connector.connector_type,
      {
        endpoint: connector.endpoint,
        mapping: JSON.stringify(connector.tag_mapping, null, 2),
        enabled: connector.enabled
      }
    ])))
    if (!trendParameterId && methodResponse.methods[0]?.parameters[0]) {
      setTrendParameterId(String(methodResponse.methods[0].parameters[0].id))
    }
  }, [trendParameterId])

  useEffect(() => {
    const check = async () => {
      try {
        const status = await api<{ needsAdmin: boolean }>('/bootstrap/status')
        setNeedsAdmin(status.needsAdmin)
        if (localStorage.getItem('labims-token')) {
          const response = await api<{ user: User }>('/auth/me')
          setUser(response.user)
          localStorage.setItem('labims-user', JSON.stringify(response.user))
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Unable to connect to LabIMS.')
      } finally {
        setCheckingAuth(false)
      }
    }
    void check()
    const expire = () => setUser(null)
    window.addEventListener('labims-session-expired', expire)
    return () => window.removeEventListener('labims-session-expired', expire)
  }, [])

  useEffect(() => {
    if (user) {
      void loadWorkspace().catch((cause) => setError(cause instanceof Error ? cause.message : 'Unable to load LabIMS data.'))
    }
  }, [user, loadWorkspace])

  useEffect(() => {
    if (!user || page !== 'Test Methods' || !trendParameterId) return
    let current = true
    void api<{ points: TrendPoint[] }>(`/trends?parameterId=${encodeURIComponent(trendParameterId)}`)
      .then((response) => { if (current) setTrendPoints(response.points) })
      .catch((cause) => { if (current) setError(cause instanceof Error ? cause.message : 'Unable to load trends.') })
    return () => { current = false }
  }, [user, page, trendParameterId])

  const refresh = async () => {
    await loadWorkspace()
    if (selectedSample) {
      const detail = await api<SampleDetail>(`/samples/${selectedSample.sample.id}`)
      setSelectedSample(detail)
    }
  }

  const applySampleTemplate = (templateId: string) => {
    const template = sampleTemplates.find((item) => item.id === templateId)
    if (!template) {
      setSampleTemplateId('')
      return
    }
    setSampleTemplateId(templateId)
    const method = methods.find((item) => item.name === template.methodName)
    setSampleForm((current) => ({
      ...current,
      location: template.location,
      material: template.material,
      methodId: method ? String(method.id) : current.methodId,
      chemist: template.chemist,
      notes: template.notes
    }))
  }

  const logout = () => {
    localStorage.removeItem('labims-token')
    localStorage.removeItem('labims-user')
    setUser(null)
    setSelectedSample(null)
    setNotice('You have signed out.')
  }

  const signIn = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    void run(async () => {
      const response = needsAdmin
        ? await api<{ token: string; user: User }>('/bootstrap', { method: 'POST', body: JSON.stringify(authForm) })
        : await api<{ token: string; user: User }>('/auth/login', { method: 'POST', body: JSON.stringify({ email: authForm.email, password: authForm.password }) })
      localStorage.setItem('labims-token', response.token)
      localStorage.setItem('labims-user', JSON.stringify(response.user))
      setUser(response.user)
      setNeedsAdmin(false)
      setError('')
    })
  }

  const openSample = async (sample: Sample) => {
    await run(async () => {
      const detail = await api<SampleDetail>(`/samples/${sample.id}`)
      setSelectedSample(detail)
      setResultForm(Object.fromEntries(detail.parameters.map((parameter) => [
        parameter.id,
        parameter.numeric_value == null ? '' : String(parameter.numeric_value)
      ])))
    })
  }

  const createSample = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    void run(async () => {
      await api('/samples', { method: 'POST', body: JSON.stringify(sampleForm) })
      setShowNewSample(false)
      setSampleTemplateId('')
      setSampleForm({ sampleCode: '', location: '', material: '', methodId: '', collectedAt: todayInput(), dueAt: '', chemist: '', notes: '' })
      await refresh()
    }, 'Sample registered and added to the custody log.')
  }

  const startSample = () => {
    if (!selectedSample) return
    void run(async () => {
      await api(`/samples/${selectedSample.sample.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'In Progress' }) })
      await refresh()
    }, 'Analysis started. Record test results below.')
  }

  const saveResult = (parameter: Parameter) => {
    if (!selectedSample) return
    const value = resultForm[parameter.id]
    if (!value?.trim()) {
      setError(`Enter a result for ${parameter.name}.`)
      return
    }
    void run(async () => {
      await api(`/samples/${selectedSample.sample.id}/results`, {
        method: 'PUT',
        body: JSON.stringify({ parameterId: parameter.id, value })
      })
      await refresh()
    }, `${parameter.name} result saved with limits checked.`)
  }

  const signSample = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!selectedSample) return
    void run(async () => {
      await api(`/samples/${selectedSample.sample.id}/signatures`, {
        method: 'POST',
        body: JSON.stringify(signForm)
      })
      setSignForm({ action: 'Approved', reason: '', password: '' })
      await refresh()
    }, `Sample ${signForm.action.toLowerCase()} with an electronic signature.`)
  }

  const createMethod = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    void run(async () => {
      await api('/methods', {
        method: 'POST',
        body: JSON.stringify({
          ...methodForm,
          parameters: methodForm.parameters.map((parameter) => ({
            ...parameter,
            decimalPlaces: Number(parameter.decimalPlaces),
            formula: parameter.formula.trim()
          }))
        })
      })
      setShowNewMethod(false)
      setMethodForm({
        name: '', module: 'Water Chemistry', standard: 'Site Standard', description: '',
        parameters: [{ name: '', unit: '', lowerLimit: '', upperLimit: '', decimalPlaces: 2, formula: '' }]
      })
      await refresh()
    }, 'Test method and parameter limits saved.')
  }

  const createInstrument = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    void run(async () => {
      await api('/instruments', { method: 'POST', body: JSON.stringify(instrumentForm) })
      setShowNewInstrument(false)
      setInstrumentForm({ name: '', module: 'Water Chemistry', protocol: 'TCP/IP', endpoint: '' })
      await refresh()
    }, 'Instrument record added. It remains marked not connected until a verified driver reports data.')
  }

  const captureReading = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    void run(async () => {
      await api(`/instruments/${readingForm.instrumentId || 'manual'}/readings`, {
        method: 'POST',
        body: JSON.stringify(readingForm)
      })
      setReadingForm({ instrumentId: '', tag: '', value: '', unit: '', sampleId: '' })
      await refresh()
    }, 'Instrument reading recorded.')
  }

  const autoCaptureReading = async (instrumentId: number) => {
    await run(async () => {
      await api(`/instruments/${instrumentId}/autocapture`, { method: 'POST' })
      await refresh()
    }, 'Live auto-capture completed for the instrument.')
  }

  const saveConnector = (connector: Connector) => {
    const values = connectorForms[connector.connector_type]
    if (!values) return
    void run(async () => {
      let tagMapping: Record<string, string>
      try {
        tagMapping = JSON.parse(values.mapping || '{}') as Record<string, string>
      } catch {
        throw new Error('Tag mapping must be valid JSON.')
      }
      const type = connector.connector_type === 'DCS / Historian' ? 'dcs' : 'erp'
      await api(`/integrations/${type}`, {
        method: 'PUT',
        body: JSON.stringify({ endpoint: values.endpoint, tagMapping, enabled: values.enabled })
      })
      await refresh()
    }, 'Integration configuration saved. This does not establish a live plant connection.')
  }

  const createUser = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    void run(async () => {
      await api('/users', { method: 'POST', body: JSON.stringify(userForm) })
      setShowNewUser(false)
      setUserForm({ fullName: '', email: '', password: '', role: 'Lab Technician' })
      await refresh()
    }, 'User account created.')
  }

  const verifyAudit = () => {
    void run(async () => {
      const result = await api<{ valid: boolean; checked: number }>('/audit/verify')
      setAuditIntegrity(result.valid)
      setNotice(result.valid
        ? `Audit integrity verified across ${result.checked} entries.`
        : `Audit integrity check failed at entry ${result.checked}.`)
    })
  }

  const downloadReport = () => {
    void run(async () => {
      const csv = await api<string>('/reports/samples.csv')
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `labims-samples-${new Date().toISOString().slice(0, 10)}.csv`
      anchor.click()
      URL.revokeObjectURL(url)
    }, 'CSV report downloaded.')
  }

  const downloadRegulatoryDossier = () => {
    void run(async () => {
      const dossier = await api<string>('/reports/regulatory.txt')
      const url = URL.createObjectURL(new Blob([dossier], { type: 'text/plain;charset=utf-8' }))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `labims-regulatory-dossier-${new Date().toISOString().slice(0, 10)}.txt`
      anchor.click()
      URL.revokeObjectURL(url)
    }, 'Regulatory dossier exported.')
  }

  const trendParameters = useMemo(() => methods.flatMap((method) => method.parameters.map((parameter) => ({
    ...parameter,
    methodName: method.name,
    module: method.module
  }))), [methods])

  const filteredSamples = useMemo(() => {
    const term = search.trim().toLowerCase()
    return samples.filter((sample) => {
      const matchesTerm = !term || `${sample.sample_code} ${sample.location} ${sample.method_name} ${sample.chemist}`.toLowerCase().includes(term)
      const matchesStatus = !statusFilter || sample.status === statusFilter
      return matchesTerm && matchesStatus
    })
  }, [samples, search, statusFilter])

  if (checkingAuth) return <div className="boot-screen"><span className="spinner" />Connecting to LabIMS…</div>
  if (!user) {
    return (
      <main className="auth-screen">
        <form className="auth-card" onSubmit={signIn}>
          <div className="brand-mark">L</div>
          <p className="eyebrow">Hwange Power Station</p>
          <h1>{needsAdmin ? 'Set up LabIMS' : 'Welcome back'}</h1>
          <p className="muted">{needsAdmin ? 'Create the first Station Chemist administrator to secure this workspace.' : 'Sign in with your laboratory account.'}</p>
          {needsAdmin && <label>Full name<input required autoComplete="name" value={authForm.fullName} onChange={(event) => setAuthForm({ ...authForm, fullName: event.target.value })} /></label>}
          <label>Email<input required type="email" autoComplete="username" value={authForm.email} onChange={(event) => setAuthForm({ ...authForm, email: event.target.value })} /></label>
          <label>Password<input required type="password" minLength={needsAdmin ? 12 : 1} autoComplete={needsAdmin ? 'new-password' : 'current-password'} value={authForm.password} onChange={(event) => setAuthForm({ ...authForm, password: event.target.value })} /></label>
          {error && <p className="notice error">{error}</p>}
          <button className="primary-btn wide" disabled={busy}>{busy ? 'Please wait…' : needsAdmin ? 'Create administrator' : 'Sign in'}</button>
          {needsAdmin && <small className="muted">Use a unique password with at least 12 characters.</small>}
        </form>
      </main>
    )
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-block">
          <div className="brand-mark">L</div>
          <div><p className="eyebrow">Power Station</p><h1>LabIMS</h1></div>
        </div>
        <nav className="nav" aria-label="Main navigation">
          {navigation.map((item) => (
            <button key={item} className={`nav-item ${page === item ? 'active' : ''}`} onClick={() => setPage(item)}>
              <span className="nav-glyph">{['◈', '▤', '⚗', '⌁', '✓', '▥', '♙'][navigation.indexOf(item)]}</span>{item}
            </button>
          ))}
        </nav>
        <div className="sidebar-card">
          <p className="card-label">Signed in as</p>
          <strong>{user.fullName}</strong>
          <small>{user.role}</small>
          <button className="logout-btn" onClick={logout}>Sign out</button>
        </div>
        <div className="sidebar-foot"><span className="dot online" />Database connected</div>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <div><p className="eyebrow dark">Hwange Power Station</p><h2>{page === 'Overview' ? 'Laboratory Information Management System' : page}</h2></div>
          <div className="top-actions">
            <span className="user-chip"><span className="avatar">{user.fullName.charAt(0).toUpperCase()}</span>{user.fullName}<span className="role-label">{user.role}</span></span>
            {['Lab Technician', 'Station Chemist'].includes(user.role) && <button className="primary-btn" onClick={() => setShowNewSample(true)}>＋ New Sample</button>}
          </div>
        </header>
        {error && <div className="notice error" role="alert">{error}<button onClick={() => setError('')}>Dismiss</button></div>}
        {notice && <div className="notice success" role="status">{notice}<button onClick={() => setNotice('')}>Dismiss</button></div>}
        {busy && <div className="loading-line" aria-label="Saving" />}

        {page === 'Overview' && (
          <>
            <section className="kpi-grid">
              <Kpi label="Compliance" value={dashboard ? `${dashboard.compliance}%` : '—'} delta="Within configured limits" tone={dashboard?.compliance != null && dashboard.compliance < 90 ? 'warning' : ''} />
              <Kpi label="Active Samples" value={dashboard?.activeSamples ?? '—'} delta="Received and in progress" />
              <Kpi label="Instrument Uptime" value={dashboard?.instrumentUptime == null ? '—' : `${dashboard.instrumentUptime}%`} delta={dashboard?.instrumentUptime == null ? 'No device status data' : `${dashboard.instrumentsConnected} of ${dashboard.instrumentsTotal} connected`} />
              <Kpi label="COA Issued" value={dashboard?.coaIssued ?? '—'} delta="Approved this month" />
            </section>
            <section className="content-grid">
              <div className="panel">
                <div className="panel-header"><div><h3>Laboratory modules</h3><p className="muted">Configured methods and station interfaces</p></div><span className="badge">{methods.length} methods</span></div>
                <div className="module-list">
                  {modules.map((module) => <div key={module} className="module-item"><span className="module-bullet" />{module}<span className="module-arrow">›</span></div>)}
                </div>
              </div>
              <div className="panel trend-panel">
                <div className="panel-header"><div><h3>Compliance trend</h3><p className="muted">Recent test results within configured limits</p></div><span className="badge">6 months</span></div>
                <div className="chart">
                  {(dashboard?.trend ?? []).map((month) => (
                    <div className="chart-col" key={`${month.label}-${month.compliance}`} title={`${month.label}: ${month.compliance}%`}>
                      <span className="chart-value">{month.compliance ? `${month.compliance}%` : '—'}</span>
                      <span className="bar" style={{ height: `${Math.max(month.compliance, 4)}%` }} />
                      <span className="chart-month">{month.label}</span>
                    </div>
                  ))}
                </div>
              </div>
            </section>
            <section className="panel samples-panel">
              <div className="panel-header"><div><h3>Sample workflow</h3><p className="muted">Latest registrations and their current status</p></div><button className="text-btn" onClick={() => setPage('Sample Registry')}>Open registry →</button></div>
              <SampleTable samples={samples.slice(0, 6)} onOpen={openSample} />
            </section>
          </>
        )}

        {page === 'Sample Registry' && (
          <section className="panel page-panel">
            <div className="panel-header"><div><h3>Sample registry</h3><p className="muted">Search, track status, review results and chain of custody.</p></div>
              {['Lab Technician', 'Station Chemist'].includes(user.role) && <button className="primary-btn" onClick={() => setShowNewSample(true)}>＋ Register sample</button>}
            </div>
            <div className="toolbar">
              <label className="searchbox"><span>⌕</span><input placeholder="Search sample, location or method…" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
              <select aria-label="Filter by status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="">All statuses</option><option>Received</option><option>In Progress</option><option>Approved</option><option>Rejected</option></select>
              <span className="muted result-count">{filteredSamples.length} samples</span>
            </div>
            <SampleTable samples={filteredSamples} onOpen={openSample} />
          </section>
        )}

        {page === 'Test Methods' && (
          <section className="page-panel">
            <div className="page-heading"><div><h3>Test methods</h3><p className="muted">Controlled methods, configured limits, reporting precision and applicable standards.</p></div>
              {user.role === 'Station Chemist' && <button className="primary-btn" onClick={() => setShowNewMethod(true)}>＋ Configure method</button>}
            </div>
            <div className="method-grid">
              {methods.map((method) => <article className="panel method-card" key={method.id}>
                <div className="method-top"><span className="module-tag">{method.module}</span><span className="method-standard">{method.standard}</span></div>
                <h4>{method.name}</h4><p className="muted">{method.description || 'Laboratory test method'}</p>
                <div className="parameter-list">{method.parameters.map((parameter) => <div key={parameter.id} className="parameter-summary">
                  <span>{parameter.name}<small>{parameter.unit || 'No unit'}</small></span>
                  <span>{parameter.formula ? <code className="formula-code">= {parameter.formula}</code> : `${parameter.lowerLimit ?? parameter.lower_limit ?? '—'} – ${parameter.upperLimit ?? parameter.upper_limit ?? '—'}`}</span>
                </div>)}</div>
                <small className="muted">{method.parameters.length} result parameters</small>
              </article>)}
            </div>
            <section className="panel subpanel trend-detail">
              <div className="panel-header"><div><h3>Parameter trend</h3><p className="muted">Recorded laboratory readings over the last 90 days.</p></div>
                <select aria-label="Select parameter trend" value={trendParameterId} onChange={(event) => setTrendParameterId(event.target.value)}>
                  {trendParameters.map((parameter) => <option key={`${parameter.id}-${parameter.methodName}`} value={parameter.id}>{parameter.methodName} · {parameter.name}</option>)}
                </select>
              </div>
              <TrendChart points={trendPoints} />
            </section>
          </section>
        )}

        {page === 'Instrument Interface' && (
          <section className="page-panel">
            <div className="page-heading"><div><h3>Instrument interface</h3><p className="muted">Manage supported serial, USB and TCP/IP instrument records and integration mappings.</p></div>
              {user.role === 'Station Chemist' && <button className="primary-btn" onClick={() => setShowNewInstrument(true)}>＋ Add instrument</button>}
            </div>
            <div className="panel integration-note"><span className="integration-icon">⌁</span><div><strong>Hardware connection status is reported honestly</strong><p className="muted">A configured instrument is not marked connected until a verified driver or station adapter reports data.</p></div></div>
            <div className="instrument-grid">{instruments.length ? instruments.map((instrument) => <article className="panel instrument-card" key={instrument.id}>
              <div className="instrument-icon">⚗</div><div className="instrument-info"><h4>{instrument.name}</h4><p>{instrument.module} · {instrument.protocol}</p><small>{instrument.endpoint || 'Endpoint not set'}</small></div>
              <div className="instrument-actions">
                <span className={`status-pill ${instrument.status === 'Connected' ? 'approved' : 'received'}`}>{instrument.status}</span>
                {['Lab Technician', 'Station Chemist'].includes(user.role) && <button className="secondary-btn compact" onClick={() => void autoCaptureReading(instrument.id)} disabled={busy}>Auto-capture</button>}
              </div>
              <small className="instrument-last">Last reading {formatDate(instrument.last_reading, true)}</small>
            </article>) : <EmptyState title="No instruments configured" text="Add an instrument record to start mapping the station's analyzers." />}</div>
            {['Lab Technician', 'Station Chemist'].includes(user.role) && <section className="panel subpanel">
              <div className="panel-header"><div><h3>Record an instrument reading</h3><p className="muted">Manual capture now; protocol drivers can be connected when the device interface is available.</p></div></div>
              <form className="inline-form" onSubmit={captureReading}>
                <label>Instrument<select value={readingForm.instrumentId} onChange={(event) => setReadingForm({ ...readingForm, instrumentId: event.target.value })}><option value="">Manual / DCS tag</option>{instruments.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
                <label>Tag / parameter<input required value={readingForm.tag} onChange={(event) => setReadingForm({ ...readingForm, tag: event.target.value })} placeholder="e.g. Unit2.Boiler.pH" /></label>
                <label>Value<input required type="number" step="any" value={readingForm.value} onChange={(event) => setReadingForm({ ...readingForm, value: event.target.value })} /></label>
                <label>Unit<input value={readingForm.unit} onChange={(event) => setReadingForm({ ...readingForm, unit: event.target.value })} placeholder="pH, µS/cm…" /></label>
                <label>Link sample<select value={readingForm.sampleId} onChange={(event) => setReadingForm({ ...readingForm, sampleId: event.target.value })}><option value="">No sample link</option>{samples.map((sample) => <option key={sample.id} value={sample.id}>{sample.sample_code}</option>)}</select></label>
                <button className="secondary-btn" disabled={busy}>Record reading</button>
              </form>
            </section>}
            <section className="panel subpanel">
              <div className="panel-header"><div><h3>Latest captured readings</h3><p className="muted">Readings are stored with their source, sample association and capture time.</p></div></div>
              {readings.length ? <div className="table-wrap"><table><thead><tr><th>Tag</th><th>Value</th><th>Instrument</th><th>Sample</th><th>Quality</th><th>Recorded</th></tr></thead><tbody>{readings.slice(0, 20).map((reading) => <tr key={reading.id}><td>{reading.tag}</td><td>{reading.value} {reading.unit}</td><td>{reading.instrument_name || 'Manual / DCS'}</td><td>{reading.sample_code || '—'}</td><td>{reading.quality}</td><td>{formatDate(reading.observed_at, true)}</td></tr>)}</tbody></table></div> : <EmptyState title="No readings yet" text="Manually record an instrument or historian value to see it here." />}
            </section>
            <div className="connector-grid">{connectors.map((connector) => <ConnectorCard key={connector.connector_type} connector={connector} values={connectorForms[connector.connector_type]} editable={user.role === 'Station Chemist'} busy={busy}
              onChange={(values) => setConnectorForms({ ...connectorForms, [connector.connector_type]: values })}
              onSave={() => saveConnector(connector)} />)}</div>
          </section>
        )}

        {page === 'Compliance' && (
          <section className="page-panel">
            <div className="page-heading"><div><h3>Compliance & audit trail</h3><p className="muted">Out-of-limit results, electronic signatures and immutable change history.</p></div>
              <button className="secondary-btn" onClick={verifyAudit}>⟳ Verify audit integrity</button>
            </div>
            {auditIntegrity !== null && <div className={`integrity-banner ${auditIntegrity ? 'good' : 'bad'}`}>{auditIntegrity ? '✓ Hash chain verified. No changes detected.' : '⚠ Integrity verification failed. Review the audit entries immediately.'}</div>}
            {complianceReadiness && <div className="panel readiness-panel">
              <div className="readiness-header">
                <div>
                  <p className="card-label">Regulatory readiness</p>
                  <h3>{complianceReadiness.status}</h3>
                </div>
                <span className={`status-pill ${complianceReadiness.status === 'Ready' ? 'approved' : complianceReadiness.status === 'At Risk' ? 'progress' : 'rejected'}`}>{complianceReadiness.status}</span>
              </div>
              <div className="readiness-grid">
                {complianceReadiness.checks.map((check) => <div key={check.id} className={`check-item ${check.ok ? 'ok' : 'warn'}`}>
                  <strong>{check.label}</strong>
                  <span>{check.value}</span>
                </div>)}
              </div>
              <div className="readiness-checklist">
                {complianceReadiness.checklist.map((item) => <div key={item.id} className={`checklist-row ${item.status}`}>
                  <span className="requirement-tag">{item.requirement}</span>
                  <div>
                    <strong>{item.status === 'pass' ? 'Pass' : item.status === 'warning' ? 'Needs confirmation' : 'Fail'}</strong>
                    <p>{item.detail}</p>
                  </div>
                </div>)}
              </div>
            </div>}
            <div className="compliance-kpis"><div className="panel mini-kpi"><span>Out-of-limit results</span><strong>{compliance.exceptions.length}</strong></div><div className="panel mini-kpi"><span>Electronic signatures</span><strong>{compliance.signatures.length}</strong></div><div className="panel mini-kpi"><span>Audit events (latest 100)</span><strong>{compliance.audit.length}</strong></div></div>
            <div className="panel subpanel">
              <div className="panel-header"><div><h3>Limit exceptions</h3><p className="muted">Results compared with the configured method limits.</p></div></div>
              {compliance.exceptions.length ? <div className="table-wrap"><table><thead><tr><th>Sample</th><th>Location</th><th>Parameter</th><th>Result</th><th>Configured limits</th><th>Tested</th></tr></thead><tbody>{compliance.exceptions.map((entry, index) => <tr key={`${entry.sample_code}-${entry.parameter}-${index}`}><td>{entry.sample_code}</td><td>{entry.location}</td><td>{entry.parameter}</td><td className="danger-text">{entry.numeric_value} {entry.unit}</td><td>{entry.lower_limit ?? '—'} – {entry.upper_limit ?? '—'}</td><td>{formatDate(entry.tested_at, true)}</td></tr>)}</tbody></table></div> : <EmptyState title="No limit exceptions" text="Results outside the current configured limits will be listed here." />}
            </div>
            <div className="compliance-grid">
              <div className="panel subpanel"><div className="panel-header"><h3>Electronic signatures</h3></div>
                {compliance.signatures.length ? <div className="event-list">{compliance.signatures.slice(0, 10).map((signature, index) => <div className="event-item" key={`${signature.sample_id}-${index}`}><span className={`event-mark ${signature.action === 'Approved' ? 'green' : 'red'}`}>{signature.action === 'Approved' ? '✓' : '!'}</span><div><strong>{signature.action} · {signature.sample_code}</strong><p>{signature.signer} · {signature.meaning}</p><small>{signature.reason}</small><time>{formatDate(signature.signed_at, true)}</time></div></div>)}</div> : <p className="muted">Signed approvals and rejections will appear here.</p>}
              </div>
              <div className="panel subpanel"><div className="panel-header"><h3>Audit history</h3><span className="badge">{compliance.audit.length} latest</span></div>
                <div className="event-list">{compliance.audit.slice(0, 20).map((entry) => <div className="event-item" key={entry.id}><span className="event-mark blue">·</span><div><strong>{entry.action}</strong><p>{entry.actor || 'System'} · {entry.entity_type} #{entry.entity_id}</p><small>{Object.entries(entry.details || {}).map(([key, value]) => `${key}: ${String(value)}`).join(' · ')}</small><time>{formatDate(entry.created_at, true)}</time></div></div>)}</div>
              </div>
            </div>
          </section>
        )}

        {page === 'Reports' && (
          <section className="page-panel">
            <div className="page-heading"><div><h3>Reports & certificates</h3><p className="muted">Export traceable sample and result records for review and downstream reporting.</p></div><button className="primary-btn" onClick={downloadReport}>↓ Export CSV</button></div>
            <div className="report-grid">
              <article className="panel report-card"><span className="report-icon">▤</span><h4>Sample and results register</h4><p>Sample IDs, collection locations, material, methods, workflow status, results and specification limits.</p><button className="secondary-btn" onClick={downloadReport}>Download CSV</button></article>
              <article className="panel report-card"><span className="report-icon">✓</span><h4>Certificate of analysis</h4><p>Approved sample results and electronic sign-off are accessible from each sample's detail and custody record.</p><button className="secondary-btn" onClick={() => setPage('Sample Registry')}>Open sample registry</button></article>
              <article className="panel report-card"><span className="report-icon">▣</span><h4>Regulatory dossier</h4><p>Export a text dossier covering readiness checks, tender requirements, controls and operational validation notes.</p><button className="secondary-btn" onClick={downloadRegulatoryDossier}>Export dossier</button></article>
            </div>
            <div className="panel subpanel"><div className="panel-header"><div><h3>Report snapshot</h3><p className="muted">Live counts from the relational database.</p></div></div>
              <div className="report-stats"><div><strong>{dashboard?.totalSamples ?? 0}</strong><span>Total samples</span></div><div><strong>{dashboard?.activeSamples ?? 0}</strong><span>Active samples</span></div><div><strong>{dashboard?.coaIssued ?? 0}</strong><span>Approved this month</span></div><div><strong>{dashboard?.rejectedSamples ?? 0}</strong><span>Rejected samples</span></div></div>
            </div>
          </section>
        )}

        {page === 'User Management' && (
          <section className="page-panel">
            <div className="page-heading"><div><h3>User access control</h3><p className="muted">Access is role-based; approvals and configuration actions are restricted by the API.</p></div>
              {user.role === 'Station Chemist' && <button className="primary-btn" onClick={() => setShowNewUser(true)}>＋ Create user</button>}
            </div>
            {user.role === 'Station Chemist' ? <UserList onError={setError} /> : <div className="panel access-note"><span className="access-icon">♙</span><div><strong>{user.role}</strong><p className="muted">User provisioning is restricted to the Station Chemist administrator role.</p></div></div>}
            <div className="panel role-panel"><h3>Role permissions</h3><div className="role-grid">
              <RoleCard role="Lab Technician" text="Register samples, record test results and review sample history." />
              <RoleCard role="Lab Supervisor" text="Review results, provide signed sample approvals or rejections." />
              <RoleCard role="Station Chemist" text="Manage users, methods, instrument configuration and integrations." />
              <RoleCard role="Plant Management" text="Read-only access to dashboards, compliance and reports." />
            </div></div>
          </section>
        )}
      </main>

      {showNewSample && <Modal title="Register a sample" onClose={() => setShowNewSample(false)}>
        <form className="form-grid" onSubmit={createSample}>
          <label>Sample template<select value={sampleTemplateId} onChange={(event) => applySampleTemplate(event.target.value)}><option value="">Custom sample</option>{sampleTemplates.map((template) => <option key={template.id} value={template.id}>{template.label}</option>)}</select></label>
          <label>Sample ID / barcode<input value={sampleForm.sampleCode} onChange={(event) => setSampleForm({ ...sampleForm, sampleCode: event.target.value })} placeholder="Leave blank to generate an ID" /></label>
          <label>Test method / template<select required value={sampleForm.methodId} onChange={(event) => {
            setSampleForm({ ...sampleForm, methodId: event.target.value })
            setSampleTemplateId('')
          }}><option value="">Select a method</option>{methods.map((method) => <option key={method.id} value={method.id}>{method.name} · {method.module}</option>)}</select></label>
          <label>Sample location<input required value={sampleForm.location} onChange={(event) => setSampleForm({ ...sampleForm, location: event.target.value })} placeholder="Unit 2 Boiler Feedwater" /></label>
          <label>Material<input value={sampleForm.material} onChange={(event) => setSampleForm({ ...sampleForm, material: event.target.value })} placeholder="Water, coal, oil…" /></label>
          <label>Collected at<input type="datetime-local" value={sampleForm.collectedAt} onChange={(event) => setSampleForm({ ...sampleForm, collectedAt: event.target.value })} /></label>
          <label>Due by<input type="datetime-local" value={sampleForm.dueAt} onChange={(event) => setSampleForm({ ...sampleForm, dueAt: event.target.value })} /></label>
          <label>Assigned chemist<input value={sampleForm.chemist} onChange={(event) => setSampleForm({ ...sampleForm, chemist: event.target.value })} placeholder={user.fullName} /></label>
          <label className="span-two">Notes<input value={sampleForm.notes} onChange={(event) => setSampleForm({ ...sampleForm, notes: event.target.value })} /></label>
          <div className="form-actions span-two"><button className="secondary-btn" type="button" onClick={() => setShowNewSample(false)}>Cancel</button><button className="primary-btn" disabled={busy}>Register sample</button></div>
        </form>
      </Modal>}

      {showNewMethod && <Modal title="Configure a test method" onClose={() => setShowNewMethod(false)} wide>
        <form className="form-grid" onSubmit={createMethod}>
          <label>Method name<input required value={methodForm.name} onChange={(event) => setMethodForm({ ...methodForm, name: event.target.value })} /></label>
          <label>Module<select value={methodForm.module} onChange={(event) => setMethodForm({ ...methodForm, module: event.target.value })}>{modules.slice(0, 4).map((module) => <option key={module}>{module}</option>)}</select></label>
          <label>Standard / procedure<input required value={methodForm.standard} onChange={(event) => setMethodForm({ ...methodForm, standard: event.target.value })} placeholder="ASTM, ISO or site standard" /></label>
          <label>Description<input value={methodForm.description} onChange={(event) => setMethodForm({ ...methodForm, description: event.target.value })} /></label>
          <div className="parameter-builder span-two"><div className="builder-heading"><strong>Parameters, limits and optional derived formulas</strong><button className="text-btn" type="button" onClick={() => setMethodForm({ ...methodForm, parameters: [...methodForm.parameters, { name: '', unit: '', lowerLimit: '', upperLimit: '', decimalPlaces: 2, formula: '' }] })}>＋ Add parameter</button></div>
            <p className="formula-help">Formula variables use parameter names in lowercase snake_case (for example, <code>100 - moisture - ash - volatile_matter</code>). Only arithmetic operators and parentheses are supported; site-approved calculations should be confirmed before use.</p>
            {methodForm.parameters.map((parameter, index) => <div className="builder-row" key={index}>
              <label>Parameter<input required value={parameter.name} onChange={(event) => updateMethodParameter(setMethodForm, methodForm, index, 'name', event.target.value)} /></label>
              <label>Unit<input value={parameter.unit} onChange={(event) => updateMethodParameter(setMethodForm, methodForm, index, 'unit', event.target.value)} /></label>
              <label>Lower limit<input type="number" step="any" value={parameter.lowerLimit} onChange={(event) => updateMethodParameter(setMethodForm, methodForm, index, 'lowerLimit', event.target.value)} /></label>
              <label>Upper limit<input type="number" step="any" value={parameter.upperLimit} onChange={(event) => updateMethodParameter(setMethodForm, methodForm, index, 'upperLimit', event.target.value)} /></label>
              <label>Decimals<input required type="number" min="0" max="6" value={parameter.decimalPlaces} onChange={(event) => updateMethodParameter(setMethodForm, methodForm, index, 'decimalPlaces', Number(event.target.value))} /></label>
              <label>Formula<input value={parameter.formula ?? ''} onChange={(event) => updateMethodParameter(setMethodForm, methodForm, index, 'formula', event.target.value)} placeholder="Optional" /></label>
              {methodForm.parameters.length > 1 && <button type="button" className="remove-row" aria-label="Remove parameter" onClick={() => setMethodForm({ ...methodForm, parameters: methodForm.parameters.filter((_, itemIndex) => itemIndex !== index) })}>×</button>}
            </div>)}
          </div>
          <div className="form-actions span-two"><button className="secondary-btn" type="button" onClick={() => setShowNewMethod(false)}>Cancel</button><button className="primary-btn" disabled={busy}>Save method</button></div>
        </form>
      </Modal>}

      {showNewInstrument && <Modal title="Add instrument record" onClose={() => setShowNewInstrument(false)}>
        <form className="form-grid" onSubmit={createInstrument}>
          <label>Instrument name<input required value={instrumentForm.name} onChange={(event) => setInstrumentForm({ ...instrumentForm, name: event.target.value })} placeholder="ICP-OES Analyzer" /></label>
          <label>Laboratory module<select value={instrumentForm.module} onChange={(event) => setInstrumentForm({ ...instrumentForm, module: event.target.value })}>{modules.slice(0, 4).map((module) => <option key={module}>{module}</option>)}</select></label>
          <label>Protocol<select value={instrumentForm.protocol} onChange={(event) => setInstrumentForm({ ...instrumentForm, protocol: event.target.value })}>{['RS232', 'USB', 'TCP/IP', 'Manual'].map((protocol) => <option key={protocol}>{protocol}</option>)}</select></label>
          <label>Endpoint / port<input value={instrumentForm.endpoint} onChange={(event) => setInstrumentForm({ ...instrumentForm, endpoint: event.target.value })} placeholder="e.g. COM3 or 192.168.1.20:502" /></label>
          <div className="form-actions span-two"><button className="secondary-btn" type="button" onClick={() => setShowNewInstrument(false)}>Cancel</button><button className="primary-btn" disabled={busy}>Add instrument</button></div>
        </form>
      </Modal>}

      {showNewUser && <Modal title="Create user account" onClose={() => setShowNewUser(false)}>
        <form className="form-grid" onSubmit={createUser}>
          <label>Full name<input required value={userForm.fullName} onChange={(event) => setUserForm({ ...userForm, fullName: event.target.value })} /></label>
          <label>Email<input required type="email" value={userForm.email} onChange={(event) => setUserForm({ ...userForm, email: event.target.value })} /></label>
          <label>Password<input required type="password" minLength={12} value={userForm.password} onChange={(event) => setUserForm({ ...userForm, password: event.target.value })} /><small>At least 12 characters.</small></label>
          <label>Role<select value={userForm.role} onChange={(event) => setUserForm({ ...userForm, role: event.target.value as Role })}>{['Lab Technician', 'Lab Supervisor', 'Station Chemist', 'Plant Management'].map((role) => <option key={role}>{role}</option>)}</select></label>
          <div className="form-actions span-two"><button className="secondary-btn" type="button" onClick={() => setShowNewUser(false)}>Cancel</button><button className="primary-btn" disabled={busy}>Create account</button></div>
        </form>
      </Modal>}

      {selectedSample && <Modal title={`Sample ${selectedSample.sample.sample_code}`} onClose={() => setSelectedSample(null)} wide>
        <div className="sample-detail">
          <div className="detail-head"><div><span className="module-tag">{selectedSample.sample.module}</span><h3>{selectedSample.sample.location}</h3><p className="muted">{selectedSample.sample.method_name} · {selectedSample.sample.standard}</p></div><StatusBadge status={selectedSample.sample.status} /></div>
          <div className="detail-facts"><div><span>Material</span><strong>{selectedSample.sample.material || '—'}</strong></div><div><span>Collected</span><strong>{formatDate(selectedSample.sample.collected_at, true)}</strong></div><div><span>Due</span><strong>{formatDate(selectedSample.sample.due_at, true)}</strong></div><div><span>Chemist</span><strong>{selectedSample.sample.chemist || 'Unassigned'}</strong></div></div>
          {selectedSample.sample.notes && <p className="sample-notes">{selectedSample.sample.notes}</p>}
          <div className="detail-section"><div className="section-heading"><h4>Test results</h4><span className="muted">{selectedSample.parameters.filter((parameter) => parameter.numeric_value != null).length} / {selectedSample.parameters.length} recorded</span></div>
            {selectedSample.parameters.length ? <div className="result-list">{selectedSample.parameters.map((parameter) => {
              const value = parameter.numeric_value == null ? null : Number(parameter.numeric_value)
              const within = value == null ? null : isInRange(value, parameter)
              return <div className={`result-row ${within === false ? 'out-of-range' : ''}`} key={parameter.id}>
                <div className="result-name"><strong>{parameter.name}</strong><small>{parameter.unit || 'No unit'} · Limits {parameter.lower_limit ?? '—'} to {parameter.upper_limit ?? '—'}</small></div>
                {selectedSample.sample.status === 'In Progress' && ['Lab Technician', 'Station Chemist'].includes(user.role) && !parameter.formula
                  ? <><input aria-label={`${parameter.name} result`} type="number" step="any" value={resultForm[parameter.id] ?? ''} onChange={(event) => setResultForm({ ...resultForm, [parameter.id]: event.target.value })} /><button className="secondary-btn compact" onClick={() => saveResult(parameter)} disabled={busy}>Save</button></>
                  : <strong className={within === false ? 'danger-text' : 'result-value'}>{value == null ? (parameter.formula ? 'Awaiting formula inputs' : 'Not recorded') : `${value.toFixed(parameter.decimal_places ?? 2)} ${parameter.unit}`}{parameter.calculated && <small className="calculated-label">Calculated automatically</small>}</strong>}
                {parameter.formula && <small className="formula-detail">ƒ(x) = {parameter.formula}</small>}
                {within !== null && <span className={`result-flag ${within ? 'within' : 'outside'}`}>{within ? 'Within limits' : 'Out of limit'}</span>}
              </div>
            })}</div> : <p className="muted">No result parameters have been configured for this method.</p>}
          </div>
          {selectedSample.sample.status === 'Received' && ['Lab Technician', 'Station Chemist'].includes(user.role) && <button className="secondary-btn" onClick={startSample} disabled={busy}>▶ Start analysis</button>}
          {selectedSample.sample.status === 'In Progress' && ['Lab Supervisor', 'Station Chemist'].includes(user.role) && <form className="signature-form" onSubmit={signSample}>
            <h4>Electronic signature</h4><p className="muted">Signing records your identity, meaning, reason and timestamp. Approval requires all method results.</p>
            <div className="form-grid">
              <label>Action<select value={signForm.action} onChange={(event) => setSignForm({ ...signForm, action: event.target.value })}><option>Approved</option><option>Rejected</option></select></label>
              <label>Confirm password<input required type="password" value={signForm.password} onChange={(event) => setSignForm({ ...signForm, password: event.target.value })} /></label>
              <label className="span-two">Reason<input required minLength={8} value={signForm.reason} onChange={(event) => setSignForm({ ...signForm, reason: event.target.value })} placeholder="Document why this result is being approved or rejected." /></label>
            </div><button className={`signature-btn ${signForm.action === 'Rejected' ? 'reject' : ''}`} disabled={busy}>{signForm.action === 'Approved' ? '✓ Sign and approve' : 'Sign and reject'}</button>
          </form>}
          <div className="detail-section"><div className="section-heading"><h4>Chain of custody</h4><span className="muted">Append-only record</span></div>
            <div className="event-list">{selectedSample.events.map((event, index) => <div className="event-item" key={`${event.action}-${event.created_at}-${index}`}><span className="event-mark blue">·</span><div><strong>{event.action}</strong><p>{event.actor || 'System'}{Object.keys(event.details || {}).length ? ` · ${Object.entries(event.details).map(([key, value]) => `${key}: ${String(value)}`).join(' · ')}` : ''}</p><time>{formatDate(event.created_at, true)}</time></div></div>)}</div>
          </div>
          {selectedSample.signatures.length > 0 && <div className="detail-section"><div className="section-heading"><h4>Electronic signatures</h4></div>{selectedSample.signatures.map((signature, index) => <div className="signature-record" key={`${signature.signed_at}-${index}`}><strong>{signature.action} by {signature.signer}</strong><span>{signature.meaning}</span><span>Reason: {signature.reason}</span><time>{formatDate(signature.signed_at, true)}</time></div>)}</div>}
        </div>
      </Modal>}
    </div>
  )
}

function updateMethodParameter(
  setForm: Dispatch<SetStateAction<typeof initialMethodForm>>,
  form: typeof initialMethodForm,
  index: number,
  field: 'name' | 'unit' | 'lowerLimit' | 'upperLimit' | 'decimalPlaces' | 'formula',
  value: string | number
) {
  const parameters = form.parameters.map((parameter, itemIndex) => itemIndex === index ? { ...parameter, [field]: value } : parameter)
  setForm({ ...form, parameters })
}

const initialMethodForm = {
  name: '', module: 'Water Chemistry', standard: 'Site Standard', description: '',
  parameters: [{ name: '', unit: '', lowerLimit: '', upperLimit: '', decimalPlaces: 2, formula: '' }]
}

function Kpi({ label, value, delta, tone = '' }: { label: string; value: string | number; delta: string; tone?: string }) {
  return <article className="kpi-card"><span>{label}</span><strong>{value}</strong><em className={tone}>{delta}</em></article>
}

function StatusBadge({ status }: { status: Status }) {
  return <span className={`status-pill ${statusTone[status]}`}>{status}</span>
}

function SampleTable({ samples, onOpen }: { samples: Sample[]; onOpen: (sample: Sample) => void }) {
  if (!samples.length) return <EmptyState title="No samples found" text="Register a sample to begin tracking laboratory work." />
  return <div className="table-wrap"><table>
    <thead><tr><th>Sample ID</th><th>Location</th><th>Method</th><th>Status</th><th>Due</th><th>Chemist</th><th>Results</th><th /></tr></thead>
    <tbody>{samples.map((sample) => <tr key={sample.id} onClick={() => onOpen(sample)} className="clickable-row">
      <td><strong className="sample-code">{sample.sample_code}</strong></td><td>{sample.location}<small>{sample.material || sample.module}</small></td><td>{sample.method_name}</td><td><StatusBadge status={sample.status} /></td><td>{formatDate(sample.due_at, true)}</td><td>{sample.chemist || '—'}</td><td>{sample.result_count ?? 0} / {sample.parameter_count ?? 0}</td><td><button className="row-open" aria-label={`Open ${sample.sample_code}`}>›</button></td>
    </tr>)}</tbody>
  </table></div>
}

function Modal({ title, onClose, wide = false, children }: { title: string; onClose: () => void; wide?: boolean; children: ReactNode }) {
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal-header"><h3>{title}</h3><button className="close-btn" aria-label="Close dialog" onClick={onClose}>×</button></div>
      {children}
    </section>
  </div>
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return <div className="empty-state"><span>⌁</span><strong>{title}</strong><p>{text}</p></div>
}

function TrendChart({ points }: { points: TrendPoint[] }) {
  if (!points.length) return <EmptyState title="No result history for this parameter" text="Record a lab result or instrument reading to build a time trend." />
  const values = points.map((point) => Number(point.numeric_value))
  const minimum = Math.min(...values)
  const maximum = Math.max(...values)
  const range = maximum - minimum || Math.max(Math.abs(maximum) * 0.1, 1)
  const coordinates = points.map((point, index) => ({
    x: points.length === 1 ? 400 : 28 + index * (744 / (points.length - 1)),
    y: 154 - ((Number(point.numeric_value) - minimum) / range) * 132
  }))
  return <div className="trend-plot">
    <div className="trend-scale"><span>High {maximum}</span><span>Low {minimum}</span></div>
    <svg viewBox="0 0 800 170" role="img" aria-label={`Trend for ${points[0].parameter}`} preserveAspectRatio="none">
      {[22, 88, 154].map((y) => <line key={y} x1="25" x2="775" y1={y} y2={y} className="trend-gridline" />)}
      <polyline points={coordinates.map(({ x, y }) => `${x},${y}`).join(' ')} className="trend-line" />
      {coordinates.map((point, index) => <circle key={`${points[index].sample_code}-${index}`} cx={point.x} cy={point.y} r="4" className="trend-dot">
        <title>{`${points[index].sample_code}: ${points[index].numeric_value} ${points[index].unit} · ${formatDate(points[index].tested_at, true)}`}</title>
      </circle>)}
    </svg>
    <div className="trend-meta"><span>{points.length} readings · {points[0].unit || 'no unit'}</span><span>{formatDate(points[0].tested_at)} – {formatDate(points[points.length - 1].tested_at)}</span></div>
    <div className="trend-samples">{points.slice(-5).reverse().map((point) => <div key={`${point.sample_code}-${point.tested_at}`}><strong>{point.numeric_value} {point.unit}</strong><small>{point.sample_code} · {formatDate(point.tested_at)}</small></div>)}</div>
  </div>
}

function RoleCard({ role, text }: { role: Role; text: string }) {
  return <div className="role-card"><span className="role-dot" /><div><strong>{role}</strong><p>{text}</p></div></div>
}

function ConnectorCard({ connector, values, editable, busy, onChange, onSave }: {
  connector: Connector
  values?: { endpoint: string; mapping: string; enabled: boolean }
  editable: boolean
  busy: boolean
  onChange: (values: { endpoint: string; mapping: string; enabled: boolean }) => void
  onSave: () => void
}) {
  if (!values) return null
  return <article className="panel connector-card"><div className="panel-header"><div><h3>{connector.connector_type}</h3><p className="muted">{connector.connector_type === 'ERP' ? 'Chemical inventory export configuration' : 'Plant historian / DCS data mapping'}</p></div><span className={`status-pill ${connector.enabled ? 'progress' : 'received'}`}>{connector.enabled ? 'Configured' : 'Not configured'}</span></div>
    {editable ? <div className="connector-fields">
      <label>Endpoint<input value={values.endpoint} onChange={(event) => onChange({ ...values, endpoint: event.target.value })} placeholder={connector.connector_type === 'ERP' ? 'ERP API URL' : 'Historian API endpoint'} /></label>
      <label>Tag mapping (JSON)<textarea rows={3} value={values.mapping} onChange={(event) => onChange({ ...values, mapping: event.target.value })} placeholder={'{\n  "boiler_feedwater_ph": "Unit2.BFW.pH"\n}'} /></label>
      <label className="toggle-label"><input type="checkbox" checked={values.enabled} onChange={(event) => onChange({ ...values, enabled: event.target.checked })} /> Enable configuration</label>
      <button className="secondary-btn" onClick={onSave} disabled={busy}>Save connector settings</button>
    </div> : <p className="muted">{connector.endpoint || 'Ask a Station Chemist to configure this connector.'}</p>}
    <small className="connector-disclaimer">Configuration only — vendor adapter and live connectivity still require station-specific validation.</small>
  </article>
}

function UserList({ onError }: { onError: (message: string) => void }) {
  const [users, setUsers] = useState<{ id: number; full_name: string; email: string; role: Role; active: boolean }[]>([])
  useEffect(() => {
    void api<{ users: typeof users }>('/users').then((response) => setUsers(response.users))
      .catch((cause) => onError(cause instanceof Error ? cause.message : 'Unable to load users.'))
  }, [onError])
  return <div className="panel user-list"><div className="panel-header"><div><h3>LabIMS accounts</h3><p className="muted">Active accounts and assigned roles.</p></div><span className="badge">{users.length} users</span></div>
    {users.map((account) => <div className="user-row" key={account.id}><span className="avatar">{account.full_name.charAt(0).toUpperCase()}</span><div><strong>{account.full_name}</strong><small>{account.email}</small></div><span className="role-chip">{account.role}</span><span className={`account-state ${account.active ? 'is-active' : ''}`}>{account.active ? 'Active' : 'Disabled'}</span></div>)}
  </div>
}
