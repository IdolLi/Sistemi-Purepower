/**
 * Technical reference photos for tooling.
 *
 * The database stores real image files (see files.js / tooling.routes upload) — but a
 * manufacturing plant with 10k tools rarely has a photo for every legacy tool, and demo
 * data must still show *something* recognisable. So for tooling records that have no
 * uploaded photo we render a dimensioned CAD-style view from the stored geometry
 * (overall size, internal opening, wall thickness, corner radius, channel, holes,
 * letter/logo position). The renderer is pure so it can also be used by the label
 * printer and, later, by the AI photo-matching feature as a synthetic reference image.
 */

const TYPE_KIND = {
  RH: 'housing',
  GH: 'housing',
  RM: 'mold',
  LI: 'letters',
  NI: 'letters',
  LOI: 'logo',
  CT: 'blade',
  CF: 'fixture',
  FT: 'forming',
  JIG: 'fixture',
  FIX: 'fixture',
  TPL: 'template',
  MT: 'gauge',
  OTH: 'generic',
};

const VIEW_LABEL = {
  FRONT: 'Front view',
  TOP: 'Top view',
  SIDE: 'Side view',
  DETAIL: 'Detail',
  LETTERING: 'Marking detail',
  BACK: 'Back view',
  BOTTOM: 'Bottom view',
  DAMAGE: 'Damage area',
  LOCATION: 'Storage position',
};

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const f = (n, d = 1) => (n === null || n === undefined ? 0 : Number(Number(n).toFixed(d)));

function palette(kind) {
  switch (kind) {
    case 'housing':
      return { body: '#3f4a5a', bodyHi: '#59677c', cavity: '#1d242f', channel: '#0f151d', accent: '#f59e0b' };
    case 'mold':
      return { body: '#4b5563', bodyHi: '#6b7280', cavity: '#111827', channel: '#0b0f19', accent: '#38bdf8' };
    case 'letters':
      return { body: '#b8bfc9', bodyHi: '#e2e8f0', cavity: '#374151', channel: '#1f2937', accent: '#111827' };
    case 'logo':
      return { body: '#c7ccd4', bodyHi: '#eef2f7', cavity: '#374151', channel: '#1f2937', accent: '#0ea5e9' };
    case 'blade':
      return { body: '#8d99a8', bodyHi: '#dbe3ec', cavity: '#2b3442', channel: '#161c25', accent: '#ef4444' };
    case 'fixture':
      return { body: '#556070', bodyHi: '#7c8ba1', cavity: '#1f2733', channel: '#141a23', accent: '#22c55e' };
    case 'forming':
      return { body: '#4a5568', bodyHi: '#718096', cavity: '#1a202c', channel: '#101620', accent: '#a78bfa' };
    case 'template':
      return { body: '#cbd5e1', bodyHi: '#f1f5f9', cavity: '#64748b', channel: '#475569', accent: '#0f172a' };
    case 'gauge':
      return { body: '#94a3b8', bodyHi: '#e2e8f0', cavity: '#334155', channel: '#1e293b', accent: '#facc15' };
    default:
      return { body: '#57606f', bodyHi: '#7f8c9e', cavity: '#222f3e', channel: '#18212d', accent: '#9ca3af' };
  }
}

function frame({ title, subtitle, code, stamp, body, width = 640, height = 460 }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#eef2f7"/><stop offset="100%" stop-color="#d5dbe4"/></linearGradient>
  <linearGradient id="metal" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="${body.bodyHi}"/><stop offset="55%" stop-color="${body.body}"/><stop offset="100%" stop-color="${body.cavity}"/></linearGradient>
  <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M20 0H0V20" fill="none" stroke="#c3ccd8" stroke-width="0.6"/></pattern>
</defs>
<rect width="${width}" height="${height}" fill="url(#bg)"/><rect width="${width}" height="${height}" fill="url(#grid)"/>
<rect x="10" y="10" width="${width - 20}" height="${height - 20}" fill="none" stroke="#8b98a9" stroke-width="1.4"/>
<text x="26" y="36" font-size="15" font-weight="700" fill="#111827">${title}</text>
<text x="26" y="54" font-size="11" fill="#334155">${subtitle}</text>
<g>
  <rect x="${width - 226}" y="${height - 46}" width="216" height="32" fill="#ffffff" stroke="#8b98a9"/>
  <text x="${width - 218}" y="${height - 30}" font-size="10" fill="#111827" font-weight="700">${code}</text>
  <text x="${width - 218}" y="${height - 19}" font-size="8.5" fill="#475569">${stamp}</text>
</g>
</svg>`;
}

function dimensionLine(x1, y1, x2, y2, label, opts = {}) {
  const { color = '#0f172a', offset = 0 } = opts;
  const vertical = Math.abs(x1 - x2) < 0.5;
  const midX = (x1 + x2) / 2 + (vertical ? 8 : 0);
  const midY = (y1 + y2) / 2 + (vertical ? 0 : -6);
  const arrow = (x, y, dx, dy) => {
    const len = 6;
    const nx = dy === 0 ? 0 : len * Math.sign(dy);
    const ny = dx === 0 ? 0 : len * Math.sign(dx);
    return `M${x} ${y} l${-dx === 0 ? nx : nx} ${-dy === 0 ? ny : ny}`;
  };
  const head1 = vertical
    ? `M${x1} ${y1} l-3.5 7 h7 z`
    : `M${x1} ${y1} l7 -3.5 v7 z`;
  const head2 = vertical
    ? `M${x2} ${y2} l-3.5 -7 h7 z`
    : `M${x2} ${y2} l-7 -3.5 v7 z`;
  return `<g stroke="${color}" stroke-width="0.9" fill="${color}">
<line x1="${f(x1)}" y1="${f(y1 + offset)}" x2="${f(x2)}" y2="${f(y2 + offset)}"/>
<path d="${head1}" transform="translate(0 ${f(offset)})"/><path d="${head2}" transform="translate(0 ${f(offset)})"/>
<text x="${f(midX)}" y="${f(midY + offset)}" font-size="10" stroke="none" text-anchor="${vertical ? 'start' : 'middle'}" font-weight="700">${label}</text>
${arrow(x1, y1, x2 - x1, y2 - y1)}${arrow(x2, y2, x1 - x2, y1 - y2)}
</g>`;
}

function boltHole(cx, cy, r) {
  return `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(r)}" fill="#0b1220"/><circle cx="${f(cx)}" cy="${f(cy)}" r="${f(r + 3)}" fill="none" stroke="#9aa7b8" stroke-width="0.8"/>`;
}

/** Front/side elevation of a rectangular housing with wall thickness + rubber channel. */
function drawHousing(v, d, p, dims) {
  const L = num(dims.overall_length_mm) ?? 420;
  const W = num(dims.overall_width_mm) ?? 180;
  const H = num(dims.overall_height_mm) ?? 65;
  const IL = num(dims.internal_length_mm) ?? L - 60;
  const IW = num(dims.internal_width_mm) ?? W - 50;
  const wall = num(dims.wall_thickness_mm) ?? 8;
  const chW = num(dims.channel_width_mm) ?? 12;
  const chD = num(dims.channel_depth_mm) ?? 10;
  const radius = num(dims.corner_radius_mm) ?? 12;

  if (v === 'TOP' || v === 'BOTTOM') {
    const s = Math.min(430 / L, 280 / W);
    const ox = (640 - L * s) / 2;
    const oy = 86 + (300 - W * s) / 2;
    const iw = IL * s;
    const ih = IW * s;
    const ix = ox + (L * s - iw) / 2;
    const iy = oy + (W * s - ih) / 2;
    const chWpx = chW * s;
    const holes = [];
    const hc = Math.min(4, Math.max(0, num(dims.hole_count) ?? 4));
    for (let i = 0; i < hc; i++) {
      const cx = i % 2 === 0 ? ix - chWpx - 6 : ix + iw + chWpx + 6;
      const cy = i < 2 ? iy - chWpx - 6 : iy + ih + chWpx + 6;
      holes.push(boltHole(cx, cy, (num(dims.hole_diameter_mm) ?? 9) * s * 0.6));
    }
    return {
      body: `<g>
<rect x="${f(ox)}" y="${f(oy)}" width="${f(L * s)}" height="${f(W * s)}" rx="${f(radius * s)}" fill="url(#metal)" stroke="#0b1220" stroke-width="1.2"/>
<rect x="${f(ix)}" y="${f(iy)}" width="${f(iw)}" height="${f(ih)}" rx="${f(Math.max(1, radius * s * 0.6))}" fill="${p.cavity}" stroke="#0b1220"/>
<rect x="${f(ix - chWpx)}" y="${f(iy - chWpx)}" width="${f(iw + chWpx * 2)}" height="${f(ih + chWpx * 2)}" rx="${f(radius * s)}" fill="none" stroke="${p.channel}" stroke-width="${f(Math.max(1.5, chWpx))}" opacity="0.95"/>
${holes.join('')}
<text x="${f(ox + 6)}" y="${f(oy - 8)}" font-size="10" fill="#334155">wall ${f(wall)}mm · channel ${f(chW)}×${f(chD)}mm</text>
</g>`,
      dims: [
        dimensionLine(ox, oy + W * s + 22, ox + L * s, oy + W * s + 22, `${f(L)} mm`),
        dimensionLine(ox + L * s + 20, oy, ox + L * s + 20, oy + W * s, `${f(W)} mm`),
        dimensionLine(ix, iy - 12, ix + iw, iy - 12, `${f(IL)} mm`),
      ],
    };
  }

  if (v === 'SIDE') {
    const s = Math.min(430 / L, 200 / H);
    const ox = (640 - L * s) / 2;
    const oy = 120 + (240 - H * s) / 2;
    const chDpx = (chD || 10) * s;
    return {
      body: `<g>
<rect x="${f(ox)}" y="${f(oy)}" width="${f(L * s)}" height="${f(H * s)}" fill="url(#metal)" stroke="#0b1220" stroke-width="1.2"/>
<rect x="${f(ox)}" y="${f(oy)}" width="${f(L * s)}" height="${f(chDpx)}" fill="${p.channel}" opacity="0.85"/>
<rect x="${f(ox + (wall || 8) * s)}" y="${f(oy + chDpx)}" width="${f((L - (wall || 8) * 2) * s)}" height="${f(Math.max(4, (H - chD) * s - chDpx))}" fill="${p.cavity}" opacity="0.75"/>
</g>`,
      dims: [
        dimensionLine(ox, oy + H * s + 20, ox + L * s, oy + H * s + 20, `${f(L)} mm`),
        dimensionLine(ox + L * s + 22, oy, ox + L * s + 22, oy + H * s, `${f(H)} mm`),
        dimensionLine(ox + L * s - 60, oy - 12, ox + L * s - 60 + 0.01, oy - 12, `depth ${f(chD)} mm`),
      ],
    };
  }

  if (v === 'DETAIL') {
    const scale = 3.2;
    const cw = chW * scale;
    const cd = chD * scale;
    const ox = 150;
    const oy = 140;
    return {
      body: `<g>
<rect x="${f(ox - 60)}" y="${f(oy)}" width="${f(400)}" height="${f(150)}" fill="url(#metal)" stroke="#0b1220"/>
<path d="M${ox} ${oy + 40} v${f(cd)} h${f(cw)} v${f(-cd)} z" fill="${p.channel}" stroke="#0b1220"/>
<path d="M${ox + 150} ${oy + 40} v${f(cd * 0.9)} h${f(cw * 0.8)} v${f(-cd * 0.9)} z" fill="${p.channel}" stroke="#0b1220"/>
<circle cx="${ox + 300}" cy="${oy + 70}" r="${f((num(dims.hole_diameter_mm) ?? 9) * scale * 0.5)}" fill="#0b1220"/>
<text x="${f(ox)}" y="${f(oy + 40 - 8)}" font-size="11" fill="#0f172a" font-weight="700">rubber channel ${f(chW)} × ${f(chD)} mm</text>
<text x="${f(ox + 150)}" y="${f(oy + 130)}" font-size="10" fill="#334155">witness mark / parting line</text>
<text x="${f(ox + 280)}" y="${f(oy + 130)}" font-size="10" fill="#334155">Ø${f(num(dims.hole_diameter_mm) ?? 9)} hole</text>
</g>`,
      dims: [dimensionLine(ox, oy + 26, ox + cw, oy + 26, `${f(chW)} mm`), dimensionLine(ox - 24, oy + 40, ox - 24, oy + 40 + cd, `${f(chD)}`)],
    };
  }

  if (v === 'LETTERING' || v === 'MARKING') {
    const letters = String(dims.letter_position || 'FRONT FACE').toUpperCase();
    const size = num(dims.letter_size_mm) ?? 12;
    const chars = 'PUREPOWER-PP00452';
    const glyphW = size * 1.9;
    const ox = 320 - (chars.length * glyphW) / 2;
    const glyphs = chars
      .split('')
      .map((ch, i) => `<text x="${f(ox + i * glyphW)}" y="230" font-size="${f(size * 1.9)}" font-weight="700" fill="${p.accent}" stroke="${p.cavity}" stroke-width="0.4">${ch}</text>`)
      .join('');
    return {
      body: `<g>
<rect x="60" y="120" width="520" height="220" rx="10" fill="${p.body}" stroke="#0b1220"/>
<rect x="80" y="140" width="480" height="180" rx="6" fill="${p.bodyHi}" opacity="0.35"/>
${glyphs}
<text x="60" y="370" font-size="11" fill="#334155">marking position: ${letters} · letter height ${f(size)} mm · depth 0.4 mm · count ${f(num(dims.letter_count) ?? 0)}</text>
</g>`,
      dims: [dimensionLine(ox, 250, ox + chars.length * glyphW, 250, `${f(size)} mm high`)],
    };
  }

  // FRONT (default): the face you see when you pull the box off the shelf
  const s = Math.min(440 / L, 230 / Math.max(H, W / 3));
  const ox = (640 - L * s) / 2;
  const oy = 110 + (240 - H * s) / 2;
  const holes = [];
  const hd = num(dims.hole_distance_mm) ?? L * 0.6;
  const hr = (num(dims.hole_diameter_mm) ?? 9) * s * 0.6;
  if (num(dims.hole_count)) {
    holes.push(boltHole(ox + (L * s - hd * s) / 2, oy + H * s * 0.5, hr));
    holes.push(boltHole(ox + (L * s + hd * s) / 2, oy + H * s * 0.5, hr));
  }
  return {
    body: `<g>
<rect x="${f(ox)}" y="${f(oy)}" width="${f(L * s)}" height="${f(H * s)}" rx="${f(radius * s)}" fill="url(#metal)" stroke="#0b1220" stroke-width="1.3"/>
<rect x="${f(ox + 6)}" y="${f(oy + 6)}" width="${f(L * s - 12)}" height="${f(H * s * 0.22)}" fill="#ffffff" opacity="0.13"/>
${holes.join('')}
<text x="${f(ox + 10)}" y="${f(oy + H * s - 10)}" font-size="11" fill="${p.accent}" font-weight="700">${f(num(dims.letter_size_mm) ?? 10)}mm ${String(dims.letter_position || 'MARKING').toUpperCase().slice(0, 24)}</text>
</g>`,
    dims: [
      dimensionLine(ox, oy + H * s + 24, ox + L * s, oy + H * s + 24, `${f(L)} mm`),
      dimensionLine(ox - 24, oy, ox - 24, oy + H * s, `${f(H)} mm`),
      num(dims.hole_count) ? dimensionLine(ox + (L * s - hd * s) / 2, oy - 16, ox + (L * s + hd * s) / 2, oy - 16, `${f(hd)} mm c/c`) : '',
    ],
  };
}

function drawCylinder(dims, p, code, kind) {
  const D = num(dims.overall_diameter_mm) ?? num(dims.outer_diameter_mm) ?? 76;
  const H = num(dims.overall_height_mm) ?? 65;
  const hole = num(dims.internal_diameter_mm) ?? D * 0.55;
  const s = Math.min(300 / (D * 2.2), 210 / H);
  const w = D * s;
  const h = H * s;
  const cx = 320;
  const top = 130 + (240 - h) / 2;
  const rx = w * 0.32;
  return {
    body: `<g>
<path d="M${f(cx - w / 2)} ${f(top)} v${f(h)} a${f(rx)} ${f(rx * 0.42)} 0 0 0 ${f(w)} 0 v${f(-h)}" fill="url(#metal)" stroke="#0b1220" stroke-width="1.2"/>
<ellipse cx="${f(cx)}" cy="${f(top)}" rx="${f(w / 2)}" ry="${f(rx * 0.42)}" fill="${p.bodyHi}" stroke="#0b1220"/>
<ellipse cx="${f(cx)}" cy="${f(top)}" rx="${f((hole / D) * (w / 2))}" ry="${f((hole / D) * rx * 0.42)}" fill="${p.cavity}" stroke="#0b1220"/>
${kind === 'gauge' ? `<path d="M${f(cx - w / 2)} ${f(top + h * 0.55)} h${f(w)}" stroke="${p.accent}" stroke-width="1.6"/>` : ''}
${`<path d="M${f(cx - w / 2 + 6)} ${f(top + h - 6)} q${f(w - 12)} ${f(-14)} ${f(w - 12)} 0" fill="none" stroke="#0b1220" opacity="0.5"/>`}
</g>`,
    dims: [
      dimensionLine(cx - w / 2, top + h + 34, cx + w / 2, top + h + 34, `Ø${f(D)} mm`),
      dimensionLine(cx + w / 2 + 26, top, cx + w / 2 + 26, top + h, `${f(H)} mm`),
      dimensionLine(cx - w / 2 - 24, top - 12, cx - w / 2 - 24, top - 12 + h, `Ø${f(hole)} bore`),
    ],
  };
}

function drawBlade(dims, p, code) {
  const L = num(dims.overall_length_mm) ?? 320;
  const W = num(dims.overall_width_mm) ?? 60;
  const s = Math.min(430 / L, 200 / (W * 2));
  const ox = (640 - L * s) / 2;
  const oy = 190;
  const teeth = Math.max(6, Math.round(L / 8));
  let path = `M${f(ox)} ${f(oy)}`;
  for (let i = 0; i < teeth; i++) {
    const x0 = ox + (i * L * s) / teeth;
    const x1 = ox + ((i + 0.5) * L * s) / teeth;
    const x2 = ox + ((i + 1) * L * s) / teeth;
    path += ` L${f(x0 + 2)} ${f(oy + 16)} L${f(x1)} ${f(oy + 30)} L${f(x2 - 2)} ${f(oy + 16)}`;
  }
  path += ` L${f(ox + L * s)} ${f(oy)}`;
  return {
    body: `<g>
<path d="${path} Z" fill="url(#metal)" stroke="#0b1220" stroke-width="1.1"/>
<rect x="${f(ox)}" y="${f(oy - W * s * 0.5)}" width="${f(L * s)}" height="${f(W * s * 0.5)}" rx="4" fill="${p.body}" stroke="#0b1220"/>
${boltHole(ox + 20, oy - W * s * 0.25, 5)}
${boltHole(ox + L * s - 20, oy - W * s * 0.25, 5)}
<text x="${f(ox)}" y="${f(oy + 62)}" font-size="11" fill="#334155">cutting edge ${f(num(dims.hole_count) ?? teeth)} teeth · relief 12° · carbide tipped</text>
</g>`,
    dims: [dimensionLine(ox, oy + 90, ox + L * s, oy + 90, `${f(L)} mm`), dimensionLine(ox - 22, oy - W * s * 0.5, ox - 22, oy + 30, `${f(W)} mm`)],
  };
}

function drawTemplate(dims, p, code) {
  const L = num(dims.overall_length_mm) ?? 300;
  const W = num(dims.overall_width_mm) ?? 200;
  const IL = num(dims.internal_length_mm) ?? L * 0.66;
  const IW = num(dims.internal_width_mm) ?? W * 0.55;
  const s = Math.min(420 / L, 260 / W);
  const ox = (640 - L * s) / 2;
  const oy = 100 + (280 - W * s) / 2;
  return {
    body: `<g>
<path fill-rule="evenodd" d="M${f(ox)} ${f(oy)} h${f(L * s)} v${f(W * s)} h${f(-L * s)} z M${f(ox + (L * s - IL * s) / 2)} ${f(oy + (W * s - IW * s) / 2)} h${f(IL * s)} v${f(IW * s)} h${f(-IL * s)} z" fill="url(#metal)" stroke="#0b1220"/>
${[0.2, 0.8].map((k) => boltHole(ox + L * s * k, oy + W * s * 0.1, 5)).join('')}
<text x="${f(ox)}" y="${f(oy + W * s + 22)}" font-size="11" fill="#334155">check / template · opening ${f(IL)} × ${f(IW)} mm · 2 mm hardened steel</text>
</g>`,
    dims: [dimensionLine(ox, oy - 14, ox + L * s, oy - 14, `${f(L)} mm`)],
  };
}

function drawInserts(dims, p, code, kind) {
  const size = num(dims.letter_size_mm) ?? 14;
  const count = Math.min(10, Math.max(1, num(dims.letter_count) ?? 7));
  const cell = Math.max(26, size * 2.6);
  const totalW = cell * count;
  const ox = (640 - totalW) / 2;
  const oy = 170;
  const seed = String(code).toUpperCase();
  const chars = [];
  for (let i = 0; i < count; i++) {
    const ch = kind === 'logo' ? ['◆', '●', '▲', '■'][i % 4] : seed[i % seed.length] || '0';
    chars.push(
      `<g><rect x="${f(ox + i * cell)}" y="${f(oy)}" width="${f(cell - 6)}" height="${f(cell * 1.6)}" rx="3" fill="url(#metal)" stroke="#0b1220"/><text x="${f(ox + i * cell + (cell - 6) / 2)}" y="${f(oy + cell * 1.05)}" font-size="${f(cell * 0.75)}" text-anchor="middle" font-weight="700" fill="${p.cavity}">${ch}</text></g>`,
    );
  }
  return {
    body: `<g>
<rect x="${f(ox - 12)}" y="${f(oy - 34)}" width="${f(totalW + 18)}" height="${f(cell * 1.6 + 52)}" rx="6" fill="${p.body}" opacity="0.25" stroke="#8b98a9"/>
${chars.join('')}
<text x="${f(ox - 12)}" y="${f(oy + cell * 1.6 + 34)}" font-size="11" fill="#334155">magnetic base · character height ${f(size)} mm · ${kind === 'logo' ? 'logo emboss set' : 'engraved letters'} · position: ${String(dims.letter_position || 'centred').toUpperCase()}</text>
</g>`,
    dims: [dimensionLine(ox, oy - 48, ox + cell - 6, oy - 48, `${f(size)} mm`), dimensionLine(ox, oy + cell * 1.6 + 60, ox + totalW, oy + cell * 1.6 + 60, `${count} pcs`)],
  };
}

function drawGauge(dims, p, code) {
  const L = num(dims.overall_length_mm) ?? 240;
  const s = 400 / L;
  const oy = 210;
  return {
    body: `<g>
<rect x="120" y="${f(oy)}" width="${f(L * s * 0.5)}" height="16" rx="4" fill="url(#metal)" stroke="#0b1220"/>
<rect x="${f(120 + L * s * 0.5 + 10)}" y="${f(oy - 6)}" width="${f(L * s * 0.32)}" height="28" rx="4" fill="${p.body}" stroke="#0b1220"/>
${Array.from({ length: 13 }).map((_, i) => `<line x1="${f(128 + i * ((L * s * 0.5 - 16) / 12))}" y1="${f(oy + 16)}" x2="${f(128 + i * ((L * s * 0.5 - 16) / 12))}" y2="${f(oy + (i % 5 === 0 ? 2 : 8))}" stroke="#0b1220" stroke-width="0.8"/>`).join('')}
<text x="120" y="${f(oy + 52)}" font-size="11" fill="#334155">calibrated check gauge · nominal ${f(num(dims.internal_length_mm) ?? 0)} × ${f(num(dims.internal_width_mm) ?? 0)} mm · tolerance ±${f(num(dims.letter_size_mm) ?? 0.1)} mm</text>
</g>`,
    dims: [dimensionLine(120, oy - 26, 120 + L * s * 0.5, oy - 26, `${f(L)} mm`)],
  };
}

/**
 * Render one reference view.
 * @returns {{svg:string, view:string, kind:string}}
 */
export function renderToolingImage(tool, view = 'FRONT') {
  const dims = tool.dimensions || {};
  const code = tool.tooling_id || tool.code || 'TOOL';
  const typeCode = String(tool.type_code || tool.typeCode || '').toUpperCase();
  let kind = TYPE_KIND[typeCode] || 'generic';
  const roundish = num(dims.overall_diameter_mm) != null && num(dims.overall_length_mm) == null;
  if (roundish && ['housing', 'forming', 'mold', 'generic'].includes(kind)) kind = 'cylinder';
  const p = palette(kind);
  const name = tool.name || 'Tooling item';
  let drawn;
  switch (kind) {
    case 'letters':
    case 'logo':
      drawn = drawInserts(dims, p, code, kind === 'logo' ? 'logo' : 'letters');
      break;
    case 'blade':
      drawn = drawBlade(dims, p, code);
      break;
    case 'cylinder':
      drawn = drawCylinder(dims, p, code, kind);
      break;
    case 'template':
      drawn = drawTemplate(dims, p, code);
      break;
    case 'gauge':
      drawn = drawGauge(dims, p, code);
      break;
    case 'fixture':
    case 'forming':
      drawn = kind === 'forming' && roundish ? drawCylinder(dims, p, code, kind) : drawHousing('FRONT', dims, p, dims);
      break;
    default:
      drawn = drawHousing('FRONT', dims, p, dims);
  }
  if (view && view !== 'FRONT' && ['housing', 'mold', 'fixture', 'forming'].includes(kind)) {
    drawn = drawHousing(view, dims, p, dims);
  }
  const stamp = `${VIEW_LABEL[view] || 'Front view'} · generated from stored geometry · not a photo`;
  const svg = frame({
    title: `${name.toUpperCase()}`,
    subtitle: `${code} · ${tool.type_name || typeCode || 'TOOLING'} · ${f(dims.overall_length_mm) || f(dims.overall_diameter_mm) || '—'} × ${f(dims.overall_width_mm) || '—'} × ${f(dims.overall_height_mm) || '—'} mm`,
    code,
    stamp,
    body: p,
    width: 640,
    height: 460,
  }).replace('</svg>', `${drawn.body}${(drawn.dims || []).join('')}\n</svg>`);
  return { svg, view: view || 'FRONT', kind };
}

export { VIEW_LABEL, TYPE_KIND };
