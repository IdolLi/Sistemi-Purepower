-- ============================================================================
-- 004 WAREHOUSE: location hierarchy, location tree, movements, reservations,
--     usage history and QR/barcode label registry
-- ============================================================================

CREATE TABLE warehouses (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(20) NOT NULL UNIQUE,
  name VARCHAR(160) NOT NULL,
  warehouse_type VARCHAR(20) NOT NULL DEFAULT 'TOOL_ROOM',
  parent_id INT NULL,
  address VARCHAR(255) NULL,
  manager VARCHAR(120) NULL,
  level_prefix VARCHAR(10) NULL,
  level_label VARCHAR(40) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 100,
  notes TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT wh_parent_fk FOREIGN KEY (parent_id) REFERENCES warehouses (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE warehouse_rows (
  id INT AUTO_INCREMENT PRIMARY KEY,
  warehouse_id INT NOT NULL,
  code VARCHAR(20) NOT NULL,
  label VARCHAR(120) NULL,
  description VARCHAR(400) NULL,
  sort_order INT NOT NULL DEFAULT 100,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  CONSTRAINT wrow_wh_fk FOREIGN KEY (warehouse_id) REFERENCES warehouses (id) ON DELETE CASCADE,
  UNIQUE KEY uq_wrow (warehouse_id, code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE warehouse_racks (
  id INT AUTO_INCREMENT PRIMARY KEY,
  row_id INT NOT NULL,
  code VARCHAR(20) NOT NULL,
  label VARCHAR(120) NULL,
  side VARCHAR(20) NULL,
  sort_order INT NOT NULL DEFAULT 100,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  CONSTRAINT wrack_row_fk FOREIGN KEY (row_id) REFERENCES warehouse_rows (id) ON DELETE CASCADE,
  UNIQUE KEY uq_wrack (row_id, code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE warehouse_shelves (
  id INT AUTO_INCREMENT PRIMARY KEY,
  rack_id INT NOT NULL,
  code VARCHAR(20) NOT NULL,
  label VARCHAR(120) NULL,
  level_no INT NULL,
  capacity_items INT NULL,
  max_weight_kg DECIMAL(8,2) NULL,
  height_mm INT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  CONSTRAINT wshelf_rack_fk FOREIGN KEY (rack_id) REFERENCES warehouse_racks (id) ON DELETE CASCADE,
  UNIQUE KEY uq_wshelf (rack_id, code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE warehouse_boxes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  shelf_id INT NOT NULL,
  code VARCHAR(20) NOT NULL,
  label VARCHAR(120) NULL,
  capacity_items INT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  CONSTRAINT wbox_shelf_fk FOREIGN KEY (shelf_id) REFERENCES warehouse_shelves (id) ON DELETE CASCADE,
  UNIQUE KEY uq_wbox (shelf_id, code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE tooling_locations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  kind VARCHAR(20) NOT NULL,
  code VARCHAR(40) NOT NULL,
  full_code VARCHAR(200) NOT NULL UNIQUE,
  label_path VARCHAR(400) NULL,
  ref_id INT NOT NULL,
  parent_location_id INT NULL,
  warehouse_id INT NULL,
  row_id INT NULL,
  rack_id INT NULL,
  shelf_id INT NULL,
  box_id INT NULL,
  depth INT NOT NULL DEFAULT 0,
  capacity_items INT NULL,
  occupancy_items INT NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'AVAILABLE',
  zone VARCHAR(60) NULL,
  qr_payload VARCHAR(255) NULL,
  is_scannable TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 100,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT tl_parent_fk FOREIGN KEY (parent_location_id) REFERENCES tooling_locations (id) ON DELETE SET NULL,
  UNIQUE KEY uq_tl (kind, ref_id),
  INDEX idx_tl_full (full_code),
  INDEX idx_tl_status (status),
  INDEX idx_tl_wh (warehouse_id, row_id, rack_id, shelf_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE inventory_locations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(60) NOT NULL UNIQUE,
  name VARCHAR(160) NULL,
  warehouse_id INT NULL,
  location_type VARCHAR(30) NOT NULL DEFAULT 'BIN',
  capacity INT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  CONSTRAINT invloc_wh_fk FOREIGN KEY (warehouse_id) REFERENCES warehouses (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE tooling_movements (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  tooling_item_id INT NOT NULL,
  movement_type VARCHAR(30) NOT NULL,
  from_location_id INT NULL,
  to_location_id INT NULL,
  from_location_code VARCHAR(200) NULL,
  to_location_code VARCHAR(200) NULL,
  external_location VARCHAR(200) NULL,
  production_order_id INT NULL,
  status_before VARCHAR(30) NULL,
  status_after VARCHAR(30) NULL,
  qty INT NOT NULL DEFAULT 1,
  reason_code VARCHAR(40) NULL,
  note VARCHAR(500) NULL,
  user_id INT NULL,
  username VARCHAR(60) NULL,
  device VARCHAR(60) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT mv_tool_fk FOREIGN KEY (tooling_item_id) REFERENCES tooling_items (id) ON DELETE CASCADE,
  CONSTRAINT mv_from_fk FOREIGN KEY (from_location_id) REFERENCES tooling_locations (id) ON DELETE SET NULL,
  CONSTRAINT mv_to_fk FOREIGN KEY (to_location_id) REFERENCES tooling_locations(id) ON DELETE SET NULL,
  CONSTRAINT mv_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL,
  INDEX idx_mv_tool_time (tooling_item_id, created_at),
  INDEX idx_mv_time (created_at),
  INDEX idx_mv_order (production_order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE tooling_usage_history (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  tooling_item_id INT NOT NULL,
  production_order_id INT NULL,
  batch_id INT NULL,
  filter_id INT NULL,
  event_type VARCHAR(20) NOT NULL DEFAULT 'USAGE',
  cycles INT NOT NULL DEFAULT 1,
  quantity INT NOT NULL DEFAULT 0,
  produced_qty INT NOT NULL DEFAULT 0,
  operator_id INT NULL,
  operator_name VARCHAR(120) NULL,
  occurred_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  note VARCHAR(400) NULL,
  CONSTRAINT use_tool_fk FOREIGN KEY (tooling_item_id) REFERENCES tooling_items (id) ON DELETE CASCADE,
  CONSTRAINT use_filter_fk FOREIGN KEY (filter_id) REFERENCES filters (id) ON DELETE SET NULL,
  INDEX idx_use_tool (tooling_item_id, occurred_at),
  INDEX idx_use_order (production_order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE tooling_reservations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tooling_item_id INT NOT NULL,
  production_order_id INT NULL,
  requested_by INT NULL,
  reserved_by INT NULL,
  qty INT NOT NULL DEFAULT 1,
  planned_start_at DATETIME NULL,
  planned_end_at DATETIME NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  note VARCHAR(400) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  released_at DATETIME NULL,
  CONSTRAINT res_tool_fk FOREIGN KEY (tooling_item_id) REFERENCES tooling_items (id) ON DELETE CASCADE,
  CONSTRAINT res_by_fk FOREIGN KEY (reserved_by) REFERENCES users (id) ON DELETE SET NULL,
  INDEX idx_res_tool_status (tooling_item_id, status),
  INDEX idx_res_order (production_order_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE code_registry (
  id INT AUTO_INCREMENT PRIMARY KEY,
  entity_type VARCHAR(20) NOT NULL,
  entity_id INT NOT NULL,
  code VARCHAR(80) NOT NULL,
  symbology VARCHAR(20) NOT NULL DEFAULT 'QR',
  payload VARCHAR(255) NOT NULL,
  target_url VARCHAR(255) NOT NULL,
  label_size_mm VARCHAR(40) NULL,
  printed_count INT NOT NULL DEFAULT 0,
  last_printed_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_code (entity_type, entity_id, symbology),
  INDEX idx_code_lookup (symbology, code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE label_templates (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL UNIQUE,
  kind VARCHAR(20) NOT NULL DEFAULT 'TOOLING',
  width_mm DECIMAL(6,1) NOT NULL DEFAULT 70,
  height_mm DECIMAL(6,1) NOT NULL DEFAULT 40,
  columns_per_row INT NOT NULL DEFAULT 2,
  rows_per_page INT NOT NULL DEFAULT 6,
  show_logo TINYINT(1) NOT NULL DEFAULT 1,
  show_type TINYINT(1) NOT NULL DEFAULT 1,
  show_filter TINYINT(1) NOT NULL DEFAULT 1,
  show_location TINYINT(1) NOT NULL DEFAULT 1,
  show_dimensions TINYINT(1) NOT NULL DEFAULT 0,
  show_status TINYINT(1) NOT NULL DEFAULT 1,
  font_scale DECIMAL(4,2) NOT NULL DEFAULT 1.00,
  is_default TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
