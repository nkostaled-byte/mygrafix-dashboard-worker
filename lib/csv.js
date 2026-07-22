/**
 * CSV Export Helpers
 * ===================
 * Convert database rows to CSV format for downloadable exports.
 */

/**
 * Convert an array of row objects to a CSV string.
 * @param {object[]} rows
 * @returns {string}
 */
export function rowsToCsv(rows) {
  if (!rows.length) return "";

  // Union of keys across all rows
  const columns = Array.from(
    rows.reduce((set, row) => {
      Object.keys(row).forEach((key) => set.add(key));
      return set;
    }, new Set())
  );

  const header = columns.map(csvEscape).join(",");
  const lines = rows.map((row) =>
    columns.map((col) => csvEscape(formatCsvValue(row[col]))).join(",")
  );

  return [header, ...lines].join("\r\n");
}

function formatCsvValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function csvEscape(value) {
  const str = String(value);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

