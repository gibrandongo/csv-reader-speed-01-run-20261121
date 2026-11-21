// Fast CSV reader matching csv-reader 1.0.0 semantics (see competition.yaml).
//
// Single left-to-right pass over the text, index-based scanning, no regex,
// no per-character function calls in the hot loop. Fields are sliced out of
// the input; a field is only rebuilt (parts + join) when a lone CR had to be
// dropped from it or a quoted field needs "" / CR / LF normalisation.
//
// Semantics implemented, from the written spec:
// - U+FEFF at the very start is dropped.
// - A record ends at LF or CRLF; a line left with no characters is no record.
// - Outside quotes a CR not followed by LF is dropped (error stray_cr).
// - A field opening with a quote runs to the next quote that is not doubled;
//   "" inside it is one quote, each CRLF or lone CR inside it is read as LF.
// - What follows the closing quote, up to the next comma or line break, is
//   appended as it stands (error quote_junk, when the field ends).
// - A quote that never closes is a literal character and the text after it
//   is read again as unquoted (error unterminated_quote).
// - A quote inside an unquoted field is a literal character.
// - Fields stay strings, never trimmed or converted.
// - columns is the first record when header is true, else null; rows holds
//   the records after it (every record when header is false), each padded
//   with "" (short_row, with fields: its field count) or cut (long_row, with
//   extra: the cut fields) to the first record's width.
// - Each error is {code, line, row}, in the order met, a record's short_row
//   or long_row when it ends: line the 1-based line its record starts on,
//   counting every LF, CRLF and lone CR inside quotes, and row its record's
//   index in rows, null for the header.

export function run(input) {
  const s = input.text;
  const header = input.header;
  const n = s.length;
  let i = 0;
  if (n > 0 && s.charCodeAt(0) === 0xFEFF) i = 1;

  const rows = [];
  const errors = [];
  let columns = null;
  let width = -1; // field count of the first record; -1 until the first record
  let line = 1; // 1-based line number at position i
  let rowCount = 0; // data rows emitted so far (also the next row's index)
  let recLine = 1; // line the record currently being parsed starts on
  let rowIdx = null; // this record's index in rows, null for the header

  while (i < n) {
    // ---- record start: a line left with no characters is no record ----
    const c0 = s.charCodeAt(i);
    if (c0 === 10) {
      i++;
      line++;
      continue;
    }
    if (c0 === 13) {
      if (i + 1 < n && s.charCodeAt(i + 1) === 10) {
        i += 2;
        line++;
        continue;
      }
      // lone CR at record start: dropped, error on the record about to start
      errors.push({ code: 'stray_cr', line, row: header && width === -1 ? null : rowCount });
      i++;
      continue;
    }

    recLine = line; // line this record starts on
    rowIdx = header && width === -1 ? null : rowCount;
    const fields = [];

    // ---- fields of this record ----
    let recordDone = false;
    while (!recordDone) {
      let field;
      if (s.charCodeAt(i) === 34) {
        // ---- quoted field ----
        let p = i + 1;
        let close = -1;
        let doubled = false;
        for (;;) {
          const q = s.indexOf('"', p);
          if (q === -1) break;
          if (q + 1 < n && s.charCodeAt(q + 1) === 34) {
            doubled = true;
            p = q + 2;
            continue;
          }
          close = q;
          break;
        }
        if (close === -1) {
          // quote never closes: literal character, rest read again as unquoted
          errors.push({ code: 'unterminated_quote', line: recLine, row: rowIdx });
          field = readUnquoted();
        } else {
          let content;
          const nl = s.indexOf('\n', i + 1);
          const cr = s.indexOf('\r', i + 1);
          if (!doubled && (nl === -1 || nl >= close) && (cr === -1 || cr >= close)) {
            content = s.slice(i + 1, close);
          } else {
            content = buildQuoted(i + 1, close);
          }
          // junk after the closing quote, up to the next comma or line break
          const junk = readJunk(close + 1);
          if (junk.length > 0) {
            errors.push({ code: 'quote_junk', line: recLine, row: rowIdx });
            field = content + junk;
          } else {
            field = content;
          }
        }
      } else {
        field = readUnquoted();
      }
      fields.push(field);

      // ---- field delimiter ----
      if (i >= n) {
        recordDone = true;
      } else {
        const d = s.charCodeAt(i);
        if (d === 44) {
          i++;
        } else if (d === 10) {
          i++;
          line++;
          recordDone = true;
        } else {
          // d === 13: CRLF (a lone CR is dropped inside the field readers)
          i += 2;
          line++;
          recordDone = true;
        }
      }
    }

    // ---- record finished: width, pad / cut, short_row / long_row ----
    if (width === -1) {
      width = fields.length;
      if (header) {
        columns = fields;
      } else {
        rows.push(fields);
        rowCount++;
      }
    } else if (fields.length < width) {
      errors.push({ code: 'short_row', line: recLine, row: rowIdx, fields: fields.length });
      while (fields.length < width) fields.push('');
      rows.push(fields);
      rowCount++;
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recLine, row: rowIdx, extra: fields.slice(width) });
      fields.length = width;
      rows.push(fields);
      rowCount++;
    } else {
      rows.push(fields);
      rowCount++;
    }
  }

  return { columns, rows, errors };

  // ---- helpers (closures over the parser state above) ----

  // Unquoted field starting at i (also the fallback for an unterminated
  // quote: i points at the literal quote). Leaves i at the field delimiter
  // (',', LF, CRLF) or at n. Lone CRs are dropped with a stray_cr error and
  // the field continues after them, in a single scan (no rescan).
  function readUnquoted() {
    let segStart = i;
    let parts = null;
    let k = i;
    while (k < n) {
      const c = s.charCodeAt(k);
      if (c === 44 || c === 10) break;
      if (c === 13) {
        if (k + 1 < n && s.charCodeAt(k + 1) === 10) break; // CRLF ends the field
        errors.push({ code: 'stray_cr', line: recLine, row: rowIdx });
        if (parts === null) parts = [s.slice(segStart, k)];
        else parts.push(s.slice(segStart, k));
        segStart = k + 1;
      }
      k++;
    }
    let field;
    if (parts === null) {
      field = s.slice(segStart, k);
    } else {
      parts.push(s.slice(segStart, k));
      field = parts.join('');
    }
    i = k;
    return field;
  }

  // Junk after a closing quote, from position start up to the next comma or
  // line break. Same lone-CR handling as readUnquoted. Leaves i at the
  // delimiter (',', LF, CRLF) or at n.
  function readJunk(start) {
    let segStart = start;
    let parts = null;
    let k = start;
    while (k < n) {
      const c = s.charCodeAt(k);
      if (c === 44 || c === 10) break;
      if (c === 13) {
        if (k + 1 < n && s.charCodeAt(k + 1) === 10) break; // CRLF ends the junk
        errors.push({ code: 'stray_cr', line: recLine, row: rowIdx });
        if (parts === null) parts = [s.slice(segStart, k)];
        else parts.push(s.slice(segStart, k));
        segStart = k + 1;
      }
      k++;
    }
    let junk;
    if (parts === null) {
      junk = s.slice(segStart, k);
    } else {
      parts.push(s.slice(segStart, k));
      junk = parts.join('');
    }
    i = k;
    return junk;
  }

  // Content of a quoted field over [a, b): "" is one quote, each CRLF or
  // lone CR or LF inside it is read as LF. Counts the line breaks into the
  // parser's line counter. Every '"' in [a, b) is the first half of a '""'.
  function buildQuoted(a, b) {
    const parts = [];
    let seg = a;
    let k = a;
    while (k < b) {
      const c = s.charCodeAt(k);
      if (c === 34) {
        parts.push(s.slice(seg, k));
        parts.push('"');
        k += 2;
        seg = k;
      } else if (c === 13) {
        parts.push(s.slice(seg, k));
        parts.push('\n');
        line++;
        if (k + 1 < b && s.charCodeAt(k + 1) === 10) k += 2;
        else k += 1;
        seg = k;
      } else if (c === 10) {
        parts.push(s.slice(seg, k));
        parts.push('\n');
        line++;
        k++;
        seg = k;
      } else {
        k++;
      }
    }
    parts.push(s.slice(seg, b));
    return parts.join('');
  }
}
