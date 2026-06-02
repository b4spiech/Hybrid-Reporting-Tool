import type { ProjectState } from './types';

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the click has a chance to start.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function slug(title: string): string {
  return title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'tracking-gantt';
}

export function exportJSON(state: ProjectState): void {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  triggerDownload(blob, `${slug(state.title)}.json`);
}

/** Serialize an <svg> element to a standalone, namespaced SVG string. */
function serializeSvg(svg: SVGSVGElement): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(clone);
}

export function exportSVG(svg: SVGSVGElement, title: string): void {
  const blob = new Blob([serializeSvg(svg)], { type: 'image/svg+xml;charset=utf-8' });
  triggerDownload(blob, `${slug(title)}.svg`);
}

/** Rasterize the SVG to a PNG at the given pixel scale (default 2x for crispness). */
export function exportPNG(svg: SVGSVGElement, title: string, scale = 2): Promise<void> {
  const svgString = serializeSvg(svg);
  const width = svg.viewBox.baseVal.width || svg.clientWidth;
  const height = svg.viewBox.baseVal.height || svg.clientHeight;

  return new Promise((resolve, reject) => {
    const img = new Image();
    const svgUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgString);
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      const ctx = canvas.getContext('2d');
      if (!ctx) return reject(new Error('Canvas not supported'));
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => {
        if (!blob) return reject(new Error('PNG encoding failed'));
        triggerDownload(blob, `${slug(title)}.png`);
        resolve();
      }, 'image/png');
    };
    img.onerror = () => reject(new Error('Could not render SVG to image'));
    img.src = svgUrl;
  });
}

export function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

/**
 * Parse a CSV mapping "integration name -> percent complete". Tolerant of a
 * header row and of a trailing "%" on the number. Returns name->percent.
 */
export function parseProgressCSV(text: string): Map<string, number> {
  const out = new Map<string, number>();
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const cells = splitCsvLine(line);
    if (cells.length < 2) continue;
    const name = cells[0].trim();
    const pctRaw = cells[1].replace('%', '').trim();
    const pct = Number(pctRaw);
    // Skip header rows or junk.
    if (!name || !Number.isFinite(pct)) continue;
    out.set(name.toLowerCase(), Math.max(0, Math.min(100, Math.round(pct))));
  }
  return out;
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      cells.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells;
}
