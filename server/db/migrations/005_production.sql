-- ============================================================================
-- 005 PRODUCTION: orders, required tooling, usage log, batches
-- ============================================================================

CREATE TABLE production_orders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  po_number VARCHAR(60) NOT NULL UNIQUE,
  filter_id INT NOT NULL,
  quantity_ordered INT NOT NULL DEFAULT 1,
  quantity_produced INT NOT NULL DEFAULT 0,
  status VARCHAR(30) NOT NULL DEFAULT 'PLANNED',
  priority VARCHAR(10) NOT NULL DEFAULT 'NORMAL',
  line VARCHAR(80) NULL,
  machine VARCHAR(120) NULL,
  planned_start_at DATETIME NULL,
  planned_end_at DATETIME NULL,
  started_at DATETIME NULL,
  completed_at DATETIME NULL,
  availability_status VARCHAR(20) NOT NULL DEFAULT 'UNKNOWN',
  availability_checked_at DATETIME NULL,
  blocking_reason VARCHAR(400) NULL,
  customer_ref VARCHAR(120) NULL,
  notes TEXT NULL,
  created_by INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT po_filter_fk FOREIGN KEY (filter_id) REFERENCES filters (id),
  CONSTRAINT po_creator_fk FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL,
  INDEX idx_po_status (status, planned_start_at),
  INDEX idx_po_filter (filter_id),
  INDEX idx_po_avail (availability_status, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE production_order_tools (
  id INT AUTO_INCREMENT PRIMARY KEY,
  production_order_id INT NOT NULL,
  tooling_item_id INT NOT NULL,
  is_required TINYINT(1) NOT NULL DEFAULT 1,
  qty INT NOT NULL DEFAULT 1,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  taken_at DATETIME NULL,
  returned_at DATETIME NULL,
  cycle_count INT NOT NULL DEFAULT 0,
  produced_qty INT NOT NULL DEFAULT 0,
  CONSTRAINT pot_order_fk FOREIGN KEY (production_order_id) REFERENCES production_orders (id) ON DELETE CASCADE,
  CONSTRAINT pot_tool_fk FOREIGN KEY (tooling_item_id) REFERENCES tooling_items (id) ON DELETE CASCADE,
  UNIQUE KEY uq_pot (production_order_id, tooling_item_id),
  INDEX idx_pot_tool (tooling_item_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE production_batches (
  id INT AUTO_INCREMENT PRIMARY KEY,
  batch_number VARCHAR(60) NOT NULL UNIQUE,
  production_order_id INT NOT NULL,
  filter_id INT NOT NULL,
  quantity INT NOT NULL DEFAULT 0,
  good_qty INT NOT NULL DEFAULT 0,
  scrap_qty INT NOT NULL DEFAULT 0,
  started_at DATETIME NULL,
  completed_at DATETIME NULL,
  operator_id INT NULL,
  notes VARCHAR(400) NULL,
  CONSTRAINT pb_order_fk FOREIGN KEY (production_order_id) REFERENCES production_orders (id) ON DELETE CASCADE,
  CONSTRAINT pb_filter_fk FOREIGN KEY (filter_id) REFERENCES filters (id),
  INDEX idx_pb_order (production_order_id),
  INDEX idx_pb_filter (filter_id, completed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE production_history (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  production_order_id INT NULL,
  filter_id INT NULL,
  event_type VARCHAR(30) NOT NULL,
  quantity INT NOT NULL DEFAULT 0,
  note VARCHAR(400) NULL,
  user_id INT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ph_order (production_order_id, created_at),
  INDEX idx_ph_time (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
