CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('Lab Technician', 'Lab Supervisor', 'Station Chemist', 'Plant Management')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS test_methods (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  module TEXT NOT NULL CHECK (module IN ('Water Chemistry', 'Coal / Combustion', 'Oil & Fuel', 'Gas Analysis')),
  standard TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS test_parameters (
  id BIGSERIAL PRIMARY KEY,
  method_id BIGINT NOT NULL REFERENCES test_methods(id),
  name TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT '',
  lower_limit NUMERIC,
  upper_limit NUMERIC,
  decimal_places SMALLINT NOT NULL DEFAULT 2 CHECK (decimal_places BETWEEN 0 AND 6),
  variable_name TEXT GENERATED ALWAYS AS (
    trim(both '_' from regexp_replace(lower(name), '[^a-z0-9]+', '_', 'g'))
  ) STORED,
  formula TEXT,
  UNIQUE (method_id, name),
  UNIQUE (method_id, variable_name),
  CHECK (lower_limit IS NULL OR upper_limit IS NULL OR lower_limit <= upper_limit)
);

ALTER TABLE test_parameters ADD COLUMN IF NOT EXISTS variable_name TEXT
  GENERATED ALWAYS AS (trim(both '_' from regexp_replace(lower(name), '[^a-z0-9]+', '_', 'g'))) STORED;
ALTER TABLE test_parameters ADD COLUMN IF NOT EXISTS formula TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS test_parameters_method_variable_unique
  ON test_parameters(method_id, variable_name);

CREATE TABLE IF NOT EXISTS samples (
  id BIGSERIAL PRIMARY KEY,
  sample_code TEXT NOT NULL UNIQUE,
  location TEXT NOT NULL,
  material TEXT NOT NULL DEFAULT '',
  method_id BIGINT NOT NULL REFERENCES test_methods(id),
  status TEXT NOT NULL DEFAULT 'Received' CHECK (status IN ('Received', 'In Progress', 'Approved', 'Rejected')),
  collected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  due_at TIMESTAMPTZ,
  chemist TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS test_results (
  id BIGSERIAL PRIMARY KEY,
  sample_id BIGINT NOT NULL REFERENCES samples(id),
  parameter_id BIGINT NOT NULL REFERENCES test_parameters(id),
  numeric_value NUMERIC NOT NULL,
  entered_by BIGINT REFERENCES users(id),
  tested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  comments TEXT NOT NULL DEFAULT '',
  calculated BOOLEAN NOT NULL DEFAULT FALSE,
  formula_snapshot TEXT,
  UNIQUE (sample_id, parameter_id)
);

ALTER TABLE test_results ADD COLUMN IF NOT EXISTS calculated BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE test_results ADD COLUMN IF NOT EXISTS formula_snapshot TEXT;

CREATE TABLE IF NOT EXISTS sample_events (
  id BIGSERIAL PRIMARY KEY,
  sample_id BIGINT NOT NULL REFERENCES samples(id),
  actor_id BIGINT REFERENCES users(id),
  action TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS electronic_signatures (
  id BIGSERIAL PRIMARY KEY,
  sample_id BIGINT NOT NULL REFERENCES samples(id),
  signer_id BIGINT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL CHECK (action IN ('Approved', 'Rejected')),
  meaning TEXT NOT NULL,
  reason TEXT NOT NULL,
  signed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_events (
  id BIGSERIAL PRIMARY KEY,
  actor_id BIGINT REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  previous_hash TEXT NOT NULL,
  record_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS instruments (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  module TEXT NOT NULL,
  protocol TEXT NOT NULL CHECK (protocol IN ('RS232', 'USB', 'TCP/IP', 'Manual')),
  endpoint TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'Not connected' CHECK (status IN ('Connected', 'Not connected', 'Maintenance')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS instrument_readings (
  id BIGSERIAL PRIMARY KEY,
  instrument_id BIGINT REFERENCES instruments(id),
  sample_id BIGINT REFERENCES samples(id),
  tag TEXT NOT NULL,
  value NUMERIC NOT NULL,
  unit TEXT NOT NULL DEFAULT '',
  quality TEXT NOT NULL DEFAULT 'Good' CHECK (quality IN ('Good', 'Uncertain', 'Bad')),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  recorded_by BIGINT REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS integration_connectors (
  id BIGSERIAL PRIMARY KEY,
  connector_type TEXT NOT NULL UNIQUE CHECK (connector_type IN ('DCS / Historian', 'ERP')),
  endpoint TEXT NOT NULL DEFAULT '',
  tag_mapping JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by BIGINT REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS samples_status_due_idx ON samples(status, due_at);
CREATE INDEX IF NOT EXISTS samples_collected_at_idx ON samples(collected_at DESC);
CREATE INDEX IF NOT EXISTS test_results_sample_idx ON test_results(sample_id, tested_at DESC);
CREATE INDEX IF NOT EXISTS instrument_readings_tag_time_idx ON instrument_readings(tag, observed_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_created_at_idx ON audit_events(created_at DESC);
CREATE INDEX IF NOT EXISTS sample_events_sample_time_idx ON sample_events(sample_id, created_at DESC);

CREATE OR REPLACE FUNCTION prevent_immutable_history_changes() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'History records are append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sample_events_immutable ON sample_events;
CREATE TRIGGER sample_events_immutable
  BEFORE UPDATE OR DELETE ON sample_events
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_history_changes();

DROP TRIGGER IF EXISTS audit_events_immutable ON audit_events;
CREATE TRIGGER audit_events_immutable
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_history_changes();

DROP TRIGGER IF EXISTS electronic_signatures_immutable ON electronic_signatures;
CREATE TRIGGER electronic_signatures_immutable
  BEFORE UPDATE OR DELETE ON electronic_signatures
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_history_changes();

INSERT INTO integration_connectors (connector_type)
VALUES ('DCS / Historian'), ('ERP')
ON CONFLICT (connector_type) DO NOTHING;

INSERT INTO test_methods (name, module, standard, description)
VALUES
  ('Boiler Feedwater', 'Water Chemistry', 'Site Standard', 'Routine boiler feedwater chemistry checks.'),
  ('Water Treatment', 'Water Chemistry', 'ASTM / Site Standard', 'Treatment-plant water quality checks.'),
  ('Coal Proximate Analysis', 'Coal / Combustion', 'ASTM D7582', 'Moisture, ash, and volatile matter.'),
  ('Transformer Oil DGA', 'Oil & Fuel', 'IEC 60567', 'Dissolved gas analysis for transformer oil.'),
  ('Hydrogen Purity', 'Gas Analysis', 'Site Standard', 'Hydrogen purity and dew point checks.')
ON CONFLICT (name) DO NOTHING;

INSERT INTO test_parameters (method_id, name, unit, lower_limit, upper_limit, decimal_places)
SELECT m.id, p.name, p.unit, p.lower_limit, p.upper_limit, p.decimal_places
FROM (
  VALUES
    ('Boiler Feedwater', 'pH', 'pH', 9.0::numeric, 10.5::numeric, 2),
    ('Boiler Feedwater', 'Conductivity', 'µS/cm', NULL::numeric, 0.2::numeric, 2),
    ('Boiler Feedwater', 'Silica', 'mg/L', NULL::numeric, 0.27::numeric, 3),
    ('Boiler Feedwater', 'Dissolved Oxygen', 'µg/L', NULL::numeric, 7::numeric, 1),
    ('Boiler Feedwater', 'Cation Conductivity', 'µS/cm', NULL::numeric, NULL::numeric, 2),
    ('Boiler Feedwater', 'Sodium', 'µg/L', NULL::numeric, NULL::numeric, 2),
    ('Boiler Feedwater', 'Iron', 'µg/L', NULL::numeric, NULL::numeric, 2),
    ('Boiler Feedwater', 'Copper', 'µg/L', NULL::numeric, NULL::numeric, 2),
    ('Boiler Feedwater', 'Hydrazine', 'mg/L', NULL::numeric, NULL::numeric, 3),
    ('Boiler Feedwater', 'Ammonia', 'mg/L', NULL::numeric, NULL::numeric, 3),
    ('Water Treatment', 'pH', 'pH', 6.5::numeric, 8.5::numeric, 2),
    ('Water Treatment', 'Conductivity', 'µS/cm', NULL::numeric, 1500::numeric, 0),
    ('Water Treatment', 'Iron', 'mg/L', NULL::numeric, 0.3::numeric, 2),
    ('Coal Proximate Analysis', 'Moisture', '%', 0::numeric, 20::numeric, 2),
    ('Coal Proximate Analysis', 'Ash', '%', 0::numeric, 30::numeric, 2),
    ('Coal Proximate Analysis', 'Volatile Matter', '%', 0::numeric, 50::numeric, 2),
    ('Coal Proximate Analysis', 'Fixed Carbon', '%', 0::numeric, 100::numeric, 2),
    ('Coal Proximate Analysis', 'Calorific Value', 'MJ/kg', NULL::numeric, NULL::numeric, 2),
    ('Transformer Oil DGA', 'Hydrogen', 'ppm', 0::numeric, 150::numeric, 1),
    ('Transformer Oil DGA', 'Methane', 'ppm', 0::numeric, 120::numeric, 1),
    ('Transformer Oil DGA', 'Acetylene', 'ppm', 0::numeric, 35::numeric, 1),
    ('Transformer Oil DGA', 'Ethane', 'ppm', 0::numeric, NULL::numeric, 1),
    ('Transformer Oil DGA', 'Ethylene', 'ppm', 0::numeric, NULL::numeric, 1),
    ('Transformer Oil DGA', 'Carbon Monoxide', 'ppm', 0::numeric, NULL::numeric, 1),
    ('Transformer Oil DGA', 'Carbon Dioxide', 'ppm', 0::numeric, NULL::numeric, 1),
    ('Hydrogen Purity', 'Hydrogen Purity', '%', 98::numeric, 100::numeric, 2),
    ('Hydrogen Purity', 'Dew Point', '°C', NULL::numeric, -40::numeric, 1),
    ('Diesel Specification', 'Density', 'kg/m³', NULL::numeric, NULL::numeric, 2),
    ('Diesel Specification', 'Viscosity', 'mm²/s', NULL::numeric, NULL::numeric, 2),
    ('Diesel Specification', 'Flash Point', '°C', NULL::numeric, NULL::numeric, 1),
    ('Heavy Fuel Oil Specification', 'Density', 'kg/m³', NULL::numeric, NULL::numeric, 2),
    ('Heavy Fuel Oil Specification', 'Viscosity', 'mm²/s', NULL::numeric, NULL::numeric, 2),
    ('Heavy Fuel Oil Specification', 'Sulfur', '%', NULL::numeric, NULL::numeric, 2),
    ('Coal Ultimate Analysis', 'Carbon', '%', 0::numeric, 100::numeric, 2),
    ('Coal Ultimate Analysis', 'Hydrogen', '%', 0::numeric, 100::numeric, 2),
    ('Coal Ultimate Analysis', 'Nitrogen', '%', 0::numeric, 100::numeric, 2),
    ('Coal Ultimate Analysis', 'Sulfur', '%', 0::numeric, 100::numeric, 2),
    ('Coal Ultimate Analysis', 'Oxygen', '%', 0::numeric, 100::numeric, 2)
) AS p(method_name, name, unit, lower_limit, upper_limit, decimal_places)
JOIN test_methods m ON m.name = p.method_name
ON CONFLICT (method_id, name) DO NOTHING;

UPDATE test_parameters p
SET formula = '100 - moisture - ash - volatile_matter'
FROM test_methods m
WHERE p.method_id = m.id
    AND m.name = 'Coal Proximate Analysis'
    AND p.name = 'Fixed Carbon'
    AND p.formula IS NULL;

INSERT INTO test_methods (name, module, standard, description)
VALUES
    ('Coal Ultimate Analysis', 'Coal / Combustion', 'ASTM / Site Standard', 'Carbon, hydrogen, nitrogen, sulfur, and oxygen.'),
    ('Diesel Specification', 'Oil & Fuel', 'Site Standard', 'Diesel fuel quality and acceptance testing.'),
    ('Heavy Fuel Oil Specification', 'Oil & Fuel', 'Site Standard', 'Heavy fuel oil quality and acceptance testing.')
ON CONFLICT (name) DO NOTHING;

INSERT INTO test_parameters (method_id, name, unit, lower_limit, upper_limit, decimal_places)
SELECT m.id, p.name, p.unit, p.lower_limit, p.upper_limit, p.decimal_places
FROM (
    VALUES
      ('Diesel Specification', 'Density', 'kg/m³', NULL::numeric, NULL::numeric, 2),
      ('Diesel Specification', 'Viscosity', 'mm²/s', NULL::numeric, NULL::numeric, 2),
      ('Diesel Specification', 'Flash Point', '°C', NULL::numeric, NULL::numeric, 1),
      ('Heavy Fuel Oil Specification', 'Density', 'kg/m³', NULL::numeric, NULL::numeric, 2),
      ('Heavy Fuel Oil Specification', 'Viscosity', 'mm²/s', NULL::numeric, NULL::numeric, 2),
      ('Heavy Fuel Oil Specification', 'Sulfur', '%', NULL::numeric, NULL::numeric, 2),
      ('Coal Ultimate Analysis', 'Carbon', '%', 0::numeric, 100::numeric, 2),
      ('Coal Ultimate Analysis', 'Hydrogen', '%', 0::numeric, 100::numeric, 2),
      ('Coal Ultimate Analysis', 'Nitrogen', '%', 0::numeric, 100::numeric, 2),
      ('Coal Ultimate Analysis', 'Sulfur', '%', 0::numeric, 100::numeric, 2),
      ('Coal Ultimate Analysis', 'Oxygen', '%', 0::numeric, 100::numeric, 2)
) AS p(method_name, name, unit, lower_limit, upper_limit, decimal_places)
JOIN test_methods m ON m.name = p.method_name
ON CONFLICT (method_id, name) DO NOTHING;
