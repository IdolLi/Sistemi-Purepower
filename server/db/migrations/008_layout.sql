-- ============================================================================
-- 008 WAREHOUSE LAYOUT + LABEL PRINT RUNS
--     Adds the visual storage-map editor (spec 14) and a per-code print log
--     so label printing can report how often a label was printed.
-- ============================================================================

ALTER TABLE tooling_locations
  ADD COLUMN map_row INT NULL,
  ADD COLUMN map_col INT NULL,
  ADD COLUMN map_span INT NOT NULL DEFAULT 1,
  ADD COLUMN map_color VARCHAR(20) NULL,
  ADD COLUMN note VARCHAR(500) NULL;

ALTER TABLE tooling_items
  ADD COLUMN deleted_by INT NULL,
  ADD COLUMN archived_reason VARCHAR(400) NULL,
  ADD CONSTRAINT ti_deleter_fk FOREIGN KEY (deleted_by) REFERENCES users (id) ON DELETE SET NULL;

CREATE TABLE warehouse_layouts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  warehouse_id INT NOT NULL UNIQUE,
  grid_cols INT NOT NULL DEFAULT 12,
  grid_rows INT NOT NULL DEFAULT 8,
  cell_size_px INT NOT NULL DEFAULT 64,
  background_document_id INT NULL,
  note VARCHAR(500) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT wl_wh_fk FOREIGN KEY (warehouse_id) REFERENCES warehouses (id) ON DELETE CASCADE,
  CONSTRAINT wl_bg_fk FOREIGN KEY (background_document_id) REFERENCES tooling_documents (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE label_print_runs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  entity_type VARCHAR(20) NOT NULL,
  entity_id INT NOT NULL,
  entity_code VARCHAR(80) NOT NULL,
  template VARCHAR(120) NULL,
  copies INT NOT NULL DEFAULT 1,
  sheet_format VARCHAR(40) NULL,
  dpi INT NULL,
  requested_by INT NULL,
  requested_name VARCHAR(120) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_lpr_entity (entity_type, entity_id, created_at),
  CONSTRAINT lpr_user_fk FOREIGN KEY (requested_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_mv_location ON tooling_movements (to_location_code, created_at);

CREATE TABLE inventory_counts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  count_no VARCHAR(40) NOT NULL UNIQUE,
  title VARCHAR(200) NOT NULL,
  location_code VARCHAR(60) NULL,
  warehouse_id INT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
  method VARCHAR(20) NOT NULL DEFAULT 'FULL',
  counter_a INT NULL,
  counter_b INT NULL,
  notes VARCHAR(500) NULL,
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at DATETIME NULL,
  created_by INT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT ic_wh_fk FOREIGN KEY (warehouse_id) REFERENCES warehouses (id) ON DELETE SET NULL,
  CONSTRAINT ic_ca_fk FOREIGN KEY (counter_a) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT ic_cb_fk FOREIGN KEY (counter_b) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT ic_user_fk FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL,
  INDEX idx_ic_status (status, started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE inventory_count_lines (
  id INT AUTO_INCREMENT PRIMARY KEY,
  count_id INT NOT NULL,
  inventory_item_id INT NOT NULL,
  location_id INT NULL,
  system_qty INT NOT NULL DEFAULT 0,
  counted_a INT NULL,
  counted_b INT NULL,
  counted_qty INT NULL,
  variance INT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  applied_txn_id BIGINT NULL,
  note VARCHAR(400) NULL,
  counted_at DATETIME NULL,
  CONSTRAINT icl_count_fk FOREIGN KEY (count_id) REFERENCES inventory_counts (id) ON DELETE CASCADE,
  CONSTRAINT icl_item_fk FOREIGN KEY (inventory_item_id) REFERENCES inventory_items (id) ON DELETE CASCADE,
  UNIQUE KEY uq_icl (count_id, inventory_item_id, location_id),
  INDEX idx_icl_status (count_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE packaging_items
  ADD UNIQUE KEY uq_pack (filter_id, packaging_type);
