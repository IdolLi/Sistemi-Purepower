/**
 * Demo dataset generator (spec §59) - also used in "perf" mode to scale the dataset up
 * to thousands of records so pagination/indexing can be verified.
 *
 * Produces internally consistent data: filters, dimensions, cross references, vehicle
 * applications, tooling sets, tooling items, tooling dimensions, technical reference
 * photos, locations, movements, reservations, maintenance, damage reports, requests,
 * production orders, usage history, inventory and packaging.
 */
import fs from 'node:fs';
import path from 'node:path';
import config from '../config.js';
import db from '../db/index.js';
import logger from '../lib/logger.js';
import { renderToolingImage } from '../services/referenceImage.js';
import { FILTER_TYPES } from './catalog.js';

/* ------------------------------------------------------------------ util */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const iso = (d) => d.toISOString().slice(0, 10);
const isoT = (d) => d.toISOString().slice(0, 19).replace('T', ' ');
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
const pad = (row, keys, fallback = null) => {
  const out = {};
  for (const k of keys) out[k] = row[k] === undefined || row[k] === null ? fallback : row[k];
  return out;
};
/** pad() but keeps real NULLs (only fills keys that are absent). */
const padSparse = (row, keys) => {
  const out = {};
  for (const k of keys) out[k] = row[k] === undefined ? null : row[k];
  return out;
};

const NOTNULL = ['filter_tooling_requirements.quantity_required', 'tooling_items.quantity', 'production_orders.quantity_ordered', 'inventory.quantity'];

/* -------------------------------------------------------------- dataset */
const VEHICLES = [
  ['BMW', '3 Series', 'F30', 2012, 2019, '320d', 'B47D20', 'Diesel', 190],
  ['BMW', '3 Series', 'F30', 2012, 2019, '318d', 'B47D20', 'Diesel', 150],
  ['BMW', 'X1', 'F48', 2015, 2022, 'sDrive18d', 'B47D20', 'Diesel', 150],
  ['BMW', '5 Series', 'G30', 2017, 2023, '520d', 'B47D20', 'Diesel', 190],
  ['Volkswagen', 'Golf VII', 'AU', 2012, 2020, '1.6 TDI', 'CXXB', 'Diesel', 115],
  ['Volkswagen', 'Passat B8', 'MQB', 2014, 2023, '2.0 TDI', 'DFHA', 'Diesel', 150],
  ['Volkswagen', 'Tiguan II', 'MQB', 2016, 2024, '2.0 TDI', 'DFGA', 'Diesel', 150],
  ['Audi', 'A4 B9', 'MQB', 2015, 2023, '2.0 TDI', 'DEUA', 'Diesel', 190],
  ['Audi', 'A3 8V', 'MQB', 2012, 2020, '1.6 TDI', 'CLHA', 'Diesel', 110],
  ['Audi', 'Q5 FY', 'MLB', 2017, 2024, '2.0 TDI', 'DFTA', 'Diesel', 190],
  ['Mercedes-Benz', 'C-Class', 'W205', 2014, 2021, 'C220d', 'OM654', 'Diesel', 170],
  ['Mercedes-Benz', 'Sprinter', 'VS30', 2018, 2024, '314 CDI', 'OM651', 'Diesel', 143],
  ['Fiat', 'Panda', '319', 2012, 2020, '1.2', '310A10', 'Petrol', 69],
  ['Fiat', 'Ducato', '250', 2014, 2024, '2.0 MultiJet', '452HX', 'Diesel', 136],
  ['Alfa Romeo', 'Giulia', '952', 2016, 2024, '2.2 JTDm', '6H6', 'Diesel', 150],
  ['Alfa Romeo', 'Stelvio', '949', 2017, 2024, '2.2 JTDm', '6H6', 'Diesel', 190],
  ['Renault', 'Megane IV', 'CMF', 2016, 2024, '1.5 dCi', 'K9K872', 'Diesel', 110],
  ['Renault', 'Trafic III', 'CMF', 2014, 2024, '1.6 dCi', 'R9M062', 'Diesel', 120],
  ['Opel', 'Astra K', 'K2XX', 2015, 2022, '1.6 CDTI', 'B16DTL', 'Diesel', 136],
  ['Ford', 'Transit', 'V362', 2014, 2024, '2.0 EcoBlue', 'YNFA', 'Diesel', 170],
  ['Toyota', 'Hilux', 'AN120', 2015, 2024, '2.4 D-4D', '2GD-FTV', 'Diesel', 150],
  ['Toyota', 'Corolla', 'E210', 2019, 2024, '1.8 Hybrid', '2ZR-FXE', 'Hybrid', 122],
];

const FILTERS = [
  {
    seq: '00452',
    type: 'AIR',
    brand: 'BMW',
    family: 'BMW-F30',
    name: 'Air filter panel - BMW B47 2.0d',
    dims: { length_mm: 310, width_mm: 220, height_mm: 55, pleat_count: 48, pleat_height_mm: 32, weight_grams: 520 },
    materials: { media_type: 'Paper cellulose 220g', glue_type: 'PU hot melt', end_cap_material: 'PU foam seal', mesh_type: 'PE mesh 40um', production_machine: 'AutoFlex 4000', standard_batch_qty: 500, cycle_time_seconds: 42 },
    xrefs: [['OEM', '13718572970'], ['OEM', '13717823241'], ['MANN', 'C32015'], ['MAHLE', 'LX3898/1'], ['BOSCH', 'S 6970 L'], ['FILTRON', 'AR700214']],
    vehicles: [0, 1, 2, 3],
    tools: [
      { type: 'RH', name: 'Rubber forming housing 310x220', rev: 1, dims: { overall_length_mm: 420, overall_width_mm: 180, overall_height_mm: 65, internal_length_mm: 310, internal_width_mm: 155, wall_thickness_mm: 8, channel_width_mm: 12, channel_depth_mm: 10, corner_radius_mm: 14, hole_diameter_mm: 11, hole_count: 4, hole_distance_mm: 300, letter_position: 'Front face centre', letter_size_mm: 14, letter_count: 9 }, cycles: 1850, max: 2500, material: 'Steel S235 welded', qty: 1, status: 'AVAILABLE', loc: [2, 4, 3, 7] },
      { type: 'LI', name: 'Letter insert PP-CF-00452', dims: { overall_length_mm: 190, overall_width_mm: 26, overall_height_mm: 12, letter_size_mm: 14, letter_count: 9, letter_position: 'Front face centre' }, status: 'AVAILABLE', loc: [2, 4, 4, 2] },
      { type: 'CF', name: 'Cutting fixture 310x220', rev: 2, dims: { overall_length_mm: 340, overall_width_mm: 250, overall_height_mm: 90, hole_diameter_mm: 9, hole_count: 6, mounting_dimensions: '300x210 c/c' }, cycles: 9800, max: 12000, material: 'Aluminium 6082-T6', status: 'MAINTENANCE', loc: [2, 4, 3, 5], note: 'Blade holder worn - under maintenance' },
      { type: 'GH', name: 'Gasket housing 215x45', dims: { overall_length_mm: 240, overall_width_mm: 70, overall_height_mm: 45, internal_length_mm: 215, internal_width_mm: 45, channel_width_mm: 8, channel_depth_mm: 6, corner_radius_mm: 6 }, cycles: 6200, max: 9000, material: 'Steel C45', status: 'AVAILABLE', loc: [2, 4, 3, 9] },
    ],
  },
  {
    seq: '00781',
    type: 'AIR',
    brand: 'Volkswagen',
    family: 'VW-MQB',
    name: 'Air filter panel - VW Golf VII 1.6 TDI',
    dims: { length_mm: 285, width_mm: 195, height_mm: 48, pleat_count: 42, pleat_height_mm: 28, weight_grams: 430 },
    materials: { media_type: 'Paper cellulose 200g', glue_type: 'PU hot melt', end_cap_material: 'PU foam seal', production_machine: 'AutoFlex 4000', standard_batch_qty: 600, cycle_time_seconds: 38 },
    xrefs: [['OEM', '1K0129620'], ['MANN', 'C3184'], ['MAHLE', 'LX3553'], ['BOSCH', 'S 6876 A'], ['HENGST', 'E491L']],
    vehicles: [4, 8],
    tools: [
      { type: 'RH', name: 'Rubber forming housing 285x195', dims: { overall_length_mm: 421, overall_width_mm: 180, overall_height_mm: 64, internal_length_mm: 285, internal_width_mm: 170, wall_thickness_mm: 8, channel_width_mm: 12, channel_depth_mm: 10, corner_radius_mm: 12, letter_size_mm: 12, letter_count: 9, letter_position: 'Front face centre' }, cycles: 940, max: 2500, material: 'Steel S235 welded', status: 'AVAILABLE', loc: [2, 4, 1, 3] },
      { type: 'LI', name: 'Letter insert PP-CF-00781', dims: { overall_length_mm: 176, overall_width_mm: 24, overall_height_mm: 12, letter_size_mm: 12, letter_count: 9, letter_position: 'Front face centre' }, status: 'AVAILABLE', loc: [2, 4, 1, 4] },
      { type: 'CF', name: 'Cutting fixture 285x195', dims: { overall_length_mm: 320, overall_width_mm: 225, overall_height_mm: 88, hole_count: 6, hole_diameter_mm: 9 }, cycles: 4100, max: 12000, status: 'AVAILABLE', loc: [2, 4, 1, 6] },
    ],
  },
  {
    seq: '00912',
    type: 'AIR',
    brand: 'Volkswagen',
    family: 'VW-MQB',
    name: 'Air filter panel - VW Passat B8 2.0 TDI',
    dims: { length_mm: 288, width_mm: 197, height_mm: 49, pleat_count: 44, pleat_height_mm: 30, weight_grams: 445 },
    materials: { media_type: 'Paper cellulose 200g', glue_type: 'PU hot melt', end_cap_material: 'PU foam seal', production_machine: 'AutoFlex 4000', standard_batch_qty: 600 },
    xrefs: [['OEM', '3G0129620'], ['MANN', 'C32009'], ['PURFLUX', 'A1272'], ['UFI', '30-245/2']],
    vehicles: [5, 6],
    shared_with: '00452',
    tools: [{ type: 'LI', name: 'Letter insert PP-CF-00912', dims: { overall_length_mm: 178, overall_width_mm: 24, overall_height_mm: 12, letter_size_mm: 12, letter_count: 9, letter_position: 'Front face centre' }, status: 'AVAILABLE', loc: [2, 4, 2, 8] }],
  },
  {
    seq: '00318',
    type: 'CABIN',
    brand: 'BMW',
    family: 'BMW-F30',
    name: 'Cabin filter activated carbon - BMW F30',
    dims: { length_mm: 250, width_mm: 220, height_mm: 30, pleat_count: 60, pleat_height_mm: 14, weight_grams: 380 },
    materials: { media_type: 'Activated carbon nonwoven', glue_type: 'Hot melt bead', end_cap_material: 'Frameless', production_machine: 'CabinLine 2', standard_batch_qty: 800 },
    xrefs: [['OEM', '64119229645'], ['MANN', 'CUK2939'], ['MAHLE', 'LA349/2'], ['BOSCH', '6982C']],
    vehicles: [0, 1, 3],
    tools: [
      { type: 'TPL', name: 'Frame template 250x220x30', dims: { overall_length_mm: 262, overall_width_mm: 232, overall_height_mm: 6, internal_length_mm: 250, internal_width_mm: 220 }, status: 'AVAILABLE', loc: [1, 1, 1, 2] },
      { type: 'CT', name: 'Foam cutting blade 262', dims: { overall_length_mm: 262, overall_width_mm: 18, overall_height_mm: 3, hole_count: 24 }, cycles: 15200, max: 20000, status: 'AVAILABLE', loc: [1, 1, 1, 3] },
    ],
  },
  {
    seq: '01204',
    type: 'OIL',
    brand: 'BMW',
    family: 'BMW-F30',
    name: 'Spin-on oil filter - BMW B47',
    dims: { overall_diameter_mm: 76, overall_height_mm: 65, thread_spec: 'M20x1.5', thread_size_mm: 20, gasket_diameter_mm: 65, gasket_thickness_mm: 3, gasket_inner_diameter_mm: 45, weight_grams: 310, pleat_count: 32, pleat_height_mm: 42 },
    materials: { media_type: 'Phenolic resin paper', glue_type: 'Epoxy', end_cap_material: 'Steel plate 0.8mm', mesh_type: 'Wire mesh support', production_machine: 'SpinLine 8', standard_batch_qty: 1200, cycle_time_seconds: 22 },
    xrefs: [['OEM', '11428591096'], ['OEM', '11427842251'], ['MANN', 'HU8012z'], ['MAHLE', 'OX1171D'], ['BOSCH', '0986452074']],
    vehicles: [0, 2, 3],
    tools: [
      { type: 'RM', name: 'Spin-on rubber mold D76', dims: { overall_diameter_mm: 96, overall_height_mm: 78, internal_diameter_mm: 76, wall_thickness_mm: 10 }, cycles: 21800, max: 30000, material: 'Tool steel 1.2344 hardened', status: 'AVAILABLE', loc: [1, 2, 1, 1] },
      { type: 'FT', name: 'Can forming tool D76', dims: { overall_diameter_mm: 82, overall_height_mm: 70, internal_diameter_mm: 76 }, cycles: 18400, max: 40000, status: 'IN_USE', external: 'Production Line 1' },
      { type: 'NI', name: 'Number insert batch code', dims: { overall_length_mm: 120, overall_width_mm: 20, overall_height_mm: 10, letter_size_mm: 8, letter_count: 8, letter_position: 'Ring circumference' }, status: 'AVAILABLE', loc: [1, 2, 1, 4] },
    ],
  },
  {
    seq: '01330',
    type: 'OIL',
    brand: 'Fiat',
    family: 'Fiat-1.4',
    name: 'Cartridge oil filter - Fiat 1.4 16V',
    dims: { outer_diameter_mm: 68, inner_diameter_mm: 32, overall_height_mm: 118, gasket_diameter_mm: 62, gasket_thickness_mm: 2.5, weight_grams: 210, pleat_count: 26 },
    materials: { media_type: 'Cellulose + synthetic blend', glue_type: 'Epoxy end-dip', end_cap_material: 'PU cover plate', production_machine: 'SpinLine 4', standard_batch_qty: 1500 },
    xrefs: [['OEM', '55264134'], ['MANN', 'HU7008z'], ['PURFLUX', 'AD127C'], ['UFI', '2322100']],
    vehicles: [12],
    tools: [
      { type: 'RM', name: 'Cartridge mold D68x118', dims: { overall_diameter_mm: 88, overall_height_mm: 132, internal_diameter_mm: 68, wall_thickness_mm: 9 }, cycles: 8600, max: 30000, status: 'AVAILABLE', loc: [1, 2, 2, 3] },
      { type: 'GH', name: 'Gasket housing 62x45', dims: { overall_length_mm: 80, overall_width_mm: 62, overall_height_mm: 45, internal_length_mm: 62, internal_width_mm: 45, channel_width_mm: 7, channel_depth_mm: 5 }, status: 'AVAILABLE', loc: [1, 2, 2, 5] },
    ],
  },
  {
    seq: '02210',
    type: 'FUEL',
    brand: 'BMW',
    family: 'BMW-F30',
    name: 'Fuel filter module inline - BMW F30',
    dims: { length_mm: 168, overall_height_mm: 68, outer_diameter_mm: 68, inner_diameter_mm: 42, thread_spec: 'Quick connector 8mm', weight_grams: 340 },
    materials: { media_type: 'Glass fibre 10um', glue_type: 'Ultrasonic weld', production_machine: 'FuelLine 2', standard_batch_qty: 400 },
    xrefs: [['OEM', '13328515786'], ['BOSCH', '0986AF4486'], ['MAHLE', 'KX265D']],
    vehicles: [0, 1],
    tools: [
      { type: 'FT', name: 'End cap forming tool D68', dims: { overall_diameter_mm: 72, overall_height_mm: 40 }, cycles: 5400, max: 20000, status: 'AVAILABLE', loc: [1, 2, 3, 1] },
      { type: 'FIX', name: 'Connector holding fixture', dims: { overall_length_mm: 140, overall_width_mm: 80, overall_height_mm: 55, hole_diameter_mm: 8, hole_count: 4, hole_distance_mm: 90 }, status: 'AVAILABLE', loc: [1, 2, 3, 2] },
    ],
  },
  {
    seq: '02455',
    type: 'FUEL',
    brand: 'Volkswagen',
    family: 'VW-MQB',
    name: 'Fuel filter canister - VW 2.0 TDI',
    dims: { length_mm: 155, overall_height_mm: 64, outer_diameter_mm: 64, gasket_diameter_mm: 58, gasket_thickness_mm: 2, weight_grams: 295 },
    materials: { media_type: 'Microfibre 8um', glue_type: 'Epoxy', production_machine: 'FuelLine 2', standard_batch_qty: 400 },
    xrefs: [['OEM', '1K0201511'], ['MANN', 'WK9030'], ['FILTRON', 'PP8109']],
    vehicles: [4, 5],
    tools: [{ type: 'RM', name: 'Canister mold 155x64', dims: { overall_diameter_mm: 84, overall_height_mm: 168, internal_diameter_mm: 64 }, cycles: 3200, max: 25000, status: 'AVAILABLE', loc: [1, 2, 3, 6] }],
  },
  {
    seq: '03120',
    type: 'HYDRAULIC',
    brand: 'Mercedes-Benz',
    family: 'MB-SPRINTER',
    name: 'Hydraulic return filter - Sprinter',
    dims: { outer_diameter_mm: 92, inner_diameter_mm: 40, overall_height_mm: 185, thread_spec: 'M24x1.5', weight_grams: 620 },
    materials: { media_type: 'Glass fibre 25um', end_cap_material: 'NBR + metal plate', production_machine: 'HydroLine 1', standard_batch_qty: 200 },
    xrefs: [['OEM', 'A9062900051'], ['DONALDSON', 'P164326'], ['MAHLE', 'HX80/10']],
    vehicles: [11],
    tools: [
      { type: 'RM', name: 'Hydraulic mold D92x185', dims: { overall_diameter_mm: 112, overall_height_mm: 200, internal_diameter_mm: 92 }, cycles: 1100, max: 20000, status: 'AVAILABLE', loc: null, wh: 'SP', locRef: [1, 1, 1, 2] },
      { type: 'MT', name: 'Bore check gauge D92', dims: { overall_length_mm: 200, overall_width_mm: 40, overall_height_mm: 12, internal_length_mm: 92, letter_size_mm: 0.05 }, status: 'AVAILABLE', loc: null, wh: 'SP', locRef: [1, 1, 1, 3] },
    ],
  },
  {
    seq: '04010',
    type: 'TRANSMISSION',
    brand: 'Renault',
    family: 'Renault-CMF',
    name: 'Transmission filter kit with pan gasket - Megane',
    dims: { length_mm: 240, width_mm: 165, height_mm: 38, gasket_thickness_mm: 2.5, weight_grams: 460 },
    materials: { media_type: 'Felt + magnetic trap', glue_type: 'PU bead', end_cap_material: 'PP cover', production_machine: 'TransLine 1', standard_batch_qty: 250 },
    xrefs: [['OEM', '8200004432'], ['PURFLUX', 'AH1124'], ['UFI', '30.215.00']],
    vehicles: [16, 17],
    tools: [
      { type: 'RH', name: 'Tray forming housing 240x165', dims: { overall_length_mm: 348, overall_width_mm: 250, overall_height_mm: 72, internal_length_mm: 240, internal_width_mm: 165, wall_thickness_mm: 9, channel_width_mm: 10, channel_depth_mm: 8, corner_radius_mm: 16, hole_count: 6, hole_diameter_mm: 8, hole_distance_mm: 250, letter_size_mm: 10, letter_position: 'Long side' }, cycles: 4300, max: 8000, status: 'AVAILABLE', loc: [3, 1, 1, 2] },
      { type: 'GH', name: 'Pan gasket housing 240', dims: { overall_length_mm: 264, overall_width_mm: 40, overall_height_mm: 30, internal_length_mm: 240, internal_width_mm: 16, channel_width_mm: 6, channel_depth_mm: 4 }, status: 'AVAILABLE', loc: [3, 1, 1, 4] },
      { type: 'LI', name: 'Letter insert ATF-04010', dims: { overall_length_mm: 150, overall_width_mm: 22, overall_height_mm: 10, letter_size_mm: 10, letter_count: 8, letter_position: 'Long side' }, status: 'AVAILABLE', loc: [3, 1, 1, 5] },
      { type: 'JIG', name: 'Drain plug drill jig', dims: { overall_length_mm: 120, overall_width_mm: 60, overall_height_mm: 45, hole_diameter_mm: 12, hole_count: 1 }, status: 'DAMAGED', loc: [3, 1, 1, 9], note: 'Bushed locating pin cracked' },
    ],
  },
  {
    seq: '00660',
    type: 'AIR',
    brand: 'Opel',
    name: 'Air filter panel - Astra K 1.6 CDTI',
    dims: { length_mm: 232, width_mm: 178, height_mm: 50, pleat_count: 36, weight_grams: 410 },
    materials: { media_type: 'Paper cellulose 190g', glue_type: 'PU hot melt', production_machine: 'AutoFlex 4000', standard_batch_qty: 450 },
    xrefs: [['OEM', '55355112'], ['MANN', 'C32019'], ['BOSCH', 'S 6974 L']],
    vehicles: [18],
    tools: [
      { type: 'RH', name: 'Rubber forming housing 232x178', dims: { overall_length_mm: 340, overall_width_mm: 230, overall_height_mm: 60, internal_length_mm: 232, internal_width_mm: 178, wall_thickness_mm: 8, channel_width_mm: 11, channel_depth_mm: 9, corner_radius_mm: 10 }, cycles: 2100, max: 6000, status: 'AVAILABLE', loc: [3, 2, 1, 1] },
      { type: 'LI', name: 'Letter insert PP-CF-00660', dims: { overall_length_mm: 160, overall_width_mm: 24, overall_height_mm: 12, letter_size_mm: 12, letter_count: 9 }, status: 'AVAILABLE', loc: [3, 2, 1, 2] },
    ],
  },
  {
    seq: '00745',
    type: 'OIL',
    brand: 'Ford',
    name: 'Spin-on oil filter - Transit 2.0 EcoBlue',
    dims: { overall_diameter_mm: 93, overall_height_mm: 110, thread_spec: '3/4-16UNF', weight_grams: 420, gasket_diameter_mm: 80, gasket_thickness_mm: 3 },
    materials: { media_type: 'Synthetic blend', glue_type: 'Epoxy', production_machine: 'SpinLine 8', standard_batch_qty: 800 },
    xrefs: [['OEM', 'CK3Q9601CB'], ['MANN', 'W940/30'], ['MAHLE', 'OX356D']],
    vehicles: [19],
    tools: [
      { type: 'RM', name: 'Spin-on mold D93x110', dims: { overall_diameter_mm: 115, overall_height_mm: 124, internal_diameter_mm: 93 }, cycles: 28400, max: 30000, status: 'AVAILABLE', loc: [5, 1, 1, 2] },
      { type: 'FT', name: 'Can forming tool D93', dims: { overall_diameter_mm: 100, overall_height_mm: 118 }, cycles: 26000, max: 40000, status: 'AVAILABLE', loc: [5, 1, 1, 3] },
    ],
  },
];

/** Extra filters that deliberately share PP-CF-00452 tooling (family + compatibility demo). */
const FAMILY_FILTERS = [
  { seq: '00453', brand: 'BMW', type: 'AIR', name: 'Air filter panel - BMW 320d high-flow variant', dims: { length_mm: 310, width_mm: 220, height_mm: 55 }, vehicles: [0] },
  { seq: '00454', brand: 'BMW', type: 'AIR', name: 'Air filter panel - BMW 318d (2016+)', dims: { length_mm: 310, width_mm: 220, height_mm: 54.5 }, vehicles: [1, 2] },
  { seq: '00455', brand: 'BMW', type: 'AIR', name: 'Air filter panel - BMW 520d G30', dims: { length_mm: 311, width_mm: 220, height_mm: 55 }, vehicles: [3] },
];

const WAREHOUSES = [
  {
    code: 'TR', name: 'Tool Room (Main)', warehouse_type: 'TOOL_ROOM', level_prefix: 'R', level_label: 'Row', address: 'Hall A, ground floor', manager: 'Ardit Kola',
    rows: [
      { code: 'R01', label: 'Row 01 - templates & blades', racks: [{ code: 'RK01', shelves: 2, cap: 12 }, { code: 'RK02', shelves: 2, cap: 12 }] },
      { code: 'R02', label: 'Row 02 - rubber housings', racks: [{ code: 'RK04', shelves: 4, cap: 10 }, { code: 'RK05', shelves: 3, cap: 10 }, { code: 'RK06', shelves: 2, cap: 8 }] },
      { code: 'R03', label: 'Row 03 - transmission & fixtures', racks: [{ code: 'RK07', shelves: 3, cap: 10 }, { code: 'RK08', shelves: 2, cap: 10 }] },
      { code: 'R04', label: 'Row 04 - inserts & small tooling', racks: [{ code: 'RK09', shelves: 3, cap: 14 }, { code: 'RK10', shelves: 2, cap: 14 }] },
      { code: 'R05', label: 'Row 05 - heavy molds', racks: [{ code: 'RK11', shelves: 3, cap: 6 }, { code: 'RK12', shelves: 2, cap: 6 }] },
      { code: 'R06', label: 'Row 06 - spare copies (currently empty)', racks: [{ code: 'RK13', shelves: 2, cap: 10 }] },
    ],
  },
  {
    code: 'SP', name: 'Spare Tooling Store', warehouse_type: 'STORE', level_prefix: 'R', level_label: 'Row', address: 'Hall B, mezzanine', manager: 'Ardit Kola',
    rows: [{ code: 'R01', label: 'Row 01 - spares', racks: [{ code: 'RK01', shelves: 3, cap: 8 }, { code: 'RK02', shelves: 2, cap: 8 }] }],
  },
  {
    code: 'OT', name: 'External Tooling Store', warehouse_type: 'EXTERNAL', level_prefix: 'Z', level_label: 'Zone', address: 'Off-site - ToolTech shpk', manager: 'Third party',
    rows: [{ code: 'Z01', label: 'Zone 01 - outsourced molds', racks: [{ code: 'RK01', shelves: 2, cap: 20 }] }],
  },
];

const TOOL_DEFAULTS = {
  status: 'AVAILABLE',
  condition_rating: 'GOOD',
  quantity: 1,
  is_tracked: 1,
  total_cycles: 0,
  total_parts_produced: 0,
  cycle_warning_pct: 85,
  open_damage_reports: 0,
  reserved_qty: 0,
  current_revision: 1,
};
/** pad() for tooling_items: never nulls out NOT NULL columns that have table defaults. */
const padTool = (row) => {
  const filled = { ...TOOL_DEFAULTS, ...stripNulls(row) };
  return padSparse(filled, TOOL_KEYS);
};
const stripNulls = (row) => {
  const out = {};
  for (const [k, v] of Object.entries(row)) if (v !== null) out[k] = v;
  return out;
};

const DIM_KEYS = [
  'overall_length_mm', 'overall_width_mm', 'overall_height_mm', 'overall_diameter_mm', 'internal_diameter_mm', 'outer_wall_mm',
  'internal_length_mm', 'internal_width_mm', 'internal_height_mm',
  'wall_thickness_mm', 'channel_width_mm', 'channel_depth_mm', 'corner_radius_mm', 'hole_diameter_mm', 'hole_count', 'hole_position',
  'hole_distance_mm', 'mounting_dimensions', 'letter_position', 'letter_size_mm', 'letter_count', 'logo_position', 'logo_size_mm', 'depth_mm', 'custom_values',
];
const TOOL_KEYS = [
  'tooling_id', 'name', 'tooling_type_id', 'tooling_set_id', 'primary_filter_id', 'status', 'condition_rating', 'material', 'manufacturer', 'supplier',
  'weight_grams', 'quantity', 'serial_number', 'barcode', 'qr_payload', 'manufacturing_date', 'purchase_date', 'warranty_until', 'location_id',
  'external_location', 'rubber_profile', 'letter_type', 'logo_ref', 'total_cycles', 'total_parts_produced', 'max_cycles',
  'cycle_warning_pct', 'last_used_at', 'last_maintenance_date', 'next_maintenance_date', 'maintenance_interval_days', 'maintenance_interval_cycles',
  'last_condition_check_at', 'open_damage_reports', 'reserved_qty', 'cost', 'current_revision', 'notes', 'created_by', 'created_at',
];
const FILTER_DIM_KEYS = [
  'length_mm', 'width_mm', 'height_mm', 'outer_diameter_mm', 'inner_diameter_mm', 'overall_diameter_mm', 'thread_size_mm', 'thread_spec',
  'gasket_diameter_mm', 'gasket_thickness_mm', 'gasket_inner_diameter_mm', 'weight_grams', 'pleat_count', 'pleat_height_mm', 'custom_values',
];
const MATERIAL_KEYS = ['media_type', 'media_code', 'glue_type', 'gasket_material', 'rubber_material', 'end_cap_material', 'mesh_type', 'pleat_count', 'pleat_height_mm', 'production_machine', 'standard_batch_qty', 'cycle_time_seconds', 'notes'];
const MAINT_KEYS = ['tooling_item_id', 'kind', 'status', 'priority', 'scheduled_date', 'completed_date', 'technician', 'work_description', 'findings', 'condition_before', 'condition_after', 'parts_replaced', 'cost', 'downtime_hours', 'next_maintenance_date', 'damage_report_id', 'created_by', 'created_at'];
const DAMAGE_KEYS = ['report_no', 'tooling_item_id', 'damage_type', 'severity', 'location_note', 'description', 'reported_by', 'reported_at', 'status', 'resolution', 'resolved_at', 'created_at'];
const ORDER_TOOL_KEYS = ['production_order_id', 'tooling_item_id', 'is_required', 'qty', 'status', 'taken_at', 'returned_at', 'cycle_count', 'produced_qty'];
const MOVEMENT_KEYS = ['tooling_item_id', 'movement_type', 'from_location_id', 'to_location_id', 'from_location_code', 'to_location_code', 'external_location', 'production_order_id', 'status_before', 'status_after', 'qty', 'reason_code', 'note', 'user_id', 'username', 'created_at'];
const USAGE_KEYS = ['tooling_item_id', 'production_order_id', 'filter_id', 'event_type', 'cycles', 'quantity', 'produced_qty', 'operator_name', 'occurred_at', 'note'];

async function chunkInsert(exec, table, rows, chunkSize = 300) {
  if (!rows.length) return 0;
  // use the union of keys so heterogeneous rows cannot mis-align columns with values
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const columnList = keys.map((k) => `\`${k}\``).join(',');
  for (let i = 0; i < rows.length; i += chunkSize) {
    const slice = rows.slice(i, i + chunkSize);
    const ph = `(${keys.map(() => '?').join(',')})`;
    const values = slice.map(() => ph).join(',');
    const sql = `INSERT INTO \`${table}\` (${columnList}) VALUES ${values}`;
    try {
      await exec.run(sql, slice.flatMap((r) => keys.map((k) => (r[k] === undefined ? null : r[k]))));
    } catch (err) {
      throw new Error(`insert into ${table} (${keys.length} cols, row0 ${slice.length && Object.keys(slice[0]).length} keys) failed: ${err.message.split('\n')[0]} | row0=${JSON.stringify(slice[0]).slice(0, 300)}`);
    }
  }
  return rows.length;
}

async function writeImages(exec, toolingPk, tool, dims, views) {
  const rows = [];
  const dir = path.join(config.uploadDir, 'tooling', String(toolingPk), 'images');
  await fs.promises.mkdir(dir, { recursive: true });
  for (const [idx, view] of views.entries()) {
    const { svg } = renderToolingImage({ ...tool, tooling_id: tool.tooling_id, dimensions: dims }, view);
    const stored = `ref-${view.toLowerCase()}.svg`;
    await fs.promises.writeFile(path.join(dir, stored), svg, 'utf8');
    rows.push({
      owner_type: 'TOOLING',
      owner_id: toolingPk,
      view_type: view,
      caption: view === 'FRONT' ? 'Technical reference view - generated from stored dimensions (not a photo)' : `Technical reference view (${view})`,
      filename: `${tool.tooling_id}-${view.toLowerCase()}.svg`,
      stored_name: stored,
      mime_type: 'image/svg+xml',
      size_bytes: Buffer.byteLength(svg),
      is_primary: idx === 0 ? 1 : 0,
      sort_order: (idx + 1) * 10,
      created_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
    });
  }
  return rows;
}

export async function seedDemo({ perf = false, rngSeed = 1337, extraFilters = 56 } = {}) {
  const rnd = mulberry32(rngSeed);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const between = (a, b) => a + rnd() * (b - a);
  const exec = await db.rawDriver.executor();
  const today = new Date();
  const now = isoT(today);
  const t0 = Date.now();

  const ref = {
    filterType: Object.fromEntries((await exec.all('SELECT id, code FROM filter_types')).map((r) => [r.code, r.id])),
    brand: Object.fromEntries((await exec.all('SELECT id, code FROM brands')).map((r) => [r.code, r.id])),
    toolingType: Object.fromEntries((await exec.all('SELECT id, code, id_prefix FROM tooling_types')).map((r) => [r.code, { id: r.id, prefix: r.id_prefix || 'T' }])),
    user: Object.fromEntries((await exec.all('SELECT id, username FROM users')).map((r) => [r.username, r.id])),
  };
  const users = Object.values(ref.user);
  const engUser = ref.user.engineering ?? users[0];
  const whUser = ref.user.warehouse ?? users[0];
  const prodUser = ref.user.production ?? users[0];
  const qcUser = ref.user.quality ?? users[0];

  /* ------------------------------------------------- warehouses + tree */
  const locations = new Map();
  for (const wh of WAREHOUSES) {
    let whRow = await exec.one('SELECT id FROM warehouses WHERE code=?', [wh.code]);
    if (!whRow) {
      await exec.run(
        'INSERT INTO warehouses (code, name, warehouse_type, address, manager, level_prefix, level_label, sort_order, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        [wh.code, wh.name, wh.warehouse_type, wh.address ?? null, wh.manager ?? null, wh.level_prefix ?? 'R', wh.level_label ?? 'Row', 100, now],
      );
      whRow = await exec.one('SELECT id FROM warehouses WHERE code=?', [wh.code]);
    }
    await upsertLocation(exec, { kind: 'WAREHOUSE', code: wh.code, fullCode: wh.code, labelPath: wh.name, refId: whRow.id, whId: whRow.id, parentId: null, depth: 0 });
    const whLoc = (await exec.one("SELECT id FROM tooling_locations WHERE kind='WAREHOUSE' AND ref_id=?", [whRow.id])).id;
    locations.set(`${wh.code}`, { id: whLoc, whId: whRow.id, fullCode: wh.code, labelPath: wh.name, kind: 'WAREHOUSE', depth: 0 });

    for (const rowDef of wh.rows) {
      let r = await exec.one('SELECT id FROM warehouse_rows WHERE warehouse_id=? AND code=?', [whRow.id, rowDef.code]);
      if (!r) {
        await exec.run('INSERT INTO warehouse_rows (warehouse_id, code, label, description, sort_order) VALUES (?,?,?,?,?)', [whRow.id, rowDef.code, rowDef.label, rowDef.description ?? null, 100]);
        r = await exec.one('SELECT id FROM warehouse_rows WHERE warehouse_id=? AND code=?', [whRow.id, rowDef.code]);
      }
      const rowPath = `${wh.code}/${rowDef.code}`;
      const rowFull = `${wh.code}-${rowDef.code}`;
      await upsertLocation(exec, { kind: 'ROW', code: rowDef.code, fullCode: rowFull, labelPath: `${wh.name} / ${rowDef.label || rowDef.code}`, refId: r.id, whId: whRow.id, rowId: r.id, parentId: whLoc, depth: 1 });
      const rowLocId = (await exec.one("SELECT id FROM tooling_locations WHERE kind='ROW' AND ref_id=?", [r.id])).id;
      locations.set(rowPath, { id: rowLocId, kind: 'ROW', whId: whRow.id, rowId: r.id, fullCode: rowFull, labelPath: `${wh.name} / ${rowDef.label || rowDef.code}`, depth: 1 });

      for (const rackDef of rowDef.racks) {
        let k = await exec.one('SELECT id FROM warehouse_racks WHERE row_id=? AND code=?', [r.id, rackDef.code]);
        if (!k) {
          await exec.run('INSERT INTO warehouse_racks (row_id, code, label, sort_order) VALUES (?,?,?,?)', [r.id, rackDef.code, rackDef.code, 100]);
          k = await exec.one('SELECT id FROM warehouse_racks WHERE row_id=? AND code=?', [r.id, rackDef.code]);
        }
        const rackFull = `${rowFull}-${rackDef.code}`;
        await upsertLocation(exec, { kind: 'RACK', code: rackDef.code, fullCode: rackFull, labelPath: `${wh.name} / ${rowDef.label || rowDef.code} / ${rackDef.code}`, refId: k.id, whId: whRow.id, rowId: r.id, rackId: k.id, parentId: rowLocId, depth: 2 });
        const rackLocId = (await exec.one("SELECT id FROM tooling_locations WHERE kind='RACK' AND ref_id=?", [k.id])).id;
        const rackPath = `${rowPath}/${rackDef.code}`;
        locations.set(rackPath, { id: rackLocId, kind: 'RACK', whId: whRow.id, rowId: r.id, rackId: k.id, fullCode: rackFull, labelPath: `${wh.name} / ${rowDef.label || rowDef.code} / ${rackDef.code}`, depth: 2 });

        for (let s = 1; s <= rackDef.shelves; s++) {
          const shelfCode = `S${String(s).padStart(2, '0')}`;
          let sh = await exec.one('SELECT id FROM warehouse_shelves WHERE rack_id=? AND code=?', [k.id, shelfCode]);
          if (!sh) {
            await exec.run('INSERT INTO warehouse_shelves (rack_id, code, label, level_no, capacity_items, max_weight_kg, height_mm) VALUES (?,?,?,?,?,?,?)', [k.id, shelfCode, shelfCode, s, rackDef.cap, 400, 260]);
            sh = await exec.one('SELECT id FROM warehouse_shelves WHERE rack_id=? AND code=?', [k.id, shelfCode]);
          }
          const shelfFull = `${rackFull}-${shelfCode}`;
          const shelfLabelPath = `${wh.name} / ${rowDef.label || rowDef.code} / ${rackDef.code} / ${shelfCode}`;
          await upsertLocation(exec, { kind: 'SHELF', code: shelfCode, fullCode: shelfFull, labelPath: shelfLabelPath, refId: sh.id, whId: whRow.id, rowId: r.id, rackId: k.id, shelfId: sh.id, parentId: rackLocId, depth: 3, capacity: rackDef.cap });
          const shelfLocId = (await exec.one("SELECT id FROM tooling_locations WHERE kind='SHELF' AND ref_id=?", [sh.id])).id;
          const shelfPath = `${rackPath}/${shelfCode}`;
          locations.set(shelfPath, { id: shelfLocId, kind: 'SHELF', whId: whRow.id, rowId: r.id, rackId: k.id, shelfId: sh.id, fullCode: shelfFull, labelPath: shelfLabelPath, capacity: rackDef.cap, depth: 3 });

          for (let b = 1; b <= 10; b++) {
            const boxCode = `B${String(b).padStart(2, '0')}`;
            let bx = await exec.one('SELECT id FROM warehouse_boxes WHERE shelf_id=? AND code=?', [sh.id, boxCode]);
            if (!bx) {
              await exec.run('INSERT INTO warehouse_boxes (shelf_id, code, label, capacity_items) VALUES (?,?,?,?)', [sh.id, boxCode, boxCode, 2]);
              bx = await exec.one('SELECT id FROM warehouse_boxes WHERE shelf_id=? AND code=?', [sh.id, boxCode]);
            }
            const boxFull = `${shelfFull}-${boxCode}`;
            const boxLabelPath = `${shelfLabelPath} / ${boxCode}`;
            await upsertLocation(exec, { kind: 'BOX', code: boxCode, fullCode: boxFull, labelPath: boxLabelPath, refId: bx.id, whId: whRow.id, rowId: r.id, rackId: k.id, shelfId: sh.id, boxId: bx.id, parentId: shelfLocId, depth: 4, capacity: 2 });
            const boxLocId = (await exec.one("SELECT id FROM tooling_locations WHERE kind='BOX' AND ref_id=?", [bx.id])).id;
            locations.set(`${shelfPath}/${boxCode}`, { id: boxLocId, kind: 'BOX', whId: whRow.id, rowId: r.id, rackId: k.id, shelfId: sh.id, boxId: bx.id, fullCode: boxFull, labelPath: boxLabelPath, capacity: 2, depth: 4 });
          }
        }
      }
    }
  }

  for (let i = 1; i <= 3; i++) {
    for (let bay = 1; bay <= 6; bay++) {
      await exec.run('INSERT INTO inventory_locations (code, name, location_type) VALUES (?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name)', [`FG-${i}-${bay}`, `Finished goods aisle ${i} / bay ${bay}`, 'PALLET']);
    }
  }

  /* ------------------------------------------------- families */
  const familyIds = {};
  for (const [code, name, description] of [
    ['BMW-F30', 'BMW F30 filter family', 'Air, cabin and oil filters built on the B47 platform tooling'],
    ['VW-MQB', 'VW/Audi MQB filter family', 'Panel air filters sharing MQB housings'],
    ['Fiat-1.4', 'Fiat 1.4 petrol family', 'Cartridge oil filters for Fiat 312/955 engines'],
    ['Renault-CMF', 'Renault CMF family', 'Transmission kits for dCi engines'],
    ['MB-SPRINTER', 'Mercedes Sprinter family', 'Hydraulic and fuel filters for VS30'],
  ]) {
    const found = await exec.one('SELECT id FROM tooling_families WHERE code=?', [code]);
    if (found) {
      familyIds[code] = found.id;
      continue;
    }
    await exec.run('INSERT INTO tooling_families (code, name, description, created_at) VALUES (?,?,?,?)', [code, name, description, now]);
    familyIds[code] = (await exec.one('SELECT id FROM tooling_families WHERE code=?', [code])).id;
  }

  /* ------------------------------------------------- vehicles */
  const vehicleIds = [];
  const vehicleSeen = new Map();
  for (const v of VEHICLES) {
    const [manufacturer, model, generation, y0, y1, engine, engineCode, fuel, power] = v;
    const key = [manufacturer, model, generation, y0, y1, engine, engineCode, fuel].join('|');
    if (vehicleSeen.has(key)) {
      vehicleIds.push(vehicleSeen.get(key));
      continue;
    }
    const params = [manufacturer, model, generation, y0, y1, engine];
    let row = await exec.one('SELECT id FROM vehicles WHERE manufacturer=? AND model=? AND generation=? AND year_from=? AND year_to=? AND engine=?', params);
    if (!row) {
      await exec.run(
        'INSERT INTO vehicles (manufacturer, model, generation, year_from, year_to, engine, engine_code, fuel, power_hp, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [manufacturer, model, generation, y0, y1, engine, engineCode, fuel, power, now],
      );
      row = await exec.one('SELECT id FROM vehicles WHERE manufacturer=? AND model=? AND generation=? AND year_from=? AND year_to=? AND engine=?', params);
    }
    vehicleSeen.set(key, row.id);
    vehicleIds.push(row.id);
  }

  /* ------------------------------------------------- filter list */
  const allFilters = [...FILTERS];
  for (const extra of FAMILY_FILTERS) {
    allFilters.push({
      seq: extra.seq,
      type: extra.type,
      brand: extra.brand,
      family: 'BMW-F30',
      name: extra.name,
      dims: { ...FILTERS[0].dims, ...extra.dims },
      materials: { media_type: 'Paper cellulose 210g', glue_type: 'PU hot melt', production_machine: 'AutoFlex 4000', standard_batch_qty: 500 },
      xrefs: [['OEM', `1371857${extra.seq.slice(-3)}`], ['MANN', `C320${extra.seq.slice(-1)}`]],
      vehicles: extra.vehicles,
      shared_with: '00452',
      tools: [],
    });
  }

  const count = perf ? extraFilters * 60 : extraFilters;
  const profiles = Object.fromEntries(FILTER_TYPES.map((t) => [t.code, t.dimension_profile]));
  for (let i = 0; i < count; i++) {
    const seq = `X${String(i).padStart(4, '0')}`;
    const type = pick(FILTER_TYPES.map((t) => t.code));
    const profile = profiles[type] ?? 'panel';
    const length = Math.round(between(120, 400));
    const width = Math.round(between(90, 260));
    const height = Math.round(between(20, 90));
    const dims =
      profile === 'spin_on'
        ? { overall_diameter_mm: Math.round(between(60, 110)), overall_height_mm: Math.round(between(55, 140)), thread_spec: pick(['M20x1.5', '3/4-16UNF', 'M22x1.5', 'G3/4']), gasket_diameter_mm: Math.round(between(55, 80)), weight_grams: Math.round(between(180, 600)), pleat_count: Math.round(between(20, 45)) }
        : profile === 'kit'
          ? { length_mm: length, width_mm: width, height_mm: Math.round(between(20, 45)), gasket_thickness_mm: 2.5, weight_grams: Math.round(between(200, 700)) }
          : { length_mm: length, width_mm: width, height_mm: height, pleat_count: Math.round(between(24, 66)), pleat_height_mm: Math.round(between(14, 34)), weight_grams: Math.round(between(180, 720)) };
    allFilters.push({
      seq,
      type,
      brand: pick(['BMW', 'Volkswagen', 'Audi', 'Mercedes-Benz', 'Fiat', 'Renault', 'Opel', 'Ford', 'Toyota', 'Alfa']),
      name: `DEMO filter ${type}-${seq} (${length}x${width}x${height})`,
      dims,
      materials: { media_type: pick(['Paper cellulose', 'Nonwoven synthetic', 'Glass fibre', 'Metal mesh']), glue_type: pick(['PU hot melt', 'Epoxy', 'Phenolic']), production_machine: pick(['AutoFlex 4000', 'SpinLine 8', 'FuelLine 2', 'CabinLine 2']), standard_batch_qty: pick([200, 400, 500, 800, 1200]) },
      xrefs: [['MANN', `C${1000 + i}`], ['MAHLE', `LX${2000 + i}`], ['OEM', `${13710000 + i * 37}`]],
      vehicles: Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => Math.floor(rnd() * vehicleIds.length)),
      tools: [
        { type: 'RH', name: `Rubber forming housing ${length}x${width}`, dims: { overall_length_mm: length + Math.round(between(80, 130)), overall_width_mm: width + Math.round(between(40, 70)), overall_height_mm: height + Math.round(between(6, 18)), internal_length_mm: length, internal_width_mm: width - 8, wall_thickness_mm: 8, channel_width_mm: 11, channel_depth_mm: 9, letter_size_mm: 12, letter_count: 9 }, cycles: Math.round(between(0, 2400)), max: 6000, status: 'AVAILABLE' },
        ...(rnd() > 0.45 ? [{ type: 'LI', name: 'Letter insert set', dims: { overall_length_mm: 160, overall_width_mm: 24, overall_height_mm: 12, letter_size_mm: 12, letter_count: 9 }, status: 'AVAILABLE' }] : []),
        ...(rnd() > 0.7 ? [{ type: 'CF', name: 'Cutting fixture', dims: { overall_length_mm: length + 30, overall_width_mm: width + 20, overall_height_mm: 85 }, cycles: Math.round(between(0, 9000)), max: 12000, status: 'AVAILABLE' }] : []),
      ],
      generated: true,
    });
  }

  /* ------------------------------------------------- build rows */
  const store = {
    filters: [],
    dims: [],
    materials: [],
    xrefs: [],
    apps: [],
    sets: [],
    tools: [],
    toolDims: [],
    images: [],
    compat: [],
    reqs: [],
    revisions: [],
    movements: [],
    usage: [],
    maint: [],
    damage: [],
    requests: [],
    orders: [],
    orderTools: [],
    reservations: [],
    batches: [],
    invItems: [],
    inv: [],
    invTxn: [],
    packaging: [],
    familyFilters: [],
    familyMembers: [],
  };
  const locById = new Map([...locations.values()].map((l) => [l.id, l.fullCode]));
  const locCodeOf = (locId) => (locId == null ? null : locById.get(locId) ?? null);
  const filterBySeq = new Map();
  const toolsByFilter = new Map();
  const toolByCode = new Map();
  const setPrimaryFilter = new Map();
  let toolSeq = 0;

  const locFor = (whCode, refs) => {
    if (!refs) return null;
    const wh = WAREHOUSES.find((w) => w.code === (whCode || 'TR'));
    const [r, rk, s, b] = refs;
    const rowDef = wh?.rows?.[r - 1];
    if (!rowDef) return null;
    const rackDef = rowDef.racks[(rk || 1) - 1] ?? rowDef.racks[0];
    const shelfCode = `S${String(s || 1).padStart(2, '0')}`;
    const key = b ? `${wh.code}/${rowDef.code}/${rackDef.code}/${shelfCode}/B${String(b).padStart(2, '0')}` : `${wh.code}/${rowDef.code}/${rackDef.code}/${shelfCode}`;
    return locations.get(key) ?? locations.get(`${wh.code}/${rowDef.code}/${rackDef.code}/${shelfCode}`) ?? null;
  };

  for (const f of allFilters) {
    const internal = `PP-${f.type}-${f.seq}`;
    const brandId = ref.brand[f.brand] ?? null;
    const searchBlob = [internal, f.name, f.dims?.length_mm ? `${f.dims.length_mm}x${f.dims.width_mm || 0}x${f.dims.height_mm || 0}` : null, f.dims?.overall_diameter_mm ? `D${f.dims.overall_diameter_mm}` : null, ...(f.xrefs ?? []).map((x) => x[1])].filter(Boolean).join(' | ');
    const filterId = 100000 + store.filters.length + 1;
    store.filters.push({
      id: filterId,
      internal_number: internal,
      product_number: `PP${f.seq}${f.type.slice(0, 2)}`,
      name: f.name,
      filter_type_id: ref.filterType[f.type] ?? ref.filterType.OTHER,
      brand_id: brandId,
      description: perf ? f.name : `Demo record for ${internal}. Tooling, warehouse and production linkage is fully wired.`,
      status: rnd() > 0.06 ? 'ACTIVE' : 'INACTIVE',
      is_active: rnd() > 0.06 ? 1 : 0,
      notes: null,
      search_blob: searchBlob,
      created_by: engUser,
      created_at: isoT(addDays(today, -Math.round(between(60, 900)))),
      updated_at: now,
    });
    filterBySeq.set(f.seq, { id: filterId, internal, filter: f });
    if (f.family && familyIds[f.family]) store.familyFilters.push({ family_id: familyIds[f.family], filter_id: filterId });

    if (f.dims) store.dims.push({ filter_id: filterId, unit: 'mm', ...pad({ ...f.dims }, FILTER_DIM_KEYS) });
    else store.dims.push({ filter_id: filterId, unit: 'mm', ...pad({}, FILTER_DIM_KEYS) });
    if (f.materials) store.materials.push({ filter_id: filterId, ...pad(f.materials, MATERIAL_KEYS) });
    for (const [refType, refNo] of f.xrefs ?? []) store.xrefs.push({ filter_id: filterId, ref_type: refType, brand_id: ref.brand[refType] ?? null, ref_number: refNo, created_at: now });
    for (const vIdx of new Set(f.vehicles ?? [])) if (vehicleIds[vIdx]) store.apps.push({ filter_id: filterId, vehicle_id: vehicleIds[vIdx], quantity_per_vehicle: 1, mounting_note: null });

    /* tooling set */
    const setCode = `TS-${f.seq}`;
    const setId = 600000 + store.sets.length + 1;
    store.sets.push({ id: setId, code: setCode, name: `Tooling set ${setCode} (${internal})`, filter_id: filterId, status: 'INCOMPLETE', required_count: 0, linked_count: 0, available_count: 0, notes: f.shared_with ? `Shares tooling with PP-${f.type}-${f.shared_with} (family tooling)` : null, created_at: now, updated_at: now });
    setPrimaryFilter.set(setId, filterId);

    const created = [];
    for (const t of f.tools ?? []) {
      const typeInfo = ref.toolingType[t.type] ?? { id: 1, prefix: 'T' };
      toolSeq += 1;
      let toolingId = `${typeInfo.prefix}-${f.seq}-A`;
      let n = 0;
      while (toolByCode.has(toolingId) && n < 8) {
        n += 1;
        toolingId = `${typeInfo.prefix}-${f.seq}-${String.fromCharCode(66 + n)}`;
      }
      if (toolByCode.has(toolingId)) continue;
      const status = t.status ?? 'AVAILABLE';
      const loc = status === 'IN_USE' || status === 'MISSING' ? null : locFor(t.wh, t.locRef ?? t.loc);
      const createdDate = iso(addDays(today, -Math.round(between(200, 1500))));
      const id = 500000 + store.tools.length + 1;
      const dims = pad(t.dims ?? {}, DIM_KEYS);
      const tool = {
        id,
        ...pad(
          {
            tooling_id: toolingId,
            name: t.name || `${typeInfo.prefix} tool for ${internal}`,
            tooling_type_id: typeInfo.id,
            tooling_set_id: setId,
            primary_filter_id: filterId,
            status,
            condition_rating: t.condition ?? (status === 'DAMAGED' ? 'POOR' : status === 'MAINTENANCE' ? 'FAIR' : pick(['EXCELLENT', 'GOOD', 'GOOD', 'FAIR'])),
            material: t.material ?? pick(['Steel S235 welded', 'Steel C45', 'Aluminium 6082-T6', 'Tool steel 1.2344']),
            manufacturer: pick(['ToolTech shpk', 'Precision Moulds srl', 'In-house workshop', 'AluForm GmbH']),
            weight_grams: Math.round(between(2000, 48000)),
            quantity: t.qty ?? 1,
            serial_number: rnd() > 0.65 ? `SN-${20000 + toolSeq}` : null,
            barcode: `SP${String(id).padStart(6, '0')}`,
            qr_payload: `SP:T:${toolingId}`,
            manufacturing_date: createdDate,
            purchase_date: createdDate,
            location_id: loc?.id ?? null,
            external_location: status === 'IN_USE' ? t.external ?? 'Production Line 1' : status === 'DAMAGED' ? 'QC hold area' : null,
            is_tracked: 1,
            cycle_warning_pct: 85,
            reserved_qty: 0,
            deleted_at: null,
            rubber_profile: ['RH', 'GH', 'RM'].includes(t.type) ? `${f.dims?.length_mm ?? f.dims?.overall_diameter_mm ?? 0}/${f.dims?.width_mm ?? 0}/PU${f.dims?.height_mm ?? 0}` : null,
            letter_type: t.type === 'LI' || t.type === 'NI' ? `Engraved ${dims.letter_size_mm ?? 12}mm` : null,
            total_cycles: t.cycles ?? 0,
            total_parts_produced: (t.cycles ?? 0) * (f.materials?.standard_batch_qty ?? 500),
            max_cycles: t.max ?? null,
            last_used_at: t.cycles ? isoT(addDays(today, -Math.round(between(1, 40)))) : null,
            last_maintenance_date: rnd() > 0.4 ? iso(addDays(today, -Math.round(between(10, 260)))) : null,
            next_maintenance_date: iso(addDays(today, Math.round(between(-25, 220)))),
            maintenance_interval_days: 180,
            maintenance_interval_cycles: t.max ? Math.round(t.max / 4) : null,
            open_damage_reports: status === 'DAMAGED' ? 1 : 0,
            cost: Math.round(between(400, 9000)),
            current_revision: t.rev ?? 1,
            notes: t.note ?? null,
            created_by: engUser,
            created_at: now,
          },
          TOOL_KEYS,
        ),
      };
      store.tools.push(tool);
      toolByCode.set(toolingId, tool);
      created.push(tool);
      store.toolDims.push({ tooling_item_id: id, ...dims });
      store.compat.push({ tooling_item_id: id, filter_id: filterId, compatibility_level: 'EXACT', is_primary: 1, note: null, created_at: now });
      store.reqs.push({ filter_id: filterId, tooling_type_id: typeInfo.id, quantity_required: t.qty ?? 1, is_mandatory: 1, note: null, created_at: now });
      store.revisions.push({
        tooling_item_id: id,
        filter_id: filterId,
        revision_no: t.rev ?? 1,
        change_summary: (t.rev ?? 1) > 1 ? 'Revision 2 - channel depth increased to 10mm, corner radius 14mm' : 'Initial release for series production',
        designer: pick(['E. Marku', 'A. Lala', 'K. Duka']),
        manufacturer: tool.manufacturer,
        material: tool.material,
        cost: tool.cost,
        manufacturing_date: tool.manufacturing_date,
        snapshot: JSON.stringify({ tool: { tooling_id: toolingId, name: tool.name, status, material: tool.material }, dims }),
        is_current: 1,
        created_by: engUser,
        created_at: now,
      });

      /* shared tooling from the family (spec §12, §47) */
      if (f.shared_with) {
        const srcTools = toolsByFilter.get(f.shared_with) ?? [];
        for (const src of srcTools) {
          store.compat.push({ tooling_item_id: src.id, filter_id: filterId, compatibility_level: 'ALT', is_primary: 0, note: 'Shared family tooling - originally made for PP-CF-00452', created_at: now });
          store.reqs.push({ filter_id: filterId, tooling_type_id: src.tooling_type_id, quantity_required: 1, is_mandatory: 1, note: 'Shared family tooling', created_at: now });
        }
      }
    }
    toolsByFilter.set(f.seq, created);

    /* photos + history (skipped in perf mode for speed) */
    if (!perf) {
      for (const tool of created) {
        const dims = store.toolDims.find((d) => d.tooling_item_id === tool.id) ?? {};
        const views = tool.status === 'DAMAGED' ? ['FRONT', 'DETAIL', 'DAMAGE'] : ['FRONT', 'TOP', 'DETAIL'];
        for (const img of await writeImages(exec, tool.id, tool, dims, views)) store.images.push(img);
        const historyLen = 3 + Math.floor(rnd() * 3);
        for (let h = historyLen; h >= 1; h--) {
          const when = addDays(today, -h * Math.round(between(3, 14)));
          store.movements.push(
            pad(baseMovement(tool, 'TAKE', when, whUser, 'Production Line 1', locCodeOf), MOVEMENT_KEYS),
            pad(baseMovement(tool, 'RETURN', addDays(when, 0.15), prodUser, null, locCodeOf), MOVEMENT_KEYS),
          );
          store.usage.push(pad({ tooling_item_id: tool.id, filter_id: tool.primary_filter_id, event_type: 'USAGE', cycles: 1, quantity: 1, produced_qty: Math.round(between(120, 900)), operator_name: pick(['A. Kola', 'D. Hoxha', 'B. Cela', 'F. Marku']), occurred_at: isoT(addDays(when, 0.1)) }, USAGE_KEYS));
        }
      }
    }
  }

  /* ------------------------------------------------- near-duplicate demo (spec §24) */
  const srcTool = toolByCode.get('H-00452-A');
  if (srcTool) {
    const dupId = 500000 + store.tools.length + 1;
    const srcDims = store.toolDims.find((d) => d.tooling_item_id === srcTool.id) ?? {};
    store.tools.push(
      pad(
        {
          id: dupId,
          tooling_id: 'H-00452-C',
          name: 'Rubber forming housing (legacy, unlabelled)',
          tooling_type_id: srcTool.tooling_type_id,
          status: 'AVAILABLE',
          condition_rating: 'FAIR',
          material: srcTool.material,
          manufacturer: 'Unknown (legacy stock)',
          weight_grams: srcTool.weight_grams,
          quantity: 1,
          barcode: `SP${dupId}`,
          qr_payload: 'SP:T:H-00452-C',
          is_tracked: 1,
          cycle_warning_pct: 85,
          reserved_qty: 0,
          open_damage_reports: 0,
          manufacturing_date: '2019-04-11',
          location_id: locFor('SP', [1, 1, 2, 1])?.id ?? null,
          rubber_profile: srcTool.rubber_profile,
          total_cycles: 40,
          total_parts_produced: 18000,
          max_cycles: 2500,
          cost: 0,
          current_revision: 1,
          notes: 'Found in Spare Tooling Store without paperwork - dimensions almost identical to H-00452-A.',
          created_by: whUser,
          created_at: now,
        },
        TOOL_KEYS,
      ),
    );
    const dupTool = store.tools[store.tools.length - 1];
    toolByCode.set('H-00452-C', dupTool);
    store.toolDims.push({ tooling_item_id: dupId, ...pad({ ...srcDims, overall_length_mm: 419.5, overall_height_mm: 65.5, custom_values: null }, DIM_KEYS) });
    for (const seq of ['00452', '00453', '00454']) {
      const target = filterBySeq.get(seq);
      if (target) store.compat.push({ tooling_item_id: dupId, filter_id: target.id, compatibility_level: 'CANDIDATE', is_primary: 0, note: 'Identified by dimension search - awaiting engineering confirmation', created_at: now });
    }
    if (!perf) for (const img of await writeImages(exec, dupId, dupTool, { ...srcDims, overall_length_mm: 419.5 }, ['FRONT', 'SIDE'])) store.images.push(img);
  }

  /* ------------------------------------------------- production orders */
  const orderDefs = [
    { po: 'PO-2026-0182', seq: '00452', qty: 500, status: 'READY', startOffset: -1, note: 'Tooling reserved yesterday, all tools on site' },
    { po: 'PO-2026-0183', seq: '01204', qty: 1200, status: 'IN_PROGRESS', startOffset: -2, note: 'Batch 1/3 complete' },
    { po: 'PO-2026-0184', seq: '00781', qty: 600, status: 'PLANNED', startOffset: 2, note: null },
    { po: 'PO-2026-0185', seq: '00912', qty: 600, status: 'PLANNED', startOffset: 3, note: 'Uses shared housing from PP-CF-00452' },
    { po: 'PO-2026-0186', seq: '00453', qty: 300, status: 'BLOCKED', startOffset: 1, note: 'Cutting fixture CT-00452-A is under maintenance' },
    { po: 'PO-2026-0175', seq: '00318', qty: 300, status: 'COMPLETED', startOffset: -14, note: null },
    { po: 'PO-2026-0168', seq: '01330', qty: 900, status: 'COMPLETED', startOffset: -26, note: null },
    { po: 'PO-2026-0158', seq: '00452', qty: 800, status: 'COMPLETED', startOffset: -41, note: null },
    { po: 'PO-2026-0190', seq: '04010', qty: 250, status: 'BLOCKED', startOffset: 2, note: 'Drill jig damaged - see DR report' },
    { po: 'PO-2026-0191', seq: '00660', qty: 450, status: 'CANCELLED', startOffset: 5, note: 'Customer postponed the order' },
  ];
  for (const def of orderDefs) {
    const target = filterBySeq.get(def.seq);
    if (!target) continue;
    const tools = toolsByFilter.get(def.seq) ?? [];
    const id = 700000 + store.orders.length + 1;
    const start = addDays(today, def.startOffset);
    const blocked = def.status === 'BLOCKED';
    store.orders.push({
      id,
      po_number: def.po,
      filter_id: target.id,
      quantity_ordered: def.qty,
      quantity_produced: def.status === 'COMPLETED' ? def.qty : def.status === 'IN_PROGRESS' ? Math.round(def.qty / 3) : 0,
      status: def.status,
      priority: def.qty > 700 ? 'HIGH' : 'NORMAL',
      line: pick(['Line 1', 'Line 2']),
      planned_start_at: isoT(start),
      planned_end_at: isoT(addDays(start, 1)),
      started_at: ['IN_PROGRESS', 'COMPLETED'].includes(def.status) ? isoT(start) : null,
      completed_at: def.status === 'COMPLETED' ? isoT(addDays(start, 1)) : null,
      availability_status: blocked ? 'NOT_READY' : 'READY',
      availability_checked_at: now,
      blocking_reason: blocked ? def.note : null,
      notes: def.note,
      created_by: prodUser,
      created_at: now,
      updated_at: now,
    });
    for (const t of tools) {
      store.orderTools.push(
        pad({
          production_order_id: id,
          tooling_item_id: t.id,
          is_required: 1,
          qty: 1,
          status: def.status === 'IN_PROGRESS' ? 'IN_USE' : def.status === 'COMPLETED' ? 'RETURNED' : blocked ? 'PENDING' : 'RESERVED',
          taken_at: ['IN_PROGRESS', 'COMPLETED'].includes(def.status) ? isoT(start) : null,
          returned_at: def.status === 'COMPLETED' ? isoT(addDays(start, 1)) : null,
          cycle_count: def.status === 'COMPLETED' ? def.qty : 0,
          produced_qty: def.status === 'COMPLETED' ? def.qty : 0,
        }, ORDER_TOOL_KEYS),
      );
      if (['PLANNED', 'READY', 'IN_PROGRESS', 'BLOCKED'].includes(def.status) && def.status !== 'BLOCKED') {
        store.reservations.push({ tooling_item_id: t.id, production_order_id: id, reserved_by: prodUser, qty: 1, planned_start_at: isoT(start), planned_end_at: isoT(addDays(start, 1)), status: 'ACTIVE', note: `Reserved for ${def.po}`, created_at: now });
      }
      if (def.status === 'COMPLETED') {
        store.usage.push(pad({ tooling_item_id: t.id, production_order_id: id, filter_id: target.id, event_type: 'USAGE', cycles: 1, quantity: def.qty, produced_qty: def.qty, operator_name: 'A. Kola', occurred_at: isoT(addDays(start, 1)), note: `${def.po} completed` }, USAGE_KEYS));
      }
    }
    if (def.status === 'COMPLETED') {
      store.batches.push({ id: 800000 + store.batches.length + 1, batch_number: `B-${def.po.slice(-5)}-1`, production_order_id: id, filter_id: target.id, quantity: def.qty, good_qty: def.qty - Math.round(def.qty * 0.004), scrap_qty: Math.round(def.qty * 0.004), started_at: isoT(start), completed_at: isoT(addDays(start, 1)), operator_id: prodUser });
    }
  }

  /* ------------------------------------------------- maintenance + damage */
  let dmgNo = 0;
  for (const t of store.tools.filter((x) => ['DAMAGED', 'MAINTENANCE'].includes(x.status)).slice(0, 6)) {
    dmgNo += 1;
    const dmgId = 850000 + dmgNo;
    store.damage.push(
      pad({
        id: dmgId,
        report_no: `DR-2026-${String(dmgNo).padStart(4, '0')}`,
        tooling_item_id: t.id,
        damage_type: t.status === 'DAMAGED' ? 'CRACKED' : 'WORN',
        severity: t.status === 'DAMAGED' ? 'HIGH' : 'MEDIUM',
        location_note: 'Found during batch changeover',
        description: t.notes ?? 'Operator reported an abnormal parting line on produced filters.',
        reported_by: qcUser,
        reported_at: isoT(addDays(today, -3)),
        status: t.status === 'DAMAGED' ? 'OPEN' : 'IN_REPAIR',
        created_at: now,
      }, DAMAGE_KEYS),
    );
    store.maint.push(
      pad({
        tooling_item_id: t.id,
        kind: 'CORRECTIVE',
        status: t.status === 'DAMAGED' ? 'IN_PROGRESS' : 'COMPLETED',
        priority: 'HIGH',
        scheduled_date: iso(addDays(today, -2)),
        completed_date: t.status === 'DAMAGED' ? null : iso(addDays(today, -1)),
        technician: pick(['J. Veshaj', 'R. Shehu']),
        work_description: 'Cleaned rubber channel, checked dimensions, re-touched the sealing face',
        findings: 'Channel width 12.1mm (nominal 12.0) - acceptable. Guide pin worn.',
        condition_before: 'POOR',
        condition_after: t.status === 'DAMAGED' ? 'POOR' : 'GOOD',
        cost: 240,
        downtime_hours: 6,
        next_maintenance_date: iso(addDays(today, 178)),
        damage_report_id: dmgId,
        created_by: qcUser,
        created_at: now,
      }, MAINT_KEYS),
    );
  }
  const plainTool = store.tools.find((t) => t.status === 'AVAILABLE' && !t.notes);
  if (plainTool) {
    store.maint.push(pad({ tooling_item_id: plainTool.id, kind: 'PREVENTIVE', status: 'COMPLETED', priority: 'NORMAL', scheduled_date: iso(addDays(today, -16)), completed_date: iso(addDays(today, -16)), technician: 'John Veshaj', work_description: 'Cleaned rubber channel, checked dimensions', findings: 'Condition: Good', condition_before: 'GOOD', condition_after: 'GOOD', created_by: qcUser, created_at: isoT(addDays(today, -16)) }, MAINT_KEYS));
  }
  const overdueTool = store.tools.find((t) => t.status === 'AVAILABLE' && t.id !== plainTool?.id);
  if (overdueTool) {
    store.maint.push(pad({ tooling_item_id: overdueTool.id, kind: 'PREVENTIVE', status: 'SCHEDULED', priority: 'HIGH', scheduled_date: iso(addDays(today, -9)), technician: 'To be assigned', work_description: '6-monthly inspection of forming faces and bolt holes', next_maintenance_date: iso(addDays(today, -9)), created_by: qcUser, created_at: now }, MAINT_KEYS));
  }

  /* ------------------------------------------------- requests */
  const requestDefs = [
    ['00912', 'RH', 'HIGH', 'PENDING', 'Production', 'Need a second rubber forming housing for PP-CF-00912', -2],
    ['00452', 'LI', 'MEDIUM', 'APPROVED', 'Engineering', 'Extra letter insert set for double-shift running', -9],
    ['01204', 'RM', 'HIGH', 'IN_PRODUCTION', 'Engineering', 'Replacement spin-on mold approaching cycle limit', -21],
    ['00318', 'CT', 'LOW', 'COMPLETED', 'Production', 'Additional cutting blade for the cabin line', -60],
    ['02455', 'FIX', 'MEDIUM', 'REJECTED', 'Sales', 'Dedicated fixture for canister 02455', -30],
  ];
  requestDefs.forEach(([seq, type, priority, status, dept, title, days], i) => {
    const target = filterBySeq.get(seq) ?? store.filters[0];
    store.requests.push({
      id: 880000 + i + 1,
      request_no: `TR-2026-${String(25 + i).padStart(4, '0')}`,
      filter_id: target?.id ?? null,
      requested_tooling_type_id: ref.toolingType[type]?.id ?? null,
      title,
      description: `${title}. Existing tooling was checked with the "Do we already have this tool?" search before raising this request.`,
      priority,
      status,
      quantity: 1,
      target_date: iso(addDays(today, days + 21)),
      requested_by: users[i % users.length],
      requested_for_dept: dept,
      approved_by: status === 'PENDING' ? null : ref.user.admin,
      approved_at: status === 'PENDING' ? null : isoT(addDays(today, days + 1)),
      rejection_reason: status === 'REJECTED' ? 'Existing fixture H-02455-A also fits this canister - no new tool needed (saved ~2,100 EUR).' : null,
      estimate_cost: Math.round(between(600, 4200)),
      completed_at: status === 'COMPLETED' ? isoT(addDays(today, days + 18)) : null,
      created_at: isoT(addDays(today, days)),
      updated_at: now,
    });
  });

  /* ------------------------------------------------- inventory */
  const invFilters = store.filters.slice(0, perf ? 500 : Math.min(40, store.filters.length));
  invFilters.forEach((filterRow, i) => {
    const itemId = 910000 + i + 1;
    const qty = Math.round(between(0, 4200));
    store.invItems.push({ id: itemId, item_kind: 'FILTER', ref_id: filterRow.id, sku: filterRow.internal_number, name: filterRow.name, unit: 'PCS', reorder_level: 400, min_stock: 200, is_active: 1, updated_at: now });
    store.inv.push({ id: 920000 + i + 1, inventory_item_id: itemId, quantity: qty, reserved_qty: Math.round(qty * 0.05), damaged_qty: Math.round(qty * 0.002) });
    const poRef = `PO-2026-${String(150 + (i % 40)).padStart(4, '0')}`;
    store.invTxn.push({ inventory_item_id: itemId, txn_type: 'RECEIPT', quantity: qty, balance_after: qty, reference_type: 'PRODUCTION_ORDER', reference_no: poRef, reason: 'PRODUCTION', note: 'Finished goods receipt from production', user_id: whUser, created_at: isoT(addDays(today, -Math.round(between(1, 60)))) });
    if (qty > 0) store.invTxn.push({ inventory_item_id: itemId, txn_type: 'ISSUE', quantity: -Math.round(qty * 0.2), balance_after: Math.round(qty * 0.8), reference_type: 'SALE', reference_no: `SO-${2000 + i}`, reason: 'SALE', note: 'Customer dispatch', user_id: whUser, created_at: isoT(addDays(today, -Math.round(between(0, 20)))) });
    store.packaging.push({ id: 930000 + i + 1, filter_id: filterRow.id, packaging_type: 'BOX 12', units_per_pack: 12, available_packs: Math.round(between(0, 900)), notes: null });
    if (i < 6) store.packaging.push({ id: 935000 + i + 1, filter_id: filterRow.id, packaging_type: 'BOX 24', units_per_pack: 24, available_packs: Math.round(between(0, 400)), notes: 'Export packaging' });
  });

  /* ------------------------------------------------- write everything */
  const writes = [
    ['filters', 'filters', store.filters],
    ['filter_dimensions', 'filter_dimensions', store.dims],
    ['filter_materials', 'filter_materials', store.materials],
    ['filter_cross_references', 'filter_cross_references', store.xrefs],
    ['filter_vehicle_applications', 'filter_vehicle_applications', store.apps],
    ['tooling_sets', 'tooling_sets', store.sets],
    ['tooling_items', 'tooling_items', store.tools],
    ['tooling_dimensions', 'tooling_dimensions', store.toolDims],
    ['tooling_compatibility', 'tooling_compatibility', store.compat],
    ['filter_tooling_requirements', 'filter_tooling_requirements', store.reqs],
    ['tooling_revisions', 'tooling_revisions', store.revisions],
    ['tooling_images', 'tooling_images', store.images],
    ['tooling_movements', 'tooling_movements', store.movements],
    ['code_registry', 'code_registry', []],
    ['tooling_usage_history', 'tooling_usage_history', store.usage],
    ['production_orders', 'production_orders', store.orders],
    ['production_order_tools', 'production_order_tools', store.orderTools],
    ['production_batches', 'production_batches', store.batches],
    ['tooling_reservations', 'tooling_reservations', store.reservations],
    ['tooling_damage_reports', 'tooling_damage_reports', store.damage],
    ['tooling_maintenance', 'tooling_maintenance', (() => {
      const byNo = new Map(store.damage.map((d) => [d.report_no, d.id]));
      return store.maint.map((m) => ({ ...m, damage_report_id: byNo.get(`DR-2026-${String(m.damage_report_id - 850000).padStart(4, '0')}`) ?? null }));
    })()],
    ['tooling_requests', 'tooling_requests', store.requests],
    ['inventory_items', 'inventory_items', store.invItems],
    ['inventory', 'inventory', store.inv],
    ['inventory_transactions', 'inventory_transactions', store.invTxn],
    ['packaging_items', 'packaging_items', store.packaging],
    ['tooling_family_filters', 'tooling_family_filters', store.familyFilters],
    ['tooling_family_members', 'tooling_family_members', store.tools.slice(0, 14).map((t, i) => ({ family_id: Object.values(familyIds)[i % Object.keys(familyIds).length], tooling_item_id: t.id, role: 'SHARED' }))],
  ];
  const summary = [];
  for (const [label, table, rows] of writes) {
    if (!rows.length) continue;
    const clean = rows.map((r) => {
      const o = { ...r };
      if (!('id' in r) || o.id === undefined) delete o.id;
      return o;
    });
    const n = await chunkInsert(exec, table, clean).catch((err) => {
      const keys = Object.keys(clean[0]);
      const bad = clean.findIndex((r) => keys.some((k) => (r[k] === null || r[k] === undefined) && NOTNULL.includes(`${table}.${k}`)));
      throw new Error(`seed insert "${table}" failed: ${err.message}${bad >= 0 ? ` | row ${bad}: ${JSON.stringify(clean[bad]).slice(0, 400)}` : ''}`);
    });
    summary.push(`${label}=${n}`);
  }

  /* ------------------------------------------------- derived state */
  await refreshSetStatuses(exec, { sets: store.sets.map((s) => s.id) });
  await refreshOccupancy(exec);
  await exec.run(
    "INSERT INTO app_settings (setting_key, value, label, group_name, is_public) VALUES ('demo_seeded', ?, 'Demo data seeded at', 'System', 0) ON DUPLICATE KEY UPDATE value=VALUES(value)",
    [now],
  );

  logger.info('seed: demo data written in %dms (%s)', Date.now() - t0, summary.join(' '));
  return {
    filters: store.filters.length,
    tooling: store.tools.length,
    images: store.images.length,
    locations: locations.size,
    movements: store.movements.length,
    summary,
  };
}

function baseMovement(tool, type, when, userId, external, locCodeOf) {
  const locCode = locCodeOf(tool.location_id);
  const base = {
    tooling_item_id: tool.id,
    movement_type: type,
    from_location_id: type === 'TAKE' ? tool.location_id ?? null : null,
    to_location_id: type === 'RETURN' ? tool.location_id ?? null : null,
    from_location_code: type === 'TAKE' ? locCode : null,
    to_location_code: type === 'RETURN' ? locCode : null,
    external_location: type === 'TAKE' ? external : null,
    status_before: type === 'TAKE' ? 'AVAILABLE' : 'IN_USE',
    status_after: type === 'TAKE' ? 'IN_USE' : 'AVAILABLE',
    qty: 1,
    note: type === 'TAKE' ? 'Taken for production' : 'Returned to storage after batch',
    created_at: isoT(when),
  };
  return { ...base, user_id: userId };
}

async function upsertLocation(exec, l) {
  await exec.run(
    `INSERT INTO tooling_locations (kind, code, full_code, label_path, ref_id, warehouse_id, row_id, rack_id, shelf_id, box_id, parent_location_id, depth, capacity_items, status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE full_code=VALUES(full_code), label_path=VALUES(label_path), capacity_items=VALUES(capacity_items), parent_location_id=VALUES(parent_location_id), updated_at=NOW()`,
    [l.kind, l.code, l.fullCode, l.labelPath, l.refId, l.whId ?? null, l.rowId ?? null, l.rackId ?? null, l.shelfId ?? null, l.boxId ?? null, l.parentId ?? null, l.depth ?? 0, l.capacity ?? null, 'AVAILABLE'],
  );
}

/* ----------------------------------------------------------- refreshers */
export async function refreshSetStatuses(exec = null, { sets = null } = {}) {
  const e = exec ?? (await db.rawDriver.executor());
  const filterOfSet = new Map();
  const setRowsFrom = sets ? 'WHERE id IN (' + sets.map(() => '?').join(',') + ')' : '';
  const setRows = await e.all(`SELECT id, code, filter_id FROM tooling_sets ${setRowsFrom}`, sets ?? []);
  for (const s of setRows) filterOfSet.set(s.id, s.filter_id);
  for (const s of setRows) {
    const filterId = filterOfSet.get(s.id);
    const required = filterId
      ? Number(await e.value('SELECT COUNT(*) c FROM filter_tooling_requirements WHERE filter_id=? AND is_mandatory=1', [filterId]) ?? 0)
      : 0;
    const stats = await e.one(
      `SELECT COUNT(*) linked,
              SUM(CASE WHEN ti.status IN ('AVAILABLE','IN_USE','RESERVED') THEN 1 ELSE 0 END) ok,
              SUM(CASE WHEN ti.status = 'MAINTENANCE' THEN 1 ELSE 0 END) maint,
              SUM(CASE WHEN ti.status IN ('MISSING','DAMAGED') THEN 1 ELSE 0 END) bad
       FROM tooling_items ti WHERE ti.tooling_set_id = ? AND ti.deleted_at IS NULL`,
      [s.id],
    );
    const linked = Number(stats?.linked ?? 0);
    const ok = Number(stats?.ok ?? 0);
    const bad = Number(stats?.bad ?? 0);
    const maint = Number(stats?.maint ?? 0);
    let status;
    if (!linked) status = 'NO_REQUIREMENTS';
    else if (bad > 0) status = 'MISSING_TOOL';
    else if (required && ok < required) status = 'PARTIAL';
    else if (maint > 0) status = 'MAINTENANCE';
    else status = 'COMPLETE';
    await e.run('UPDATE tooling_sets SET required_count=?, linked_count=?, available_count=?, status=?, completeness_checked_at=NOW() WHERE id=?', [required, linked, ok, status, s.id]);
  }
}

export async function refreshOccupancy(exec = null) {
  const e = exec ?? (await db.rawDriver.executor());
  const nearly = Number(await e.value("SELECT CAST(value AS SIGNED) v FROM app_settings WHERE setting_key='shelf_fill_nearly_pct'") ?? 70);
  const full = Number(await e.value("SELECT CAST(value AS SIGNED) v FROM app_settings WHERE setting_key='shelf_fill_full_pct'") ?? 90);
  await e.run(`UPDATE tooling_locations tl SET tl.occupancy_items = (
      SELECT COALESCE(SUM(ti.quantity),0) FROM tooling_items ti WHERE ti.location_id = tl.id AND ti.deleted_at IS NULL
    )`);
  for (const [childKind, parentKind] of [['BOX', 'SHELF'], ['SHELF', 'RACK'], ['RACK', 'ROW'], ['ROW', 'WAREHOUSE']]) {
    await e.run(`UPDATE tooling_locations parent
      SET parent.occupancy_items = (
        SELECT COALESCE(SUM(c.occupancy_items),0) FROM tooling_locations c WHERE c.parent_location_id = parent.id AND c.kind = '${childKind}'
      ) WHERE parent.kind = '${parentKind}'`);
  }
  await e.run(`UPDATE tooling_locations tl SET tl.status = 'MAINTENANCE'
    WHERE EXISTS (SELECT 1 FROM tooling_items ti WHERE ti.location_id = tl.id AND ti.status = 'MAINTENANCE')`);
  await e.run(
    `UPDATE tooling_locations SET status = CASE
        WHEN occupancy_items = 0 THEN 'EMPTY'
        WHEN capacity_items IS NULL OR capacity_items = 0 THEN 'AVAILABLE'
        WHEN occupancy_items >= capacity_items THEN 'FULL'
        WHEN occupancy_items * 100 >= capacity_items * ${full} THEN 'FULL'
        WHEN occupancy_items * 100 >= capacity_items * ${nearly} THEN 'NEARLY_FULL'
        ELSE 'AVAILABLE' END
      WHERE status <> 'MAINTENANCE'`,
  );
}
