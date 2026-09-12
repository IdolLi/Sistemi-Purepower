-- Round (spin-on / cartridge) tooling needs a diameter, not just a bounding box.
ALTER TABLE tooling_dimensions ADD COLUMN overall_diameter_mm DECIMAL(10,3) NULL AFTER overall_height_mm;
ALTER TABLE tooling_dimensions ADD COLUMN internal_diameter_mm DECIMAL(10,3) NULL AFTER overall_diameter_mm;
ALTER TABLE tooling_dimensions ADD COLUMN outer_wall_mm DECIMAL(10,3) NULL AFTER internal_diameter_mm;
ALTER TABLE tooling_dimensions ADD INDEX idx_td_diameter (overall_diameter_mm);
