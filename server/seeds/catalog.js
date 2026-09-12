/**
 * Permission catalogue + role defaults.
 * This is the single source of truth; it is synced into the database at seed time
 * and on boot (syncPermissions) so new releases never leave a role without its grants.
 *
 * Rule used by `can()` (server/lib/permissions.js + client):
 *   - "*"                  -> everything
 *   - "<module>.read"      -> granted implicitly by "*.read"
 *   - everything else      -> must be granted explicitly
 */

export const MODULES = [
  'dashboard',
  'search',
  'filters',
  'vehicles',
  'tooling_types',
  'tooling',
  'tooling_sets',
  'compatibility',
  'dimensions',
  'files',
  'revisions',
  'locations',
  'movements',
  'maintenance',
  'damage',
  'requests',
  'production',
  'inventory',
  'labels',
  'reports',
  'importexport',
  'notifications',
  'users',
  'settings',
  'backups',
  'audit',
];

const ACTIONS = ['read', 'create', 'update', 'delete', 'manage'];

/** Human readable catalogue (code, module, action, description). */
export const PERMISSIONS = [];

function add(code, description) {
  const [module, action = 'any'] = code.split('.');
  if (PERMISSIONS.some((p) => p.code === code)) return;
  PERMISSIONS.push({ code, module, action, description });
}

add('*', 'Unrestricted access (administrators only)');
add('*.read', 'Read access to every module (base permission for all roles)');
for (const m of MODULES) {
  for (const a of ACTIONS) {
    add(`${m}.${a}`, `${a} ${m.replace(/_/g, ' ')}`);
  }
}
add('reports.export', 'Export reports to PDF / Excel');
add('labels.print', 'Print tooling and shelf labels');
add('tooling.reserve', 'Reserve tooling for a production order');
add('tooling.move', 'Record tooling movements (take / move / return)');
add('tooling.inspect', 'Record condition checks and cycle counts');
add('locations.map', 'Edit the warehouse layout (rows, racks, shelves, boxes)');
add('files.manage', 'Upload and delete photos, drawings and CAD files');
add('settings.manage', 'Change application settings');
add('backups.manage', 'Create, download and remove database backups');
add('backups.read', 'See the backup list and status');
add('audit.read', 'Read the audit log');
add('notifications.manage', 'Dismiss or resolve alerts for everyone');

/** Roles that ship with the system (spec §40). */
export const ROLE_PERMISSIONS = {
  admin: ['*'],
  engineering: [
    '*.read',
    'filters.create',
    'filters.update',
    'filters.delete',
    'vehicles.create',
    'vehicles.update',
    'vehicles.delete',
    'dimensions.manage',
    'tooling.create',
    'tooling.update',
    'tooling.manage',
    'tooling_types.manage',
    'tooling_sets.manage',
    'compatibility.manage',
    'files.manage',
    'revisions.manage',
    'requests.create',
    'requests.update',
    'damage.create',
    'reports.export',
    'importexport.manage',
    'notifications.manage',
  ],
  production: [
    '*.read',
    'production.create',
    'production.update',
    'production.manage',
    'requests.create',
    'tooling.reserve',
    'tooling.move',
    'damage.create',
    'inventory.update',
    'notifications.read',
  ],
  warehouse: [
    '*.read',
    'tooling.move',
    'tooling.update',
    'locations.manage',
    'locations.map',
    'inventory.update',
    'inventory.manage',
    'labels.print',
    'tooling.create',
    'compatibility.manage',
    'notifications.read',
  ],
  quality: [
    '*.read',
    'maintenance.manage',
    'damage.create',
    'damage.update',
    'tooling.inspect',
    'tooling.update',
    'requests.create',
    'labels.print',
    'notifications.read',
  ],
  sales: ['*.read', 'requests.create', 'reports.export'],
};

export const DEMO_ROLES = [
  { code: 'admin', name: 'Administrator', description: 'Full access to every module, users, settings and backups' },
  { code: 'engineering', name: 'Engineering', description: 'Filters, dimensions, tooling, CAD and technical drawings' },
  { code: 'production', name: 'Production', description: 'Production orders, tooling reservation and usage' },
  { code: 'warehouse', name: 'Warehouse', description: 'Locations, QR scanning, tool movements and inventory' },
  { code: 'quality', name: 'Quality Control', description: 'Tool condition, inspection and maintenance' },
  { code: 'sales', name: 'Sales', description: 'Filter search, vehicle applications and availability' },
];

/** Demo accounts created by the seeder (spec §59). */
export const DEMO_USERS = [
  { username: 'admin', password: 'Admin#2026', full_name: 'System Administrator', role: 'admin', department: 'IT', email: 'admin@purepower.example' },
  { username: 'engineering', password: 'Engineer#2026', full_name: 'Elena Marku', role: 'engineering', department: 'Engineering', email: 'elena@purepower.example' },
  { username: 'production', password: 'Production#2026', full_name: 'Dritan Hoxha', role: 'production', department: 'Production Planning', email: 'dritan@purepower.example' },
  { username: 'warehouse', password: 'Warehouse#2026', full_name: 'Ardit Kola', role: 'warehouse', department: 'Tool Room', email: 'ardit@purepower.example' },
  { username: 'quality', password: 'Quality#2026', full_name: 'Enkeleda Prifti', role: 'quality', department: 'Quality Control', email: 'enkeleda@purepower.example' },
  { username: 'sales', password: 'Sales#2026', full_name: 'Genti Berisha', role: 'sales', department: 'Sales', email: 'genti@purepower.example' },
];

export const TOOLING_STATUS = {
  AVAILABLE: { label: 'Available', color: '#16a34a', dot: '🟢' },
  IN_USE: { label: 'In Use', color: '#2563eb', dot: '🔵' },
  MAINTENANCE: { label: 'Maintenance Required', color: '#eab308', dot: '🟡' },
  RESERVED: { label: 'Reserved', color: '#f97316', dot: '🟠' },
  DAMAGED: { label: 'Damaged', color: '#dc2626', dot: '🔴' },
  RETIRED: { label: 'Retired', color: '#4b5563', dot: '⚫' },
  MISSING: { label: 'Missing', color: '#7c3aed', dot: '❓' },
};

export const TOOLING_STATUSES = Object.keys(TOOLING_STATUS);

export const CONDITION_RATINGS = ['EXCELLENT', 'GOOD', 'FAIR', 'POOR', 'CRITICAL'];

export const DAMAGE_TYPES = ['CRACKED', 'BROKEN', 'WORN', 'DEFORMED', 'DENTED', 'CORRODED', 'MISSING_PART', 'JAMMED', 'WRONG_DIMENSIONS', 'CONTAMINATED', 'OTHER'];

export const FILTER_TYPES = [
  { code: 'AIR', name: 'Air Filter', icon: '🌬', dimension_profile: 'panel', sort_order: 10 },
  { code: 'CABIN', name: 'Cabin Filter', icon: '🚗', dimension_profile: 'panel', sort_order: 20 },
  { code: 'OIL', name: 'Oil Filter', icon: '🛢', dimension_profile: 'spin_on', sort_order: 30 },
  { code: 'FUEL', name: 'Fuel Filter', icon: '⛽', dimension_profile: 'inline', sort_order: 40 },
  { code: 'HYDRAULIC', name: 'Hydraulic Filter', icon: '⚙', dimension_profile: 'spin_on', sort_order: 50 },
  { code: 'TRANSMISSION', name: 'Transmission Filter', icon: '🔧', dimension_profile: 'kit', sort_order: 60 },
  { code: 'OTHER', name: 'Other', icon: '📦', dimension_profile: 'general', sort_order: 90 },
];

export const BRANDS = [
  { code: 'BMW', name: 'BMW', country: 'DE' },
  { code: 'MERCEDES', name: 'Mercedes-Benz', country: 'DE' },
  { code: 'AUDI', name: 'Audi', country: 'DE' },
  { code: 'VOLKSWAGEN', name: 'Volkswagen', country: 'DE' },
  { code: 'FIAT', name: 'Fiat', country: 'IT' },
  { code: 'RENAULT', name: 'Renault', country: 'FR' },
  { code: 'TOYOTA', name: 'Toyota', country: 'JP' },
  { code: 'FORD', name: 'Ford', country: 'US' },
  { code: 'OPEL', name: 'Opel', country: 'DE' },
  { code: 'ALFA', name: 'Alfa Romeo', country: 'IT' },
];

export const XREF_BRANDS = [
  { code: 'OEM', name: 'OEM', country: null },
  { code: 'MANN', name: 'MANN Filter', country: 'DE' },
  { code: 'MAHLE', name: 'MAHLE', country: 'DE' },
  { code: 'BOSCH', name: 'Bosch', country: 'DE' },
  { code: 'HENGST', name: 'Hengst', country: 'DE' },
  { code: 'PURFLUX', name: 'Purflux', country: 'FR' },
  { code: 'FILTRON', name: 'Filtron', country: 'PL' },
  { code: 'UFI', name: 'UFI Filters', country: 'IT' },
  { code: 'DONALDSON', name: 'Donaldson', country: 'US' },
  { code: 'PURITOR', name: 'Puritor', country: 'US' },
  { code: 'OTHER', name: 'Other', country: null },
];

/** Tooling categories (spec §7). Codes double as the ID prefix of the tooling code. */
export const TOOLING_TYPES = [
  { code: 'RH', name: 'Rubber Forming Housing', group_name: 'Housings', icon: '🧿', id_prefix: 'H', requires_cycle_tracking: 1, requires_maintenance: 1, sort_order: 10 },
  { code: 'GH', name: 'Gasket Housing', group_name: 'Housings', icon: '⭕', id_prefix: 'GH', requires_cycle_tracking: 1, requires_maintenance: 1, sort_order: 20 },
  { code: 'RM', name: 'Rubber Mold', group_name: 'Molds', icon: '🧱', id_prefix: 'RM', requires_cycle_tracking: 1, requires_maintenance: 1, sort_order: 30 },
  { code: 'LI', name: 'Letter Insert', group_name: 'Inserts', icon: '🔤', id_prefix: 'LI', requires_cycle_tracking: 0, requires_maintenance: 0, sort_order: 40 },
  { code: 'NI', name: 'Number Insert', group_name: 'Inserts', icon: '🔢', id_prefix: 'NI', requires_cycle_tracking: 0, requires_maintenance: 0, sort_order: 50 },
  { code: 'LOI', name: 'Logo Insert', group_name: 'Inserts', icon: '🏷', id_prefix: 'LGI', requires_cycle_tracking: 0, requires_maintenance: 0, sort_order: 60 },
  { code: 'CT', name: 'Cutting Tool', group_name: 'Cutting', icon: '✂', id_prefix: 'CT', requires_cycle_tracking: 1, requires_maintenance: 1, sort_order: 70 },
  { code: 'CF', name: 'Cutting Fixture', group_name: 'Cutting', icon: '🪚', id_prefix: 'CF', requires_cycle_tracking: 1, requires_maintenance: 1, sort_order: 80 },
  { code: 'FT', name: 'Forming Tool', group_name: 'Forming', icon: '🛠', id_prefix: 'FT', requires_cycle_tracking: 1, requires_maintenance: 1, sort_order: 90 },
  { code: 'JIG', name: 'Jig', group_name: 'Fixtures', icon: '📐', id_prefix: 'J', requires_cycle_tracking: 0, requires_maintenance: 0, sort_order: 100 },
  { code: 'FIX', name: 'Fixture', group_name: 'Fixtures', icon: '🗜', id_prefix: 'FX', requires_cycle_tracking: 0, requires_maintenance: 0, sort_order: 110 },
  { code: 'TPL', name: 'Template', group_name: 'Templates', icon: '📋', id_prefix: 'TP', requires_cycle_tracking: 0, requires_maintenance: 0, sort_order: 120 },
  { code: 'MT', name: 'Measuring Tool', group_name: 'Measurement', icon: '📏', id_prefix: 'MS', requires_cycle_tracking: 0, requires_maintenance: 1, sort_order: 130 },
  { code: 'OTH', name: 'Other', group_name: 'Other', icon: '🔩', id_prefix: 'OT', requires_cycle_tracking: 0, requires_maintenance: 0, sort_order: 140 },
];

/** Standard tooling dimension labels (spec §9) — used to render the dynamic form. */
export const TOOLING_DIMENSION_FIELDS = [
  { key: 'overall_length_mm', label: 'Overall length', unit: 'mm', group: 'Overall' },
  { key: 'overall_width_mm', label: 'Overall width', unit: 'mm', group: 'Overall' },
  { key: 'overall_height_mm', label: 'Overall height', unit: 'mm', group: 'Overall' },
  { key: 'internal_length_mm', label: 'Internal opening length', unit: 'mm', group: 'Internal opening' },
  { key: 'internal_width_mm', label: 'Internal opening width', unit: 'mm', group: 'Internal opening' },
  { key: 'internal_height_mm', label: 'Internal opening height', unit: 'mm', group: 'Internal opening' },
  { key: 'overall_diameter_mm', label: 'Overall diameter (OD)', unit: 'mm', group: 'Overall', note: 'round / spin-on tooling' },
  { key: 'internal_diameter_mm', label: 'Internal diameter (bore)', unit: 'mm', group: 'Internal opening', note: 'the cavity the part forms around' },
  { key: 'wall_thickness_mm', label: 'Wall thickness', unit: 'mm', group: 'Rubber channel' },
  { key: 'channel_width_mm', label: 'Rubber channel width', unit: 'mm', group: 'Rubber channel' },
  { key: 'channel_depth_mm', label: 'Rubber channel depth', unit: 'mm', group: 'Rubber channel' },
  { key: 'corner_radius_mm', label: 'Corner radius', unit: 'mm', group: 'Corners' },
  { key: 'hole_diameter_mm', label: 'Hole diameter', unit: 'mm', group: 'Holes' },
  { key: 'hole_count', label: 'Hole count', unit: 'pcs', group: 'Holes' },
  { key: 'hole_position', label: 'Hole position', unit: null, group: 'Holes', type: 'text' },
  { key: 'hole_distance_mm', label: 'Distance between mounting holes', unit: 'mm', group: 'Mounting' },
  { key: 'mounting_dimensions', label: 'Mounting dimensions', unit: null, group: 'Mounting', type: 'text' },
  { key: 'letter_position', label: 'Letter position', unit: null, group: 'Marking', type: 'text' },
  { key: 'letter_size_mm', label: 'Letter size', unit: 'mm', group: 'Marking' },
  { key: 'letter_count', label: 'Letter count', unit: 'pcs', group: 'Marking' },
  { key: 'logo_position', label: 'Logo position', unit: null, group: 'Marking', type: 'text' },
  { key: 'logo_size_mm', label: 'Logo size', unit: 'mm', group: 'Marking' },
  { key: 'depth_mm', label: 'Depth', unit: 'mm', group: 'Overall' },
];

export const FILTER_DIMENSION_FIELDS = [
  { key: 'length_mm', label: 'Length', unit: 'mm', profiles: ['panel', 'general', 'kit'] },
  { key: 'width_mm', label: 'Width', unit: 'mm', profiles: ['panel', 'general', 'kit'] },
  { key: 'height_mm', label: 'Height', unit: 'mm', profiles: ['panel', 'general', 'kit', 'inline'] },
  { key: 'outer_diameter_mm', label: 'Outer diameter', unit: 'mm', profiles: ['spin_on', 'inline', 'general'] },
  { key: 'inner_diameter_mm', label: 'Inner diameter', unit: 'mm', profiles: ['spin_on', 'inline', 'general'] },
  { key: 'overall_diameter_mm', label: 'Overall diameter', unit: 'mm', profiles: ['spin_on', 'general'] },
  { key: 'thread_spec', label: 'Thread', unit: null, profiles: ['spin_on', 'inline', 'general'], type: 'text' },
  { key: 'thread_size_mm', label: 'Thread size', unit: 'mm', profiles: ['spin_on'] },
  { key: 'gasket_diameter_mm', label: 'Gasket diameter', unit: 'mm', profiles: ['spin_on', 'inline', 'kit', 'general'] },
  { key: 'gasket_thickness_mm', label: 'Gasket thickness', unit: 'mm', profiles: ['spin_on', 'inline', 'kit', 'general'] },
  { key: 'gasket_inner_diameter_mm', label: 'Gasket inner diameter', unit: 'mm', profiles: ['spin_on', 'kit'] },
  { key: 'weight_grams', label: 'Weight', unit: 'g', profiles: null },
  { key: 'pleat_count', label: 'Pleat count', unit: 'pcs', profiles: ['panel', 'spin_on', 'cabin'] },
  { key: 'pleat_height_mm', label: 'Pleat height', unit: 'mm', profiles: ['panel', 'spin_on', 'cabin'] },
];

/** App-level defaults written to app_settings on first run. */
export const APP_SETTINGS = [
  { key: 'company_name', value: 'Sistemi Purepower', label: 'Company name', group: 'General', type: 'string', is_public: 1 },
  { key: 'company_logo_text', value: 'PUREPOWER', label: 'Logo text for printed labels', group: 'General', type: 'string', is_public: 1 },
  { key: 'unit_default', value: 'mm', label: 'Default dimension unit', group: 'General', type: 'select', is_public: 1 },
  { key: 'dimension_tolerance_mm', value: '2', label: 'Default dimension search tolerance (mm)', group: 'Search', type: 'number', is_public: 1 },
  { key: 'duplicate_similarity_pct', value: '90', label: 'Duplicate detection similarity threshold (%)', group: 'Tooling', type: 'number', is_public: 1 },
  { key: 'shelf_fill_nearly_pct', value: '70', label: 'Shelf "nearly full" threshold (%)', group: 'Warehouse', type: 'number', is_public: 1 },
  { key: 'shelf_fill_full_pct', value: '90', label: 'Shelf "full" threshold (%)', group: 'Warehouse', type: 'number', is_public: 1 },
  { key: 'maintenance_reminder_days', value: '14', label: 'Notify maintenance due N days ahead', group: 'Maintenance', type: 'number', is_public: 1 },
  { key: 'cycle_warning_pct', value: '85', label: 'Warn at % of max cycles', group: 'Maintenance', type: 'number', is_public: 1 },
  { key: 'scan_open_mode', value: 'tool', label: 'QR payload mode (tool | url)', group: 'Warehouse', type: 'select', is_public: 1 },
  { key: 'base_url', value: '', label: 'Public base URL used inside QR codes', group: 'Warehouse', type: 'string', is_public: 1 },
  { key: 'backup_keep_count', value: '10', label: 'Keep last N backups', group: 'Backup', type: 'number', is_public: 0 },
  { key: 'backup_schedule', value: 'daily-02:00', label: 'Automatic backup schedule (server cron)', group: 'Backup', type: 'string', is_public: 0 },
];

export const LABEL_TEMPLATES = [
  { name: 'Tool label 70×40 (2-up)', kind: 'TOOLING', width_mm: 70, height_mm: 40, columns_per_row: 2, rows_per_page: 6, show_logo: 1, show_type: 1, show_filter: 1, show_location: 1, show_status: 1, is_default: 1 },
  { name: 'Tool label 50×25 (compact)', kind: 'TOOLING', width_mm: 50, height_mm: 25, columns_per_row: 3, rows_per_page: 10, show_logo: 0, show_type: 1, show_filter: 1, show_location: 1, show_status: 0, font_scale: 0.82 },
  { name: 'Tool label 100×60 (large)', kind: 'TOOLING', width_mm: 100, height_mm: 60, columns_per_row: 1, rows_per_page: 4, show_logo: 1, show_type: 1, show_filter: 1, show_location: 1, show_dimensions: 1, show_status: 1, font_scale: 1.3 },
  { name: 'Shelf label 100×50', kind: 'LOCATION', width_mm: 100, height_mm: 50, columns_per_row: 1, rows_per_page: 5, show_logo: 1, show_type: 0, show_filter: 0, show_location: 1, show_status: 0, font_scale: 1.25 },
  { name: 'Rack label 150×100', kind: 'LOCATION', width_mm: 150, height_mm: 100, columns_per_row: 1, rows_per_page: 2, show_logo: 1, show_type: 0, show_filter: 0, show_location: 1, show_status: 0, font_scale: 1.6 },
];

export { ACTIONS };
