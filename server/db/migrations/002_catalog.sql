-- ============================================================================
-- 002 CATALOG: filter types, brands, filters, dimensions, materials,
--     cross references, vehicles, applications
-- ============================================================================

CREATE TABLE filter_types (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(40) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  description VARCHAR(400) NULL,
  icon VARCHAR(20) NULL,
  sort_order INT NOT NULL DEFAULT 100,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  is_system TINYINT(1) NOT NULL DEFAULT 0,
  dimension_profile VARCHAR(40) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE brands (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(40) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  country VARCHAR(60) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 100
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE filter_families (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(40) NOT NULL UNIQUE,
  name VARCHAR(160) NOT NULL,
  description VARCHAR(400) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE filters (
  id INT AUTO_INCREMENT PRIMARY KEY,
  internal_number VARCHAR(60) NOT NULL UNIQUE,
  product_number VARCHAR(80) NULL,
  name VARCHAR(200) NULL,
  filter_type_id INT NOT NULL,
  brand_id INT NULL,
  family_id INT NULL,
  description TEXT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  notes TEXT NULL,
  search_blob TEXT NULL,
  created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT filters_type_fk FOREIGN KEY (filter_type_id) REFERENCES filter_types (id),
  CONSTRAINT filters_brand_fk FOREIGN KEY (brand_id) REFERENCES brands (id),
  CONSTRAINT filters_family_fk FOREIGN KEY (family_id) REFERENCES filter_families (id),
  CONSTRAINT filters_creator_fk FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL,
  INDEX idx_filters_active (is_active, status),
  INDEX idx_filters_type (filter_type_id),
  INDEX idx_filters_brand (brand_id),
  INDEX idx_filters_product_number (product_number),
  INDEX idx_filters_search (internal_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE filter_dimensions (
  filter_id INT NOT NULL PRIMARY KEY,
  unit VARCHAR(10) NOT NULL DEFAULT 'mm',
  length_mm DECIMAL(10,3) NULL,
  width_mm DECIMAL(10,3) NULL,
  height_mm DECIMAL(10,3) NULL,
  outer_diameter_mm DECIMAL(10,3) NULL,
  inner_diameter_mm DECIMAL(10,3) NULL,
  overall_diameter_mm DECIMAL(10,3) NULL,
  thread_size_mm DECIMAL(10,3) NULL,
  thread_spec VARCHAR(40) NULL,
  gasket_diameter_mm DECIMAL(10,3) NULL,
  gasket_thickness_mm DECIMAL(10,3) NULL,
  gasket_inner_diameter_mm DECIMAL(10,3) NULL,
  weight_grams DECIMAL(10,3) NULL,
  pleat_count INT NULL,
  pleat_height_mm DECIMAL(10,3) NULL,
  custom_values TEXT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fd_filter_fk FOREIGN KEY (filter_id) REFERENCES filters (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE filter_materials (
  id INT AUTO_INCREMENT PRIMARY KEY,
  filter_id INT NOT NULL UNIQUE,
  media_type VARCHAR(120) NULL,
  media_code VARCHAR(60) NULL,
  glue_type VARCHAR(120) NULL,
  gasket_material VARCHAR(120) NULL,
  rubber_material VARCHAR(120) NULL,
  end_cap_material VARCHAR(120) NULL,
  mesh_type VARCHAR(120) NULL,
  pleat_count INT NULL,
  pleat_height_mm DECIMAL(10,3) NULL,
  production_machine VARCHAR(120) NULL,
  standard_batch_qty INT NULL,
  cycle_time_seconds INT NULL,
  notes TEXT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fm_filter_fk FOREIGN KEY (filter_id) REFERENCES filters (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE filter_cross_references (
  id INT AUTO_INCREMENT PRIMARY KEY,
  filter_id INT NOT NULL,
  ref_type VARCHAR(30) NOT NULL DEFAULT 'OEM',
  brand_id INT NULL,
  ref_number VARCHAR(100) NOT NULL,
  notes VARCHAR(400) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT xref_filter_fk FOREIGN KEY (filter_id) REFERENCES filters (id) ON DELETE CASCADE,
  CONSTRAINT xref_brand_fk FOREIGN KEY (brand_id) REFERENCES brands (id) ON DELETE SET NULL,
  INDEX idx_xref_number (ref_number),
  INDEX idx_xref_filter (filter_id, ref_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE vehicles (
  id INT AUTO_INCREMENT PRIMARY KEY,
  manufacturer VARCHAR(120) NOT NULL,
  model VARCHAR(120) NOT NULL,
  generation VARCHAR(80) NULL,
  year_from INT NULL,
  year_to INT NULL,
  engine VARCHAR(120) NULL,
  engine_code VARCHAR(60) NULL,
  fuel VARCHAR(40) NULL,
  power_hp DECIMAL(7,1) NULL,
  body_type VARCHAR(60) NULL,
  notes VARCHAR(400) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_vehicle (manufacturer, model, generation, year_from, year_to, engine, engine_code, fuel),
  INDEX idx_vehicle_lookup (manufacturer, model),
  INDEX idx_vehicle_year (year_from, year_to)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE filter_vehicle_applications (
  id INT AUTO_INCREMENT PRIMARY KEY,
  filter_id INT NOT NULL,
  vehicle_id INT NOT NULL,
  start_year INT NULL,
  end_year INT NULL,
  quantity_per_vehicle INT NOT NULL DEFAULT 1,
  mounting_note VARCHAR(400) NULL,
  CONSTRAINT fva_filter_fk FOREIGN KEY (filter_id) REFERENCES filters (id) ON DELETE CASCADE,
  CONSTRAINT fva_vehicle_fk FOREIGN KEY (vehicle_id) REFERENCES vehicles (id) ON DELETE CASCADE,
  UNIQUE KEY uq_fva (filter_id, vehicle_id),
  INDEX idx_fva_vehicle (vehicle_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
