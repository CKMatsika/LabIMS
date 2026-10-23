import 'dotenv/config'
import express from 'express'
import helmet from 'helmet'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import pg from 'pg'
import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const { Pool } = pg
const app = express()
const port = Number(process.env.PORT ?? process.env.API_PORT ?? 3001)
const host = process.env.API_HOST ?? (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1')
const jwtSecret = process.env.JWT_SECRET || randomBytes(32).toString('hex')
const production = process.env.NODE_ENV === 'production'
const directory = path.dirname(fileURLToPath(import.meta.url))
const distDirectory = path.resolve(directory, '..', 'dist')
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX ?? 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: true } : undefined
})

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

const roles = ['Lab Technician', 'Lab Supervisor', 'Station Chemist', 'Plant Management']

function requireFields(body, fields) {
  for (const field of fields) {
    if (typeof body?.[field] !== 'string' || body[field].trim() === '') {
      throw new HttpError(400, `${field} is required.`)
    }
  }
}

function makeToken(user) {
  return jwt.sign({ sub: String(user.id), role: user.role }, jwtSecret, { expiresIn: '8h' })
}

function publicUser(user) {
  return { id: user.id, fullName: user.full_name, email: user.email, role: user.role }
}

function authenticate(req, _res, next) {
  const authorization = req.headers.authorization
  if (!authorization?.startsWith('Bearer ')) return next(new HttpError(401, 'Sign in to continue.'))

  try {
    const claims = jwt.verify(authorization.slice(7), jwtSecret)
    req.auth = { id: Number(claims.sub), role: claims.role }
    next()
  } catch {
    next(new HttpError(401, 'Your session has expired. Sign in again.'))
  }
}

function allowRoles(...allowedRoles) {
  return (req, _res, next) => {
    if (!req.auth || !allowedRoles.includes(req.auth.role)) {
      return next(new HttpError(403, 'Your role does not have permission to perform this action.'))
    }
    next()
  }
}

async function transaction(work) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await work(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

class MissingFormulaInput extends Error {}

function tokenizeFormula(expression) {
  if (typeof expression !== 'string' || expression.length > 200) {
    throw new HttpError(400, 'A calculation formula must be 200 characters or fewer.')
  }
  const tokens = []
  const pattern = /\s*(\d*\.?\d+|[A-Za-z_][A-Za-z0-9_]*|[()+\-*/])/y
  let offset = 0
  const source = expression.trim()
  if (!source) throw new HttpError(400, 'A calculation formula cannot be empty.')
  while (offset < source.length) {
    pattern.lastIndex = offset
    const match = pattern.exec(source)
    if (!match) throw new HttpError(400, 'Formula supports only numbers, parameter variables, +, -, *, /, and parentheses.')
    tokens.push(match[1])
    offset = pattern.lastIndex
  }
  return tokens
}

function formulaVariables(expression) {
  return tokenizeFormula(expression).filter((token) => /^[A-Za-z_]/.test(token))
}

function evaluateFormula(expression, variables) {
  const tokens = tokenizeFormula(expression)
  let cursor = 0
  const primary = () => {
    const token = tokens[cursor++]
    if (token === undefined) throw new HttpError(400, 'Formula is incomplete.')
    if (token === '(') {
      const value = addition()
      if (tokens[cursor++] !== ')') throw new HttpError(400, 'Formula parentheses do not match.')
      return value
    }
    if (/^[A-Za-z_]/.test(token)) {
      if (!Object.hasOwn(variables, token)) throw new MissingFormulaInput(`Formula input "${token}" has not been recorded.`)
      return Number(variables[token])
    }
    const value = Number(token)
    if (!Number.isFinite(value)) throw new HttpError(400, 'Formula contains an invalid number.')
    return value
  }
  const unary = () => {
    if (tokens[cursor] === '+') { cursor++; return unary() }
    if (tokens[cursor] === '-') { cursor++; return -unary() }
    return primary()
  }
  const multiplication = () => {
    let value = unary()
    while (tokens[cursor] === '*' || tokens[cursor] === '/') {
      const operator = tokens[cursor++]
      const right = unary()
      if (operator === '/' && right === 0) throw new HttpError(422, 'A configured calculation cannot divide by zero.')
      value = operator === '*' ? value * right : value / right
    }
    return value
  }
  const addition = () => {
    let value = multiplication()
    while (tokens[cursor] === '+' || tokens[cursor] === '-') {
      const operator = tokens[cursor++]
      const right = multiplication()
      value = operator === '+' ? value + right : value - right
    }
    return value
  }
  const result = addition()
  if (cursor !== tokens.length || !Number.isFinite(result)) throw new HttpError(400, 'Formula is invalid or produces a non-finite result.')
  return result
}

function validateCalculationParameters(parameters) {
  const names = new Set()
  const formulas = new Map()
  for (const [index, parameter] of parameters.entries()) {
    const name = typeof parameter?.name === 'string' ? parameter.name.trim() : ''
    requireFields({ name }, ['name'])
    const variable = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
    if (!/^[a-z_][a-z0-9_]*$/.test(variable) || names.has(variable)) {
      throw new HttpError(400, `Parameter ${index + 1} needs a unique name that can be used in formulas.`)
    }
    names.add(variable)
    if (parameter.formula != null && typeof parameter.formula !== 'string') {
      throw new HttpError(400, `Formula for ${name} must be text.`)
    }
    const formula = parameter.formula?.trim() ?? ''
    if (formula) {
      const dependencies = formulaVariables(formula)
      for (const dependency of dependencies) {
        if (!names.has(dependency) && !parameters.some((item) =>
          typeof item?.name === 'string' &&
          item.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') === dependency
        )) {
          throw new HttpError(400, `Formula for ${name} references unknown parameter "${dependency}".`)
        }
      }
      const sampleValues = Object.fromEntries(parameters.map((item) => {
        const variableName = item.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
        return [variableName, 1]
      }))
      evaluateFormula(formula, sampleValues)
      formulas.set(variable, { formula, dependencies })
    }
  }
  const visiting = new Set()
  const visited = new Set()
  const visit = (variable) => {
    if (visiting.has(variable)) throw new HttpError(400, 'Calculation formulas cannot contain circular references.')
    if (visited.has(variable)) return
    visiting.add(variable)
    for (const dependency of formulas.get(variable)?.dependencies ?? []) {
      if (formulas.has(dependency)) visit(dependency)
    }
    visiting.delete(variable)
    visited.add(variable)
  }
  for (const variable of formulas.keys()) visit(variable)
  return formulas
}

async function writeAudit(client, actorId, action, entityType, entityId, details = {}) {
  await client.query('SELECT pg_advisory_xact_lock($1)', [418275])
  const previous = await client.query(
    'SELECT record_hash FROM audit_events ORDER BY id DESC LIMIT 1'
  )
  const previousHash = previous.rows[0]?.record_hash ?? 'GENESIS'
  const createdAt = new Date().toISOString()
  const record = {
    actorId: actorId == null ? null : String(actorId),
    action,
    entityType,
    entityId: String(entityId),
    details,
    previousHash,
    createdAt
  }
  const recordHash = createHash('sha256').update(canonicalJson(record)).digest('hex')
  await client.query(
    `INSERT INTO audit_events
      (actor_id, action, entity_type, entity_id, details, previous_hash, record_hash, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [actorId ?? null, action, entityType, String(entityId), details, previousHash, recordHash, createdAt]
  )
}

async function writeSampleEvent(client, sampleId, actorId, action, details = {}) {
  await client.query(
    'INSERT INTO sample_events (sample_id, actor_id, action, details) VALUES ($1, $2, $3, $4)',
    [sampleId, actorId ?? null, action, details]
  )
}

async function recalculateDerivedResults(client, sampleId, methodId, actorId) {
  const result = await client.query(`
    SELECT p.id, p.name, p.variable_name, p.formula, p.decimal_places,
      r.id AS result_id, r.numeric_value, r.calculated
    FROM test_parameters p
    LEFT JOIN test_results r ON r.parameter_id = p.id AND r.sample_id = $1
    WHERE p.method_id = $2 ORDER BY p.id
  `, [sampleId, methodId])
  const values = Object.create(null)
  const computed = new Set()
  const pending = new Map()
  for (const parameter of result.rows) {
    if (parameter.formula) pending.set(parameter.id, parameter)
    else if (parameter.result_id) values[parameter.variable_name] = Number(parameter.numeric_value)
  }

  let madeProgress = true
  while (pending.size && madeProgress) {
    madeProgress = false
    for (const [parameterId, parameter] of pending) {
      const dependencies = formulaVariables(parameter.formula)
      if (!dependencies.every((dependency) => Object.hasOwn(values, dependency))) continue
      const rawValue = evaluateFormula(parameter.formula, values)
      const numericValue = Number(rawValue.toFixed(Number(parameter.decimal_places)))
      const saved = await client.query(`
        INSERT INTO test_results
          (sample_id, parameter_id, numeric_value, entered_by, comments, calculated, formula_snapshot)
        VALUES ($1, $2, $3, $4, 'Auto-calculated from configured method formula', TRUE, $5)
        ON CONFLICT (sample_id, parameter_id) DO UPDATE
          SET numeric_value = EXCLUDED.numeric_value, entered_by = EXCLUDED.entered_by,
              comments = EXCLUDED.comments, calculated = TRUE,
              formula_snapshot = EXCLUDED.formula_snapshot, tested_at = NOW()
        RETURNING id
      `, [sampleId, parameterId, numericValue, actorId, parameter.formula])
      values[parameter.variable_name] = numericValue
      computed.add(parameterId)
      pending.delete(parameterId)
      const details = { parameter: parameter.name, value: numericValue, formula: parameter.formula }
      await writeSampleEvent(client, sampleId, actorId, 'Derived result calculated', details)
      await writeAudit(client, actorId, 'Derived result calculated', 'test_result', saved.rows[0].id, details)
      madeProgress = true
    }
  }

  for (const [parameterId, parameter] of pending) {
    if (!parameter.calculated) continue
    await client.query('DELETE FROM test_results WHERE id = $1', [parameter.result_id])
    const details = { parameter: parameter.name, reason: 'Required formula inputs are incomplete.' }
    await writeSampleEvent(client, sampleId, actorId, 'Derived result invalidated', details)
    await writeAudit(client, actorId, 'Derived result invalidated', 'test_result', parameter.result_id, details)
  }
  return computed.size
}

async function initializeDatabase() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required. Copy .env.example to .env and configure PostgreSQL.')
  }
  if (production && !process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET must be set in production.')
  }

  await pool.query(await readFile(path.join(directory, 'schema.sql'), 'utf8'))
  const sampleCount = await pool.query('SELECT COUNT(*)::int AS count FROM samples')
  if (sampleCount.rows[0].count === 0) {
    await pool.query(`
      INSERT INTO samples (sample_code, location, material, method_id, status, chemist, due_at)
      SELECT seed.sample_code, seed.location, seed.material, methods.id, seed.status, seed.chemist, seed.due_at
      FROM (VALUES
        ('BL-2048', 'Unit 2 Boiler Feedwater', 'Boiler Feedwater', 'Boiler Feedwater', 'In Progress', 'N. Moyo', NOW() + INTERVAL '2 hours'),
        ('CL-1187', 'Coal Yard Intake', 'Coal', 'Coal Proximate Analysis', 'Received', 'T. Ncube', NOW() + INTERVAL '4 hours'),
        ('OL-7731', 'Transformer Bay 3', 'Transformer Oil', 'Transformer Oil DGA', 'Received', 'S. Chuma', NOW() + INTERVAL '6 hours'),
        ('GA-4402', 'Hydrogen Plant', 'Hydrogen', 'Hydrogen Purity', 'In Progress', 'R. Banda', NOW() + INTERVAL '8 hours')
      ) AS seed(sample_code, location, material, method_name, status, chemist, due_at)
      JOIN test_methods methods ON methods.name = seed.method_name
      ON CONFLICT (sample_code) DO NOTHING
    `)
    await pool.query(`
      INSERT INTO sample_events (sample_id, action, details, created_at)
      SELECT s.id, 'Sample registered', '{"source":"local demo seed"}'::jsonb, s.created_at
      FROM samples s
      WHERE s.sample_code IN ('BL-2048', 'CL-1187', 'OL-7731', 'GA-4402')
        AND NOT EXISTS (
          SELECT 1 FROM sample_events e
          WHERE e.sample_id = s.id AND e.action = 'Sample registered'
        )
    `)
  }
}

app.disable('x-powered-by')
app.use(helmet())
app.use(express.json({ limit: '1mb' }))

app.get('/api/health', async (_req, res) => {
  await pool.query('SELECT 1')
  res.json({ status: 'ok', database: 'connected' })
})

app.get('/api/bootstrap/status', async (_req, res) => {
  const result = await pool.query('SELECT EXISTS (SELECT 1 FROM users) AS has_users')
  res.json({ needsAdmin: !result.rows[0].has_users })
})

app.post('/api/bootstrap', async (req, res) => {
  requireFields(req.body, ['fullName', 'email', 'password'])
  const fullName = req.body.fullName.trim()
  const email = req.body.email.trim().toLowerCase()
  if (req.body.password.length < 12) throw new HttpError(400, 'Use a password with at least 12 characters.')
  if (fullName.length > 120 || email.length > 254) throw new HttpError(400, 'Name or email is too long.')

  const user = await transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [418276])
    const existing = await client.query('SELECT id FROM users LIMIT 1')
    if (existing.rowCount) throw new HttpError(409, 'The first administrator has already been created.')
    const inserted = await client.query(
      `INSERT INTO users (full_name, email, password_hash, role)
       VALUES ($1, $2, $3, 'Station Chemist') RETURNING id, full_name, email, role`,
      [fullName, email, await bcrypt.hash(req.body.password, 12)]
    )
    const created = inserted.rows[0]
    await writeAudit(client, created.id, 'Initial administrator created', 'user', created.id, { role: created.role })
    return created
  })
  res.status(201).json({ token: makeToken(user), user: publicUser(user) })
})

app.post('/api/auth/login', async (req, res) => {
  requireFields(req.body, ['email', 'password'])
  const result = await pool.query(
    'SELECT id, full_name, email, password_hash, role, active FROM users WHERE email = $1',
    [req.body.email.trim().toLowerCase()]
  )
  const user = result.rows[0]
  if (!user || !user.active || !(await bcrypt.compare(req.body.password, user.password_hash))) {
    throw new HttpError(401, 'Email or password is incorrect.')
  }
  res.json({ token: makeToken(user), user: publicUser(user) })
})

app.use('/api', authenticate)

app.get('/api/auth/me', async (req, res) => {
  const result = await pool.query(
    'SELECT id, full_name, email, role FROM users WHERE id = $1 AND active = TRUE',
    [req.auth.id]
  )
  if (!result.rowCount) throw new HttpError(401, 'This account is no longer active.')
  res.json({ user: publicUser(result.rows[0]) })
})

app.get('/api/dashboard', async (_req, res) => {
  const [totals, trend] = await Promise.all([
    pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status IN ('Received', 'In Progress'))::int AS active_samples,
        COUNT(*) FILTER (WHERE status = 'Approved' AND updated_at >= date_trunc('month', NOW()))::int AS coa_issued,
        COUNT(*) FILTER (WHERE status = 'Rejected')::int AS rejected_samples,
        COUNT(*)::int AS total_samples
      FROM samples
    `),
    pool.query(`
      SELECT to_char(months.month, 'Mon') AS label,
        COALESCE(ROUND(100.0 * COUNT(r.id) FILTER (
          WHERE (p.lower_limit IS NOT NULL OR p.upper_limit IS NOT NULL)
            AND (p.lower_limit IS NULL OR r.numeric_value >= p.lower_limit)
            AND (p.upper_limit IS NULL OR r.numeric_value <= p.upper_limit)
        ) / NULLIF(COUNT(r.id) FILTER (WHERE p.lower_limit IS NOT NULL OR p.upper_limit IS NOT NULL), 0), 1), 0) AS compliance
      FROM generate_series(date_trunc('month', NOW()) - INTERVAL '5 months', date_trunc('month', NOW()), INTERVAL '1 month') months(month)
      LEFT JOIN test_results r ON date_trunc('month', r.tested_at) = months.month
      LEFT JOIN test_parameters p ON p.id = r.parameter_id
      GROUP BY months.month
      ORDER BY months.month
    `)
  ])
  const counts = totals.rows[0]
  const compliance = await pool.query(`
    SELECT COALESCE(ROUND(100.0 * COUNT(*) FILTER (
      WHERE (p.lower_limit IS NOT NULL OR p.upper_limit IS NOT NULL)
        AND (p.lower_limit IS NULL OR r.numeric_value >= p.lower_limit)
        AND (p.upper_limit IS NULL OR r.numeric_value <= p.upper_limit)
    ) / NULLIF(COUNT(*) FILTER (WHERE p.lower_limit IS NOT NULL OR p.upper_limit IS NOT NULL), 0), 1), 0) AS rate
    FROM test_results r JOIN test_parameters p ON p.id = r.parameter_id
  `)
  const uptime = await pool.query(`
    SELECT COUNT(*) FILTER (WHERE status = 'Connected')::int AS connected,
      COUNT(*)::int AS total FROM instruments
  `)
  res.json({
    compliance: Number(compliance.rows[0].rate),
    activeSamples: counts.active_samples,
    coaIssued: counts.coa_issued,
    rejectedSamples: counts.rejected_samples,
    totalSamples: counts.total_samples,
    instrumentUptime: uptime.rows[0].total
      ? Math.round((uptime.rows[0].connected / uptime.rows[0].total) * 1000) / 10
      : null,
    instrumentsConnected: uptime.rows[0].connected,
    instrumentsTotal: uptime.rows[0].total,
    trend: trend.rows.map((row) => ({ label: row.label, compliance: Number(row.compliance) }))
  })
})

app.get('/api/templates', async (_req, res) => {
  const result = await pool.query(`
    SELECT id, name, module, standard, description
    FROM test_methods WHERE active = TRUE ORDER BY module, name
  `)
  res.json({ templates: result.rows })
})

app.get('/api/samples', async (req, res) => {
  const search = String(req.query.search ?? '').trim()
  const status = String(req.query.status ?? '').trim()
  const result = await pool.query(`
    SELECT s.id, s.sample_code, s.location, s.material, s.status, s.collected_at,
      s.due_at, s.chemist, m.name AS method_name, m.module,
      COUNT(DISTINCT r.id)::int AS result_count,
      COUNT(DISTINCT p.id)::int AS parameter_count
    FROM samples s
    JOIN test_methods m ON m.id = s.method_id
    LEFT JOIN test_results r ON r.sample_id = s.id
    LEFT JOIN test_parameters p ON p.method_id = m.id
    WHERE ($1 = '' OR s.sample_code ILIKE '%' || $1 || '%' OR s.location ILIKE '%' || $1 || '%' OR m.name ILIKE '%' || $1 || '%')
      AND ($2 = '' OR s.status = $2)
    GROUP BY s.id, m.id
    ORDER BY s.created_at DESC
    LIMIT 250
  `, [search, status])
  res.json({ samples: result.rows })
})

app.get('/api/samples/:id', async (req, res) => {
  const sample = await pool.query(`
    SELECT s.*, m.name AS method_name, m.module, m.standard
    FROM samples s JOIN test_methods m ON m.id = s.method_id
    WHERE s.id = $1
  `, [req.params.id])
  if (!sample.rowCount) throw new HttpError(404, 'Sample not found.')
  const [parameters, events, signatures] = await Promise.all([
    pool.query(`
      SELECT p.id, p.name, p.variable_name, p.unit, p.lower_limit, p.upper_limit, p.decimal_places,
        p.formula, r.numeric_value, r.comments, r.calculated, r.formula_snapshot,
        r.tested_at, u.full_name AS entered_by
      FROM test_parameters p
      LEFT JOIN test_results r ON r.parameter_id = p.id AND r.sample_id = $1
      LEFT JOIN users u ON u.id = r.entered_by
      WHERE p.method_id = $2 ORDER BY p.id
    `, [req.params.id, sample.rows[0].method_id]),
    pool.query(`
      SELECT e.action, e.details, e.created_at, u.full_name AS actor
      FROM sample_events e LEFT JOIN users u ON u.id = e.actor_id
      WHERE e.sample_id = $1 ORDER BY e.created_at DESC
    `, [req.params.id]),
    pool.query(`
      SELECT e.action, e.meaning, e.reason, e.signed_at, u.full_name AS signer
      FROM electronic_signatures e JOIN users u ON u.id = e.signer_id
      WHERE e.sample_id = $1 ORDER BY e.signed_at DESC
    `, [req.params.id])
  ])
  res.json({ sample: sample.rows[0], parameters: parameters.rows, events: events.rows, signatures: signatures.rows })
})

app.post('/api/samples', allowRoles('Lab Technician', 'Station Chemist'), async (req, res) => {
  requireFields(req.body, ['location', 'methodId'])
  const methodId = Number(req.body.methodId)
  if (!Number.isSafeInteger(methodId) || methodId < 1) throw new HttpError(400, 'Select a valid test method.')
  const result = await transaction(async (client) => {
    const method = await client.query('SELECT id FROM test_methods WHERE id = $1 AND active = TRUE', [methodId])
    if (!method.rowCount) throw new HttpError(400, 'The selected test method is unavailable.')
    const sampleCode = (req.body.sampleCode?.trim() || `HW-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${randomBytes(3).toString('hex').toUpperCase()}`)
    if (sampleCode.length > 64) throw new HttpError(400, 'Sample ID must be 64 characters or fewer.')
    const inserted = await client.query(`
      INSERT INTO samples (sample_code, location, material, method_id, collected_at, due_at, chemist, notes, created_by)
      VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, NOW()), $6::timestamptz, $7, $8, $9)
      RETURNING id, sample_code, location, material, method_id, status, collected_at, due_at, chemist, notes
    `, [
      sampleCode,
      req.body.location.trim(),
      String(req.body.material ?? '').trim(),
      methodId,
      req.body.collectedAt || null,
      req.body.dueAt || null,
      String(req.body.chemist ?? '').trim(),
      String(req.body.notes ?? '').trim(),
      req.auth.id
    ])
    const sample = inserted.rows[0]
    await writeSampleEvent(client, sample.id, req.auth.id, 'Sample registered', { sampleCode })
    await writeAudit(client, req.auth.id, 'Sample registered', 'sample', sample.id, { sampleCode, location: sample.location })
    return sample
  })
  res.status(201).json({ sample: result })
})

app.patch('/api/samples/:id/status', allowRoles('Lab Technician', 'Station Chemist'), async (req, res) => {
  if (req.body.status !== 'In Progress') throw new HttpError(400, 'Use an electronic signature to approve or reject a sample.')
  const sample = await transaction(async (client) => {
    const current = await client.query('SELECT id, status FROM samples WHERE id = $1 FOR UPDATE', [req.params.id])
    if (!current.rowCount) throw new HttpError(404, 'Sample not found.')
    if (current.rows[0].status !== 'Received') throw new HttpError(409, 'Only received samples can be started.')
    const updated = await client.query(
      "UPDATE samples SET status = 'In Progress', updated_at = NOW() WHERE id = $1 RETURNING id, sample_code, status",
      [req.params.id]
    )
    await writeSampleEvent(client, req.params.id, req.auth.id, 'Analysis started')
    await writeAudit(client, req.auth.id, 'Analysis started', 'sample', req.params.id, {})
    return updated.rows[0]
  })
  res.json({ sample })
})

app.put('/api/samples/:id/results', allowRoles('Lab Technician', 'Station Chemist'), async (req, res) => {
  const parameterId = Number(req.body.parameterId)
  const numericValue = Number(req.body.value)
  if (!Number.isSafeInteger(parameterId) || parameterId < 1 || req.body.value == null ||
      (typeof req.body.value === 'string' && !req.body.value.trim()) || !Number.isFinite(numericValue)) {
    throw new HttpError(400, 'Choose a parameter and enter a valid numeric result.')
  }
  const result = await transaction(async (client) => {
    const sample = await client.query('SELECT id, method_id, status FROM samples WHERE id = $1 FOR UPDATE', [req.params.id])
    if (!sample.rowCount) throw new HttpError(404, 'Sample not found.')
    if (sample.rows[0].status !== 'In Progress') throw new HttpError(409, 'Start the sample before entering results.')
    const parameter = await client.query(
      'SELECT id, name, lower_limit, upper_limit, formula FROM test_parameters WHERE id = $1 AND method_id = $2',
      [parameterId, sample.rows[0].method_id]
    )
    if (!parameter.rowCount) throw new HttpError(400, 'That parameter does not belong to this sample method.')
    if (parameter.rows[0].formula) throw new HttpError(400, 'This parameter is calculated automatically from the configured method formula.')
    const saved = await client.query(`
      INSERT INTO test_results (sample_id, parameter_id, numeric_value, entered_by, comments, calculated, formula_snapshot)
      VALUES ($1, $2, $3, $4, $5, FALSE, NULL)
      ON CONFLICT (sample_id, parameter_id) DO UPDATE
        SET numeric_value = EXCLUDED.numeric_value, entered_by = EXCLUDED.entered_by,
            tested_at = NOW(), comments = EXCLUDED.comments, calculated = FALSE,
            formula_snapshot = NULL
      RETURNING id, numeric_value, tested_at
    `, [req.params.id, parameterId, numericValue, req.auth.id, String(req.body.comments ?? '').trim()])
    const p = parameter.rows[0]
    const below = p.lower_limit !== null && numericValue < Number(p.lower_limit)
    const above = p.upper_limit !== null && numericValue > Number(p.upper_limit)
    const withinLimits = !below && !above
    const details = { parameter: p.name, value: numericValue, withinLimits }
    await writeSampleEvent(client, req.params.id, req.auth.id, 'Result recorded', details)
    await writeAudit(client, req.auth.id, 'Result recorded', 'sample', req.params.id, details)
    await recalculateDerivedResults(client, req.params.id, sample.rows[0].method_id, req.auth.id)
    return { ...saved.rows[0], withinLimits, limits: { lower: p.lower_limit, upper: p.upper_limit } }
  })
  res.json({ result })
})

app.post('/api/samples/:id/signatures', allowRoles('Lab Supervisor', 'Station Chemist'), async (req, res) => {
  requireFields(req.body, ['action', 'reason', 'password'])
  const action = req.body.action
  if (!['Approved', 'Rejected'].includes(action)) throw new HttpError(400, 'Signature action must be Approved or Rejected.')
  if (req.body.reason.trim().length < 8) throw new HttpError(400, 'Enter a reason of at least 8 characters.')
  const signer = await pool.query('SELECT password_hash FROM users WHERE id = $1 AND active = TRUE', [req.auth.id])
  if (!signer.rowCount || !(await bcrypt.compare(req.body.password, signer.rows[0].password_hash))) {
    throw new HttpError(401, 'Password confirmation failed.')
  }
  const sample = await transaction(async (client) => {
    const current = await client.query('SELECT id, sample_code, status, method_id FROM samples WHERE id = $1 FOR UPDATE', [req.params.id])
    if (!current.rowCount) throw new HttpError(404, 'Sample not found.')
    if (current.rows[0].status !== 'In Progress') throw new HttpError(409, 'Only in-progress samples can be signed.')
    if (action === 'Approved') {
      const completion = await client.query(`
        SELECT COUNT(*) FILTER (WHERE r.id IS NULL)::int AS missing
        FROM test_parameters p
        LEFT JOIN test_results r ON r.parameter_id = p.id AND r.sample_id = $1
        WHERE p.method_id = $2
      `, [req.params.id, current.rows[0].method_id])
      if (completion.rows[0].missing > 0) throw new HttpError(409, 'Record a result for every method parameter before approving.')
    }
    const updated = await client.query(
      'UPDATE samples SET status = $2, updated_at = NOW() WHERE id = $1 RETURNING id, sample_code, status',
      [req.params.id, action]
    )
    await client.query(
      `INSERT INTO electronic_signatures (sample_id, signer_id, action, meaning, reason)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.params.id, req.auth.id, action, `I ${action.toLowerCase()} this laboratory record.`, req.body.reason.trim()]
    )
    const details = { action, reason: req.body.reason.trim() }
    await writeSampleEvent(client, req.params.id, req.auth.id, `Sample ${action.toLowerCase()}`, details)
    await writeAudit(client, req.auth.id, `Sample ${action.toLowerCase()}`, 'sample', req.params.id, details)
    return updated.rows[0]
  })
  res.json({ sample })
})

app.get('/api/methods', async (_req, res) => {
  const methods = await pool.query(`
    SELECT m.id, m.name, m.module, m.standard, m.description, m.active,
      COALESCE(json_agg(json_build_object(
        'id', p.id, 'name', p.name, 'unit', p.unit, 'lowerLimit', p.lower_limit,
        'upperLimit', p.upper_limit, 'decimalPlaces', p.decimal_places, 'formula', p.formula
      ) ORDER BY p.id) FILTER (WHERE p.id IS NOT NULL), '[]'::json) AS parameters
    FROM test_methods m
    LEFT JOIN test_parameters p ON p.method_id = m.id
    WHERE m.active = TRUE
    GROUP BY m.id ORDER BY m.module, m.name
  `)
  res.json({ methods: methods.rows })
})

app.post('/api/methods', allowRoles('Station Chemist'), async (req, res) => {
  requireFields(req.body, ['name', 'module', 'standard'])
  const validModules = ['Water Chemistry', 'Coal / Combustion', 'Oil & Fuel', 'Gas Analysis']
  if (!validModules.includes(req.body.module)) throw new HttpError(400, 'Choose a valid laboratory module.')
  if (!Array.isArray(req.body.parameters) || req.body.parameters.length < 1 || req.body.parameters.length > 40) {
    throw new HttpError(400, 'Add between 1 and 40 test parameters.')
  }
  validateCalculationParameters(req.body.parameters)
  const method = await transaction(async (client) => {
    const inserted = await client.query(`
      INSERT INTO test_methods (name, module, standard, description, created_by)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, name, module, standard, description
    `, [req.body.name.trim(), req.body.module, req.body.standard.trim(), String(req.body.description ?? '').trim(), req.auth.id])
    const created = inserted.rows[0]
    for (const [index, parameter] of req.body.parameters.entries()) {
      requireFields(parameter, ['name'])
      const lower = parameter.lowerLimit === '' || parameter.lowerLimit == null ? null : Number(parameter.lowerLimit)
      const upper = parameter.upperLimit === '' || parameter.upperLimit == null ? null : Number(parameter.upperLimit)
      const decimals = Number(parameter.decimalPlaces ?? 2)
      if ((lower !== null && !Number.isFinite(lower)) || (upper !== null && !Number.isFinite(upper)) ||
          !Number.isInteger(decimals) || decimals < 0 || decimals > 6 || (lower !== null && upper !== null && lower > upper)) {
        throw new HttpError(400, `Invalid limits or precision for parameter ${index + 1}.`)
      }
      await client.query(
        'INSERT INTO test_parameters (method_id, name, unit, lower_limit, upper_limit, decimal_places, formula) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [created.id, parameter.name.trim(), String(parameter.unit ?? '').trim(), lower, upper, decimals, parameter.formula?.trim() || null]
      )
    }
    await writeAudit(client, req.auth.id, 'Test method created', 'test_method', created.id, { name: created.name })
    return created
  })
  res.status(201).json({ method })
})

app.get('/api/trends', async (req, res) => {
  const parameterId = Number(req.query.parameterId)
  const days = Number(req.query.days ?? 90)
  if (!Number.isSafeInteger(parameterId) || parameterId < 1) throw new HttpError(400, 'Select a valid test parameter.')
  if (!Number.isSafeInteger(days) || days < 1 || days > 3650) throw new HttpError(400, 'Trend period must be between 1 and 3650 days.')
  const result = await pool.query(`
    SELECT r.tested_at, r.numeric_value, r.calculated, s.sample_code, s.location,
      p.name AS parameter, p.unit, p.lower_limit, p.upper_limit
    FROM test_results r
    JOIN samples s ON s.id = r.sample_id
    JOIN test_parameters p ON p.id = r.parameter_id
    WHERE r.parameter_id = $1 AND r.tested_at >= NOW() - make_interval(days => $2::int)
    ORDER BY r.tested_at
    LIMIT 500
  `, [parameterId, days])
  res.json({ points: result.rows })
})

app.get('/api/compliance', async (_req, res) => {
  const [audit, exceptions, signatures] = await Promise.all([
    pool.query(`
      SELECT a.id, a.action, a.entity_type, a.entity_id, a.details, a.created_at, u.full_name AS actor
      FROM audit_events a LEFT JOIN users u ON u.id = a.actor_id
      ORDER BY a.id DESC LIMIT 100
    `),
    pool.query(`
      SELECT s.sample_code, s.location, m.name AS method_name, p.name AS parameter,
        r.numeric_value, p.unit, p.lower_limit, p.upper_limit, r.tested_at
      FROM test_results r
      JOIN samples s ON s.id = r.sample_id
      JOIN test_parameters p ON p.id = r.parameter_id
      JOIN test_methods m ON m.id = p.method_id
      WHERE (p.lower_limit IS NOT NULL AND r.numeric_value < p.lower_limit)
        OR (p.upper_limit IS NOT NULL AND r.numeric_value > p.upper_limit)
      ORDER BY r.tested_at DESC LIMIT 100
    `),
    pool.query(`
      SELECT e.sample_id, s.sample_code, e.action, e.meaning, e.reason, e.signed_at, u.full_name AS signer
      FROM electronic_signatures e
      JOIN samples s ON s.id = e.sample_id
      JOIN users u ON u.id = e.signer_id
      ORDER BY e.signed_at DESC LIMIT 50
    `)
  ])
  res.json({ audit: audit.rows, exceptions: exceptions.rows, signatures: signatures.rows })
})

app.get('/api/audit/verify', async (_req, res) => {
  const rows = await pool.query(`
    SELECT id, actor_id, action, entity_type, entity_id, details, previous_hash, record_hash, created_at
    FROM audit_events ORDER BY id
  `)
  let previousHash = 'GENESIS'
  for (const row of rows.rows) {
    const record = {
      actorId: row.actor_id == null ? null : String(row.actor_id),
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      details: row.details,
      previousHash,
      createdAt: new Date(row.created_at).toISOString()
    }
    const expectedHash = createHash('sha256').update(canonicalJson(record)).digest('hex')
    if (row.previous_hash !== previousHash || row.record_hash !== expectedHash) {
      return res.json({ valid: false, checked: row.id })
    }
    previousHash = row.record_hash
  }
  res.json({ valid: true, checked: rows.rowCount })
})

app.get('/api/instruments', async (_req, res) => {
  const [instruments, connectors, readings] = await Promise.all([
    pool.query(`
      SELECT i.*, (SELECT MAX(observed_at) FROM instrument_readings r WHERE r.instrument_id = i.id) AS last_reading
      FROM instruments i ORDER BY i.name
    `),
    pool.query('SELECT connector_type, endpoint, tag_mapping, enabled, updated_at FROM integration_connectors ORDER BY connector_type'),
    pool.query(`
      SELECT r.id, r.tag, r.value, r.unit, r.quality, r.observed_at, i.name AS instrument_name,
        s.sample_code, u.full_name AS recorded_by
      FROM instrument_readings r
      LEFT JOIN instruments i ON i.id = r.instrument_id
      LEFT JOIN samples s ON s.id = r.sample_id
      LEFT JOIN users u ON u.id = r.recorded_by
      ORDER BY r.observed_at DESC LIMIT 100
    `)
  ])
  res.json({ instruments: instruments.rows, connectors: connectors.rows, readings: readings.rows })
})

app.post('/api/instruments', allowRoles('Station Chemist'), async (req, res) => {
  requireFields(req.body, ['name', 'module', 'protocol'])
  if (!['RS232', 'USB', 'TCP/IP', 'Manual'].includes(req.body.protocol)) {
    throw new HttpError(400, 'Choose a supported instrument protocol.')
  }
  const instrument = await transaction(async (client) => {
    const inserted = await client.query(`
      INSERT INTO instruments (name, module, protocol, endpoint)
      VALUES ($1, $2, $3, $4) RETURNING *
    `, [req.body.name.trim(), req.body.module.trim(), req.body.protocol, String(req.body.endpoint ?? '').trim()])
    await writeAudit(client, req.auth.id, 'Instrument configured', 'instrument', inserted.rows[0].id, {
      name: inserted.rows[0].name, protocol: inserted.rows[0].protocol
    })
    return inserted.rows[0]
  })
  res.status(201).json({ instrument })
})

app.post('/api/instruments/:id/readings', allowRoles('Lab Technician', 'Station Chemist'), async (req, res) => {
  requireFields(req.body, ['tag'])
  if (req.body.value == null || (typeof req.body.value === 'string' && !req.body.value.trim())) {
    throw new HttpError(400, 'Reading must be numeric.')
  }
  const value = Number(req.body.value)
  if (!Number.isFinite(value)) throw new HttpError(400, 'Reading must be numeric.')
  const instrumentId = req.params.id === 'manual' ? null : Number(req.params.id)
  if (instrumentId !== null && (!Number.isSafeInteger(instrumentId) || instrumentId < 1)) {
    throw new HttpError(400, 'Choose a valid instrument or record a manual reading.')
  }
  const sampleId = req.body.sampleId ? Number(req.body.sampleId) : null
  if (sampleId !== null && (!Number.isSafeInteger(sampleId) || sampleId < 1)) {
    throw new HttpError(400, 'Choose a valid sample to link this reading.')
  }
  const quality = req.body.quality ?? 'Good'
  if (!['Good', 'Uncertain', 'Bad'].includes(quality)) throw new HttpError(400, 'Reading quality must be Good, Uncertain or Bad.')
  const reading = await transaction(async (client) => {
    const inserted = await client.query(`
      INSERT INTO instrument_readings (instrument_id, sample_id, tag, value, unit, quality, recorded_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *
    `, [
      instrumentId,
      sampleId,
      req.body.tag.trim(),
      value,
      String(req.body.unit ?? '').trim(),
      quality,
      req.auth.id
    ])
    await writeAudit(client, req.auth.id, 'Instrument reading captured', 'instrument_reading', inserted.rows[0].id, {
      tag: inserted.rows[0].tag, value
    })
    return inserted.rows[0]
  })
  res.status(201).json({ reading })
})

app.put('/api/integrations/:type', allowRoles('Station Chemist'), async (req, res) => {
  const type = req.params.type === 'dcs' ? 'DCS / Historian' : req.params.type === 'erp' ? 'ERP' : null
  if (!type) throw new HttpError(404, 'Unknown integration type.')
  const endpoint = String(req.body.endpoint ?? '').trim()
  if (endpoint.length > 500) throw new HttpError(400, 'Endpoint must be 500 characters or fewer.')
  const tagMapping = req.body.tagMapping ?? {}
  if (!tagMapping || typeof tagMapping !== 'object' || Array.isArray(tagMapping)) {
    throw new HttpError(400, 'Tag mapping must be a JSON object.')
  }
  const enabled = Boolean(req.body.enabled)
  if (enabled && !endpoint) throw new HttpError(400, 'Provide an endpoint before enabling a connector.')
  const connector = await transaction(async (client) => {
    const saved = await client.query(`
      UPDATE integration_connectors
      SET endpoint = $2, tag_mapping = $3, enabled = $4, updated_by = $5, updated_at = NOW()
      WHERE connector_type = $1
      RETURNING connector_type, endpoint, tag_mapping, enabled, updated_at
    `, [type, endpoint, tagMapping, enabled, req.auth.id])
    await writeAudit(client, req.auth.id, 'Integration configuration updated', 'integration', type, {
      endpoint, enabled, tagMapping
    })
    return saved.rows[0]
  })
  res.json({ connector })
})

app.get('/api/users', authenticate, allowRoles('Station Chemist'), async (_req, res) => {
  const users = await pool.query('SELECT id, full_name, email, role, active, created_at FROM users ORDER BY full_name')
  res.json({ users: users.rows })
})

app.post('/api/users', authenticate, allowRoles('Station Chemist'), async (req, res) => {
  requireFields(req.body, ['fullName', 'email', 'password', 'role'])
  if (!roles.includes(req.body.role)) throw new HttpError(400, 'Choose a valid user role.')
  if (req.body.password.length < 12) throw new HttpError(400, 'Use a password with at least 12 characters.')
  const user = await transaction(async (client) => {
    const inserted = await client.query(`
      INSERT INTO users (full_name, email, password_hash, role)
      VALUES ($1, $2, $3, $4) RETURNING id, full_name, email, role, active, created_at
    `, [
      req.body.fullName.trim(),
      req.body.email.trim().toLowerCase(),
      await bcrypt.hash(req.body.password, 12),
      req.body.role
    ])
    await writeAudit(client, req.auth.id, 'User created', 'user', inserted.rows[0].id, { role: inserted.rows[0].role })
    return inserted.rows[0]
  })
  res.status(201).json({ user })
})

app.get('/api/reports/samples.csv', async (_req, res) => {
  const result = await pool.query(`
    SELECT s.sample_code, s.location, s.material, m.name AS method, m.module, s.status,
      s.collected_at, s.due_at, s.chemist, p.name AS parameter, r.numeric_value, p.unit,
      p.lower_limit, p.upper_limit, r.tested_at
    FROM samples s
    JOIN test_methods m ON m.id = s.method_id
    LEFT JOIN test_results r ON r.sample_id = s.id
    LEFT JOIN test_parameters p ON p.id = r.parameter_id
    ORDER BY s.created_at DESC, p.id
  `)
  const columns = ['sample_code', 'location', 'material', 'method', 'module', 'status', 'collected_at', 'due_at', 'chemist', 'parameter', 'numeric_value', 'unit', 'lower_limit', 'upper_limit', 'tested_at']
  const escapeCsv = (value) => {
    const text = String(value ?? '')
    const safeText = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
    return `"${safeText.replaceAll('"', '""')}"`
  }
  const csv = [columns.join(','), ...result.rows.map((row) => columns.map((column) => escapeCsv(row[column])).join(','))].join('\r\n')
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', 'attachment; filename="labims-samples.csv"')
  res.send(csv)
})

if (existsSync(distDirectory)) {
  app.use(express.static(distDirectory))
  app.get(/.*/, (_req, res) => res.sendFile(path.join(distDirectory, 'index.html')))
}

app.use((error, _req, res, _next) => {
  const status = error instanceof HttpError ? error.status : error.code === '23505' ? 409 : 500
  const message = error instanceof HttpError
    ? error.message
    : error.code === '23505'
      ? 'That value already exists.'
      : 'The request could not be completed.'
  if (status >= 500) console.error('API request failed:', error)
  res.status(status).json({ error: message })
})

try {
  await initializeDatabase()
  app.listen(port, host, () => console.log(`LabIMS API listening at http://${host}:${port}`))
} catch (error) {
  console.error('LabIMS API startup failed:', error)
  await pool.end()
  process.exitCode = 1
}
