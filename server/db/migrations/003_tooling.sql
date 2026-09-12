-- ============================================================================
-- 003 TOOLING: categories, items, sets, requirements, compatibility,
--     dimensions, images, documents, revisions, families, duplicate checks
-- ============================================================================

CREATE TABLE tooling_types (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(30) NOT NULL UNIQUE,
  name VARCHAR(160) NOT NULL,
  group_name VARCHAR(80) NULL,
  icon VARCHAR(12) NULL,
  description VARCHAR(400) NULL,
  id_prefix VARCHAR(10) NULL,
  requires_cycle_tracking TINYINT(1) NOT NULL DEFAULT 0,
  requires_maintenance TINYINT(1) NOT NULL DEFAULT 1,
  field_schema TEXT NULL,
  sort_order INT NOT NULL DEFAULT 100,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  is_system TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE custom_dimension_fields (
  id INT AUTO_INCREMENT PRIMARY KEY,
  entity VARCHAR(20) NOT NULL DEFAULT 'TOOLING',
  label VARCHAR(120) NOT NULL,
  field_key VARCHAR(60) NOT NULL,
  unit VARCHAR(20) NULL,
  data_type VARCHAR(20) NOT NULL DEFAULT 'decimal',
  applies_to_type_id INT NULL,
  sort_order INT NOT NULL DEFAULT 100,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  CONSTRAINT cdf_type_fk FOREIGN KEY (applies_to_type_id) REFERENCES tooling_types (id) ON DELETE CASCADE,
  UNIQUE KEY uq_cdf (entity, field_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE tooling_sets (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(60) NOT NULL UNIQUE,
  name VARCHAR(160) NULL,
  filter_id INT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'INCOMPLETE',
  required_count INT NOT NULL DEFAULT 0,
  linked_count INT NOT NULL DEFAULT 0,
  available_count INT NOT NULL DEFAULT 0,
  completeness_checked_at DATETIME NULL,
  notes TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT tsets_filter_fk FOREIGN KEY (filter_id) REFERENCES filters (id) ON DELETE SET NULL,
  INDEX idx_sets_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE tooling_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tooling_id VARCHAR(60) NOT NULL UNIQUE,
  name VARCHAR(200) NOT NULL,
  tooling_type_id INT NOT NULL,
  tooling_set_id INT NULL,
  primary_filter_id INT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'AVAILABLE',
  condition_rating VARCHAR(20) NOT NULL DEFAULT 'GOOD',
  material VARCHAR(120) NULL,
  manufacturer VARCHAR(160) NULL,
  supplier VARCHAR(160) NULL,
  weight_grams DECIMAL(10,2) NULL,
  quantity INT NOT NULL DEFAULT 1,
  serial_number VARCHAR(80) NULL,
  barcode VARCHAR(64) NULL UNIQUE,
  qr_payload VARCHAR(255) NULL,
  manufacturing_date DATE NULL,
  purchase_date DATE NULL,
  warranty_until DATE NULL,
  location_id INT NULL,
  external_location VARCHAR(200) NULL,
  rubber_profile VARCHAR(120) NULL,
  letter_type VARCHAR(80) NULL,
  logo_ref VARCHAR(120) NULL,
  is_tracked TINYINT(1) NOT NULL DEFAULT 1,
  total_cycles INT NOT NULL DEFAULT 0,
  total_parts_produced BIGINT NOT NULL DEFAULT 0,
  max_cycles INT NULL,
  cycle_warning_pct INT NOT NULL DEFAULT 85,
  last_used_at DATETIME NULL,
  last_maintenance_date DATE NULL,
  next_maintenance_date DATE NULL,
  maintenance_interval_days INT NULL,
  maintenance_interval_cycles INT NULL,
  last_condition_check_at DATETIME NULL,
  open_damage_reports INT NOT NULL DEFAULT 0,
  reserved_qty INT NOT NULL DEFAULT 0,
  cost DECIMAL(12,2) NULL,
  current_revision INT NOT NULL DEFAULT 1,
  notes TEXT NULL,
  deleted_at DATETIME NULL,
  created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT ti_type_fk FOREIGN KEY (tooling_type_id) REFERENCES tooling_types (id),
  CONSTRAINT ti_set_fk FOREIGN KEY (tooling_set_id) REFERENCES tooling_sets (id) ON DELETE SET NULL,
  CONSTRAINT ti_filter_fk FOREIGN KEY (primary_filter_id) REFERENCES filters (id) ON DELETE SET NULL,
  CONSTRAINT ti_creator_fk FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL,
  INDEX idx_ti_status (status, deleted_at),
  INDEX idx_ti_type (tooling_type_id),
  INDEX idx_ti_set (tooling_set_id),
  INDEX idx_ti_filter (primary_filter_id),
  INDEX idx_ti_location (location_id),
  INDEX idx_ti_maint (next_maintenance_date),
  INDEX idx_ti_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE filter_tooling_requirements (
  id INT AUTO_INCREMENT PRIMARY KEY,
  filter_id INT NOT NULL,
  tooling_type_id INT NOT NULL,
  quantity_required INT NOT NULL DEFAULT 1,
  is_mandatory TINYINT(1) NOT NULL DEFAULT 1,
  note VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT ftr_filter_fk FOREIGN KEY (filter_id) REFERENCES filters (id) ON DELETE CASCADE,
  CONSTRAINT ftr_type_fk FOREIGN KEY (tooling_type_id) REFERENCES tooling_types (id),
  UNIQUE KEY uq_ftr (filter_id, tooling_type_id, note),
  INDEX idx_ftr_type (tooling_type_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE tooling_compatibility (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tooling_item_id INT NOT NULL,
  filter_id INT NOT NULL,
  compatibility_level VARCHAR(20) NOT NULL DEFAULT 'EXACT',
  is_primary TINYINT(1) NOT NULL DEFAULT 0,
  note VARCHAR(400) NULL,
  created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT tc_tool_fk FOREIGN KEY (tooling_item_id) REFERENCES tooling_items (id) ON DELETE CASCADE,
  CONSTRAINT tc_filter_fk FOREIGN KEY (filter_id) REFERENCES filters (id) ON DELETE CASCADE,
  UNIQUE KEY uq_tc (tooling_item_id, filter_id),
  INDEX idx_tc_filter (filter_id, compatibility_level)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE tooling_families (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(60) NOT NULL UNIQUE,
  name VARCHAR(160) NOT NULL,
  brand_id INT NULL,
  description VARCHAR(400) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT tfamily_brand_fk FOREIGN KEY (brand_id) REFERENCES brands (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE tooling_family_members (
  family_id INT NOT NULL,
  tooling_item_id INT NOT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'SHARED',
  PRIMARY KEY (family_id, tooling_item_id),
  CONSTRAINT tfm_family_fk FOREIGN KEY (family_id) REFERENCES tooling_families (id) ON DELETE CASCADE,
  CONSTRAINT tfm_tool_fk FOREIGN KEY (tooling_item_id) REFERENCES tooling_items (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE tooling_family_filters (
  family_id INT NOT NULL,
  filter_id INT NOT NULL,
  PRIMARY KEY (family_id, filter_id),
  CONSTRAINT tff_family_fk FOREIGN KEY (family_id) REFERENCES tooling_families (id) ON DELETE CASCADE,
  CONSTRAINT tff_filter_fk FOREIGN KEY (filter_id) REFERENCES filters (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE tooling_dimensions (
  tooling_item_id INT NOT NULL PRIMARY KEY,
  overall_length_mm DECIMAL(10,3) NULL,
  overall_width_mm DECIMAL(10,3) NULL,
  overall_height_mm DECIMAL(10,3) NULL,
  internal_length_mm DECIMAL(10,3) NULL,
  internal_width_mm DECIMAL(10,3) NULL,
  internal_height_mm DECIMAL(10,3) NULL,
  wall_thickness_mm DECIMAL(10,3) NULL,
  channel_width_mm DECIMAL(10,3) NULL,
  channel_depth_mm DECIMAL(10,3) NULL,
  corner_radius_mm DECIMAL(10,3) NULL,
  hole_diameter_mm DECIMAL(10,3) NULL,
  hole_count INT NULL,
  hole_position VARCHAR(160) NULL,
  mounting_dimensions VARCHAR(200) NULL,
  hole_distance_mm DECIMAL(10,3) NULL,
  letter_position VARCHAR(160) NULL,
  letter_size_mm DECIMAL(10,3) NULL,
  letter_count INT NULL,
  logo_position VARCHAR(160) NULL,
  logo_size_mm DECIMAL(10,3) NULL,
  depth_mm DECIMAL(10,3) NULL,
  custom_values TEXT NULL,
  notes TEXT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT td_tool_fk FOREIGN KEY (tooling_item_id) REFERENCES tooling_items (id) ON DELETE CASCADE,
  INDEX idx_td_length (overall_length_mm, overall_width_mm, overall_height_mm),
  INDEX idx_td_internal (internal_length_mm, internal_width_mm)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE tooling_images (
  id INT AUTO_INCREMENT PRIMARY KEY,
  owner_type VARCHAR(20) NOT NULL DEFAULT 'TOOLING',
  owner_id INT NOT NULL,
  view_type VARCHAR(30) NOT NULL DEFAULT 'DETAIL',
  caption VARCHAR(200) NULL,
  filename VARCHAR(255) NOT NULL,
  stored_name VARCHAR(255) NOT NULL,
  mime_type VARCHAR(60) NOT NULL,
  size_bytes INT NOT NULL DEFAULT 0,
  width_px INT NULL,
  height_px INT NULL,
  is_primary TINYINT(1) NOT NULL DEFAULT 0,
  sort_order INT NOT NULL DEFAULT 100,
  taken_at DATETIME NULL,
  uploaded_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_img_owner (owner_type, owner_id, view_type),
  INDEX idx_img_primary (owner_type, owner_id, is_primary)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE tooling_documents (
  id INT AUTO_INCREMENT PRIMARY KEY,
  owner_type VARCHAR(20) NOT NULL DEFAULT 'TOOLING',
  owner_id INT NOT NULL,
  doc_type VARCHAR(30) NOT NULL DEFAULT 'OTHER',
  filename VARCHAR(255) NOT NULL,
  stored_name VARCHAR(255) NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  extension VARCHAR(20) NOT NULL,
  mime_type VARCHAR(120) NOT NULL,
  size_bytes INT NOT NULL DEFAULT 0,
  version_no INT NOT NULL DEFAULT 1,
  is_current TINYINT(1) NOT NULL DEFAULT 1,
  description VARCHAR(400) NULL,
  uploaded_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_doc_owner (owner_type, owner_id, doc_type),
  INDEX idx_doc_current (owner_type, owner_id, is_current)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE tooling_revisions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tooling_item_id INT NULL,
  filter_id INT NULL,
  revision_no INT NOT NULL DEFAULT 1,
  change_summary VARCHAR(400) NULL,
  designer VARCHAR(120) NULL,
  manufacturer VARCHAR(160) NULL,
  material VARCHAR(120) NULL,
  cost DECIMAL(12,2) NULL,
  manufacturing_date DATE NULL,
  cad_document_id INT NULL,
  drawing_document_id INT NULL,
  snapshot TEXT NULL,
  is_current TINYINT(1) NOT NULL DEFAULT 0,
  created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT trev_tool_fk FOREIGN KEY (tooling_item_id) REFERENCES tooling_items (id) ON DELETE CASCADE,
  CONSTRAINT trev_filter_fk FOREIGN KEY (filter_id) REFERENCES filters (id) ON DELETE CASCADE,
  UNIQUE KEY uq_trev (tooling_item_id, revision_no),
  INDEX idx_trev_current (tooling_item_id, is_current),
  INDEX idx_trev_filter (filter_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE duplicate_checks (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tooling_a_id INT NOT NULL,
  tooling_b_id INT NOT NULL,
  similarity_pct DECIMAL(5,1) NOT NULL DEFAULT 0,
  reason VARCHAR(400) NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
  reviewed_by INT NULL,
  reviewed_at DATETIME NULL,
  notes VARCHAR(400) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT dup_a_fk FOREIGN KEY (tooling_a_id) REFERENCES tooling_items (id) ON DELETE CASCADE,
  CONSTRAINT dup_b_fk FOREIGN KEY (tooling_b_id) REFERENCES tooling_items (id) ON DELETE CASCADE,
  UNIQUE KEY uq_dup (tooling_a_id, tooling_b_id),
  INDEX idx_dup_status (status, similarity_pct)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
