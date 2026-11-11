import type { Token, Tokens } from 'marked';
import { lexer } from 'marked';
import PDFDocument from 'pdfkit';

/**
 * Renders a proposal's Markdown as a PDF (design 6.2, step 5). It draws the shapes a
 * proposal has: headings, paragraphs, lists and tables. Images and raw HTML are not drawn;
 * the proposal rules already keep them out. The built-in fonts cover Western European
 * text; any other character is drawn as a question mark.
 */
const WIN_ANSI_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
const REPLACE: Record<string, string> = { '→': '->', '←': '<-', '≥': '>=', '≤': '<=', '≠': '!=', '\u00a0': ' ', '\u2011': '-', '\u2212': '-' };

function printable(text: string): string {
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (REPLACE[char] !== undefined) out += REPLACE[char];
    else if (char === '\n' || char === '\t' || (code >= 0x20 && code <= 0x7e) || (code >= 0xa1 && code <= 0xff) || WIN_ANSI_EXTRA.includes(char)) out += char;
    else out += '?';
  }
  return out;
}

/** The text of inline Markdown without its marks. A link keeps its address when that differs from its text. */
function plain(tokens: Token[] | undefined, fallback = ''): string {
  if (!tokens) return fallback;
  return tokens
    .map((token): string => {
      switch (token.type) {
        case 'link': {
          const link = token as Tokens.Link;
          const label = plain(link.tokens, link.text);
          return link.href && link.href !== label && !link.href.startsWith('#') ? `${label} (${link.href})` : label;
        }
        case 'br':
          return '\n';
        case 'image':
        case 'html':
          return '';
        case 'codespan':
          return (token as Tokens.Codespan).text;
        case 'escape':
          return (token as Tokens.Escape).text;
        default: {
          const generic = token as Tokens.Generic;
          const inner = generic.tokens;
          return inner ? plain(inner) : typeof generic.text === 'string' ? generic.text : '';
        }
      }
    })
    .join('')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

const BODY = 10.5;
const HEADING: Record<number, number> = { 1: 20, 2: 14, 3: 12 };

export function renderProposalPdf(markdown: string, meta: { title: string; subtitle?: string }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 64, info: { Title: printable(meta.title), Creator: 'Patcher' } });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const left = doc.page.margins.left;
    const bottom = () => doc.page.height - doc.page.margins.bottom;

    const paragraph = (text: string, options: { indent?: number; bold?: boolean; size?: number; gap?: number; color?: string } = {}) => {
      const body = printable(text).trim();
      if (!body) return;
      doc
        .font(options.bold ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(options.size ?? BODY)
        .fillColor(options.color ?? '#1a1a1a')
        .text(body, left + (options.indent ?? 0), doc.y, { width: width - (options.indent ?? 0), lineGap: 2 });
      doc.moveDown(options.gap ?? 0.6);
    };

    const list = (token: Tokens.List, indent: number) => {
      token.items.forEach((item, index) => {
        const nested = item.tokens.filter((t): t is Tokens.List => t.type === 'list');
        const text = plain(item.tokens.filter((t) => t.type !== 'list'));
        const start = typeof token.start === 'number' ? token.start : 1;
        const mark = token.ordered ? `${start + index}.` : '•';
        if (doc.y > bottom() - 20) doc.addPage();
        const y = doc.y;
        doc.font('Helvetica').fontSize(BODY).fillColor('#1a1a1a').text(mark, left + indent, y, { width: 16 });
        doc.text(printable(text).trim() || ' ', left + indent + 16, y, { width: width - indent - 16, lineGap: 2 });
        doc.moveDown(0.25);
        for (const inner of nested) list(inner, indent + 16);
      });
      if (indent === 0) doc.moveDown(0.4);
    };

    const table = (token: Tokens.Table) => {
      const columns = Math.max(1, token.header.length);
      // The first column holds names and gets the room; the rest share what is left.
      const first = columns > 1 ? width * 0.4 : width;
      const other = columns > 1 ? (width - first) / (columns - 1) : 0;
      const x = (i: number) => left + (i === 0 ? 0 : first + (i - 1) * other);
      const w = (i: number) => (i === 0 ? first : other) - 8;
      const row = (cells: Tokens.TableCell[], bold: boolean) => {
        const texts = cells.map((c) => printable(plain(c.tokens, c.text)).trim() || ' ');
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5);
        const height = Math.max(...texts.map((t, i) => doc.heightOfString(t, { width: w(i) })));
        if (doc.y + height > bottom()) doc.addPage();
        const y = doc.y;
        texts.forEach((t, i) => doc.fillColor('#1a1a1a').text(t, x(i), y, { width: w(i) }));
        doc.y = y + height + 5;
        doc
          .moveTo(left, doc.y - 2)
          .lineTo(left + width, doc.y - 2)
          .lineWidth(bold ? 0.8 : 0.3)
          .strokeColor('#999999')
          .stroke();
        doc.y += 3;
      };
      row(token.header, true);
      for (const cells of token.rows) row(cells, false);
      doc.moveDown(0.6);
    };

    const draw = (tokens: Token[]) => {
      for (const token of tokens) {
        switch (token.type) {
          case 'heading': {
            const heading = token as Tokens.Heading;
            if (heading.depth <= 2 && doc.y > bottom() - 80) doc.addPage();
            if (heading.depth === 2) doc.moveDown(0.5);
            paragraph(plain(heading.tokens, heading.text), { bold: true, size: HEADING[heading.depth] ?? 11, gap: heading.depth === 1 ? 0.3 : 0.4 });
            if (heading.depth === 1 && meta.subtitle) paragraph(meta.subtitle, { size: 9.5, color: '#666666', gap: 1 });
            break;
          }
          case 'paragraph':
            paragraph(plain((token as Tokens.Paragraph).tokens, (token as Tokens.Paragraph).text));
            break;
          case 'text':
            paragraph(plain((token as Tokens.Text).tokens, (token as Tokens.Text).text));
            break;
          case 'list':
            list(token as Tokens.List, 0);
            break;
          case 'table':
            table(token as Tokens.Table);
            break;
          case 'blockquote':
            for (const inner of (token as Tokens.Blockquote).tokens) {
              if (inner.type === 'paragraph') paragraph(plain((inner as Tokens.Paragraph).tokens), { indent: 14, color: '#444444' });
            }
            break;
          case 'code':
            paragraph((token as Tokens.Code).text, { indent: 14, size: 9.5 });
            break;
          case 'hr':
            doc.moveDown(0.5);
            break;
          default:
            break;
        }
      }
    };

    draw(lexer(markdown));
    doc.end();
  });
}
