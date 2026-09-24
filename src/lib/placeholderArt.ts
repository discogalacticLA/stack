import { escapeHtml } from "./html.js";

/**
 * Original, deterministic placeholder artwork (SVG). No third-party images are used.
 * Archive art and "copy photo" placeholders look intentionally different, and both carry
 * a visible label so they are never mistaken for real photographs.
 */
const PALETTES = [
  ["#1f1d1a", "#d8c7a3", "#b5452a"],
  ["#243b3a", "#e9dfc9", "#d08a2e"],
  ["#3a2c4a", "#f0e6d2", "#6fa39a"],
  ["#e6dcc8", "#262320", "#9c3d21"],
  ["#1d3557", "#f1e9d8", "#e07a5f"],
  ["#4a3b2a", "#efe4cf", "#7d9d5b"],
  ["#101418", "#c9b99a", "#4f7cac"],
  ["#d9cbb0", "#2b2a27", "#c0582f"],
];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seed: string) {
  let x = hash(seed) || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) % 10000) / 10000;
  };
}

export function archiveArtSvg(seed: string, title: string, subtitle: string): string {
  const r = rng(seed);
  const [bg, fg, accent] = PALETTES[hash(seed) % PALETTES.length];
  const variant = hash(seed + "v") % 4;
  let shapes = "";
  if (variant === 0) {
    for (let i = 0; i < 7; i++) {
      const radius = 30 + i * 22;
      shapes += `<circle cx="${150 + r() * 20}" cy="${150 + r() * 20}" r="${radius}" fill="none" stroke="${i % 2 ? fg : accent}" stroke-width="${2 + r() * 6}"/>`;
    }
  } else if (variant === 1) {
    for (let i = 0; i < 9; i++) {
      const y = 20 + i * 30;
      shapes += `<rect x="0" y="${y}" width="${120 + r() * 180}" height="${8 + r() * 12}" fill="${i % 3 ? fg : accent}"/>`;
    }
  } else if (variant === 2) {
    shapes += `<rect x="40" y="40" width="220" height="220" fill="${accent}"/>`;
    shapes += `<circle cx="150" cy="150" r="${60 + r() * 30}" fill="${bg}"/>`;
    shapes += `<circle cx="150" cy="150" r="8" fill="${fg}"/>`;
  } else {
    for (let i = 0; i < 14; i++) {
      shapes += `<polygon points="${r() * 300},${r() * 300} ${r() * 300},${r() * 300} ${r() * 300},${r() * 300}" fill="${i % 2 ? fg : accent}" opacity="0.8"/>`;
    }
  }
  const t = escapeHtml(title.slice(0, 32));
  const st = escapeHtml(subtitle.slice(0, 40));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300" role="img" aria-label="Placeholder artwork for ${t}">
<rect width="300" height="300" fill="${bg}"/>${shapes}
<rect x="0" y="236" width="300" height="64" fill="${bg}" opacity="0.88"/>
<text x="14" y="262" font-family="Helvetica, Arial, sans-serif" font-size="17" font-weight="700" fill="${fg}">${t}</text>
<text x="14" y="284" font-family="Helvetica, Arial, sans-serif" font-size="12" fill="${fg}" opacity="0.85">${st}</text>
<text x="286" y="18" text-anchor="end" font-family="Helvetica, Arial, sans-serif" font-size="9" letter-spacing="1" fill="${fg}" opacity="0.7">PLACEHOLDER ART</text>
</svg>`;
}

/** A stylised "photo" of an individual copy: a record half out of a sleeve, with a visible label. */
export function copyPhotoSvg(seed: string, caption: string): string {
  const r = rng(seed);
  const [bg, fg, accent] = PALETTES[hash(seed + "p") % PALETTES.length];
  const angle = Math.round(r() * 16 - 8);
  const wear = Array.from({ length: 5 }, () =>
    `<line x1="${80 + r() * 140}" y1="${80 + r() * 140}" x2="${80 + r() * 140}" y2="${80 + r() * 140}" stroke="#fff" stroke-opacity="0.15" stroke-width="1"/>`,
  ).join("");
  const c = escapeHtml(caption.slice(0, 40));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300" role="img" aria-label="Placeholder copy photo: ${c}">
<rect width="300" height="300" fill="#8b8378"/>
<rect width="300" height="300" fill="url(#g)"/>
<defs><radialGradient id="g"><stop offset="0" stop-color="#b8afa2"/><stop offset="1" stop-color="#6d665d"/></radialGradient></defs>
<g transform="rotate(${angle} 150 150)">
<circle cx="190" cy="150" r="100" fill="#141414"/>
<circle cx="190" cy="150" r="34" fill="${accent}"/>
<circle cx="190" cy="150" r="4" fill="#ddd"/>${wear}
<rect x="30" y="50" width="200" height="200" fill="${bg}" stroke="${fg}" stroke-opacity="0.3"/>
<rect x="45" y="65" width="60" height="8" fill="${fg}" opacity="0.6"/>
</g>
<rect x="0" y="0" width="300" height="24" fill="#000" opacity="0.55"/>
<text x="10" y="16" font-family="Helvetica, Arial, sans-serif" font-size="11" fill="#fff">DEMO COPY PHOTO · ${c}</text>
</svg>`;
}
