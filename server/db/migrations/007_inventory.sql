-- ============================================================================
-- 007 INVENTORY + COLLABORATION: filter stock, transactions, notifications
-- ============================================================================

CREATE TABLE inventory_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  item_kind VARCHAR(20) NOT NULL DEFAULT 'FILTER',
  ref_id INT NULL,
  sku VARCHAR(80) NULL UNIQUE,
  name VARCHAR(200) NOT NULL,
  unit VARCHAR(20) NOT NULL DEFAULT 'PCS',
  reorder_level INT NOT NULL DEFAULT 0,
  min_stock INT NULL,
  location_id INT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT inv_loc_fk FOREIGN KEY (location_id) REFERENCES inventory_locations (id) ON DELETE SET NULL,
  INDEX idx_inv_kind (item_kind, ref_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE inventory (
  id INT AUTO_INCREMENT PRIMARY KEY,
  inventory_item_id INT NOT NULL,
  location_id INT NULL,
  quantity INT NOT NULL DEFAULT 0,
  reserved_qty INT NOT NULL DEFAULT 0,
  damaged_qty INT NOT NULL DEFAULT 0,
  lot_ref VARCHAR(60) NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT inv_item_fk FOREIGN KEY (inventory_item_id) REFERENCES inventory_items (id) ON DELETE CASCADE,
  CONSTRAINT inv_invloc_fk FOREIGN KEY (location_id) REFERENCES inventory_locations (id) ON DELETE SET NULL,
  UNIQUE KEY uq_inv (inventory_item_id, location_id),
  INDEX idx_inv_qty (quantity)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE inventory_transactions (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  inventory_item_id INT NOT NULL,
  location_id INT NULL,
  txn_type VARCHAR(20) NOT NULL,
  quantity INT NOT NULL,
  balance_after INT NULL,
  reference_type VARCHAR(30) NULL,
  reference_id INT NULL,
  reference_no VARCHAR(60) NULL,
  reason VARCHAR(40) NULL,
  note VARCHAR(400) NULL,
  user_id INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT itxn_item_fk FOREIGN KEY (inventory_item_id) REFERENCES inventory_items (id) ON DELETE CASCADE,
  CONSTRAINT itxn_loc_fk FOREIGN KEY (location_id) REFERENCES inventory_locations (id) ON DELETE SET NULL,
  CONSTRAINT itxn_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL,
  INDEX idx_itxn_item (inventory_item_id, created_at),
  INDEX idx_itxn_type (txn_type, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE packaging_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  filter_id INT NOT NULL,
  packaging_type VARCHAR(60) NOT NULL DEFAULT 'BOX',
  units_per_pack INT NOT NULL DEFAULT 1,
  available_packs INT NOT NULL DEFAULT 0,
  location_id INT NULL,
  notes VARCHAR(400) NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT pack_filter_fk FOREIGN KEY (filter_id) REFERENCES filters (id) ON DELETE CASCADE,
  INDEX idx_pack_filter (filter_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE notifications (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NULL,
  role_code VARCHAR(40) NULL,
  kind VARCHAR(40) NOT NULL,
  severity VARCHAR(20) NOT NULL DEFAULT 'INFO',
  title VARCHAR(200) NOT NULL,
  message VARCHAR(500) NULL,
  entity_type VARCHAR(60) NULL,
  entity_id VARCHAR(64) NULL,
  link VARCHAR(255) NULL,
  dedup_key VARCHAR(160) NULL UNIQUE,
  is_read TINYINT(1) NOT NULL DEFAULT 0,
  read_at DATETIME NULL,
  resolved_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_notif_user (user_id, is_read, created_at),
  INDEX idx_notif_kind (kind, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE ai_feature_requests (
  id INT AUTO_INCREMENT PRIMARY KEY,
  feature VARCHAR(40) NOT NULL,
  payload TEXT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'QUEUED',
  result TEXT NULL,
  requested_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at DATETIME NULL,
  INDEX idx_aifrq (feature, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
