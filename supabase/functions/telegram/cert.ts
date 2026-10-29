// Certificate of participation (A4 landscape PDF), in the app's look: navy, white, one blue accent.
import { PDFDocument, rgb, StandardFonts, PDFFont, PDFPage } from "npm:pdf-lib@1.17.1";
import fontkit from "npm:@pdf-lib/fontkit@1.1.1";

type Obj = Record<string, any>;
const hex = (h: string) => { const n = parseInt(h.slice(1), 16); return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255); };
const NAVY = hex("#0B1B3F"), BLUE = hex("#1463FF"), INK = hex("#0B1B3F"), MUTED = hex("#5B6884"), LINE = hex("#DDE4F0"), BG = hex("#F5F8FE"), WHITE = rgb(1, 1, 1), SOFT = hex("#B9C6E4");

const cache: Obj = {};
async function fetchBytes(url: string): Promise<Uint8Array | null> {
  if (cache[url] !== undefined) return cache[url];
  try {
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 6.1; rv:2.0) Gecko/20100101 Firefox/4.0" } });
    cache[url] = r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
    if (!r.ok) console.error("cert fetch", r.status, url);
  } catch (e) { console.error("cert fetch failed", url, String(e)); cache[url] = null; }
  return cache[url];
}
// The app's fonts (Google Fonts TTF files): Barlow Condensed 800 for display, Inter 400/700 for text.
const FONT = {
  display: "https://fonts.gstatic.com/s/barlowcondensed/v13/HTxwL3I-JCGChYJ8VI-L6OO_au7B47b1z3bWvA.ttf",
  body: "https://fonts.gstatic.com/s/inter/v20/UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIw2boKoduKmMEVuLyfAZ9hjQ.ttf",
  bold: "https://fonts.gstatic.com/s/inter/v20/UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIw2boKoduKmMEVuFuYAZ9hjQ.ttf",
};

async function embedImage(doc: PDFDocument, url?: string) {
  if (!url) return null;
  const b = await fetchBytes(url);
  if (!b || b.length < 8) return null;
  try {
    if (b[0] === 0x89 && b[1] === 0x50) return await doc.embedPng(b);
    if (b[0] === 0xff && b[1] === 0xd8) return await doc.embedJpg(b);
  } catch { /* unsupported image */ }
  return null;
}

function spaced(page: PDFPage, text: string, font: PDFFont, size: number, x: number, y: number, color: any, spacing: number) {
  let cx = x; for (const ch of text) { page.drawText(ch, { x: cx, y, size, font, color }); cx += font.widthOfTextAtSize(ch, size) + spacing; }
}
const spacedWidth = (text: string, font: PDFFont, size: number, spacing: number) => font.widthOfTextAtSize(text, size) + spacing * Math.max(0, text.length - 1);
function centered(page: PDFPage, text: string, font: PDFFont, size: number, y: number, color = INK, spacing = 0) {
  const w = font.widthOfTextAtSize(text, size) + spacing * Math.max(0, text.length - 1);
  const x = (page.getWidth() - w) / 2;
  if (!spacing) { page.drawText(text, { x, y, size, font, color }); return; }
  let cx = x;
  for (const ch of text) { page.drawText(ch, { x: cx, y, size, font, color }); cx += font.widthOfTextAtSize(ch, size) + spacing; }
}
// Largest size (<= max) at which the text fits the width.
const fit = (font: PDFFont, text: string, max: number, width: number) => { let s = max; while (s > 10 && font.widthOfTextAtSize(text, s) > width) s -= 1; return s; };

export async function certificatePdf(o: { player: string; tournament: string; dates: string; detail: string; issued: string; logoUrl?: string; appIconUrl: string; stats?: { label: string; value: string }[] }): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const [displayB, bodyR, bodyB] = await Promise.all([FONT.display, FONT.body, FONT.bold].map((u) => fetchBytes(u)));
  const embed = async (b: Uint8Array | null, std: StandardFonts) => { if (b) { try { return await doc.embedFont(b, { subset: true }); } catch (e) { console.error("font", e); } } return await doc.embedFont(std); };
  const fDisplay = await embed(displayB, StandardFonts.HelveticaBold);
  const fBody = await embed(bodyR, StandardFonts.Helvetica);
  const fBold = await embed(bodyB, StandardFonts.HelveticaBold);
  doc.setTitle(`Certificate of Participation · ${o.player}`);
  doc.setAuthor("Team MG · MG eFootball Milandhoo Community");

  const W = 842, H = 595, page = doc.addPage([W, H]);
  page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: BG });
  // card
  const M = 28;
  page.drawRectangle({ x: M, y: M, width: W - 2 * M, height: H - 2 * M, color: WHITE, borderColor: LINE, borderWidth: 1 });
  // navy header band
  const bandH = 92;
  page.drawRectangle({ x: M, y: H - M - bandH, width: W - 2 * M, height: bandH, color: NAVY });
  page.drawRectangle({ x: M, y: H - M - bandH - 4, width: W - 2 * M, height: 4, color: BLUE });
  const icon = await embedImage(doc, o.appIconUrl);
  const bandMid = H - M - bandH / 2;
  if (icon) page.drawImage(icon, { x: M + 26, y: bandMid - 24, width: 48, height: 48 });
  const tx = M + (icon ? 90 : 26);
  page.drawText("MG EFOOTBALL", { x: tx, y: bandMid + 2, size: 22, font: fDisplay, color: WHITE });
  spaced(page, "MILANDHOO COMMUNITY", fBold, 9, tx, bandMid - 16, SOFT, 2);

  // tournament logo (top right of band)
  const tlogo = await embedImage(doc, o.logoUrl);
  if (tlogo) { const s = 56; page.drawImage(tlogo, { x: W - M - 26 - s, y: bandMid - s / 2, width: s, height: s }); }

  // body (a little tighter when there is a stats row)
  const st = o.stats && o.stats.length ? o.stats : null;
  let y = H - M - bandH - (st ? 56 : 72);
  centered(page, "CERTIFICATE OF PARTICIPATION", fBold, 13, y, BLUE, 3.2);
  y -= st ? 38 : 46;
  centered(page, "This certificate is proudly presented to", fBody, 13, y, MUTED);
  y -= st ? 60 : 66;
  const nameSize = fit(fDisplay, o.player, 58, W - 2 * M - 120);
  centered(page, o.player, fDisplay, nameSize, y, INK);
  y -= st ? 18 : 22;
  page.drawRectangle({ x: W / 2 - 110, y, width: 220, height: 1.5, color: BLUE });
  y -= st ? 30 : 38;
  centered(page, "for taking part in", fBody, 13, y, MUTED);
  y -= 34;
  const tSize = fit(fBold, o.tournament, 24, W - 2 * M - 120);
  centered(page, o.tournament, fBold, tSize, y, INK);
  y -= st ? 20 : 24;
  centered(page, o.dates, fBody, 11.5, y, MUTED);
  if (st) {
    // tournament stats: a row of equal boxes
    const n = st.length, gap = 8, bw = Math.min(96, (W - 2 * M - 120 - gap * (n - 1)) / n), bh = 46;
    const total = n * bw + gap * (n - 1);
    let bx = (W - total) / 2; const by = y - 22 - bh;
    for (const it of st) {
      page.drawRectangle({ x: bx, y: by, width: bw, height: bh, color: BG, borderColor: LINE, borderWidth: 1 });
      const vs = fit(fDisplay, it.value, 20, bw - 10);
      page.drawText(it.value, { x: bx + (bw - fDisplay.widthOfTextAtSize(it.value, vs)) / 2, y: by + 20, size: vs, font: fDisplay, color: INK });
      const lab = it.label.toUpperCase();
      spaced(page, lab, fBold, 6.5, bx + (bw - spacedWidth(lab, fBold, 6.5, 0.8)) / 2, by + 8, MUTED, 0.8);
      bx += bw + gap;
    }
  } else {
    y -= 30;
    centered(page, o.detail, fBody, 11.5, y, MUTED);
  }

  // footer: issued (left), Team MG (right)
  const fy = M + 46;
  page.drawRectangle({ x: M + 60, y: fy + 16, width: 170, height: 0.8, color: LINE });
  page.drawText(o.issued, { x: M + 60, y: fy, size: 12, font: fBold, color: INK });
  spaced(page, "DATE ISSUED", fBold, 8, M + 60, fy - 16, MUTED, 1.5);
  const rx = W - M - 60 - 170;
  page.drawRectangle({ x: rx, y: fy + 16, width: 170, height: 0.8, color: LINE });
  const tm = "Team MG";
  page.drawText(tm, { x: rx + 170 - fDisplay.widthOfTextAtSize(tm, 20), y: fy - 2, size: 20, font: fDisplay, color: INK });
  const org = "ORGANISERS";
  spaced(page, org, fBold, 8, rx + 170 - spacedWidth(org, fBold, 8, 1.5), fy - 16, MUTED, 1.5);
  return await doc.save();
}
